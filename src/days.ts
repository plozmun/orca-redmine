// Calendar days as Redmine reads them (`YYYY-MM-DD`, local time). Pure: the panel builds the
// time-entry day picker from it and the worker checks the day it is sent.

/** `YYYY-MM-DD` for `at` in local time: Redmine dates are days, not instants. */
export function localDate(at: Date): string {
  const month = String(at.getMonth() + 1).padStart(2, '0')
  return `${at.getFullYear()}-${month}-${String(at.getDate()).padStart(2, '0')}`
}

/**
 * `YYYY-MM-DD` for the day `days` before `at`, in local time. Calendar arithmetic, not milliseconds,
 * so a change of daylight saving time does not shift the day.
 */
export function localDateDaysAgo(days: number, at: Date = new Date()): string {
  return localDate(new Date(at.getFullYear(), at.getMonth(), at.getDate() - days))
}

/** How many days the time-entry picker offers, today included. Older days are typed. */
export const RECENT_DAYS = 7

/** Today first, then the days before it: the choices of the time-entry day picker. */
export function recentDays(at: Date = new Date(), count = RECENT_DAYS): string[] {
  return Array.from({ length: count }, (_, days) => localDateDaysAgo(days, at))
}

/**
 * Whether `day` can be booked: a real `YYYY-MM-DD` date, not after today. Redmine would take a
 * future day, but booking time ahead is almost always a typo.
 */
export function isBookableDay(day: string, at: Date = new Date()): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!match) return false
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const parsed = new Date(year, month - 1, date)
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== date) return false
  return day <= localDate(at)
}
