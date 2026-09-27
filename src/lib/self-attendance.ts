// Self clock-in / clock-out rules (portal GPS geofence + face verification). PURE functions only
// (no prisma, no server imports): the API routes load the data, these functions decide.
//
// Trust model: the server clock is the only clock. Coordinates and the selfie come from the
// client and can be forged by a determined user (fake-GPS apps, a photo of a face); the checks
// here raise the cost of cheating and leave evidence (AttendancePunch), they do not make it
// impossible. Never describe the feature as "tamper-proof" (DEC-005).
import { scheduledShift, type ScheduleLike } from '@/lib/attendance';
import { nearestFence, type GeoFence, type LatLng, type NearestFence } from '@/lib/geo';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Version of the biometric / location notice the employee accepted (FaceProfile.consentVersion).
 * Bump it whenever the notice text in src/app/portal/_components/ClockCard.tsx changes: enrolled
 * employees are then asked to accept the new text before their next punch.
 * v2 (approved by the owner on 2026-09-26): retention period in days + HR as the contact for requests.
 */
export const FACE_CONSENT_VERSION = '2026-09-v2';

/**
 * FaceProfile.model once the employee withdrew consent: the template and the photo are deleted
 * but the row stays as a marker, so enrolling again needs HR (RESET_FACE deletes the marker).
 * Without it, "withdraw then enroll someone else's face" would bypass the enrollment lock.
 */
export const FACE_PROFILE_WITHDRAWN = 'withdrawn';

/** Minimum gap between a check-in and the check-out of the same record (double-tap guard). */
export const MIN_PUNCH_GAP_MS = 5 * 60 * 1000;
/** A still-open record of yesterday can be closed until its scheduled end + this grace. */
export const OUT_GRACE_MS = 6 * HOUR_MS;

// ---------------------------------------------------------------------------
// Settings (SystemSetting keys; limits are shared with src/app/api/settings/definitions.ts)
// ---------------------------------------------------------------------------

export const SELF_ATTENDANCE_SETTING_KEYS = {
  enabled: 'self_attendance_enabled',
  gpsMaxAccuracyM: 'attendance_gps_max_accuracy_m',
  defaultRadiusM: 'attendance_geofence_default_radius_m',
  faceAcceptPct: 'attendance_face_accept_pct',
  faceMinPct: 'attendance_face_min_pct',
  livenessAcceptPct: 'attendance_liveness_accept_pct',
  livenessMinPct: 'attendance_liveness_min_pct',
  selfieRetentionDays: 'attendance_selfie_retention_days',
} as const;

type SettingField = keyof typeof SELF_ATTENDANCE_SETTING_KEYS;

/** Defaults and allowed ranges (integers). Face / liveness values are percentages. */
export const SELF_ATTENDANCE_SETTING_LIMITS: Readonly<Record<SettingField, { defaultValue: number; min: number; max: number }>> = {
  enabled: { defaultValue: 0, min: 0, max: 1 },
  gpsMaxAccuracyM: { defaultValue: 100, min: 10, max: 1000 },
  defaultRadiusM: { defaultValue: 150, min: 30, max: 2000 },
  // SFace cosine similarity: OpenCV's reference threshold is 0.363. Below "min" -> rejected,
  // between "min" and "accept" -> accepted but flagged for review. Calibrate during the pilot.
  faceAcceptPct: { defaultValue: 42, min: 20, max: 95 },
  faceMinPct: { defaultValue: 36, min: 10, max: 95 },
  livenessAcceptPct: { defaultValue: 70, min: 0, max: 100 },
  livenessMinPct: { defaultValue: 50, min: 0, max: 100 },
  selfieRetentionDays: { defaultValue: 90, min: 1, max: 365 },
};

export interface SelfAttendanceSettings {
  enabled: boolean;
  gpsMaxAccuracyM: number;
  defaultRadiusM: number;
  /** Cosine similarity (0..1) at or above which the face is accepted. */
  faceAccept: number;
  /** Cosine similarity (0..1) below which the face is rejected. */
  faceMin: number;
  /** Liveness score (0..1) at or above which the capture is accepted. */
  livenessAccept: number;
  /** Liveness score (0..1) below which the capture is rejected as a likely spoof. */
  livenessMin: number;
  selfieRetentionDays: number;
}

