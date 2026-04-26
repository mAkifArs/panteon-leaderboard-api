import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildServer } from './server.ts'
import './plugins/bigint-serializer.ts'

// We test the wiring (server boots, routes register, BigInt
// serialises) without spinning up real PG/Redis/Mongo. Real-DB
// integration tests come in the testcontainers layer.
vi.mock('./db/postgres.ts', () => ({
  pingPostgres: vi.fn(async () => true),
  closePostgres: vi.fn(async () => undefined),
}))
vi.mock('./db/redis.ts', () => ({
  pingRedis: vi.fn(async () => true),
  closeRedis: vi.fn(async () => undefined),
}))
vi.mock('./db/mongo.ts', () => ({
  pingMongo: vi.fn(async () => true),
  closeMongo: vi.fn(async () => undefined),
}))

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  process.env['NODE_ENV'] = 'test'
  process.env['DATABASE_URL'] = 'postgres://test:test@localhost:5432/test'
  process.env['REDIS_URL'] = 'redis://localhost:6379'
  process.env['MONGO_URL'] = 'mongodb://localhost:27017'
  process.env['LOG_LEVEL'] = 'fatal'
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe('server', () => {
  it('serves GET / with name + status', async () => {
    const app = await buildServer()
    const res = await app.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ name: 'panteon-leaderboard-api', status: 'ok' })
    await app.close()
  })

  it('serves GET /health with all-up status when checks pass', async () => {
    const app = await buildServer()
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      status: 'ok',
      checks: { postgres: true, redis: true, mongo: true },
    })
    await app.close()
  })

  it('returns 503 from /health when any check fails', async () => {
    const { pingRedis } = await import('./db/redis.ts')
    vi.mocked(pingRedis).mockResolvedValueOnce(false)

    const app = await buildServer()
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({
      status: 'degraded',
      checks: { postgres: true, redis: false, mongo: true },
    })
    await app.close()
  })

  it('returns 404 with structured error for unknown routes', async () => {
    const app = await buildServer()
    const res = await app.inject({ method: 'GET', url: '/nope' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({
      error: { code: 'not_found', message: 'Route GET /nope not found' },
    })
    await app.close()
  })

  it('serialises BigInt as a decimal string in JSON responses', async () => {
    const app = await buildServer()
    app.get('/echo-bigint', async () => ({ amount: 123456789012345678901234567890n }))

    const res = await app.inject({ method: 'GET', url: '/echo-bigint' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ amount: '123456789012345678901234567890' })
    await app.close()
  })
})
