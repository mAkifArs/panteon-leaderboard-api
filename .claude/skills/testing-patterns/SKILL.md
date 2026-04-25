---
name: testing-patterns
description: Backend testing conventions for the leaderboard API. Loads when editing test files or src/ files that should be tested. Defines layers, what we always test, and the no-mock rule for databases.
---

# Testing Patterns — Leaderboard API

This skill teaches the conventions for **this specific
project**. The base model knows Vitest, Supertest, and
testcontainers; this file documents what we do here.

## Layers

| Layer       | Tool                  | What it covers                                         |
|-------------|-----------------------|--------------------------------------------------------|
| Unit        | Vitest                | Pure functions (BigInt math, rank window, formatters)  |
| Integration | Vitest + testcontainers | Routes + real PG + real Redis + real Mongo            |
| Load        | k6 (`/benchmark`)     | p50/p99 under N concurrent users                       |
| Replay      | `/replay-week`        | Determinism check — recompute past distributions       |

## The no-mock rule

**Integration tests hit real databases via testcontainers, never
mocks.**

Rationale: a mocked DB test passing while the real schema or
query is broken is worse than no test. Testcontainers spins up
a per-test PG / Redis / Mongo container; CI cost is acceptable
and confidence is real.

This is non-negotiable. If a test is "too slow" with real
containers, the answer is to scope the test, not to mock the
database.

## What we always test

These behaviours have a test that fails if they regress:

- **BigInt money math.** `2% of total` rounds toward zero,
  always — never `Math.round`. Test with edge values
  (1n, 50n, 99n, 100n, very large).
- **Append-only `earning_events`.** UPDATE on the table
  raises. DELETE raises. Only INSERT is allowed.
- **Idempotency keys on POST /earnings.** Same key twice =
  same response, no duplicate row.
- **Prize distribution.** Single PG transaction, rolls back
  cleanly on partial failure. `/replay-week` reproduces the
  result deterministically.
- **Redis SETNX cron lock.** Two simultaneous distribution
  attempts → only one runs. Test with two parallel calls.
- **Sorted set ranking.** `ZREVRANGE` returns descending. Top
  100 query at every interesting boundary (1, 100, 101, 2M).
- **Own-rank cluster math.** All five edge cases: rank 1,
  rank 2, mid, second-to-last, last. Always 6 entries.
- **Tie-breaking.** Equal scores → earliest first-earning
  timestamp wins. Test with manufactured ties.
- **Currency JSON serialization.** BigInt → string in the
  response, no `null`, no precision loss.

## What we deliberately don't test

- Trivial getters and pass-throughs.
- Implementation details of internal helpers — test what the
  route returns, not how it computed it.
- Coverage as a target. Coverage is a smell signal; behaviour
  in the "always test" list is the real bar.

## File layout

```
src/routes/earnings.ts
src/routes/earnings.test.ts             # unit (pure helpers)
src/routes/earnings.integration.test.ts # real DBs

src/lib/money.ts
src/lib/money.test.ts                   # unit
```

Naming: `*.test.ts` = unit, `*.integration.test.ts` =
testcontainer-backed.

## Test database lifecycle

- Each integration test starts on a fresh DB schema (migrate
  up at suite start, truncate between tests).
- No test depends on the order of other tests.
- Seed data is created in the `arrange` step of each test,
  never globally.

## Replay tests

- `/replay-week <isoWeek>` recomputes what the distribution
  *should* have been from `earning_events` and diffs against
  the actual `prize_payouts` table.
- A test wraps this for the most recent closed week and
  fails if any payout differs from the deterministic recompute.
- This is the ultimate audit — if it passes, the engine is
  reproducible; if it fails, we have a real bug.

## Load tests

- Owned by `/benchmark`. The skill runs k6, captures p50/p99
  for the three hot endpoints (top-100, own-rank, POST
  /earnings), and refreshes the README table.
- Run before every delivery and after any performance-
  sensitive change.

## CI gates

- Unit + integration tests must pass.
- `/check-case` must produce zero unchecked items on `main`.
- Migration `up` and `down` both succeed in CI.
