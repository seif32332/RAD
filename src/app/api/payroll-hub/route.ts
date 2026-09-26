import { NextResponse } from 'next/server';
import { z, type ZodTypeAny } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireEmployeeId, requireUser, type AuthUser } from '@/lib/auth';
import { DEDUCTION_STATUS, LOAN_STATUS, PAYROLL_STATUS, ROLE_GROUPS, roleIn } from '@/lib/constants';
import { badRequest, conflict, forbidden, handleApiError, notFound, parseBody, parseQuery } from '@/lib/http';
import { zDate, zId, zInt, zMoney, zMonth, zOptMoney, zOptText, zPagination, zText, zYear, zBool } from '@/lib/validation';
import { logAudit } from '@/lib/audit';
import { assertCanManageEmployee, managedEmployeesWhere } from '@/lib/hr-workflows';
import { roundMoney, sumMoney } from '@/lib/money';
import { addDays, daysBetween, todayKey } from '@/lib/dates';
import {
  approvePayrollMonth,
  dailyRate,
  draftMonths,
  hasStoredBreakdown,
  markPayrollMonthPaid,
  monthIndex,
  releaseDeductionFromDraft,
} from '@/lib/payroll';
import {
  approveDeduction,
  approveLoanStep,
  forgiveLoan,
  markLoanTransferred,
  rejectLoan,
  waiveDeduction,
  assertWithinPenaltyCap,
} from '@/lib/finance';

export const dynamic = 'force-dynamic';

/**
 * Pages that read the hub: payrolls / loans / penalties / overtimes and the payments screen's
 * loans awaiting transfer (PAYROLL: HR + finance), and penalties for branch / department
 * managers (team scope, no salary data). Gov relations use /api/payments only (403 here).
 */
const HUB_READ_ROLES = [...new Set([...ROLE_GROUPS.PAYROLL, ...ROLE_GROUPS.MANAGERS])];
const MANAGERS_OR_PAYROLL = [...new Set([...ROLE_GROUPS.MANAGERS, ...ROLE_GROUPS.PAYROLL])];
const TX_OPTIONS = { timeout: 60000, maxWait: 10000 };

const employeeSelect = {
  select: {
    id: true,
    employeeId: true,
    firstNameArabic: true,
    lastNameArabic: true,
    basicSalary: true,
    branch: { select: { nameArabic: true } },
  },
} as const;

/** Team view for branch / department managers: no salary fields. */
const teamEmployeeSelect = {
  select: {
    id: true,
    employeeId: true,
    firstNameArabic: true,
    lastNameArabic: true,
    branch: { select: { nameArabic: true } },
  },
} as const;

const HUB_SECTIONS = ['payrolls', 'overtimes', 'deductions', 'loans', 'allowances', 'workAssignments'] as const;
type HubSection = (typeof HUB_SECTIONS)[number];

const emptyToUndef = (v: unknown) => (v === '' || v === null ? undefined : v);

const HubQuerySchema = zPagination.extend({
  /** Payrolls of one month only (both required together). */
  month: z.preprocess(emptyToUndef, zMonth.optional()),
  year: z.preprocess(emptyToUndef, zYear.optional()),
  /** Comma-separated subset of HUB_SECTIONS (default: all). */
  sections: z.preprocess(emptyToUndef, z.string().max(200).optional()),
});

