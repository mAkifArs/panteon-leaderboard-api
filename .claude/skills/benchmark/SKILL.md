---
name: benchmark
description: Run k6 load tests against the local API, capture p50/p99 latencies for top-100, own-rank, and earnings endpoints, and refresh the benchmark table in README.md. Use before delivery and after any performance-sensitive change.
---

# Benchmark

Produce reproducible performance numbers that back the
scalability claims in the README.

## Procedure

1. **Verify precondition:** 2M-user seed is loaded.

   ```bash
   pnpm tsx scripts/verify-seed.ts --expect=2000000
   ```

   If the seed is smaller, abort with a message explaining the
   user should run `/seed 2m` first. 2M is the baseline for
   advertised numbers.

2. **Warm caches** — 30 second low-rate soak so Redis working
   set is hot:

   ```bash
   k6 run --duration 30s --vus 10 benchmarks/warmup.js
   ```

3. **Run scenarios in sequence** (never in parallel; contention
   poisons the numbers):

   ```bash
   k6 run benchmarks/read-top100.js      > .bench/top100.json
   k6 run benchmarks/read-own-rank.js    > .bench/ownrank.json
   k6 run benchmarks/write-earnings.js   > .bench/earnings.json
   k6 run benchmarks/mixed-workload.js   > .bench/mixed.json
   ```

   Each scenario runs for 60s at 100 VUs unless the script
   specifies otherwise.

4. **Parse results.** Each scenario outputs JSON summaries with
   `http_req_duration` percentiles. Extract:
   - p50, p95, p99 latency
   - RPS (requests per second sustained)
   - Error rate (must be < 0.1% or the run is invalid)

5. **Format as markdown table.** Exactly this structure:

   ```markdown
   | Endpoint                     | p50    | p95    | p99    | RPS    | Errors |
   |------------------------------|--------|--------|--------|--------|--------|
   | GET /leaderboard/top100      | 3.2ms  | 4.5ms  | 5.8ms  | 28,400 | 0.00%  |
   | GET /leaderboard/me          | 4.1ms  | 6.2ms  | 8.1ms  | 22,100 | 0.00%  |
   | POST /earnings               | 6.8ms  | 11.4ms | 18.2ms | 14,500 | 0.02%  |
   | Mixed (70% read / 30% write) | 5.9ms  | 9.8ms  | 14.1ms | 18,700 | 0.01%  |
   ```

6. **Update README.md.** Replace the block between the markers:

   ```
   <!-- BENCH:START -->
   (paste table here)
   _Last run: YYYY-MM-DD on <machine-description>_
   <!-- BENCH:END -->
   ```

7. **Commit** with message: `chore: refresh benchmarks (run on
   <date>, <seed-size>)`.

## Rules

- **Never paste numbers that weren't measured in this session.**
  If a scenario fails or errors, leave its row as `N/A` with a
  footnote explaining why.
- **Same machine, same seed.** If you change hardware or seed
  size, note it in the README footnote.
- **Error rate > 0.1% invalidates the run** — fix the issue
  before reporting numbers.
- **Single Fly machine baseline.** Numbers are reported for one
  API instance unless stated otherwise. Multi-instance numbers
  get their own separately-labelled table.

## What good numbers look like

For this stack on a single Fly shared-cpu-1x with managed
Upstash/Neon/Atlas:

- Top 100: p99 < 10ms
- Own-rank: p99 < 15ms
- Earnings write: p99 < 25ms (includes PG tx + Redis pipeline)

Numbers significantly worse than these suggest a missing index,
a non-pipelined Redis call, or N+1 SQL.
