---
name: postgres-patterns
description: Project-specific PostgreSQL conventions for the leaderboard system. Loads when working on schemas, migrations, transactions, BigInt money arithmetic, idempotency, append-only tables, or anything involving the users/earning_events/prize_payouts/weekly_pools tables.
---

# Postgres Patterns — Leaderboard Project

Conventions specific to **this project**. Claude already knows
SQL; this file teaches the rules we commit to here.

## Role

Postgres is the **source of truth** for:

- User identity (`users`)
- Append-only earnings audit trail (`earning_events`)
- Prize pool accumulators per week (`weekly_pools`)
- Prize payouts, one row per winner per week (`prize_payouts`)
- Idempotency key registry (`idempotency_keys`)

If Redis or Mongo are wiped, the entire system must be
reconstructable from Postgres alone. Any design that breaks
this invariant is rejected.

## Money arithmetic

**All monetary amounts are stored as `BIGINT` in the smallest
currency unit** (the in-game "coin" has no fractions, so this
is literal coins). Never `NUMERIC`, never `DECIMAL`, never
`DOUBLE PRECISION`.

In TypeScript code, amounts are `bigint`:

```typescript
const amount: bigint = BigInt(payload.amount)
const poolCut: bigint = (amount * 2n) / 100n  // 2% pool
```

**Never `Math.round(x * 0.02)`.** Floating point arithmetic on
financial values causes cumulative drift. The pool-cut rule is
to multiply first by an integer, then integer-divide.

## Append-only tables

`earning_events` and `prize_payouts` are **append-only**.

- No `UPDATE`.
- No `DELETE`.
- New facts become new rows, timestamped.
- Mistakes are corrected with compensating rows (e.g. a reversal
  event with `amount: -500` referencing the original).

**Why:** the audit trail is the product. If you can overwrite
history, you've broken replay. `/replay-week` stops working.

## Schema conventions

- Primary keys:
  - `users.id` — UUID v4.
  - `earning_events.id` — `BIGSERIAL`. Ordered, append-only.
  - `prize_payouts.id` — `BIGSERIAL`.
  - `weekly_pools.week_bucket` — TEXT primary key, ISO week.
- Foreign keys are always explicit, never implicit. `ON DELETE
  RESTRICT` unless there's a documented reason otherwise.
- Timestamps: `TIMESTAMPTZ`, never `TIMESTAMP WITHOUT TIME
  ZONE`. Server operates in UTC.
- Week bucket column: always `TEXT NOT NULL` with format
  `YYYY-WXX`. Indexed alongside user_id.

## Required indexes

```sql
CREATE INDEX ON earning_events (user_id, week_bucket);
CREATE INDEX ON earning_events (week_bucket, occurred_at);
CREATE INDEX ON prize_payouts (week_bucket);
CREATE UNIQUE INDEX ON prize_payouts (week_bucket, user_id);
CREATE UNIQUE INDEX ON idempotency_keys (key);
```

The `UNIQUE (week_bucket, user_id)` on `prize_payouts` is the
**final line of defence against double-payouts**. Even if the
Redis lock fails and the DB transaction lock fails, Postgres
will reject the second insert with a unique violation.

## Transaction patterns

### Read-after-write consistency (earnings endpoint)

```typescript
await db.transaction(async (tx) => {
  // 1. Idempotency check
  const existing = await tx
    .insert(idempotencyKeys)
    .values({ key, requestHash, response: null })
    .onConflictDoNothing()
    .returning()
  if (existing.length === 0) {
    // Already processed; return cached response
    return await tx.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key))
  }

  // 2. Insert earning
  await tx.insert(earningEvents).values({ userId, amount, weekBucket })

  // 3. Increment pool counter
  await tx
    .insert(weeklyPools)
    .values({ weekBucket, totalPool: amount * 2n / 100n })
    .onConflictDoUpdate({
      target: weeklyPools.weekBucket,
      set: { totalPool: sql`${weeklyPools.totalPool} + ${amount * 2n / 100n}` },
    })

  // 4. Cache response for idempotency
  // ...
})
```

### Prize distribution (guard row pattern)

```typescript
await db.transaction(async (tx) => {
  // Atomic "claim this week for this run"
  const claim = await tx
    .update(weeklyPools)
    .set({ distributedAt: new Date(), distributionRunId: runId })
    .where(and(
      eq(weeklyPools.weekBucket, weekBucket),
      isNull(weeklyPools.distributedAt),
    ))
    .returning()

  if (claim.length === 0) {
    // Another instance already distributed. No-op.
    return
  }

  // Insert all 100 payouts — UNIQUE constraint rejects duplicates
  await tx.insert(prizePayouts).values(payouts)
})
```

This pattern needs **both the Redis SETNX lock AND the DB
guard row**. The Redis lock prevents concurrent runs; the DB
guard makes a concurrent run mathematically impossible even if
the Redis lock is somehow bypassed.

## Migration rules

All migrations live in `drizzle/`. Rules:

- Every migration must have a documented rollback (see
  `/migrate` skill).
- Never `DROP COLUMN` in a single migration — expand/contract
  in two migrations.
- Never add a `NOT NULL` column without a default to a populated
  table.
- Money columns added later must use `BIGINT` and match existing
  scale.

## What Postgres must NOT be used for

- ❌ **Live leaderboard queries** — `ORDER BY score DESC LIMIT
  100` on 2M rows is slow and gets slower. That's Redis's job.
- ❌ **Session storage** — stateless API, no sessions.
- ❌ **Caching derived views** — Redis.
- ❌ **Flexible-schema event blobs** — Mongo.

## Query patterns worth repeating

### Rebuild Redis from PG (see also `/rebuild-redis`)

```sql
SELECT user_id, SUM(amount) AS total
FROM earning_events
WHERE week_bucket = $1
GROUP BY user_id;
```

### Audit: verify pool counter matches event sum

```sql
SELECT
  wp.total_pool AS recorded_pool,
  COALESCE(SUM(ee.amount) / 50, 0) AS computed_pool,
  wp.total_pool - (COALESCE(SUM(ee.amount) / 50, 0)) AS drift
FROM weekly_pools wp
LEFT JOIN earning_events ee USING (week_bucket)
WHERE wp.week_bucket = $1
GROUP BY wp.week_bucket, wp.total_pool;
```

Drift should always be zero. Any non-zero value is an incident.

## Common bugs to watch for

1. Using `Math.round` or `*` on amounts in JS instead of BigInt.
2. Forgetting to pass `weekBucket` as `TEXT` — passing a `Date`
   object produces TZ-dependent string coercion.
3. N+1 queries — always use joins or `IN (...)` batches for
   multi-row fetches (e.g. "get usernames for top 100 user IDs").
4. Missing transaction on earnings path — partial writes are
   worse than the whole operation failing.
5. Using `SERIAL` on tables expected to exceed 2B rows
   (`earning_events` will). Use `BIGSERIAL`.

## Further reading

- `docs/adr/ADR-006-bigint-money-arithmetic.md`
- `docs/adr/ADR-003-distributed-lock-with-db-guard.md`
- `src/repositories/postgres/` for live code.
