---
name: replay-week
description: Rebuild what the prize distribution SHOULD have been for a given ISO week from Postgres earning_events, and diff against the actual prize_payouts table. Use for audit, debugging a distribution incident, or demonstrating determinism of the payout engine.
---

# Replay Week

Given an ISO week bucket (e.g. `2026-W18`), reconstruct the correct
prize distribution from the source-of-truth `earning_events` table
and compare it to what was actually written to `prize_payouts`.

A correct, healthy system produces an empty diff. Any non-empty
diff is an incident.

## Arguments

- `<week-bucket>` — ISO-8601 week string, format `YYYY-WXX`.
  Example: `2026-W18`.

## Procedure

1. **Load expected state.** Run the pure function
   `calculateDistribution(weekBucket)` from
   `src/services/distribution/calculate.ts`. This function reads
   `earning_events` for the given week, aggregates earnings per
   user, sorts, applies the 20/15/10/55 formula, and returns an
   array of `{ rank, userId, expectedAmount }`.

2. **Load actual state.** Query `prize_payouts` for the same week:

   ```sql
   SELECT rank, user_id, amount
   FROM prize_payouts
   WHERE week_bucket = $1
   ORDER BY rank;
   ```

3. **Diff the two.** Compare by `(rank, userId)`. Report:

   - Rows present in expected but missing in actual → **missed payouts**.
   - Rows present in actual but missing in expected → **phantom payouts**.
   - Rows present in both with different `amount` → **mis-paid amounts**.
   - Rows present in both with matching `amount` → ✅ correct.

4. **Report financial impact.** Sum the delta across all
   discrepancies. Report as BigInt in the smallest currency unit.

5. **Output format.** Markdown table with columns:
   `Rank | UserID | Expected | Actual | Delta | Status`

   Followed by a summary:
   ```
   Week: 2026-W18
   Total distributed (expected): 12,500,000
   Total distributed (actual):   12,499,800
   Net discrepancy: -200
   Affected users: 2
   Status: ⚠️ INCIDENT
   ```

## Rules

- This is a read-only operation. Never write to `prize_payouts`
  from this skill. Corrective actions require a separate,
  manually-invoked reconciliation script.
- Always use BigInt arithmetic. No floats.
- If `calculateDistribution()` throws, surface the error verbatim;
  do not swallow.
- Confirm the week exists in `weekly_pools` table before running —
  abort if the week hasn't been finalised yet (it's mid-week).

## When to use

- After any production cron failure alert.
- As a scheduled sanity check (weekly, Monday morning).
- During the code review of any change to
  `src/services/distribution/`.
- In the live demo video to show audit capability.
