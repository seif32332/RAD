import { describe, expect, it } from 'vitest';
import { riyadhDateTime } from '@/lib/attendance';
import {
  PUNCH_REASONS,
  SELF_ATTENDANCE_SETTING_KEYS as K,
  checkFace,
  checkLocation,
  cosineSimilarity,
  decidePunch,
  parseSelfAttendanceSettings,
  previousDayKey,
  resolvePunchPlan,
  tooSoonAfterCheckIn,
  type AttendanceDayRow,
  type FaceAnalysis,
} from '@/lib/self-attendance';

const at = (day: string, time: string) => riyadhDateTime(day, time) as Date;
const dayShift = { shiftType: 'ONE_SHIFT', startTime: '08:00', endTime: '17:00' };
const nightShift = { shiftType: 'ONE_SHIFT', startTime: '22:00', endTime: '06:00' };
const row = (dayKey: string, checkIn: Date | null, checkOut: Date | null, id = `att-${dayKey}`): AttendanceDayRow => ({ id, dayKey, checkIn, checkOut });

describe('parseSelfAttendanceSettings', () => {
  it('uses the defaults when nothing is stored (feature off)', () => {
    const s = parseSelfAttendanceSettings([]);
    expect(s).toEqual({
      enabled: false,
      gpsMaxAccuracyM: 100,
      defaultRadiusM: 150,
      faceAccept: 0.42,
      faceMin: 0.36,
      livenessAccept: 0.7,
      livenessMin: 0.5,
      selfieRetentionDays: 90,
    });
  });

  it('reads valid values and ignores invalid / out-of-range ones', () => {
    const s = parseSelfAttendanceSettings([
      { key: K.enabled, value: '1' },
      { key: K.gpsMaxAccuracyM, value: '"60"' },
      { key: K.defaultRadiusM, value: '5000' }, // above max -> default
      { key: K.faceAcceptPct, value: 'abc' }, // not a number -> default
      { key: K.selfieRetentionDays, value: '30' },
    ]);
    expect(s.enabled).toBe(true);
    expect(s.gpsMaxAccuracyM).toBe(60);
    expect(s.defaultRadiusM).toBe(150);
    expect(s.faceAccept).toBe(0.42);
    expect(s.selfieRetentionDays).toBe(30);
  });

  it('never lets the reject threshold exceed the accept threshold', () => {
    const s = parseSelfAttendanceSettings([
      { key: K.faceAcceptPct, value: '40' },
      { key: K.faceMinPct, value: '60' },
      { key: K.livenessAcceptPct, value: '55' },
      { key: K.livenessMinPct, value: '90' },
    ]);
    expect(s.faceMin).toBe(0.4);
    expect(s.livenessMin).toBe(0.55);
  });
});

describe('checkLocation', () => {
  const fences = [{ id: 'loc1', name: 'المقر', latitude: 24.7136, longitude: 46.6753, radiusM: 150 }];
  const inside = { latitude: 24.7140, longitude: 46.6753 }; // ~44 m
  const outside = { latitude: 24.7236, longitude: 46.6753 }; // ~1.1 km

  it('accepts a precise point inside a fence', () => {
    const r = checkLocation({ exempt: false, point: inside, accuracyM: 20, fences, maxAccuracyM: 100 });
    expect(r.reasons).toEqual([]);
    expect(r.nearest?.fence.id).toBe('loc1');
  });

  it('rejects outside the fence and reports the distance', () => {
    const r = checkLocation({ exempt: false, point: outside, accuracyM: 10, fences, maxAccuracyM: 100 });
    expect(r.reasons).toEqual([PUNCH_REASONS.OUTSIDE_GEOFENCE]);
    expect(Math.round(r.nearest?.distanceM ?? 0)).toBeGreaterThan(1000);
  });

  it('rejects an imprecise position even when its center is inside', () => {
    expect(checkLocation({ exempt: false, point: inside, accuracyM: 250, fences, maxAccuracyM: 100 }).reasons).toEqual([PUNCH_REASONS.LOW_GPS_ACCURACY]);
    expect(checkLocation({ exempt: false, point: inside, accuracyM: null, fences, maxAccuracyM: 100 }).reasons).toEqual([PUNCH_REASONS.LOW_GPS_ACCURACY]);
  });

  it('rejects when the branch has no location or the point is missing', () => {
    expect(checkLocation({ exempt: false, point: inside, accuracyM: 5, fences: [], maxAccuracyM: 100 }).reasons).toEqual([PUNCH_REASONS.NO_LOCATIONS_CONFIGURED]);
    expect(checkLocation({ exempt: false, point: null, accuracyM: null, fences, maxAccuracyM: 100 }).reasons).toEqual([PUNCH_REASONS.LOCATION_MISSING]);
  });

  it('exempt employees pass anywhere (the nearest fence is still recorded)', () => {
    const r = checkLocation({ exempt: true, point: outside, accuracyM: 500, fences, maxAccuracyM: 100 });
    expect(r.reasons).toEqual([PUNCH_REASONS.GEO_EXEMPT]);
    expect(r.nearest?.inside).toBe(false);
  });
});

