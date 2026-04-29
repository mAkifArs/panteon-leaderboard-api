import { describe, expect, it } from 'vitest'
import { isoWeekRange, isoWeekToMonday, toIsoWeek } from '../iso-week.ts'

describe('toIsoWeek', () => {
  it('formats a mid-week date as YYYY-WXX', () => {
    // 2026-04-26 is a Sunday in ISO week 17 of 2026.
    expect(toIsoWeek(new Date('2026-04-26T12:00:00Z'))).toBe('2026-W17')
  })

  it('zero-pads single-digit weeks', () => {
    expect(toIsoWeek(new Date('2026-01-05T00:00:00Z'))).toBe('2026-W02')
  })

  it('handles the year-boundary case where ISO year != calendar year', () => {
    // 2027-01-01 (Friday) belongs to the last ISO week of 2026.
    expect(toIsoWeek(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53')
  })

  it('returns 2026-W01 for 2025-12-29 (Monday of week 1)', () => {
    expect(toIsoWeek(new Date('2025-12-29T00:00:00Z'))).toBe('2026-W01')
  })

  it('returns the same week for any time within that week', () => {
    const monday = toIsoWeek(new Date('2026-04-20T00:00:00Z'))
    const sunday = toIsoWeek(new Date('2026-04-26T23:59:59Z'))
    expect(monday).toBe(sunday)
    expect(monday).toBe('2026-W17')
  })
})

describe('isoWeekToMonday', () => {
  it('returns the Monday at 00:00 UTC of a given ISO week', () => {
    expect(isoWeekToMonday('2026-W17').toISOString()).toBe('2026-04-20T00:00:00.000Z')
  })

  it('round-trips with toIsoWeek for a Monday', () => {
    const monday = isoWeekToMonday('2026-W17')
    expect(toIsoWeek(monday)).toBe('2026-W17')
  })

  it('handles year-boundary weeks', () => {
    expect(isoWeekToMonday('2026-W53').toISOString()).toBe('2026-12-28T00:00:00.000Z')
  })

  it('throws on malformed input', () => {
    expect(() => isoWeekToMonday('2026-17')).toThrow(/Invalid ISO week format/)
    expect(() => isoWeekToMonday('2026-W7')).toThrow(/Invalid ISO week format/)
  })

  it('throws on out-of-range week numbers', () => {
    expect(() => isoWeekToMonday('2026-W00')).toThrow(/Invalid ISO week number/)
    expect(() => isoWeekToMonday('2026-W54')).toThrow(/Invalid ISO week number/)
  })
})

describe('isoWeekRange', () => {
  it('returns Mon 00:00 UTC to Sun 23:59:59.999 UTC', () => {
    const { start, end } = isoWeekRange('2026-W17')
    expect(start.toISOString()).toBe('2026-04-20T00:00:00.000Z')
    expect(end.toISOString()).toBe('2026-04-26T23:59:59.999Z')
  })

  it('spans exactly 7 days minus 1ms', () => {
    const { start, end } = isoWeekRange('2026-W17')
    expect(end.getTime() - start.getTime()).toBe(7 * 86_400_000 - 1)
  })

  it('handles year-boundary weeks', () => {
    const { start, end } = isoWeekRange('2026-W53')
    expect(start.toISOString()).toBe('2026-12-28T00:00:00.000Z')
    expect(end.toISOString()).toBe('2027-01-03T23:59:59.999Z')
  })
})
