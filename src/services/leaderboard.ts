import type { Redis } from 'ioredis'

/**
 * Live leaderboard service — wraps a Redis sorted set per ISO week.
 *
 * Postgres is the source of truth for `earning_events`; Redis here
 * is the derived hot view. Total scores are kept in
 * `lb:week:<isoWeek>` as a `ZSET` keyed by user id.
 *
 * Tie-breaking: Redis sorts by score DESC. When two users tie on
 * score, ZREVRANGE returns them in lexicographic order of the
 * member key. To match the project's deterministic tie-breaking
 * rule (earliest first earning wins, see CLAUDE.md invariant 7),
 * the canonical leaderboard ranking is computed in Postgres for
 * authoritative views (cron, replay). The Redis view is a fast
 * approximation good enough for in-week reads; the cron always
 * materialises the final ranking from PG before payouts.
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
 * member if it does not exist. Score is stored as a Redis double
 * but our amounts fit safely (in-game coins, well under 2^53 per
 * week per user even for whales).
 */
export async function addEarning(
  redis: Redis,
  isoWeek: string,
  userId: string,
  amount: bigint,
): Promise<void> {
  await redis.zincrby(leaderboardKey(isoWeek), Number(amount), userId)
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
  return raw === null ? null : BigInt(raw)
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
      score: BigInt(scoreStr),
    })
  }
  return entries
}
