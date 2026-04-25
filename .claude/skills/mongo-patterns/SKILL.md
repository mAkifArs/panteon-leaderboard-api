---
name: mongo-patterns
description: Project-specific MongoDB conventions for the leaderboard system. Loads when working on weekly snapshots, audit archives, analytics pipelines, or anything that writes to the weekly_snapshots / prize_distributions / player_events collections.
---

# MongoDB Patterns — Leaderboard Project

Conventions specific to **this project's** use of MongoDB.

## Role

MongoDB is the **historical archive and analytics** layer:

- `weekly_snapshots` — one document per completed week,
  capturing the final top-100 ranking and pool metadata.
- `prize_distributions` — full audit log of every prize
  distribution run (which winners, what amounts, which run ID,
  which API instance executed it).
- `player_events` — optional event stream for analytics
  (earnings, level-ups, logins). Write-heavy, read-for-analysis.

Mongo is **never** on the live request path. If Mongo is down,
the application serves traffic normally — new events get buffered
in a local file-backed queue and flushed when Mongo recovers.

## Why Mongo and not Postgres for these

1. **Snapshots are semi-structured.** Each week's schema may
   evolve (new metrics added, new distribution formulas tested).
   Document model absorbs this without migrations.
2. **Write-once, read-rarely.** Snapshots and distributions are
   append-only historical records; Mongo's write path is
   optimised for this access pattern.
3. **Analytics pipelines.** Aggregation framework is well-suited
   for "top 10 users by total earnings over 12 weeks" style
   queries. PG could do it but requires more plumbing.
4. **Scale of event stream.** `player_events` grows linearly with
   traffic. Sharding in Mongo is straightforward; in PG it's an
   operational project.

## Collection: weekly_snapshots

```javascript
{
  _id: "2026-W18",                      // ISO week as string, deterministic PK
  weekStart: ISODate("2026-04-27"),
  weekEnd:   ISODate("2026-05-03"),
  totalPool: NumberDecimal("12500000"), // BigInt as Decimal128
  participantCount: 1982445,
  topPlayers: [
    {
      rank: 1,
      userId: "uuid",
      username: "xxx",
      earnings: NumberDecimal("2500000"),
      prize: NumberDecimal("2500000"),
      prizePercentage: 20
    },
    // ... 100 entries
  ],
  distributionRunId: "uuid",
  finalisedAt: ISODate("2026-05-04T00:05:00Z"),
  apiInstance: "api-fly-fra-01",
  schemaVersion: 1
}
```

**Key rules:**

- `_id` is the ISO week string. Enforces "one snapshot per week"
  at the DB level.
- Money fields use `Decimal128` to preserve BigInt semantics.
  Never store money as `Double`.
- `schemaVersion` is set on every document. Future schema
  changes bump the version; read code handles each version
  explicitly.

## Collection: prize_distributions

```javascript
{
  _id: ObjectId(),
  weekBucket: "2026-W18",
  distributionRunId: "uuid",
  totalDistributed: NumberDecimal("12500000"),
  payouts: [
    { rank: 1, userId: "uuid", amount: NumberDecimal("2500000"), percentage: 20 },
    // ... 100 entries
  ],
  ranAt: ISODate("2026-05-04T00:05:00Z"),
  ranByInstance: "api-fly-fra-01",
  status: "completed" | "failed" | "partial",
  durationMs: 347,
  notes: "optional human context"
}
```

**Indexes:**

```
{ weekBucket: 1 }
{ distributionRunId: 1 }
{ ranAt: -1 }
```

## Collection: player_events

```javascript
{
  _id: ObjectId(),
  userId: "uuid",
  type: "earning" | "login" | "level_up" | "purchase",
  amount: NumberDecimal("500"),  // optional, only for monetary types
  weekBucket: "2026-W18",
  occurredAt: ISODate(),
  metadata: { /* arbitrary payload, type-dependent */ },
  schemaVersion: 1
}
```

**Indexes:**

```
{ userId: 1, occurredAt: -1 }
{ weekBucket: 1, type: 1 }
{ occurredAt: -1 }                         // TTL index optional, 90d retention
```

## Write patterns

- **All writes to `weekly_snapshots` are idempotent upserts**
  keyed by ISO week. Re-running the finalisation job must
  produce the same document, not a duplicate.
- **Writes to `prize_distributions` are inserts only.** Each
  run produces one document. Retries must generate a new
  `distributionRunId` — they don't overwrite the prior run's
  log.
- **`player_events` writes are fire-and-forget** from the API
  perspective. Use `acknowledged: false` write concern only if
  you understand the durability implication. Otherwise batch
  inserts with `ordered: false` for throughput.

## What Mongo must NOT be used for

- ❌ **Live leaderboard queries.** That's Redis.
- ❌ **Financial source of truth.** That's Postgres. Mongo is
  derived / archival.
- ❌ **User authentication / identity.** Postgres.
- ❌ **Anything that requires multi-document ACID transactions
  across collections.** Mongo supports them but adds latency;
  if you need this, reconsider whether the data actually
  belongs in Postgres.

## Aggregation patterns worth knowing

### Top 10 players by cumulative earnings over last 4 weeks

```javascript
db.weekly_snapshots.aggregate([
  { $match: { _id: { $in: [lastWeek, lastWeek-1, lastWeek-2, lastWeek-3] } } },
  { $unwind: "$topPlayers" },
  { $group: {
      _id: "$topPlayers.userId",
      totalEarnings: { $sum: "$topPlayers.earnings" },
      weeksInTop100: { $sum: 1 }
  } },
  { $sort: { totalEarnings: -1 } },
  { $limit: 10 }
])
```

### Distribution audit: sum all payouts ever

```javascript
db.prize_distributions.aggregate([
  { $unwind: "$payouts" },
  { $group: {
      _id: null,
      everDistributed: { $sum: "$payouts.amount" }
  } }
])
```

## Common bugs to watch for

1. Storing money as `Number` (JS number) instead of
   `Decimal128`. Amounts above `2^53` lose precision.
2. Forgetting `schemaVersion` on documents. Future changes
   become painful.
3. Writing to Mongo on the synchronous request path. Always
   enqueue or fire-and-forget.
4. Creating unbounded arrays (e.g. pushing all earnings into
   one user document). Mongo has a 16MB document limit.
5. Missing index on `weekBucket` for analytics queries —
   collection scans on millions of event documents are slow.

## Further reading

- `docs/adr/ADR-001-three-database-split.md`
- `src/repositories/mongo/` for live code.
