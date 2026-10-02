// Unit tests of the calendar module's pure parts (P1-CAL): the weekday parser, the daily hours of a
// pattern, the day classification (dayType semantics) and the scope helpers. The database parts are
// in calendar.it.test.ts (CAL_IT=1).
import { describe, expect, it } from 'vitest';
import {
  CalendarScopeError,
  DEFAULT_WORK_WEEKDAYS,
  assertCompanyInScope,
  classifyDay,
  formatWeekdays,
  inScope,
  normalizeWeekdays,
  parseWeekdays,
  patternDailyHours,
} from '@/modules/calendar';

describe('parseWeekdays (WorkSchedule.workDays label -> workWeekdays)', () => {
  it('reads the comma list the branch form writes', () => {
    expect(parseWeekdays('الأحد, الاثنين, الثلاثاء, الأربعاء, الخميس')).toEqual([0, 1, 2, 3, 4]);
    expect(parseWeekdays('السبت، الأحد')).toEqual([0, 6]);
  });

  it('expands a range, also across the end of the week', () => {
    expect(parseWeekdays('الأحد-الخميس')).toEqual([0, 1, 2, 3, 4]);
    expect(parseWeekdays('من السبت إلى الأربعاء')).toEqual([0, 1, 2, 3, 6]);
    expect(parseWeekdays('الخميس - الأحد')).toEqual([0, 4, 5, 6]);
    expect(parseWeekdays('sun to thu')).toEqual([0, 1, 2, 3, 4]);
  });

  it('accepts spelling variants (hamza, taa marbuta) and English day names', () => {
    expect(parseWeekdays('الاحد و الإثنين و الجمعه')).toEqual([0, 1, 5]);
    expect(parseWeekdays('Sunday, Monday, Saturday')).toEqual([0, 1, 6]);
  });

  it('gives [] (not set) for an empty or unknown label', () => {
    expect(parseWeekdays(null)).toEqual([]);
    expect(parseWeekdays('   ')).toEqual([]);
    expect(parseWeekdays('دوام كامل')).toEqual([]);
  });

  it('normalizeWeekdays sorts, deduplicates and refuses values outside 0..6; formatWeekdays labels them', () => {
    expect(normalizeWeekdays([4, 0, 4, 2])).toEqual([0, 2, 4]);
    expect(() => normalizeWeekdays([7])).toThrow(RangeError);
    expect(() => normalizeWeekdays([1.5])).toThrow(RangeError);
    expect(formatWeekdays([1, 0])).toBe('الأحد، الاثنين');
    expect(DEFAULT_WORK_WEEKDAYS).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('patternDailyHours', () => {
  it('one shift, two shifts, overnight and flexible', () => {
    expect(patternDailyHours({ shiftType: 'ONE_SHIFT', startTime: '08:00', endTime: '16:30' })).toBe(8.5);
    expect(patternDailyHours({ shiftType: 'TWO_SHIFTS', startTime: '08:00', endTime: '12:00', startTime2: '16:00', endTime2: '20:00' })).toBe(8);
    expect(patternDailyHours({ shiftType: 'ONE_SHIFT', startTime: '22:00', endTime: '06:00' })).toBe(8);
    expect(patternDailyHours({ shiftType: 'FLEXIBLE', flexibleHours: 7 })).toBe(7);
  });

  it('null when the pattern does not say', () => {
    expect(patternDailyHours(null)).toBeNull();
    expect(patternDailyHours({ shiftType: 'ONE_SHIFT', startTime: null, endTime: null })).toBeNull();
    expect(patternDailyHours({ shiftType: 'FLEXIBLE', flexibleHours: 0 })).toBeNull();
    expect(patternDailyHours({ shiftType: 'ONE_SHIFT', startTime: '25:00', endTime: '10:00' })).toBeNull();
  });
});

describe('classifyDay (dayType semantics)', () => {
  const week = [0, 1, 2, 3, 4];
  const base = { workWeekdays: week, holiday: null, ramadan: null, patternHours: 8 } as const;

  it('WORKDAY on a working weekday with the pattern hours', () => {
    expect(classifyDay({ ...base, weekday: 2 })).toEqual({ type: 'WORKDAY', isWorkingDay: true, weekend: false, scheduledHours: 8 });
  });

  it('WEEKEND on a rest weekday (0 hours)', () => {
    expect(classifyDay({ ...base, weekday: 5 })).toEqual({ type: 'WEEKEND', isWorkingDay: false, weekend: true, scheduledHours: 0 });
  });

  it('HOLIDAY wins over the weekend and over Ramadan', () => {
    const holiday = { id: 'h', name: 'اليوم الوطني' };
    expect(classifyDay({ ...base, weekday: 3, holiday, ramadan: { id: 'r', dailyHours: 6 } })).toMatchObject({ type: 'HOLIDAY', weekend: false, scheduledHours: 0 });
    expect(classifyDay({ ...base, weekday: 6, holiday })).toMatchObject({ type: 'HOLIDAY', weekend: true, isWorkingDay: false });
  });

  it('RAMADAN_WORKDAY: the Ramadan hours, never more than the pattern; unknown pattern -> the Ramadan hours', () => {
    const ramadan = { id: 'r', dailyHours: 6 };
    expect(classifyDay({ ...base, weekday: 1, ramadan })).toEqual({ type: 'RAMADAN_WORKDAY', isWorkingDay: true, weekend: false, scheduledHours: 6 });
    expect(classifyDay({ ...base, weekday: 1, ramadan, patternHours: 5 })).toMatchObject({ scheduledHours: 5 });
    expect(classifyDay({ ...base, weekday: 1, ramadan, patternHours: null })).toMatchObject({ scheduledHours: 6 });
    expect(classifyDay({ ...base, weekday: 5, ramadan })).toMatchObject({ type: 'WEEKEND' });
  });

  it('WORKDAY with unknown hours when the pattern has none', () => {
    expect(classifyDay({ ...base, weekday: 0, patternHours: null })).toMatchObject({ type: 'WORKDAY', scheduledHours: null });
  });
});

describe('calendar scope helpers', () => {
  it('inScope / assertCompanyInScope: a list restricts, ALL and null (explicit cross-company) do not', () => {
    expect(inScope(['a'], 'a')).toBe(true);
    expect(inScope(['a'], 'b')).toBe(false);
    expect(inScope([], 'a')).toBe(false);
    expect(inScope('ALL', 'b')).toBe(true);
    expect(inScope(null, 'b')).toBe(true);
    expect(() => assertCompanyInScope(['a'], 'b')).toThrow(CalendarScopeError);
  });
});
