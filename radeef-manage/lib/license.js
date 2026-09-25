'use strict';
/**
 * Pure license decisions (DEC-009). No I/O, so they can be unit tested.
 *
 * `days` is the whole number of days from today (Asia/Riyadh) to the license end date, as
 * returned by dates.daysUntilKey():  0 = today is the LAST PAID DAY, -1 = expired yesterday.
 *
 *  - suspend : days < 0   (never on the last paid day itself; the old `days <= 0` rule took
 *                          that day away from the customer)
 *  - remind  : 0 <= days <= reminderDays (default 14), at most once per tenant per calendar day
 *              (the once-per-day record lives in the SQLite registry, see store.claimNotice)
 *  - null    : nothing to do
 */

const DEFAULT_REMINDER_DAYS = 14;
const MAX_REMINDER_DAYS = 60;

function normalizeReminderDays(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_REMINDER_DAYS;
  return Math.min(Math.floor(n), MAX_REMINDER_DAYS);
}

/** 'suspend' | 'remind' | null */
function licenseAction(days, reminderDays = DEFAULT_REMINDER_DAYS) {
  if (typeof days !== 'number' || !Number.isFinite(days)) return null;
  if (days < 0) return 'suspend';
  if (days <= normalizeReminderDays(reminderDays)) return 'remind';
  return null;
}

/** Renewal base: extend from the current end date while the license is still running (days >= 0). */
function renewFromEndDate(days, suspended) {
  return !suspended && typeof days === 'number' && Number.isFinite(days) && days >= 0;
}

/** Notice kind stored in the per-day registry. */
function noticeKind(action) {
  return action === 'suspend' ? 'expired' : 'warning';
}

module.exports = { DEFAULT_REMINDER_DAYS, MAX_REMINDER_DAYS, normalizeReminderDays, licenseAction, renewFromEndDate, noticeKind };
