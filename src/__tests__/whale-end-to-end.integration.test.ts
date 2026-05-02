/**
 * Cross-layer whale end-to-end test.
 *
 * Three commits in a row (`d840707`, `6f262ac`, Bug 3 / `getSampleUsers`)
 * fixed the same class of bug at the Redis ↔ BigInt boundary, each
 * one in a different callsite. Per-module unit tests caught each
 * symptom *after* it shipped; this suite exists so the fourth one
 * is caught before merge.
 *
 * Why real Redis (not ioredis-mock): mock does ZSET arithmetic in
 * JS Number, so the production-only "5e+18" string form never
 * appears against the mock. The bugs we want to prevent only show
 * up against real Redis. Mongo is optional — the leaderboard-view
 * fallback path (commit `178434d`) tolerates a missing profile, so
 * this suite asserts on the rank/score data only.
 *
 * Requires docker-compose stack up: `docker compose up -d`.
 */
import assert from 'node:assert'
import { drizzle } from 'drizzle-orm/postgres-js'
import IORedis from 'ioredis'
import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as schema from '../db/schema.ts'
import {
  WHALE_AMOUNT,
  WHALE_POOL_CONTRIBUTION,
  WHALE_REDIS_SCORE_SCIENTIFIC,
} from '../../test/fixtures/whale.ts'
import { toIsoWeek } from '../lib/iso-week.ts'
import { recordEarning } from '../services/earnings.ts'
import {
  clearWeek,
  getOwnRankCluster,
  getScore,
  getTop,
  leaderboardKey,
} from '../services/leaderboard.ts'
import { getOwnRankView, getSampleUsers, getTopView } from '../services/leaderboard-view.ts'
import { getCurrentPool } from '../services/pool.ts'

const DATABASE_URL = process.env['DATABASE_URL']
const REDIS_URL = process.env['REDIS_URL']
if (!DATABASE_URL) throw new Error('DATABASE_URL must be set (cp .env.example .env)')
if (!REDIS_URL) throw new Error('REDIS_URL must be set (cp .env.example .env)')

// Fastify inject's res.json() is typed as `any`; this helper
// narrows to the body shape we expect so each assertion stays
// type-checked without per-line eslint disables.
function bodyOf<T>(res: { json: () => unknown }): T {
  return res.json() as T
}

let pool: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>
let redis: IORedis

// Pin the test to a synthetic week so it can never collide with
// real seed data or other integration tests.
const ISO_WEEK = '9998-W42'
const WHALE_ID = `whale-${Date.now()}`
const NORMAL_IDS = Array.from({ length: 10 }, (_, i) => `normal-${Date.now()}-${i}`)
const WHALE_TS = new Date('2026-04-20T10:00:00Z')

beforeAll(() => {
  pool = postgres(DATABASE_URL, { max: 5, onnotice: () => undefined })
  db = drizzle(pool, { schema })
  redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: false })
  // Sanity check: WHALE_TS lands on a different ISO week than our
  // synthetic test week, so the manual rewrite below is meaningful.
  expect(toIsoWeek(WHALE_TS)).not.toBe(ISO_WEEK)
})

afterAll(async () => {
  await pool`DELETE FROM earning_events WHERE iso_week = ${ISO_WEEK}`
  await clearWeek(redis, ISO_WEEK)
  await redis.del(`pool:week:${ISO_WEEK}`)
  await pool.end({ timeout: 5 })
  redis.disconnect()
})

