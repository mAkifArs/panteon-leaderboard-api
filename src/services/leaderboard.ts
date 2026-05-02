import type { Redis } from 'ioredis'
import { bigIntToRedisScore, redisScoreToBigInt } from './redis-bigint.ts'

/**
 * Live leaderboard service — wraps a Redis sorted set per ISO week.
 *
 * Postgres is the source of truth for `earning_events` (ADR-001);
 * Redis here is the derived hot view. Total scores are kept in
 * `lb:week:<isoWeek>` as a `ZSET` keyed by user id.
 *
 * **BigInt vs. float reconciliation (CLAUDE.md invariant 1).** Money
 * is BigInt in PG. Redis sorted-set scores are IEEE-754 doubles —
 * there is no integer-score variant. We accept this trade-off
 * because (a) PG is always the authoritative store and (b) the cron
 * re-materialises the final ranking from PG before any payout, so
 * float drift in the live view can never affect money. In-week UI
 * reads are tolerant of sub-coin drift; cron reads are not, and they
 * never touch Redis. See ADR-001 for the source-of-truth contract
 * and `/rebuild-redis` for the recovery path.
 *
 * **Tie-breaking.** Redis sorts by score DESC, then by lexicographic
 * member key on ties. The project's deterministic tie-break rule is
 * `score DESC, first_earning_at ASC, first_earning_id ASC` (CLAUDE.md
 * invariant 7). These two orderings can disagree on ties, so the
 * canonical ranking is computed in Postgres for authoritative views
 * (cron, replay). The Redis view is good enough for in-week reads;
 * payouts always materialise from PG via the ORDER BY in
 * `runWeeklyDistribution`.
 */

export const LEADERBOARD_KEY_PREFIX = 'lb:week:'

export function leaderboardKey(isoWeek: string): string {
  return `${LEADERBOARD_KEY_PREFIX}${isoWeek}`
}

export interface LeaderboardEntry {
  rank: number
  userId: string
  score: bigint
}

export interface OwnRankCluster {
  rank: number
  totalPlayers: number
  cluster: LeaderboardEntry[]
}

/**
 * Increment a user's running total for the week. Creates the
 * member if it does not exist. Score is stored as a Redis double:
 * see the BigInt-vs-float note in the module header — PG remains
 * the authoritative score, this is the live view only.
 */
export async function addEarning(
  redis: Redis,
  isoWeek: string,
  userId: string,
  amount: bigint,
): Promise<void> {
  // bigIntToRedisScore keeps the JS Number cast out of the path —
  // see src/services/redis-bigint.ts module header for why this
  // matters past 2^53. Redis still stores the score as a double
  // (sortedset spec); the helper just removes the JS-side
  // precision cliff before serialisation.
  await redis.zincrby(leaderboardKey(isoWeek), bigIntToRedisScore(amount), userId)
}

/**
 * Total score for a user this week, or null if they have no
 * earnings for the week (not in the sorted set at all).
 */
export async function getScore(
  redis: Redis,
  isoWeek: string,
  userId: string,
): Promise<bigint | null> {
  const raw = await redis.zscore(leaderboardKey(isoWeek), userId)
  return raw === null ? null : redisScoreToBigInt(raw)
}

/**
 * Rank of a user this week (1-indexed, highest score = rank 1),
 * or null if they have no earnings for the week.
 */
export async function getRank(
  redis: Redis,
  isoWeek: string,
  userId: string,
): Promise<number | null> {
  const r = await redis.zrevrank(leaderboardKey(isoWeek), userId)
  return r === null ? null : r + 1
}

/**
 * Total number of players ranked this week.
 */
export async function getTotalPlayers(redis: Redis, isoWeek: string): Promise<number> {
  return await redis.zcard(leaderboardKey(isoWeek))
}

/**
 * Top N players (default 100) by score, descending.
 */
export async function getTop(
  redis: Redis,
  isoWeek: string,
  limit = 100,
): Promise<LeaderboardEntry[]> {
  const raw = await redis.zrevrange(leaderboardKey(isoWeek), 0, limit - 1, 'WITHSCORES')
  return decodeRangeWithScores(raw, 1)
}

/**
 * The own-rank cluster: 3 players above + the user + 2 below.
 * Always 6 entries unless `totalPlayers < 6`, in which case it
 * returns however many entries exist.
 *
 * Edge cases (always 6 entries when possible, window slides):
 *   - rank 1  → ranks 1..6 (self + 5 below)
 *   - rank 2  → ranks 1..6 (1 above + self + 4 below)
 *   - rank 3  → ranks 1..6 (2 above + self + 3 below)
 *   - rank 4  → ranks 1..6 (3 above + self + 2 below)
 *   - rank N (mid) → ranks N-3..N+2
 *   - rank N where N+2 > total → window shifts up so end = total
 *
 * Returns null if the user has no earnings this week.
 */
export async function getOwnRankCluster(
  redis: Redis,
  isoWeek: string,
  userId: string,
): Promise<OwnRankCluster | null> {
  const key = leaderboardKey(isoWeek)
  const [rankZeroIndexed, totalPlayers] = await Promise.all([
    redis.zrevrank(key, userId),
    redis.zcard(key),
  ])
  if (rankZeroIndexed === null) return null

  const myRank = rankZeroIndexed + 1
  const desiredAbove = 3
  const desiredBelow = 2
  const clusterSize = desiredAbove + 1 + desiredBelow // 6

  let start = Math.max(1, myRank - desiredAbove)
  let end = start + clusterSize - 1
  if (end > totalPlayers) {
    end = totalPlayers
    start = Math.max(1, end - clusterSize + 1)
  }

  const raw = await redis.zrevrange(key, start - 1, end - 1, 'WITHSCORES')
  return {
    rank: myRank,
    totalPlayers,
    cluster: decodeRangeWithScores(raw, start),
  }
}

/**
 * Wipe the leaderboard for a week. Used by `/rebuild-redis`
 * before reseeding from Postgres, and by tests for cleanup.
 */
export async function clearWeek(redis: Redis, isoWeek: string): Promise<void> {
  await redis.del(leaderboardKey(isoWeek))
}

function decodeRangeWithScores(raw: string[], startingRank: number): LeaderboardEntry[] {
  const entries: LeaderboardEntry[] = []
  for (let i = 0; i < raw.length; i += 2) {
    const userId = raw[i]
    const scoreStr = raw[i + 1]
    if (userId === undefined || scoreStr === undefined) continue
    entries.push({
      rank: startingRank + i / 2,
      userId,
      score: redisScoreToBigInt(scoreStr),
    })
  }
  return entries
}
