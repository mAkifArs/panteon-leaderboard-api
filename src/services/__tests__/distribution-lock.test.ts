import IORedisMock from 'ioredis-mock'
import type { Redis } from 'ioredis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  acquireDistributionLock,
  distributionLockKey,
  releaseDistributionLock,
  withDistributionLock,
} from '../distribution-lock.ts'

let redis: Redis

beforeEach(async () => {
  redis = new IORedisMock()
  // ioredis-mock shares one in-memory store across all instances
  // by default — wipe it between tests to keep them isolated.
  await redis.flushall()
})

afterEach(() => {
  redis.disconnect()
})

const ISO_WEEK = '2026-W17'

describe('distributionLockKey', () => {
  it('uses the lock:distribution:week: prefix', () => {
    expect(distributionLockKey('2026-W17')).toBe('lock:distribution:week:2026-W17')
  })
})

describe('acquireDistributionLock', () => {
  it('succeeds when the key is absent', async () => {
    const lock = await acquireDistributionLock(redis, ISO_WEEK, 'run-1', 10_000)
    expect(lock).toEqual({ key: 'lock:distribution:week:2026-W17', runId: 'run-1' })
  })

  it('fails when another holder already has the lock', async () => {
    const first = await acquireDistributionLock(redis, ISO_WEEK, 'run-1', 10_000)
    const second = await acquireDistributionLock(redis, ISO_WEEK, 'run-2', 10_000)
    expect(first).not.toBeNull()
    expect(second).toBeNull()
  })

  it('sets the TTL so the lock auto-expires on holder crash', async () => {
    await acquireDistributionLock(redis, ISO_WEEK, 'run-1', 10_000)
    const ttl = await redis.pttl(distributionLockKey(ISO_WEEK))
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(10_000)
  })
})

describe('releaseDistributionLock', () => {
  it('releases when called by the holder', async () => {
    const lock = await acquireDistributionLock(redis, ISO_WEEK, 'run-1', 10_000)
    expect(lock).not.toBeNull()
    const released = await releaseDistributionLock(redis, lock!)
    expect(released).toBe(true)
    // After release, a new acquire should succeed.
    const next = await acquireDistributionLock(redis, ISO_WEEK, 'run-2', 10_000)
    expect(next).not.toBeNull()
  })

  it('does NOT release if the runId does not match (lost-lock scenario)', async () => {
    // Holder A acquires.
    await acquireDistributionLock(redis, ISO_WEEK, 'run-A', 10_000)
    // Simulate A's TTL expiring and B grabbing it.
    await redis.del(distributionLockKey(ISO_WEEK))
    const lockB = await acquireDistributionLock(redis, ISO_WEEK, 'run-B', 10_000)
    expect(lockB).not.toBeNull()

    // Now A's late-arriving release attempt — must NOT delete B's lock.
    const releasedByA = await releaseDistributionLock(redis, {
      key: distributionLockKey(ISO_WEEK),
      runId: 'run-A',
    })
    expect(releasedByA).toBe(false)

    // B's lock is still in place.
    const value = await redis.get(distributionLockKey(ISO_WEEK))
    expect(value).toBe('run-B')
  })

  it('returns false when the lock has already expired or been released', async () => {
    const released = await releaseDistributionLock(redis, {
      key: distributionLockKey(ISO_WEEK),
      runId: 'run-ghost',
    })
    expect(released).toBe(false)
  })
})

describe('withDistributionLock', () => {
  it('runs the callback and releases on success', async () => {
    let ran = false
    const result = await withDistributionLock(redis, ISO_WEEK, 'run-1', 10_000, () => {
      ran = true
      return Promise.resolve(42)
    })
    expect(ran).toBe(true)
    expect(result).toBe(42)
    // Lock released — a new acquire must succeed.
    const next = await acquireDistributionLock(redis, ISO_WEEK, 'run-2', 10_000)
    expect(next).not.toBeNull()
  })

  it('skips the callback when the lock is held by someone else', async () => {
    await acquireDistributionLock(redis, ISO_WEEK, 'run-A', 10_000)
    let ran = false
    const result = await withDistributionLock(redis, ISO_WEEK, 'run-B', 10_000, () => {
      ran = true
      return Promise.resolve('should-not-run')
    })
    expect(ran).toBe(false)
    expect(result).toBeNull()
  })

  it('still releases the lock if the callback throws', async () => {
    await expect(
      withDistributionLock(redis, ISO_WEEK, 'run-1', 10_000, () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    // Lock must be released despite the throw.
    const next = await acquireDistributionLock(redis, ISO_WEEK, 'run-2', 10_000)
    expect(next).not.toBeNull()
  })
})
