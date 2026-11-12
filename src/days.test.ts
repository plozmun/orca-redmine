// Unit tests for the calendar-day helpers behind the time-entry day picker.
import { assert, test } from 'orca/testing'
import { isBookableDay, localDate, localDateDaysAgo, recentDays, RECENT_DAYS } from './days'

const NOV_12 = new Date(2026, 10, 12, 9, 30)

test('local dates are zero-padded days in local time', () => {
  assert.equal(localDate(new Date(2026, 0, 5, 23, 59)), '2026-01-05')
  assert.equal(localDateDaysAgo(1, NOV_12), '2026-11-11')
  assert.equal(localDateDaysAgo(12, NOV_12), '2026-10-31')
})

test('the picker offers today first, then the days before it', () => {
  const days = recentDays(NOV_12)
  assert.equal(days.length, RECENT_DAYS)
  assert.deepEqual(days.slice(0, 3), ['2026-11-12', '2026-11-11', '2026-11-10'])
  assert.equal(days.at(-1), '2026-11-06')
})

test('a bookable day is a real date that is not in the future', () => {
  assert.equal(isBookableDay('2026-11-12', NOV_12), true)
  assert.equal(isBookableDay('2025-02-28', NOV_12), true)
  assert.equal(isBookableDay('2026-11-13', NOV_12), false)
  assert.equal(isBookableDay('2026-02-30', NOV_12), false)
  assert.equal(isBookableDay('2026-1-5', NOV_12), false)
  assert.equal(isBookableDay('12/11/2026', NOV_12), false)
  assert.equal(isBookableDay('', NOV_12), false)
})
