# ADR-001: Three-database role split — Postgres, Redis, MongoDB

- **Status:** Accepted (revised by ADR-007)
- **Date:** 2026-04-24
- **Deciders:** Mehmet Akif Arslan
- **Tags:** #backend #postgres #redis #mongodb #architecture

> **Note (2026-04-27):** The user placement in this ADR is
> superseded by ADR-007. Users now live in MongoDB. The
> three-database split itself stands; only the user-data ownership
> moves. Read this ADR for the framing of why each database earns
> its place, then read ADR-007 for the corrected user placement.

## Context

The brief fixes the stack as `Node.js + PostgreSQL + MongoDB +
Redis` and explicitly says *"your implementation must stay within
this stack."* Three data systems is a lot for a 10-day case, so
the natural question is whether all three are load-bearing or
whether one can be collapsed into another.

The system has three distinct data shapes:

1. **Transactional truth.** Users, earning events, and prize payouts
   are financial records. They need ACID guarantees, strong
   constraints, and a durable audit trail.
2. **Hot-path ranking.** Top-100 queries and own-rank queries must
   respond in single-digit milliseconds even at 2M users. They are
   read-heavy, mutated on every earning event.
3. **Historical snapshots and audit.** Once a week closes, its
   leaderboard becomes immutable history. We need to query it by
   week, by player, or aggregate across months — but never write to
   it again.

These are three different workloads. Collapsing any two onto one
engine is possible but wasteful — and dropping any of the three
would violate the brief's stack constraint.

## Decision

We use **three databases, each with a single primary responsibility:**

- **PostgreSQL — source of truth.** Users, `earning_events`
  (append-only), `prize_payouts`, `weekly_pools`. All financial
  correctness lives here. Schema changes via Drizzle migrations, each
  reversible.
- **Redis — live leaderboard and coordination.** A sorted set per
  ISO week (`lb:{isoWeek}`) for top-100 and own-rank queries. A
  weekly pool counter. A `SETNX` lock for the prize-distribution
  cron. Redis is a **derived cache** — the project includes
  `/rebuild-redis` which reconstructs the full sorted set from PG in
  minutes, so a total Redis wipe is a recoverable incident.
- **MongoDB — immutable history and audit.** Weekly snapshots (one
  document per week per top-100 player), prize distribution records
  (what ran, when, idempotency key, inputs hash), and analytics-
  friendly player event streams. Write-once per week per player.

## Consequences

### Positive

- Each query hits the engine best suited for it: PG for correctness,
  Redis for latency, Mongo for flexible historical queries.
- Redis being explicitly a cache (not truth) means outages are
  recoverable without data loss. This is provable via
  `/rebuild-redis`.
- Weekly snapshots in Mongo give us an append-only audit log without
  bloating the transactional Postgres tables.
- The architecture directly matches the brief's stack requirement,
  which de-risks the "Cloud usage" and "Architecture" evaluation
  criteria.

### Negative

- Three data systems means three connection pools, three sets of
  operational concerns, three managed-service bills (Neon, Upstash,
  Atlas).
- Dual-write ordering matters: PG first, then Redis. If Redis write
  fails after PG commit, the cache is stale until the next event for
  that player or a manual rebuild. This failure mode is accepted and
  documented in the upcoming ADR-002 (dual-write ordering).
- More onboarding surface for anyone joining the project.

### Neutral

- The stack now has one managed service per concern rather than a
  single VPS with Docker Compose. Different operational model, not
  inherently better or worse — chosen because the case rewards
  "Cloud usage".

## Alternatives Considered

### Alternative A: Postgres + Redis only (drop Mongo)

Historical snapshots could live in Postgres partitioned tables
(`weekly_snapshots_2026w17`, etc.). This works but wastes the
brief's stack, loses flexible schema for analytics events, and
couples cold history to the hot transactional DB.

### Alternative B: Postgres + Mongo only (drop Redis)

Mongo can serve ranked reads with a compound index on `(week, score
DESC, earnedAt ASC)`. It is not O(log N) like a Redis sorted set,
and own-rank queries at 2M users would be noticeably slower. Redis
also does lock coordination, which Mongo cannot do cleanly.

### Alternative C: Put the live leaderboard in Mongo with compound indexes

Claude's first suggestion when asked "where does the live
leaderboard live?" This is technically possible but trades away
Redis's core strength (sorted-set primitives) for nothing in return.
Rejected on performance grounds.

## AI involvement

Claude was asked to enumerate the trade-offs for each collapse
(PG+Redis only, PG+Mongo only, Redis+Mongo only, all three). The
model's initial lean was to put the leaderboard in Mongo with a
compound index — I pushed back because Redis sorted sets are the
textbook solution for exactly this problem.

The final three-way split is my call; Claude helped me articulate
why each database earns its place rather than making the split for
me.

## References

- `docs/case/case-en.html` — stack requirement (§3, infrastructure).
- ADR-002 (forthcoming) — dual-write ordering: PG first, then Redis.
- ADR-003 (forthcoming) — distributed lock on the prize cron.
