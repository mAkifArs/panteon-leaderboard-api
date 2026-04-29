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
 * Returns 0n for an empty week.
 */
export async function getCurrentPool(
  redis: Redis,
  db: Database,
  isoWeek: string,
): Promise<bigint> {
  try {
    const cached = await redis.get(`pool:week:${isoWeek}`)
    if (cached !== null) {
      return BigInt(cached)
    }
  } catch {
    // Fall through to PG.
  }

  const rows = await db.execute<{ pool: string | null }>(sql`
    SELECT (COALESCE(SUM(amount), 0) * 2 / 100)::text AS pool
    FROM earning_events
    WHERE iso_week = ${isoWeek}
  `)
  return BigInt(rows[0]?.pool ?? '0')
}
