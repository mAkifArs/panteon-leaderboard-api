import { sql } from 'drizzle-orm'
import type { Redis } from 'ioredis'
import type { Database } from '../db/postgres.ts'
import { poolKey } from './redis-keys.ts'

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
  } catch {
    // Fall through to PG.
  }

  const rows = await db.execute<{ pool: string | null }>(sql`
    SELECT GREATEST(COALESCE(SUM(amount), 0) * 2 / 100, 0)::text AS pool
    FROM earning_events
    WHERE iso_week = ${isoWeek}
  `)
  const pool = BigInt(rows[0]?.pool ?? '0')

  // Lazy backfill — best-effort + SET NX. If Redis is still down we
  // silently give up; if a parallel recordEarning INCRBY beat us to
  // it, NX preserves that value (it is the correct one).
  try {
    await redis.set(key, pool.toString(), 'NX')
  } catch {
    // ignore
  }

  return pool
}
