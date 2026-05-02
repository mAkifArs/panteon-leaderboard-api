import type { Redis } from 'ioredis'

/**
 * Distributed lock via Redis SETNX + TTL.
 *
 * Used by the prize-distribution cron to ensure only one API
 * instance runs the weekly payout, even when the deployment is
 * horizontally scaled. Without this lock, N instances would each
 * fire `node-cron` and try to distribute the same week N times.
 * The DB-level UNIQUE constraints on `prize_payouts` are the
 * final fail-safe (CLAUDE.md invariant + ADR-003), but we still
 * want the lock so we never *attempt* concurrent distributions
 * and pollute logs / wake on-call.
 *
 * Each acquire is tagged with a `runId` (UUID) so the holder is
 * known. Release is atomic via a Lua script: only delete the key
 * if its value still equals the holder's runId. This prevents
 * the classic bug where holder A's call to RELEASE arrives after
 * its own TTL expired and holder B already grabbed the lock —
 * without the runId check, A would unlock B's lock.
 *
 * The TTL is the safety net for crashes: if the holder dies
 * mid-distribution, the lock auto-releases after `ttlMs` and the
 * next cron tick can take over. Set TTL ≥ longest reasonable
 * distribution duration (default 10 minutes is generous; payouts
 * for top-100 take seconds).
 */

export const DISTRIBUTION_LOCK_PREFIX = 'lock:distribution:week:'

export function distributionLockKey(isoWeek: string): string {
  return `${DISTRIBUTION_LOCK_PREFIX}${isoWeek}`
}

export interface AcquiredLock {
  key: string
  runId: string
}

/**
 * Try to acquire the distribution lock for a given ISO week.
 * Returns the lock handle on success, or `null` if another
 * holder is already in flight.
 *
 * `runId` should be unique per cron invocation — the same UUID
 * passed to the audit row in Mongo (`prize_distributions._id`).
 */
export async function acquireDistributionLock(
  redis: Redis,
  isoWeek: string,
  runId: string,
  ttlMs: number,
): Promise<AcquiredLock | null> {
  const key = distributionLockKey(isoWeek)
  // SET key value NX PX ttlMs — atomic "acquire only if absent".
  const reply = await redis.set(key, runId, 'PX', ttlMs, 'NX')
  return reply === 'OK' ? { key, runId } : null
}

/**
 * Release a previously-acquired lock. Atomic check-and-delete:
 * only removes the key if its value still equals our runId.
 *
 * Returns true if we held it and released, false if it was no
 * longer ours (TTL expired or someone else grabbed it).
 */
const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`

export async function releaseDistributionLock(redis: Redis, lock: AcquiredLock): Promise<boolean> {
  const result = (await redis.eval(RELEASE_SCRIPT, 1, lock.key, lock.runId)) as number
  return result === 1
}

/**
 * Convenience wrapper: acquire → run callback → release.
 * Skips the callback (and returns null) if the lock is held by
 * someone else. Callback exceptions still trigger release.
 */
export async function withDistributionLock<T>(
  redis: Redis,
  isoWeek: string,
  runId: string,
  ttlMs: number,
  fn: (lock: AcquiredLock) => Promise<T>,
): Promise<T | null> {
  const lock = await acquireDistributionLock(redis, isoWeek, runId, ttlMs)
  if (!lock) return null
  try {
    return await fn(lock)
  } finally {
    await releaseDistributionLock(redis, lock)
  }
}