function intSetting(raw: string | undefined, field: SettingField): number {
  const { defaultValue, min, max } = SELF_ATTENDANCE_SETTING_LIMITS[field];
  if (raw === undefined) return defaultValue;
  const v = String(raw).trim().replace(/^"(.*)"$/, '$1');
  const n = Number(v);
  if (v === '' || !Number.isFinite(n) || n < min || n > max) return defaultValue;
  return Math.floor(n);
}

/** Settings from SystemSetting rows; missing / invalid values use the defaults. "min" never exceeds "accept". */
export function parseSelfAttendanceSettings(rows: ReadonlyArray<{ key: string; value: string }>): SelfAttendanceSettings {
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const get = (field: SettingField) => intSetting(map.get(SELF_ATTENDANCE_SETTING_KEYS[field]), field);
  const faceAcceptPct = get('faceAcceptPct');
  const livenessAcceptPct = get('livenessAcceptPct');
  return {
    enabled: get('enabled') === 1,
    gpsMaxAccuracyM: get('gpsMaxAccuracyM'),
    defaultRadiusM: get('defaultRadiusM'),
    faceAccept: faceAcceptPct / 100,
    faceMin: Math.min(get('faceMinPct'), faceAcceptPct) / 100,
    livenessAccept: livenessAcceptPct / 100,
    livenessMin: Math.min(get('livenessMinPct'), livenessAcceptPct) / 100,
    selfieRetentionDays: get('selfieRetentionDays'),
  };
}

// ---------------------------------------------------------------------------
// Reason codes
// ---------------------------------------------------------------------------

export const PUNCH_REASONS = {
  // Rejections
  LOCATION_MISSING: 'LOCATION_MISSING',
  NO_LOCATIONS_CONFIGURED: 'NO_LOCATIONS_CONFIGURED',
  LOW_GPS_ACCURACY: 'LOW_GPS_ACCURACY',
  OUTSIDE_GEOFENCE: 'OUTSIDE_GEOFENCE',
  NOT_ENROLLED: 'NOT_ENROLLED',
  FACE_SERVICE_UNAVAILABLE: 'FACE_SERVICE_UNAVAILABLE',
  NO_FACE: 'NO_FACE',
  MULTIPLE_FACES: 'MULTIPLE_FACES',
  FACE_MISMATCH: 'FACE_MISMATCH',
  SPOOF_SUSPECTED: 'SPOOF_SUSPECTED',
  // Accepted with a flag (manager / HR review)
  FACE_BORDERLINE: 'FACE_BORDERLINE',
  LIVENESS_BORDERLINE: 'LIVENESS_BORDERLINE',
  ON_LEAVE: 'ON_LEAVE',
  // Informational
  GEO_EXEMPT: 'GEO_EXEMPT',
  FACE_EXEMPT: 'FACE_EXEMPT',
} as const;

export type PunchReason = (typeof PUNCH_REASONS)[keyof typeof PUNCH_REASONS];

const REJECT_REASONS: ReadonlySet<PunchReason> = new Set<PunchReason>([
  PUNCH_REASONS.LOCATION_MISSING,
  PUNCH_REASONS.NO_LOCATIONS_CONFIGURED,
  PUNCH_REASONS.LOW_GPS_ACCURACY,
  PUNCH_REASONS.OUTSIDE_GEOFENCE,
  PUNCH_REASONS.NOT_ENROLLED,
  PUNCH_REASONS.FACE_SERVICE_UNAVAILABLE,
  PUNCH_REASONS.NO_FACE,
  PUNCH_REASONS.MULTIPLE_FACES,
  PUNCH_REASONS.FACE_MISMATCH,
  PUNCH_REASONS.SPOOF_SUSPECTED,
]);

const FLAG_REASONS: ReadonlySet<PunchReason> = new Set<PunchReason>([
  PUNCH_REASONS.FACE_BORDERLINE,
  PUNCH_REASONS.LIVENESS_BORDERLINE,
  PUNCH_REASONS.ON_LEAVE,
]);

