import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../plugins/bigint-serializer.ts'
import { registerErrorHandler } from '../../plugins/error-handler.ts'

/**
 * Route-level smoke tests for /leaderboard/*. The view + pool
 * services are mocked; we focus on Zod validation, the 404 path
 * for unranked users, and the BigInt-string serialisation in the
 * response envelope.
 */

vi.mock('../../db/postgres.ts', () => ({
  getPostgres: () => ({ db: {}, pool: {} }),
}))
vi.mock('../../db/redis.ts', () => ({
  getRedis: () => ({}),
}))
vi.mock('../../db/mongo.ts', () => ({
  getMongo: () => ({ db: {}, client: {} }),
}))

const getTopViewMock = vi.fn()
const getOwnRankViewMock = vi.fn()
vi.mock('../../services/leaderboard-view.ts', () => ({
  getTopView: (...args: unknown[]): unknown => getTopViewMock(...args),
  getOwnRankView: (...args: unknown[]): unknown => getOwnRankViewMock(...args),
  // getSampleUsers is unused by this route file but the import
  // surface is shared with the users route — leave it as a noop.
  getSampleUsers: vi.fn(),
}))

const getCurrentPoolMock = vi.fn()
vi.mock('../../services/pool.ts', () => ({
  getCurrentPool: (...args: unknown[]): unknown => getCurrentPoolMock(...args),
}))

interface ErrorBody {
  error: { code: string; message: string }
}
interface TopBody {
  meta: { pool: string }
  entries: { score: string; username: string }[]
}
interface MeBody {
  rank: number
  totalPlayers: number
  cluster: { score: string }[]
  meta: { pool: string }
}

// Fastify inject's res.json() is typed as `any`; this helper
// narrows to the body shape we expect so each assertion stays
// type-checked without per-line eslint disables.
function bodyOf<T>(res: { json: () => unknown }): T {
  return res.json() as T
}

let app: FastifyInstance

beforeEach(async () => {
  getTopViewMock.mockReset()
  getOwnRankViewMock.mockReset()
  getCurrentPoolMock.mockReset()
  app = Fastify({ logger: false })
  registerErrorHandler(app)
  const { registerLeaderboardRoutes } = await import('../leaderboard.ts')
  registerLeaderboardRoutes(app)
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

describe('GET /leaderboard/top', () => {
  it('400 when isoWeek query is malformed', async () => {
    const res = await app.inject({ method: 'GET', url: '/leaderboard/top?isoWeek=2026-7' })
    expect(res.statusCode).toBe(400)
    expect(bodyOf<ErrorBody>(res).error.code).toBe('invalid_query')
  })

  it('200 with BigInt scores and pool serialised as decimal strings', async () => {
    getTopViewMock.mockResolvedValueOnce([
      { rank: 1, userId: 'u1', score: 9999n, username: 'Alpha' },
    ])
    getCurrentPoolMock.mockResolvedValueOnce(12345n)

    const res = await app.inject({
      method: 'GET',
      url: '/leaderboard/top?limit=1&isoWeek=2026-W18',
    })
    expect(res.statusCode).toBe(200)
    const body = bodyOf<TopBody>(res)
    expect(body.meta.pool).toBe('12345')
    expect(body.entries[0]?.score).toBe('9999')
    expect(body.entries[0]?.username).toBe('Alpha')
  })
})

describe('GET /leaderboard/me/:userId', () => {
  it('404 when user is unranked this week', async () => {
    getOwnRankViewMock.mockResolvedValueOnce(null)
    getCurrentPoolMock.mockResolvedValueOnce(0n)

    const res = await app.inject({ method: 'GET', url: '/leaderboard/me/ghost' })
    expect(res.statusCode).toBe(404)
    expect(bodyOf<ErrorBody>(res).error.code).toBe('unranked')
  })

  it('200 with cluster + meta when user is ranked', async () => {
    getOwnRankViewMock.mockResolvedValueOnce({
      rank: 5,
      totalPlayers: 100,
      cluster: [{ rank: 5, userId: 'u5', score: 500n, username: 'Five' }],
    })
    getCurrentPoolMock.mockResolvedValueOnce(7n)

    const res = await app.inject({ method: 'GET', url: '/leaderboard/me/u5' })
    expect(res.statusCode).toBe(200)
    const body = bodyOf<MeBody>(res)
    expect(body.rank).toBe(5)
    expect(body.totalPlayers).toBe(100)
    expect(body.cluster[0]?.score).toBe('500')
    expect(body.meta.pool).toBe('7')
  })
})

describe('GET /leaderboard/current/:userId', () => {
  it('200 with top + me + meta in a single envelope', async () => {
    getTopViewMock.mockResolvedValueOnce([{ rank: 1, userId: 'u1', score: 1000n, username: 'One' }])
    getOwnRankViewMock.mockResolvedValueOnce({
      rank: 5,
      totalPlayers: 50,
      cluster: [{ rank: 5, userId: 'u5', score: 500n, username: 'Five' }],
    })
    getCurrentPoolMock.mockResolvedValueOnce(42n)

    const res = await app.inject({ method: 'GET', url: '/leaderboard/current/u5' })
    expect(res.statusCode).toBe(200)
    const body = bodyOf<{
      meta: { pool: string }
      top: { count: number; entries: { score: string }[] }
      me: { rank: number; cluster: { score: string }[] } | null
    }>(res)
    expect(body.meta.pool).toBe('42')
    expect(body.top.count).toBe(1)
    expect(body.top.entries[0]?.score).toBe('1000')
    expect(body.me?.rank).toBe(5)
    expect(body.me?.cluster[0]?.score).toBe('500')
  })

  it('200 with me=null when the user has no earnings this week', async () => {
    getTopViewMock.mockResolvedValueOnce([])
    getOwnRankViewMock.mockResolvedValueOnce(null)
    getCurrentPoolMock.mockResolvedValueOnce(0n)

    const res = await app.inject({ method: 'GET', url: '/leaderboard/current/ghost' })
    expect(res.statusCode).toBe(200)
    const body = bodyOf<{ me: unknown }>(res)
    expect(body.me).toBeNull()
  })
})
