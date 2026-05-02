import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../plugins/bigint-serializer.ts'
import { registerErrorHandler } from '../../plugins/error-handler.ts'

/**
 * Route-level smoke tests for POST /earnings.
 *
 * The service layer is covered by earnings.integration.test.ts
 * against real Postgres; here we focus on the HTTP surface — Zod
 * validation paths, status codes, and the 200/201 split between
 * fresh writes and replays. We mock the service so the test does
 * not require any DB.
 */

vi.mock('../../db/postgres.ts', () => ({
  getPostgres: () => ({ db: {}, pool: {} }),
}))
vi.mock('../../db/redis.ts', () => ({
  getRedis: () => ({}),
}))

const recordEarningMock = vi.fn()
vi.mock('../../services/earnings.ts', () => ({
  recordEarning: (...args: unknown[]): unknown => recordEarningMock(...args),
}))

interface ErrorBody {
  error: { code: string; message: string }
}
interface EarningBody {
  earning: { amount: string }
  pool: { amount: string }
  newRank: number
}

// Fastify inject's res.json() is typed as `any`; this helper
// narrows to the body shape we expect so each assertion stays
// type-checked without per-line eslint disables.
function bodyOf<T>(res: { json: () => unknown }): T {
  return res.json() as T
}

let app: FastifyInstance

beforeEach(async () => {
  recordEarningMock.mockReset()
  app = Fastify({ logger: false })
  registerErrorHandler(app)
  const { registerEarningsRoutes } = await import('../earnings.ts')
  registerEarningsRoutes(app)
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

describe('POST /earnings — validation', () => {
  it('400 when Idempotency-Key header is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/earnings',
      payload: { userId: 'u1', amount: '100' },
    })
    expect(res.statusCode).toBe(400)
    expect(bodyOf<ErrorBody>(res).error.code).toBe('invalid_headers')
  })

  it('400 when amount is not a positive integer string', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/earnings',
      headers: { 'idempotency-key': 'k1' },
      payload: { userId: 'u1', amount: '0' },
    })
    expect(res.statusCode).toBe(400)
    expect(bodyOf<ErrorBody>(res).error.code).toBe('invalid_body')
  })

  it('400 when userId is empty', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/earnings',
      headers: { 'idempotency-key': 'k1' },
      payload: { userId: '', amount: '100' },
    })
    expect(res.statusCode).toBe(400)
    expect(bodyOf<ErrorBody>(res).error.code).toBe('invalid_body')
  })
})

describe('POST /earnings — happy path', () => {
  it('201 on fresh insert and forwards the service result', async () => {
    recordEarningMock.mockResolvedValueOnce({
      earning: {
        id: '42',
        userId: 'u1',
        amount: 1000n,
        isoWeek: '2026-W18',
        earnedAt: new Date('2026-05-02T12:00:00Z'),
        isReplay: false,
      },
      pool: { isoWeek: '2026-W18', amount: 20n },
      newRank: 7,
    })

    const res = await app.inject({
      method: 'POST',
      url: '/earnings',
      headers: { 'idempotency-key': 'k-fresh' },
      payload: { userId: 'u1', amount: '1000' },
    })

    expect(res.statusCode).toBe(201)
    const body = bodyOf<EarningBody>(res)
    expect(body.earning.amount).toBe('1000')
    expect(body.pool.amount).toBe('20')
    expect(body.newRank).toBe(7)
  })

  it('200 on replay (isReplay=true)', async () => {
    recordEarningMock.mockResolvedValueOnce({
      earning: {
        id: '42',
        userId: 'u1',
        amount: 1000n,
        isoWeek: '2026-W18',
        earnedAt: new Date('2026-05-02T12:00:00Z'),
        isReplay: true,
      },
      pool: { isoWeek: '2026-W18', amount: 20n },
      newRank: 7,
    })

    const res = await app.inject({
      method: 'POST',
      url: '/earnings',
      headers: { 'idempotency-key': 'k-replay' },
      payload: { userId: 'u1', amount: '1000' },
    })

    expect(res.statusCode).toBe(200)
  })
})