/** Employee-facing Arabic text of each reason. */
export const PUNCH_REASON_MESSAGES: Readonly<Record<PunchReason, string>> = {
  LOCATION_MISSING: 'تعذر الحصول على موقعك. اسمح للمتصفح بالوصول إلى الموقع ثم حاول مرة أخرى.',
  NO_LOCATIONS_CONFIGURED: 'لم يُحدَّد موقع حضور لفرعك بعد. تواصل مع الموارد البشرية.',
  LOW_GPS_ACCURACY: 'دقة تحديد الموقع ضعيفة. فعّل الموقع الدقيق (GPS) واقترب من مكان مكشوف ثم حاول مرة أخرى.',
  OUTSIDE_GEOFENCE: 'أنت خارج نطاق موقع العمل.',
  NOT_ENROLLED: 'يجب تسجيل صورة الوجه المرجعية أولاً.',
  FACE_SERVICE_UNAVAILABLE: 'خدمة التحقق من الوجه غير متاحة الآن. حاول بعد قليل أو ارفع طلب تصحيح.',
  NO_FACE: 'لم يظهر وجه واضح في الصورة. اجعل وجهك داخل الإطار في مكان مضاء.',
  MULTIPLE_FACES: 'ظهر أكثر من وجه في الصورة. يجب أن تكون وحدك في الصورة.',
  FACE_MISMATCH: 'الوجه لا يطابق صورتك المسجلة.',
  SPOOF_SUSPECTED: 'تعذر التأكد من أن الصورة ملتقطة مباشرة لوجهك. صوّر وجهك مباشرة دون شاشة أو صورة مطبوعة.',
  FACE_BORDERLINE: 'تطابق الوجه منخفض: سُجّلت الحركة وستتم مراجعتها.',
  LIVENESS_BORDERLINE: 'جودة الالتقاط منخفضة: سُجّلت الحركة وستتم مراجعتها.',
  ON_LEAVE: 'أنت مسجّل في إجازة: سُجّلت الحركة وستتم مراجعتها.',
  GEO_EXEMPT: 'مستثنى من شرط الموقع.',
  FACE_EXEMPT: 'مستثنى من التحقق من الوجه.',
};

/** Short labels for HR tables. */
export const PUNCH_REASON_LABELS: Readonly<Record<PunchReason, string>> = {
  LOCATION_MISSING: 'بدون موقع',
  NO_LOCATIONS_CONFIGURED: 'لا مواقع للفرع',
  LOW_GPS_ACCURACY: 'دقة موقع ضعيفة',
  OUTSIDE_GEOFENCE: 'خارج النطاق',
  NOT_ENROLLED: 'الوجه غير مسجل',
  FACE_SERVICE_UNAVAILABLE: 'خدمة الوجه متوقفة',
  NO_FACE: 'لا يظهر وجه',
  MULTIPLE_FACES: 'أكثر من وجه',
  FACE_MISMATCH: 'وجه غير مطابق',
  SPOOF_SUSPECTED: 'اشتباه صورة أو شاشة',
  FACE_BORDERLINE: 'تطابق منخفض',
  LIVENESS_BORDERLINE: 'التقاط ضعيف',
  ON_LEAVE: 'في إجازة',
  GEO_EXEMPT: 'مستثنى من الموقع',
  FACE_EXEMPT: 'مستثنى من الوجه',
};

/** Conditions that prevent a punch before any location / camera step (no AttendancePunch is written). */
export const SELF_ATTENDANCE_BLOCKERS = {
  DISABLED: 'DISABLED',
  TERMINATED: 'TERMINATED',
  NO_LOCATIONS_CONFIGURED: 'NO_LOCATIONS_CONFIGURED',
  FACE_WITHDRAWN: 'FACE_WITHDRAWN',
  DAY_COMPLETE: 'DAY_COMPLETE',
} as const;

export type SelfAttendanceBlocker = (typeof SELF_ATTENDANCE_BLOCKERS)[keyof typeof SELF_ATTENDANCE_BLOCKERS];

