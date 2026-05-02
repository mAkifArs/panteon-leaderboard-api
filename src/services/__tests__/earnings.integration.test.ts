import { drizzle } from 'drizzle-orm/postgres-js'
import IORedisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../../db/schema.ts'
import { recordEarning } from '../earnings.ts'
import { poolKey } from '../redis-keys.ts'

const DATABASE_URL = process.env['DATABASE_URL']
if (!DATABASE_URL) throw new Error('DATABASE_URL must be set')

let pool: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>
let redis: Redis

beforeAll(() => {
  pool = postgres(DATABASE_URL, { max: 5, onnotice: () => undefined })
  db = drizzle(pool, { schema })
})

afterAll(async () => {
  await pool.end({ timeout: 5 })
})

beforeEach(async () => {
  redis = new IORedisMock()
  await redis.flushall()
})

afterEach(() => {
  redis.disconnect()
})

let counter = 0
function uniqueUserId(): string {
  counter++
  return `e-test-${Date.now()}-${counter}`
}

// All tests use 2026-07-22T12:00:00Z which is in ISO week 2026-W30.
const TEST_WEEK = '2026-W30'

async function cleanupUser(userId: string): Promise<void> {
  await pool`DELETE FROM earning_events WHERE user_id = ${userId}`
}

describe('recordEarning — fresh write', () => {
  it('inserts an earning row keyed by upstream user_id', async () => {
    const userId = uniqueUserId()
    try {
      const result = await recordEarning(db, redis, {
        userId,
        amount: 1000n,
        idempotencyKey: `key-${userId}`,
        now: new Date('2026-07-22T12:00:00Z'),
      })

      expect(result.earning.isReplay).toBe(false)
      expect(result.earning.amount).toBe(1000n)
      expect(result.earning.userId).toBe(userId)
      expect(result.earning.isoWeek).toBe(TEST_WEEK)

      const earningRows = await pool<{ amount: string }[]>`
        SELECT amount::text FROM earning_events WHERE user_id = ${userId}
      `
      expect(earningRows).toHaveLength(1)
      expect(earningRows[0]!.amount).toBe('1000')
    } finally {
      await cleanupUser(userId)
    }
  })

  it('updates Redis: leaderboard ZSET + pool counter (2% of amount)', async () => {
    const userId = uniqueUserId()
    try {
      const result = await recordEarning(db, redis, {
        userId,
        amount: 5_000n,
        idempotencyKey: `key-${userId}`,
        now: new Date('2026-07-22T12:00:00Z'),
      })

      // Pool counter += 2% of 5000 = 100
      expect(result.pool.amount).toBe(100n)
      expect(result.pool.isoWeek).toBe(TEST_WEEK)

      // Only player in the (mock) ZSET → rank 1.
      expect(result.newRank).toBe(1)

      // Leaderboard sorted set has the user with score 5000.
      const score = await redis.zscore(`lb:week:${TEST_WEEK}`, result.earning.userId)
      expect(score).toBe('5000')
    } finally {
      await cleanupUser(userId)
    }
  })
})

describe('recordEarning — idempotency', () => {
  it('replaying with the same key returns the original earning, no new row', async () => {
    const userId = uniqueUserId()
    const idempotencyKey = `key-${userId}-once`
    try {
      const first = await recordEarning(db, redis, {
        userId,
        amount: 1000n,
        idempotencyKey,
        now: new Date('2026-07-22T12:00:00Z'),
      })
      expect(first.earning.isReplay).toBe(false)

      const second = await recordEarning(db, redis, {
        userId,
        amount: 9999n, // different amount on retry — must be ignored
        idempotencyKey,
        now: new Date('2026-07-22T12:05:00Z'),
      })
      expect(second.earning.isReplay).toBe(true)
      expect(second.earning.id).toBe(first.earning.id)
      expect(second.earning.amount).toBe(1000n) // original, not 9999

      // Only one row in PG.
      const count = await pool<{ c: string }[]>`
        SELECT COUNT(*)::text AS c FROM earning_events
        WHERE idempotency_key = ${idempotencyKey}
      `
      expect(count[0]!.c).toBe('1')

      // Pool counter still reflects the FIRST insert only (20), not 9999*0.02.
      // 2% of 1000 = 20.
      const poolValue = await redis.get(poolKey(TEST_WEEK))
      expect(poolValue).toBe('20')
    } finally {
      await cleanupUser(userId)
    }
  })
})

