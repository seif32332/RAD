import { randomUUID } from 'crypto';
import { after, NextResponse } from 'next/server';
import { z, type ZodTypeAny } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { issuePayslipsQuietly } from '@/lib/documents/service';
import { getClientIp, requireEmployeeId, requireUser, type AuthUser } from '@/lib/auth';
import { DEDUCTION_STATUS, PAYROLL_STATUS, ROLE_GROUPS, roleIn } from '@/lib/constants';
import { badRequest, conflict, forbidden, handleApiError, notFound, parseBody, parseQuery } from '@/lib/http';
import { zDate, zId, zInt, zMoney, zMonth, zOptMoney, zOptText, zPagination, zText, zYear, zBool } from '@/lib/validation';
import { logAudit } from '@/lib/audit';
import { assertCanManageEmployee, managedEmployeesWhere } from '@/lib/hr-workflows';
import { roundMoney, sumMoney } from '@/lib/money';
import { addDays, daysBetween, todayKey } from '@/lib/dates';
import {
  approveCompanyPayrollMonth,
  dailyRate,
  draftMonths,
  hasStoredBreakdown,
  monthIndex,
  payCompanyPayrollMonth,
  payrollMonthCompanies,
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
import { resolveSelfContext, resolveTeamContext } from '@/lib/employee-scope';
import { ALL_COMPANIES, authz, resolveActor, scopedContext, scopedPrisma, type ScopeContext, type ScopedPrismaClient } from '@/modules/iam';
import { moneyActorOf } from '@/modules/platform';
import {
  createDeduction,
  createLoan,
  referDeductionToInvestigation,
  requestDeductionWaiver,
  resolveDeductionObjection,
  runPayrollTransaction,
  submitDeductionObjection,
} from '@/modules/payroll';
import { createBonus } from '@/modules/compensation';
import { isSeparated } from '@/modules/lifecycle';
import { hasOpenEos } from '@/modules/offboarding';
import { assignOvertime, decideOvertime } from '@/modules/time';

export const dynamic = 'force-dynamic';

/**
 * Pages that read the hub: payrolls / loans / penalties / overtimes and the payments screen's
 * loans awaiting transfer (PAYROLL: HR + finance), and penalties for branch / department
 * managers (team scope, no salary data). Gov relations use /api/payments only (403 here).
 */
const HUB_READ_ROLES = [...new Set([...ROLE_GROUPS.PAYROLL, ...ROLE_GROUPS.MANAGERS])];
const MANAGERS_OR_PAYROLL = [...new Set([...ROLE_GROUPS.MANAGERS, ...ROLE_GROUPS.PAYROLL])];

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
    // P1-SCOPE: payroll users read their companies (ScopedContext), managers their team inside their
    // own company (TeamContext). Lists and counts go through the scoped client.
    const actor = await resolveActor(prisma, user);
    const scope = roleIn(user.role, ROLE_GROUPS.PAYROLL) ? scopedContext(actor) : await resolveTeamContext(prisma, actor);
    authz.assert(scope, 'payroll.read');
    const db = scopedPrisma(scope);
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
      const rows = await db.deduction.findMany({
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
        ? db.payroll.findMany({
            where: payrollWhere,
            include: { employee: payrollEmployeeSelect },
            orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
            ...paging,
          })
        : none,
      wants('overtimes') ? db.overtimeRequest.findMany({ include, orderBy: { createdAt: 'desc' }, ...paging }) : none,
      wants('deductions') ? db.deduction.findMany({ include, orderBy: { createdAt: 'desc' }, ...paging }) : none,
      wants('loans') ? db.loan.findMany({ include, orderBy: { createdAt: 'desc' }, ...paging }) : none,
      wants('allowances') ? db.allowance.findMany({ include, orderBy: { createdAt: 'desc' }, ...paging }) : none,
      wants('workAssignments') ? db.workAssignment.findMany({ include, orderBy: { createdAt: 'desc' }, ...paging }) : none,
    ]);
    const payrolls = payrollRows.map((p) => ({ ...p, breakdown: storedBreakdown(p) }));

    let page: Record<string, number> | undefined;
    if (q.take !== undefined || q.skip !== undefined) {
      const [cPay, cOt, cDed, cLoan, cAllow, cWa] = await Promise.all([
        wants('payrolls') ? db.payroll.count({ where: payrollWhere }) : 0,
        wants('overtimes') ? db.overtimeRequest.count() : 0,
        wants('deductions') ? db.deduction.count() : 0,
        wants('loans') ? db.loan.count() : 0,
        wants('allowances') ? db.allowance.count() : 0,
        wants('workAssignments') ? db.workAssignment.count() : 0,
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
  /** The company whose month is approved (ARC-PAY-A7: one company per approval). Optional when only one has drafts. */
  companyId: z.preprocess(emptyToUndefined, zId.optional()),
  /** Refused (BL-PAY-008): approval and payment are never one call. */
  markPaid: z.preprocess(emptyToUndefined, zBool.optional()),
});

const MonthPayload = z.object({ month: zMonth, year: zYear, companyId: z.preprocess(emptyToUndefined, zId.optional()) });

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

type Ctx = { user: AuthUser; ip: string; db: ScopedPrismaClient; scope: ScopeContext; idempotencyKey: string | null };

/**
 * The operation key of a money act (LIFECYCLE_MODEL §2.2): the client's Idempotency-Key (a retry
 * replays), else derived from (act, entity, user) so a double click replays, or a fresh key for a
 * creation without one.
 */
function opKey(ctx: Pick<Ctx, 'user' | 'idempotencyKey'>, ...parts: string[]): string {
  return ctx.idempotencyKey ? `${parts[0]}:k:${ctx.user.id}:${ctx.idempotencyKey.slice(0, 100)}` : parts.join(':');
}

/**
 * The company of a month-level act (ARC-PAY-A7: payroll is per company; no multi-company approval,
 * DOMAIN_BOUNDARIES §5.4.3): the one named, which must be in the user's scope, else the only company of
 * the user's scope with a month in the wanted state; several → 400 listing them.
 */
async function monthCompany(ctx: Ctx, year: number, month: number, requested: string | undefined, want: 'drafts' | 'approved'): Promise<string> {
  if (requested) {
    if (ctx.scope.companies !== ALL_COMPANIES && !ctx.scope.companies.includes(requested)) throw notFound('الشركة غير موجودة');
    return requested;
  }
  const rows = (await payrollMonthCompanies(asTx(ctx.db), year, month)).filter((c) => (want === 'drafts' ? c.drafts > 0 : c.status === 'APPROVED'));
  if (rows.length === 1) return rows[0].companyId;
  if (!rows.length) {
    throw conflict(want === 'drafts' ? `لا توجد مسودات رواتب بانتظار الاعتماد لشهر ${month}/${year}` : `لا يوجد مسير معتمد بانتظار الصرف لشهر ${month}/${year}`);
  }
  throw badRequest('المسير لكل شركة على حدة: حدد الشركة', { code: 'COMPANY_REQUIRED', companies: rows });
}

/** A transaction of the scoped client, handed to the legacy helpers that take a TransactionClient. */
const asTx = (tx: unknown) => tx as Prisma.TransactionClient;

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
    // P1-SCOPE: every handler works through the scoped client (and its transactions): payroll users in
    // their companies, managers in their team (own company), employees on their own records. A row
    // outside the context is "not found"; month-level approval / payment covers the context's
    // companies only.
    const actor = await resolveActor(prisma, user);
    const scope = roleIn(user.role, ROLE_GROUPS.PAYROLL)
      ? scopedContext(actor)
      : roleIn(user.role, ROLE_GROUPS.MANAGERS)
        ? await resolveTeamContext(prisma, actor)
        : await resolveSelfContext(prisma, actor);
    authz.assert(scope, 'payroll.hub.act');
    const ctx: Ctx = { user, ip: getClientIp(req), db: scopedPrisma(scope), scope, idempotencyKey: req.headers.get('idempotency-key')?.trim() || null };
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
  async UPDATE_OVERTIME_STATUS(payload, ctx) {
    const { user, ip, db } = ctx;
    requireGroup(user, ROLE_GROUPS.PAYROLL);
    const { id, status } = parsePayload(OvertimeStatusPayload, payload);
    // time.decideOvertime behind money.gateway: never one's own overtime (BR-PAY-001), decidedById recorded.
    const updated = await runPayrollTransaction(db, (tx) => decideOvertime(tx, { actor: moneyActorOf(user), overtimeId: id, status, operationKey: opKey(ctx, 'overtime.decide', id, status, user.id), ipAddress: ip }));
    return ok('تم التحديث بنجاح', updated);
  },

  async CREATE_OVERTIME_ASSIGNMENT(payload, ctx) {
    const { user, ip, db } = ctx;
    requireGroup(user, ROLE_GROUPS.PAYROLL);
    const p = parsePayload(CreateOvertimePayload, payload);
    const byHours = p.type === 'HOURS' || p.type === 'BIOMETRIC';
    if (byHours && !(p.hours && p.hours > 0)) throw badRequest('يرجى إدخال عدد الساعات');
    if (!byHours && !(p.amount && p.amount > 0)) throw badRequest('يرجى إدخال المبلغ المقطوع');

    const month = p.date.getUTCMonth() + 1;
    const year = p.date.getUTCFullYear();
    const [employee, finalized] = await Promise.all([
      db.employee.findUnique({ where: { id: p.employeeId }, select: { id: true } }),
      db.payroll.findFirst({
        where: { employeeId: p.employeeId, month, year, status: { not: PAYROLL_STATUS.DRAFT } },
        select: { id: true },
      }),
    ]);
    if (!employee) throw notFound('الموظف غير موجود');
    if (finalized) throw conflict('مسير رواتب هذا الشهر معتمد للموظف مسبقاً؛ اختر تاريخاً في شهر لم يُعتمد مسيره بعد');

    // time.assignOvertime behind money.gateway: effective at once (BL-PAY-007 makes it PENDING), never to oneself.
    const created = await runPayrollTransaction(db, (tx) =>
      assignOvertime(tx, {
        actor: moneyActorOf(user),
        employeeId: p.employeeId,
        date: p.date,
        type: p.type,
        hours: byHours ? (p.hours ?? 0) : 0,
        amount: byHours ? 0 : (p.amount ?? 0),
        reason: p.reason ?? null,
        operationKey: opKey(ctx, 'overtime.assign', randomUUID()),
        ipAddress: ip,
      }),
    );
    return ok('تم حفظ التكليف واعتماده', created);
  },

  // ---------------------------------------------------------------- payroll
  async APPROVE_DRAFTS(payload, ctx) {
    const { user, ip, db } = ctx;
    requireGroup(user, ROLE_GROUPS.PAYROLL);
    const p = parsePayload(ApproveDraftsPayload, payload);
    // BL-PAY-008 (DEC-PO-005): approving and paying are never one call; the payment is its own act
    // (MARK_PAYROLL_PAID) by someone who approved nothing of the month.
    if (p.markPaid) throw badRequest('لا يُعتمد المسير ويُصرف في طلب واحد: الاعتماد أولاً، ثم يسجّل الصرف شخص آخر غير المعتمد', { code: 'APPROVE_AND_PAY_REFUSED' });

    // DEC-010: approval always names the month explicitly (never inferred from loaded rows).
    if (p.month === undefined || p.year === undefined) {
      const months = await draftMonths(asTx(db));
      if (months.length === 0) throw conflict('لا توجد مسودات رواتب بانتظار الاعتماد');
      throw badRequest('يرجى تحديد الشهر والسنة المراد اعتماد مسيرهما', { months });
    }
    const m = p.month;
    const y = p.year;
    const companyId = await monthCompany(ctx, y, m, p.companyId, 'drafts');
    const monthRow = await db.payrollMonth.findUnique({ where: { companyId_year_month: { companyId, year: y, month: m } }, select: { version: true } });
    const result = await approveCompanyPayrollMonth(db, {
      companyId,
      year: y,
      month: m,
      actor: moneyActorOf(user),
      operationKey: opKey(ctx, 'payroll.approve', companyId, `${y}-${m}`, `v${monthRow?.version ?? 0}`, user.id),
      ipAddress: ip,
    });
    const reserved = result.reservedEmployeeIds.length;
    return ok(
      reserved
        ? `تم اعتماد ${result.count} سطراً من مسير شهر ${m}/${y}؛ سطرك (${reserved}) يعتمده شخص آخر`
        : `تم اعتماد مسير رواتب شهر ${m}/${y} بنجاح`,
      undefined,
      { count: result.count, month: m, year: y, companyId, status: result.monthStatus === 'APPROVED' ? PAYROLL_STATUS.APPROVED : 'PARTIALLY_APPROVED', reservedEmployeeIds: result.reservedEmployeeIds, replayed: result.replayed },
    );
  },

  async MARK_PAYROLL_PAID(payload, ctx) {
    const { user, ip, db } = ctx;
    requireGroup(user, ROLE_GROUPS.FINANCE);
    const { month, year, companyId: requested } = parsePayload(MonthPayload, payload);
    const companyId = await monthCompany(ctx, year, month, requested, 'approved');
    const monthRow = await db.payrollMonth.findUnique({ where: { companyId_year_month: { companyId, year, month } }, select: { version: true } });
    // payroll.markPayrollMonthPaid behind money.gateway: the payer approved nothing of the month (BR-PAY-002).
    const { count } = await payCompanyPayrollMonth(db, {
      companyId,
      year,
      month,
      actor: moneyActorOf(user),
      operationKey: opKey(ctx, 'payroll.pay', companyId, `${year}-${month}`, `v${monthRow?.version ?? 0}`, user.id),
      ipAddress: ip,
    });
    after(() => issuePayslipsQuietly(year, month));
    return ok(`تم تسجيل صرف مسير رواتب شهر ${month}/${year}`, undefined, { count, month, year, companyId });
  },

  // ---------------------------------------------------------------- deductions
  async CREATE_DEDUCTION(payload, ctx) {
    const { user, ip, db } = ctx;
    requireGroup(user, MANAGERS_OR_PAYROLL);
    const p = parsePayload(CreateDeductionPayload, payload);
    await assertManagerScope(user, p.employeeId);
    const category = p.category || 'ATTENDANCE';
    const violationType = p.violationType ?? null;

    const [employee, previous] = await Promise.all([
      db.employee.findUnique({
        where: { id: p.employeeId },
        select: { basicSalary: true, allowances: { where: { isMonthly: true }, select: { name: true, amount: true, isMonthly: true } } },
      }),
      // Same-type violations in the 180 days up to this violation's date (Article 68).
      db.deduction.findMany({
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

    // payroll.createDeduction behind money.gateway (issuedById / decidedById recorded).
    const created = await runPayrollTransaction(db, (tx) =>
      createDeduction(tx, {
        actor: { ...moneyActorOf(user), name: user.name },
        operationKey: opKey(ctx, 'deduction.create', randomUUID()),
        ipAddress: ip,
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
        },
      }),
    );
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

  async REFER_TO_INVESTIGATION(payload, ctx) {
    const { user, ip, db } = ctx;
    requireGroup(user, ROLE_GROUPS.PAYROLL);
    const { id } = parsePayload(IdPayload, payload);
    const investigation = await runPayrollTransaction(db, async (tx) => {
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
      // payroll.referDeductionToInvestigation behind money.gateway (a suspension, never of one's own penalty).
      await referDeductionToInvestigation(tx, {
        actor: { ...moneyActorOf(user), name: user.name },
        deductionId: id,
        investigationId: inv.id,
        notIn: [DEDUCTION_STATUS.WAIVED, DEDUCTION_STATUS.REJECTED],
        message: 'لا يمكن إحالة المخالفة: تمت إحالتها أو معالجتها مسبقاً',
        operationKey: opKey(ctx, 'deduction.refer', id, user.id),
        ipAddress: ip,
      });
      await logAudit({ userId: user.id, action: 'UPDATE', entityType: 'DEDUCTION', entityId: id, details: { referredTo: inv.id }, ipAddress: ip }, asTx(tx));
      return inv;
    });
    return ok('تم إحالة المخالفة للتحقيق الإداري', investigation);
  },

  async SUBMIT_OBJECTION(payload, ctx) {
    const { user, ip, db } = ctx;
    const { id, objectionText } = parsePayload(ObjectionPayload, payload);
    const updated = await runPayrollTransaction(db, async (tx) => {
      const d = await tx.deduction.findUnique({ where: { id }, select: { id: true, employeeId: true } });
      if (!d) throw notFound('المخالفة غير موجودة');
      if (!roleIn(user.role, ROLE_GROUPS.PAYROLL)) {
        const ownId = await requireEmployeeId(user);
        if (d.employeeId !== ownId) throw forbidden();
      }
      // payroll.submitDeductionObjection: a request (the employee objects to his own penalty).
      return submitDeductionObjection(tx, { actor: { ...moneyActorOf(user), name: user.name }, deductionId: id, objectionText, operationKey: opKey(ctx, 'deduction.object', id, user.id), ipAddress: ip });
    });
    return ok('تم تسجيل اعتراض الموظف', updated);
  },

  async RESOLVE_OBJECTION(payload, ctx) {
    const { user, ip, db } = ctx;
    requireGroup(user, ROLE_GROUPS.PAYROLL);
    const { id, decision } = parsePayload(ResolveObjectionPayload, payload);
    // payroll.resolveDeductionObjection behind money.gateway: never on one's own penalty.
    const updated = await runPayrollTransaction(db, (tx) =>
      resolveDeductionObjection(tx, { actor: { ...moneyActorOf(user), name: user.name }, deductionId: id, decision, operationKey: opKey(ctx, 'deduction.resolveObjection', id, decision, user.id), ipAddress: ip }),
    );
    return ok(`تم ${decision === 'ACCEPTED' ? 'قبول' : 'رفض'} الاعتراض`, updated);
  },

  async APPROVE_DEDUCTION_AMOUNT(payload, { user, ip, db }) {
    requireGroup(user, ROLE_GROUPS.PAYROLL);
    const { id, amount } = parsePayload(ApproveAmountPayload, payload);
    const updated = await db.$transaction((tx) => approveDeduction(asTx(tx), id, user, { amount, ipAddress: ip }));
    return ok('تم تسعير المخالفة وايقاع الخصم', updated);
  },

  async WAIVE_DEDUCTION(payload, { user, ip, db }) {
    requireGroup(user, ROLE_GROUPS.PAYROLL);
    const { id } = parsePayload(IdPayload, payload);
    const updated = await db.$transaction((tx) => waiveDeduction(asTx(tx), id, user, { ipAddress: ip }));
    return ok('تم إسقاط المخالفة بالكامل', updated);
  },

  async REQUEST_WAIVE_DEDUCTION(payload, ctx) {
    const { user, ip, db } = ctx;
    requireGroup(user, MANAGERS_OR_PAYROLL);
    const { id } = parsePayload(IdPayload, payload);
    const updated = await runPayrollTransaction(db, async (tx) => {
      const d = await tx.deduction.findUnique({ where: { id }, select: { id: true, employeeId: true } });
      if (!d) throw notFound('المخالفة غير موجودة');
      await assertManagerScope(user, d.employeeId);
      return requestDeductionWaiver(tx, { actor: { ...moneyActorOf(user), name: user.name }, deductionId: id, operationKey: opKey(ctx, 'deduction.requestWaiver', id, user.id), ipAddress: ip });
    });
    return ok('تم إرسال طلب الإسقاط للموارد البشرية', updated);
  },

  async REJECT_WAIVE_DEDUCTION(payload, { user, ip, db }) {
    requireGroup(user, ROLE_GROUPS.PAYROLL);
    const { id } = parsePayload(IdPayload, payload);
    const updated = await db.$transaction(async (tx) => {
      const d = await tx.deduction.findUnique({ where: { id }, select: { status: true } });
      if (!d) throw notFound('المخالفة غير موجودة');
      if (d.status !== DEDUCTION_STATUS.PENDING_WAIVE_APPROVAL) throw conflict('لا يوجد طلب إسقاط معلق لهذه المخالفة');
      return approveDeduction(asTx(tx), id, user, { ipAddress: ip });
    });
    return ok('تم رفض طلب الإسقاط وإعادة المخالفة', updated);
  },

  // ---------------------------------------------------------------- loans
  async CREATE_LOAN(payload, ctx) {
    const { user, ip, db } = ctx;
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

    const employee = await db.employee.findUnique({ where: { id: employeeId }, select: { id: true, employmentState: true, isTerminated: true, terminationDate: true } });
    if (!employee) throw notFound('الموظف غير موجود');
    if (isSeparated(employee)) throw conflict('لا يمكن تسجيل سلفة لموظف منتهية خدمته');

    // payroll.createLoan behind money.gateway: a pending request (for oneself too, DEC-PO-006), createdById recorded.
    // BL-LCY-012 (BR-LCY-011): no new loan once an end-of-service settlement of the current employment
    // period exists (not rejected / reversed), checked in the loan's transaction.
    const created = await runPayrollTransaction(db, async (tx) => {
      if (await hasOpenEos(tx, employeeId)) throw conflict('لا يمكن تسجيل سلفة: للموظف تصفية نهاية خدمة قائمة');
      return createLoan(tx, {
        actor: moneyActorOf(user),
        employeeId,
        amount: p.amount,
        monthlyInstallment: p.monthlyInstallment,
        reason: p.reason ?? '',
        operationKey: opKey(ctx, 'loan.create', randomUUID()),
        ipAddress: ip,
      });
    });
    await logAudit({ userId: user.id, action: 'CREATE', entityType: 'LOAN', entityId: created.id, details: { employeeId, amount: created.amount }, ipAddress: ip });
    return ok('تم تسجيل السلفة', created);
  },

  async APPROVE_LOAN(payload, { user, ip, db }) {
    const { id, level, receiptUrl } = parsePayload(ApproveLoanPayload, payload);
    const updated = await db.$transaction(async (tx) => {
      switch (level) {
        case 'FINANCE':
          if (!receiptUrl) throw badRequest('يجب إرفاق إيصال التحويل');
          return markLoanTransferred(asTx(tx), id, receiptUrl, user, { ipAddress: ip });
        case 'HR_FINAL':
          return approveLoanStep(asTx(tx), id, 'FINANCE', user, { ipAddress: ip });
        default:
          return approveLoanStep(asTx(tx), id, level, user, { ipAddress: ip });
      }
    });
    return ok('تم اعتماد الطلب بنجاح', updated);
  },

  async REJECT_LOAN(payload, { user, ip, db }) {
    const { id, reason } = parsePayload(RejectLoanPayload, payload);
    const updated = await db.$transaction((tx) => rejectLoan(asTx(tx), id, user, reason ?? null, { ipAddress: ip }));
    return ok('تم رفض طلب السلفة', updated);
  },

  async FORGIVE_LOAN(payload, { user, ip, db }) {
    const { id } = parsePayload(IdPayload, payload);
    const updated = await db.$transaction((tx) => forgiveLoan(asTx(tx), id, user, { ipAddress: ip }));
    return ok('تم إسقاط السلفة', updated);
  },

  // ---------------------------------------------------------------- bonuses
  async CREATE_BONUS(payload, ctx) {
    const { user, ip, db } = ctx;
    requireGroup(user, ROLE_GROUPS.PAYROLL);
    const p = parsePayload(CreateBonusPayload, payload);
    if (!(p.amount > 0)) throw badRequest('يرجى إدخال مبلغ المكافأة');

    const [employee, finalized] = await Promise.all([
      db.employee.findUnique({ where: { id: p.employeeId }, select: { id: true, legalCompanyId: true } }),
      db.payroll.findMany({
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

    // compensation.createBonus behind money.gateway: never to oneself (BR-PAY-001), approvedById recorded.
    const created = await runPayrollTransaction(db, (tx) =>
      createBonus(tx, {
        actor: moneyActorOf(user),
        employeeId: p.employeeId,
        name: p.name,
        amount: p.amount,
        payrollMonth: month,
        payrollYear: year,
        companyId: employee.legalCompanyId,
        operationKey: opKey(ctx, 'bonus.create', randomUUID()),
        ipAddress: ip,
      }),
    );
    await logAudit({ userId: user.id, action: 'CREATE', entityType: 'BONUS', entityId: created.id, details: { employeeId: p.employeeId, amount: created.amount, month, year }, ipAddress: ip });
    return ok(`تم إدراج المكافأة للموظف (تُصرف في مسير ${month}/${year})`, created);
  },

  // ---------------------------------------------------------------- work assignments
  async UPDATE_WORK_ASSIGNMENT(payload, { user, ip, db }) {
    requireGroup(user, ROLE_GROUPS.PAYROLL);
    const { id, status } = parsePayload(WorkAssignmentPayload, payload);
    const now = new Date();
    const updated = await db.$transaction(async (tx) => {
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
        asTx(tx),
      );
      return tx.workAssignment.findUniqueOrThrow({ where: { id } });
    });
    return ok('تم تحديث حالة مهمة العمل الخارجية', updated);
  },
};
