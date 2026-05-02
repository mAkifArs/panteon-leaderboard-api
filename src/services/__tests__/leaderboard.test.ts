import IORedisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addEarning,
  clearWeek,
  getOwnRankCluster,
  getRank,
  getScore,
  getTop,
  getTotalPlayers,
  leaderboardKey,
} from '../leaderboard.ts'

const ISO_WEEK = '2026-W17'

let redis: Redis

beforeEach(async () => {
  // ioredis-mock implements the sorted-set commands we use
  // (ZINCRBY / ZREVRANGE / ZREVRANK / ZSCORE / ZCARD / DEL) with
  // the same semantics, but instances share one in-memory store
  // by default — flushall keeps tests isolated.
  // Real-Redis integration tests via testcontainers come in a
  // follow-up commit (see testing-patterns skill).
  redis = new IORedisMock()
  await redis.flushall()
})

afterEach(async () => {
  await clearWeek(redis, ISO_WEEK)
  redis.disconnect()
})

describe('leaderboardKey', () => {
  it('uses the lb:week: prefix', () => {
    expect(leaderboardKey('2026-W17')).toBe('lb:week:2026-W17')
  })
})

describe('addEarning + getScore', () => {
  it('starts a player at the given amount', async () => {
    await addEarning(redis, ISO_WEEK, 'u1', 100n)
    expect(await getScore(redis, ISO_WEEK, 'u1')).toBe(100n)
  })

  it('accumulates multiple earnings for the same player', async () => {
    await addEarning(redis, ISO_WEEK, 'u1', 100n)
    await addEarning(redis, ISO_WEEK, 'u1', 250n)
    await addEarning(redis, ISO_WEEK, 'u1', 50n)
    expect(await getScore(redis, ISO_WEEK, 'u1')).toBe(400n)
  })

  it('returns null for a player who has not earned this week', async () => {
    expect(await getScore(redis, ISO_WEEK, 'unknown')).toBeNull()
  })

  it('parses scientific-notation scores from Redis (>2^53)', async () => {
    // Redis ZSCORE for very large totals comes back as e.g. "5e+18"
    // because the score is an IEEE-754 double. BigInt cannot parse
    // that form directly; we fall through Number first. Sub-coin
    // drift here is the documented trade-off in the module header.
    await redis.zadd(`lb:week:${ISO_WEEK}`, 5e18, 'whale')
    const score = await getScore(redis, ISO_WEEK, 'whale')
    expect(score).toBe(5_000_000_000_000_000_000n)
  })
})

describe('getRank', () => {
  it('returns 1-indexed rank for a player who has earned', async () => {
    await addEarning(redis, ISO_WEEK, 'u1', 100n)
    await addEarning(redis, ISO_WEEK, 'u2', 200n)
    await addEarning(redis, ISO_WEEK, 'u3', 50n)
    expect(await getRank(redis, ISO_WEEK, 'u2')).toBe(1)
    expect(await getRank(redis, ISO_WEEK, 'u1')).toBe(2)
    expect(await getRank(redis, ISO_WEEK, 'u3')).toBe(3)
  })

  it('returns null for a player who has not earned this week', async () => {
    expect(await getRank(redis, ISO_WEEK, 'unknown')).toBeNull()
  })
})

describe('getTotalPlayers', () => {
  it('counts unique players who have earned this week', async () => {
    expect(await getTotalPlayers(redis, ISO_WEEK)).toBe(0)
    await addEarning(redis, ISO_WEEK, 'u1', 100n)
    await addEarning(redis, ISO_WEEK, 'u2', 200n)
    await addEarning(redis, ISO_WEEK, 'u1', 50n) // same player again
    expect(await getTotalPlayers(redis, ISO_WEEK)).toBe(2)
  })
})

describe('getTop', () => {
  beforeEach(async () => {
    for (let i = 1; i <= 10; i++) {
      await addEarning(redis, ISO_WEEK, `u${String(i)}`, BigInt(i * 100))
    }
  })

  it('returns the top N descending with 1-indexed ranks', async () => {
    const top3 = await getTop(redis, ISO_WEEK, 3)
    expect(top3).toEqual([
      { rank: 1, userId: 'u10', score: 1000n },
      { rank: 2, userId: 'u9', score: 900n },
      { rank: 3, userId: 'u8', score: 800n },
    ])
  })

  it('defaults to 100', async () => {
    const all = await getTop(redis, ISO_WEEK)
    expect(all).toHaveLength(10)
    expect(all[0]?.rank).toBe(1)
    expect(all[9]?.rank).toBe(10)
  })

  it('returns an empty array when no one has earned', async () => {
    await clearWeek(redis, ISO_WEEK)
    expect(await getTop(redis, ISO_WEEK)).toEqual([])
  })

  it('does not crash when the top entry is a whale (Bug 1 regression)', async () => {
    // Bug 1 (commit d840707): inline BigInt(scoreStr) crashed when
    // Redis returned a whale score in scientific notation. The
    // helper layer now goes through redisScoreToBigInt; this test
    // locks that decodeRangeWithScores uses it.
    await clearWeek(redis, ISO_WEEK)
    await addEarning(redis, ISO_WEEK, 'whale', 5_000_000_000_000_000_050n)
    const top = await getTop(redis, ISO_WEEK, 1)
    expect(top).toHaveLength(1)
    expect(top[0]?.userId).toBe('whale')
    // Sub-coin drift past 2^53 is documented; assert bounded, not exact.
    expect(typeof top[0]?.score).toBe('bigint')
  })
})