describe('recordEarning — idempotency scope is per-user (ADR-009)', () => {
  it('two different users sending the same key get two distinct rows', async () => {
    const userA = uniqueUserId()
    const userB = uniqueUserId()
    const sharedKey = `shared-${Date.now()}`
    try {
      const a = await recordEarning(db, redis, {
        userId: userA,
        amount: 1000n,
        idempotencyKey: sharedKey,
        now: new Date('2026-07-22T12:00:00Z'),
      })
      const b = await recordEarning(db, redis, {
        userId: userB,
        amount: 7777n,
        idempotencyKey: sharedKey,
        now: new Date('2026-07-22T12:00:00Z'),
      })

      // Neither is a replay of the other — different namespaces.
      expect(a.earning.isReplay).toBe(false)
      expect(b.earning.isReplay).toBe(false)

      // Each user gets their own row with their own amount.
      expect(a.earning.userId).toBe(userA)
      expect(a.earning.amount).toBe(1000n)
      expect(b.earning.userId).toBe(userB)
      expect(b.earning.amount).toBe(7777n)
      expect(a.earning.id).not.toBe(b.earning.id)

      // Verify in PG: two rows share the key but on different users.
      const rows = await pool<{ user_id: string; amount: string }[]>`
        SELECT user_id, amount::text FROM earning_events
        WHERE idempotency_key = ${sharedKey}
        ORDER BY user_id
      `
      expect(rows).toHaveLength(2)
      const byUser = new Map(rows.map((r) => [r.user_id, r.amount]))
      expect(byUser.get(userA)).toBe('1000')
      expect(byUser.get(userB)).toBe('7777')
    } finally {
      await cleanupUser(userA)
      await cleanupUser(userB)
    }
  })

  it('same user + same key is still a replay (dedup intact within scope)', async () => {
    const userId = uniqueUserId()
    const key = `same-${Date.now()}`
    try {
      const first = await recordEarning(db, redis, {
        userId,
        amount: 500n,
        idempotencyKey: key,
        now: new Date('2026-07-22T12:00:00Z'),
      })
      const second = await recordEarning(db, redis, {
        userId,
        amount: 9999n,
        idempotencyKey: key,
        now: new Date('2026-07-22T12:01:00Z'),
      })

      expect(first.earning.isReplay).toBe(false)
      expect(second.earning.isReplay).toBe(true)
      expect(second.earning.id).toBe(first.earning.id)
      expect(second.earning.amount).toBe(500n)
    } finally {
      await cleanupUser(userId)
    }
  })
})

describe('recordEarning — pool counter is BigInt-safe past 2^53', () => {
  // We can't assert real-Redis 64-bit-integer behaviour here because
  // ioredis-mock implements INCRBY in JS Number arithmetic and would
  // reproduce the very precision bug we removed. Instead we verify
  // the *contract our code keeps* with Redis: INCRBY is invoked with
  // a decimal-string increment (so the server-side path stays in
  // 64-bit integers), and the post-write read uses GET (which returns
  // the bulk-string representation) parsed via BigInt — never the
  // INCRBY return value, which ioredis casts to a JS Number.
  it('sends INCRBY as a string and re-reads pool via GET', async () => {
    const userId = uniqueUserId()
    const incrbySpy = vi.spyOn(redis, 'incrby')
    const getSpy = vi.spyOn(redis, 'get')
    try {
      // 10^17 + 1 — chosen so the value cannot round-trip through
      // JS Number without losing precision. We don't assert on the
      // returned amount (mock arithmetic distorts it); we assert
      // on what hits the wire.
      const amount = 5_000_000_000_000_000_050n
      const expectedContribution = '100000000000000001'

      await recordEarning(db, redis, {
        userId,
        amount,
        idempotencyKey: `big-${userId}`,
        now: new Date('2026-07-22T12:00:00Z'),
      })

      // INCRBY received a decimal string, not a number. This is the
      // bit that prevents IEEE-754 rounding on the way to the server.
      expect(incrbySpy).toHaveBeenCalledWith(poolKey(TEST_WEEK), expectedContribution)

      // Pool counter is read back via GET, never reused from the
      // INCRBY reply. ioredis casts INCRBY's integer reply to a JS
      // Number; GET returns the bulk-string verbatim, so BigInt(...)
      // preserves the full 64-bit value.
      expect(getSpy).toHaveBeenCalledWith(poolKey(TEST_WEEK))

      // PG-side agrees on the underlying earning amount (BIGINT, 2^63 cap).
      const pgRow = await pool<{ amount: string }[]>`
        SELECT amount::text FROM earning_events WHERE user_id = ${userId}
      `
      expect(pgRow[0]!.amount).toBe(amount.toString())
    } finally {
      incrbySpy.mockRestore()
      getSpy.mockRestore()
      await cleanupUser(userId)
    }
  })
})

describe('recordEarning — multiple events accumulate', () => {
  it('two earnings from the same user accumulate in PG and Redis', async () => {
    const userId = uniqueUserId()
    try {
      await recordEarning(db, redis, {
        userId,
        amount: 100n,
        idempotencyKey: `${userId}-1`,
        now: new Date('2026-07-22T12:00:00Z'),
      })
      const second = await recordEarning(db, redis, {
        userId,
        amount: 250n,
        idempotencyKey: `${userId}-2`,
        now: new Date('2026-07-22T12:01:00Z'),
      })

      // PG: two rows, sum = 350.
      const sumRows = await pool<{ s: string }[]>`
        SELECT COALESCE(SUM(amount), 0)::text AS s FROM earning_events
        WHERE user_id = ${second.earning.userId}
      `
      expect(sumRows[0]!.s).toBe('350')

      // Redis ZSET score for the user = 350 (ZINCRBY accumulates).
      const score = await redis.zscore(`lb:week:${TEST_WEEK}`, second.earning.userId)
      expect(score).toBe('350')

      // Pool counter = 2% of (100 + 250) = 7
      expect(second.pool.amount).toBe(7n)
    } finally {
      await cleanupUser(userId)
    }
  })
})
