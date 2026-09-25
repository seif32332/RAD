// HR approval workflows (leaves, internal transfers, attendance corrections).
//
// Every state change is guarded atomically on the previous state
// (`updateMany({ where: { id, status: EXPECTED } })` + conflict() when count === 0), so a
// double click / double request can never apply side effects twice. Callers must run these
// inside `prisma.$transaction(async (tx) => ...)` and pass `tx`.
import 'server-only';
import type { LeaveStatus, LeaveType, Prisma } from '@prisma/client';
import type { AuthUser } from '@/lib/auth';
import {
  ASSET_STATUS,
  ATTENDANCE_CORRECTION_STATUS,
  DEFAULT_EXIT_REENTRY_VISA_FEE,
  LEAVE_STATUS,
  ROLE_GROUPS,
  TRANSFER_STATUS,
  roleIn,
} from '@/lib/constants';
import { badRequest, conflict, forbidden, notFound } from '@/lib/http';
import { logAudit } from '@/lib/audit';
import { addDays, dateKey, daysBetween, inclusiveDays, today } from '@/lib/dates';
import { roundMoney } from '@/lib/money';
import {
  BALANCE_CONSUMING_STATUSES,
  LEAVE_RULE_SETTING_KEYS,
  MAX_LEAVE_DAYS,
  completedServiceYears,
  computeLeaveBalance,
  computeLeaveRequest,
  dailyWage,
  isSaudiNationality,
  isStatutoryLeaveType,
  parseStatutoryLeaveRules,
  recalculateShortenedLeave,
  type BereavementRelation,
  type LeaveBalance,
  type LeaveRequestResult,
  type LeaveTypeCode,
  type StatutoryLeaveContext,
  type StatutoryLeaveRules,
} from '@/lib/leave';
import {
  ATTENDANCE_SOURCE,
  ATTENDANCE_STATUS,
  buildPunches,
  computeLateEarly,
  defaultPunchTimes,
  pickEmployeeSchedule,
} from '@/lib/attendance';

type Db = Prisma.TransactionClient;

/**
 * Compile-time guard: LEAVE_TYPES in src/lib/leave.ts (pure, no Prisma) must list exactly the
 * Prisma LeaveType enum, so every label map derived from LEAVE_TYPE_LABELS stays exhaustive.
 */
type SameUnion<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const LEAVE_TYPES_MATCH_PRISMA: SameUnion<LeaveType, LeaveTypeCode> = true;

export interface WorkflowOptions {
  /** Client IP for the audit log. */
  ipAddress?: string | null;
}

/** Status values of TransferRequest (re-exported from src/lib/constants.ts). */
export { TRANSFER_STATUS };
/** Status values of AttendanceCorrection (alias of ATTENDANCE_CORRECTION_STATUS in src/lib/constants.ts). */
export const CORRECTION_STATUS = ATTENDANCE_CORRECTION_STATUS;
export const CORRECTION_TYPES = ['LATE', 'EARLY_LEAVE', 'ABSENT', 'GENERAL'] as const;
export const ASSET_ACTIONS = ['RETAIN', 'CLEAR'] as const;

export const SETTING_KEYS = {
  ANNUAL_LEAVE_DAYS: 'annual_leave_days',
  EXIT_REENTRY_VISA_FEE: 'exit_reentry_visa_fee',
} as const;

const EXIT_REENTRY_VISA_TYPE = 'خروج وعودة';
/** Exit/re-entry visa statuses meaning "still in progress" (CANCELLED / ISSUED are closed). */
const ACTIVE_VISA_STATUSES = ['PENDING_PAYMENT', 'PAID'] as const;
const OPEN_PAYMENT_STATUSES = ['PENDING_OWNER', 'PENDING_FINANCE'] as const;
/** Payment request status used when a payment will not happen (withdrawn / returned). */
const WITHDRAWN_PAYMENT_STATUS = 'RETURNED' as const;
const BALANCE_TYPES: LeaveType[] = ['ANNUAL', 'DEDUCTED', 'EMERGENCY'];
/** APPROVED + COMPLETED (src/lib/leave.ts BALANCE_CONSUMING_STATUSES) typed for Prisma filters. */
const BALANCE_CONSUMING_LEAVE_STATUSES = BALANCE_CONSUMING_STATUSES as readonly LeaveStatus[];
/** Reason prefix of a portal "تحديث بياناتي" request (filed as an AttendanceCorrection row). */
export const DATA_UPDATE_PREFIX = '[طلب: تحديث بيانات]';
/** Reason prefix of every portal general request (letters, data update, other). */
export const GENERAL_REQUEST_PREFIX = '[طلب:';

// ---------------------------------------------------------------------------
// Portal general requests / data update (pure helpers)
// ---------------------------------------------------------------------------

/**
 * General requests (letters, data update, "other") go straight to HR: they never need the
 * direct manager's approval and are hidden from manager queues (DOM-006 / UX-05).
 */
export function isHrDirectRequest(reason: string | null | undefined): boolean {
  return (reason ?? '').trimStart().startsWith(GENERAL_REQUEST_PREFIX);
}

const HR_DIRECT_MESSAGE = 'هذا الطلب يُحال إلى الموارد البشرية مباشرة ولا يمر بالمدير المباشر';

/** Tags of the structured lines the portal writes into a data-update request ("الجوال: 05..."). */
export const DATA_UPDATE_TAGS = {
  MOBILE: 'الجوال',
  EMAIL: 'البريد',
  IBAN: 'الآيبان',
  BANK: 'اسم البنك',
  IBAN_CERTIFICATE: 'شهادة الآيبان',
} as const;

const MOBILE_PATTERN = /^05\d{8}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ARABIC_DIGITS = /[٠-٩۰-۹]/g;

function toLatinDigits(s: string): string {
  return s.replace(ARABIC_DIGITS, (d) => String(d.charCodeAt(0) & 0xf));
}

/** Values of every line tagged exactly `tag:` (the tag must start the line). */
function taggedValues(lines: string[], tag: string): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith(tag)) continue;
    const rest = t.slice(tag.length).trimStart();
    if (!rest.startsWith(':')) continue;
    const value = rest.slice(1).trim();
    // "-" is the placeholder older portal versions wrote for an empty field.
    if (value && value !== '-') out.push(value);
  }
  return out;
}

export interface DataUpdateParse {
  /** Mobile to apply (tagged line, format 05XXXXXXXX), else null. */
  mobile: string | null;
  /** Email to apply (tagged line, valid address, lower-cased), else null. */
  email: string | null;
  /** The request asks for an IBAN change (never applied automatically). */
  ibanRequested: boolean;
  /** Tagged fields present but not applied because the value is invalid or repeated. */
  rejected: string[];
}

/**
 * Reads a data-update request. Only explicitly tagged lines count: free text is never scanned
 * for numbers or IBANs (the old fallback regexes wrote IBAN digits into the mobile number).
 */
