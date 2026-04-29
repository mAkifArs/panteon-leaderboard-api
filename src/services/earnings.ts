import { sql } from 'drizzle-orm'
import type { Redis } from 'ioredis'
import type { Database } from '../db/postgres.ts'
import { toIsoWeek } from '../lib/iso-week.ts'
import { addEarning, getRank } from './leaderboard.ts'

/**
 * POST /earnings service.
 *
 * Records a single earning event. Sequence:
 *   1. PG: INSERT earning_events with ON CONFLICT
 *      (idempotency_key) DO NOTHING. Idempotency lives at the
 *      database level (ADR-004).
 *   2. After commit: best-effort Redis update — ZINCRBY on the
 *      leaderboard sorted set, INCRBY on the live pool counter.
 *      Redis is the *derived* layer (ADR-001); a Redis write
 *      failure is logged but does not fail the request because
 *      PG already committed and `/rebuild-redis` can recover.
 *
 * The user_id stored in earning_events is the upstream external
 * player id directly (TEXT). There is no PG users table — see
 * ADR-007. Profile data lives in MongoDB.
 *
 * Returns the earning row + the new live pool counter (for UX).
 */

export interface RecordEarningInput {
  /** Upstream external player id. Stored as-is in earning_events.user_id. */
  userId: string
  /** Amount in the smallest currency unit. Positive integers only. */
  amount: bigint
  /** Client-supplied idempotency token. UNIQUE per earning. */
  idempotencyKey: string
  /** Optional override for testability. */
  now?: Date
}

export interface RecordEarningResult {
  earning: {
    id: string
    userId: string
    amount: bigint
    isoWeek: string
    earnedAt: Date
    isReplay: boolean
  }
  pool: {
    isoWeek: string
    amount: bigint
  }
  /**
   * The user's rank after this earning was applied (1-indexed,
   * lower = better). `null` if the user is not yet in the
   * leaderboard sorted set (Redis miss / cold start) — frontend
   * should fall back to /leaderboard/me.
   */
  newRank: number | null
}

const POOL_KEY_PREFIX = 'pool:week:'
function poolKey(isoWeek: string): string {
  return `${POOL_KEY_PREFIX}${isoWeek}`
}

interface EarningRow extends Record<string, unknown> {
  id: string
  user_id: string
  amount: string
  iso_week: string
  earned_at: Date
}

export async function recordEarning(
  db: Database,
  redis: Redis,
  input: RecordEarningInput,
): Promise<RecordEarningResult> {
  const earnedAt = input.now ?? new Date()
  const isoWeek = toIsoWeek(earnedAt)

  // ON CONFLICT (idempotency_key) DO NOTHING + RETURNING tells us
  // whether this is a fresh write or a replay.
  const inserted = await db.execute<EarningRow>(sql`
    INSERT INTO earning_events (
      user_id, amount, iso_week, earned_at, idempotency_key
    ) VALUES (
      ${input.userId},
      ${input.amount.toString()}::bigint,
      ${isoWeek},
      ${earnedAt.toISOString()}::timestamptz,
      ${input.idempotencyKey}
    )
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING id::text, user_id, amount::text, iso_week, earned_at
  `)

  let earning: EarningRow
  let isReplay: boolean
  if (inserted.length > 0) {
    earning = inserted[0]!
    isReplay = false
  } else {
    const existing = await db.execute<EarningRow>(sql`
      SELECT id::text, user_id, amount::text, iso_week, earned_at
      FROM earning_events
      WHERE idempotency_key = ${input.idempotencyKey}
    `)
    earning = existing[0]!
    isReplay = true
  }

  // Redis updates — best-effort, only on a fresh (non-replay)
  // insert. On replay we do nothing because the original write
  // already updated Redis (or rebuild-redis will catch it).
  let poolAmount = 0n
  let newRank: number | null = null
  if (!isReplay) {
    try {
      const contributionToPool = (input.amount * 2n) / 100n
      const [, poolReply] = await Promise.all([
        addEarning(redis, isoWeek, earning.user_id, BigInt(earning.amount)),
        redis.incrby(poolKey(isoWeek), Number(contributionToPool)),
      ])
      poolAmount = BigInt(poolReply)
      // After ZINCRBY, fetch the user's current rank so the
      // frontend can show instant rank-change feedback after
      // POST /earnings (no need to immediately re-poll
      // /leaderboard/me).
      newRank = await getRank(redis, isoWeek, earning.user_id)
    } catch (err) {
      // Log but do not propagate — PG is the source of truth and
      // rebuild-redis can re-derive Redis state from PG.
      console.error('[earnings] redis write failed:', (err as Error).message)
    }
  } else {
    try {
      const [current, rank] = await Promise.all([
        redis.get(poolKey(isoWeek)),
        getRank(redis, isoWeek, earning.user_id),
      ])
      poolAmount = current === null ? 0n : BigInt(current)
      newRank = rank
    } catch {
      poolAmount = 0n
    }
  }

  return {
    earning: {
      id: earning.id,
      userId: earning.user_id,
      amount: BigInt(earning.amount),
      isoWeek: earning.iso_week,
      earnedAt: earning.earned_at,
      isReplay,
    },
    pool: { isoWeek, amount: poolAmount },
    newRank,
  }
}
