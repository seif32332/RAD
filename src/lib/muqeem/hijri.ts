// Date conversions for Muqeem. Pure and client-safe (no server imports).
//
// Storage convention (src/lib/dates.ts): date-only values are stored as UTC midnight of the
// calendar day, so every conversion here works in UTC.
//
// Muqeem expects Hijri dates as 'yyyy-MM-dd' in the Umm al-Qura calendar (e.g. returnBefore of
// an exit/re-entry visa) and Gregorian dates as 'yyyy-MM-dd'. It returns Gregorian dates in
// several spellings (parseMuqeemGregorian) and Hijri dates as 'yyyy-MM-dd' or 'yyyy/MM/dd'.

const HIJRI_FORMAT = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura-nu-latn', {
  timeZone: 'UTC',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const DAY_MS = 24 * 60 * 60 * 1000;

function toValidDate(date: Date | string): Date {
  const d = date instanceof Date ? date : new Date(/^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00Z` : date);
  if (Number.isNaN(d.getTime())) throw new RangeError('تاريخ غير صالح');
  return d;
}

/**
 * Umm al-Qura Hijri date of a (UTC) calendar day as 'yyyy-MM-dd', e.g. 2026-09-26 -> '1448-04-15'.
 * Accepts a Date (its UTC calendar day is used) or a 'yyyy-MM-dd' / ISO string. Throws RangeError
 * for an invalid date.
 */
export function toHijriDateString(date: Date | string): string {
  const d = toValidDate(date);
  const parts = HIJRI_FORMAT.formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  const year = get('year').replace(/\D/g, '');
  return `${year.padStart(4, '0')}-${get('month').padStart(2, '0')}-${get('day').padStart(2, '0')}`;
}

/** True for a syntactically valid Hijri 'yyyy-MM-dd' (year 1300-1600, month 1-12, day 1-30). */
export function isHijriDateString(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  return y >= 1300 && y <= 1600 && mo >= 1 && mo <= 12 && d >= 1 && d <= 30;
}

/**
 * Gregorian date (UTC midnight) of an Umm al-Qura Hijri date 'yyyy-MM-dd' (also 'yyyy/MM/dd').
 * Returns null when the text is invalid or the day does not exist (e.g. the 30th of a 29-day month).
 */
export function hijriToGregorian(value: string | null | undefined): Date | null {
  if (!value) return null;
  const normalized = value.trim().replace(/\//g, '-').replace(/^(\d{4})-(\d)-/, '$1-0$2-').replace(/-(\d)$/, '-0$1');
  if (!isHijriDateString(normalized)) return null;
  const [y, m, d] = normalized.split('-').map(Number);
  // Anchor: 1 Muharram 1445 = 2023-07-19. Estimate, then search around it.
  const anchor = Date.UTC(2023, 6, 19);
  const estimate = anchor + Math.round((y - 1445) * 354.36707 + (m - 1) * 29.530589 + (d - 1)) * DAY_MS;
  for (let offset = 0; offset <= 40; offset++) {
    for (const sign of offset === 0 ? [0] : [-1, 1]) {
      const candidate = new Date(estimate + sign * offset * DAY_MS);
      if (toHijriDateString(candidate) === normalized) return candidate;
    }
  }
  return null;
}

/** 'yyyy-MM-dd' Gregorian string for Muqeem request fields (UTC calendar day of a stored date). */
export function toMuqeemGregorian(date: Date | string): string {
  return toValidDate(date).toISOString().slice(0, 10);
}

function ymd(y: number, mo: number, d: number): Date | null {
  if (y < 1900 || y > 2200 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCMonth() === mo - 1 && date.getUTCDate() === d ? date : null;
}

/**
 * Parses a Gregorian date returned by Muqeem into a date-only value (UTC midnight).
 * Accepts 'yyyy-MM-dd', 'yyyy/MM/dd', 'dd-MM-yyyy', 'dd/MM/yyyy', ISO timestamps (the calendar day
 * in the timestamp's own offset is kept, e.g. '2026-09-26T00:00:00+03:00' -> 2026-09-26) and epoch
 * milliseconds. Hijri-looking years (< 1900) are rejected. Returns null for anything else.
 */
export function parseMuqeemGregorian(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    const d = new Date(value);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }
  if (typeof value !== 'string') return null;
  const s = value.trim();
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:$|[T\s])/);
  if (m) return ymd(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) return ymd(+m[3], +m[2], +m[1]);
  return null;
}