/**
 * GET /api/payroll-hub[?month&year&take&skip&sections]
 * Without parameters: every list (unchanged behaviour for the existing pages).
 * - month + year: payroll rows of that month only (the payrolls page no longer downloads every
 *   payroll ever; totals / summary / export come from /api/payroll-hub/summary and /export).
 * - take / skip: page every returned list (newest first); `page` then reports the total counts.
 * - sections=payrolls,loans,...: only those lists (the others come back empty).
 * Payroll rows carry their STORED breakdown columns (gosiEmployee, gosiEmployer, loansDeduction,
 * violationsDeduction, leaveDeduction, otherDeductions, bonusAmount, needsReview, reviewNote).
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser(HUB_READ_ROLES);
    const q = parseQuery(req, HubQuerySchema);
    if ((q.month === undefined) !== (q.year === undefined)) throw badRequest('يرجى تحديد الشهر والسنة معاً');
    const include = { employee: employeeSelect };
    const empty = { payrolls: [], overtimes: [], deductions: [], loans: [], allowances: [], workAssignments: [] };
    const paging: { take?: number; skip?: number } = {};
    if (q.take !== undefined) paging.take = q.take;
    if (q.skip !== undefined) paging.skip = q.skip;
    const requested = q.sections
      ? new Set(q.sections.split(',').map((s) => s.trim()).filter((s): s is HubSection => (HUB_SECTIONS as readonly string[]).includes(s)))
      : new Set<HubSection>(HUB_SECTIONS);
    const wants = (s: HubSection) => requested.has(s);

    if (!roleIn(user.role, ROLE_GROUPS.PAYROLL)) {
      // Branch / department managers (penalties page): only their team's violations, without
      // salary data (employee basic salary, the violation's daily salary).
      const where = await managedEmployeesWhere(prisma, user);
      const rows = await prisma.deduction.findMany({
        where: where ? { employee: where } : {},
        include: { employee: teamEmployeeSelect },
        orderBy: { createdAt: 'desc' },
        ...paging,
      });
      const deductions = rows.map(({ dailySalary: _dailySalary, ...d }) => d);
      return NextResponse.json({ ...empty, deductions });
    }

    const payrollWhere = q.month !== undefined && q.year !== undefined ? { month: q.month, year: q.year } : {};
    const none = Promise.resolve([]);
    const [payrollRows, overtimes, deductions, loans, allowances, workAssignments] = await Promise.all([
      wants('payrolls')
        ? prisma.payroll.findMany({
            where: payrollWhere,
            include: { employee: payrollEmployeeSelect },
            orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
            ...paging,
          })
        : none,
      wants('overtimes') ? prisma.overtimeRequest.findMany({ include, orderBy: { createdAt: 'desc' }, ...paging }) : none,
      wants('deductions') ? prisma.deduction.findMany({ include, orderBy: { createdAt: 'desc' }, ...paging }) : none,
      wants('loans') ? prisma.loan.findMany({ include, orderBy: { createdAt: 'desc' }, ...paging }) : none,
      wants('allowances') ? prisma.allowance.findMany({ include, orderBy: { createdAt: 'desc' }, ...paging }) : none,
      wants('workAssignments') ? prisma.workAssignment.findMany({ include, orderBy: { createdAt: 'desc' }, ...paging }) : none,
    ]);
    const payrolls = payrollRows.map((p) => ({ ...p, breakdown: storedBreakdown(p) }));

    let page: Record<string, number> | undefined;
    if (q.take !== undefined || q.skip !== undefined) {
      const [cPay, cOt, cDed, cLoan, cAllow, cWa] = await Promise.all([
        wants('payrolls') ? prisma.payroll.count({ where: payrollWhere }) : 0,
        wants('overtimes') ? prisma.overtimeRequest.count() : 0,
        wants('deductions') ? prisma.deduction.count() : 0,
        wants('loans') ? prisma.loan.count() : 0,
        wants('allowances') ? prisma.allowance.count() : 0,
        wants('workAssignments') ? prisma.workAssignment.count() : 0,
      ]);
      page = {
        take: q.take ?? 0,
        skip: q.skip ?? 0,
        payrolls: cPay,
        overtimes: cOt,
        deductions: cDed,
        loans: cLoan,
        allowances: cAllow,
        workAssignments: cWa,
      };
    }

    return NextResponse.json({ payrolls, overtimes, deductions, loans, allowances, workAssignments, ...(page ? { page } : {}) });
  } catch (err) {
    return handleApiError(err, 'payroll-hub:GET');
  }
}

/** Payroll sheet employee fields (no IBAN: the .xlsx export decrypts it on the server). */
const payrollEmployeeSelect = {
  select: {
    ...employeeSelect.select,
    nationality: true,
    gosiRegime: true,
  },
} as const;

/**
 * Legacy `breakdown` shape of the payroll sheet, now read from the STORED columns (never
 * recomputed from the current employee record). null for rows generated before the columns
 * existed (their split is unknown).
 */
function storedBreakdown(p: {
  totalDeductions: number;
  gosiEmployee: number;
  loansDeduction: number;
  violationsDeduction: number;
  leaveDeduction: number;
  otherDeductions: number;
}) {
  if (!hasStoredBreakdown(p)) return null;
  return {
    loanInstallments: p.loansDeduction,
    penalties: p.violationsDeduction,
    gosi: p.gosiEmployee,
    other: sumMoney([p.leaveDeduction, p.otherDeductions]),
  };
}

// ---------------------------------------------------------------------------
// POST { actionType, payload }
// ---------------------------------------------------------------------------

const ActionSchema = z.object({
  actionType: z.string().trim().min(1).max(64),
  payload: z.unknown().optional(),
});

const emptyToUndefined = (v: unknown) => (v === '' || v === null ? undefined : v);
const optEnum = <T extends [string, ...string[]]>(values: T) => z.preprocess(emptyToUndefined, z.enum(values).optional());

const IdPayload = z.object({ id: zId });

const OvertimeStatusPayload = z.object({ id: zId, status: z.enum(['APPROVED', 'REJECTED']) });

const ApproveDraftsPayload = z.object({
  month: z.preprocess(emptyToUndefined, zMonth.optional()),
  year: z.preprocess(emptyToUndefined, zYear.optional()),
  markPaid: z.preprocess(emptyToUndefined, zBool.optional()),
});

const MonthPayload = z.object({ month: zMonth, year: zYear });

// ---------------------------------------------------------------- discipline rules (pure, unit tested)

/** Article 70: a single violation's penalty may not exceed five days' wage. */
export const DEDUCTION_DAYS_MAX = 5;
/** Article 68: a violation counts as a repeat only within 180 days of the previous one. */
export const OCCURRENCE_WINDOW_DAYS = 180;
/** Article 69: no penalty after 30 days from discovering the violation (warned, not blocked). */
export const LATE_VIOLATION_DAYS = 30;

