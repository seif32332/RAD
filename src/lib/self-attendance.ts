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
  DAY_COMPLETE: 'DAY_COMPLETE',
} as const;

export type SelfAttendanceBlocker = (typeof SELF_ATTENDANCE_BLOCKERS)[keyof typeof SELF_ATTENDANCE_BLOCKERS];

export const SELF_ATTENDANCE_BLOCKER_MESSAGES: Readonly<Record<SelfAttendanceBlocker, string>> = {
  DISABLED: 'تسجيل الحضور من البوابة غير مفعّل في منشأتك.',
  TERMINATED: 'لا يمكن تسجيل الحضور بعد انتهاء الخدمة.',
  NO_LOCATIONS_CONFIGURED: PUNCH_REASON_MESSAGES.NO_LOCATIONS_CONFIGURED,
  DAY_COMPLETE: 'سجلت حضورك وانصرافك لهذا اليوم. إذا كان هناك خطأ فارفع طلب تصحيح.',
};

/** Employee-facing message for a rejected punch (first rejection reason), with the distance when outside the fence. */
export function rejectionMessage(reasons: readonly PunchReason[], nearest?: { distanceM: number; name: string } | null): string {
  const first = reasons.find((r) => REJECT_REASONS.has(r)) ?? reasons[0];
  if (!first) return 'تعذر تسجيل الحركة.';
  if (first === PUNCH_REASONS.OUTSIDE_GEOFENCE && nearest) {
    return `${PUNCH_REASON_MESSAGES.OUTSIDE_GEOFENCE} تبعد نحو ${Math.round(nearest.distanceM)} م عن «${nearest.name}».`;
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

export type PunchPlan =
  | { action: 'IN'; dayKey: string; attendanceId: string | null }
  | { action: 'OUT'; dayKey: string; attendanceId: string; checkIn: Date; repunch: boolean }
  | { action: 'DONE'; dayKey: string; attendanceId: string | null };

export interface PunchPlanInput {
  now: Date;
  schedule: ScheduleLike | null | undefined;
  /** Riyadh calendar day of `now` ('YYYY-MM-DD'). */
  todayKey: string;
  yesterday: AttendanceDayRow | null;
  today: AttendanceDayRow | null;
}

export function previousDayKey(dayKey: string): string {
  return new Date(Date.parse(`${dayKey}T00:00:00.000Z`) - DAY_MS).toISOString().slice(0, 10);
}

/** How long an open record without a usable schedule may stay closable (12-16 h). */
function maxOpenMs(schedule: ScheduleLike | null | undefined): number {
  const requiredH = schedule?.shiftType === 'FLEXIBLE' && schedule.flexibleHours ? schedule.flexibleHours : 8;
  return Math.min(16, Math.max(12, requiredH * 1.5)) * HOUR_MS;
}

/** True while an open record of `row.dayKey` may still receive its check-out at `now`. */
function stillClosable(row: AttendanceDayRow, schedule: ScheduleLike | null | undefined, now: Date): boolean {
  if (!row.checkIn) return false;
  const shift = scheduledShift(schedule, row.dayKey);
  if (shift) return now.getTime() <= shift.end.getTime() + OUT_GRACE_MS;
  return now.getTime() - row.checkIn.getTime() <= maxOpenMs(schedule);
}

/**
 * Decides what a punch at `now` means.
 * 1. An open record of today -> OUT.
 * 2. An open record of yesterday still within its closing window (scheduled end + 6 h; 12-16 h
 *    after check-in without a schedule) -> OUT on yesterday (overnight shifts).
 * 3. Inside yesterday's overnight shift (after midnight, before its end): the punch belongs to
 *    yesterday -> IN (late arrival) or DONE.
 * 4. Otherwise today's record: complete -> DONE (TWO_SHIFTS may re-punch OUT until the last end
 *    + grace: the last check-out wins), else IN.
 * A record left open (forgotten check-out) is not closed automatically: it needs a correction.
 */
export function resolvePunchPlan(input: PunchPlanInput): PunchPlan {
  const { now, schedule, today, yesterday, todayKey } = input;
  const yesterdayKey = previousDayKey(todayKey);

  if (today?.checkIn && !today.checkOut) {
    return { action: 'OUT', dayKey: todayKey, attendanceId: today.id, checkIn: today.checkIn, repunch: false };
  }
  if (yesterday?.checkIn && !yesterday.checkOut && stillClosable(yesterday, schedule, now)) {
    return { action: 'OUT', dayKey: yesterdayKey, attendanceId: yesterday.id, checkIn: yesterday.checkIn, repunch: false };
  }

  const yShift = schedule?.shiftType === 'FLEXIBLE' ? null : scheduledShift(schedule, yesterdayKey);
  if (yShift && now.getTime() < yShift.end.getTime()) {
    if (!yesterday?.checkIn) return { action: 'IN', dayKey: yesterdayKey, attendanceId: yesterday?.id ?? null };
    if (yesterday.checkOut) return { action: 'DONE', dayKey: yesterdayKey, attendanceId: yesterday.id };
  }

  if (today?.checkOut) {
    if (today.checkIn && schedule?.shiftType === 'TWO_SHIFTS' && stillClosable(today, schedule, now)) {
      return { action: 'OUT', dayKey: todayKey, attendanceId: today.id, checkIn: today.checkIn, repunch: true };
    }
    return { action: 'DONE', dayKey: todayKey, attendanceId: today.id };
  }
  return { action: 'IN', dayKey: todayKey, attendanceId: today?.id ?? null };
}

/** True when a check-out at `now` comes too soon after `checkIn` (accidental double tap). */
export function tooSoonAfterCheckIn(checkIn: Date, now: Date): boolean {
  return now.getTime() - checkIn.getTime() < MIN_PUNCH_GAP_MS;
}
