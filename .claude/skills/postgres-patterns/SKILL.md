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
- Append-only earnings audit trail (`earning_events`) — also
  the registry for idempotency keys, via the `idempotency_key`
  column with a `UNIQUE` constraint (no separate table; see
  ADR-004)
- Prize pool accumulators per week (`weekly_pools`)
- Prize payouts, one row per winner per week (`prize_payouts`)

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
  - `users.id` — `BIGSERIAL`. The game's user id is stored in
    `users.external_id` (TEXT UNIQUE).
  - `earning_events.id` — `BIGSERIAL`. Ordered, append-only.
  - `prize_payouts.id` — `BIGSERIAL`.
  - `weekly_pools.iso_week` — TEXT primary key, ISO week.
- Foreign keys are always explicit, never implicit. `ON DELETE
  RESTRICT` unless there's a documented reason otherwise.
- Timestamps: `TIMESTAMPTZ`, never `TIMESTAMP WITHOUT TIME
  ZONE`. Server operates in UTC.
- ISO-week column: always `TEXT NOT NULL` with format
  `YYYY-WXX`, named `iso_week` everywhere. Indexed alongside
  user_id (see ADR-005 for why we denormalise it).

## Required indexes

```sql
-- earning_events
CREATE INDEX        ON earning_events (iso_week, user_id);
CREATE INDEX        ON earning_events (user_id, earned_at);
CREATE UNIQUE INDEX ON earning_events (idempotency_key);

-- prize_payouts
CREATE UNIQUE INDEX ON prize_payouts (iso_week, user_id);
CREATE UNIQUE INDEX ON prize_payouts (iso_week, rank);

-- users
CREATE UNIQUE INDEX ON users (external_id);
```

The two `UNIQUE` indexes on `prize_payouts` are the **final line
of defence against double-payouts**. Even if the Redis SETNX
lock fails and the application status check is bypassed,
Postgres will reject:

- `UNIQUE (iso_week, user_id)` — a second payout to the same
  user in the same week.
- `UNIQUE (iso_week, rank)` — two users assigned the same rank
  in the same week. This also enforces deterministic
  tie-breaking — without it, a re-run could pick a different
  winner for a tied rank.

`UNIQUE (idempotency_key)` on `earning_events` makes duplicate
POST /earnings requests idempotent at the database level (see
ADR-004).

## Tie-breaking — deterministic, three-level

When two players have the same weekly total, ranking ties are
broken by **earliest first earning of that week**, then by
**smaller `earning_events.id`** as a final fallback. Every
ranking query in the system uses the same three-level
`ORDER BY`:

```sql
SELECT
  user_id,
  SUM(amount)                           AS total,
  MIN(earned_at)                        AS first_earning_at,
  MIN(id)                               AS first_earning_id
FROM earning_events
WHERE iso_week = $1
GROUP BY user_id
ORDER BY
  total              DESC,    -- 1. higher amount wins
  first_earning_at   ASC,     -- 2. earlier first earning wins
  first_earning_id   ASC      -- 3. earlier insert wins (microsecond ties)
LIMIT 100;
```

**Why three levels:**

- Level 1 (`total DESC`) — the obvious score order.
- Level 2 (`first_earning_at ASC`) — fairness rule: the player
  who started earning earlier this week wins. Reflects gameplay
  engagement, not account age.
- Level 3 (`first_earning_id ASC`) — `TIMESTAMPTZ` is microsecond-
  precision; identical timestamps are rare but possible. The
  monotonic `BIGSERIAL` id breaks the final tie.

**Why this matters beyond fairness:**

- `prize_payouts UNIQUE (iso_week, rank)` requires that every
  rank maps to exactly one user. Non-deterministic tie-breaking
  → INSERT conflict on retry → broken cron.
- `/replay-week` must reproduce the exact same ranking from the
  same `earning_events` rows. Random or implementation-defined
  ordering breaks replay determinism, which breaks the audit
  story.

**Forbidden tie-breakers:**

- `user_id` ASC — gives older accounts permanent advantage.
- `created_at` ASC — same problem at user level.
- `RANDOM()` — non-deterministic, breaks replay.
- Username alphabetical — players have no control, feels arbitrary.

