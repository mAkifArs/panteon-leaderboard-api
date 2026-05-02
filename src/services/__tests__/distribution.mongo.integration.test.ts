import { drizzle } from 'drizzle-orm/postgres-js'
import IORedisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import { MongoClient, type Db } from 'mongodb'
import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import * as schema from '../../db/schema.ts'
import {
  ensureMongoIndexes,
  playerProfiles,
  prizeDistributions,
  weeklySnapshots,
} from '../../db/mongo-collections.ts'
import { runWeeklyDistribution } from '../distribution.ts'

/**
 * Integration tests for the MongoDB write path of
 * `runWeeklyDistribution` (distribution.ts:255–305).
 *
 * The PG-only suite (`distribution.integration.test.ts`) does not
 * pass `mongo`, so the audit/snapshot block never runs there. This
 * file fills that gap: real PG, real Mongo (docker-compose),
 * `ioredis-mock` for the lock — the lock + release path is already
 * covered by `distribution-lock.test.ts` and a real Redis would add
 * setup cost without adding signal here.
 *
 * Why this test matters: the Mongo write is wrapped in a try/catch
 * that only logs on failure. PG truth and `/replay-week` make a
 * Mongo failure recoverable, but a regression in shape (wrong
 * field, replaceOne→insertOne, missing fallback) would pass the
 * existing suite and surface to a player as "previous week's
 * leaderboard is empty" or "Player #undefined". That regression
 * mode is what the three cases below pin down.
 */

const DATABASE_URL = process.env['DATABASE_URL']
const MONGO_URL = process.env['MONGO_URL']
const MONGO_DB = process.env['MONGO_DB'] ?? 'leaderboard'
if (!DATABASE_URL) throw new Error('DATABASE_URL must be set for integration tests')
if (!MONGO_URL) throw new Error('MONGO_URL must be set for integration tests')

let pool: ReturnType<typeof postgres>
let db: ReturnType<typeof drizzle<typeof schema>>
let mongoClient: MongoClient
let mongo: Db
let redis: Redis

beforeAll(async () => {
  pool = postgres(DATABASE_URL, { max: 5, onnotice: () => undefined })
  db = drizzle(pool, { schema })
  mongoClient = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 5000 })
  await mongoClient.connect()
  mongo = mongoClient.db(MONGO_DB)
  await ensureMongoIndexes(mongo)
})

