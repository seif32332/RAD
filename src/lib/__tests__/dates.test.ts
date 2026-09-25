import { describe, expect, it } from 'vitest';
import {
  addDays,
  dateKey,
  daysBetween,
  daysUntil,
  inclusiveDays,
  monthRange,
  parseDateOnly,
  riyadhDateKey,
  toDateInputValue,
  today,
  todayKey,
} from '@/lib/dates';

const utc = (s: string) => new Date(`${s}T00:00:00.000Z`);
const iso = (d: Date | null) => (d ? d.toISOString() : null);

describe('todayKey / today (Riyadh calendar day, UTC+3)', () => {
  it('is still the same day just before midnight in Riyadh', () => {
    expect(todayKey(new Date('2026-09-23T20:59:59.999Z'))).toBe('2026-09-23');
  });

  it('rolls over at Riyadh midnight (21:00 UTC) while UTC is still the previous day', () => {
    const now = new Date('2026-09-23T21:00:00.000Z');
    expect(now.toISOString().slice(0, 10)).toBe('2026-09-23');
    expect(todayKey(now)).toBe('2026-09-24');
  });

  it('handles month and year boundaries', () => {
    expect(todayKey(new Date('2026-12-31T22:30:00.000Z'))).toBe('2027-01-01');
  });

  it('today() is the Riyadh day at UTC midnight (storage convention)', () => {
    expect(today(new Date('2026-09-23T21:30:00.000Z')).toISOString()).toBe('2026-09-24T00:00:00.000Z');
    expect(today(new Date('2026-09-23T00:30:00.000Z')).toISOString()).toBe('2026-09-23T00:00:00.000Z');
  });
});

describe('riyadhDateKey / dateKey', () => {
  it('riyadhDateKey shifts a timestamp into the Riyadh day', () => {
    expect(riyadhDateKey('2026-09-23T22:00:00.000Z')).toBe('2026-09-24');
    expect(riyadhDateKey('2026-09-23T20:00:00.000Z')).toBe('2026-09-23');
    expect(riyadhDateKey(null)).toBeNull();
  });

  it('dateKey keeps the stored (UTC) calendar day', () => {
    expect(dateKey(utc('2026-09-23'))).toBe('2026-09-23');
    expect(dateKey(null)).toBeNull();
    expect(dateKey('')).toBeNull();
    expect(dateKey('not a date')).toBeNull();
    expect(toDateInputValue(null)).toBe('');
    expect(toDateInputValue(utc('2026-01-05'))).toBe('2026-01-05');
  });
});

describe('daysUntil', () => {
  const now = new Date('2026-09-23T10:00:00.000Z');

  it('returns 0 for a date that expires today', () => {
    expect(daysUntil(utc('2026-09-23'), now)).toBe(0);
    expect(daysUntil('2026-09-23', now)).toBe(0);
  });

  it('returns negative values for past dates and positive for future dates', () => {
    expect(daysUntil(utc('2026-09-20'), now)).toBe(-3);
    expect(daysUntil(utc('2026-09-24'), now)).toBe(1);
    expect(daysUntil(utc('2027-09-23'), now)).toBe(365);
  });

  it('uses the Riyadh day, not the UTC day, near midnight', () => {
    const lateEvening = new Date('2026-09-23T21:30:00.000Z'); // 00:30 on the 24th in Riyadh
    expect(daysUntil(utc('2026-09-24'), lateEvening)).toBe(0);
    expect(daysUntil(utc('2026-09-23'), lateEvening)).toBe(-1);
  });

  it('returns null for missing or invalid dates', () => {
    expect(daysUntil(null, now)).toBeNull();
    expect(daysUntil(undefined, now)).toBeNull();
    expect(daysUntil('garbage', now)).toBeNull();
  });
});

