import { sql } from 'drizzle-orm'
import type { Redis } from 'ioredis'
import type { Database } from '../db/postgres.ts'

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
 * of the cache. This is a read-through pattern; `/rebuild-redis`
 * remains the bulk-recovery tool for when the entire sortedset is
 * gone, but for an isolated key eviction the cache self-heals.
 *
 * The PG query clamps the result to >= 0 because correction events
 * with negative amounts could in principle drag a week's net total
 * below zero; the live UI should never show a negative pool.
 *
 * Returns 0n for an empty week.
 */
export async function getCurrentPool(redis: Redis, db: Database, isoWeek: string): Promise<bigint> {
  try {
    const cached = await redis.get(`pool:week:${isoWeek}`)
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

  // Lazy backfill — best-effort. If Redis is still down we silently
  // give up and PG remains correct.
  try {
    await redis.set(`pool:week:${isoWeek}`, pool.toString())
  } catch {
    // ignore
  }

  return pool
}
