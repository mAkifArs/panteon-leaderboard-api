import { drizzle } from 'drizzle-orm/postgres-js'
import IORedisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as schema from '../../db/schema.ts'
import { runWeeklyDistribution } from '../distribution.ts'

/**
 * Integration tests against a real Postgres (docker compose).
 *
 * Required: `docker compose up -d` and `bun run db:migrate` must
 * have run; DATABASE_URL must point to the live instance. If
 * either is missing, this suite errors out.
 *
 * Each test uses a unique `isoWeek` prefix to avoid colliding
 * with other tests or with real data.
 *
 * Redis is mocked (ioredis-mock) — the lock + release path is
 * already covered by distribution-lock.test.ts. Mongo is omitted
 * here; audit-collection coverage will land with the mongo
 * integration sub-chunk.
 */

const DATABASE_URL = process.env['DATABASE_URL']
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL must be set for integration tests (cp .env.example .env)')
}

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

let weekCounter = 0
function uniqueWeek(): string {
  weekCounter++
  // Use a clearly synthetic iso-week-shaped string so no real
  // production data could ever collide. Pad to fit the regex
  // shape: YYYY-WXX with 4 digits + W + 2 digits.
  return `9999-W${String(weekCounter).padStart(2, '0')}`
}

async function seedPlayers(
  isoWeek: string,
  players: { userId: string; amount: bigint; earnedAt?: Date }[],
): Promise<void> {
  for (const p of players) {
    await pool`
      INSERT INTO earning_events (user_id, amount, iso_week, idempotency_key, earned_at)
      VALUES (
        ${p.userId},
        ${p.amount.toString()}::bigint,
        ${isoWeek},
        ${`key-${p.userId}-${isoWeek}`},
        ${(p.earnedAt ?? new Date()).toISOString()}::timestamptz
      )
    `
  }
}

async function cleanupWeek(isoWeek: string): Promise<void> {
  await pool`DELETE FROM prize_payouts WHERE iso_week = ${isoWeek}`
  await pool`DELETE FROM earning_events WHERE iso_week = ${isoWeek}`
  await pool`DELETE FROM weekly_pools WHERE iso_week = ${isoWeek}`
}

describe('runWeeklyDistribution — happy path', () => {
  it('distributes a pool of 100 players and writes 100 payout rows', async () => {
    const isoWeek = uniqueWeek()
    try {
      // 100 players with distinct scores: player N earns N*1000.
      const players = Array.from({ length: 100 }, (_, i) => ({
        userId: `u-${isoWeek}-${String(i + 1).padStart(3, '0')}`,
        amount: BigInt((i + 1) * 1000),
      }))
      await seedPlayers(isoWeek, players)

      const result = await runWeeklyDistribution({ isoWeek, db, redis })

      expect(result.status).toBe('distributed')
      if (result.status !== 'distributed') return
      expect(result.payouts).toHaveLength(100)
      expect(result.runId).toMatch(/^[0-9a-f-]{36}$/)
      // Pool = 2% of (1000 + 2000 + ... + 100000) = 2% * 5_050_000 = 101_000
      expect(result.totalPool).toBe(101_000n)

      // Verify the rows landed in PG.
      const payoutRows = await pool<{ rank: number; amount: string }[]>`
        SELECT rank, amount::text FROM prize_payouts
        WHERE iso_week = ${isoWeek}
        ORDER BY rank
      `
      expect(payoutRows).toHaveLength(100)

      // Sum of amounts = totalPool exactly (no money lost).
      const sum = payoutRows.reduce((s, r) => s + BigInt(r.amount), 0n)
      expect(sum).toBe(101_000n)

      // Status flipped to 'distributed'.
      const poolRow = await pool<{ status: string; pool_amount: string }[]>`
        SELECT status, pool_amount::text FROM weekly_pools WHERE iso_week = ${isoWeek}
      `
      expect(poolRow[0]!.status).toBe('distributed')
      expect(poolRow[0]!.pool_amount).toBe('101000')
    } finally {
      await cleanupWeek(isoWeek)
    }
  })

  it('is idempotent: second run returns already-distributed', async () => {
    const isoWeek = uniqueWeek()
    try {
      await seedPlayers(isoWeek, [
        { userId: `u-${isoWeek}-001`, amount: 10_000n },
        { userId: `u-${isoWeek}-002`, amount: 5_000n },
      ])

      const first = await runWeeklyDistribution({ isoWeek, db, redis })
      expect(first.status).toBe('distributed')

      // Second run on the same week — must be a no-op.
      const second = await runWeeklyDistribution({ isoWeek, db, redis })
      expect(second.status).toBe('skipped')
      if (second.status === 'skipped') {
        expect(second.reason).toBe('already-distributed')
      }

      // Still only one set of payouts in PG.
      const payoutCount = await pool<{ c: string }[]>`
        SELECT COUNT(*)::text AS c FROM prize_payouts WHERE iso_week = ${isoWeek}
      `
      expect(payoutCount[0]!.c).toBe('2')
    } finally {
      await cleanupWeek(isoWeek)
    }
  })
})