export const SELF_ATTENDANCE_BLOCKER_MESSAGES: Readonly<Record<SelfAttendanceBlocker, string>> = {
  DISABLED: 'تسجيل الحضور من البوابة غير مفعّل في منشأتك.',
  TERMINATED: 'لا يمكن تسجيل الحضور بعد انتهاء الخدمة.',
  NO_LOCATIONS_CONFIGURED: PUNCH_REASON_MESSAGES.NO_LOCATIONS_CONFIGURED,
  FACE_WITHDRAWN: 'سحبت موافقتك على التحقق من الوجه وحُذفت بياناته. لتسجيل الحضور من البوابة مرة أخرى تواصل مع الموارد البشرية لإعادة فتح تسجيل الوجه.',
  DAY_COMPLETE: 'سجلت حضورك وانصرافك لهذا اليوم. إذا كان هناك خطأ فارفع طلب تصحيح.',
};

/** DAY_COMPLETE when only the check-out was recorded (the check-in was rejected and not corrected yet). */
export const DAY_COMPLETE_WITHOUT_CHECK_IN_MESSAGE = 'سجلت انصرافك لهذا اليوم، لكن حضورك غير مسجل. إن لم ترفع طلب تصحيح لمحاولة الحضور المرفوضة فارفعه الآن.';

/** Measurements that make a location rejection actionable for the employee. */
export interface RejectionContext {
  nearest?: { distanceM: number; name: string; radiusM?: number } | null;
  accuracyM?: number | null;
  maxAccuracyM?: number;
}

/** Employee-facing message for a rejected punch (first rejection reason), with the measured numbers for location problems. */
export function rejectionMessage(reasons: readonly PunchReason[], context: RejectionContext = {}): string {
  const first = reasons.find((r) => REJECT_REASONS.has(r)) ?? reasons[0];
  if (!first) return 'تعذر تسجيل الحركة.';
  const { nearest, accuracyM, maxAccuracyM } = context;
  if (first === PUNCH_REASONS.OUTSIDE_GEOFENCE && nearest) {
    const allowed = nearest.radiusM ? `، والمسموح حتى ${nearest.radiusM} م` : '';
    return `${PUNCH_REASON_MESSAGES.OUTSIDE_GEOFENCE} تبعد نحو ${Math.round(nearest.distanceM)} م عن «${nearest.name}»${allowed}.`;
  }
  if (first === PUNCH_REASONS.LOW_GPS_ACCURACY && accuracyM !== null && accuracyM !== undefined && Number.isFinite(accuracyM) && maxAccuracyM) {
    return `دقة تحديد موقعك الآن نحو ${Math.round(accuracyM)} م، والمطلوب ${maxAccuracyM} م أو أقل. فعّل الموقع الدقيق (GPS) وانتظر قليلاً، أو اقترب من نافذة أو مكان مكشوف، ثم حاول مرة أخرى.`;
  }
  return PUNCH_REASON_MESSAGES[first];
}

export function isRejectReason(reason: string): boolean {
  return REJECT_REASONS.has(reason as PunchReason);
}

export type PunchResultCode = 'ACCEPTED' | 'FLAGGED' | 'REJECTED';

/** Any rejection reason -> REJECTED; else any flag reason -> FLAGGED; else ACCEPTED. */
export function decidePunch(reasons: readonly PunchReason[]): PunchResultCode {
  if (reasons.some((r) => REJECT_REASONS.has(r))) return 'REJECTED';
  if (reasons.some((r) => FLAG_REASONS.has(r))) return 'FLAGGED';
  return 'ACCEPTED';
}

// ---------------------------------------------------------------------------
// Location check
// ---------------------------------------------------------------------------

export interface NamedFence extends GeoFence {
  id: string;
  name: string;
}

export interface LocationCheckInput {
  exempt: boolean;
  point: LatLng | null;
  accuracyM: number | null;
  fences: readonly NamedFence[];
  maxAccuracyM: number;
}

export interface LocationCheck {
  reasons: PunchReason[];
  nearest: NearestFence<NamedFence> | null;
}

export function checkLocation(input: LocationCheckInput): LocationCheck {
  const nearest = input.point && input.fences.length ? nearestFence(input.point, input.fences) : null;
  if (input.exempt) return { reasons: [PUNCH_REASONS.GEO_EXEMPT], nearest };
  if (!input.fences.length) return { reasons: [PUNCH_REASONS.NO_LOCATIONS_CONFIGURED], nearest: null };
  if (!input.point) return { reasons: [PUNCH_REASONS.LOCATION_MISSING], nearest: null };
  // A position this imprecise cannot tell inside from outside: reject rather than guess.
  if (input.accuracyM === null || !Number.isFinite(input.accuracyM) || input.accuracyM > input.maxAccuracyM) {
    return { reasons: [PUNCH_REASONS.LOW_GPS_ACCURACY], nearest };
  }
  if (!nearest || !nearest.inside) return { reasons: [PUNCH_REASONS.OUTSIDE_GEOFENCE], nearest };
  return { reasons: [], nearest };
}

