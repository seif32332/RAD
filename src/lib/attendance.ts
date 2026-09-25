// Attendance domain logic. PURE functions only (no prisma, no server imports).
//
// Conventions:
// - Attendance.date is a date-only value (UTC midnight of the Riyadh calendar day).
// - checkIn / checkOut are real timestamps. Times typed by users ("08:30") are Riyadh
//   wall-clock times (UTC+3, no DST) and are converted with riyadhDateTime().
// - WorkSchedule times are "HH:MM" Riyadh wall-clock strings.

const RIYADH_OFFSET_MIN = 3 * 60;
const MINUTE_MS = 60 * 1000;
const DAY_MIN = 24 * 60;

export const SHIFT_TYPES = ['ONE_SHIFT', 'TWO_SHIFTS', 'FLEXIBLE'] as const;
export type ShiftType = (typeof SHIFT_TYPES)[number];

export const ATTENDANCE_STATUS = { PRESENT: 'PRESENT', ABSENT: 'ABSENT' } as const;

/** Origin of a punch (Attendance.checkInSource / checkOutSource). null = row written before the feature existed. */
export const ATTENDANCE_SOURCE = { MANUAL: 'MANUAL', CORRECTION: 'CORRECTION', SELF: 'SELF' } as const;
export type AttendanceSource = (typeof ATTENDANCE_SOURCE)[keyof typeof ATTENDANCE_SOURCE];

/** Used only to fill in a missing punch when the employee has no work schedule. */
export const FALLBACK_SHIFT = { startTime: '09:00', endTime: '17:00' } as const;

export interface ScheduleLike {
  shiftType?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  startTime2?: string | null;
  endTime2?: string | null;
  flexibleHours?: number | null;
  isExemptFromAttendance?: boolean | null;
}

