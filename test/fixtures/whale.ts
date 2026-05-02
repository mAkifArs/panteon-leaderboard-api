/**
 * Shared whale-amount fixtures for tests that need to exercise
 * the IEEE-754 boundary in the Redis sortedset score path.
 *
 * Three different bug commits (`d840707`, `6f262ac`, Bug 3) each
 * landed with their own ad-hoc whale fixture. Centralising the
 * magic numbers here means any future shift of the boundary
 * (e.g. PG BIGINT → NUMERIC) changes one file, and every test
 * that "uses a whale" speaks the same number.
 */

/**
 * Single deliberately whale-sized amount, far past 2^53. Picked
 * so the 2% pool contribution lands at exactly 10^17 + 1, which
 * is the value that exposed the JS Number cast in commit 6f262ac.
 */
export const WHALE_AMOUNT = 5_000_000_000_000_000_050n

/**
 * The pool contribution that follows from a single WHALE_AMOUNT
 * earning. Useful for asserting on /leaderboard/* meta.pool.
 */
export const WHALE_POOL_CONTRIBUTION = (WHALE_AMOUNT * 2n) / 100n

/**
 * 2^53 + 1 — the smallest BigInt that loses precision when cast
 * via JS Number. Useful for tests that want a "boundary" rather
 * than a "deep whale" assertion.
 */
export const WHALE_AMOUNT_NEAR_BOUNDARY = 9_007_199_254_740_993n

/**
 * What Redis serialises a 5e+18 sortedset score back to. Locked
 * here so we can assert on raw ZSCORE behaviour in real-Redis
 * integration tests without re-deriving it.
 */
export const WHALE_REDIS_SCORE_SCIENTIFIC = '5e+18'