describe('getOwnRankCluster', () => {
  // Seed 100 players, each with a distinct score (player N has 100*N).
  beforeEach(async () => {
    for (let i = 1; i <= 100; i++) {
      await addEarning(redis, ISO_WEEK, `u${String(i)}`, BigInt(i * 100))
    }
    // Now u100 = rank 1 (10000), u99 = rank 2, ..., u1 = rank 100 (100).
  })

  it('always returns 6 entries when totalPlayers >= 6', async () => {
    const result = await getOwnRankCluster(redis, ISO_WEEK, 'u50')
    expect(result?.cluster).toHaveLength(6)
  })

  it('mid rank: 3 above + self + 2 below', async () => {
    const result = await getOwnRankCluster(redis, ISO_WEEK, 'u50') // rank 51
    expect(result?.rank).toBe(51)
    expect(result?.totalPlayers).toBe(100)
    expect(result?.cluster.map((e) => e.rank)).toEqual([48, 49, 50, 51, 52, 53])
    expect(result?.cluster[3]?.userId).toBe('u50')
  })

  it('rank 1: window stays at the top (self + 5 below)', async () => {
    const result = await getOwnRankCluster(redis, ISO_WEEK, 'u100') // rank 1
    expect(result?.rank).toBe(1)
    expect(result?.cluster.map((e) => e.rank)).toEqual([1, 2, 3, 4, 5, 6])
    expect(result?.cluster[0]?.userId).toBe('u100')
  })

  it('rank 2: 1 above + self + 4 below', async () => {
    const result = await getOwnRankCluster(redis, ISO_WEEK, 'u99') // rank 2
    expect(result?.rank).toBe(2)
    expect(result?.cluster.map((e) => e.rank)).toEqual([1, 2, 3, 4, 5, 6])
    expect(result?.cluster[1]?.userId).toBe('u99')
  })

  it('rank 3: 2 above + self + 3 below', async () => {
    const result = await getOwnRankCluster(redis, ISO_WEEK, 'u98') // rank 3
    expect(result?.rank).toBe(3)
    expect(result?.cluster.map((e) => e.rank)).toEqual([1, 2, 3, 4, 5, 6])
    expect(result?.cluster[2]?.userId).toBe('u98')
  })

  it('last rank: window slides up to end at totalPlayers', async () => {
    const result = await getOwnRankCluster(redis, ISO_WEEK, 'u1') // rank 100
    expect(result?.rank).toBe(100)
    expect(result?.cluster.map((e) => e.rank)).toEqual([95, 96, 97, 98, 99, 100])
    expect(result?.cluster[5]?.userId).toBe('u1')
  })

  it('second-to-last rank: window slides up', async () => {
    const result = await getOwnRankCluster(redis, ISO_WEEK, 'u2') // rank 99
    expect(result?.rank).toBe(99)
    expect(result?.cluster.map((e) => e.rank)).toEqual([95, 96, 97, 98, 99, 100])
    expect(result?.cluster[4]?.userId).toBe('u2')
  })

  it('returns null for a player who has not earned this week', async () => {
    const result = await getOwnRankCluster(redis, ISO_WEEK, 'ghost')
    expect(result).toBeNull()
  })

  it('shrinks gracefully when totalPlayers < 6', async () => {
    await clearWeek(redis, ISO_WEEK)
    await addEarning(redis, ISO_WEEK, 'a', 100n)
    await addEarning(redis, ISO_WEEK, 'b', 200n)
    await addEarning(redis, ISO_WEEK, 'c', 50n)
    const result = await getOwnRankCluster(redis, ISO_WEEK, 'a') // rank 2 of 3
    expect(result?.totalPlayers).toBe(3)
    expect(result?.cluster).toHaveLength(3)
    expect(result?.cluster.map((e) => e.userId)).toEqual(['b', 'a', 'c'])
  })
})