afterAll(async () => {
  await pool.end({ timeout: 5 })
  await mongoClient.close()
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
  // 9998-Wxx instead of 9999-Wxx: the PG-only suite
  // (`distribution.integration.test.ts`) already uses 9999-Wxx and
  // vitest runs files in parallel by default, so the two suites
  // would otherwise collide on iso_week. Both prefixes are
  // impossible in real data.
  return `9998-W${String(weekCounter).padStart(2, '0')}`
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
        ${`mongo-key-${p.userId}-${isoWeek}-${String(Math.random())}`},
        ${(p.earnedAt ?? new Date()).toISOString()}::timestamptz
      )
    `
  }
}

async function seedProfiles(
  profiles: { userId: string; username: string; country?: string }[],
): Promise<void> {
  if (profiles.length === 0) return
  const now = new Date()
  await playerProfiles(mongo).insertMany(
    profiles.map((p) => ({
      _id: p.userId,
      username: p.username,
      ...(p.country !== undefined && { country: p.country }),
      createdAt: now,
      updatedAt: now,
    })),
  )
}

async function cleanupWeek(isoWeek: string, profileIds: string[] = []): Promise<void> {
  await pool`DELETE FROM prize_payouts WHERE iso_week = ${isoWeek}`
  await pool`DELETE FROM earning_events WHERE iso_week = ${isoWeek}`
  await pool`DELETE FROM weekly_pools WHERE iso_week = ${isoWeek}`
  await prizeDistributions(mongo).deleteMany({ isoWeek })
  await weeklySnapshots(mongo).deleteOne({ _id: isoWeek })
  if (profileIds.length > 0) {
    await playerProfiles(mongo).deleteMany({ _id: { $in: profileIds } })
  }
}

describe('runWeeklyDistribution — Mongo audit + snapshot writes', () => {
  it('writes prize_distributions audit doc and weekly_snapshots with resolved profiles', async () => {
    const isoWeek = uniqueWeek()
    const ids = [
      `u-${isoWeek}-001`,
      `u-${isoWeek}-002`,
      `u-${isoWeek}-003`,
    ]
    try {
      await seedProfiles([
        { userId: ids[0]!, username: 'AlphaWolf', country: 'TR' },
        { userId: ids[1]!, username: 'BetaForge', country: 'DE' },
        { userId: ids[2]!, username: 'GammaShade', country: 'JP' },
      ])
      await seedPlayers(isoWeek, [
        { userId: ids[0]!, amount: 30_000n },
        { userId: ids[1]!, amount: 20_000n },
        { userId: ids[2]!, amount: 10_000n },
      ])

      const result = await runWeeklyDistribution({ isoWeek, db, redis, mongo })
      expect(result.status).toBe('distributed')
      if (result.status !== 'distributed') return

      // Pool = 2% of 60_000 = 1_200
      expect(result.totalPool).toBe(1_200n)

      // (a) prize_distributions audit doc
      const audit = await prizeDistributions(mongo).findOne({ _id: result.runId })
      expect(audit).not.toBeNull()
      expect(audit!.isoWeek).toBe(isoWeek)
      expect(audit!.totalPool).toBe('1200')
      expect(audit!.runAt).toBeInstanceOf(Date)
      expect(audit!.payouts).toHaveLength(3)
      // Each entry: { rank: number, amount: decimal-string }
      for (const p of audit!.payouts) {
        expect(typeof p.rank).toBe('number')
        expect(typeof p.amount).toBe('string')
        expect(p.amount).toMatch(/^\d+$/)
      }

      // (b) weekly_snapshots doc, _id == isoWeek
      const snapshot = await weeklySnapshots(mongo).findOne({ _id: isoWeek })
      expect(snapshot).not.toBeNull()
      expect(snapshot!.isoWeek).toBe(isoWeek)
      expect(snapshot!.totalPool).toBe('1200')
      expect(snapshot!.generatedAt).toBeInstanceOf(Date)
      expect(snapshot!.top).toHaveLength(3)

      // Rank ASC ordering
      expect(snapshot!.top.map((e) => e.rank)).toEqual([1, 2, 3])

      // Top-1: profile resolved (username + country come from Mongo)
      expect(snapshot!.top[0]!.userId).toBe(ids[0])
      expect(snapshot!.top[0]!.username).toBe('AlphaWolf')
      expect(snapshot!.top[0]!.country).toBe('TR')

      // BigInt serialisation contract: total + prize are decimal strings
      for (const e of snapshot!.top) {
        expect(typeof e.total).toBe('string')
        expect(typeof e.prize).toBe('string')
        expect(e.total).toMatch(/^\d+$/)
        expect(e.prize).toMatch(/^\d+$/)
      }
    } finally {
      await cleanupWeek(isoWeek, ids)
    }
  })

  it('falls back to "Player #<slice>" when a profile is missing in Mongo', async () => {
    const isoWeek = uniqueWeek()
    // Use stable, non-random ids so the slice(0,8) assertion is exact.
    const withProfile = 'profiled-player-id-aaaaaa'
    const withoutProfile = 'orphan-player-id-bbbbbb'
    try {
      // Seed only one of the two profiles.
      await seedProfiles([{ userId: withProfile, username: 'Profiled', country: 'TR' }])
      await seedPlayers(isoWeek, [
        { userId: withProfile, amount: 10_000n },
        { userId: withoutProfile, amount: 5_000n },
      ])

      const result = await runWeeklyDistribution({ isoWeek, db, redis, mongo })
      expect(result.status).toBe('distributed')

      const snapshot = await weeklySnapshots(mongo).findOne({ _id: isoWeek })
      expect(snapshot).not.toBeNull()
      expect(snapshot!.top).toHaveLength(2)

      // Resolved profile keeps its real username + country
      const profiledEntry = snapshot!.top.find((e) => e.userId === withProfile)
      expect(profiledEntry?.username).toBe('Profiled')
      expect(profiledEntry?.country).toBe('TR')

      // Missing profile gets the deterministic fallback. The exact
      // formula (distribution.ts:281) is `Player #${id.slice(0,8)}`.
      const orphanEntry = snapshot!.top.find((e) => e.userId === withoutProfile)
      expect(orphanEntry?.username).toBe(`Player #${withoutProfile.slice(0, 8)}`)
      // Country must be omitted when absent (no `country: undefined` leak)
      expect(Object.prototype.hasOwnProperty.call(orphanEntry, 'country')).toBe(false)
    } finally {
      await cleanupWeek(isoWeek, [withProfile])
    }
  })

  it('replaces (not duplicates) the snapshot when distribution re-runs after forensic reset', async () => {
    const isoWeek = uniqueWeek()
    const ids = [`u-${isoWeek}-001`, `u-${isoWeek}-002`]
    try {
      await seedProfiles([
        { userId: ids[0]!, username: 'FirstRun', country: 'TR' },
        { userId: ids[1]!, username: 'AlsoFirstRun', country: 'DE' },
      ])
      await seedPlayers(isoWeek, [
        { userId: ids[0]!, amount: 10_000n },
        { userId: ids[1]!, amount: 5_000n },
      ])

      const first = await runWeeklyDistribution({ isoWeek, db, redis, mongo })
      expect(first.status).toBe('distributed')

      const v1 = await weeklySnapshots(mongo).findOne({ _id: isoWeek })
      expect(v1).not.toBeNull()
      const v1GeneratedAt = v1!.generatedAt.getTime()
      const v1TotalPool = v1!.totalPool

      // Forensic recovery simulation: drop the payouts, flip the
      // pool back to 'open' so the CAS in the next run can claim
      // it again. Add more earnings so the new snapshot must differ.
      await pool`DELETE FROM prize_payouts WHERE iso_week = ${isoWeek}`
      await pool`UPDATE weekly_pools SET status = 'open', distributed_at = NULL WHERE iso_week = ${isoWeek}`
      await seedPlayers(isoWeek, [{ userId: ids[0]!, amount: 90_000n }])

      // Small delay to make the v2 generatedAt strictly greater
      // than v1; replaceOne sets it to `now()` at write time so a
      // sub-millisecond test can otherwise tie.
      await new Promise((r) => setTimeout(r, 10))

      const second = await runWeeklyDistribution({ isoWeek, db, redis, mongo })
      expect(second.status).toBe('distributed')

      // Exactly one snapshot doc — replaceOne (not insertOne)
      const count = await weeklySnapshots(mongo).countDocuments({ _id: isoWeek })
      expect(count).toBe(1)

      const v2 = await weeklySnapshots(mongo).findOne({ _id: isoWeek })
      expect(v2).not.toBeNull()
      expect(v2!.generatedAt.getTime()).toBeGreaterThan(v1GeneratedAt)
      // Pool grew with the extra earnings, so totalPool must change
      expect(v2!.totalPool).not.toBe(v1TotalPool)

      // prize_distributions, on the other hand, is insertOne — both
      // runs leave their own audit doc behind (different runIds).
      const auditCount = await prizeDistributions(mongo).countDocuments({ isoWeek })
      expect(auditCount).toBe(2)
    } finally {
      await cleanupWeek(isoWeek, ids)
    }
  })
})
