/**
 * Prize distribution math.
 *
 * Brief: each week, 2% of total earnings forms a pool. The pool is
 * distributed to the top 100 ranked players:
 *   - rank  1 → 20% of pool
 *   - rank  2 → 15% of pool
 *   - rank  3 → 10% of pool
 *   - ranks 4..100 → share the remaining 55%, "based on their rank"
 *
 * "Based on their rank" is interpreted as **linear weighting**: the
 * weight of rank R (4 ≤ R ≤ N) is `N + 1 - R`, so rank 4 gets the
 * largest share within the 55% bucket and rank N the smallest. This
 * matches typical idle-game leaderboard payout curves and is
 * documented in ADR-006.
 *
 * **Fewer than 100 winners**: the same shape applies. Top 3 keep
 * fixed 20/15/10. Ranks 4..N share the 55% with weights scaled to
 * fit (so a small week still distributes the entire 55% bucket
 * among the actual ranks 4..N). If N < 3, the missing ranks'
 * percentages roll up into rank 1's payout via the residual rule.
 *
 * **Rounding**: all arithmetic is BigInt floor division. The
 * residual (totalPool − sum of allocated amounts) is added to
 * rank 1's payout. This guarantees that the sum of payouts equals
 * the input pool exactly, no money lost or created.
 *
 * **Zero amounts are filtered** because `prize_payouts.amount`
 * has a CHECK (amount > 0) constraint. With a realistic pool size
 * this never happens; the filter is a safety net for extreme cases.
 */

export interface Payout {
  rank: number
  amount: bigint
}

const MAX_WINNERS = 100

/**
 * Distribute a prize pool among the top `totalWinners` players.
 *
 * @param totalPool      Pool amount in the smallest currency unit (BigInt).
 * @param totalWinners   Actual number of ranked players this week. Capped at 100.
 * @returns              One `Payout` per rank that receives a nonzero amount,
 *                       in ascending rank order. Sum of `amount` equals
 *                       `totalPool` exactly when `totalWinners > 0`.
 */
export function distributePool(totalPool: bigint, totalWinners: number): Payout[] {
  if (totalWinners <= 0 || totalPool <= 0n) return []

  const N = Math.min(totalWinners, MAX_WINNERS)
  const payouts: Payout[] = []

  // Top 3 — fixed percentages.
  if (N >= 1) payouts.push({ rank: 1, amount: (totalPool * 20n) / 100n })
  if (N >= 2) payouts.push({ rank: 2, amount: (totalPool * 15n) / 100n })
  if (N >= 3) payouts.push({ rank: 3, amount: (totalPool * 10n) / 100n })

  // Ranks 4..N — share 55% of pool, weighted linearly.
  if (N >= 4) {
    const remainingPool = (totalPool * 55n) / 100n
    // weight(R) = N + 1 - R. Sum over R = 4..N is an arithmetic
    // series: (N - 3)(N - 2) / 2.
    const totalWeight = BigInt(((N - 3) * (N - 2)) / 2)
    for (let rank = 4; rank <= N; rank++) {
      const weight = BigInt(N + 1 - rank)
      const amount = (remainingPool * weight) / totalWeight
      payouts.push({ rank, amount })
    }
  }

  // Residual (rounding + missing top-3 slots) → rank 1.
  const totalAllocated = payouts.reduce((sum, p) => sum + p.amount, 0n)
  const residual = totalPool - totalAllocated
  if (residual > 0n) {
    payouts[0]!.amount += residual
  }

  // Strip any zero-amount entries to satisfy the CHECK constraint
  // on prize_payouts.amount (> 0). With a realistic pool this is a
  // no-op; defensive against pathological inputs.
  return payouts.filter((p) => p.amount > 0n)
}

/**
 * Verify a payout list sums to the input pool. Used by tests and
 * the audit/replay path. Returns the difference if any (positive
 * means under-allocated, negative means over-allocated).
 */
export function payoutResidual(totalPool: bigint, payouts: Payout[]): bigint {
  const sum = payouts.reduce((acc, p) => acc + p.amount, 0n)
  return totalPool - sum
}