// ---------------------------------------------------------------------------
// Face check
// ---------------------------------------------------------------------------

/** What the face service reports for one image (see services/face). */
export interface FaceAnalysis {
  faces: number;
  /** 0..1, higher = more likely a live capture. null when not computed. */
  liveness: number | null;
  embedding: number[] | null;
}

export interface FaceCheckInput {
  exempt: boolean;
  enrolled: boolean;
  /** null = the service could not be reached / timed out / is not configured. */
  analysis: FaceAnalysis | null;
  /** Cosine similarity between the capture and the enrolled template (null if not computed). */
  similarity: number | null;
  settings: Pick<SelfAttendanceSettings, 'faceAccept' | 'faceMin' | 'livenessAccept' | 'livenessMin'>;
}

export function checkFace(input: FaceCheckInput): PunchReason[] {
  if (input.exempt) return [PUNCH_REASONS.FACE_EXEMPT];
  if (!input.enrolled) return [PUNCH_REASONS.NOT_ENROLLED];
  const a = input.analysis;
  if (!a) return [PUNCH_REASONS.FACE_SERVICE_UNAVAILABLE];
  if (a.faces === 0) return [PUNCH_REASONS.NO_FACE];
  if (a.faces > 1) return [PUNCH_REASONS.MULTIPLE_FACES];

  const reasons: PunchReason[] = [];
  const s = input.settings;
  if (a.liveness === null || a.liveness < s.livenessMin) reasons.push(PUNCH_REASONS.SPOOF_SUSPECTED);
  else if (a.liveness < s.livenessAccept) reasons.push(PUNCH_REASONS.LIVENESS_BORDERLINE);

  if (input.similarity === null || !Number.isFinite(input.similarity) || input.similarity < s.faceMin) reasons.push(PUNCH_REASONS.FACE_MISMATCH);
  else if (input.similarity < s.faceAccept) reasons.push(PUNCH_REASONS.FACE_BORDERLINE);
  return reasons;
}

/** Cosine similarity of two vectors; NaN when they differ in length or one is all zeros. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return NaN;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return NaN;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---------------------------------------------------------------------------
// Which record does a punch belong to?
// ---------------------------------------------------------------------------

/** Attendance row reduced to what the planner needs. dayKey = Attendance.date as 'YYYY-MM-DD'. */
export interface AttendanceDayRow {
  id: string;
  dayKey: string;
  checkIn: Date | null;
  checkOut: Date | null;
}

export type PunchAction = 'IN' | 'OUT';

export type PunchPlan =
  | {
      action: 'IN';
      dayKey: string;
      attendanceId: string | null;
      /** After a rejected check-in the employee may also record the check-out (leaving without a check-in). */
      alternative?: 'OUT';
    }
  | {
      action: 'OUT';
      dayKey: string;
      /** null: no record yet (the day's only check-in attempt was rejected); the check-out creates it. */
      attendanceId: string | null;
      /** null when the day has no check-in (rejected and not corrected yet). */
      checkIn: Date | null;
      repunch: boolean;
      /** After a rejected check-in, retrying the check-in stays possible. */
      alternative?: 'IN';
    }
  | { action: 'DONE'; dayKey: string; attendanceId: string | null };

export type PunchStep = Exclude<PunchPlan, { action: 'DONE' }>;

export interface PunchPlanInput {
  now: Date;
  schedule: ScheduleLike | null | undefined;
  /** Riyadh calendar day of `now` ('YYYY-MM-DD'). */
  todayKey: string;
  yesterday: AttendanceDayRow | null;
  today: AttendanceDayRow | null;
  /** Tomorrow's row: only used for an early arrival at a shift that starts around midnight. */
  tomorrow?: AttendanceDayRow | null;
  /** Latest REJECTED check-in attempt per day ('YYYY-MM-DD' -> server time of the attempt). */
  rejectedIn?: Readonly<Record<string, Date | undefined>>;
}

