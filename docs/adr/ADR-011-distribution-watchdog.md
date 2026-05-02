# ADR-011: Distribution watchdog as a separate scheduled job

- **Status:** Accepted
- **Date:** 2026-05-03
- **Deciders:** Mehmet Akif Arslan
- **Tags:** #ops #cron #monitoring #money-safety

## Context

ADR-003 deliberately leaves mid-distribution crash recovery as a
**manual** operator action: silent auto-retry can mask money bugs,
and the four-layer constraint stack (Redis lock + PG status CAS +
two `prize_payouts` UNIQUE constraints) makes "stop and inspect"
the safe default. That decision still stands.

What ADR-003 does not address is **how the operator finds out
something is wrong** in the first place. The distribution
workflow (`weekly-distribution.yml`) relies on GitHub Actions'
built-in failure email — but that email only fires when the job
exits non-zero. There are at least four scenarios where the
distribution work doesn't land but the workflow exits clean (or
doesn't run at all):

1. **Silent runtime exit-zero bug.** The job runs, the script
   acquires the Redis lock and starts the PG transaction, then
   crashes before commit. If the crash path is caught and `process`
   exits 0 anyway (e.g. an unhandled rejection treated as warning,
   or a wrapper script that swallows status), `weekly_pools.status`
   stays `'open'` and no email goes out.
2. **GitHub Actions cron miss.** The schedule entry didn't fire
   — actions/runner outage, region degradation, or just queue
   eviction (the cron schedule is best-effort on the free tier).
3. **Runner killed mid-run.** Free-tier minute cap hit, OOM,
   `timeout-minutes` exceeded. The runner is killed; the workflow
   shows "failed" but if the kill happened *after* the PG
   transaction committed, status is fine — and if it happened
   before, status is stuck. Either way, no signal in the body of
   the email beyond "the job died".
4. **Mid-distribution crash → status stuck in `'distributing'`.**
   The exact ADR-003 scenario. The job exited non-zero (so an
   email did go out), but the email says "exit code 1, see logs".
   The operator has to dig to learn that the actionable state is
   `weekly_pools.status = 'distributing'` and that `/replay-week`
   is the recovery tool.

In all four cases the answer to "did the previous ISO week reach
`status = 'distributed'`?" is *no*. A second cron, asking exactly
that question one hour after distribution, closes the
notification gap without changing ADR-003's recovery semantics.

## Decision

A new GitHub Actions workflow,
`weekly-distribution-watchdog.yml`, runs every **Monday 01:05
UTC** — one hour after `weekly-distribution.yml`. It executes a
new script, `scripts/check-last-week.ts`, that:

- Computes the target ISO week as `previousIsoWeek(new Date())`,
  the same helper distribution itself uses (commit `3ac2bb7`).
  An optional argv override remains for forensic checks via
  `workflow_dispatch`.
- Issues a single read-only SELECT against Postgres:
  `SELECT status FROM weekly_pools WHERE iso_week = $1`.
- Branches:
  - `status === 'distributed'` → exit 0, OK message.
  - `status === 'distributing'` → exit 1, message names ADR-003
    + `/replay-week` so the operator knows the recovery path.
  - `status === 'open'` → exit 1, distribution did not claim the
    week (CAS rejection or never ran).
  - row missing → exit 1, distribution did not run at all.
  - any other status → exit 1, "unexpected status".

Non-zero exit triggers GitHub Actions' built-in failure email —
the same channel operators already watch. No third-party
service, no PagerDuty/Slack integration in this scope.

The watchdog is intentionally **separate** from the distribution
workflow (no `needs:` chaining) so it still runs when distribution
fails to start. Its only secret is `DATABASE_URL`; it never
touches Redis or Mongo.

## Consequences

### Positive

- **Closes the silent-failure notification gap** for all four
  scenarios above with one read-only query per week.
- **Self-contained.** No new infrastructure, no third-party SaaS,
  no extra cost on top of GitHub Actions' free tier (~10 seconds
  of runner time per week).
- **Operator-friendly error messages.** When the watchdog trips
  on a `'distributing'`-stuck row, the failure email body names
  the recovery procedure (`/replay-week` skill, ADR-003) directly,
  cutting the "find the runbook" step.
- **Minimum secret surface.** Only `DATABASE_URL` is exposed to
  the watchdog workflow. Read-only query, no money mutation
  surface added.
- **Shared semantics with distribution.** Both jobs use
  `previousIsoWeek(now)`; if that helper changes (DST policy
  shift, week-numbering tweak), both update together — no drift.

### Negative

- **False positive on Postgres outage at 01:05 UTC.** A degraded
  PG would trip the watchdog even when distribution succeeded.
  Trade-off: false negative (silent payout delay, players unpaid,
  customer-support tickets) costs more than false positive
  (operator checks PG once and confirms green). Acceptable.
