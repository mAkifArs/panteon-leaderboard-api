import type { Db } from 'mongodb'
import type { Redis } from 'ioredis'
import pino from 'pino'
import { playerProfiles, type PlayerProfileDoc } from '../db/mongo-collections.ts'
import {
  getOwnRankCluster,
  getTop,
  getTotalPlayers,
  leaderboardKey,
  type LeaderboardEntry,
} from './leaderboard.ts'
import { redisScoreToBigInt } from './redis-bigint.ts'

/**
 * Read-side composition: Redis sorted-set entries are fast (rank
 * + score) but lack human-readable identity. This module joins
 * them with `player_profiles` from MongoDB so the UI can render
 * names, country, and any future profile fields without going
 * back to the API.
 *
 * See ADR-007 for why profile data lives in Mongo. The user_id
 * stored in Redis matches `player_profiles._id` directly — no
 * translation step required.
 *
 * If a profile is missing in Mongo (signup race, deleted
 * account, upstream out of sync), we render a deterministic
 * fallback so the leaderboard still loads.
 */

export interface ViewEntry extends LeaderboardEntry {
  username: string
  country?: string
}

export interface OwnRankView {
  rank: number
  totalPlayers: number
  cluster: ViewEntry[]
}

const log = pino({ name: 'leaderboard-view' })

function fallbackUsername(userId: string): string {
  return `Player #${userId.slice(0, 8)}`
}

async function enrichWithProfiles(mongo: Db, entries: LeaderboardEntry[]): Promise<ViewEntry[]> {
  if (entries.length === 0) return []
  const ids = entries.map((e) => e.userId)

  // Mongo failure must not take down the leaderboard read path —
  // the rank/score data is already in hand from Redis. We log,
  // map every entry through the deterministic fallback username,
  // and let the response render. This mirrors the Redis-after-PG
  // tolerance on the write path: each store fails independently.
  let byId = new Map<string, PlayerProfileDoc>()
  try {
    const docs: PlayerProfileDoc[] = await playerProfiles(mongo)
      .find({ _id: { $in: ids } })
      .toArray()
    byId = new Map(docs.map((d) => [d._id, d]))
  } catch (err) {
    log.error({ err, count: ids.length }, 'mongo profile lookup failed; using fallback usernames')
  }

  return entries.map((e) => {
    const doc = byId.get(e.userId)
    const country = doc?.country
    return {
      ...e,
      username: doc?.username ?? fallbackUsername(e.userId),
      ...(country !== undefined && { country }),
    }
  })
}

export async function getTopView(
  redis: Redis,
  mongo: Db,
  isoWeek: string,
  limit = 100,
): Promise<ViewEntry[]> {
  const entries = await getTop(redis, isoWeek, limit)
  return enrichWithProfiles(mongo, entries)
}

/**
 * Sample N users that span the rank distribution — top, middle,
 * and lower tiers. Used by the frontend demo login panel so the
 * picker offers users with materially different leaderboard
 * positions (top-100, around-me view, near-bottom) without
 * hardcoding ids.
 *
 * For n=3 the picks are ranks { 1, totalPlayers/2, totalPlayers*0.9 }.
 * For other n, picks are evenly spaced across the distribution.
 *
 * Returns rank-ascending. May return **fewer than `n`** entries:
 *   - If totalPlayers < n, returns all available users.
 *   - For n=5 the boundary picks include rank 100; on a small
 *     leaderboard (totalPlayers < 100) that pick is filtered out
 *     and the resulting set may shrink to 3-4 entries.
 * Callers must read `count` from the response, not assume `n`.
 */
export async function getSampleUsers(
  redis: Redis,
  mongo: Db,
  isoWeek: string,
  n: number,
): Promise<ViewEntry[]> {
  const total = await getTotalPlayers(redis, isoWeek)
  if (total === 0) return []

  let targetRanks: number[]
  if (total <= n) {
    targetRanks = Array.from({ length: total }, (_, i) => i + 1)
  } else if (n === 3) {
    targetRanks = [1, Math.floor(total / 2), Math.max(2, Math.floor(total * 0.9))]
  } else if (n === 5) {
    // UX-meaningful boundary picks for the demo picker: top of
    // podium, last podium slot, last in top-100, mid pack, and
    // the very last player. Each one drives a distinct render path
    // in the frontend (top-3 podium, list-edge, list-end, outside-
    // top-100 cluster, sliding-window cluster at the bottom).
    targetRanks = [1, 3, 100, Math.max(101, Math.floor(total / 2)), total]
  } else {
    // Evenly spaced anchors, always including rank 1 and rank N.
    targetRanks = Array.from({ length: n }, (_, i) =>
      i === 0 ? 1 : i === n - 1 ? total : 1 + Math.floor((i * (total - 1)) / (n - 1)),
    )
  }
  const uniqueRanks = [...new Set(targetRanks)]
    .filter((r) => r >= 1 && r <= total)
    .sort((a, b) => a - b)

  // ZREVRANGE one entry at a time, batched into a single Redis
  // round-trip via pipeline. n is small (≤ ~10) so the pipeline
  // overhead is negligible — the win is the single RTT instead
  // of N sequential ones.
  const pipeline = redis.pipeline()
  for (const rank of uniqueRanks) {
    pipeline.zrevrange(leaderboardKey(isoWeek), rank - 1, rank - 1, 'WITHSCORES')
  }
  const results = await pipeline.exec()

  const entries: LeaderboardEntry[] = uniqueRanks.flatMap((rank, idx) => {
    const reply = results?.[idx]?.[1] as string[] | undefined
    if (!reply || reply.length < 2) return []
    // redisScoreToBigInt: scientific-notation safe (see redis-bigint.ts).
    // Inline BigInt(reply[1]!) crashed on whale scores — Bug 3.
    return [{ rank, userId: reply[0]!, score: redisScoreToBigInt(reply[1]!) }]
  })

  return enrichWithProfiles(mongo, entries)
}

/**
 * Own-rank cluster keyed by external user id. The user id matches
 * `player_profiles._id` directly. Returns null if the user has no
 * earnings this week.
 */
export async function getOwnRankView(
  redis: Redis,
  mongo: Db,
  isoWeek: string,
  userId: string,
): Promise<OwnRankView | null> {
  const cluster = await getOwnRankCluster(redis, isoWeek, userId)
  if (!cluster) return null
  const enriched = await enrichWithProfiles(mongo, cluster.cluster)
  return {
    rank: cluster.rank,
    totalPlayers: cluster.totalPlayers,
    cluster: enriched,
  }
}
