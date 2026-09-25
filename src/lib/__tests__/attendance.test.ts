import { describe, expect, it } from 'vitest';
import {
  buildPunches,
  computeLateEarly,
  defaultPunchTimes,
  normalizeTimeOfDay,
  parseTimeOfDay,
  pickEmployeeSchedule,
  riyadhDateTime,
  scheduledShift,
} from '@/lib/attendance';

const DAY = '2026-09-23';

describe('time parsing', () => {
  it('parses HH:MM, H:MM and HH:MM:SS', () => {
    expect(parseTimeOfDay('08:30')).toBe(510);
    expect(parseTimeOfDay('8:05')).toBe(485);
    expect(parseTimeOfDay('23:59:59')).toBe(1439);
    expect(parseTimeOfDay('00:00')).toBe(0);
  });

  it('rejects invalid times', () => {
    expect(parseTimeOfDay('24:00')).toBeNull();
    expect(parseTimeOfDay('12:60')).toBeNull();
    expect(parseTimeOfDay('8am')).toBeNull();
    expect(parseTimeOfDay('')).toBeNull();
    expect(parseTimeOfDay(null)).toBeNull();
    expect(normalizeTimeOfDay('8:5')).toBeNull();
    expect(normalizeTimeOfDay('8:05')).toBe('08:05');
  });

  it('riyadhDateTime converts Riyadh wall-clock time to UTC', () => {
    expect(riyadhDateTime(DAY, '08:00')?.toISOString()).toBe('2026-09-23T05:00:00.000Z');
    expect(riyadhDateTime(DAY, '01:30')?.toISOString()).toBe('2026-09-22T22:30:00.000Z');
    expect(riyadhDateTime('2026-9-23', '08:00')).toBeNull();
    expect(riyadhDateTime(DAY, 'bad')).toBeNull();
  });

  it('buildPunches rolls an earlier check-out into the next day', () => {
    const p = buildPunches(DAY, '22:00', '06:00');
    expect(p.checkIn?.toISOString()).toBe('2026-09-23T19:00:00.000Z');
    expect(p.checkOut?.toISOString()).toBe('2026-09-24T03:00:00.000Z');
    expect(buildPunches(DAY, '08:00', null)).toEqual({ checkIn: new Date('2026-09-23T05:00:00.000Z'), checkOut: null });
  });
});

describe('scheduledShift', () => {
  it('uses the first start and the last end of a two-shift day', () => {
    const s = scheduledShift({ shiftType: 'TWO_SHIFTS', startTime: '08:00', endTime: '12:00', startTime2: '16:00', endTime2: '20:00' }, DAY);
    expect(s?.start.toISOString()).toBe('2026-09-23T05:00:00.000Z');
    expect(s?.end.toISOString()).toBe('2026-09-23T17:00:00.000Z');
  });

  it('returns null for flexible or incomplete schedules', () => {
    expect(scheduledShift({ shiftType: 'FLEXIBLE', flexibleHours: 8 }, DAY)).toBeNull();
    expect(scheduledShift({ shiftType: 'ONE_SHIFT', startTime: '08:00' }, DAY)).toBeNull();
    expect(scheduledShift(null, DAY)).toBeNull();
  });
});