beforeEach(async () => {
  // Idempotent setup: clean → seed once per test isolation. Tests
  // in this file all observe the same final state; we only re-seed
  // if a previous run left it dirty. Use direct PG/Redis writes
  // (production code path) to populate the synthetic week.
  await pool`DELETE FROM earning_events WHERE iso_week = ${ISO_WEEK}`
  await clearWeek(redis, ISO_WEEK)
  await redis.del(`pool:week:${ISO_WEEK}`)

  // Whale earning via the production write path (recordEarning).
  // This exercises the addEarning + bigIntToRedisScore boundary
  // and the pool counter INCRBY-as-string fix from commit 6f262ac.
  await recordEarning(db, redis, {
    userId: WHALE_ID,
    amount: WHALE_AMOUNT,
    idempotencyKey: `whale-${ISO_WEEK}`,
    now: WHALE_TS,
  })
  // We forced ISO_WEEK above; recordEarning derives it from `now`,
  // so override the row's iso_week to land on the synthetic key.
  await pool`
    UPDATE earning_events
    SET iso_week = ${ISO_WEEK}
    WHERE user_id = ${WHALE_ID} AND idempotency_key = ${`whale-${ISO_WEEK}`}
  `
  // Move the live Redis score onto the synthetic week as well.
  const realWeek = toIsoWeek(WHALE_TS)
  const score = await redis.zscore(leaderboardKey(realWeek), WHALE_ID)
  assert(score !== null, 'whale score must exist on the real week after recordEarning')
  await redis.zadd(leaderboardKey(ISO_WEEK), score, WHALE_ID)
  await redis.zrem(leaderboardKey(realWeek), WHALE_ID)
  // Pool counter — recordEarning wrote to the real week's pool key.
  // For this test we only need the synthetic-week pool to be present.
  await redis.set(`pool:week:${ISO_WEEK}`, WHALE_POOL_CONTRIBUTION.toString())

  // Normal players directly via PG insert + Redis ZADD (this matches
  // what addEarning does but lets us pin amounts and timestamps).
  for (let i = 0; i < NORMAL_IDS.length; i++) {
    const id = NORMAL_IDS[i]!
    const amount = BigInt(1_000 * (i + 1)) // 1000 .. 10000
    await pool`
      INSERT INTO earning_events (user_id, amount, iso_week, idempotency_key, earned_at)
      VALUES (${id}, ${amount.toString()}::bigint, ${ISO_WEEK},
              ${`normal-${ISO_WEEK}-${String(i)}`},
              ${WHALE_TS.toISOString()}::timestamptz)
    `
    await redis.zadd(leaderboardKey(ISO_WEEK), amount.toString(), id)
  }

  // Pool counter cleanup of the real-week side effect.
  await redis.del(`pool:week:${toIsoWeek(WHALE_TS)}`)
  await pool`DELETE FROM earning_events WHERE iso_week = ${toIsoWeek(WHALE_TS)} AND user_id = ${WHALE_ID}`
})

describe('whale end-to-end — Redis sortedset score behaviour', () => {
  it('Redis returns the whale score in scientific notation (the form that crashed)', async () => {
    const raw = await redis.zscore(leaderboardKey(ISO_WEEK), WHALE_ID)
    assert(raw !== null, 'whale must be in the synthetic-week ZSET')
    // This is the production behaviour we have to handle: raw string
    // is "5e+18", not "5000000000000000050". Inline BigInt() crashes.
    expect(raw).toContain('e+')
    expect(raw).toBe(WHALE_REDIS_SCORE_SCIENTIFIC)
  })
})

