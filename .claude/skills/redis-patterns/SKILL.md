---
name: redis-patterns
description: Project-specific Redis conventions for the leaderboard system. Loads when working on anything involving Redis keys, sorted sets, pipelining, locks, or leaderboard read/write paths. Covers key naming, TTL policy, pipelining rules, Lua scripts, and what Redis must NOT be used for.
---

# Redis Patterns — Leaderboard Project

This skill documents how Redis is used in **this specific
project**. It is not a general Redis tutorial. The Claude base
model already knows Redis; this file teaches the conventions
we follow here.

## Role

Redis is the **live, volatile, high-throughput** layer of the
three-database stack:

- Postgres is the source of truth (users, earnings audit trail,
  payouts).
- Redis is the **derived, live view** (current-week leaderboard,
  rank queries, prize pool counter, cron locks).
- Mongo is the historical archive (weekly snapshots, event stream).

If Redis is wiped, the system is fully recoverable from Postgres
via `/rebuild-redis`. Never store anything in Redis that is not
derivable from Postgres.

## Key naming

All keys follow `<domain>:<scope>:<identifier>`:

| Pattern                                 | Purpose                         | TTL  |
|-----------------------------------------|----------------------------------|------|
| `leaderboard:week:<ISO-week>`           | Sorted set, scores per user     | 14d  |
| `pool:week:<ISO-week>`                  | Integer counter, 2% pool        | 14d  |
| `idempotency:earnings:<key>`            | Cached POST /earnings response  | 24h  |
| `lock:distribution:week:<ISO-week>`     | SETNX cron lock                 | 10m  |
| `lock:rebuild:leaderboard:week:<ISO-week>` | SETNX rebuild lock           | 5m   |
| `rate:earnings:<userId>`                | Token bucket counter (optional) | 60s  |

**ISO week format is `YYYY-WXX`** (e.g. `2026-W18`). Zero-padded.
Week boundaries are Monday 00:00:00 UTC.

## Sorted set conventions

The leaderboard uses a single sorted set per week, keyed by
user ID, scored by earnings (smallest currency unit, as a
Number — not BigInt because Redis scores are 64-bit floats, but
our amounts stay within safe integer range for realistic weekly
totals).

**Always use `ZINCRBY` to increment, not `ZADD`.** Racing reads
between two API instances would otherwise cause lost updates.
`ZINCRBY` is atomic at the Redis level.

**Read commands:**

| Intent              | Command                                        |
|---------------------|------------------------------------------------|
| Top 100             | `ZREVRANGE leaderboard:week:X 0 99 WITHSCORES` |
| A user's rank       | `ZREVRANK leaderboard:week:X <userId>`         |
| Own + neighbours    | Lua script (see below) — never two round-trips |
| Total participants  | `ZCARD leaderboard:week:X`                     |

## Lua script: own-rank cluster

The "own rank + 3 above + 2 below" query must be atomic. Two
round-trips (ZREVRANK then ZREVRANGE) can tear under concurrent
writes. Use this Lua script, loaded once at startup via
`SCRIPT LOAD`:

```lua
-- KEYS[1] = leaderboard key
-- ARGV[1] = userId
local rank = redis.call('ZREVRANK', KEYS[1], ARGV[1])
if rank == false then
  return {-1}  -- not ranked
end
local start_rank = math.max(0, rank - 3)
local end_rank = rank + 2
local entries = redis.call('ZREVRANGE', KEYS[1], start_rank, end_rank, 'WITHSCORES')
return {rank, start_rank, entries}
```

Call it via `EVALSHA` with the pre-loaded hash, not `EVAL`
every time.

## Pipelining rules

- **Any write of > 10 operations must be pipelined.** Use
  `redis.pipeline()` (ioredis) or `MULTI/EXEC` (node-redis).
- **Seed scripts use batches of 10,000** — larger batches hit
  request buffer limits on Upstash.
- **Reads that fan out across multiple keys** (e.g. joining top
  100 with PG user rows) should fetch from PG, not do N Redis
  round-trips.

## Distributed locks

Only for operations that **must run on exactly one instance**:

- Weekly prize distribution cron.
- Redis rebuild from PG.
- Backfill scripts.

Use the standard pattern:

```typescript
const token = crypto.randomUUID()
const acquired = await redis.set(lockKey, token, 'EX', ttlSec, 'NX')
if (!acquired) throw new LockContendedError()
try {
  // ... work ...
} finally {
  // Release only if we still own the lock (atomic check-and-del)
  await redis.eval(
    `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`,
    1, lockKey, token
  )
}
```

**Never release with `DEL` unconditionally** — if your lock TTL
expired and another instance acquired it, you'd release theirs.

## What Redis must NOT be used for

- ❌ **Persistent financial data** — prize payouts, earning
  history. Those go to Postgres.
- ❌ **User profile data** — username, email, auth. Postgres.
- ❌ **Append-only event streams** — those go to Mongo
  (`player_events`).
- ❌ **Anything where "the value was here a minute ago but is
  gone now" is catastrophic** — Upstash/ElastiCache can evict
  under memory pressure.
- ❌ **As a pub/sub message bus** — use BullMQ (which uses
  Redis under the hood but gives us persistence, retries,
  observability).

## Common bugs to watch for

1. **Using `ZRANGE` instead of `ZREVRANGE`** for top players.
   Ascending order returns the lowest scores first.
2. **Forgetting `WITHSCORES`** when you need scores in the
   response payload.
3. **Off-by-one on neighbour windows** — rank 2 has only 1
   player above, not 3. Shift the window.
4. **Float precision on very large scores** — Redis scores are
   IEEE 754 doubles. Amounts above `2^53` lose precision. Our
   realistic weekly maximum is well below this but seed scripts
   should not generate absurd values.
5. **Not pipelining a batch of ZADDs** — this is a 50x slowdown.
6. **Releasing someone else's lock** — always use the token-check
   Lua above.

## Further reading

- `docs/adr/ADR-002-dual-write-pg-then-redis.md`
- `docs/adr/ADR-003-distributed-lock-with-db-guard.md`
- `src/repositories/redis/` for all live code following these
  patterns.
