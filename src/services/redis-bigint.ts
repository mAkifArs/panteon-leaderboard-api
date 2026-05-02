/**
 * Redis ↔ BigInt sortedset I/O — single source of truth.
 *
 * **Why this module exists.** The leaderboard sortedset score is an
 * IEEE-754 double by Redis spec; the rest of the codebase carries
 * money as BigInt (CLAUDE.md invariant 1). Crossing that boundary
 * the wrong way has historically produced HTTP 500s in production:
 *
 *   - commit `d840707` — `BigInt(scoreStr)` crashed on whale scores
 *     that Redis serialises as scientific notation (e.g. "5e+18").
 *     `/leaderboard/top` returned 500.
 *   - commit `6f262ac` — `redis.incrby(key, Number(contribution))`
 *     silently lost precision past 2^53 because the JS Number cast
 *     happened *before* the wire.
 *   - Bug 3 (this refactor) — `getSampleUsers` had its own inline
 *     `BigInt(reply[1]!)` parse that bypassed the existing helper.
 *
 * Each fix was a spot-fix in one callsite. The pattern kept
 * reappearing because the helper was private to leaderboard.ts and
 * sister modules reinvented the wrong thing. This module makes the
 * helpers public, names both directions, and is paired with an
 * ESLint `no-restricted-syntax` guard (eslint.config.js) that bans
 * the inline anti-patterns in the four files that touch this
 * boundary.
 *
 * **Sub-coin drift past 2^53 is documented and tolerated** in this
 * layer (see leaderboard.ts module header + ADR-001). Cron payouts
 * always re-materialise the canonical ranking from Postgres before
 * any money moves, so float drift on the live view can never affect
 * payouts. The helpers below preserve that invariant — they don't
 * try to make Redis precise, they just remove the *JS-side*
 * precision cliff that happens before the Redis wire.
 */

/**
 * Convert a Redis sorted-set score (always serialised as a decimal
 * or scientific-notation double, e.g. "1000", "5e+18", "12345.5")
 * to a BigInt.
 *
 * `BigInt(scoreStr)` would crash on scientific notation — that was
 * Bug 1 (commit d840707) and Bug 3. We round through Number first,
 * which Redis's textual representation always round-trips into.
 * The Math.round is the explicit acknowledgement that we're
 * accepting sub-coin drift; the score was already a double on the
 * wire, no precision is being lost here that wasn't already gone.
 */
export function redisScoreToBigInt(scoreStr: string): bigint {
  return BigInt(Math.round(Number(scoreStr)))
}

/**
 * Convert a BigInt money amount to the string form ioredis accepts
 * for ZADD / ZINCRBY score arguments (and for sorted-set member
 * pairs in pipelines).
 *
 * ioredis serialises numeric arguments via its own `.toString()`
 * before sending — so passing a `Number` first triggers a JS-side
 * cast that loses precision past 2^53 (that was Bug 2, commit
 * 6f262ac, on the pool counter). The Redis server still stores
 * sortedset scores as IEEE-754 doubles, so the value past 2^53
 * will round on the *server* side regardless. The point of this
 * helper is to keep the JS Number cast out of the path entirely:
 * one rounding step, on the Redis side, where we documented it,
 * instead of two (JS Number + Redis double) where the first one
 * is silent.
 *
 * For the pool counter, which is a normal Redis STRING (not a
 * sortedset score), the same string-argument trick lets Redis use
 * its native 64-bit integer arithmetic — there's no rounding at
 * all in that path. See earnings.ts for that callsite.
 */
export function bigIntToRedisScore(amount: bigint): string {
  return amount.toString()
}