describe('runWeeklyDistribution — empty week', () => {
  it('returns no-earnings and marks the week distributed', async () => {
    const isoWeek = uniqueWeek()
    try {
      // No players, no events.
      const result = await runWeeklyDistribution({ isoWeek, db, redis })
      expect(result.status).toBe('skipped')
      if (result.status === 'skipped') {
        expect(result.reason).toBe('no-earnings')
      }

      // weekly_pools row was created with status = distributed and amount = 0.
      const poolRow = await pool<{ status: string; pool_amount: string }[]>`
        SELECT status, pool_amount::text FROM weekly_pools WHERE iso_week = ${isoWeek}
      `
      expect(poolRow[0]!.status).toBe('distributed')
      expect(poolRow[0]!.pool_amount).toBe('0')

      // No payouts.
      const payoutCount = await pool<{ c: string }[]>`
        SELECT COUNT(*)::text AS c FROM prize_payouts WHERE iso_week = ${isoWeek}
      `
      expect(payoutCount[0]!.c).toBe('0')
    } finally {
      await cleanupWeek(isoWeek)
    }
  })
})

describe('runWeeklyDistribution — fewer than 100 players', () => {
  it('distributes to all existing players (5 winners)', async () => {
    const isoWeek = uniqueWeek()
    try {
      await seedPlayers(
        isoWeek,
        [10_000n, 8_000n, 6_000n, 4_000n, 2_000n].map((amount, i) => ({
          userId: `u-${isoWeek}-${String(i + 1).padStart(3, '0')}`,
          amount,
        })),
      )

      const result = await runWeeklyDistribution({ isoWeek, db, redis })
      expect(result.status).toBe('distributed')
      if (result.status !== 'distributed') return
      expect(result.payouts).toHaveLength(5)

      // Pool = 2% of 30_000 = 600
      expect(result.totalPool).toBe(600n)

      // Sum of payouts = pool exactly.
      const sum = result.payouts.reduce((s, p) => s + p.amount, 0n)
      expect(sum).toBe(600n)
    } finally {
      await cleanupWeek(isoWeek)
    }
  })
})

describe('runWeeklyDistribution — deterministic tie-breaking', () => {
  it('ranks ties by earliest first earning timestamp', async () => {
    const isoWeek = uniqueWeek()
    try {
      // Three players, all earning 5000, but at different times.
      // Earlier first_earning = better rank.
      const t0 = new Date('2026-04-20T10:00:00Z')
      const t1 = new Date('2026-04-20T11:00:00Z')
      const t2 = new Date('2026-04-20T12:00:00Z')
      const earlyId = `u-${isoWeek}-early`
      await seedPlayers(isoWeek, [
        { userId: `u-${isoWeek}-late`, amount: 5_000n, earnedAt: t2 },
        { userId: earlyId, amount: 5_000n, earnedAt: t0 },
        { userId: `u-${isoWeek}-mid`, amount: 5_000n, earnedAt: t1 },
      ])

      const result = await runWeeklyDistribution({ isoWeek, db, redis })
      expect(result.status).toBe('distributed')

      const payoutRows = await pool<{ rank: number; user_id: string }[]>`
        SELECT rank, user_id FROM prize_payouts
        WHERE iso_week = ${isoWeek}
        ORDER BY rank
      `
      // Rank 1 must be the earliest earner.
      expect(payoutRows[0]!.user_id).toBe(earlyId)
      expect(payoutRows[0]!.rank).toBe(1)
    } finally {
      await cleanupWeek(isoWeek)
    }
  })

  it('a whale alongside normal players ranks correctly from PG (drift-immune)', async () => {
    // Regression guard for the documented invariant: cron payout
    // re-materialises ranking from PG, never from Redis. A whale
    // amount that would cause sub-coin drift in the Redis sortedset
    // view must still produce exact PG-side rank order.
    const isoWeek = uniqueWeek()
    try {
      const whaleId = `u-${isoWeek}-whale`
      const normal1 = `u-${isoWeek}-normal1`
      const normal2 = `u-${isoWeek}-normal2`
      await seedPlayers(isoWeek, [
        { userId: whaleId, amount: 5_000_000_000_000_000_050n },
        { userId: normal1, amount: 1_000n },
        { userId: normal2, amount: 500n },
      ])

      const result = await runWeeklyDistribution({ isoWeek, db, redis })
      expect(result.status).toBe('distributed')

      const payoutRows = await pool<{ rank: number; user_id: string }[]>`
        SELECT rank, user_id FROM prize_payouts
        WHERE iso_week = ${isoWeek}
        ORDER BY rank
      `
      expect(payoutRows[0]!.user_id).toBe(whaleId)
      expect(payoutRows[1]!.user_id).toBe(normal1)
      expect(payoutRows[2]!.user_id).toBe(normal2)
    } finally {
      await cleanupWeek(isoWeek)
    }
  })
})
