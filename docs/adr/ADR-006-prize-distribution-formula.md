# ADR-006: Prize distribution formula and edge-case interpretation

- **Status:** Accepted
- **Date:** 2026-04-27
- **Deciders:** Mehmet Akif Arslan
- **Tags:** #backend #money-safety #product-interpretation

## Context

The brief specifies the prize-distribution formula:

> The weekly leaderboard system is built around automatically
> collecting 2% of the total money players earn during the week
> into a prize pool. At the end of the week, this pool is
> distributed to the top 100 players according to ranking: 1st
> place gets 20%, 2nd gets 15%, 3rd gets 10%; the remaining 55%
> is distributed among players ranked 4th through 100th, **based
> on their rank**.

Three things need interpretation:

1. **"Based on their rank"** for ranks 4..100 — what shape?
2. **Fewer than 100 players** in a given week — what happens?
3. **BigInt rounding residual** — where does it go?

The brief does not specify any of these, and the case is private
so I cannot ask for clarification before delivery. I made
assumptions, documented them here, and built tests against them
so they can be challenged with full transparency.

## Decision

### 1. Ranks 4..100 → linear weighting

Weight of rank R is `(N + 1 - R)` where `N = min(totalWinners, 100)`.
The 55% bucket is divided proportional to weight:

```
share(R) = remainingPool55 * (N + 1 - R) / sum(weights for 4..N)
```

For a full top-100 week, the weight series is `97, 96, …, 1` and
the sum is `4753`. Rank 4 gets the largest share within the 55%
bucket; rank 100 gets the smallest. Smooth, monotonically
decreasing.

### 2. Fewer than 100 winners

The same formula applies with `N = totalWinners`. Top 3 keep
their fixed `20% / 15% / 10%`. Ranks 4..N share 55% with the
weighting **scaled to the actual range** (the denominator is
recomputed from the actual ranks present, not from the
hypothetical 1..97 series). This guarantees the entire 55% bucket
is distributed when fewer than 100 winners exist — no money
"left on the table".

If there are zero winners, `distributePool` returns an empty
array and the cron marks the week as `distributed` with a zero
pool, idempotently.

If there are 1 or 2 winners, the missing top-3 percentages roll
into rank 1's payout via the residual rule below.

### 3. Rounding residual → rank 1

All arithmetic is BigInt floor division. Sum of all shares may
fall short of the input pool by up to `N` (each rank potentially
short by ≤ 1 unit). The residual is added to rank 1's payout so
the final invariant `sum(payouts) == totalPool` holds exactly.

This is the "winner takes the rounding" convention. Rationale:

- Spreading the residual one-at-a-time is fairer at scale but
  costs O(residual) operations in the hot path.
- Rank 1 is already the largest share — adding a few units of
  rounding noise to the top of the table is invisible to players.
- It keeps the maths simple and easy to audit (`/replay-week`
  reproduces it exactly).

## Consequences

### Positive

- The formula is unambiguous, deterministic, and auditable.
- Sum of payouts always equals input pool — money conservation
  is provable from the function signature.
- Edge cases (0, 1, 2, 50, 100, 250 winners) all have defined
  behaviour with tests.
- `/replay-week` can re-derive any past week's intended payout
  exactly and diff against `prize_payouts`.

### Negative

- "Linear weighting" is one defensible interpretation of
  "based on their rank". A reviewer might prefer:
  - **Equal split** (55% / 97 each)
  - **Tiered** (e.g. 4-10 share X%, 11-50 share Y%, 51-100 share Z%)
  - **Geometric** (exponential decay)
  These would change every payout below rank 3. The choice is
  documented here so any disagreement is a code change, not a
  hidden assumption.
- Rank 1 receiving the rounding residual gives them a slight
  bonus (typically <100 units against a 6-figure share). Not
  meaningful at realistic pool sizes; documented for honesty.

### Neutral

- The CHECK constraint `prize_payouts.amount > 0` means very
  small pools could produce zero-amount entries for low-weight
  ranks. The implementation filters those out before insert; the
  un-allocated weight gets absorbed into rank 1 via the residual
  rule. With realistic pools (millions of currency units) this
  never happens.

## Alternatives Considered

### Alternative A: Equal split for ranks 4..100

`55% / 97` per rank. Rejected because the brief explicitly says
"based on their rank" — equal split ignores rank entirely.

### Alternative B: Tier-based bands (4-10, 11-50, 51-100)

Adds product complexity for marginal fairness gain. The brief
does not hint at tiers, and tier boundaries become arbitrary
choices that are harder to defend than a single linear curve.

### Alternative C: Geometric decay

`share(R) = base * decay^R`. Smoother for whales (rank 4 gets
much more than rank 100 even than linear). Could be defensible
but introduces a free parameter (decay factor) that the brief
gives no guidance on. Linear is the parameter-free choice.

### Alternative D: Top-3 percentages scale when N < 3

E.g. with 2 winners, rank 1 gets 20/(20+15) = 57.1% of pool,
rank 2 gets 15/(20+15) = 42.9%. Rejected: the fixed 20/15/10
percentages are stated absolutely in the brief; scaling them
violates that. Residual-to-rank-1 keeps the brief's stated
percentages intact.

### Alternative E: Spread residual one-at-a-time

For a ≤ N residual, give +1 to rank 1, +1 to rank 2, … in
ascending rank order. Fairer than dumping it all on rank 1.
Rejected on simplicity grounds — at realistic pool sizes the
residual is invisible noise. If a future product decision
demands fairness here, the change is local to `distributePool`.

## AI involvement

I asked Claude to enumerate the standard "based on their rank"
interpretations seen in idle-game economies. It surfaced linear,
tiered, and geometric, and noted that linear is the most common
default. Claude also pointed out the residual problem before I
hit it in tests — useful early.

The decision to put residual on rank 1 (as opposed to spreading
it) is mine, on simplicity grounds. Documenting the alternatives
so a reviewer can challenge them is also my call — Claude's
default would have shipped without an ADR.

## References

- `src/lib/prize-math.ts` — implementation.
- `src/lib/prize-math.test.ts` — 21 tests covering happy path,
  edge cases (1, 2, 3, 5, 50, 100, 250 winners), pool conservation
  across awkward sizes, monotonic decrease, zero-amount filtering.
- ADR-003 — distribution safety layers; rank UNIQUE constraint
  enforces deterministic tie-breaking, which this formula
  depends on.
- CLAUDE.md invariants 1 (BigInt money) and 7 (deterministic
  tie-breaking).
- `docs/case/case-en.html` — the brief's exact wording.