The three-level rule is non-negotiable. If you need to add a
new ranking query, it uses the same ORDER BY. No exceptions.

## Transaction patterns

### POST /earnings — idempotent insert + pool increment

```typescript
await db.transaction(async (tx) => {
  // 1. Insert the earning row. If the idempotency key already
  //    exists, ON CONFLICT returns no rows — we treat that as
  //    "already processed" and return the existing row's data.
  const inserted = await tx
    .insert(earningEvents)
    .values({
      userId,
      amount,
      isoWeek,
      idempotencyKey,
      earnedAt: new Date(),
    })
    .onConflictDoNothing({ target: earningEvents.idempotencyKey })
    .returning()

  if (inserted.length === 0) {
    // Replay of an already-processed request. Return the
    // existing row so the response is identical.
    const existing = await tx
      .select()
      .from(earningEvents)
      .where(eq(earningEvents.idempotencyKey, idempotencyKey))
    return existing[0]
  }

  // 2. Increment the weekly pool by 2% (BigInt arithmetic).
  await tx
    .insert(weeklyPools)
    .values({ isoWeek, poolAmount: (amount * 2n) / 100n })
    .onConflictDoUpdate({
      target: weeklyPools.isoWeek,
      set: {
        poolAmount: sql`${weeklyPools.poolAmount} + ${(amount * 2n) / 100n}`,
      },
    })

  return inserted[0]
})
```

Note: the response itself is not stored. The idempotency
guarantee is that the *side effects* (the earning row, the pool
increment) happen exactly once. The response is reconstructed
from the existing row on replay.

### Prize distribution (status state machine + DB guard)

```typescript
await db.transaction(async (tx) => {
  // Atomic "claim this week for distribution".
  // Only succeeds if status is currently 'open'.
  const claim = await tx
    .update(weeklyPools)
    .set({ status: 'distributing' })
    .where(and(
      eq(weeklyPools.isoWeek, isoWeek),
      eq(weeklyPools.status, 'open'),
    ))
    .returning()

  if (claim.length === 0) {
    // Already distributing or distributed. No-op.
    return
  }

  // Insert all 100 payouts. UNIQUE (iso_week, user_id) and
  // UNIQUE (iso_week, rank) reject duplicates if anything
  // bypasses the status check above.
  await tx.insert(prizePayouts).values(payouts)

  // Close the week.
  await tx
    .update(weeklyPools)
    .set({ status: 'distributed', distributedAt: new Date() })
    .where(eq(weeklyPools.isoWeek, isoWeek))
})
```

This pattern needs **all four layers** for safety:

1. Redis `SETNX` lock — blocks concurrent cron triggers across
   horizontally-scaled API instances.
2. `weekly_pools.status = 'open'` check — application-level
   guard, fast no-op on retry.
3. `UNIQUE (iso_week, user_id)` — DB-level guard against double
   payouts to the same user.
4. `UNIQUE (iso_week, rank)` — DB-level guard against rank
   collisions, also enforces deterministic tie-breaking.

If layers 1–3 all fail simultaneously (unlikely but possible
during a botched deploy), layer 4 still rejects the duplicate
INSERT. We never want to be one bug away from a double payout.

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
WHERE iso_week = $1
GROUP BY user_id;
```

### Audit: verify pool counter matches event sum

```sql
SELECT
  wp.total_pool AS recorded_pool,
  COALESCE(SUM(ee.amount) / 50, 0) AS computed_pool,
  wp.total_pool - (COALESCE(SUM(ee.amount) / 50, 0)) AS drift
FROM weekly_pools wp
LEFT JOIN earning_events ee USING (iso_week)
WHERE wp.iso_week = $1
GROUP BY wp.iso_week, wp.total_pool;
```

Drift should always be zero. Any non-zero value is an incident.

## Common bugs to watch for

1. Using `Math.round` or `*` on amounts in JS instead of BigInt.
2. Forgetting to pass `isoWeek` as `TEXT` — passing a `Date`
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