describe('checkFace', () => {
  const settings = { faceAccept: 0.42, faceMin: 0.36, livenessAccept: 0.7, livenessMin: 0.5 };
  const ok: FaceAnalysis = { faces: 1, liveness: 0.93, embedding: [1, 0] };

  it('accepts a live, matching face', () => {
    expect(checkFace({ exempt: false, enrolled: true, analysis: ok, similarity: 0.61, settings })).toEqual([]);
  });

  it('rejects a mismatch and flags a borderline match', () => {
    expect(checkFace({ exempt: false, enrolled: true, analysis: ok, similarity: 0.2, settings })).toEqual([PUNCH_REASONS.FACE_MISMATCH]);
    expect(checkFace({ exempt: false, enrolled: true, analysis: ok, similarity: 0.38, settings })).toEqual([PUNCH_REASONS.FACE_BORDERLINE]);
  });

  it('rejects likely spoofs and flags borderline liveness', () => {
    expect(checkFace({ exempt: false, enrolled: true, analysis: { ...ok, liveness: 0.3 }, similarity: 0.8, settings })).toEqual([PUNCH_REASONS.SPOOF_SUSPECTED]);
    expect(checkFace({ exempt: false, enrolled: true, analysis: { ...ok, liveness: 0.6 }, similarity: 0.8, settings })).toEqual([PUNCH_REASONS.LIVENESS_BORDERLINE]);
    expect(checkFace({ exempt: false, enrolled: true, analysis: { ...ok, liveness: null }, similarity: 0.8, settings })).toEqual([PUNCH_REASONS.SPOOF_SUSPECTED]);
  });

  it('rejects no face / several faces / unavailable service / no enrollment (fail closed)', () => {
    expect(checkFace({ exempt: false, enrolled: true, analysis: { faces: 0, liveness: null, embedding: null }, similarity: null, settings })).toEqual([PUNCH_REASONS.NO_FACE]);
    expect(checkFace({ exempt: false, enrolled: true, analysis: { faces: 2, liveness: 0.9, embedding: null }, similarity: null, settings })).toEqual([PUNCH_REASONS.MULTIPLE_FACES]);
    expect(checkFace({ exempt: false, enrolled: true, analysis: null, similarity: null, settings })).toEqual([PUNCH_REASONS.FACE_SERVICE_UNAVAILABLE]);
    expect(checkFace({ exempt: false, enrolled: false, analysis: ok, similarity: 0.9, settings })).toEqual([PUNCH_REASONS.NOT_ENROLLED]);
  });

  it('exempt employees skip the face check', () => {
    expect(checkFace({ exempt: true, enrolled: false, analysis: null, similarity: null, settings })).toEqual([PUNCH_REASONS.FACE_EXEMPT]);
  });
});

describe('decidePunch', () => {
  it('rejection beats flag beats accept; informational reasons do not matter', () => {
    expect(decidePunch([])).toBe('ACCEPTED');
    expect(decidePunch([PUNCH_REASONS.GEO_EXEMPT])).toBe('ACCEPTED');
    expect(decidePunch([PUNCH_REASONS.FACE_BORDERLINE])).toBe('FLAGGED');
    expect(decidePunch([PUNCH_REASONS.FACE_BORDERLINE, PUNCH_REASONS.OUTSIDE_GEOFENCE])).toBe('REJECTED');
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for the same direction, 0 for orthogonal, NaN for bad input', () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBeNaN();
    expect(cosineSimilarity([0, 0], [1, 1])).toBeNaN();
  });
});

