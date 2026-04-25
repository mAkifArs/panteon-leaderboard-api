---
name: seed
description: Regenerate fake leaderboard data for local development or benchmarking. Uses a Pareto distribution to mimic real idle-game economies (few whales, many casuals). Default 100k users; pass size arg for larger runs.
---

# Seed

Populate the local stack with realistic fake game data.

## Arguments

- `[size]` — number of users to create. Default `100000`.
  Supported: `1k`, `10k`, `100k`, `1m`, `2m`.

## Procedure

1. **Confirm local stack is running.** `docker-compose ps` should
   show postgres, redis, mongo all healthy. If not, `docker-compose
   up -d` first and wait for healthchecks.

2. **Reset existing state** (ask user first if destructive):

   ```bash
   pnpm tsx scripts/reset-local.ts
   ```

   This truncates `users`, `earning_events`, `weekly_pools`,
   `prize_payouts`, flushes the Redis DB, drops Mongo collections.

3. **Seed users:**

   ```bash
   pnpm tsx scripts/seed.ts --users=<size> --week=$(date +%Y-W%V)
   ```

   The seed script:
   - Generates users with `@faker-js/faker`.
   - Batches 10k user INSERTs per transaction.
   - For earnings, uses a Pareto distribution (α=1.5): top 1% earn
     ~60% of total coins, bottom 50% earn ~5%. Mimics real idle
     games.
   - For each user, emits between 1 and 200 `earning_events` over
     the past 7 days, timestamps uniformly distributed.
   - Simultaneously updates Redis sorted set via pipelined `ZADD`.

4. **Verify:**

   ```bash
   pnpm tsx scripts/verify-seed.ts
   ```

   Checks that:
   - `SELECT COUNT(*) FROM users` matches requested size.
   - Redis `ZCARD leaderboard:week:<current>` matches.
   - `SELECT SUM(amount)/50 FROM earning_events` equals
     `weekly_pools.total_pool` (2% cut correctness).

5. **Print summary.** Top 10 leaderboard, pool total, user count,
   total earnings, elapsed time.

## Rules

- **Never run on production DSNs.** The skill must abort if
  `DATABASE_URL` contains `neon.tech`, `amazonaws.com`, or any
  managed-provider hostname. Only `localhost`, `127.0.0.1`, or
  `docker.internal` are allowed.
- **Amounts are BigInt.** Never generate float amounts.
- **Usernames must be unique.** Faker can collide at scale —
  use `${username}_${i}` to guarantee uniqueness.
- **Time distribution:** no earnings with `occurred_at` in the
  future. Clock skew causes subtle bugs in `ZREVRANGE` queries
  that slice by timestamp.

## Performance expectations

| Size | Expected duration on M1 / dev laptop |
|------|--------------------------------------|
| 10k  | ~5s                                  |
| 100k | ~45s                                 |
| 1m   | ~6 min                               |
| 2m   | ~14 min                              |

If the run exceeds these by more than 2x, something is wrong —
check batch sizes and Redis pipelining.
