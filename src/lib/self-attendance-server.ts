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
  SELF_ATTENDANCE_BLOCKERS,
  SELF_ATTENDANCE_SETTING_KEYS,
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

/** Today's and yesterday's Attendance rows of the employee (the only rows a punch can touch). */
export async function loadPlanRows(db: Db, employeeId: string, todayKey: string): Promise<{ today: AttendanceDayRow | null; yesterday: AttendanceDayRow | null }> {
  const yesterdayKey = previousDayKey(todayKey);
  const rows = await db.attendance.findMany({
    where: { employeeId, date: { in: [dayDate(yesterdayKey), dayDate(todayKey)] } },
    select: { id: true, date: true, checkIn: true, checkOut: true },
  });
  const pick = (key: string): AttendanceDayRow | null => {
    const r = rows.find((x) => dateKey(x.date) === key);
    return r ? { id: r.id, dayKey: key, checkIn: r.checkIn, checkOut: r.checkOut } : null;
  };
  return { today: pick(todayKey), yesterday: pick(yesterdayKey) };
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
  const plan = resolvePunchPlan({ now, schedule, todayKey, today: rows.today, yesterday: rows.yesterday });
  const record = plan.dayKey === todayKey ? rows.today : rows.yesterday;

  const blockers: SelfAttendanceBlocker[] = [];
  if (!settings.enabled) blockers.push(SELF_ATTENDANCE_BLOCKERS.DISABLED);
  if (employee.isTerminated) blockers.push(SELF_ATTENDANCE_BLOCKERS.TERMINATED);
  if (!employee.attendanceGeoExempt && fences.length === 0) blockers.push(SELF_ATTENDANCE_BLOCKERS.NO_LOCATIONS_CONFIGURED);
  if (plan.action === 'DONE') blockers.push(SELF_ATTENDANCE_BLOCKERS.DAY_COMPLETE);

  const { faceProfile, ...emp } = employee;
  return {
    now,
    todayKey,
    settings,
    employee: emp,
    schedule,
    fences,
    plan,
    record,
    faceRequired: !employee.attendanceFaceExempt,
    faceEnrolled: faceProfile?.model === FACE_MODEL,
    faceConsentCurrent: faceProfile?.consentVersion === FACE_CONSENT_VERSION,
    blockers,
  };
}
