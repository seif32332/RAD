// dayType semantics (P1-CAL, DOMAIN_MODEL §1.3 effectiveContext.dayType). PURE: no prisma.
//
// One employee, one calendar day (Riyadh date, stored as UTC midnight):
//   HOLIDAY          a non-cancelled HolidayCalendar row of the company covers the day (wins over
//                    everything: a holiday on a weekend is still reported HOLIDAY, with weekend=true)
//   WEEKEND          the weekday is not a working day of the employee's pattern (or of the default)
//   RAMADAN_WORKDAY  a working day inside the company's RamadanPeriod: scheduledHours is the Ramadan
//                    daily hours (never more than the pattern's own hours)
//   WORKDAY          any other working day: scheduledHours from the pattern (null when unknown)
import type { Weekday } from './weekdays';

export type DayType = 'WORKDAY' | 'WEEKEND' | 'HOLIDAY' | 'RAMADAN_WORKDAY';
export const DAY_TYPES: readonly DayType[] = ['WORKDAY', 'WEEKEND', 'HOLIDAY', 'RAMADAN_WORKDAY'];

/** The time fields of a WorkPattern (WorkSchedule row) that give its daily hours. */
export interface PatternHoursInput {
  shiftType?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  startTime2?: string | null;
  endTime2?: string | null;
  flexibleHours?: number | null;
}

function minutesOf(hhmm: string | null | undefined): number | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(hhmm ?? '');
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function spanMinutes(start: string | null | undefined, end: string | null | undefined): number | null {
  const a = minutesOf(start);
  const b = minutesOf(end);
  if (a === null || b === null) return null;
  return b > a ? b - a : b + 24 * 60 - a; // an end at or before the start crosses midnight
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Scheduled hours of one working day of the pattern; null when the pattern does not say. */
export function patternDailyHours(p: PatternHoursInput | null | undefined): number | null {
  if (!p) return null;
  if (p.shiftType === 'FLEXIBLE') return p.flexibleHours && p.flexibleHours > 0 ? round2(p.flexibleHours) : null;
  const first = spanMinutes(p.startTime, p.endTime);
  if (first === null) return null;
  if (p.shiftType === 'TWO_SHIFTS') {
    const second = spanMinutes(p.startTime2, p.endTime2);
    return round2((first + (second ?? 0)) / 60);
  }
  return round2(first / 60);
}

export interface ClassifyInput {
  /** getUTCDay() of the day. */
  weekday: Weekday;
  /** Working weekdays in force (the pattern's, else the default). */
  workWeekdays: readonly number[];
  holiday: { id: string; name: string } | null;
  ramadan: { id: string; dailyHours: number } | null;
  /** The pattern's hours for a normal working day (null = unknown). */
  patternHours: number | null;
}

export interface ClassifiedDay {
  type: DayType;
  isWorkingDay: boolean;
  /** The weekday is a rest day of the pattern (also true for a holiday that falls on it). */
  weekend: boolean;
  /** Hours the employee is scheduled to work that day; 0 on a rest day, null when unknown. */
  scheduledHours: number | null;
}

export function classifyDay(input: ClassifyInput): ClassifiedDay {
  const weekend = !input.workWeekdays.includes(input.weekday);
  if (input.holiday) return { type: 'HOLIDAY', isWorkingDay: false, weekend, scheduledHours: 0 };
  if (weekend) return { type: 'WEEKEND', isWorkingDay: false, weekend, scheduledHours: 0 };
  if (input.ramadan) {
    const cap = input.ramadan.dailyHours;
    const hours = input.patternHours === null ? cap : Math.min(input.patternHours, cap);
    return { type: 'RAMADAN_WORKDAY', isWorkingDay: true, weekend, scheduledHours: round2(hours) };
  }
  return { type: 'WORKDAY', isWorkingDay: true, weekend, scheduledHours: input.patternHours };
}