describe('daysBetween / inclusiveDays / addDays / monthRange', () => {
  it('counts whole calendar days', () => {
    expect(daysBetween('2026-01-01', '2026-01-31')).toBe(30);
    expect(daysBetween('2026-01-31', '2026-01-01')).toBe(-30);
    expect(daysBetween('2024-02-28', '2024-03-01')).toBe(2); // leap year
    expect(Number.isNaN(daysBetween('x', '2026-01-01'))).toBe(true);
  });

  it('inclusiveDays counts both ends', () => {
    expect(inclusiveDays('2026-09-23', '2026-09-23')).toBe(1);
    expect(inclusiveDays('2026-09-01', '2026-09-30')).toBe(30);
  });

  it('addDays', () => {
    expect(addDays(utc('2026-12-31'), 1).toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(addDays(utc('2026-03-01'), -1).toISOString()).toBe('2026-02-28T00:00:00.000Z');
  });

  it('monthRange returns first/last day and the number of days', () => {
    const feb = monthRange(2024, 2);
    expect(feb.start.toISOString()).toBe('2024-02-01T00:00:00.000Z');
    expect(feb.end.toISOString()).toBe('2024-02-29T00:00:00.000Z');
    expect(feb.days).toBe(29);
    expect(monthRange(2026, 2).days).toBe(28);
    const dec = monthRange(2026, 12);
    expect(dec.end.toISOString()).toBe('2026-12-31T00:00:00.000Z');
    expect(dec.days).toBe(31);
  });
});

describe('parseDateOnly', () => {
  it('parses YYYY-MM-DD and YYYY/MM/DD', () => {
    expect(iso(parseDateOnly('2026-09-23'))).toBe('2026-09-23T00:00:00.000Z');
    expect(iso(parseDateOnly('2026/9/3'))).toBe('2026-09-03T00:00:00.000Z');
    expect(iso(parseDateOnly(' 2026.09.23 '))).toBe('2026-09-23T00:00:00.000Z');
  });

  it('parses DD/MM/YYYY and DD-MM-YYYY (day first)', () => {
    expect(iso(parseDateOnly('23/09/2026'))).toBe('2026-09-23T00:00:00.000Z');
    expect(iso(parseDateOnly('03/09/2026'))).toBe('2026-09-03T00:00:00.000Z');
    expect(iso(parseDateOnly('3-9-2026'))).toBe('2026-09-03T00:00:00.000Z');
  });

  it('keeps the calendar day of ISO timestamps', () => {
    expect(iso(parseDateOnly('2026-09-23T15:45:00.000Z'))).toBe('2026-09-23T00:00:00.000Z');
  });

  it('parses Excel serial numbers (numbers and numeric strings)', () => {
    expect(iso(parseDateOnly(45000))).toBe('2023-03-15T00:00:00.000Z');
    expect(iso(parseDateOnly('45000'))).toBe('2023-03-15T00:00:00.000Z');
    expect(iso(parseDateOnly(46288))).toBe('2026-09-23T00:00:00.000Z');
    expect(iso(parseDateOnly(45000.4))).toBe('2023-03-15T00:00:00.000Z');
  });

  it('normalizes Date objects to a date-only value', () => {
    expect(iso(parseDateOnly(new Date('2026-09-23T12:00:00.000Z')))).toBe('2026-09-23T00:00:00.000Z');
  });

  it('rejects invalid calendar dates and garbage', () => {
    expect(parseDateOnly('31/02/2026')).toBeNull();
    expect(parseDateOnly('2026-02-30')).toBeNull();
    expect(parseDateOnly('2026-13-01')).toBeNull();
    expect(parseDateOnly('00/01/2026')).toBeNull();
    expect(parseDateOnly('hello')).toBeNull();
    expect(parseDateOnly('')).toBeNull();
    expect(parseDateOnly('   ')).toBeNull();
    expect(parseDateOnly(null)).toBeNull();
    expect(parseDateOnly(undefined)).toBeNull();
    expect(parseDateOnly(new Date('invalid'))).toBeNull();
    expect(parseDateOnly(30)).toBeNull(); // too small to be a real Excel date
    expect(parseDateOnly(Number.NaN)).toBeNull();
    expect(parseDateOnly(Infinity)).toBeNull();
  });

  it('accepts 29 February only in leap years', () => {
    expect(iso(parseDateOnly('29/02/2024'))).toBe('2024-02-29T00:00:00.000Z');
    expect(parseDateOnly('29/02/2026')).toBeNull();
  });
});
