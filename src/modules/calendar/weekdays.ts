// Working weekdays of a WorkPattern (P1-CAL). PURE: no prisma, no server imports.
//
// Weekday numbers follow Date.getUTCDay(): 0 = Sunday … 6 = Saturday.
//
// HR has always typed the working days as text (WorkSchedule.workDays: "الأحد, الاثنين, …" from the
// branch form, or "الأحد-الخميس"). parseWeekdays turns that label into the structured
// WorkSchedule.workWeekdays column. The SQL function calendar_parse_weekdays (migration 9z_calendar)
// is the same parser, used once to backfill the existing rows; the parity is tested in
// __tests__/calendar.it.test.ts.

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Arabic names in the order of getUTCDay() (the labels the branch form writes). */
export const WEEKDAY_NAMES_AR = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'] as const;

/**
 * The owner default when an employee has no pattern, or a pattern without working days: Sunday to
 * Thursday (Friday and Saturday off), the practice of the tenant setting default_work_days_per_week = 5.
 * It is a default only (DEC-PO-116): a company changes it by giving its branches a pattern.
 */
export const DEFAULT_WORK_WEEKDAYS: readonly Weekday[] = Object.freeze([0, 1, 2, 3, 4] as Weekday[]);

// Normalized fragments that identify a day (after normalizeArabic). Order = weekday number.
const DAY_PATTERNS: readonly (readonly string[])[] = [
  ['احد', 'sun'],
  ['اثنين', 'اتنين', 'mon'],
  ['ثلاثا', 'tue'],
  ['اربعا', 'wed'],
  ['خميس', 'thu'],
  ['جمع', 'fri'],
  ['سبت', 'sat'],
];

const RANGE_MARKERS = ['-', '–', '—', 'الي', 'حتي', ' to '];

function normalizeArabic(s: string): string {
  return ` ${s.toLowerCase()} `
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[ـً-ْ]/g, '');
}

/**
 * The weekdays named in a label, sorted. A range ("الأحد-الخميس", "من السبت إلى الأربعاء") is
 * expanded, wrapping over the end of the week. Unknown text gives [] (not set).
 */
export function parseWeekdays(label: string | null | undefined): Weekday[] {
  if (!label || !label.trim()) return [];
  const text = normalizeArabic(label);
  const found: { day: Weekday; at: number }[] = [];
  DAY_PATTERNS.forEach((patterns, day) => {
    let at = -1;
    for (const p of patterns) {
      const i = text.indexOf(p);
      if (i >= 0 && (at < 0 || i < at)) at = i;
    }
    if (at >= 0) found.push({ day: day as Weekday, at });
  });
  if (!found.length) return [];
  found.sort((a, b) => a.at - b.at);
  const isRange = found.length === 2 && RANGE_MARKERS.some((m) => text.slice(found[0].at, found[1].at).includes(m));
  if (isRange) {
    const out: Weekday[] = [];
    for (let d = found[0].day; ; d = ((d + 1) % 7) as Weekday) {
      out.push(d);
      if (d === found[1].day) break;
    }
    return out.sort((a, b) => a - b);
  }
  return found.map((f) => f.day).sort((a, b) => a - b);
}

/** Validates a weekday list (0..6, unique) and returns it sorted. */
export function normalizeWeekdays(days: readonly number[]): Weekday[] {
  const out = new Set<Weekday>();
  for (const d of days) {
    if (!Number.isInteger(d) || d < 0 || d > 6) throw new RangeError(`weekday ${d} is not 0..6`);
    out.add(d as Weekday);
  }
  return [...out].sort((a, b) => a - b);
}

/** Arabic label of a weekday list ("الأحد، الاثنين، …"). */
export function formatWeekdays(days: readonly number[]): string {
  return normalizeWeekdays(days)
    .map((d) => WEEKDAY_NAMES_AR[d])
    .join('، ');
}