describe('resolvePunchPlan', () => {
  const today = '2026-09-25';
  const yesterday = '2026-09-24';

  it('previousDayKey handles month and year boundaries', () => {
    expect(previousDayKey('2026-03-01')).toBe('2026-02-28');
    expect(previousDayKey('2027-01-01')).toBe('2026-12-31');
  });

  it('first punch of the day is a check-in on today', () => {
    const plan = resolvePunchPlan({ now: at(today, '07:55'), schedule: dayShift, todayKey: today, yesterday: null, today: null });
    expect(plan).toEqual({ action: 'IN', dayKey: today, attendanceId: null });
  });

  it('an open record of today gets the check-out', () => {
    const t = row(today, at(today, '08:02'), null);
    const plan = resolvePunchPlan({ now: at(today, '17:05'), schedule: dayShift, todayKey: today, yesterday: null, today: t });
    expect(plan).toMatchObject({ action: 'OUT', dayKey: today, attendanceId: t.id, repunch: false });
  });

  it('a complete ONE_SHIFT day is done; TWO_SHIFTS may re-punch the check-out (last one wins)', () => {
    const t = row(today, at(today, '08:00'), at(today, '12:00'));
    expect(resolvePunchPlan({ now: at(today, '20:00'), schedule: dayShift, todayKey: today, yesterday: null, today: t }).action).toBe('DONE');
    const split = { shiftType: 'TWO_SHIFTS', startTime: '08:00', endTime: '12:00', startTime2: '16:00', endTime2: '20:00' };
    expect(resolvePunchPlan({ now: at(today, '20:05'), schedule: split, todayKey: today, yesterday: null, today: t })).toMatchObject({ action: 'OUT', repunch: true });
  });

  it('overnight shift: the check-out after midnight closes yesterday', () => {
    const y = row(yesterday, at(yesterday, '21:58'), null);
    const plan = resolvePunchPlan({ now: at(today, '06:10'), schedule: nightShift, todayKey: today, yesterday: y, today: null });
    expect(plan).toMatchObject({ action: 'OUT', dayKey: yesterday, attendanceId: y.id });
  });

  it('overnight shift: a late arrival after midnight belongs to yesterday', () => {
    const plan = resolvePunchPlan({ now: at(today, '00:30'), schedule: nightShift, todayKey: today, yesterday: null, today: null });
    expect(plan).toEqual({ action: 'IN', dayKey: yesterday, attendanceId: null });
  });

  it('a forgotten check-out of a day shift is not closed the next morning: new check-in today', () => {
    const y = row(yesterday, at(yesterday, '08:00'), null);
    const plan = resolvePunchPlan({ now: at(today, '07:55'), schedule: dayShift, todayKey: today, yesterday: y, today: null });
    expect(plan).toEqual({ action: 'IN', dayKey: today, attendanceId: null });
  });

  it('without a usable schedule, an open record stays closable for a bounded time only', () => {
    const y = row(yesterday, at(yesterday, '22:00'), null);
    expect(resolvePunchPlan({ now: at(today, '06:00'), schedule: null, todayKey: today, yesterday: y, today: null })).toMatchObject({ action: 'OUT', dayKey: yesterday });
    const flexible = { shiftType: 'FLEXIBLE', flexibleHours: 8 };
    const y2 = row(yesterday, at(yesterday, '17:00'), null);
    expect(resolvePunchPlan({ now: at(today, '08:00'), schedule: flexible, todayKey: today, yesterday: y2, today: null })).toEqual({ action: 'IN', dayKey: today, attendanceId: null });
  });

  it('reuses an existing empty row (e.g. created by a correction without check-in)', () => {
    const t = row(today, null, null, 'existing');
    expect(resolvePunchPlan({ now: at(today, '08:00'), schedule: dayShift, todayKey: today, yesterday: null, today: t })).toEqual({ action: 'IN', dayKey: today, attendanceId: 'existing' });
  });
});

describe('tooSoonAfterCheckIn', () => {
  it('blocks a check-out within 5 minutes of the check-in', () => {
    const inAt = new Date('2026-09-25T05:00:00Z');
    expect(tooSoonAfterCheckIn(inAt, new Date('2026-09-25T05:04:59Z'))).toBe(true);
    expect(tooSoonAfterCheckIn(inAt, new Date('2026-09-25T05:05:00Z'))).toBe(false);
  });
});