export function parseDataUpdateRequest(reason: string | null | undefined): DataUpdateParse {
  const lines = (reason ?? '').split(/\r?\n/);
  const rejected: string[] = [];

  let mobile: string | null = null;
  const mobiles = taggedValues(lines, DATA_UPDATE_TAGS.MOBILE).map((v) => toLatinDigits(v).replace(/[\s-]/g, ''));
  if (mobiles.length === 1 && MOBILE_PATTERN.test(mobiles[0])) mobile = mobiles[0];
  else if (mobiles.length > 0) rejected.push(DATA_UPDATE_TAGS.MOBILE);

  let email: string | null = null;
  const emails = taggedValues(lines, DATA_UPDATE_TAGS.EMAIL).map((v) => v.toLowerCase());
  if (emails.length === 1 && emails[0].length <= 200 && EMAIL_PATTERN.test(emails[0])) email = emails[0];
  else if (emails.length > 0) rejected.push(DATA_UPDATE_TAGS.EMAIL);

  const ibanRequested = taggedValues(lines, DATA_UPDATE_TAGS.IBAN).length > 0;
  return { mobile, email, ibanRequested, rejected };
}

/** Arabic label of an Employee field a data-update request may change. */
const DATA_UPDATE_FIELD_LABELS: Record<'mobileNumber' | 'email', string> = {
  mobileNumber: DATA_UPDATE_TAGS.MOBILE,
  email: DATA_UPDATE_TAGS.EMAIL,
};

export const IBAN_MANUAL_UPDATE_MESSAGE = 'تغيير الآيبان يتطلب تعديلاً يدوياً في ملف الموظف بعد التحقق من شهادة الآيبان.';

