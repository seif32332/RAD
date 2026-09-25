'use strict';
/** Date-only helpers. Keys are "YYYY-MM-DD" in the Asia/Riyadh calendar. */

const DAY_MS = 24 * 60 * 60 * 1000;

function todayKey(now = new Date()) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Riyadh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function keyToUtc(key) {
  return Date.parse(`${key}T00:00:00Z`);
}

/** Add calendar months, clamping the day (Jan 31 + 1 month = Feb 28/29). */
function addMonthsKey(key, months) {
  const [y, m, d] = key.split('-').map(Number);
  const targetMonthIndex = m - 1 + months;
  const ty = y + Math.floor(targetMonthIndex / 12);
  const tm = ((targetMonthIndex % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const out = new Date(Date.UTC(ty, tm, Math.min(d, lastDay)));
  return out.toISOString().slice(0, 10);
}

/** Whole days from today to `key` (0 = today, negative = past). */
function daysUntilKey(key, now = new Date()) {
  if (!key) return null;
  const t = keyToUtc(key);
  if (Number.isNaN(t)) return null;
  return Math.round((t - keyToUtc(todayKey(now))) / DAY_MS);
}

function stamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-');
}

module.exports = { todayKey, addMonthsKey, daysUntilKey, stamp };