/**
 * Occurrence number of a violation dated `violationDate`, given the dates of the employee's
 * earlier non-dropped violations of the same type: 1 + those dated within the 180 days up to
 * (and including) that date. Violations dated after it, or older than the window, do not count.
 */
export function occurrenceNumberFor(violationDate: Date, previousDates: readonly Date[]): number {
  const count = previousDates.filter((d) => {
    const age = daysBetween(d, violationDate);
    return age >= 0 && age <= OCCURRENCE_WINDOW_DAYS;
  }).length;
  return count + 1;
}

/** True when `amount` is more than one day's wage (any positive amount when the wage is unknown). */
export function exceedsOneDayWage(amount: number, dailyWage: number): boolean {
  if (!(amount > 0)) return false;
  if (!(dailyWage > 0)) return true;
  return roundMoney(amount) > roundMoney(dailyWage);
}

/**
 * Status of a newly registered violation. Managers' violations always wait for HR pricing. HR's
 * take effect directly only up to one day's wage: a bigger penalty with no linked investigation
 * waits for amount approval (PENDING_AMOUNT_APPROVAL) whatever status was requested.
 */
export function newDeductionStatus(input: { isHr: boolean; requested?: string; amount: number; dailyWage: number }): string {
  if (!input.isHr) return DEDUCTION_STATUS.PENDING_AMOUNT_APPROVAL;
  if (exceedsOneDayWage(input.amount, input.dailyWage)) return DEDUCTION_STATUS.PENDING_AMOUNT_APPROVAL;
  return input.requested ?? DEDUCTION_STATUS.DEDUCTED;
}

/** Arabic warning when the violation is dated more than 30 days before today, else null. */
export function lateViolationWarning(violationDate: Date, now: Date = new Date()): string | null {
  const age = daysBetween(violationDate, todayKey(now));
  if (!(age > LATE_VIOLATION_DAYS)) return null;
  return `تاريخ المخالفة أقدم من ${LATE_VIOLATION_DAYS} يوماً (${age} يوماً). لا يجوز توقيع جزاء بعد مضي ${LATE_VIOLATION_DAYS} يوماً من تاريخ علم المنشأة بالمخالفة (المادة 69)، فتأكد من تاريخ اكتشافها قبل اعتماد أي خصم.`;
}

const CreateDeductionPayload = z.object({
  employeeId: zId,
  date: zDate,
  amount: zOptMoney,
  reason: zText(1000),
  category: zOptText(50),
  violationType: zOptText(100),
  severity: zOptText(20),
  deductionDays: z.preprocess(
    emptyToUndefined,
    zInt
      .pipe(
        z.number()
          .min(0, 'عدد أيام الخصم غير صالح')
          .max(DEDUCTION_DAYS_MAX, `لا يجوز أن يتجاوز الخصم أجر ${DEDUCTION_DAYS_MAX} أيام عن المخالفة الواحدة (المادة 70)`),
      )
      .optional(),
  ),
  issuedBy: zOptText(200),
  status: optEnum([DEDUCTION_STATUS.DEDUCTED, DEDUCTION_STATUS.PENDING_AMOUNT_APPROVAL]),
  lawArticle: zOptText(300),
});

const ObjectionPayload = z.object({ id: zId, objectionText: zText(3000) });
const ResolveObjectionPayload = z.object({ id: zId, decision: z.enum(['ACCEPTED', 'REJECTED']) });
const ApproveAmountPayload = z.object({ id: zId, amount: zMoney });

const CreateLoanPayload = z.object({
  employeeId: z.preprocess(emptyToUndefined, zId.optional()),
  amount: zMoney,
  monthlyInstallment: zMoney,
  reason: zOptText(1000),
});

const CreateOvertimePayload = z.object({
  employeeId: zId,
  date: zDate,
  type: z.preprocess((v) => (v === '' || v == null ? 'HOURS' : v), z.enum(['HOURS', 'LUMP_SUM', 'BIOMETRIC', 'MAX_AMOUNT'])),
  hours: z.preprocess(emptyToUndefined, zMoney.pipe(z.number().max(400)).optional()),
  amount: zOptMoney,
  reason: zOptText(1000),
});

const CreateBonusPayload = z.object({
  employeeId: zId,
  name: zText(200),
  amount: zMoney,
  payrollMonth: z.preprocess(emptyToUndefined, zMonth.optional()),
  payrollYear: z.preprocess(emptyToUndefined, zYear.optional()),
});

const ApproveLoanPayload = z.object({
  id: zId,
  level: z.enum(['MANAGER', 'HR', 'FINANCE', 'HR_FINAL', 'OWNER']),
  receiptUrl: zOptText(2000),
});

const RejectLoanPayload = z.object({ id: zId, reason: zOptText(1000) });

const WorkAssignmentPayload = z.object({
  id: zId,
  status: z.enum(['PENDING_EMPLOYEE', 'PENDING_HR', 'APPROVED', 'REJECTED']),
});

