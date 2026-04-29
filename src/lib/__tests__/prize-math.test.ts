import { describe, expect, it } from 'vitest'
import { distributePool, payoutResidual } from '../prize-math.ts'

describe('distributePool — empty cases', () => {
  it('returns [] when totalWinners is 0', () => {
    expect(distributePool(1_000_000n, 0)).toEqual([])
  })

  it('returns [] when totalPool is 0', () => {
    expect(distributePool(0n, 50)).toEqual([])
  })

  it('returns [] when totalPool is negative (defensive)', () => {
    expect(distributePool(-100n, 10)).toEqual([])
  })
})

describe('distributePool — top 3 fixed percentages', () => {
  it('rank 1 gets 20% (plus residual)', () => {
    const pool = 1_000_000n
    const payouts = distributePool(pool, 100)
    // rank 1 = 20% + small residual from BigInt rounding in 4..100
    const rank1 = payouts.find((p) => p.rank === 1)!
    expect(rank1.amount).toBeGreaterThanOrEqual((pool * 20n) / 100n)
  })

  it('rank 2 gets exactly 15%', () => {
    const pool = 1_000_000n
    const payouts = distributePool(pool, 100)
    expect(payouts.find((p) => p.rank === 2)!.amount).toBe((pool * 15n) / 100n)
  })

  it('rank 3 gets exactly 10%', () => {
    const pool = 1_000_000n
    const payouts = distributePool(pool, 100)
    expect(payouts.find((p) => p.rank === 3)!.amount).toBe((pool * 10n) / 100n)
  })
})

describe('distributePool — exact pool conservation (no money lost)', () => {
  it('sum of payouts equals totalPool for 100 winners', () => {
    const pool = 1_000_000n
    const payouts = distributePool(pool, 100)
    expect(payoutResidual(pool, payouts)).toBe(0n)
  })

  it('sum of payouts equals totalPool for 50 winners', () => {
    const pool = 999_999n
    const payouts = distributePool(pool, 50)
    expect(payoutResidual(pool, payouts)).toBe(0n)
  })

  it('sum equals totalPool for awkward pool sizes (BigInt rounding)', () => {
    for (const pool of [7n, 13n, 100n, 101n, 12_345_678n, 999_999_999n]) {
      const payouts = distributePool(pool, 100)
      expect(payoutResidual(pool, payouts)).toBe(0n)
    }
  })

  it('sum equals totalPool for awkward winner counts', () => {
    const pool = 1_000_000n
    for (const winners of [1, 2, 3, 4, 5, 7, 33, 99]) {
      const payouts = distributePool(pool, winners)
      expect(payoutResidual(pool, payouts)).toBe(0n)
    }
  })
})

describe('distributePool — ranks 4..N share 55% by linear weight', () => {
  it('rank 4 receives the largest share in the 4..N bucket', () => {
    const payouts = distributePool(1_000_000n, 100)
    const rank4 = payouts.find((p) => p.rank === 4)!.amount
    const rank100 = payouts.find((p) => p.rank === 100)!.amount
    expect(rank4).toBeGreaterThan(rank100)
  })

  it('share decreases monotonically as rank increases (4..N)', () => {
    const payouts = distributePool(1_000_000n, 100)
    const tail = payouts.filter((p) => p.rank >= 4 && p.rank <= 100)
    for (let i = 1; i < tail.length; i++) {
      expect(tail[i]!.amount).toBeLessThanOrEqual(tail[i - 1]!.amount)
    }
  })

  it('rank 4..100 bucket sums to ~55% of pool (within rounding)', () => {
    const pool = 10_000_000n
    const payouts = distributePool(pool, 100)
    const tailSum = payouts
      .filter((p) => p.rank >= 4 && p.rank <= 100)
      .reduce((s, p) => s + p.amount, 0n)
    // Allow up to 99 units of under-allocation (one per rank 4..100,
    // each potentially short by up to 1 due to floor division).
    const expected = (pool * 55n) / 100n
    expect(tailSum).toBeLessThanOrEqual(expected)
    expect(expected - tailSum).toBeLessThanOrEqual(99n)
  })
})

describe('distributePool — fewer than 100 winners', () => {
  it('1 winner: rank 1 gets the entire pool', () => {
    const pool = 1_000_000n
    const payouts = distributePool(pool, 1)
    expect(payouts).toEqual([{ rank: 1, amount: pool }])
  })

  it('2 winners: rank 1 = 20% + residual (65%), rank 2 = 15%', () => {
    const pool = 1_000_000n
    const payouts = distributePool(pool, 2)
    expect(payouts).toHaveLength(2)
    expect(payouts[1]!.amount).toBe(150_000n) // 15%
    expect(payouts[0]!.amount).toBe(pool - 150_000n) // 20% + residual
  })

  it('3 winners: top 3 percentages, residual (55%) → rank 1', () => {
    const pool = 1_000_000n
    const payouts = distributePool(pool, 3)
    expect(payouts).toHaveLength(3)
    expect(payouts[2]!.amount).toBe(100_000n) // 10%
    expect(payouts[1]!.amount).toBe(150_000n) // 15%
    expect(payouts[0]!.amount).toBe(750_000n) // 20% + 55% residual
  })

  it('5 winners: ranks 4..5 share 55% by weight (2:1)', () => {
    const pool = 100_000n
    const payouts = distributePool(pool, 5)
    expect(payouts).toHaveLength(5)
    // weight(4) = 5+1-4 = 2, weight(5) = 5+1-5 = 1, total = 3
    // rank 4 = 55_000 * 2 / 3 = 36_666; rank 5 = 55_000 * 1 / 3 = 18_333
    // residual stays in rank 1
    expect(payouts[3]!.amount).toBe(36_666n)
    expect(payouts[4]!.amount).toBe(18_333n)
    expect(payoutResidual(pool, payouts)).toBe(0n)
  })

  it('caps at 100 even if more winners are passed', () => {
    const payouts = distributePool(1_000_000n, 250)
    expect(payouts.every((p) => p.rank >= 1 && p.rank <= 100)).toBe(true)
    expect(payouts).toHaveLength(100)
  })
})

describe('distributePool — every payout is positive (CHECK constraint safety)', () => {
  it('no zero amounts for realistic pool sizes', () => {
    for (const pool of [1_000n, 10_000n, 100_000n, 1_000_000n]) {
      const payouts = distributePool(pool, 100)
      expect(payouts.every((p) => p.amount > 0n)).toBe(true)
    }
  })

  it('filters zero amounts at extreme small-pool edge', () => {
    // Pool so small that rank 100 (weight 1) would round to 0.
    // Filter must drop it; sum of remaining payouts still equals pool.
    const pool = 100n
    const payouts = distributePool(pool, 100)
    expect(payouts.every((p) => p.amount > 0n)).toBe(true)
    expect(payoutResidual(pool, payouts)).toBe(0n)
  })
})

describe('distributePool — payouts are returned in ascending rank order', () => {
  it('rank 1 first, rank N last', () => {
    const payouts = distributePool(1_000_000n, 100)
    for (let i = 1; i < payouts.length; i++) {
      expect(payouts[i]!.rank).toBeGreaterThan(payouts[i - 1]!.rank)
    }
  })
})