- **Free-tier queue gecikmesi false alarm risk.** Distribution
  has a 15-minute timeout; watchdog fires 60 minutes later. If
  GitHub Actions queue gecikmesi exceeds ~55 minutes (rare on
  free tier but documented), the watchdog would fire while
  distribution is still pending. Mitigation: push watchdog to
  02:05 UTC if observed. Today, 1 h is the right balance.
- **Duplicate `DATABASE_URL` secret reference.** Two workflows
  now consume the same secret; secret rotation requires noting
  both. Acceptable — the rotation procedure is "update the
  repository secret" once, both workflows pick up the new value.
- **No automated test for the script itself.** The script is
  ~50 lines: argv parse, single SELECT, four-branch switch.
  Test coverage would require a real-PG integration test that
  seeds each `weekly_pools.status` value and asserts on
  `process.exitCode` — high boilerplate, low signal versus the
  manual smoke at install time:
  ```
  bun run check:last-week 2026-W17    # exit 0 on a distributed week
  bun run check:last-week 2099-W01    # exit 1 on a missing row
  ```
  This trade-off is conscious; revisit if the script grows
  branches beyond the four state-machine states.

### Neutral

- Watchdog **does not** verify `prize_payouts` count. A no-earnings
  week legitimately distributes 0 payouts and marks itself
  `distributed`; adding "payouts > 0" would false-trip on those
  weeks. The status enum is the authoritative completion signal.

## Alternatives Considered

### Alternative A: PagerDuty / Slack webhook integration

Distribution sends a "done" ping; absence of the ping pages the
oncall. Industry standard, richer routing.

Rejected: third-party dependency outside the case scope; the
GitHub Actions email + the operator's existing inbox already
provides the same notification channel for distribution failures.
A future migration to PagerDuty/Slack is a one-day swap; the
watchdog's semantic check is the load-bearing part, not the
delivery channel.

### Alternative B: Healthcheck.io ping (or equivalent dead-man-switch)

Distribution `curl`s a known URL on success; the SaaS pages the
operator if the ping doesn't arrive within a window.

Rejected for the same reason as A — third-party SaaS in scope —
plus: scenario 1 (silent exit-zero) would still trigger the
healthcheck ping (the script *did* exit 0), so the dead-man-switch
wouldn't catch the bug class we most care about. The watchdog's
state-machine query catches it; a heartbeat ping doesn't.

### Alternative C: Distribution job verifies its own success

After `runWeeklyDistribution`, the script re-reads
`weekly_pools.status` and exits non-zero if not `'distributed'`.

Rejected: scenario 3 (runner kill) and scenario 2 (cron miss)
both prevent the script from reaching the verify step at all.
Self-verification cannot catch failures of the runner or the
scheduler that hosts it.

### Alternative D: Chain watchdog to distribution via `needs:`

`watchdog` job depends on `distribute` job in a single workflow;
GitHub runs them in order.

Rejected: if distribution fails to start (cron miss) or fails
hard (exit non-zero), the chained job never runs — exactly the
scenarios the watchdog should catch. The watchdog must be
independently scheduled.

### Alternative E: Watchdog also checks `prize_payouts` row count

`SELECT count(*) FROM prize_payouts WHERE iso_week = $1 > 0`.

Rejected: a no-earnings week is legitimately distributed with
zero payouts. Adding the count check would false-trip on every
quiet week. The status enum is already the source of truth
for "did this complete?".

## Revisit triggers

- The deployment moves to PagerDuty / Slack / a paid alerting
  pipeline → re-route the watchdog there (the SELECT logic stays;
  the delivery channel changes).
- The `weekly_pools.status` enum gains or loses values → update
  the four-branch switch in `scripts/check-last-week.ts`.
- The distribution timing changes (e.g. mid-week refresh, multiple
  payouts per week) → revisit the cron interval and the "previous
  week" semantics.
- Observed false positives (PG flapping at 01:05 UTC, watchdog
  tripping when distribution actually succeeded) → push schedule
  to 02:05 UTC, or add a thin retry loop with backoff in the
  script.

## AI involvement

The four silent-failure scenarios were enumerated by Claude after
the user asked about distribution observability. The choice
between separate workflow vs `needs:` chaining was settled by
naming scenarios 2 and 3 explicitly (cron miss / runner kill) —
without that, chained execution looked tempting on simplicity
grounds. The "no self-test for the script" trade-off is the
user's call; Claude flagged it explicitly so it's an informed
omission rather than a forgotten one.

## References

- ADR-003 — distributed lock + manual recovery decision; this
  ADR adds notification, not recovery automation.
- `scripts/check-last-week.ts` — the script.
- `.github/workflows/weekly-distribution-watchdog.yml` — the
  scheduled trigger.
- `src/lib/iso-week.ts` — `previousIsoWeek`, shared with
  distribution (commit `3ac2bb7`).
- `src/db/schema.ts` — `weekly_pools.status` enum that the
  watchdog branches on.
