// Date helpers. Client-safe (no server imports).
//
// Storage convention: date-only values (birth dates, expiry dates, leave start/end...)
// are stored as UTC midnight of that calendar day, e.g. new Date('2026-09-23') ->
// 2026-09-23T00:00:00.000Z. "Today" is always the calendar day in Riyadh (UTC+3, no DST).

const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Today's calendar date in Riyadh as 'YYYY-MM-DD'. */
export function todayKey(now: Date = new Date()): string {
  return new Date(now.getTime() + RIYADH_OFFSET_MS).toISOString().slice(0, 10);
}

/** Today (Riyadh calendar day) as a Date at UTC midnight, matching the storage convention. */
export function today(now: Date = new Date()): Date {
  return new Date(`${todayKey(now)}T00:00:00.000Z`);
}

/** Calendar-day key ('YYYY-MM-DD') of a stored date-only value. */
export function dateKey(d: Date | string | null | undefined): string | null {
  const date = toDate(d);
  return date ? date.toISOString().slice(0, 10) : null;
}

/** Calendar-day key in Riyadh time for a timestamp (e.g. createdAt, check-in time). */
export function riyadhDateKey(d: Date | string | null | undefined): string | null {
  const date = toDate(d);
  return date ? new Date(date.getTime() + RIYADH_OFFSET_MS).toISOString().slice(0, 10) : null;
}

export function toDate(d: Date | string | number | null | undefined): Date | null {
  if (d === null || d === undefined || d === '') return null;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Whole calendar days from `from` to `to` (both date-only). Positive if `to` is later. */
export function daysBetween(from: Date | string, to: Date | string): number {
  const a = dateKey(from);
  const b = dateKey(to);
  if (!a || !b) return NaN;
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
}

/**
 * Days remaining until a date-only value, relative to today in Riyadh.
 * 0 = expires today, negative = already expired, null = no date.
 */
export function daysUntil(d: Date | string | null | undefined, now: Date = new Date()): number | null {
  const key = dateKey(d);
  if (!key) return null;
  return Math.round((Date.parse(`${key}T00:00:00Z`) - Date.parse(`${todayKey(now)}T00:00:00Z`)) / DAY_MS);
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

/** Inclusive count of calendar days in [start, end]. */
export function inclusiveDays(start: Date | string, end: Date | string): number {
  const n = daysBetween(start, end);
  return Number.isNaN(n) ? NaN : n + 1;
}

/** First and last day (UTC midnight) of a month. month is 1-12. */
export function monthRange(year: number, month: number): { start: Date; end: Date; days: number } {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));
  return { start, end, days: end.getUTCDate() };
}

/**
 * Parse user / Excel input into a date-only value (UTC midnight).
 * Accepts: Date, 'YYYY-MM-DD', 'YYYY/MM/DD', 'DD/MM/YYYY', 'DD-MM-YYYY', ISO strings,
 * and Excel serial numbers. Returns null for empty or invalid input.
 */
export function parseDateOnly(v: unknown): Date | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return new Date(Date.UTC(v.getFullYear(), v.getMonth(), v.getDate()));
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Excel serial date (days since 1899-12-30)
    if (v > 59 && v < 2958466) return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * DAY_MS);
    return null;
  }
  const s = String(v).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return validYmd(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) return validYmd(+m[3], +m[2], +m[1]);
  if (/^\d+(\.\d+)?$/.test(s)) return parseDateOnly(Number(s));
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : parseDateOnly(parsed);
}

function validYmd(y: number, mo: number, d: number): Date | null {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCMonth() === mo - 1 ? date : null;
}

// ---------------------------------------------------------------------------
// Display formatting (UI). Gregorian calendar, Latin digits, Arabic month names.
// ---------------------------------------------------------------------------

const DATE_LOCALE = 'ar-SA-u-ca-gregory-nu-latn';

/** e.g. "23 سبتمبر 2026". Returns '—' for empty values. */
export function formatDate(d: Date | string | null | undefined, opts?: Intl.DateTimeFormatOptions): string {
  const date = toDate(d);
  if (!date) return '—';
  return date.toLocaleDateString(DATE_LOCALE, { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric', ...opts });
}

/** e.g. "2026/09/23". */
export function formatDateShort(d: Date | string | null | undefined): string {
  const date = toDate(d);
  if (!date) return '—';
  return date.toLocaleDateString(DATE_LOCALE, { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
}

/** Timestamp in Riyadh time, e.g. "23 سبتمبر 2026، 14:05". */
export function formatDateTime(d: Date | string | null | undefined): string {
  const date = toDate(d);
  if (!date) return '—';
  return date.toLocaleString(DATE_LOCALE, {
    timeZone: 'Asia/Riyadh',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Value for <input type="date"> from a stored date-only value. */
export function toDateInputValue(d: Date | string | null | undefined): string {
  return dateKey(d) ?? '';
}
