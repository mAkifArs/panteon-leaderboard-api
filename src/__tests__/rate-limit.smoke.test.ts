import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildServer } from '../server.ts'
import '../plugins/bigint-serializer.ts'

/**
 * Smoke tests for the per-endpoint rate-limit plugin (ADR-010).
 *
 * Test environment uses the in-memory store (server.ts switches
 * to it when NODE_ENV === 'test'), so a fresh `buildServer()` per
 * test gives each case a clean counter and we don't need to spin
 * up Redis just to assert wiring.
 *
 * We mock the DB clients to noop because the route handlers
 * themselves are exercised end-to-end elsewhere; here we only care
 * about the limiter — that 429 fires after the configured `max`,
 * that the response shape goes through the standard error
 * envelope, that exempt routes (`/health`, `/`) are never limited,
 * and that the Retry-After header is set.
 */

vi.mock('../db/postgres.ts', () => ({
  getPostgres: () => ({ db: {}, pool: {} }),
  pingPostgres: vi.fn(() => Promise.resolve(true)),
  closePostgres: vi.fn(() => Promise.resolve()),
}))
vi.mock('../db/redis.ts', () => ({
  // ioredis-shaped enough for buildServer's `redis: getRedis()`
  // path; in test mode server.ts passes `undefined` instead so this
  // is only here to keep the import resolvable.
  getRedis: () => ({}),
  pingRedis: vi.fn(() => Promise.resolve(true)),
  closeRedis: vi.fn(() => Promise.resolve()),
}))
vi.mock('../db/mongo.ts', () => ({
  getMongo: () => ({ db: {}, client: {} }),
  pingMongo: vi.fn(() => Promise.resolve(true)),
  closeMongo: vi.fn(() => Promise.resolve()),
}))

const recordEarningMock = vi.fn()
vi.mock('../services/earnings.ts', () => ({
  recordEarning: (...args: unknown[]): unknown => recordEarningMock(...args),
}))

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  process.env['NODE_ENV'] = 'test'
  process.env['DATABASE_URL'] = 'postgres://test:test@localhost:5432/test'
  process.env['REDIS_URL'] = 'redis://localhost:6379'
  process.env['MONGO_URL'] = 'mongodb://localhost:27017'
  process.env['LOG_LEVEL'] = 'fatal'
  recordEarningMock.mockReset()
  recordEarningMock.mockResolvedValue({
    earning: {
      id: '1',
      userId: 'u1',
      amount: 1n,
      isoWeek: '2026-W18',
      earnedAt: new Date('2026-05-02T12:00:00Z'),
      isReplay: false,
    },
    pool: { isoWeek: '2026-W18', amount: 0n },
    newRank: 1,
  })
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

interface ErrorBody {
  error: { code: string; message: string }
}

describe('rate-limit — POST /earnings (60/min)', () => {
  it('allows the first 60 requests and rejects the 61st with 429', async () => {
    const app = await buildServer()
    try {
      // 60 successful calls — first one is enough to verify the
      // mocked service path; the rest are just exhausting the bucket.
      for (let i = 0; i < 60; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/earnings',
          headers: { 'idempotency-key': `rl-${String(i)}` },
          payload: { userId: 'u1', amount: '1' },
        })
        expect(res.statusCode).toBe(201)
      }

      const overflow = await app.inject({
        method: 'POST',
        url: '/earnings',
        headers: { 'idempotency-key': 'rl-overflow' },
        payload: { userId: 'u1', amount: '1' },
      })
      expect(overflow.statusCode).toBe(429)
      // Standard error envelope shared with validation / 5xx paths
      // (see server.ts errorResponseBuilder).
      const body: ErrorBody = overflow.json()
      expect(body.error.code).toBe('rate_limited')
      expect(body.error.message).toMatch(/rate limit exceeded/i)
      // Retry-After must be present so well-behaved clients can
      // back off rather than tight-loop.
      expect(overflow.headers['retry-after']).toBeDefined()
    } finally {
      await app.close()
    }
  })
})

describe('rate-limit — exempt routes', () => {
  it('does not rate-limit GET /health regardless of volume', async () => {
    const app = await buildServer()
    try {
      // 200 hits well past the tightest limit (60); /health must
      // never 429 — it would let the load balancer mark a healthy
      // replica as down.
      for (let i = 0; i < 200; i++) {
        const res = await app.inject({ method: 'GET', url: '/health' })
        expect(res.statusCode).toBe(200)
      }
    } finally {
      await app.close()
    }
  })

  it('does not rate-limit GET / (root smoke)', async () => {
    const app = await buildServer()
    try {
      for (let i = 0; i < 200; i++) {
        const res = await app.inject({ method: 'GET', url: '/' })
        expect(res.statusCode).toBe(200)
      }
    } finally {
      await app.close()
    }
  })
})
