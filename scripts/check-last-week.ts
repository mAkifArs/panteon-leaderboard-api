/**
 * Watchdog for the weekly prize-distribution cron (ADR-011).
 *
 * The distribution job (`scripts/distribute.ts` / `weekly-distribution.yml`)
 * exits non-zero on its own crashes — GH Actions emails the failure
 * automatically in that case. What it CAN'T tell us: silent failure
 * modes where exit was 0 but the work didn't land. Four scenarios:
 *
 *   1. The job ran, exited 0, but a runtime bug left
 *      `weekly_pools.status` at 'open' (lock acquired, transaction
 *      not committed, exit 0 anyway).
 *   2. The cron didn't fire at all (GH Actions outage / queue miss).
 *   3. The runner was killed mid-run (timeout, free-tier minute cap).
 *   4. The job ran but crashed mid-distribution → status stuck in
 *      'distributing' (the exact ADR-003 manual-recovery scenario).
 *
 * All four collapse to the same query: did the previous ISO week's
 * `weekly_pools` row reach status='distributed'? If not, the
 * watchdog exits non-zero and GH Actions sends the standard
 * failure email — the same notification path operators already
 * watch for distribution failures.
 *
 * Read-only single SELECT, no transaction, no Redis, no Mongo.
 * Uses the same `previousIsoWeek` helper as the distribution
 * script so the two cron jobs share one definition of "the week
 * that just closed".
 *
 * Usage:
 *   bun run check:last-week              # previous ISO week (default)
 *   bun run check:last-week 2026-W17     # explicit week (forensic)
 *
 * Exit codes:
 *   0 — OK (status === 'distributed')
 *   1 — watchdog tripped (row missing / status open / status distributing)
 *   2 — invalid argv format (matches scripts/distribute.ts convention)
 */
import { closePostgres, getPostgres } from '../src/db/postgres.ts'
import { previousIsoWeek } from '../src/lib/iso-week.ts'

async function main(): Promise<void> {
  const isoWeek = process.argv[2] ?? previousIsoWeek(new Date())
  if (!/^\d{4}-W\d{2}$/.test(isoWeek)) {
    console.error(`[watchdog] invalid iso week: ${isoWeek} (expected YYYY-WXX)`)
    process.exit(2)
  }

  const { pool } = getPostgres()

  try {
    const rows = await pool<{ status: string }[]>`
      SELECT status FROM weekly_pools WHERE iso_week = ${isoWeek}
    `

    if (rows.length === 0) {
      console.error(`[watchdog] FAIL ${isoWeek}: no weekly_pools row — distribution did not run`)
      process.exit(1)
    }

    const status = rows[0]!.status
    if (status === 'distributed') {
      console.log(`[watchdog] OK ${isoWeek}: status=distributed`)
      process.exit(0)
    }
    if (status === 'distributing') {
      console.error(
        `[watchdog] FAIL ${isoWeek}: status=distributing — mid-run crash, manual recovery required (see ADR-003 + /replay-week skill)`,
      )
      process.exit(1)
    }
    if (status === 'open') {
      console.error(
        `[watchdog] FAIL ${isoWeek}: status=open — distribution did not claim the week`,
      )
      process.exit(1)
    }
    // Unknown status — treat as failure rather than swallowing.
    console.error(`[watchdog] FAIL ${isoWeek}: unexpected status=${status}`)
    process.exit(1)
  } finally {
    await closePostgres()
  }
}

main().catch((err: unknown) => {
  console.error('[watchdog] failed:', err)
  process.exit(1)
})