/** "HH:MM" / "H:MM" / "HH:MM:SS" (24h) -> minutes since midnight, or null. */
export function parseTimeOfDay(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = String(value).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** Normalizes a time string to "HH:MM" or returns null when invalid. */
export function normalizeTimeOfDay(value: string | null | undefined): string | null {
  const minutes = parseTimeOfDay(value);
  if (minutes === null) return null;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Riyadh wall-clock time on a calendar day ('YYYY-MM-DD') -> UTC timestamp. */
export function riyadhDateTime(dayKey: string, time: string | number): Date | null {
  const minutes = typeof time === 'number' ? time : parseTimeOfDay(time);
  if (minutes === null || !/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) return null;
  const base = Date.parse(`${dayKey}T00:00:00.000Z`);
  if (Number.isNaN(base)) return null;
  return new Date(base + (minutes - RIYADH_OFFSET_MIN) * MINUTE_MS);
}

/**
 * Builds check-in / check-out timestamps from typed times. A check-out earlier than
 * the check-in is treated as the next day (overnight shift).
 */
export function buildPunches(dayKey: string, checkIn?: string | null, checkOut?: string | null): { checkIn: Date | null; checkOut: Date | null } {
  const inAt = checkIn ? riyadhDateTime(dayKey, checkIn) : null;
  let outAt = checkOut ? riyadhDateTime(dayKey, checkOut) : null;
  if (inAt && outAt && outAt.getTime() <= inAt.getTime()) outAt = new Date(outAt.getTime() + DAY_MIN * MINUTE_MS);
  return { checkIn: inAt, checkOut: outAt };
}

export interface ScheduledShift {
  start: Date;
  end: Date;
}

/** Scheduled start (first shift) and end (last shift) for a day, or null for flexible/unknown schedules. */
export function scheduledShift(schedule: ScheduleLike | null | undefined, dayKey: string): ScheduledShift | null {
  if (!schedule || schedule.shiftType === 'FLEXIBLE') return null;
  const startMin = parseTimeOfDay(schedule.startTime);
  const lastEnd = schedule.shiftType === 'TWO_SHIFTS' ? (schedule.endTime2 ?? schedule.endTime) : schedule.endTime;
  let endMin = parseTimeOfDay(lastEnd);
  if (startMin === null || endMin === null) return null;
  if (endMin <= startMin) endMin += DAY_MIN; // overnight shift
  const start = riyadhDateTime(dayKey, startMin);
  const end = riyadhDateTime(dayKey, endMin);
  return start && end ? { start, end } : null;
}

export interface LateEarlyInput {
  schedule: ScheduleLike | null | undefined;
  /** Attendance calendar day 'YYYY-MM-DD'. */
  dayKey: string;
  checkIn: Date | null;
  checkOut: Date | null;
}

export interface LateEarlyResult {
  lateMinutes: number;
  earlyLeaveMin: number;
  overtimeMin: number;
  workedMinutes: number;
  /** False when there is no usable schedule (numbers are then 0). */
  hasSchedule: boolean;
}

/**
 * Late arrival / early leave / overtime minutes against the employee's WorkSchedule.
 * - Exempt schedules: all zero.
 * - FLEXIBLE: no lateness; shortfall vs flexibleHours is early leave, excess is overtime.
 * - ONE_SHIFT / TWO_SHIFTS: late vs the first start, early/overtime vs the last end.
 */
export function computeLateEarly(input: LateEarlyInput): LateEarlyResult {
  const { schedule, dayKey, checkIn, checkOut } = input;
  const worked = checkIn && checkOut ? Math.max(0, Math.round((checkOut.getTime() - checkIn.getTime()) / MINUTE_MS)) : 0;
  const zero: LateEarlyResult = { lateMinutes: 0, earlyLeaveMin: 0, overtimeMin: 0, workedMinutes: worked, hasSchedule: false };
  if (!schedule) return zero;
  if (schedule.isExemptFromAttendance) return { ...zero, hasSchedule: true };

  if (schedule.shiftType === 'FLEXIBLE') {
    const required = Math.max(0, Math.round((schedule.flexibleHours ?? 0) * 60));
    if (!required || !checkIn || !checkOut) return { ...zero, hasSchedule: required > 0 };
    return {
      lateMinutes: 0,
      earlyLeaveMin: Math.max(0, required - worked),
      overtimeMin: Math.max(0, worked - required),
      workedMinutes: worked,
      hasSchedule: true,
    };
  }

  const shift = scheduledShift(schedule, dayKey);
  if (!shift) return zero;
  const diffMin = (a: Date, b: Date) => Math.round((a.getTime() - b.getTime()) / MINUTE_MS);
  return {
    lateMinutes: checkIn ? Math.max(0, diffMin(checkIn, shift.start)) : 0,
    earlyLeaveMin: checkOut ? Math.max(0, diffMin(shift.end, checkOut)) : 0,
    overtimeMin: checkOut ? Math.max(0, diffMin(checkOut, shift.end)) : 0,
    workedMinutes: worked,
    hasSchedule: true,
  };
}

/**
 * Chooses the employee's schedule among the branch schedules: the one whose name matches
 * Employee.workSchedule, otherwise the only schedule of the branch, otherwise null.
 */
export function pickEmployeeSchedule<T extends ScheduleLike & { name: string }>(
  schedules: T[],
  employeeScheduleName: string | null | undefined,
): T | null {
  if (!schedules.length) return null;
  const wanted = employeeScheduleName?.trim();
  if (wanted) {
    const match = schedules.find((s) => s.name.trim() === wanted);
    if (match) return match;
  }
  return schedules.length === 1 ? schedules[0] : null;
}

/** Scheduled punch times ("HH:MM") used to fill a missing punch when a correction is approved. */
export function defaultPunchTimes(schedule: ScheduleLike | null | undefined): { startTime: string; endTime: string } {
  if (schedule && schedule.shiftType !== 'FLEXIBLE') {
    const start = normalizeTimeOfDay(schedule.startTime);
    const end = normalizeTimeOfDay(schedule.shiftType === 'TWO_SHIFTS' ? (schedule.endTime2 ?? schedule.endTime) : schedule.endTime);
    if (start && end) return { startTime: start, endTime: end };
  }
  if (schedule?.shiftType === 'FLEXIBLE' && schedule.flexibleHours) {
    const start = parseTimeOfDay(FALLBACK_SHIFT.startTime) as number;
    const endMin = (start + Math.round(schedule.flexibleHours * 60)) % DAY_MIN;
    return { startTime: FALLBACK_SHIFT.startTime, endTime: normalizeTimeOfDay(`${Math.floor(endMin / 60)}:${String(endMin % 60).padStart(2, '0')}`) ?? FALLBACK_SHIFT.endTime };
  }
  return { ...FALLBACK_SHIFT };
}
