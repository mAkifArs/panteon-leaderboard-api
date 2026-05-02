/**
 * Run the weekly prize distribution for a given ISO week.
 *
 * Usage:
 *   bun run db:distribute              # current week
 *   bun run db:distribute 2026-W17     # specific week
 *
 * Idempotent: a second run on the same week returns "skipped"
 * (already-distributed). Safe to wire to a real cron in
 * production; in deployment we will wrap this in a cron job
 * (e.g. Fly.io machine cron or external GitHub Action) that
 * fires every Monday 00:05 UTC.
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