describe('whale end-to-end — service layer', () => {
  it('getTop does not crash and ranks the whale at #1', async () => {
    const top = await getTop(redis, ISO_WEEK, 100)
    expect(top.length).toBeGreaterThan(0)
    expect(top[0]?.userId).toBe(WHALE_ID)
    expect(typeof top[0]?.score).toBe('bigint')
  })

  it('getScore returns a BigInt close to the whale amount', async () => {
    const score = await getScore(redis, ISO_WEEK, WHALE_ID)
    assert(score !== null)
    // Sub-coin drift past 2^53 is documented; bound it loosely.
    const drift = score > WHALE_AMOUNT ? score - WHALE_AMOUNT : WHALE_AMOUNT - score
    expect(drift).toBeLessThan(1_000_000n)
  })

  it('getOwnRankCluster centres on the whale without throwing', async () => {
    const cluster = await getOwnRankCluster(redis, ISO_WEEK, WHALE_ID)
    assert(cluster !== null)
    expect(cluster.rank).toBe(1)
    expect(cluster.cluster.some((e) => e.userId === WHALE_ID)).toBe(true)
  })

  it('getSampleUsers does not crash with a whale at the top (Bug 3 regression)', async () => {
    // This is the exact endpoint that returned HTTP 500 in production
    // before the fix. The route mounts getSampleUsers; the route test
    // suite mocks the service, so without this real-Redis assertion
    // the whale path would have no coverage at all.
    const sample = await getSampleUsers(redis, {} as never, ISO_WEEK, 5)
    expect(sample.length).toBeGreaterThan(0)
    expect(sample.every((s) => typeof s.score === 'bigint')).toBe(true)
  })

  it('getCurrentPool returns the whale-driven pool as BigInt', async () => {
    const poolValue = await getCurrentPool(redis, db, ISO_WEEK)
    expect(poolValue).toBe(WHALE_POOL_CONTRIBUTION)
  })

  it('getTopView gracefully falls back when Mongo is absent', async () => {
    // We pass a fake Mongo Db (the leaderboard-view module wraps the
    // lookup in try/catch and falls back to a deterministic
    // "Player #..." username on failure).
    const view = await getTopView(redis, {} as never, ISO_WEEK, 5)
    expect(view.length).toBeGreaterThan(0)
    expect(view[0]?.userId).toBe(WHALE_ID)
    expect(view[0]?.username).toMatch(/^Player #/)
  })

  it('getOwnRankView keeps the whale at rank 1 with fallback profile', async () => {
    const view = await getOwnRankView(redis, {} as never, ISO_WEEK, WHALE_ID)
    assert(view !== null)
    expect(view.rank).toBe(1)
    expect(view.cluster[0]?.userId).toBe(WHALE_ID)
  })
})

describe('whale end-to-end — HTTP route layer', () => {
  // Importing buildServer at the top of the file would bind the
  // routes to the real services — exactly what we want, no mocks.
  // The CORS plugin needs CORS_ORIGINS in env (already set by
  // test/setup.ts loading .env), and the routes only use the lazy
  // getPostgres/getRedis/getMongo singletons we already opened.
  it('GET /leaderboard/top returns 200 with the whale ranked', async () => {
    const { buildServer } = await import('../server.ts')
    const app = await buildServer()
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/leaderboard/top?limit=5&isoWeek=${ISO_WEEK}`,
      })
      expect(res.statusCode).toBe(200)
      const body = bodyOf<{
        meta: { pool: string }
        entries: { userId: string; score: string }[]
      }>(res)
      expect(body.meta.pool).toBe(WHALE_POOL_CONTRIBUTION.toString())
      expect(body.entries[0]?.userId).toBe(WHALE_ID)
      // BigInt serialised as decimal string, never scientific.
      expect(body.entries[0]?.score).not.toContain('e+')
    } finally {
      await app.close()
    }
  })

  it('GET /leaderboard/me/:whaleId returns 200', async () => {
    const { buildServer } = await import('../server.ts')
    const app = await buildServer()
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/leaderboard/me/${WHALE_ID}?isoWeek=${ISO_WEEK}`,
      })
      expect(res.statusCode).toBe(200)
      const body = bodyOf<{ rank: number }>(res)
      expect(body.rank).toBe(1)
    } finally {
      await app.close()
    }
  })

  it('GET /users/sample returns 200 (the route that crashed in Bug 3)', async () => {
    const { buildServer } = await import('../server.ts')
    const app = await buildServer()
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/users/sample?n=5&isoWeek=${ISO_WEEK}`,
      })
      expect(res.statusCode).toBe(200)
      const body = bodyOf<{ users: { userId: string; score: string }[] }>(res)
      expect(body.users.length).toBeGreaterThan(0)
      expect(body.users.every((u) => !u.score.includes('e+'))).toBe(true)
    } finally {
      await app.close()
    }
  })

  it('GET /leaderboard/current/:whaleId returns 200 with top + me + meta', async () => {
    const { buildServer } = await import('../server.ts')
    const app = await buildServer()
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/leaderboard/current/${WHALE_ID}?isoWeek=${ISO_WEEK}`,
      })
      expect(res.statusCode).toBe(200)
      const body = bodyOf<{
        meta: { pool: string }
        top: { entries: { userId: string }[] }
        me: { rank: number } | null
      }>(res)
      expect(body.meta.pool).toBe(WHALE_POOL_CONTRIBUTION.toString())
      expect(body.top.entries[0]?.userId).toBe(WHALE_ID)
      expect(body.me?.rank).toBe(1)
    } finally {
      await app.close()
    }
  })
})
