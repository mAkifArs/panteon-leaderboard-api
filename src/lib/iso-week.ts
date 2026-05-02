/**
 * ISO 8601 week formatting. Used as the canonical week identifier
 * across Postgres (`iso_week` column), Redis keys (`lb:week:<isoWeek>`)
 * and Mongo documents.
 *
 * The format is `YYYY-WXX` (zero-padded week, e.g. `2026-W17`).
 *
 * Why a single helper: every database touches this string, and the
 * format must stay byte-identical across them. ADR-005 explains why
 * we denormalise this onto `earning_events` instead of computing it
 * on every read.
 */

const MS_PER_DAY = 86_400_000

/**
 * Return the ISO 8601 week string for a given UTC instant.
 *
 * The ISO week year may differ from the calendar year at year
 * boundaries: 2026-01-01 (Thursday) belongs to ISO week 2026-W01,
 * but 2027-01-01 (Friday) belongs to 2026-W53. This is intentional
 * and matches Postgres `to_char(..., 'IYYY-"W"IW')` semantics.
 */
export function toIsoWeek(date: Date): string {
  // Work in UTC throughout. Copy the date so we don't mutate the input.
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))

  // ISO weekday: Mon = 1 ... Sun = 7. JavaScript getUTCDay returns 0..6 with Sun = 0.
  const isoDayOfWeek = utc.getUTCDay() === 0 ? 7 : utc.getUTCDay()

  // The ISO week-numbering year is determined by the Thursday of the same week.
  utc.setUTCDate(utc.getUTCDate() + 4 - isoDayOfWeek)
  const isoYear = utc.getUTCFullYear()

  // Week number = number of weeks between the Thursday of week 1 and our Thursday, plus one.
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4))
  const firstThursdayDayOfWeek = firstThursday.getUTCDay() === 0 ? 7 : firstThursday.getUTCDay()
  firstThursday.setUTCDate(firstThursday.getUTCDate() + 4 - firstThursdayDayOfWeek)

  const weekNumber = Math.round((utc.getTime() - firstThursday.getTime()) / (7 * MS_PER_DAY)) + 1

  return `${isoYear}-W${String(weekNumber).padStart(2, '0')}`
}

/**
 * The ISO week immediately preceding the one containing `date`.
 * The cron fires Mondays 00:05 UTC and needs to operate on the
 * week that just *closed* (Sunday 23:59 UTC), not the one that
 * is five minutes old. Subtracting seven days then re-deriving
 * the ISO week handles year boundaries (W01 → previous-year W52
 * or W53) for free, because `toIsoWeek` already encodes
 * ISO 8601's "week-numbering year" rule.
 */
export function previousIsoWeek(date: Date): string {
  return toIsoWeek(new Date(date.getTime() - 7 * MS_PER_DAY))
}

export interface IsoWeekRange {
  /** Monday 00:00:00.000 UTC of the given ISO week. */
  start: Date
  /** Sunday 23:59:59.999 UTC of the given ISO week. */
  end: Date
}

/**
 * Inclusive UTC range for an ISO week — Monday 00:00 to Sunday
 * 23:59:59.999. Used by the leaderboard API meta envelope so the
 * frontend can render a week-end countdown.
 */
export function isoWeekRange(isoWeek: string): IsoWeekRange {
  const start = isoWeekToMonday(isoWeek)
  const end = new Date(start.getTime() + 7 * MS_PER_DAY - 1)
  return { start, end }
}

/**
 * Parse an ISO week string back into the UTC Date of its Monday
 * (00:00:00 UTC). Inverse of `toIsoWeek` for week starts.
 *
 * Throws if the format is not `YYYY-WXX` with a valid week number.
 */
export function isoWeekToMonday(isoWeek: string): Date {
  const match = /^(\d{4})-W(\d{2})$/.exec(isoWeek)
  if (!match) {
    throw new Error(`Invalid ISO week format: ${isoWeek} (expected YYYY-WXX)`)
  }
  const year = Number(match[1])
  const week = Number(match[2])
  if (week < 1 || week > 53) {
    throw new Error(`Invalid ISO week number: ${week} (must be 1..53)`)
  }

  // Find the Monday of week 1: the week containing 4 January.
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const jan4DayOfWeek = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay()
  const week1Monday = new Date(jan4.getTime() - (jan4DayOfWeek - 1) * MS_PER_DAY)

  return new Date(week1Monday.getTime() + (week - 1) * 7 * MS_PER_DAY)
}