/** HR approval message naming exactly the fields that were applied. */
export function describeDataUpdateOutcome(
  updatedFields: ReadonlyArray<'mobileNumber' | 'email'>,
  parsed: Pick<DataUpdateParse, 'ibanRequested' | 'rejected'>,
): string {
  const parts: string[] = [];
  if (updatedFields.length > 0) {
    parts.push(`تم اعتماد الطلب وتحديث ${updatedFields.map((f) => DATA_UPDATE_FIELD_LABELS[f]).join(' و')} في ملف الموظف.`);
  } else {
    parts.push('تم اعتماد الطلب، ولم يُطبَّق أي حقل تلقائياً.');
  }
  if (parsed.rejected.length > 0) {
    parts.push(`لم يُطبَّق ${parsed.rejected.join(' و')} لأن القيمة المدخلة غير صالحة.`);
  }
  if (parsed.ibanRequested) parts.push(IBAN_MANUAL_UPDATE_MESSAGE);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Request stage shown to the employee (pure helpers)
// ---------------------------------------------------------------------------

export type RequestStage = 'MANAGER' | 'HR' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'IN_REVIEW';

export const REQUEST_STAGE_LABELS: Readonly<Record<RequestStage, string>> = {
  MANAGER: 'بانتظار المدير',
  HR: 'بانتظار الموارد البشرية',
  APPROVED: 'معتمد',
  REJECTED: 'مرفوض',
  CANCELLED: 'ملغى',
  IN_REVIEW: 'قيد المراجعة',
};

/**
 * Stage of a two-step request (leave / attendance correction). `needsManager` is false when the
 * request skips the direct manager (general requests, employees without a direct manager).
 */
export function twoStepRequestStage(p: { status: string; isManagerApproved: boolean; needsManager: boolean }): RequestStage {
  if (p.status === 'REJECTED') return 'REJECTED';
  if (p.status === 'CANCELLED') return 'CANCELLED';
  if (p.status === 'APPROVED' || p.status === 'COMPLETED') return 'APPROVED';
  if (p.status !== 'PENDING') return 'IN_REVIEW';
  return p.needsManager && !p.isManagerApproved ? 'MANAGER' : 'HR';
}

const LEAVE_REJECTION_PREFIX = 'سبب الرفض:';

/** Rejection reason rejectLeave() appended to the leave notes (last one wins), else null. */
export function leaveRejectionReason(notes: string | null | undefined): string | null {
  const lines = (notes ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith(LEAVE_REJECTION_PREFIX));
  const last = lines[lines.length - 1];
  const reason = last?.slice(LEAVE_REJECTION_PREFIX.length).trim();
  return reason || null;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Numeric SystemSetting value, or null when missing / not a number. */
export async function getNumericSetting(db: Db, key: string): Promise<number | null> {
  const row = await db.systemSetting.findUnique({ where: { key }, select: { value: true } });
  if (!row) return null;
  const raw = String(row.value).trim().replace(/^"(.*)"$/, '$1');
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Statutory leave rules (SystemSetting leave_* keys; missing / invalid values use the provisional defaults). */
export async function getStatutoryLeaveRules(db: Db): Promise<StatutoryLeaveRules> {
  const rows = await db.systemSetting.findMany({
    where: { key: { in: Object.values(LEAVE_RULE_SETTING_KEYS) } },
    select: { key: true, value: true },
  });
  return parseStatutoryLeaveRules(new Map(rows.map((r) => [r.key, r.value])));
}

export async function getExitReentryVisaFee(db: Db): Promise<number> {
  const fee = await getNumericSetting(db, SETTING_KEYS.EXIT_REENTRY_VISA_FEE);
  return fee !== null && fee >= 0 ? roundMoney(fee) : DEFAULT_EXIT_REENTRY_VISA_FEE;
}

// ---------------------------------------------------------------------------
// Authorization helpers
// ---------------------------------------------------------------------------

interface EmployeeScope {
  id: string;
  directManagerId: string | null;
  branchId: string | null;
  departmentId: string | null;
}

const employeeScopeSelect = { id: true, directManagerId: true, branchId: true, departmentId: true } as const;

/**
 * Throws 403 unless `user` may approve/reject requests of `employee`:
 * - nobody approves their own request (except the owner group),
 * - HR group: any employee,
 * - other managers: their direct reports, or employees of their branch (BRANCH_MANAGER)
 *   / department (DEPT_MANAGER).
 */
export async function assertCanManageEmployee(db: Db, user: AuthUser, employee: EmployeeScope): Promise<void> {
  if (user.employeeId && user.employeeId === employee.id && !roleIn(user.role, ROLE_GROUPS.OWNER)) {
    throw forbidden('لا يمكنك اعتماد أو رفض طلب يخصك');
  }
  if (roleIn(user.role, ROLE_GROUPS.HR)) return;
  if (!roleIn(user.role, ROLE_GROUPS.MANAGERS)) throw forbidden();
  if (!user.employeeId) throw forbidden('حسابك غير مرتبط بملف موظف');
  if (employee.directManagerId && employee.directManagerId === user.employeeId) return;
  const me = await db.employee.findUnique({ where: { id: user.employeeId }, select: { branchId: true, departmentId: true } });
  if (user.role === 'BRANCH_MANAGER' && me?.branchId && me.branchId === employee.branchId) return;
  if (user.role === 'DEPT_MANAGER' && me?.departmentId && me.departmentId === employee.departmentId) return;
  throw forbidden('هذا الموظف ليس ضمن نطاق إدارتك');
}

/**
 * Employee filter for list endpoints: null = every employee (HR group); otherwise the
 * employees the manager may act on (direct reports, own branch / department) plus themselves.
 * Plain employees get only themselves.
 */
export async function managedEmployeesWhere(db: Db, user: AuthUser): Promise<Prisma.EmployeeWhereInput | null> {
  if (roleIn(user.role, ROLE_GROUPS.HR)) return null;
  if (!user.employeeId) return { id: '__none__' };
  const or: Prisma.EmployeeWhereInput[] = [{ id: user.employeeId }];
  if (roleIn(user.role, ROLE_GROUPS.MANAGERS)) {
    or.push({ directManagerId: user.employeeId });
    const me = await db.employee.findUnique({ where: { id: user.employeeId }, select: { branchId: true, departmentId: true } });
    if (user.role === 'BRANCH_MANAGER' && me?.branchId) or.push({ branchId: me.branchId });
    if (user.role === 'DEPT_MANAGER' && me?.departmentId) or.push({ departmentId: me.departmentId });
  }
  return { OR: or };
}

// ---------------------------------------------------------------------------
// Leave balance / evaluation
// ---------------------------------------------------------------------------

/** Loads the employee's leaves and computes the balance with the single formula in src/lib/leave.ts. */
export async function getEmployeeLeaveBalance(
  db: Db,
  employeeId: string,
  opts: { asOf?: Date; excludeLeaveId?: string } = {},
): Promise<LeaveBalance> {
  const [employee, setting] = await Promise.all([
    db.employee.findUnique({
      where: { id: employeeId },
      select: {
        joinDate: true,
        leaveAccrualStartDate: true,
        leaves: {
          where: { leaveType: { in: BALANCE_TYPES }, status: { in: [LEAVE_STATUS.PENDING, ...BALANCE_CONSUMING_LEAVE_STATUSES] } },
          select: {
            id: true,
            leaveType: true,
            status: true,
            paidDays: true,
            totalDays: true,
            unpaidDays: true,
            startDate: true,
            endDate: true,
            createdAt: true,
          },
        },
      },
    }),
    getNumericSetting(db, SETTING_KEYS.ANNUAL_LEAVE_DAYS),
  ]);
  if (!employee) throw notFound('الموظف غير موجود');
  return computeLeaveBalance({
    joinDate: employee.joinDate,
    leaveAccrualStartDate: employee.leaveAccrualStartDate,
    leaves: employee.leaves,
    asOf: opts.asOf,
    annualLeaveDaysSetting: setting,
    excludeLeaveId: opts.excludeLeaveId,
  });
}

/** Sick days (APPROVED/COMPLETED) in the 12 months before `startDate`. */
export async function getPastSickDays(db: Db, employeeId: string, startDate: Date, excludeLeaveId?: string): Promise<number> {
  const yearAgo = new Date(Date.UTC(startDate.getUTCFullYear() - 1, startDate.getUTCMonth(), startDate.getUTCDate()));
  const rows = await db.leave.findMany({
    where: {
      employeeId,
      leaveType: 'SICK',
      status: { in: [...BALANCE_CONSUMING_LEAVE_STATUSES] },
      endDate: { gte: yearAgo },
      startDate: { lt: startDate },
      ...(excludeLeaveId ? { id: { not: excludeLeaveId } } : {}),
    },
    select: { totalDays: true },
  });
  return rows.reduce((s, r) => s + (r.totalDays || 0), 0);
}

export interface LeaveEvaluationParams {
  employeeId: string;
  leaveType: LeaveType;
  startDate: Date;
  endDate: Date;
  acceptUnpaidExtraDays?: boolean;
  waiveDeduction?: boolean;
  /** When re-evaluating an existing leave (edit/extend). */
  excludeLeaveId?: string;
  /** PATERNITY / BEREAVEMENT / MARRIAGE: date of the birth / death / marriage (optional). */
  eventDate?: Date | null;
  /** BEREAVEMENT: relation of the deceased (default FIRST_DEGREE). */
  bereavementRelation?: BereavementRelation | null;
}

export interface LeaveEvaluation {
  totalDays: number;
  balance: LeaveBalance;
  dailyRate: number;
  result: LeaveRequestResult;
  employee: { id: string; nationality: string | null; basicSalary: number; isTerminated: boolean; gender: string; joinDate: Date };
  /** Statutory leave types only: the rules and facts the result was computed with. */
  statutory: StatutoryLeaveContext | null;
}

/** Other PENDING / APPROVED / COMPLETED HAJJ leaves of the employee since `joinDate` (the current service). */
export async function countPriorHajjLeaves(db: Db, employeeId: string, joinDate: Date, excludeLeaveId?: string): Promise<number> {
  return db.leave.count({
    where: {
      employeeId,
      leaveType: 'HAJJ',
      status: { in: [LEAVE_STATUS.PENDING, ...BALANCE_CONSUMING_LEAVE_STATUSES] },
      startDate: { gte: joinDate },
      ...(excludeLeaveId ? { id: { not: excludeLeaveId } } : {}),
    },
  });
}

/** Server-side leave computation: days, balance (as of the leave start), paid/unpaid split, deduction. */
export async function evaluateLeave(db: Db, p: LeaveEvaluationParams): Promise<LeaveEvaluation> {
  const totalDays = inclusiveDays(p.startDate, p.endDate);
  if (!Number.isFinite(totalDays) || totalDays < 1) throw badRequest('تاريخ نهاية الإجازة يجب أن يكون بعد تاريخ البداية أو مساوياً له');
  if (totalDays > MAX_LEAVE_DAYS) throw badRequest(`مدة الإجازة لا يمكن أن تتجاوز ${MAX_LEAVE_DAYS} يوماً`);

  const employee = await db.employee.findUnique({
    where: { id: p.employeeId },
    select: { id: true, nationality: true, basicSalary: true, isTerminated: true, gender: true, joinDate: true },
  });
  if (!employee) throw notFound('الموظف غير موجود');

  const statutoryType = isStatutoryLeaveType(p.leaveType);
  const [balance, pastSickDays, rules, priorHajjLeaves] = await Promise.all([
    getEmployeeLeaveBalance(db, p.employeeId, { asOf: p.startDate, excludeLeaveId: p.excludeLeaveId }),
    p.leaveType === 'SICK' ? getPastSickDays(db, p.employeeId, p.startDate, p.excludeLeaveId) : Promise.resolve(0),
    statutoryType ? getStatutoryLeaveRules(db) : Promise.resolve(null),
    p.leaveType === 'HAJJ' ? countPriorHajjLeaves(db, p.employeeId, employee.joinDate, p.excludeLeaveId) : Promise.resolve(0),
  ]);
  const statutory: StatutoryLeaveContext | null = rules
    ? {
        rules,
        gender: employee.gender,
        serviceYears: completedServiceYears(employee.joinDate, p.startDate),
        priorHajjLeaves,
        bereavementRelation: p.leaveType === 'BEREAVEMENT' ? (p.bereavementRelation ?? 'FIRST_DEGREE') : null,
        daysFromEvent: p.eventDate ? daysBetween(p.eventDate, p.startDate) : null,
      }
    : null;
  const dailyRate = dailyWage(employee.basicSalary);
  const result = computeLeaveRequest({
    leaveType: p.leaveType,
    totalDays,
    availableBalance: balance.available,
    dailyRate,
    pastSickDays,
    acceptUnpaidExtraDays: p.acceptUnpaidExtraDays,
    waiveDeduction: p.waiveDeduction,
    statutory: statutory ?? undefined,
  });
  return { totalDays, balance, dailyRate, result, employee, statutory };
}

/**
 * Row-locks the employee until the transaction ends so concurrent leave requests for the same
 * employee are serialized (the open-leave / overlap checks cannot both pass).
 */
export async function lockEmployeeForUpdate(tx: Db, employeeId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "Employee" WHERE "id" = ${employeeId} FOR UPDATE`;
}

/** 409 when the employee has a PENDING leave, or an APPROVED leave not yet returned whose end date is today or later. */
export async function assertNoOpenLeave(db: Db, employeeId: string, excludeLeaveId?: string): Promise<void> {
  const open = await db.leave.findFirst({
    where: {
      employeeId,
      ...(excludeLeaveId ? { id: { not: excludeLeaveId } } : {}),
      OR: [
        { status: LEAVE_STATUS.PENDING },
        { status: LEAVE_STATUS.APPROVED, isReturned: false, endDate: { gte: today() } },
      ],
    },
    select: { id: true },
  });
  if (open) throw conflict('يوجد معاملة إجازة قائمة حالياً للموظف. يرجى الانتظار حتى انتهائها.');
}

/** 409 when [start, end] overlaps another pending/approved/completed leave of the employee. */
export async function assertNoOverlappingLeave(db: Db, employeeId: string, start: Date, end: Date, excludeLeaveId?: string): Promise<void> {
  const overlap = await db.leave.findFirst({
    where: {
      employeeId,
      ...(excludeLeaveId ? { id: { not: excludeLeaveId } } : {}),
      status: { in: [LEAVE_STATUS.PENDING, ...BALANCE_CONSUMING_LEAVE_STATUSES] },
      startDate: { lte: end },
      endDate: { gte: start },
    },
    select: { id: true },
  });
  if (overlap) throw conflict('تتداخل تواريخ الإجازة مع إجازة أخرى مسجلة للموظف');
}

// ---------------------------------------------------------------------------
// Leave state machine
//   PENDING --manager--> PENDING(isManagerApproved) --HR--> APPROVED
//   PENDING --reject--> REJECTED            PENDING --cancel--> CANCELLED
//   APPROVED --record return--> APPROVED(actualReturnDate) --confirm--> COMPLETED
//   APPROVED --cancel--> CANCELLED (not started) | COMPLETED (cut short)
// ---------------------------------------------------------------------------

const leaveWorkflowSelect = {
  id: true,
  employeeId: true,
  leaveType: true,
  status: true,
  startDate: true,
  endDate: true,
  totalDays: true,
  paidDays: true,
  unpaidDays: true,
  totalDeduction: true,
  dailyDeductionRate: true,
  isManagerApproved: true,
  isHrApproved: true,
  isOutsideKSA: true,
  exitReentryVisaCost: true,
  isReturned: true,
  actualReturnDate: true,
  notes: true,
  employee: {
    select: {
      ...employeeScopeSelect,
      employeeId: true,
      firstNameArabic: true,
      lastNameArabic: true,
      nationality: true,
    },
  },
} as const;

type WorkflowLeave = Prisma.LeaveGetPayload<{ select: typeof leaveWorkflowSelect }>;

async function loadLeave(db: Db, leaveId: string): Promise<WorkflowLeave> {
  const leave = await db.leave.findUnique({ where: { id: leaveId }, select: leaveWorkflowSelect });
  if (!leave) throw notFound('طلب الإجازة غير موجود');
  return leave;
}

function employeeName(e: { firstNameArabic: string | null; lastNameArabic: string | null; employeeId: string | null }): string {
  const name = `${e.firstNameArabic ?? ''} ${e.lastNameArabic ?? ''}`.trim();
  return e.employeeId ? `${name} (${e.employeeId})` : name;
}

function appendNote(notes: string | null, line: string): string {
  return notes ? `${notes}\n${line}` : line;
}

const alreadyProcessed = () => conflict('تمت معالجة هذا الطلب مسبقاً');
const returnAlreadyRecorded = () => conflict('تم إثبات عودة الموظف مسبقاً وهي بانتظار تأكيد المباشرة من الموارد البشرية');

/**
 * Manager or HR approval of a PENDING leave. HR approval makes it APPROVED and requires the
 * manager approval first, unless the employee has no direct manager or the approver is the owner.
 * For non-Saudi employees leaving the kingdom, HR approval opens the exit/re-entry visa and its
 * payment request.
 */
export async function approveLeave(tx: Db, leaveId: string, stage: 'MANAGER' | 'HR', user: AuthUser, opts: WorkflowOptions = {}) {
  const leave = await loadLeave(tx, leaveId);
  if (leave.status !== LEAVE_STATUS.PENDING) throw alreadyProcessed();
  await assertCanManageEmployee(tx, user, leave.employee);

  if (stage === 'MANAGER') {
    if (!roleIn(user.role, ROLE_GROUPS.MANAGERS)) throw forbidden();
    const r = await tx.leave.updateMany({
      where: { id: leaveId, status: LEAVE_STATUS.PENDING, isManagerApproved: false },
      data: { isManagerApproved: true, managerApprovedAt: new Date() },
    });
    if (r.count === 0) throw conflict('تمت موافقة المدير على هذا الطلب مسبقاً');
  } else {
    if (!roleIn(user.role, ROLE_GROUPS.HR)) throw forbidden();
    const canSkipManager = !leave.employee.directManagerId || roleIn(user.role, ROLE_GROUPS.OWNER);
    if (!leave.isManagerApproved && !canSkipManager) throw conflict('الطلب بانتظار موافقة المدير المباشر أولاً');
    const r = await tx.leave.updateMany({
      where: {
        id: leaveId,
        status: LEAVE_STATUS.PENDING,
        isHrApproved: false,
        ...(canSkipManager ? {} : { isManagerApproved: true }),
      },
      data: { isHrApproved: true, hrApprovedAt: new Date(), status: LEAVE_STATUS.APPROVED },
    });
    if (r.count === 0) throw alreadyProcessed();
    if (leave.isOutsideKSA && !isSaudiNationality(leave.employee.nationality)) {
      await openExitReentryVisa(tx, leave, user.id);
    }
  }

  await logAudit(
    { userId: user.id, action: 'APPROVE', entityType: 'Leave', entityId: leaveId, details: { stage, employeeId: leave.employeeId }, ipAddress: opts.ipAddress },
    tx,
  );
  return tx.leave.findUnique({ where: { id: leaveId } });
}

/**
 * The employee's exit/re-entry visa that is still in progress (PENDING_PAYMENT or PAID), or null.
 * The visa of a cancelled leave is CANCELLED (see cancelLeaveVisa), so it no longer blocks a new one.
 */
export async function findActiveExitReentryVisa(db: Db, employeeId: string): Promise<{ id: string } | null> {
  return db.visa.findFirst({
    where: { employeeId, visaType: EXIT_REENTRY_VISA_TYPE, status: { in: [...ACTIVE_VISA_STATUSES] } },
    select: { id: true },
    orderBy: { createdAt: 'desc' },
  });
}

async function openExitReentryVisa(tx: Db, leave: WorkflowLeave, requestedById: string): Promise<void> {
  const existing = await findActiveExitReentryVisa(tx, leave.employeeId);
  if (existing) return;
  const fee = leave.exitReentryVisaCost && leave.exitReentryVisaCost > 0 ? roundMoney(leave.exitReentryVisaCost) : await getExitReentryVisaFee(tx);
  const visa = await tx.visa.create({
    data: {
      employeeId: leave.employeeId,
      visaType: EXIT_REENTRY_VISA_TYPE,
      status: 'PENDING_PAYMENT',
      deductedFrom: `مربوط آلياً بطلب الإجازة الخارجية (#${leave.id})`,
    },
    select: { id: true },
  });
  await tx.paymentRequest.create({
    data: {
      title: `رسوم تأشيرة خروج وعودة - ${employeeName(leave.employee)}`,
      reason: 'تكلفة تأشيرة خروج وعودة لإجازة الموظف',
      amount: fee,
      accountNumber: 'سداد - مدفوعات حكومية (تأشيرات)',
      status: 'PENDING_FINANCE',
      requestedById,
      entityType: 'VISA',
      entityId: visa.id,
    },
  });
}

/**
 * The leave will not take place: its auto-created exit/re-entry visa that is still unpaid becomes
 * CANCELLED and its open payment request is withdrawn (RETURNED). A visa already paid or issued is
 * left untouched (the fee is spent; HR handles it from the visas page). Returns the cancelled visa ids.
 */
async function cancelLeaveVisa(tx: Db, leave: WorkflowLeave): Promise<string[]> {
  const visas = await tx.visa.findMany({
    where: {
      employeeId: leave.employeeId,
      visaType: EXIT_REENTRY_VISA_TYPE,
      status: 'PENDING_PAYMENT',
      deductedFrom: { contains: leave.id },
    },
    select: { id: true },
  });
  if (!visas.length) return [];
  const ids = visas.map((v) => v.id);
  await tx.visa.updateMany({ where: { id: { in: ids }, status: 'PENDING_PAYMENT' }, data: { status: 'CANCELLED' } });
  await tx.paymentRequest.updateMany({
    where: { entityType: 'VISA', entityId: { in: ids }, status: { in: [...OPEN_PAYMENT_STATUSES] } },
    data: { status: WITHDRAWN_PAYMENT_STATUS, returnReason: 'إلغاء الإجازة المرتبطة بالتأشيرة' },
  });
  return ids;
}

/** Rejects a PENDING leave (manager or HR). */
export async function rejectLeave(tx: Db, leaveId: string, user: AuthUser, reason?: string | null, opts: WorkflowOptions = {}) {
  if (!roleIn(user.role, ROLE_GROUPS.MANAGERS)) throw forbidden();
  const leave = await loadLeave(tx, leaveId);
  if (leave.status !== LEAVE_STATUS.PENDING) throw alreadyProcessed();
  await assertCanManageEmployee(tx, user, leave.employee);
  const cleanReason = reason?.trim() || null;
  const r = await tx.leave.updateMany({
    where: { id: leaveId, status: LEAVE_STATUS.PENDING },
    data: {
      status: LEAVE_STATUS.REJECTED,
      ...(cleanReason ? { notes: appendNote(leave.notes, `سبب الرفض: ${cleanReason}`) } : {}),
    },
  });
  if (r.count === 0) throw alreadyProcessed();
  await logAudit(
    { userId: user.id, action: 'REJECT', entityType: 'Leave', entityId: leaveId, details: { reason: cleanReason, employeeId: leave.employeeId }, ipAddress: opts.ipAddress },
    tx,
  );
  return tx.leave.findUnique({ where: { id: leaveId } });
}

/** Manager/HR records the employee's actual return date (awaiting HR confirmation). */
export async function recordLeaveReturn(tx: Db, leaveId: string, returnDate: Date | null | undefined, user: AuthUser, opts: WorkflowOptions = {}) {
  if (!roleIn(user.role, ROLE_GROUPS.MANAGERS)) throw forbidden();
  const leave = await loadLeave(tx, leaveId);
  if (leave.status !== LEAVE_STATUS.APPROVED || leave.isReturned) throw conflict('لا يمكن إثبات العودة إلا لإجازة معتمدة قائمة');
  // A return notice already awaits HR: it must be confirmed or rejected before a new one is recorded.
  if (leave.actualReturnDate) throw returnAlreadyRecorded();
  await assertCanManageEmployee(tx, user, leave.employee);
  const date = returnDate ?? today();
  if (daysBetween(leave.startDate, date) < 0) throw badRequest('تاريخ العودة لا يمكن أن يسبق تاريخ بداية الإجازة');
  const r = await tx.leave.updateMany({
    where: { id: leaveId, status: LEAVE_STATUS.APPROVED, isReturned: false, actualReturnDate: null },
    data: { actualReturnDate: date },
  });
  if (r.count === 0) throw returnAlreadyRecorded();
  await logAudit(
    { userId: user.id, action: 'UPDATE', entityType: 'Leave', entityId: leaveId, details: { event: 'RETURN_RECORDED', returnDate: dateKey(date) }, ipAddress: opts.ipAddress },
    tx,
  );
  return tx.leave.findUnique({ where: { id: leaveId } });
}

/** HR rejects a recorded return notice (clears actualReturnDate). */
export async function rejectLeaveReturn(tx: Db, leaveId: string, user: AuthUser, opts: WorkflowOptions = {}) {
  if (!roleIn(user.role, ROLE_GROUPS.HR)) throw forbidden();
  const leave = await loadLeave(tx, leaveId);
  if (leave.status !== LEAVE_STATUS.APPROVED || leave.isReturned || !leave.actualReturnDate) throw alreadyProcessed();
  const r = await tx.leave.updateMany({
    where: { id: leaveId, status: LEAVE_STATUS.APPROVED, isReturned: false, actualReturnDate: { not: null } },
    data: { actualReturnDate: null },
  });
  if (r.count === 0) throw alreadyProcessed();
  await logAudit(
    { userId: user.id, action: 'REJECT', entityType: 'Leave', entityId: leaveId, details: { event: 'RETURN_REJECTED' }, ipAddress: opts.ipAddress },
    tx,
  );
  return tx.leave.findUnique({ where: { id: leaveId } });
}

async function shortenedLeaveData(tx: Db, leave: WorkflowLeave, newEnd: Date) {
  const newTotalDays = inclusiveDays(leave.startDate, newEnd);
  const pastSickDays = leave.leaveType === 'SICK' ? await getPastSickDays(tx, leave.employeeId, leave.startDate, leave.id) : 0;
  const calc = recalculateShortenedLeave({
    leaveType: leave.leaveType,
    paidDays: leave.paidDays,
    unpaidDays: leave.unpaidDays,
    totalDeduction: leave.totalDeduction,
    dailyDeductionRate: leave.dailyDeductionRate,
    newTotalDays,
    pastSickDays,
  });
  return { endDate: newEnd, ...calc };
}

/**
 * HR confirms the return (المباشرة): status COMPLETED. An early return shortens the leave so the
 * unused paid days go back to the balance. The balance is NOT reset (leaveAccrualStartDate untouched).
 */
export async function confirmLeaveReturn(tx: Db, leaveId: string, user: AuthUser, opts: WorkflowOptions = {}) {
  if (!roleIn(user.role, ROLE_GROUPS.HR)) throw forbidden();
  const leave = await loadLeave(tx, leaveId);
  if (leave.status !== LEAVE_STATUS.APPROVED || leave.isReturned) throw alreadyProcessed();
  // The return (المباشرة) must be recorded first (RETURN action): confirming without a date would
  // otherwise treat "today" as the return day and silently cancel / cut short a future leave.
  if (!leave.actualReturnDate) throw conflict('يجب إثبات تاريخ عودة الموظف أولاً قبل تأكيد المباشرة');
  await assertCanManageEmployee(tx, user, leave.employee);

  const returnDate = leave.actualReturnDate;
  const lastLeaveDay = addDays(returnDate, -1);
  let data: Prisma.LeaveUpdateManyMutationInput = { isReturned: true, actualReturnDate: returnDate, status: LEAVE_STATUS.COMPLETED };
  if (daysBetween(leave.startDate, lastLeaveDay) < 0) {
    // Returned before the leave started: it never took place.
    data = { ...data, status: LEAVE_STATUS.CANCELLED };
  } else if (daysBetween(lastLeaveDay, leave.endDate) > 0) {
    data = { ...data, ...(await shortenedLeaveData(tx, leave, lastLeaveDay)) };
  }

  const r = await tx.leave.updateMany({
    where: { id: leaveId, status: LEAVE_STATUS.APPROVED, isReturned: false, actualReturnDate: returnDate },
    data,
  });
  if (r.count === 0) throw alreadyProcessed();
  // Returned before the leave started: it never took place, so its unpaid visa is cancelled too.
  const cancelledVisaIds = data.status === LEAVE_STATUS.CANCELLED ? await cancelLeaveVisa(tx, leave) : [];
  await logAudit(
    {
      userId: user.id,
      action: 'APPROVE',
      entityType: 'Leave',
      entityId: leaveId,
      details: { event: 'RETURN_CONFIRMED', returnDate: dateKey(returnDate), status: data.status, ...(cancelledVisaIds.length ? { cancelledVisaIds } : {}) },
      ipAddress: opts.ipAddress,
    },
    tx,
  );
  return tx.leave.findUnique({ where: { id: leaveId } });
}

/**
 * Cancels a leave.
 * - PENDING: HR, or the employee who owns it -> CANCELLED.
 * - APPROVED and not started -> CANCELLED (HR). Started -> cut short to yesterday and COMPLETED (HR).
 */
export async function cancelLeave(tx: Db, leaveId: string, user: AuthUser, opts: WorkflowOptions = {}) {
  const leave = await loadLeave(tx, leaveId);
  const isHr = roleIn(user.role, ROLE_GROUPS.HR);
  const isOwner = !!user.employeeId && user.employeeId === leave.employeeId;
  const todayDate = today();
  let data: Prisma.LeaveUpdateManyMutationInput;
  let expected: Prisma.LeaveWhereInput;

  if (leave.status === LEAVE_STATUS.PENDING) {
    if (!isHr && !isOwner) throw forbidden();
    data = { status: LEAVE_STATUS.CANCELLED };
    expected = { status: LEAVE_STATUS.PENDING };
  } else if (leave.status === LEAVE_STATUS.APPROVED && !leave.isReturned) {
    if (!isHr) throw forbidden();
    await assertCanManageEmployee(tx, user, leave.employee);
    const lastLeaveDay = addDays(todayDate, -1);
    if (daysBetween(leave.startDate, lastLeaveDay) < 0) {
      data = { status: LEAVE_STATUS.CANCELLED };
    } else {
      const end = daysBetween(lastLeaveDay, leave.endDate) > 0 ? lastLeaveDay : leave.endDate;
      data = {
        status: LEAVE_STATUS.COMPLETED,
        isReturned: true,
        actualReturnDate: todayDate,
        ...(end === leave.endDate ? {} : await shortenedLeaveData(tx, leave, end)),
      };
    }
    expected = { status: LEAVE_STATUS.APPROVED, isReturned: false };
  } else {
    throw conflict('لا يمكن إلغاء هذه الإجازة في حالتها الحالية');
  }

  const r = await tx.leave.updateMany({ where: { id: leaveId, ...expected }, data });
  if (r.count === 0) throw alreadyProcessed();
  const cancelledVisaIds = data.status === LEAVE_STATUS.CANCELLED ? await cancelLeaveVisa(tx, leave) : [];
  await logAudit(
    {
      userId: user.id,
      action: 'UPDATE',
      entityType: 'Leave',
      entityId: leaveId,
      details: { event: 'CANCELLED', from: leave.status, to: data.status, ...(cancelledVisaIds.length ? { cancelledVisaIds } : {}) },
      ipAddress: opts.ipAddress,
    },
    tx,
  );
  return tx.leave.findUnique({ where: { id: leaveId } });
}

// ---------------------------------------------------------------------------
// Internal transfers
// ---------------------------------------------------------------------------

async function loadPendingTransfer(tx: Db, transferId: string) {
  const transfer = await tx.transferRequest.findUnique({
    where: { id: transferId },
    select: {
      id: true,
      status: true,
      employeeId: true,
      toBranchId: true,
      toWorkSchedule: true,
      assetAction: true,
      employee: { select: { ...employeeScopeSelect, isTerminated: true } },
    },
  });
  if (!transfer) throw notFound('طلب النقل غير موجود');
  if (transfer.status !== TRANSFER_STATUS.PENDING) throw alreadyProcessed();
  return transfer;
}

/** HR approves a PENDING transfer: moves the employee to the new branch/schedule and clears assets when requested. */
export async function approveTransfer(tx: Db, transferId: string, user: AuthUser, opts: WorkflowOptions & { hrNote?: string | null } = {}) {
  if (!roleIn(user.role, ROLE_GROUPS.HR)) throw forbidden();
  const transfer = await loadPendingTransfer(tx, transferId);
  await assertCanManageEmployee(tx, user, transfer.employee);
  if (transfer.employee.isTerminated) throw conflict('لا يمكن نقل موظف منتهية خدماته');
  const branch = await tx.branch.findUnique({ where: { id: transfer.toBranchId }, select: { id: true } });
  if (!branch) throw badRequest('الفرع المنقول إليه غير موجود');

  const r = await tx.transferRequest.updateMany({
    where: { id: transferId, status: TRANSFER_STATUS.PENDING },
    data: { status: TRANSFER_STATUS.APPROVED, ...(opts.hrNote !== undefined ? { hrNote: opts.hrNote?.trim() || null } : {}) },
  });
  if (r.count === 0) throw alreadyProcessed();

  // A department belongs to one branch: keep it only if it is part of the destination branch.
  const departmentId = transfer.employee.departmentId;
  let clearDepartment = false;
  if (departmentId) {
    const dept = await tx.department.findUnique({ where: { id: departmentId }, select: { branchId: true } });
    clearDepartment = !dept || dept.branchId !== transfer.toBranchId;
  }

  await tx.employee.update({
    where: { id: transfer.employeeId },
    data: {
      branchId: transfer.toBranchId,
      ...(transfer.toWorkSchedule ? { workSchedule: transfer.toWorkSchedule } : {}),
      ...(clearDepartment ? { departmentId: null } : {}),
    },
  });
  // Custody items (العهد) go back to the warehouse, like the assets "clear" action.
  let clearedAssetIds: string[] = [];
  if (transfer.assetAction === 'CLEAR') {
    const held = await tx.asset.findMany({
      where: {
        employeeId: transfer.employeeId,
        returnDate: null,
        status: { notIn: [ASSET_STATUS.DAMAGED, ASSET_STATUS.TRANSFERRED] },
      },
      select: { id: true },
    });
    clearedAssetIds = held.map((a) => a.id);
    if (clearedAssetIds.length) {
      await tx.asset.updateMany({
        where: { id: { in: clearedAssetIds }, employeeId: transfer.employeeId, returnDate: null },
        data: { returnDate: today(), status: ASSET_STATUS.VACANT, employeeId: null },
      });
    }
  }
  await logAudit(
    {
      userId: user.id,
      action: 'APPROVE',
      entityType: 'TransferRequest',
      entityId: transferId,
      details: {
        employeeId: transfer.employeeId,
        toBranchId: transfer.toBranchId,
        toWorkSchedule: transfer.toWorkSchedule,
        departmentCleared: clearDepartment ? departmentId : null,
        assetsCleared: clearedAssetIds.length,
        clearedAssetIds,
      },
      ipAddress: opts.ipAddress,
    },
    tx,
  );
  return tx.transferRequest.findUnique({ where: { id: transferId } });
}

export async function rejectTransfer(tx: Db, transferId: string, user: AuthUser, reason?: string | null, opts: WorkflowOptions = {}) {
  if (!roleIn(user.role, ROLE_GROUPS.HR)) throw forbidden();
  const transfer = await loadPendingTransfer(tx, transferId);
  await assertCanManageEmployee(tx, user, transfer.employee);
  const note = reason?.trim() || null;
  const r = await tx.transferRequest.updateMany({
    where: { id: transferId, status: TRANSFER_STATUS.PENDING },
    data: { status: TRANSFER_STATUS.REJECTED, ...(note ? { hrNote: note } : {}) },
  });
  if (r.count === 0) throw alreadyProcessed();
  await logAudit(
    { userId: user.id, action: 'REJECT', entityType: 'TransferRequest', entityId: transferId, details: { reason: note, employeeId: transfer.employeeId }, ipAddress: opts.ipAddress },
    tx,
  );
  return tx.transferRequest.findUnique({ where: { id: transferId } });
}

// ---------------------------------------------------------------------------
// Attendance corrections
// ---------------------------------------------------------------------------

/** The employee's WorkSchedule: Employee.workSchedule (name) within the branch, else the branch's only schedule. */
export async function resolveEmployeeSchedule(db: Db, employeeId: string) {
  const employee = await db.employee.findUnique({ where: { id: employeeId }, select: { id: true, branchId: true, workSchedule: true } });
  if (!employee) throw notFound('الموظف غير موجود');
  if (!employee.branchId) return { employee, schedule: null };
  const schedules = await db.workSchedule.findMany({
    where: { branchId: employee.branchId },
    select: { id: true, name: true, shiftType: true, startTime: true, endTime: true, startTime2: true, endTime2: true, flexibleHours: true, isExemptFromAttendance: true },
    orderBy: { createdAt: 'asc' },
  });
  return { employee, schedule: pickEmployeeSchedule(schedules, employee.workSchedule) };
}

const correctionSelect = {
  id: true,
  employeeId: true,
  date: true,
  reason: true,
  status: true,
  correctionType: true,
  isManagerApproved: true,
  isHrApproved: true,
  punchId: true,
  employee: { select: employeeScopeSelect },
} as const;

/**
 * Approves an attendance correction.
 * stage MANAGER (default for non-HR managers): marks the manager approval (fingerprint
 * corrections only: general requests "[طلب: ...]" are HR-only and answer 403 here).
 * stage HR (default for HR): final approval, never waits for the manager. Data-update requests
 * apply only the tagged mobile / email lines (never the IBAN); other general requests are just
 * approved; fingerprint corrections fill the missing punches from the employee's WorkSchedule
 * and recompute late/early minutes.
 */
export async function approveAttendanceCorrection(
  tx: Db,
  correctionId: string,
  user: AuthUser,
  opts: WorkflowOptions & { stage?: 'MANAGER' | 'HR'; comment?: string | null } = {},
) {
  const stage = opts.stage ?? (roleIn(user.role, ROLE_GROUPS.HR) ? 'HR' : 'MANAGER');
  const correction = await tx.attendanceCorrection.findUnique({ where: { id: correctionId }, select: correctionSelect });
  if (!correction) throw notFound('الطلب غير موجود');
  if (correction.status !== CORRECTION_STATUS.PENDING) throw alreadyProcessed();
  await assertCanManageEmployee(tx, user, correction.employee);
  const comment = opts.comment?.trim() || null;
  const hrDirect = isHrDirectRequest(correction.reason);

  if (stage === 'MANAGER') {
    if (!roleIn(user.role, ROLE_GROUPS.MANAGERS)) throw forbidden();
    // Letters / data updates go straight to HR: the direct manager has no step in them.
    if (hrDirect) throw forbidden(HR_DIRECT_MESSAGE);
    const r = await tx.attendanceCorrection.updateMany({
      where: { id: correctionId, status: CORRECTION_STATUS.PENDING, isManagerApproved: false },
      data: { isManagerApproved: true, managerApprovedAt: new Date(), ...(comment ? { managerComment: comment } : {}) },
    });
    if (r.count === 0) throw conflict('تمت موافقة المدير على هذا الطلب مسبقاً');
    await logAudit(
      { userId: user.id, action: 'APPROVE', entityType: 'AttendanceCorrection', entityId: correctionId, details: { stage }, ipAddress: opts.ipAddress },
      tx,
    );
    return { outcome: 'MANAGER_APPROVED' as const, message: 'تمت موافقة المدير بنجاح' };
  }

  if (!roleIn(user.role, ROLE_GROUPS.HR)) throw forbidden();
  const r = await tx.attendanceCorrection.updateMany({
    where: { id: correctionId, status: CORRECTION_STATUS.PENDING },
    data: { status: CORRECTION_STATUS.APPROVED, isHrApproved: true, hrApprovedAt: new Date(), ...(comment ? { hrComment: comment } : {}) },
  });
  if (r.count === 0) throw alreadyProcessed();

  const reason = correction.reason ?? '';
  let outcome: 'DATA_UPDATED' | 'GENERAL_APPROVED' | 'ATTENDANCE_UPDATED';
  let message: string;
  let details: Record<string, unknown> = { stage };

  if (reason.trimStart().startsWith(DATA_UPDATE_PREFIX)) {
    // Only tagged, valid mobile / email lines are applied. The IBAN is NEVER applied here:
    // HR changes it by hand in the employee file after checking the IBAN certificate.
    const parsed = parseDataUpdateRequest(reason);
    const data: { mobileNumber?: string; email?: string } = {
      ...(parsed.mobile ? { mobileNumber: parsed.mobile } : {}),
      ...(parsed.email ? { email: parsed.email } : {}),
    };
    const updatedFields = Object.keys(data) as Array<'mobileNumber' | 'email'>;
    if (updatedFields.length > 0) await tx.employee.update({ where: { id: correction.employeeId }, data });
    outcome = 'DATA_UPDATED';
    message = describeDataUpdateOutcome(updatedFields, parsed);
    details = { ...details, updatedFields, ibanRequested: parsed.ibanRequested, rejectedFields: parsed.rejected };
  } else if (hrDirect) {
    outcome = 'GENERAL_APPROVED';
    message = 'تم اعتماد الطلب';
  } else {
    const applied = await applyAttendanceCorrection(tx, correction.employeeId, correction.date, correction.correctionType, {
      punchId: correction.punchId,
      reviewerId: user.id,
    });
    outcome = 'ATTENDANCE_UPDATED';
    message = 'تم الاعتماد وإرسال التعديل للبصمة بنجاح';
    details = { ...details, attendance: applied };
  }

  await logAudit(
    { userId: user.id, action: 'APPROVE', entityType: 'AttendanceCorrection', entityId: correctionId, details, ipAddress: opts.ipAddress },
    tx,
  );
  return { outcome, message };
}

/**
 * Fills the missing punches of the corrected day. A request linked to a rejected / flagged self
 * punch uses that punch's SERVER time for the punch it was about (instead of the scheduled time),
 * so deliberately failing the face / location check cannot erase lateness or early leave; only an
 * explicit LATE / EARLY_LEAVE correction approved by HR zeroes those minutes.
 */
async function applyAttendanceCorrection(
  tx: Db,
  employeeId: string,
  date: Date,
  correctionType: string | null,
  link: { punchId: string | null; reviewerId: string } = { punchId: null, reviewerId: '' },
) {
  const day = dateKey(date);
  if (!day) throw badRequest('تاريخ الطلب غير صالح');
  const attendanceDate = new Date(`${day}T00:00:00.000Z`);
  const [{ schedule }, existing, punch] = await Promise.all([
    resolveEmployeeSchedule(tx, employeeId),
    tx.attendance.findUnique({ where: { employeeId_date: { employeeId, date: attendanceDate } } }),
    link.punchId
      ? tx.attendancePunch.findUnique({ where: { id: link.punchId }, select: { id: true, employeeId: true, type: true, createdAt: true } })
      : Promise.resolve(null),
  ]);
  const linked = punch && punch.employeeId === employeeId ? punch : null;
  const times = defaultPunchTimes(schedule);
  const scheduled = buildPunches(day, times.startTime, times.endTime);
  const checkIn = existing?.checkIn ?? (linked?.type === 'IN' ? linked.createdAt : scheduled.checkIn);
  const checkOut = existing?.checkOut ?? (linked?.type === 'OUT' ? linked.createdAt : scheduled.checkOut);
  const calc = computeLateEarly({ schedule, dayKey: day, checkIn, checkOut });
  const lateMinutes = correctionType === 'LATE' ? 0 : calc.lateMinutes;
  const earlyLeaveMin = correctionType === 'EARLY_LEAVE' ? 0 : calc.earlyLeaveMin;
  const values = {
    checkIn,
    checkOut,
    checkInSource: existing?.checkIn ? (existing.checkInSource ?? null) : ATTENDANCE_SOURCE.CORRECTION,
    checkOutSource: existing?.checkOut ? (existing.checkOutSource ?? null) : ATTENDANCE_SOURCE.CORRECTION,
    // HR has looked at the day: a pending "flagged" warning is resolved by the approval.
    flagged: false,
    status: ATTENDANCE_STATUS.PRESENT,
    lateMinutes,
    earlyLeaveMin,
    earlyMinutes: earlyLeaveMin,
    overtimeMin: calc.overtimeMin,
  };
  const saved = existing
    ? await tx.attendance.update({ where: { id: existing.id }, data: values, select: { id: true } })
    : await tx.attendance.create({ data: { employeeId, date: attendanceDate, ...values }, select: { id: true } });
  if (linked) {
    await tx.attendancePunch.update({
      where: { id: linked.id },
      data: { reviewedAt: new Date(), reviewedById: link.reviewerId || null, attendanceId: saved.id },
    });
  }
  return { id: saved.id, date: day, lateMinutes, earlyLeaveMin, scheduleFound: !!schedule, punchTimeUsed: !!linked };
}

export async function rejectAttendanceCorrection(tx: Db, correctionId: string, user: AuthUser, reason?: string | null, opts: WorkflowOptions = {}) {
  if (!roleIn(user.role, ROLE_GROUPS.MANAGERS)) throw forbidden();
  const correction = await tx.attendanceCorrection.findUnique({ where: { id: correctionId }, select: correctionSelect });
  if (!correction) throw notFound('الطلب غير موجود');
  if (correction.status !== CORRECTION_STATUS.PENDING) throw alreadyProcessed();
  await assertCanManageEmployee(tx, user, correction.employee);
  const isHr = roleIn(user.role, ROLE_GROUPS.HR);
  if (!isHr && isHrDirectRequest(correction.reason)) throw forbidden(HR_DIRECT_MESSAGE);
  const note = reason?.trim() || null;
  const commentField = isHr ? 'hrComment' : 'managerComment';
  const r = await tx.attendanceCorrection.updateMany({
    where: { id: correctionId, status: CORRECTION_STATUS.PENDING },
    data: { status: CORRECTION_STATUS.REJECTED, ...(note ? { [commentField]: note } : {}) },
  });
  if (r.count === 0) throw alreadyProcessed();
  await logAudit(
    { userId: user.id, action: 'REJECT', entityType: 'AttendanceCorrection', entityId: correctionId, details: { reason: note }, ipAddress: opts.ipAddress },
    tx,
  );
  return { message: 'تم رفض الطلب' };
}