describe('computeLateEarly', () => {
  const oneShift = { shiftType: 'ONE_SHIFT', startTime: '08:00', endTime: '16:00' };

  it('computes late arrival and early leave against the schedule', () => {
    const { checkIn, checkOut } = buildPunches(DAY, '08:15', '15:50');
    expect(computeLateEarly({ schedule: oneShift, dayKey: DAY, checkIn, checkOut })).toEqual({
      lateMinutes: 15,
      earlyLeaveMin: 10,
      overtimeMin: 0,
      workedMinutes: 455,
      hasSchedule: true,
    });
  });

  it('on-time with overtime after the shift end', () => {
    const { checkIn, checkOut } = buildPunches(DAY, '07:55', '17:30');
    expect(computeLateEarly({ schedule: oneShift, dayKey: DAY, checkIn, checkOut })).toMatchObject({
      lateMinutes: 0,
      earlyLeaveMin: 0,
      overtimeMin: 90,
    });
  });

  it('handles overnight shifts', () => {
    const night = { shiftType: 'ONE_SHIFT', startTime: '22:00', endTime: '06:00' };
    const { checkIn, checkOut } = buildPunches(DAY, '22:05', '06:30');
    expect(computeLateEarly({ schedule: night, dayKey: DAY, checkIn, checkOut })).toMatchObject({
      lateMinutes: 5,
      earlyLeaveMin: 0,
      overtimeMin: 30,
      workedMinutes: 505,
    });
  });

  it('two shifts: early leave is measured against the end of the second shift', () => {
    const two = { shiftType: 'TWO_SHIFTS', startTime: '08:00', endTime: '12:00', startTime2: '16:00', endTime2: '20:00' };
    const { checkIn, checkOut } = buildPunches(DAY, '08:00', '19:30');
    expect(computeLateEarly({ schedule: two, dayKey: DAY, checkIn, checkOut })).toMatchObject({ lateMinutes: 0, earlyLeaveMin: 30 });
  });

  it('flexible schedules compare worked time with the required hours', () => {
    const flex = { shiftType: 'FLEXIBLE', flexibleHours: 8 };
    const short = buildPunches(DAY, '10:00', '17:00');
    expect(computeLateEarly({ schedule: flex, dayKey: DAY, ...short })).toEqual({
      lateMinutes: 0,
      earlyLeaveMin: 60,
      overtimeMin: 0,
      workedMinutes: 420,
      hasSchedule: true,
    });
    const long = buildPunches(DAY, '10:00', '19:15');
    expect(computeLateEarly({ schedule: flex, dayKey: DAY, ...long }).overtimeMin).toBe(75);
  });

  it('exempt employees and missing schedules produce no lateness', () => {
    const { checkIn, checkOut } = buildPunches(DAY, '11:00', '12:00');
    expect(computeLateEarly({ schedule: { ...oneShift, isExemptFromAttendance: true }, dayKey: DAY, checkIn, checkOut })).toMatchObject({
      lateMinutes: 0,
      earlyLeaveMin: 0,
      hasSchedule: true,
    });
    expect(computeLateEarly({ schedule: null, dayKey: DAY, checkIn, checkOut })).toMatchObject({
      lateMinutes: 0,
      earlyLeaveMin: 0,
      workedMinutes: 60,
      hasSchedule: false,
    });
  });

  it('only a check-in: lateness without early leave', () => {
    const { checkIn } = buildPunches(DAY, '09:00');
    expect(computeLateEarly({ schedule: oneShift, dayKey: DAY, checkIn, checkOut: null })).toMatchObject({
      lateMinutes: 60,
      earlyLeaveMin: 0,
      workedMinutes: 0,
    });
  });
});

describe('pickEmployeeSchedule / defaultPunchTimes', () => {
  const a = { name: 'صباحي', shiftType: 'ONE_SHIFT', startTime: '08:00', endTime: '16:00' };
  const b = { name: 'مسائي', shiftType: 'ONE_SHIFT', startTime: '16:00', endTime: '00:00' };

  it('matches by name, falls back to the only schedule, otherwise null', () => {
    expect(pickEmployeeSchedule([a, b], ' مسائي ')).toBe(b);
    expect(pickEmployeeSchedule([a], 'غير موجود')).toBe(a);
    expect(pickEmployeeSchedule([a, b], null)).toBeNull();
    expect(pickEmployeeSchedule([], 'صباحي')).toBeNull();
  });

  it('default punch times come from the schedule', () => {
    expect(defaultPunchTimes(a)).toEqual({ startTime: '08:00', endTime: '16:00' });
    expect(defaultPunchTimes({ shiftType: 'FLEXIBLE', flexibleHours: 8.5 })).toEqual({ startTime: '09:00', endTime: '17:30' });
    expect(defaultPunchTimes(null)).toEqual({ startTime: '09:00', endTime: '17:00' });
  });
});