type Ctx = { user: AuthUser; ip: string };

function parsePayload<S extends ZodTypeAny>(schema: S, payload: unknown): z.infer<S> {
  return schema.parse(payload ?? {});
}

function requireGroup(user: AuthUser, group: readonly string[]) {
  if (!roleIn(user.role, group)) throw forbidden();
}

/**
 * Managers outside HR/payroll may only act on their team: direct reports, or their branch
 * (BRANCH_MANAGER) / department (DEPT_MANAGER) - the same scope GET returns - never themselves.
 */
async function assertManagerScope(user: AuthUser, employeeId: string) {
  if (roleIn(user.role, ROLE_GROUPS.PAYROLL)) return;
  if (!user.employeeId) throw forbidden('حسابك غير مرتبط بملف موظف');
  const emp = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, directManagerId: true, branchId: true, departmentId: true },
  });
  if (!emp) throw notFound('الموظف غير موجود');
  await assertCanManageEmployee(prisma, user, emp);
}

const ok = (message: string, data?: unknown, extra?: Record<string, unknown>) =>
  NextResponse.json({ message, ...(data !== undefined ? { data } : {}), ...(extra ?? {}) });

export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.ALL);
    const { actionType, payload } = await parseBody(req, ActionSchema);
    const ctx: Ctx = { user, ip: getClientIp(req) };
    const handler = Object.prototype.hasOwnProperty.call(HANDLERS, actionType) ? HANDLERS[actionType] : undefined;
    if (!handler) throw badRequest('إجراء غير معروف');
    return await handler(payload, ctx);
  } catch (err) {
    return handleApiError(err, 'payroll-hub:POST');
  }
}

type Handler = (payload: unknown, ctx: Ctx) => Promise<NextResponse>;