/** An arrival up to this long before a shift that starts around midnight belongs to that shift. */
export const EARLY_IN_WINDOW_MS = 3 * HOUR_MS;
/** After a rejected check-in, retrying it stays the main action for at least this long. */
export const RETRY_IN_WINDOW_MS = HOUR_MS;
/** Without a schedule, the check-out becomes the main action this long after a rejected check-in. */
const DEPARTURE_WITHOUT_SCHEDULE_MS = 4 * HOUR_MS;
/** Back-to-back shifts (e.g. 24 h ones) still get this much time to check out after the end. */
const MIN_OUT_GRACE_MS = HOUR_MS;

export function previousDayKey(dayKey: string): string {
  return new Date(Date.parse(`${dayKey}T00:00:00.000Z`) - DAY_MS).toISOString().slice(0, 10);
}

export function nextDayKey(dayKey: string): string {
  return new Date(Date.parse(`${dayKey}T00:00:00.000Z`) + DAY_MS).toISOString().slice(0, 10);
}

/** How long an open record without a usable schedule may stay closable (12-16 h). */
function maxOpenMs(schedule: ScheduleLike | null | undefined): number {
  const requiredH = schedule?.shiftType === 'FLEXIBLE' && schedule.flexibleHours ? schedule.flexibleHours : 8;
  return Math.min(16, Math.max(12, requiredH * 1.5)) * HOUR_MS;
}

/**
 * Last moment (ms) a record of `dayKey` may still receive its check-out: the scheduled end + 6 h,
 * but not past the midpoint to the next shift's start, so an early arrival for the next shift is
 * never taken for a late check-out. Without a schedule: 12-16 h after `since` (check-in or attempt).
 */
function closingDeadline(dayKey: string, schedule: ScheduleLike | null | undefined, since: Date | null): number | null {
  const shift = scheduledShift(schedule, dayKey);
  if (shift) {
    const next = scheduledShift(schedule, nextDayKey(dayKey));
    const gap = next ? next.start.getTime() - shift.end.getTime() : Infinity;
    return shift.end.getTime() + Math.min(OUT_GRACE_MS, Math.max(MIN_OUT_GRACE_MS, gap / 2));
  }
  return since ? since.getTime() + maxOpenMs(schedule) : null;
}

function stillClosable(dayKey: string, schedule: ScheduleLike | null | undefined, now: Date, since: Date | null): boolean {
  const deadline = closingDeadline(dayKey, schedule, since);
  return deadline !== null && now.getTime() <= deadline;
}

/**
 * Decides what a punch at `now` means.
 * 1. An open record gets its check-out: today's; yesterday's while closable (overnight shifts:
 *    scheduled end + grace, or 12-16 h after check-in without a schedule); tomorrow's (early start).
 * 2. Yesterday's shift: after midnight inside an overnight shift the punch belongs to yesterday
 *    (late arrival); a TWO_SHIFTS day ending after midnight can still re-punch its last check-out.
 * 3. Early arrival (up to 3 h) at a shift that starts around midnight, once today's shift is over:
 *    the punch belongs to tomorrow.
 * 4. Today's record: complete -> DONE (TWO_SHIFTS may re-punch the check-out while closable: the
 *    last one wins), else IN.
 * After a REJECTED check-in (no check-in on the record), the employee is offered both the retry
 * and the check-out (leaving): the retry comes first until the shift's midpoint (at least 1 h).
 * A record left open (forgotten check-out) is not closed automatically: it needs a correction.
 */
