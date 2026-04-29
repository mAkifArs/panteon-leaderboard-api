# ADR-003: Four-layer safety for prize distribution (lock + status + dual UNIQUE)

- **Status:** Accepted
- **Date:** 2026-04-27
- **Deciders:** Mehmet Akif Arslan
- **Tags:** #backend #postgres #redis #cron #money-safety

## Context

The weekly cron distributes real in-game currency to the top 100
players. A bug here is a financial-correctness incident, not a
cosmetic one — double payouts cost the company money, missed
payouts erode player trust. The cron will eventually run on a
horizontally-scaled API deployment (Fly.io, multiple instances),
which means a naive `node-cron` inside the app process would fire
N times for N instances.

The system must guarantee, under any combination of:

- horizontal scaling (multiple instances)
- crashed mid-run, restarted by orchestrator
- accidental manual re-trigger
- buggy code that bypasses application-level checks

…that **each (week, user) and each (week, rank) tuple receives at
most one payout**, ever.

## Decision

We use **four independent layers** of protection. Each layer would
be sufficient to catch most bugs alone; together they require all
four to fail simultaneously for a double-payout to occur.

### Layer 1 — Redis SETNX lock with TTL

`SET lock:distribution:week:<isoWeek> <runId> NX PX <ttlMs>`

The first instance to win the SETNX race holds the lock and runs
the distribution. Other instances see `NX` reject and back off.
TTL guarantees that a crashed holder eventually releases the lock.

Release uses a Lua compare-and-delete script so a stale holder
cannot accidentally release another holder's lock after its own
TTL expired:

```lua
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
```

### Layer 2 — `weekly_pools.status` state machine in PG transaction

Inside the distribution PG transaction, the first action is an
atomic CAS:

```sql
INSERT INTO weekly_pools (iso_week, status) VALUES (..., 'distributing')
ON CONFLICT (iso_week) DO UPDATE
  SET status = 'distributing'
  WHERE weekly_pools.status = 'open'
RETURNING iso_week
```

Only one transaction can flip the row from `'open'` to
`'distributing'`. Subsequent attempts return zero rows and the
distribution becomes a no-op. This catches the case where the
Redis lock somehow let two distributors through (Redis split-brain,
clock skew on TTL).

### Layer 3 — `UNIQUE (iso_week, user_id)` on `prize_payouts`

Even if both Layers 1 and 2 fail and two distributors get to the
INSERT step, the unique constraint rejects the second user payout
for the same week. The transaction rolls back; no money moves.

### Layer 4 — `UNIQUE (iso_week, rank)` on `prize_payouts`

A second unique constraint on (week, rank). This guards against:

- A bug that maps two users to the same rank (broken sort, stale
  data, off-by-one).
- A retry that recomputes the ranking with non-deterministic
  tie-breaking, assigning rank 47 to a different user than the
  first run.

By requiring rank uniqueness per week, we **enforce deterministic
tie-breaking at the database level**. CLAUDE.md invariant 7
specifies the three-level tie-break ORDER BY; this UNIQUE makes
violating that rule impossible to commit.

## Consequences

### Positive

- A double-payout requires every layer to fail at the same instant
  — vanishingly unlikely.
- Each layer is independent: Redis can be wiped, the PG row can be
  deleted manually, the cron can be triggered by hand, and the DB
  constraints still catch it.
- The four-layer design becomes part of the audit story:
  `/replay-week` can demonstrate that the system would have
  rejected any duplicate even in adversarial conditions.

### Negative

- More moving parts. A new contributor needs to understand all four
  layers (mitigated by `postgres-patterns` and `redis-patterns`
  skills documenting them).
- Failure modes shift: instead of "did the cron run?", the question
  becomes "which layer caught it, and is the row in 'distributing'
  state requiring manual cleanup?". `/replay-week` is the recovery
  tool.

### Neutral

- The Redis lock is essentially "fast-path optimisation" — it
  prevents wasted work in the common case. Layers 2-4 are the
  correctness guarantees. Removing the Redis lock would make the
  system slower (every cron tick on every instance starts a PG
  transaction) but not less correct.

## Alternatives Considered

### Alternative A: PG advisory lock only

`SELECT pg_advisory_xact_lock(...)` would serialize attempts at
the DB. Works but does not give the fast Redis-side rejection,
and adds load to PG even for instances that should bail early.

### Alternative B: Redis lock alone, no DB constraints

Cheap and fast, but a Redis outage or split-brain becomes a
financial incident. Money safety should not depend on a single
infrastructure component being healthy.

### Alternative C: Application-level "have we run this week" check

A naive `SELECT count(*) FROM prize_payouts WHERE iso_week = ?`
before inserting. TOCTOU race: two instances both see 0, both
insert. Requires a lock anyway, and doesn't add anything beyond
the constraints.

### Alternative D: Idempotency-key approach (single token per week)

Treat the cron run like a POST request with an `Idempotency-Key`
of `week:<isoWeek>`. Workable but conflates two concerns — the
key would need to live somewhere (Redis or PG) and become a fifth
layer rather than replacing one.

## AI involvement

The four-layer model was pieced together over several Claude
conversations. Claude initially suggested only the Redis lock
("it's the standard pattern"), and I pushed for adding the DB
constraint as a fail-safe — the pushback was a YAGNI/safety
trade-off where I prioritised safety on the money path.

Claude later helped enumerate the failure modes for each layer
in isolation, which surfaced the rank-UNIQUE idea as a way to
also enforce deterministic tie-breaking at the DB level (Layer 4
ended up doing two jobs).

The final structure is mine; Claude was an accelerant on
articulation and edge-case enumeration.

## References

- ADR-001 — three-database role split (Redis is derived; PG is
  source of truth → constraints belong in PG).
- ADR-005 — `iso_week` denormalisation (UNIQUE constraints
  reference this column).
- CLAUDE.md invariant 5 — distribution runs in a single PG
  transaction guarded by Redis SETNX with TTL.
- CLAUDE.md invariant 7 — deterministic tie-breaking, enforced
  at the DB by Layer 4.
- `src/services/distribution.ts` — implementation.
- `src/services/distribution-lock.ts` — Layer 1.