const HANDLERS: Record<string, Handler> = {
  // ---------------------------------------------------------------- overtime
  async UPDATE_OVERTIME_STATUS(payload, { user, ip }) {
    requireGroup(user, ROLE_GROUPS.PAYROLL);
    const { id, status } = parsePayload(OvertimeStatusPayload, payload);
    const updated = await prisma.$transaction(async (tx) => {
      const res = await tx.overtimeRequest.updateMany({ where: { id, status: 'PENDING' }, data: { status } });
      if (res.count === 0) {
        const exists = await tx.overtimeRequest.findUnique({ where: { id }, select: { id: true } });
        if (!exists) throw notFound();
        throw conflict('تمت معالجة طلب العمل الإضافي مسبقاً');
      }
      await logAudit(
        { userId: user.id, action: status === 'APPROVED' ? 'APPROVE' : 'REJECT', entityType: 'OVERTIME', entityId: id, details: { status }, ipAddress: ip },
        tx,
      );
      return tx.overtimeRequest.findUniqueOrThrow({ where: { id } });
    });
    return ok('تم التحديث بنجاح', updated);
  },

  async CREATE_OVERTIME_ASSIGNMENT(payload, { user, ip }) {
    requireGroup(user, ROLE_GROUPS.PAYROLL);
    const p = parsePayload(CreateOvertimePayload, payload);
    const byHours = p.type === 'HOURS' || p.type === 'BIOMETRIC';
    if (byHours && !(p.hours && p.hours > 0)) throw badRequest('يرجى إدخال عدد الساعات');
    if (!byHours && !(p.amount && p.amount > 0)) throw badRequest('يرجى إدخال المبلغ المقطوع');

    const month = p.date.getUTCMonth() + 1;
    const year = p.date.getUTCFullYear();
    const [employee, finalized] = await Promise.all([
      prisma.employee.findUnique({ where: { id: p.employeeId }, select: { id: true } }),
      prisma.payroll.findFirst({
        where: { employeeId: p.employeeId, month, year, status: { not: PAYROLL_STATUS.DRAFT } },
        select: { id: true },
      }),
    ]);
    if (!employee) throw notFound('الموظف غير موجود');
    if (finalized) throw conflict('مسير رواتب هذا الشهر معتمد للموظف مسبقاً؛ اختر تاريخاً في شهر لم يُعتمد مسيره بعد');

    const created = await prisma.overtimeRequest.create({
      data: {
        employeeId: p.employeeId,
        date: p.date,
        type: p.type,
        hours: byHours ? roundMoney(p.hours ?? 0) : 0,
        amount: byHours ? 0 : roundMoney(p.amount ?? 0),
        reason: p.reason ?? null,
        status: 'APPROVED', // التكليف المباشر يعتبر معتمداً فوراً
      },
    });
    await logAudit({ userId: user.id, action: 'CREATE', entityType: 'OVERTIME', entityId: created.id, details: { type: p.type, hours: created.hours, amount: created.amount }, ipAddress: ip });
    return ok('تم حفظ التكليف واعتماده', created);
  },

  // ---------------------------------------------------------------- payroll
  async APPROVE_DRAFTS(payload, { user, ip }) {
    requireGroup(user, ROLE_GROUPS.PAYROLL);
    const p = parsePayload(ApproveDraftsPayload, payload);
    if (p.markPaid) requireGroup(user, ROLE_GROUPS.FINANCE);

    // DEC-010: approval always names the month explicitly (never inferred from loaded rows).
    if (p.month === undefined || p.year === undefined) {
      const months = await draftMonths(prisma);
      if (months.length === 0) throw conflict('لا توجد مسودات رواتب بانتظار الاعتماد');
      throw badRequest('يرجى تحديد الشهر والسنة المراد اعتماد مسيرهما', { months });
    }
    const m = p.month;
    const y = p.year;

    const result = await prisma.$transaction(async (tx) => {
      const approved = await approvePayrollMonth(tx, y, m);
      const paid = p.markPaid ? await markPayrollMonthPaid(tx, y, m) : 0;
      return { ...approved, paid };
    }, TX_OPTIONS);

    await logAudit({
      userId: user.id,
      action: 'APPROVE',
      entityType: 'PAYROLL',
      entityId: `${y}-${m}`,
      details: { month: m, year: y, approved: result.count, paid: result.paid, loansCompleted: result.loansCompleted },
      ipAddress: ip,
    });
    return ok(
      p.markPaid ? 'تم اعتماد وصرف مسير الرواتب بنجاح' : `تم اعتماد مسير رواتب شهر ${m}/${y} بنجاح`,
      undefined,
      { count: result.count, month: m, year: y, status: p.markPaid ? PAYROLL_STATUS.PAID : PAYROLL_STATUS.APPROVED },
    );
  },

  async MARK_PAYROLL_PAID(payload, { user, ip }) {
    requireGroup(user, ROLE_GROUPS.FINANCE);
    const { month, year } = parsePayload(MonthPayload, payload);
    const count = await prisma.$transaction((tx) => markPayrollMonthPaid(tx, year, month));
    await logAudit({ userId: user.id, action: 'UPDATE', entityType: 'PAYROLL', entityId: `${year}-${month}`, details: { status: PAYROLL_STATUS.PAID, count }, ipAddress: ip });
    return ok(`تم تسجيل صرف مسير رواتب شهر ${month}/${year}`, undefined, { count, month, year });
  },

  // ---------------------------------------------------------------- deductions
  async CREATE_DEDUCTION(payload, { user, ip }) {
    requireGroup(user, MANAGERS_OR_PAYROLL);
    const p = parsePayload(CreateDeductionPayload, payload);
    await assertManagerScope(user, p.employeeId);
    const category = p.category || 'ATTENDANCE';
    const violationType = p.violationType ?? null;

    const [employee, previous] = await Promise.all([
      prisma.employee.findUnique({
        where: { id: p.employeeId },
        select: { basicSalary: true, allowances: { where: { isMonthly: true }, select: { name: true, amount: true, isMonthly: true } } },
      }),
      // Same-type violations in the 180 days up to this violation's date (Article 68).
      prisma.deduction.findMany({
        where: {
          employeeId: p.employeeId,
          category,
          violationType,
          status: { notIn: [DEDUCTION_STATUS.WAIVED, DEDUCTION_STATUS.REJECTED] },
          date: { gte: addDays(p.date, -OCCURRENCE_WINDOW_DAYS), lte: p.date },
        },
        select: { date: true },
      }),
    ]);
    if (!employee) throw notFound('الموظف غير موجود');

    const rate = dailyRate(employee);
    const deductionDays = p.deductionDays ?? 0;
    const amount = roundMoney(deductionDays > 0 ? rate * deductionDays : (p.amount ?? 0));
    assertWithinPenaltyCap(amount, rate);

    // Managers' violations go to HR for pricing; HR's take effect directly only up to one day's
    // wage (a bigger penalty with no investigation waits for amount approval).
    const isHr = roleIn(user.role, ROLE_GROUPS.PAYROLL);
    const status = newDeductionStatus({ isHr, requested: p.status, amount, dailyWage: rate });
    const effective = status === DEDUCTION_STATUS.DEDUCTED;
    const warnings: string[] = [];
    const late = lateViolationWarning(p.date);
    if (late) warnings.push(late);
    if (isHr && status === DEDUCTION_STATUS.PENDING_AMOUNT_APPROVAL && p.status !== DEDUCTION_STATUS.PENDING_AMOUNT_APPROVAL) {
      warnings.push('الخصم يتجاوز أجر يوم واحد ولا يرتبط بتحقيق، لذا سُجّل بانتظار اعتماد المبلغ ولن يدخل المسير قبل اعتماده.');
    }

    const created = await prisma.deduction.create({
      data: {
        employeeId: p.employeeId,
        amount,
        date: p.date,
        reason: p.reason,
        category,
        violationType,
        occurrenceNumber: occurrenceNumberFor(p.date, previous.map((d) => d.date)),
        severity: p.severity || 'LOW',
        deductionDays,
        dailySalary: rate,
        hasFinancialImpact: amount > 0 || deductionDays > 0,
        issuedBy: p.issuedBy || user.name,
        status,
        lawArticle: p.lawArticle ?? null,
        ...(effective ? { approvedBy: user.name, approvedAt: new Date() } : {}),
      },
    });
    await logAudit({
      userId: user.id,
      action: 'CREATE',
      entityType: 'DEDUCTION',
      entityId: created.id,
      details: { employeeId: p.employeeId, amount, status, deductionDays, occurrenceNumber: created.occurrenceNumber, warnings },
      ipAddress: ip,
    });
    return ok(
      effective ? 'تم إدراج المخالفة' : 'تم تسجيل المخالفة بانتظار اعتماد مبلغ الخصم',
      created,
      warnings.length ? { warnings } : undefined,
    );
  },

  async REFER_TO_INVESTIGATION(payload, { user, ip }) {
    requireGroup(user, ROLE_GROUPS.PAYROLL);
    const { id } = parsePayload(IdPayload, payload);
    const investigation = await prisma.$transaction(async (tx) => {
      const d = await tx.deduction.findUnique({
        where: { id },
        select: { id: true, employeeId: true, amount: true, reason: true, category: true, severity: true, payrollMonth: true, isLinkedToPayroll: true },
      });
      if (!d) throw notFound('المخالفة غير موجودة');
      const inv = await tx.investigation.create({
        data: {
          employeeId: d.employeeId,
          subject: `تحقيق بخصوص: ${d.reason}`,
          category: d.category,
          severity: d.severity === 'CRITICAL' ? 'CRITICAL' : 'HIGH',
        },
      });
      const res = await tx.deduction.updateMany({
        where: {
          id,
          isReferredToInvestigation: false,
          isLinkedToPayroll: false,
          status: { notIn: [DEDUCTION_STATUS.WAIVED, DEDUCTION_STATUS.REJECTED] },
        },
        data: { isReferredToInvestigation: true, investigationId: inv.id, status: DEDUCTION_STATUS.UNDER_INVESTIGATION },
      });
      if (res.count === 0) throw conflict('لا يمكن إحالة المخالفة: تمت إحالتها أو معالجتها مسبقاً');
      await releaseDeductionFromDraft(tx, d);
      await logAudit({ userId: user.id, action: 'UPDATE', entityType: 'DEDUCTION', entityId: id, details: { referredTo: inv.id }, ipAddress: ip }, tx);
      return inv;
    });
    return ok('تم إحالة المخالفة للتحقيق الإداري', investigation);
  },

  async SUBMIT_OBJECTION(payload, { user, ip }) {
    const { id, objectionText } = parsePayload(ObjectionPayload, payload);
    const updated = await prisma.$transaction(async (tx) => {
      const d = await tx.deduction.findUnique({
        where: { id },
        select: { id: true, employeeId: true, amount: true, payrollMonth: true, isLinkedToPayroll: true },
      });
      if (!d) throw notFound('المخالفة غير موجودة');
      if (!roleIn(user.role, ROLE_GROUPS.PAYROLL)) {
        const ownId = await requireEmployeeId(user);
        if (d.employeeId !== ownId) throw forbidden();
      }
      const res = await tx.deduction.updateMany({
        where: {
          id,
          hasObjection: false,
          isLinkedToPayroll: false,
          status: { in: [DEDUCTION_STATUS.DEDUCTED, DEDUCTION_STATUS.PENDING_AMOUNT_APPROVAL, 'COMPLETED'] },
        },
        data: {
          hasObjection: true,
          objectionText,
          objectionDate: new Date(),
          objectionStatus: 'PENDING',
          status: DEDUCTION_STATUS.OBJECTION_SUBMITTED,
        },
      });
      if (res.count === 0) throw conflict('لا يمكن الاعتراض على هذه المخالفة (تم الاعتراض أو خُصمت مسبقاً)');
      await releaseDeductionFromDraft(tx, d);
      await logAudit({ userId: user.id, action: 'UPDATE', entityType: 'DEDUCTION', entityId: id, details: { objection: true }, ipAddress: ip }, tx);
      return tx.deduction.findUniqueOrThrow({ where: { id } });
    });
    return ok('تم تسجيل اعتراض الموظف', updated);
  },

  async RESOLVE_OBJECTION(payload, { user, ip }) {
    requireGroup(user, ROLE_GROUPS.PAYROLL);
    const { id, decision } = parsePayload(ResolveObjectionPayload, payload);
    const updated = await prisma.$transaction(async (tx) => {
      const res = await tx.deduction.updateMany({
        where: { id, status: DEDUCTION_STATUS.OBJECTION_SUBMITTED },
        data: {
          objectionStatus: decision,
          status: decision === 'ACCEPTED' ? DEDUCTION_STATUS.WAIVED : DEDUCTION_STATUS.DEDUCTED,
          approvedBy: user.name,
          approvedAt: new Date(),
        },
      });
      if (res.count === 0) {
        const exists = await tx.deduction.findUnique({ where: { id }, select: { id: true } });
        if (!exists) throw notFound('المخالفة غير موجودة');
        throw conflict('تم البت في الاعتراض مسبقاً');
      }
      await logAudit(
        { userId: user.id, action: decision === 'ACCEPTED' ? 'APPROVE' : 'REJECT', entityType: 'DEDUCTION_OBJECTION', entityId: id, details: { decision }, ipAddress: ip },
        tx,
      );
      return tx.deduction.findUniqueOrThrow({ where: { id } });
    });
    return ok(`تم ${decision === 'ACCEPTED' ? 'قبول' : 'رفض'} الاعتراض`, updated);
  },

  async APPROVE_DEDUCTION_AMOUNT(payload, { user, ip }) {
    requireGroup(user, ROLE_GROUPS.PAYROLL);
    const { id, amount } = parsePayload(ApproveAmountPayload, payload);
    const updated = await prisma.$transaction((tx) => approveDeduction(tx, id, user, { amount, ipAddress: ip }));
    return ok('تم تسعير المخالفة وايقاع الخصم', updated);
  },

  async WAIVE_DEDUCTION(payload, { user, ip }) {
    requireGroup(user, ROLE_GROUPS.PAYROLL);
    const { id } = parsePayload(IdPayload, payload);
    const updated = await prisma.$transaction((tx) => waiveDeduction(tx, id, user, { ipAddress: ip }));
    return ok('تم إسقاط المخالفة بالكامل', updated);
  },

  async REQUEST_WAIVE_DEDUCTION(payload, { user, ip }) {
    requireGroup(user, MANAGERS_OR_PAYROLL);
    const { id } = parsePayload(IdPayload, payload);
    const updated = await prisma.$transaction(async (tx) => {
      const d = await tx.deduction.findUnique({
        where: { id },
        select: { id: true, employeeId: true, amount: true, payrollMonth: true, isLinkedToPayroll: true },
      });
      if (!d) throw notFound('المخالفة غير موجودة');
      await assertManagerScope(user, d.employeeId);
      const res = await tx.deduction.updateMany({
        where: {
          id,
          isLinkedToPayroll: false,
          status: { in: [DEDUCTION_STATUS.DEDUCTED, DEDUCTION_STATUS.OBJECTION_REJECTED, DEDUCTION_STATUS.PENDING_AMOUNT_APPROVAL, 'COMPLETED'] },
        },
        data: { status: DEDUCTION_STATUS.PENDING_WAIVE_APPROVAL },
      });
      if (res.count === 0) throw conflict('لا يمكن طلب إسقاط هذه المخالفة (خُصمت أو عولجت مسبقاً)');
      await releaseDeductionFromDraft(tx, d);
      await logAudit({ userId: user.id, action: 'UPDATE', entityType: 'DEDUCTION', entityId: id, details: { status: DEDUCTION_STATUS.PENDING_WAIVE_APPROVAL }, ipAddress: ip }, tx);
      return tx.deduction.findUniqueOrThrow({ where: { id } });
    });
    return ok('تم إرسال طلب الإسقاط للموارد البشرية', updated);
  },

  async REJECT_WAIVE_DEDUCTION(payload, { user, ip }) {
    requireGroup(user, ROLE_GROUPS.PAYROLL);
    const { id } = parsePayload(IdPayload, payload);
    const updated = await prisma.$transaction(async (tx) => {
      const d = await tx.deduction.findUnique({ where: { id }, select: { status: true } });
      if (!d) throw notFound('المخالفة غير موجودة');
      if (d.status !== DEDUCTION_STATUS.PENDING_WAIVE_APPROVAL) throw conflict('لا يوجد طلب إسقاط معلق لهذه المخالفة');
      return approveDeduction(tx, id, user, { ipAddress: ip });
    });
    return ok('تم رفض طلب الإسقاط وإعادة المخالفة', updated);
  },

  // ---------------------------------------------------------------- loans
  async CREATE_LOAN(payload, { user, ip }) {
    const p = parsePayload(CreateLoanPayload, payload);
    let employeeId: string;
    if (roleIn(user.role, ROLE_GROUPS.PAYROLL) && p.employeeId) {
      employeeId = p.employeeId;
    } else {
      // Self-service (employee portal): always the logged-in user's own employee record.
      employeeId = await requireEmployeeId(user);
    }
    if (!(p.amount > 0) || !(p.monthlyInstallment > 0)) throw badRequest('الرجاء التأكد من صحة المبلغ والقسط');
    if (p.monthlyInstallment > p.amount) throw badRequest('لا يمكن أن يتجاوز القسط الشهري مبلغ السلفة');

    const employee = await prisma.employee.findUnique({ where: { id: employeeId }, select: { id: true, isTerminated: true } });
    if (!employee) throw notFound('الموظف غير موجود');
    if (employee.isTerminated) throw conflict('لا يمكن تسجيل سلفة لموظف منتهية خدمته');

    const amount = roundMoney(p.amount);
    const created = await prisma.loan.create({
      data: {
        employeeId,
        amount,
        monthlyInstallment: roundMoney(p.monthlyInstallment),
        reason: p.reason ?? '',
        remainingAmount: amount,
        status: LOAN_STATUS.PENDING,
      },
    });
    await logAudit({ userId: user.id, action: 'CREATE', entityType: 'LOAN', entityId: created.id, details: { employeeId, amount }, ipAddress: ip });
    return ok('تم تسجيل السلفة', created);
  },

  async APPROVE_LOAN(payload, { user, ip }) {
    const { id, level, receiptUrl } = parsePayload(ApproveLoanPayload, payload);
    const updated = await prisma.$transaction(async (tx) => {
      switch (level) {
        case 'FINANCE':
          if (!receiptUrl) throw badRequest('يجب إرفاق إيصال التحويل');
          return markLoanTransferred(tx, id, receiptUrl, user, { ipAddress: ip });
        case 'HR_FINAL':
          return approveLoanStep(tx, id, 'FINANCE', user, { ipAddress: ip });
        default:
          return approveLoanStep(tx, id, level, user, { ipAddress: ip });
      }
    });
    return ok('تم اعتماد الطلب بنجاح', updated);
  },

  async REJECT_LOAN(payload, { user, ip }) {
    const { id, reason } = parsePayload(RejectLoanPayload, payload);
    const updated = await prisma.$transaction((tx) => rejectLoan(tx, id, user, reason ?? null, { ipAddress: ip }));
    return ok('تم رفض طلب السلفة', updated);
  },

  async FORGIVE_LOAN(payload, { user, ip }) {
    const { id } = parsePayload(IdPayload, payload);
    const updated = await prisma.$transaction((tx) => forgiveLoan(tx, id, user, { ipAddress: ip }));
    return ok('تم إسقاط السلفة', updated);
  },

  // ---------------------------------------------------------------- bonuses
  async CREATE_BONUS(payload, { user, ip }) {
    requireGroup(user, ROLE_GROUPS.PAYROLL);
    const p = parsePayload(CreateBonusPayload, payload);
    if (!(p.amount > 0)) throw badRequest('يرجى إدخال مبلغ المكافأة');

    const [employee, finalized] = await Promise.all([
      prisma.employee.findUnique({ where: { id: p.employeeId }, select: { id: true } }),
      prisma.payroll.findMany({
        where: { employeeId: p.employeeId, status: { not: PAYROLL_STATUS.DRAFT } },
        select: { month: true, year: true },
      }),
    ]);
    if (!employee) throw notFound('الموظف غير موجود');

    // Target payroll month: requested or current (Riyadh); skip months whose payroll is already finalized.
    const now = todayKey();
    let year = p.payrollYear ?? Number(now.slice(0, 4));
    let month = p.payrollMonth ?? Number(now.slice(5, 7));
    const closed = new Set(finalized.map((f) => monthIndex(f.year, f.month)));
    for (let i = 0; i < 36 && closed.has(monthIndex(year, month)); i++) {
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }

    const created = await prisma.allowance.create({
      data: {
        employeeId: p.employeeId,
        name: p.name,
        amount: roundMoney(p.amount),
        isMonthly: false, // مكافأة / بدل طارئ لمرة واحدة
        allowanceType: 'OTHER', // a one-off bonus is never a housing / transport / food allowance (workforce engine)
        payrollMonth: month,
        payrollYear: year,
        isPaid: false,
      },
    });
    await logAudit({ userId: user.id, action: 'CREATE', entityType: 'BONUS', entityId: created.id, details: { employeeId: p.employeeId, amount: created.amount, month, year }, ipAddress: ip });
    return ok(`تم إدراج المكافأة للموظف (تُصرف في مسير ${month}/${year})`, created);
  },

  // ---------------------------------------------------------------- work assignments
  async UPDATE_WORK_ASSIGNMENT(payload, { user, ip }) {
    requireGroup(user, ROLE_GROUPS.PAYROLL);
    const { id, status } = parsePayload(WorkAssignmentPayload, payload);
    const now = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      const res = await tx.workAssignment.updateMany({
        where: { id, status: { in: ['PENDING_EMPLOYEE', 'PENDING_HR'] } },
        data: {
          status,
          hrApprovedAt: status === 'APPROVED' ? now : null,
          ...(status === 'PENDING_HR' ? { employeeApprovedAt: now } : {}),
        },
      });
      if (res.count === 0) {
        const exists = await tx.workAssignment.findUnique({ where: { id }, select: { id: true } });
        if (!exists) throw notFound('مهمة العمل غير موجودة');
        throw conflict('تمت معالجة مهمة العمل مسبقاً');
      }
      await logAudit(
        { userId: user.id, action: status === 'APPROVED' ? 'APPROVE' : status === 'REJECTED' ? 'REJECT' : 'UPDATE', entityType: 'WORK_ASSIGNMENT', entityId: id, details: { status }, ipAddress: ip },
        tx,
      );
      return tx.workAssignment.findUniqueOrThrow({ where: { id } });
    });
    return ok('تم تحديث حالة مهمة العمل الخارجية', updated);
  },
};
