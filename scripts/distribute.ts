/**
 * Run the weekly prize distribution for a given ISO week.
 *
 * Usage:
 *   bun run db:distribute              # previous ISO week (the Mon-Sun
 *                                      # that just closed Sunday 23:59 UTC)
 *   bun run db:distribute 2026-W17     # explicit week (forensic re-run)
 *
 * The cron fires Monday 00:05 UTC and operates on the week that just
 * closed, not the five-minute-old new week — see commit 3ac2bb7 for
 * the bug that motivated `previousIsoWeek` and the regression test
 * in `src/lib/__tests__/iso-week.test.ts`.
 *
 * Idempotent: a second run on the same week returns "skipped"
 * (already-distributed). Wired to a real cron in production via
 * `.github/workflows/weekly-distribution.yml`; the watchdog
 * (ADR-011) confirms the run actually finished one hour later.
 */
import { closeMongo, getMongo } from '../src/db/mongo.ts'
import { closePostgres, getPostgres } from '../src/db/postgres.ts'
import { closeRedis, getRedis } from '../src/db/redis.ts'
import { previousIsoWeek } from '../src/lib/iso-week.ts'
import { runWeeklyDistribution } from '../src/services/distribution.ts'

async function main(): Promise<void> {
  // Default target is the week that JUST CLOSED, not the one in
  // progress. The cron fires Mon 00:05 UTC and is supposed to pay
  // out for the previous Mon-Sun. argv[2] override remains
  // available for forensic re-runs (workflow_dispatch).
  const isoWeek = process.argv[2] ?? previousIsoWeek(new Date())
  if (!/^\d{4}-W\d{2}$/.test(isoWeek)) {
    console.error(`[distribute] invalid iso week: ${isoWeek} (expected YYYY-WXX)`)
    process.exit(2)
  }

  const { db } = getPostgres()
  const redis = getRedis()
  const { db: mongoDb } = getMongo()

  console.log(`[distribute] running for ${isoWeek}`)
  const result = await runWeeklyDistribution({
    isoWeek,
    db,
    redis,
    mongo: mongoDb,
  })

  if (result.status === 'distributed') {
    console.log(`[distribute] status=distributed runId=${result.runId}`)
    console.log(`[distribute] totalPool=${result.totalPool.toString()}`)
    console.log(`[distribute] payouts=${String(result.payouts.length)}`)
  } else {
    console.log(`[distribute] status=skipped reason=${result.reason}`)
  }

  await Promise.all([closePostgres(), closeRedis(), closeMongo()])
}

main().catch((err: unknown) => {
  console.error('[distribute] failed:', err)
  process.exit(1)
})