export function resolvePunchPlan(input: PunchPlanInput): PunchPlan {
  const { now, schedule, today, yesterday, todayKey } = input;
  const tomorrow = input.tomorrow ?? null;
  const yesterdayKey = previousDayKey(todayKey);
  const tomorrowKey = nextDayKey(todayKey);
  const t = now.getTime();
  const twoShifts = schedule?.shiftType === 'TWO_SHIFTS';

  const rejectedAt = (dayKey: string, row: AttendanceDayRow | null) => (row?.checkIn ? undefined : input.rejectedIn?.[dayKey]);
  const out = (row: AttendanceDayRow, repunch: boolean): PunchPlan => ({ action: 'OUT', dayKey: row.dayKey, attendanceId: row.id, checkIn: row.checkIn, repunch });
  const departureLikely = (dayKey: string, attempt: Date) => {
    const shift = scheduledShift(schedule, dayKey);
    const retryUntil = attempt.getTime() + RETRY_IN_WINDOW_MS;
    if (shift) return t >= Math.max(retryUntil, (shift.start.getTime() + shift.end.getTime()) / 2);
    return t >= attempt.getTime() + DEPARTURE_WITHOUT_SCHEDULE_MS;
  };
  /** A day without any punch recorded yet. */
  const arrive = (dayKey: string, row: AttendanceDayRow | null): PunchPlan => {
    const attendanceId = row?.id ?? null;
    const attempt = rejectedAt(dayKey, row);
    if (!attempt) return { action: 'IN', dayKey, attendanceId };
    return departureLikely(dayKey, attempt)
      ? { action: 'OUT', dayKey, attendanceId, checkIn: null, repunch: false, alternative: 'IN' }
      : { action: 'IN', dayKey, attendanceId, alternative: 'OUT' };
  };
  /** A day whose check-out is recorded. */
  const finished = (row: AttendanceDayRow): PunchPlan =>
    twoShifts && stillClosable(row.dayKey, schedule, now, row.checkIn) ? out(row, true) : { action: 'DONE', dayKey: row.dayKey, attendanceId: row.id };

  const tShift = scheduledShift(schedule, todayKey);
  const mShift = scheduledShift(schedule, tomorrowKey);
  const todayDeadline = tShift ? closingDeadline(todayKey, schedule, null) : null;
  const earlyForTomorrow = !!mShift && todayDeadline !== null && t > todayDeadline && mShift.start.getTime() - t <= EARLY_IN_WINDOW_MS;

  // 1. Open records.
  if (today?.checkIn && !today.checkOut && !earlyForTomorrow) return out(today, false);
  if (yesterday?.checkIn && !yesterday.checkOut && stillClosable(yesterdayKey, schedule, now, yesterday.checkIn)) return out(yesterday, false);
  if (tomorrow?.checkIn && !tomorrow.checkOut) return out(tomorrow, false);

  // 2. Yesterday's shift.
  const yShift = scheduledShift(schedule, yesterdayKey);
  if (yShift && t < yShift.end.getTime()) {
    if (yesterday?.checkOut) return finished(yesterday);
    if (!yesterday?.checkIn) return arrive(yesterdayKey, yesterday);
  } else if (yShift && stillClosable(yesterdayKey, schedule, now, null)) {
    if (yesterday?.checkOut && twoShifts) return out(yesterday, true);
    if (!yesterday?.checkIn && !yesterday?.checkOut && rejectedAt(yesterdayKey, yesterday)) {
      return { action: 'OUT', dayKey: yesterdayKey, attendanceId: yesterday?.id ?? null, checkIn: null, repunch: false };
    }
  }

  // 3. Early for tomorrow's shift.
  if (earlyForTomorrow) return tomorrow?.checkOut ? finished(tomorrow) : arrive(tomorrowKey, tomorrow);

  // 4. Today.
  if (today?.checkOut) return finished(today);
  if (today?.checkIn) return out(today, false);
  return arrive(todayKey, today);
}

/**
 * The step for the action the employee chose (the button they pressed): the plan's main action or
 * its alternative. null when that action is not possible now (stale page, double tap...).
 */
export function planForAction(plan: PunchPlan, action: PunchAction): PunchStep | null {
  if (plan.action === 'DONE') return null;
  if (plan.action === action) return plan;
  if (plan.alternative !== action) return null;
  return action === 'IN'
    ? { action: 'IN', dayKey: plan.dayKey, attendanceId: plan.attendanceId }
    : { action: 'OUT', dayKey: plan.dayKey, attendanceId: plan.attendanceId, checkIn: null, repunch: false };
}

/** True when a check-out at `now` comes too soon after `checkIn` (accidental double tap). */
export function tooSoonAfterCheckIn(checkIn: Date, now: Date): boolean {
  return now.getTime() - checkIn.getTime() < MIN_PUNCH_GAP_MS;
}
