import { sql } from 'drizzle-orm'
import type { Db } from 'mongodb'
import { v4 as uuidv4 } from 'uuid'
import type { Database } from '../db/postgres.ts'
import type { Redis } from 'ioredis'
import {
  playerProfiles,
  prizeDistributions,
  weeklySnapshots,
  type WeeklySnapshotEntry,
} from '../db/mongo-collections.ts'
import { distributePool, type Payout } from '../lib/prize-math.ts'
import {
  acquireDistributionLock,
  releaseDistributionLock,
} from './distribution-lock.ts'

/**
 * Weekly prize-distribution orchestrator.
 *
 * Combines four layers of safety (CLAUDE.md invariant + ADR-003,
 * forthcoming):
 *   1. Redis SETNX lock — blocks concurrent cron triggers across
 *      horizontally-scaled API instances.
 *   2. weekly_pools.status state machine — atomic CAS from 'open'
 *      to 'distributing' inside the PG transaction.
 *   3. UNIQUE (iso_week, user_id) on prize_payouts — DB-level
 *      guard against double-credit.
 *   4. UNIQUE (iso_week, rank) on prize_payouts — DB-level guard
 *      against tie-break collisions, also makes deterministic
 *      tie-breaking enforceable.
 *
 * The function is **idempotent**: calling it twice on the same
 * already-distributed week is a no-op. A crash mid-distribution
 * leaves the row in 'distributing' state; manual recovery is
 * required (see runbook in /replay-week skill).
 */

export const DEFAULT_LOCK_TTL_MS = 10 * 60 * 1000 // 10 minutes

export interface RankedPlayer {
  userId: string
  total: bigint
}

export type DistributionOutcome =
  | {
      status: 'distributed'
      runId: string
      payouts: Payout[]
      totalPool: bigint
      topPlayers: RankedPlayer[]
    }
  | { status: 'skipped'; reason: 'lock-held' | 'already-distributed' | 'no-earnings' | 'in-flight' }

export interface RunDistributionOptions {
  isoWeek: string
  db: Database
  redis: Redis
  mongo?: Db
  lockTtlMs?: number
  /** Override the runId for testability; otherwise a fresh UUID is generated. */
  runId?: string
  /** Override the clock for testability. */
  now?: () => Date
}

interface PlayerRow extends Record<string, unknown> {
  user_id: string
  total: string
  first_earning_at: Date
  first_earning_id: string
}

type TxOutcome =
  | {
      status: 'distributed'
      runId: string
      payouts: Payout[]
      totalPool: bigint
      topPlayers: RankedPlayer[]
    }
  | {
      status: 'skipped'
      reason: 'already-distributed' | 'no-earnings' | 'in-flight'
    }

