/**
 * Redis key registry — single source of truth for the prefixes we
 * own. The leaderboard sortedset key, the live pool counter key,
 * and (in future) the distribution lock key all live here so a
 * prefix change is a one-file edit.
 *
 * Drift between an inline `\`pool:week:${isoWeek}\`` template in one
 * module and a constant in another is a real risk class — every
 * caller has to mirror the format exactly or reads/writes silently
 * miss each other. The cure is mechanical: helper-only access via
 * named exports.
 *
 * Distribution lock key (`lock:distribution:week:`) is owned by
 * `distribution-lock.ts` for now because the lock module also wraps
 * the SETNX/release Lua semantics; if a third caller appears it
 * should move here.
 */

export const LEADERBOARD_KEY_PREFIX = 'lb:week:'
export const POOL_KEY_PREFIX = 'pool:week:'

export function leaderboardKey(isoWeek: string): string {
  return `${LEADERBOARD_KEY_PREFIX}${isoWeek}`
}

export function poolKey(isoWeek: string): string {
  return `${POOL_KEY_PREFIX}${isoWeek}`
}
