---
name: rebuild-redis
description: Rebuild the Redis leaderboard sorted set for the current (or a specified) week from Postgres earning_events. Use after a Redis outage, or to demonstrate the single-source-of-truth architecture — PG is the authority, Redis is a derived cache.
---

# Rebuild Redis

Regenerate the live leaderboard in Redis from the Postgres
`earning_events` table. This is the disaster-recovery path and
the architectural proof that **Postgres is the source of truth
and Redis is a derived view**.

## Arguments

- `[week-bucket]` — optional. Defaults to current ISO week.
  Format: `YYYY-WXX`.

## Procedure

1. **Confirm the target.** Print the week bucket and the Redis
   key (`leaderboard:week:<bucket>`), then ask the user to
   confirm. This is a destructive operation on the live key.

2. **Acquire a rebuild lock.** Redis key
   `rebuild-lock:leaderboard:week:<bucket>` with SETNX and a 5
   minute TTL. If the lock is already held, abort — another
   rebuild is in progress.

3. **Delete the existing sorted set:**

   ```
   DEL leaderboard:week:<bucket>
   ```

4. **Stream rows from Postgres in batches.** Query in chunks of
   10,000:

   ```sql
   SELECT user_id, SUM(amount) AS total_earnings
   FROM earning_events
   WHERE week_bucket = $1
   GROUP BY user_id
   ORDER BY user_id
   OFFSET $2 LIMIT 10000;
   ```

5. **Pipeline ZADD into Redis** in batches of 10k:

   ```
   MULTI
   ZADD leaderboard:week:<bucket> <score> <userId>  // x 10,000
   EXEC
   ```

6. **Also rebuild the pool counter:**

   ```sql
   SELECT SUM(amount) / 50 AS pool FROM earning_events WHERE week_bucket = $1;
   ```

   Then:

   ```
   SET pool:week:<bucket> <value>
   ```

7. **Verify:**

   - Redis `ZCARD leaderboard:week:<bucket>` equals
     `SELECT COUNT(DISTINCT user_id) FROM earning_events WHERE week_bucket = $1`.
   - Top 10 via `ZREVRANGE` matches top 10 via PG `ORDER BY
     SUM(amount) DESC LIMIT 10`.
   - Pool value matches `SUM(amount)/50` from PG.

8. **Release the lock.** `DEL rebuild-lock:...`.

9. **Report:**
   - User count
   - Top 10
   - Pool value
   - Elapsed time
   - Throughput (users/sec)

## Rules

- **Never delete a key without a lock.** Concurrent rebuilds
  produce inconsistent state.
- **Never trust Redis as the primary.** The whole point of this
  skill is to prove the opposite — if PG and Redis disagree,
  PG wins.
- **Do not use `KEYS` or `SCAN` to pick the week bucket.** Always
  read it from the argument or current-week calculation; never
  discover it from Redis state.
- **Bulk operations must be pipelined.** One RTT per ZADD at 2M
  users takes tens of minutes; pipelined it takes under 60
  seconds.

## Expected duration

| User count | Expected rebuild time |
|------------|-----------------------|
| 100k       | ~2s                   |
| 1m         | ~25s                  |
| 2m         | ~55s                  |

Anything slower than 2x these suggests a missing index on
`earning_events(week_bucket, user_id)` or a non-pipelined Redis
path.

## Demo value

This skill is the single clearest answer to the interview
question: *"What happens if Redis dies?"*

```
$ claude /rebuild-redis 2026-W18
> Confirm rebuild of leaderboard:week:2026-W18 from Postgres? [y/N]: y
> Acquired lock.
> Streaming 1,982,445 users from Postgres...
> Pipelined 1,982,445 ZADDs in 54.2s.
> Pool counter restored: 12,438,910.
> Verification passed. Lock released.
> Top 1: user_8f3ac1 (earnings: 2,512,300).
```

Record a GIF of this and embed it in the README.
