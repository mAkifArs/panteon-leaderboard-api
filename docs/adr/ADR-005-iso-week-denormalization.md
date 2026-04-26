# ADR-005: Denormalise `iso_week` as a column on `earning_events`

- **Status:** Accepted
- **Date:** 2026-04-26
- **Deciders:** Mehmet Akif Arslan
- **Tags:** #backend #postgres #performance #denormalisation

## Context

The leaderboard system is week-scoped: every read query, every
ranking computation, every prize calculation, and every weekly
snapshot filters by ISO week. The natural data model places
`earned_at` (a `TIMESTAMPTZ`) on each earning event and computes
the week from it on demand.

At this project's scale — 50M+ rows per week, 2M DAU producing
several million events per day — the performance characteristics
of "compute the week" vs "store the week" diverge sharply.

## Decision

We store `iso_week` as a `TEXT NOT NULL` column on `earning_events`,
populated by the application at insert time using the standard ISO
8601 week format (`YYYY-WXX`). Indexed alongside `user_id` for
ranking queries.

```sql
earning_events (
  ...
  earned_at  TIMESTAMPTZ NOT NULL,
  iso_week   TEXT NOT NULL,
  ...
);

CREATE INDEX ON earning_events (iso_week, user_id);
```

The `iso_week` value is computed once, in the application, at the
moment the earning row is created. It is never updated.

## Consequences

### Positive

- **Equality lookup vs range scan.** `WHERE iso_week = '2026-W17'`
  hits a B-tree index with O(log N) equality lookup. The naive
  alternative — `WHERE earned_at >= ... AND earned_at < ...` —
  must compute week boundaries (timezone-aware) and then perform
  a range scan over an `earned_at` index. Equality wins by an
  order of magnitude at our row count.
- **Composite index is straightforward.** `(iso_week, user_id)` is
  the dominant access pattern for the system. A composite index on
  this pair lets the planner satisfy "what did user X earn in week
  W" with a single index seek.
- **Leaderboard rebuild and replay are simple SQL.** Both
  `/rebuild-redis` and `/replay-week` open with `WHERE iso_week =
  $1`. No date math at the query site.
- **Audit and debugging.** "Show me everything that was credited
  to week 2026-W17" is a one-line query a human can read.
- **No drift risk.** The table is append-only (CLAUDE.md invariant
  3); the column cannot diverge from `earned_at` because nothing
  ever updates either field after insert.

### Negative

- **Denormalisation.** `iso_week` is derivable from `earned_at`,
  so storing it duplicates information. In a mutable schema this
  would be a bug magnet. Append-only neutralises that risk.
- **Slight storage overhead.** `TEXT` of `'YYYY-WXX'` is ~12 bytes
  per row. At 50M rows/week × 52 weeks/year ≈ 31 GB/year on the
  column alone. We accept this — disk is cheap, latency is not.
- **Application is responsible for correctness.** The week format
  must be consistent (`2026-W17`, not `2026-W7` or `26-W17`).
  Mitigated by a single `toIsoWeek(date: Date): string` helper
  used everywhere, plus tests.

### Neutral

- We do not use a generated column (PostgreSQL's
  `GENERATED ALWAYS AS`) because computing ISO week in SQL is
  awkward (`EXTRACT(week FROM ...)` has timezone subtleties and
  does not produce the canonical `YYYY-WXX` format without
  string concatenation). Doing it in TypeScript with a
  battle-tested helper is cleaner.

## Alternatives Considered

### Alternative A: No `iso_week` column; compute on every query

```sql
WHERE earned_at >= '2026-04-20 00:00:00+00'
  AND earned_at <  '2026-04-27 00:00:00+00'
```

Works for ad-hoc queries. For the hot path, range scans over a
`(earned_at)` index are slower than equality on `(iso_week, ...)`
at our scale, and the boundary computation must be done at every
call site. Rejected.

### Alternative B: Generated column

```sql
iso_week TEXT GENERATED ALWAYS AS (
  to_char(earned_at, 'IYYY-"W"IW')
) STORED
```

Postgres maintains the column on insert. Pleasant in theory, but:

- Timezone semantics of `to_char` and `IYYY/IW` need careful
  reading. Test coverage and confidence costs more than just
  using a TS helper.
- The `IYYY-"W"IW` format produces `2026-W17` correctly but
  silently breaks on year boundaries if the wrong format
  specifier is used (`YYYY` vs `IYYY`). Easy to get wrong.

Rejected on "we control the input, the application can produce
the canonical string with one well-tested helper."

### Alternative C: Partition `earning_events` by week

```sql
CREATE TABLE earning_events (
  ...
) PARTITION BY RANGE (earned_at);
```

Partitioning gives O(1) week filtering essentially for free, plus
makes archival cheap (drop a partition). It also adds operational
complexity, requires a partition-creation cron, and complicates
foreign keys.

Rejected for now on operational simplicity grounds. Worth
revisiting if the table grows beyond ~1B rows or if archive cost
becomes a problem. The denormalised column does not preclude
adding partitioning later.

## AI involvement

Claude was asked to compare the three options under our scale
assumptions (50M rows/week, 2M DAU). It surfaced the partitioning
option (Alternative C) which I had not initially considered, but
I rejected it as premature operational complexity for the case
window. The denormalisation choice is mine.

## References

- ADR-001 — three-database role split.
- CLAUDE.md invariant 3 — `earning_events` is append-only
  (denormalisation is safe because nothing mutates the row).
- `.claude/skills/postgres-patterns/SKILL.md` — encodes the
  `iso_week` naming convention and required indexes.
