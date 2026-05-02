import { sql } from 'drizzle-orm'
import type { Redis } from 'ioredis'
import pino from 'pino'
import type { Database } from '../db/postgres.ts'
import { toIsoWeek } from '../lib/iso-week.ts'
import { addEarning, getRank } from './leaderboard.ts'

const defaultLogger = pino({ name: 'earnings' })

export type EarningsLogger = Pick<pino.BaseLogger, 'error' | 'warn' | 'info'>

/**
 * POST /earnings service.
 *
 * Records a single earning event. Sequence:
 *   1. PG: INSERT earning_events with ON CONFLICT
 *      (user_id, idempotency_key) DO NOTHING. Idempotency lives at
 *      the database level (ADR-004) and its scope is per-user
 *      (ADR-009) — two clients picking the same key by coincidence
 *      get two distinct rows, neither sees the other's data.
 *   2. After commit: best-effort Redis update — ZINCRBY on the
 *      leaderboard sorted set, INCRBY on the live pool counter.
 *      Redis is the *derived* layer (ADR-001); a Redis write
 *      failure is logged but does not fail the request because
 *      PG already committed and `/rebuild-redis` can recover.
 *
 * **BigInt safety on the pool counter.** The leaderboard sorted-set
 * score is forced to be an IEEE-754 double by the Redis spec — drift
 * past 2^53 is documented and tolerated there because the cron
 * always re-materialises the ranking from PG. The pool counter has
 * no such constraint: it is a normal Redis STRING and INCRBY runs
 * native 64-bit integer arithmetic. We pass the BigInt contribution
 * as a decimal string so JS Number is never in the path; precision
 * matches PG up to 2^63. CLAUDE.md invariant 1 (money is BigInt) is
 * preserved end-to-end on this counter.
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
  /** Logger to use; defaults to a pino instance named 'earnings'. */
  logger?: EarningsLogger
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
  const logger = input.logger ?? defaultLogger

  // ON CONFLICT (user_id, idempotency_key) DO NOTHING + RETURNING
  // tells us whether this is a fresh write or a replay. Per-user
  // scope per ADR-009.
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
    ON CONFLICT (user_id, idempotency_key) DO NOTHING
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
      WHERE user_id = ${input.userId}
        AND idempotency_key = ${input.idempotencyKey}
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
      // String argument on INCRBY keeps JS Number out of the
      // server-side path; Redis does the increment in native
      // 64-bit integer arithmetic. We deliberately discard the
      // INCRBY reply because ioredis parses it back to a JS Number
      // on the client side, which loses precision past 2^53. Re-
      // reading the counter via GET (Redis returns the bulk-string
      // representation) and parsing with BigInt preserves the full
      // 64-bit value. See module header for the BigInt-safety note.
      await Promise.all([
        addEarning(redis, isoWeek, earning.user_id, BigInt(earning.amount)),
        redis.incrby(poolKey(isoWeek), contributionToPool.toString()),
      ])
      // After ZINCRBY, fetch the user's current rank so the
      // frontend can show instant rank-change feedback after
      // POST /earnings (no need to immediately re-poll
      // /leaderboard/me). Pool counter is read here as a string
      // for the precision reason above.
      const [poolStr, rank] = await Promise.all([
        redis.get(poolKey(isoWeek)),
        getRank(redis, isoWeek, earning.user_id),
      ])
      poolAmount = poolStr === null ? 0n : BigInt(poolStr)
      newRank = rank
    } catch (err) {
      // Log but do not propagate — PG is the source of truth and
      // rebuild-redis can re-derive Redis state from PG.
      logger.error(
        { err, userId: earning.user_id, isoWeek, earningId: earning.id },
        'redis write failed (PG already committed)',
      )
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
