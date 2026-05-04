import { sql } from 'drizzle-orm'
import type { Redis } from 'ioredis'
import pino from 'pino'
import type { Database } from '../db/postgres.ts'
import { poolKey } from './redis-keys.ts'

const log = pino({ name: 'pool' })

/**
 * Read the current weekly pool amount.
 *
 * Source of truth is Postgres (sum of earning_events.amount * 2%).
 * Redis holds a live counter that is updated on every earning event;
 * we read from there first because it's a single GET, then fall
 * back to PG if Redis is missing the key (cold start, eviction, or
 * a Redis wipe before /rebuild-redis ran).
 *
 * On a cache miss we re-populate Redis from the PG result before
 * returning. Without this lazy backfill every subsequent read on
 * the same week would also miss and hit PG — defeating the point
 * of the cache. The backfill uses **SET NX** so a parallel
 * `recordEarning` INCRBY that landed between our miss and our
 * write is not clobbered: NX makes the SET a no-op if the key
 * already exists, and the INCRBY value is the correct one to keep.
 * `/rebuild-redis` remains the bulk-recovery tool for when the
 * entire sortedset is gone; for an isolated key eviction the cache
 * self-heals here.
 *
 * The PG query clamps the result to >= 0 because correction events
 * with negative amounts could in principle drag a week's net total
 * below zero; the live UI should never show a negative pool.
 *
 * Returns 0n for an empty week.
 */
export async function getCurrentPool(redis: Redis, db: Database, isoWeek: string): Promise<bigint> {
  const key = poolKey(isoWeek)
  try {
    const cached = await redis.get(key)
    if (cached !== null) {
      return BigInt(cached)
    }
  } catch (err) {
    // Redis transient failure — log so a cluster of these is
    // visible in operator dashboards, then fall through to PG.
    log.warn({ err, isoWeek }, 'redis GET failed; falling through to PG')
  }

  // SUM(bigint) returns numeric in PG; dividing by 100 inside SQL
  // adds default decimal scale (e.g. "4.0000000000000000"), which
  // BigInt() rejects. We pull the bigint sum out as a clean integer
  // string and do the 2% math in JS BigInt — same shape as
  // distribution.ts so the two paths can never drift apart on the
  // canonical pool formula.
  const rows = await db.execute<{ total_earnings: string | null }>(sql`
    SELECT COALESCE(SUM(amount), 0)::text AS total_earnings
    FROM earning_events
    WHERE iso_week = ${isoWeek}
  `)
  const totalEarnings = BigInt(rows[0]?.total_earnings ?? '0')
  const pool = totalEarnings > 0n ? (totalEarnings * 2n) / 100n : 0n

  // Lazy backfill — best-effort + SET NX. If Redis is still down we
  // log and give up; if a parallel recordEarning INCRBY beat us to
  // it, NX preserves that value (it is the correct one).
  try {
    await redis.set(key, pool.toString(), 'NX')
  } catch (err) {
    log.warn({ err, isoWeek }, 'redis SET NX backfill failed; PG remains correct')
  }

  return pool
}