export async function runWeeklyDistribution(
  opts: RunDistributionOptions,
): Promise<DistributionOutcome> {
  const {
    isoWeek,
    db,
    redis,
    mongo,
    lockTtlMs = DEFAULT_LOCK_TTL_MS,
    runId = uuidv4(),
    now = () => new Date(),
  } = opts

  // 1. Acquire the Redis lock. If someone else holds it, bail.
  const lock = await acquireDistributionLock(redis, isoWeek, runId, lockTtlMs)
  if (!lock) {
    return { status: 'skipped', reason: 'lock-held' }
  }

  try {
    // 2. Inside a PG transaction:
    //    - Atomically claim the week (status: open -> distributing)
    //    - Compute pool from PG (source of truth)
    //    - Read top 100 with deterministic tie-breaking
    //    - Insert payouts
    //    - Mark distributed
    const result: TxOutcome = await db.transaction(async (tx): Promise<TxOutcome> => {
      // Atomic CAS: only succeeds if the week is currently 'open'.
      // If the row doesn't exist (no earnings this week), we'll
      // create it here in 'distributing' state. If it exists with
      // status != 'open', the WHERE clause matches nothing.
      const claimed = await tx.execute(sql`
        INSERT INTO weekly_pools (iso_week, status)
        VALUES (${isoWeek}, 'distributing')
        ON CONFLICT (iso_week) DO UPDATE
          SET status = 'distributing'
          WHERE weekly_pools.status = 'open'
        RETURNING iso_week, status
      `)
      if (claimed.length === 0) {
        // Row exists but status was not 'open' — already distributed
        // or another instance is in flight.
        const existing = await tx.execute<{ status: string }>(sql`
          SELECT status FROM weekly_pools WHERE iso_week = ${isoWeek}
        `)
        const status = existing[0]?.status
        return {
          status: 'skipped',
          reason: status === 'distributed' ? 'already-distributed' : 'in-flight',
        }
      }

      // Compute the prize pool from PG (truth).
      // 2% of total earnings for the week, BigInt math.
      const poolRows = await tx.execute<{ total_earnings: string | null }>(sql`
        SELECT COALESCE(SUM(amount), 0)::text AS total_earnings
        FROM earning_events
        WHERE iso_week = ${isoWeek}
      `)
      const totalEarnings = BigInt(poolRows[0]?.total_earnings ?? '0')
      const totalPool = (totalEarnings * 2n) / 100n

      if (totalPool <= 0n) {
        // No earnings (or net negative). Mark distributed-trivially
        // so the cron doesn't keep retrying.
        await tx.execute(sql`
          UPDATE weekly_pools
          SET status = 'distributed', distributed_at = ${now().toISOString()}::timestamptz, pool_amount = 0
          WHERE iso_week = ${isoWeek}
        `)
        return { status: 'skipped', reason: 'no-earnings' }
      }

      // Persist the pool amount for audit.
      await tx.execute(sql`
        UPDATE weekly_pools
        SET pool_amount = ${totalPool.toString()}::bigint
        WHERE iso_week = ${isoWeek}
      `)

      // Top 100 with deterministic tie-breaking (CLAUDE.md
      // invariant 7): score DESC, first_earning_at ASC,
      // first_earning_id ASC.
      const topRows = await tx.execute<PlayerRow>(sql`
        SELECT
          user_id                                       AS user_id,
          SUM(amount)::text                             AS total,
          MIN(earned_at)                                AS first_earning_at,
          MIN(id)::text                                 AS first_earning_id
        FROM earning_events
        WHERE iso_week = ${isoWeek}
        GROUP BY user_id
        HAVING SUM(amount) > 0
        ORDER BY
          SUM(amount)      DESC,
          MIN(earned_at)   ASC,
          MIN(id)          ASC
        LIMIT 100
      `)

      const totalWinners = topRows.length
      const payouts = distributePool(totalPool, totalWinners)

      // Insert payouts row-by-row. The two UNIQUE constraints on
      // prize_payouts will reject any duplicate from a botched
      // re-run (defence in depth).
      for (const payout of payouts) {
        const player = topRows[payout.rank - 1]!
        await tx.execute(sql`
          INSERT INTO prize_payouts (
            iso_week, user_id, rank, amount, distribution_id, distributed_at
          ) VALUES (
            ${isoWeek},
            ${player.user_id},
            ${payout.rank},
            ${payout.amount.toString()}::bigint,
            ${runId}::uuid,
            ${now().toISOString()}::timestamptz
          )
        `)
      }

      // Close the week.
      await tx.execute(sql`
        UPDATE weekly_pools
        SET status = 'distributed', distributed_at = ${now().toISOString()}::timestamptz
        WHERE iso_week = ${isoWeek}
      `)

      const topPlayers: RankedPlayer[] = topRows.map((r) => ({
        userId: r.user_id,
        total: BigInt(r.total),
      }))

      return {
        status: 'distributed',
        runId,
        payouts,
        totalPool,
        topPlayers,
      }
    })

    // 3. Mongo writes (best-effort, separate from the PG
    // transaction — Mongo failure does NOT roll back PG, because
    // the snapshot can be reconstructed from PG via /replay-week).
    //
    //   (a) prize_distributions — one audit doc per cron run.
    //   (b) weekly_snapshots — denormalised top-100 with
    //       username/country resolved from player_profiles, frozen
    //       in time. Drives the "previous week" UI without
    //       hitting PG.
    if (mongo && result.status === 'distributed') {
      try {
        await prizeDistributions(mongo).insertOne({
          _id: runId,
          isoWeek,
          runAt: now(),
          totalPool: result.totalPool.toString(),
          payouts: result.payouts.map((p) => ({
            rank: p.rank,
            amount: p.amount.toString(),
          })),
        })

        const userIds = result.topPlayers.map((p) => p.userId)
        const profiles = await playerProfiles(mongo)
          .find({ _id: { $in: userIds } })
          .toArray()
        const profileById = new Map(profiles.map((p) => [p._id, p]))

        const top: WeeklySnapshotEntry[] = result.payouts.map((payout) => {
          const player = result.topPlayers[payout.rank - 1]!
          const profile = profileById.get(player.userId)
          const country = profile?.country
          return {
            rank: payout.rank,
            userId: player.userId,
            username: profile?.username ?? `Player #${player.userId.slice(0, 8)}`,
            ...(country !== undefined && { country }),
            total: player.total.toString(),
            prize: payout.amount.toString(),
          }
        })

        // replaceOne with upsert: re-running on the same week
        // overwrites cleanly. PG-side idempotency (UNIQUE on
        // prize_payouts) means a re-run only happens after
        // explicit recovery, so overwrite is safe.
        await weeklySnapshots(mongo).replaceOne(
          { _id: isoWeek },
          {
            isoWeek,
            generatedAt: now(),
            totalPool: result.totalPool.toString(),
            top,
          },
          { upsert: true },
        )
      } catch (err) {
        console.error(
          '[distribution] mongo write failed (PG already committed):',
          (err as Error).message,
        )
      }
    }

    return result
  } finally {
    await releaseDistributionLock(redis, lock)
  }
}
