// Data loading for self clock-in (the decisions themselves are pure: src/lib/self-attendance.ts).
import 'server-only';
import type { Prisma } from '@prisma/client';
import { dateKey, todayKey as riyadhTodayKey } from '@/lib/dates';
import type { ScheduleLike } from '@/lib/attendance';
import { notFound } from '@/lib/http';
import { resolveEmployeeSchedule } from '@/lib/hr-workflows';
import { FACE_MODEL } from '@/lib/face';
import {
  FACE_CONSENT_VERSION,
  FACE_PROFILE_WITHDRAWN,
  SELF_ATTENDANCE_BLOCKERS,
  SELF_ATTENDANCE_SETTING_KEYS,
  nextDayKey,
  parseSelfAttendanceSettings,
  previousDayKey,
  resolvePunchPlan,
  type AttendanceDayRow,
  type NamedFence,
  type PunchPlan,
  type SelfAttendanceBlocker,
  type SelfAttendanceSettings,
} from '@/lib/self-attendance';

type Db = Prisma.TransactionClient;

export async function loadSelfAttendanceSettings(db: Db): Promise<SelfAttendanceSettings> {
  const rows = await db.systemSetting.findMany({
    where: { key: { in: Object.values(SELF_ATTENDANCE_SETTING_KEYS) } },
    select: { key: true, value: true },
  });
  return parseSelfAttendanceSettings(rows);
}

/** Active attendance locations of a branch (none without a branch). */
export async function loadActiveFences(db: Db, branchId: string | null): Promise<NamedFence[]> {
  if (!branchId) return [];
  return db.attendanceLocation.findMany({
    where: { branchId, isActive: true },
    select: { id: true, name: true, latitude: true, longitude: true, radiusM: true },
    orderBy: { createdAt: 'asc' },
  });
}

const dayDate = (key: string) => new Date(`${key}T00:00:00.000Z`);

export interface PlanRows {
  yesterday: AttendanceDayRow | null;
  today: AttendanceDayRow | null;
  tomorrow: AttendanceDayRow | null;
  /** Latest rejected check-in attempt per day (the planner ignores it once the day has a check-in). */
  rejectedIn: Record<string, Date>;
}

/** The Attendance rows a punch can touch (yesterday, today, tomorrow) and the rejected check-in attempts of those days. */
export async function loadPlanRows(db: Db, employeeId: string, todayKey: string): Promise<PlanRows> {
  const keys = [previousDayKey(todayKey), todayKey, nextDayKey(todayKey)];
  const [rows, rejected] = await Promise.all([
    db.attendance.findMany({
      where: { employeeId, date: { in: keys.map(dayDate) } },
      select: { id: true, date: true, checkIn: true, checkOut: true },
    }),
    db.attendancePunch.findMany({
      where: { employeeId, type: 'IN', result: 'REJECTED', workDate: { in: keys.map(dayDate) } },
      orderBy: { createdAt: 'desc' },
      select: { workDate: true, createdAt: true },
    }),
  ]);
  const pick = (key: string): AttendanceDayRow | null => {
    const r = rows.find((x) => dateKey(x.date) === key);
    return r ? { id: r.id, dayKey: key, checkIn: r.checkIn, checkOut: r.checkOut } : null;
  };
  const rejectedIn: Record<string, Date> = {};
  for (const p of rejected) {
    const key = dateKey(p.workDate);
    if (key && !rejectedIn[key]) rejectedIn[key] = p.createdAt;
  }
  return { yesterday: pick(keys[0]), today: pick(keys[1]), tomorrow: pick(keys[2]), rejectedIn };
}

export interface SelfAttendanceContext {
  now: Date;
  todayKey: string;
  settings: SelfAttendanceSettings;
  employee: {
    id: string;
    branchId: string | null;
    isTerminated: boolean;
    employmentStatus: string;
    attendanceGeoExempt: boolean;
    attendanceFaceExempt: boolean;
  };
  schedule: ScheduleLike | null;
  fences: NamedFence[];
  plan: PunchPlan;
  /** The Attendance row the plan points at (for display). */
  record: AttendanceDayRow | null;
  faceRequired: boolean;
  /** A FaceProfile made by the current model exists. */
  faceEnrolled: boolean;
  /** Biometric data is stored (any model): the employee can withdraw consent. */
  faceDataStored: boolean;
  /** Consent was withdrawn: enrolling again needs HR (RESET_FACE). */
  faceWithdrawn: boolean;
  /** The enrolled employee accepted the current version of the privacy notice. */
  faceConsentCurrent: boolean;
  blockers: SelfAttendanceBlocker[];
}

/** Everything the portal card and the punch route need, for the logged-in employee at `now`. */
export async function loadSelfAttendanceContext(db: Db, employeeId: string, now: Date = new Date()): Promise<SelfAttendanceContext> {
  const employee = await db.employee.findUnique({
    where: { id: employeeId },
    select: {
      id: true,
      branchId: true,
      isTerminated: true,
      employmentStatus: true,
      attendanceGeoExempt: true,
      attendanceFaceExempt: true,
      faceProfile: { select: { model: true, consentVersion: true } },
    },
  });
  if (!employee) throw notFound('ملف الموظف غير موجود');

  const todayKey = riyadhTodayKey(now);
  const [settings, { schedule }, fences, rows] = await Promise.all([
    loadSelfAttendanceSettings(db),
    resolveEmployeeSchedule(db, employeeId),
    loadActiveFences(db, employee.branchId),
    loadPlanRows(db, employeeId, todayKey),
  ]);
  const plan = resolvePunchPlan({ now, schedule, todayKey, ...rows });
  const record = [rows.yesterday, rows.today, rows.tomorrow].find((r) => r?.dayKey === plan.dayKey) ?? null;

  const { faceProfile, ...emp } = employee;
  const faceRequired = !employee.attendanceFaceExempt;
  const faceWithdrawn = faceProfile?.model === FACE_PROFILE_WITHDRAWN;

  const blockers: SelfAttendanceBlocker[] = [];
  if (!settings.enabled) blockers.push(SELF_ATTENDANCE_BLOCKERS.DISABLED);
  if (employee.isTerminated) blockers.push(SELF_ATTENDANCE_BLOCKERS.TERMINATED);
  if (!employee.attendanceGeoExempt && fences.length === 0) blockers.push(SELF_ATTENDANCE_BLOCKERS.NO_LOCATIONS_CONFIGURED);
  if (faceRequired && faceWithdrawn) blockers.push(SELF_ATTENDANCE_BLOCKERS.FACE_WITHDRAWN);
  if (plan.action === 'DONE') blockers.push(SELF_ATTENDANCE_BLOCKERS.DAY_COMPLETE);

  return {
    now,
    todayKey,
    settings,
    employee: emp,
    schedule,
    fences,
    plan,
    record,
    faceRequired,
    faceEnrolled: faceProfile?.model === FACE_MODEL,
    faceDataStored: !!faceProfile && !faceWithdrawn,
    faceWithdrawn,
    faceConsentCurrent: faceProfile?.consentVersion === FACE_CONSENT_VERSION,
    blockers,
  };
}
