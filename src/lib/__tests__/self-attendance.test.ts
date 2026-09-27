import { describe, expect, it } from 'vitest';
import { riyadhDateTime } from '@/lib/attendance';
import {
  PUNCH_REASONS,
  PUNCH_REASON_MESSAGES,
  SELF_ATTENDANCE_SETTING_KEYS as K,
  checkFace,
  checkLocation,
  cosineSimilarity,
  decidePunch,
  nextDayKey,
  parseSelfAttendanceSettings,
  planForAction,
  previousDayKey,
  rejectionMessage,
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

  it('nextDayKey handles month and year boundaries', () => {
    expect(nextDayKey('2026-02-28')).toBe('2026-03-01');
    expect(nextDayKey('2026-12-31')).toBe('2027-01-01');
  });

  describe('split shift ending after midnight (TWO_SHIFTS)', () => {
    const lateSplit = { shiftType: 'TWO_SHIFTS', startTime: '12:00', endTime: '16:00', startTime2: '19:00', endTime2: '01:00' };
    const midnightSplit = { ...lateSplit, endTime2: '00:00' };
    const y = row(yesterday, at(yesterday, '12:00'), at(yesterday, '16:00'));

    it("re-punches yesterday's last check-out before the shift end", () => {
      expect(resolvePunchPlan({ now: at(today, '00:58'), schedule: lateSplit, todayKey: today, yesterday: y, today: null })).toMatchObject({ action: 'OUT', dayKey: yesterday, attendanceId: y.id, repunch: true });
    });

    it('re-punches it just after the end too, but not once the next shift is near', () => {
      expect(resolvePunchPlan({ now: at(today, '00:05'), schedule: midnightSplit, todayKey: today, yesterday: y, today: null })).toMatchObject({ action: 'OUT', dayKey: yesterday, repunch: true });
      expect(resolvePunchPlan({ now: at(today, '11:30'), schedule: midnightSplit, todayKey: today, yesterday: y, today: null })).toEqual({ action: 'IN', dayKey: today, attendanceId: null });
    });
  });

  describe('shift starting at midnight', () => {
    const midnight = { shiftType: 'ONE_SHIFT', startTime: '00:00', endTime: '08:00' };
    const tomorrow = nextDayKey(today);

    it("an arrival before midnight is the check-in of tomorrow's shift, not a late one of today", () => {
      const t = row(today, at(yesterday, '23:52'), at(today, '08:01'));
      expect(resolvePunchPlan({ now: at(today, '23:50'), schedule: midnight, todayKey: today, yesterday: null, today: t, tomorrow: null })).toEqual({ action: 'IN', dayKey: tomorrow, attendanceId: null });
    });

    it("that early check-in is closed if tapped again, and in the morning as today's record", () => {
      const m = row(tomorrow, at(today, '23:50'), null);
      expect(resolvePunchPlan({ now: at(today, '23:52'), schedule: midnight, todayKey: today, yesterday: null, today: null, tomorrow: m })).toMatchObject({ action: 'OUT', dayKey: tomorrow });
      expect(resolvePunchPlan({ now: at(tomorrow, '08:02'), schedule: midnight, todayKey: tomorrow, yesterday: null, today: m })).toMatchObject({ action: 'OUT', dayKey: tomorrow, attendanceId: m.id });
    });

    it("a late arrival after midnight is today's check-in", () => {
      expect(resolvePunchPlan({ now: at(today, '00:20'), schedule: midnight, todayKey: today, yesterday: null, today: null })).toEqual({ action: 'IN', dayKey: today, attendanceId: null });
    });

    it('a day shift is never pulled to tomorrow in the evening', () => {
      expect(resolvePunchPlan({ now: at(today, '23:30'), schedule: dayShift, todayKey: today, yesterday: null, today: null, tomorrow: null })).toEqual({ action: 'IN', dayKey: today, attendanceId: null });
    });
  });

  it('a 24 h shift can still be closed just after its end', () => {
    const allDay = { shiftType: 'ONE_SHIFT', startTime: '08:00', endTime: '08:00' };
    const y = row(yesterday, at(yesterday, '08:00'), null);
    expect(resolvePunchPlan({ now: at(today, '08:10'), schedule: allDay, todayKey: today, yesterday: y, today: null })).toMatchObject({ action: 'OUT', dayKey: yesterday });
  });

  describe('after a rejected check-in', () => {
    const rejectedIn = { [today]: at(today, '08:05') };

    it('offers the retry first, and the check-out as the other button', () => {
      expect(resolvePunchPlan({ now: at(today, '08:10'), schedule: dayShift, todayKey: today, yesterday: null, today: null, rejectedIn })).toEqual({ action: 'IN', dayKey: today, attendanceId: null, alternative: 'OUT' });
    });

    it('offers the check-out first after the middle of the shift', () => {
      expect(resolvePunchPlan({ now: at(today, '17:00'), schedule: dayShift, todayKey: today, yesterday: null, today: null, rejectedIn })).toEqual({ action: 'OUT', dayKey: today, attendanceId: null, checkIn: null, repunch: false, alternative: 'IN' });
    });

    it('a late arrival past the middle still gets an hour to retry the check-in', () => {
      const late = { [today]: at(today, '13:00') };
      expect(resolvePunchPlan({ now: at(today, '13:05'), schedule: dayShift, todayKey: today, yesterday: null, today: null, rejectedIn: late }).action).toBe('IN');
    });

    it('is ignored once the day has a check-in (retry accepted or correction approved)', () => {
      const t = row(today, at(today, '08:20'), null);
      expect(resolvePunchPlan({ now: at(today, '17:00'), schedule: dayShift, todayKey: today, yesterday: null, today: t, rejectedIn })).toMatchObject({ action: 'OUT', checkIn: t.checkIn, repunch: false });
    });

    it('a check-out recorded without check-in completes the day', () => {
      const t = row(today, null, at(today, '17:00'));
      expect(resolvePunchPlan({ now: at(today, '17:30'), schedule: dayShift, todayKey: today, yesterday: null, today: t, rejectedIn }).action).toBe('DONE');
    });

    it("night shift: leaving records the check-out on the shift's day", () => {
      const night = { [yesterday]: at(yesterday, '22:05') };
      expect(resolvePunchPlan({ now: at(today, '05:50'), schedule: nightShift, todayKey: today, yesterday: null, today: null, rejectedIn: night })).toMatchObject({ action: 'OUT', dayKey: yesterday, checkIn: null, alternative: 'IN' });
      expect(resolvePunchPlan({ now: at(today, '06:10'), schedule: nightShift, todayKey: today, yesterday: null, today: null, rejectedIn: night })).toMatchObject({ action: 'OUT', dayKey: yesterday, checkIn: null });
    });
  });

  it('planForAction accepts the main action or the alternative only', () => {
    const plan = resolvePunchPlan({ now: at(today, '08:10'), schedule: dayShift, todayKey: today, yesterday: null, today: null, rejectedIn: { [today]: at(today, '08:05') } });
    expect(planForAction(plan, 'IN')).toMatchObject({ action: 'IN', dayKey: today });
    expect(planForAction(plan, 'OUT')).toEqual({ action: 'OUT', dayKey: today, attendanceId: null, checkIn: null, repunch: false });
    const plain = resolvePunchPlan({ now: at(today, '08:10'), schedule: dayShift, todayKey: today, yesterday: null, today: null });
    expect(planForAction(plain, 'OUT')).toBeNull();
    const done = resolvePunchPlan({ now: at(today, '20:00'), schedule: dayShift, todayKey: today, yesterday: null, today: row(today, at(today, '08:00'), at(today, '17:00')) });
    expect(planForAction(done, 'IN')).toBeNull();
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

describe('rejectionMessage', () => {
  it('gives the distance and the allowed radius when outside the fence', () => {
    const m = rejectionMessage([PUNCH_REASONS.OUTSIDE_GEOFENCE], { nearest: { distanceM: 419.6, name: 'المقر', radiusM: 150 } });
    expect(m).toContain('420 م');
    expect(m).toContain('«المقر»');
    expect(m).toContain('150 م');
  });

  it('gives the measured and the required accuracy when the GPS fix is weak', () => {
    const m = rejectionMessage([PUNCH_REASONS.LOW_GPS_ACCURACY], { accuracyM: 348.2, maxAccuracyM: 100 });
    expect(m).toContain('348 م');
    expect(m).toContain('100 م');
  });

  it('falls back to the generic text without measurements', () => {
    expect(rejectionMessage([PUNCH_REASONS.LOW_GPS_ACCURACY])).toBe(PUNCH_REASON_MESSAGES.LOW_GPS_ACCURACY);
    expect(rejectionMessage([PUNCH_REASONS.OUTSIDE_GEOFENCE], { nearest: null })).toBe(PUNCH_REASON_MESSAGES.OUTSIDE_GEOFENCE);
  });

  it('reports the first rejection reason, not a flag', () => {
    expect(rejectionMessage([PUNCH_REASONS.ON_LEAVE, PUNCH_REASONS.FACE_MISMATCH])).toBe(PUNCH_REASON_MESSAGES.FACE_MISMATCH);
  });
});
