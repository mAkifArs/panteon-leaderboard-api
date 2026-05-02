import assert from 'node:assert'
import IORedisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bigIntToRedisScore, redisScoreToBigInt } from '../redis-bigint.ts'

/**
 * Contract tests for the Redis ↔ BigInt sortedset helpers. These
 * lock the parse rules behind the named API so that future inline
 * `BigInt(<redisString>)` or `Number(<bigint>)` regressions are
 * caught here (and also rejected by the ESLint guard in
 * eslint.config.js).
 */

describe('redisScoreToBigInt', () => {
  it('parses a plain decimal score', () => {
    expect(redisScoreToBigInt('1000')).toBe(1000n)
  })

  it('parses scientific notation (Bug 1, Bug 3 regression)', () => {
    // Redis serialises sortedset scores past 2^53 in scientific form.
    // BigInt('5e+18') would throw SyntaxError.
    expect(redisScoreToBigInt('5e+18')).toBe(5_000_000_000_000_000_000n)
  })

  it('rounds float artefacts to the nearest integer', () => {
    // ZINCRBY of two integers can produce a Redis-side float artefact
    // (e.g. cumulative drift). The helper's Math.round is the explicit
    // acknowledgement that sub-coin drift is tolerated in this layer.
    expect(redisScoreToBigInt('12345.5')).toBe(12346n)
    expect(redisScoreToBigInt('12345.4')).toBe(12345n)
  })

  it('handles zero and negative scores', () => {
    expect(redisScoreToBigInt('0')).toBe(0n)
    expect(redisScoreToBigInt('-100')).toBe(-100n)
  })
})

describe('bigIntToRedisScore', () => {
  it('emits the decimal string form', () => {
    expect(bigIntToRedisScore(1000n)).toBe('1000')
    expect(bigIntToRedisScore(0n)).toBe('0')
  })

  it('preserves precision past 2^53 on the JS side (Bug 2 guard)', () => {
    // The whole point: do NOT pass through Number() on the way out.
    // The Redis server will still float-round this on storage, but
    // the JS-side string is exact.
    const whale = 5_000_000_000_000_000_050n
    expect(bigIntToRedisScore(whale)).toBe('5000000000000000050')
  })
})

describe('Redis round-trip via the helpers', () => {
  let redis: Redis

  beforeEach(async () => {
    redis = new IORedisMock()
    await redis.flushall()
  })

  afterEach(() => {
    redis.disconnect()
  })

  it('small integer round-trips exactly', async () => {
    await redis.zadd('lb', bigIntToRedisScore(1234n), 'u1')
    const raw = await redis.zscore('lb', 'u1')
    assert(raw !== null, 'ZSCORE must return the score we just wrote')
    expect(redisScoreToBigInt(raw)).toBe(1234n)
  })

  it('whale round-trips without throwing (sub-coin drift tolerated)', async () => {
    // ioredis-mock does ZSET arithmetic in JS Number, so the score
    // we read back may be a rounded approximation — the *contract*
    // we lock here is "no exception, BigInt-typed result close to
    // the input." Real-Redis behaviour (scientific-notation string
    // form) is exercised by the cross-layer integration test in
    // src/__tests__/whale-end-to-end.integration.test.ts.
    const whale = 5_000_000_000_000_000_050n
    await redis.zadd('lb', bigIntToRedisScore(whale), 'whale')
    const raw = await redis.zscore('lb', 'whale')
    assert(raw !== null, 'ZSCORE must return the score we just wrote')
    const parsed = redisScoreToBigInt(raw)
    // Drift bound: a few thousand of the smallest currency unit is
    // the documented upper bound for the in-week UI view (the cron
    // re-derives the canonical ranking from PG before any payout).
    const drift = parsed > whale ? parsed - whale : whale - parsed
    expect(drift).toBeLessThan(1_000_000n)
  })
})
