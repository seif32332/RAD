import { NextResponse } from 'next/server';
import { z } from 'zod';
import type { LeaveStatus, LeaveType } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import {
  DEFAULT_EXIT_REENTRY_VISA_FEE,
  LOAN_DEDUCTIBLE_STATUSES,
  PAYROLL_STATUS,
  ROLE_GROUPS,
  SETTLEMENT_STATUS,
  roleIn,
} from '@/lib/constants';
import { badRequest, conflict, forbidden, handleApiError, notFound, parseBody } from '@/lib/http';
import { zBool, zId, zOptDate, zOptMoney, zOptText } from '@/lib/validation';
import { logAudit } from '@/lib/audit';
import { activeProtectedLeave } from '@/app/api/employees/[id]/route';
import { decryptField } from '@/lib/crypto';
import { addDays, dateKey, daysBetween, today } from '@/lib/dates';
import { formatMoney, roundMoney, sumMoney } from '@/lib/money';
import { BALANCE_CONSUMING_STATUSES, BALANCE_LEAVE_TYPES, leaveTypeLabel } from '@/lib/leave';
import { loadPayrollSettings, overtimeAmount, overtimeHolders, overtimeLegacyCutoff } from '@/lib/payroll';
import {
  computeSettlement,
  COUNSEL_PENDING_NOTE,
  endOfServiceAward,
  isCounselPendingReason,
  monthOf,
  outstandingLoansForSettlement,
  overtimeDueInSettlement,
  SETTLEMENT_TYPES,
  TERMINATION_REASONS,
  yearsOfService,
} from '@/lib/settlement';
import { getNumericSetting, SETTING_KEYS } from '@/lib/hr-workflows';
import { approveSettlement, markSettlementPaid, rejectSettlement, SETTLEMENT_LOANS_AUDIT_KEY } from '@/lib/finance';

export const dynamic = 'force-dynamic';

const READ_ROLES = [...new Set([...ROLE_GROUPS.HR, ...ROLE_GROUPS.OWNER, ...ROLE_GROUPS.FINANCE])];
const UPDATE_ROLES = [...new Set([...ROLE_GROUPS.OWNER, ...ROLE_GROUPS.FINANCE])];

function safeDecrypt(v: string | null): string | null {
  try {
    return decryptField(v);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// DOM-004 / DOM-005 guards (pure helpers, unit-tested in src/lib/__tests__/c2-termination.test.ts)
// ---------------------------------------------------------------------------

/** Article 53: the probation period (including a written extension) never exceeds 180 days. */
export const PROBATION_MAX_DAYS = 180;

/** Last day a PROBATION termination is accepted: probationEndDate, capped at joinDate + 180 days. */
export function probationLimitDate(joinDate: Date, probationEndDate: Date | null | undefined): Date {
  const statutory = addDays(joinDate, PROBATION_MAX_DAYS);
  if (!probationEndDate) return statutory;
  return probationEndDate.getTime() < statutory.getTime() ? probationEndDate : statutory;
}

export interface TerminationReasonCheck {
  terminationReason: string | null | undefined;
  lastWorkingDate: Date;
  joinDate: Date;
  probationEndDate: Date | null | undefined;
  article80Clause: number | null | undefined;
  hasGuiltyInvestigation: boolean;
  /** Award the employee would get on a termination by the employer (what this reason drops). */
  forfeitedAward: number;
}

export type TerminationReasonProblemCode = 'PROBATION_EXPIRED' | 'ARTICLE_80_CLAUSE_REQUIRED' | 'ARTICLE_80_NO_GUILTY_INVESTIGATION';

/**
 * PROBATION and ARTICLE_80 set the end-of-service award to zero, so they are accepted only when
 * their conditions hold (DOM-004). Returns the Arabic reason for refusing, or null.
 */
export function terminationReasonProblem(i: TerminationReasonCheck): { code: TerminationReasonProblemCode; message: string } | null {
  const dropped = `هذا السبب يُسقط مكافأة نهاية الخدمة البالغة ${formatMoney(i.forfeitedAward)} ر.س.`;
  if (i.terminationReason === 'PROBATION') {
    const limit = probationLimitDate(i.joinDate, i.probationEndDate);
    if (daysBetween(limit, i.lastWorkingDate) > 0) {
      const basis = i.probationEndDate ? 'نهاية فترة التجربة المسجلة (بحد أقصى 180 يوماً من المباشرة)' : 'نهاية الحد الأقصى للتجربة (180 يوماً من تاريخ المباشرة)';
      return {
        code: 'PROBATION_EXPIRED',
        message: `لا يمكن اختيار «إنهاء خلال فترة التجربة»: آخر يوم عمل (${dateKey(i.lastWorkingDate)}) يقع بعد ${basis} (${dateKey(limit)}). ${dropped}`,
      };
    }
    return null;
  }
  if (i.terminationReason === 'ARTICLE_80') {
    if (!i.article80Clause) {
      return {
        code: 'ARTICLE_80_CLAUSE_REQUIRED',
        message: `الفصل بموجب المادة 80 يتطلب تحديد الفقرة التي يستند إليها (من 1 إلى 9). ${dropped}`,
      };
    }
    if (!i.hasGuiltyInvestigation) {
      return {
        code: 'ARTICLE_80_NO_GUILTY_INVESTIGATION',
        message: `الفصل بموجب المادة 80 يتطلب تحقيقاً مسجلاً للموظف ثبتت فيه الإدانة (الشؤون القانونية ← التحقيقات)، ولا يوجد تحقيق بهذه الحالة. ${dropped}`,
      };
    }
  }
  return null;
}

/** Marker stored in Settlement.additionalNotes for the article 80 paragraph (no schema column). */
export function article80NoteLine(clause: number): string {
  return `[ARTICLE_80_CLAUSE:${clause}] فصل بموجب المادة 80 — الفقرة ${clause}`;
}

/** Reasons where the worker ended the contract (article 88: two weeks instead of one). */
const WORKER_ENDED_REASONS: ReadonlyArray<string> = ['RESIGNATION', 'ARTICLE_81'];

export interface PaymentDeadline {
  /** 'YYYY-MM-DD' */
  dueDate: string;
  days: 7 | 14;
  endedBy: 'EMPLOYER' | 'WORKER';
}

/**
 * Article 88 payment deadline of an END_OF_SERVICE settlement: one week after the last working
 * day, or two weeks when the worker ended the contract (resignation / article 81). Other reasons
 * (and a missing reason) use the stricter one week.
 */
export function statutoryPaymentDeadline(s: {
  type: string;
  terminationReason: string | null | undefined;
  lastWorkingDate: Date | null | undefined;
}): PaymentDeadline | null {
  if (s.type !== 'END_OF_SERVICE' || !s.lastWorkingDate) return null;
  const workerEnded = WORKER_ENDED_REASONS.includes(s.terminationReason ?? '');
  const days = workerEnded ? 14 : 7;
  const due = dateKey(addDays(s.lastWorkingDate, days));
  if (!due) return null;
  return { dueDate: due, days, endedBy: workerEnded ? 'WORKER' : 'EMPLOYER' };
}

/** Days past the deadline for a settlement not yet paid (0 when on time, paid or rejected). */
export function paymentOverdueDays(deadline: PaymentDeadline | null, status: string, asOf: Date): number {
  if (!deadline || status === SETTLEMENT_STATUS.PAID || status === SETTLEMENT_STATUS.REJECTED || status === 'TRANSFERRED') return 0;
  return Math.max(0, daysBetween(deadline.dueDate, asOf));
}

export interface OpenObligations {
  assets: string[];
  sims: string[];
  vehicles: string[];
  futureLeaves: string[];
  exitReentryVisas: string[];
  pendingPayments: string[];
}

const listed = (items: string[]) => {
  const shown = items.slice(0, 5).join('، ');
  return items.length > 5 ? `${shown}، و${items.length - 5} غيرها` : shown;
};

/** Arabic preview warnings for what the leaver still holds or has open (read only, DOM-005). */
export function openObligationWarnings(o: OpenObligations): string[] {
  const w: string[] = [];
  if (o.assets.length) w.push(`عهد نشطة لدى الموظف (${o.assets.length}): ${listed(o.assets)}. راجِع استردادها قبل صرف المستحقات.`);
  if (o.sims.length) w.push(`شرائح اتصال مسندة للموظف (${o.sims.length}): ${listed(o.sims)}.`);
  if (o.vehicles.length) w.push(`مركبات مسندة للموظف كسائق (${o.vehicles.length}): ${listed(o.vehicles)}.`);
  if (o.futureLeaves.length) w.push(`إجازات معتمدة تبدأ بعد آخر يوم عمل (${o.futureLeaves.length}): ${listed(o.futureLeaves)}. لا تُلغى تلقائياً؛ ألغِها من صفحة الإجازات.`);
  if (o.exitReentryVisas.length) w.push(`تأشيرات خروج وعودة غير ملغاة (${o.exitReentryVisas.length}): ${listed(o.exitReentryVisas)}.`);
  if (o.pendingPayments.length) w.push(`طلبات سداد معلقة مرتبطة بوثائق الموظف أو تأشيراته (${o.pendingPayments.length}): ${listed(o.pendingPayments)}.`);
  return w;
}

const EXIT_REENTRY_VISA_TYPE = 'خروج وعودة';
const OPEN_PAYMENT_STATUSES = ['PENDING_OWNER', 'PENDING_FINANCE'] as const;
const VISA_STATUS_LABELS: Record<string, string> = { PENDING_PAYMENT: 'بانتظار الدفع', PAID: 'مدفوعة', ISSUED: 'صادرة' };

/** Reads the leaver's open obligations (custody, future leaves, visas, pending payments). */
async function loadOpenObligations(employeeId: string, lastDate: Date): Promise<OpenObligations> {
  const [assets, sims, vehicles, futureLeaves, visas] = await Promise.all([
    prisma.asset.findMany({ where: { employeeId, status: 'ACTIVE' }, select: { assetType: true, description: true } }),
    prisma.telecomSim.findMany({ where: { employeeId }, select: { simNumber: true, provider: true } }),
    prisma.vehicle.findMany({ where: { driverId: employeeId, isArchived: false }, select: { plateNumber: true, brand: true } }),
    prisma.leave.findMany({
      where: { employeeId, status: 'APPROVED', startDate: { gt: lastDate } },
      select: { leaveType: true, startDate: true, endDate: true },
      orderBy: { startDate: 'asc' },
    }),
    prisma.visa.findMany({
      where: {
        employeeId,
        visaType: EXIT_REENTRY_VISA_TYPE,
        status: { not: 'CANCELLED' },
        OR: [{ returnDate: null }, { returnDate: { gte: lastDate } }],
      },
      select: { id: true, status: true, departureDate: true },
    }),
  ]);
  const visaIds = visas.map((v) => v.id);
  const payments = await prisma.paymentRequest.findMany({
    where: {
      status: { in: [...OPEN_PAYMENT_STATUSES] },
      OR: [{ entityType: 'EMPLOYEE', entityId: employeeId }, ...(visaIds.length ? [{ entityType: 'VISA', entityId: { in: visaIds } }] : [])],
    },
    select: { title: true, amount: true },
  });
  return {
    assets: assets.map((a) => [a.assetType, a.description].filter(Boolean).join(' - ')),
    sims: sims.map((s) => [s.simNumber, s.provider].filter(Boolean).join(' - ')),
    vehicles: vehicles.map((v) => [v.plateNumber, v.brand].filter(Boolean).join(' - ')),
    futureLeaves: futureLeaves.map((l) => `${leaveTypeLabel(l.leaveType)} من ${dateKey(l.startDate)} إلى ${dateKey(l.endDate)}`),
    exitReentryVisas: visas.map((v) => `${VISA_STATUS_LABELS[v.status] ?? v.status}${v.departureDate ? ` (مغادرة ${dateKey(v.departureDate)})` : ''}`),
    pendingPayments: payments.map((p) => `${p.title} (${formatMoney(p.amount)} ر.س)`),
  };
}

/**
 * The employee has an investigation with a guilty verdict: COMPLETED_GUILTY, or CLOSED after a
 * COMPLETED_GUILTY verdict (the transition is recorded in the audit log). Returns its id.
 */
async function guiltyInvestigationId(employeeId: string): Promise<string | null> {
  const investigations = await prisma.investigation.findMany({
    where: { employeeId, status: { in: ['COMPLETED_GUILTY', 'CLOSED'] } },
    select: { id: true, status: true },
    orderBy: { updatedAt: 'desc' },
  });
  const guilty = investigations.find((i) => i.status === 'COMPLETED_GUILTY');
  if (guilty) return guilty.id;
  const closedIds = investigations.map((i) => i.id);
  if (!closedIds.length) return null;
  const verdict = await prisma.auditLog.findFirst({
    where: {
      entityType: 'Investigation',
      entityId: { in: closedIds },
      OR: [{ details: { contains: '"to":"COMPLETED_GUILTY"' } }, { details: { contains: '"from":"COMPLETED_GUILTY"' } }],
    },
    select: { entityId: true },
  });
  return verdict?.entityId ?? null;
}

export async function GET() {
  try {
    await requireUser(READ_ROLES);
    const settlements = await prisma.settlement.findMany({
      include: {
        employee: {
          select: {
            firstNameArabic: true,
            lastNameArabic: true,
            employeeId: true,
            joinDate: true,
            basicSalary: true,
            ibanNumber: true,
            bankName: true,
            employmentStatus: true,
            legalCompany: { select: { nameArabic: true } },
            branch: { select: { nameArabic: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    const asOf = today();
    return NextResponse.json(
      settlements.map((s) => {
        // Article 88 deadline (display only; computed here so the page and the rule never diverge).
        const deadline = statutoryPaymentDeadline(s);
        return {
          ...s,
          employee: { ...s.employee, ibanNumber: safeDecrypt(s.employee.ibanNumber) },
          paymentDeadline: deadline ? { ...deadline, overdueDays: paymentOverdueDays(deadline, s.status, asOf) } : null,
        };
      }),
    );
  } catch (err) {
    return handleApiError(err, 'settlements:GET');
  }
}

const emptyToUndefined = (v: unknown) => (v === '' || v === null ? undefined : v);
const optBool = z.preprocess(emptyToUndefined, zBool.optional());

const CreateSettlementSchema = z.object({
  employeeId: zId,
  type: z.enum(SETTLEMENT_TYPES),
  terminationReason: z.preprocess(emptyToUndefined, z.enum(TERMINATION_REASONS).optional()),
  salaryBasis: z.preprocess((v) => (v === '' || v == null ? 'total' : v), z.enum(['basic', 'total'])),
  lastWorkingDate: zOptDate,
  leaveStartDate: zOptDate,
  leaveEndDate: zOptDate,
  requestedLeaveDays: zOptMoney,
  excessDaysSponsorshipCost: zOptMoney,
  waiveExcessCost: optBool,
  flightTicketOption: zOptText(50),
  flightTicketAmount: zOptMoney,
  /** Preferred: HR-entered extra entitlements / deductions (the server adds everything else). */
  manualEntitlements: zOptMoney,
  manualDeductions: zOptMoney,
  /** Legacy combined values sent by the current page (used only to derive the manual parts). */
  additionalEntitlements: zOptMoney,
  additionalDeductions: zOptMoney,
  totalDeductions: zOptMoney,
  loansDeduction: zOptMoney,
  excessLeaveDeduction: zOptMoney,
  additionalNotes: zOptText(10000),
  needsEarlyRenewal: optBool,
  requestFinalExitVisa: optBool,
  leaveOutsideKsa: optBool,
  flightFrom: zOptText(200),
  flightTo: zOptText(200),
  flightDateFrom: zOptDate,
  flightDateTo: zOptDate,
  /** Article 80 paragraph (1-9); required with terminationReason ARTICLE_80 (kept in notes + audit). */
  article80Clause: z.preprocess(
    (v) => (v === '' || v === null || v === undefined ? undefined : typeof v === 'string' ? Number(v) : v),
    z
      .number({ invalid_type_error: 'فقرة المادة 80 يجب أن تكون رقماً من 1 إلى 9' })
      .int('فقرة المادة 80 يجب أن تكون رقماً من 1 إلى 9')
      .min(1, 'فقرة المادة 80 يجب أن تكون رقماً من 1 إلى 9')
      .max(9, 'فقرة المادة 80 يجب أن تكون رقماً من 1 إلى 9')
      .optional(),
  ),
  /** true: compute and return the amounts without saving anything. */
  preview: optBool,
}).superRefine((b, ctx) => {
  if (b.type === 'END_OF_SERVICE' && !b.terminationReason && !b.preview) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['terminationReason'],
      message: 'يجب تحديد سبب انتهاء العلاقة العمالية قبل حفظ تصفية نهاية الخدمة',
    });
  }
  if (b.article80Clause !== undefined && !(b.type === 'END_OF_SERVICE' && b.terminationReason === 'ARTICLE_80')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['article80Clause'],
      message: 'تُحدَّد فقرة المادة 80 فقط في تصفية نهاية الخدمة بسبب «فصل بموجب المادة 80»',
    });
  }
});

type CreateSettlementBody = z.infer<typeof CreateSettlementSchema>;

/**
 * Loads the employee record and computes the settlement amounts (shared by the preview and the
 * creation). Every amount comes from the database; only the HR-entered parts come from the body.
 */
async function computeForRequest(body: CreateSettlementBody) {
  const asOf = today();
  const lastDate = body.lastWorkingDate ?? asOf;

  const [employee, existingSettlement, existingEndOfService, settings, annualLeaveDaysSetting, visaBaseFee] = await Promise.all([
    prisma.employee.findUnique({
      where: { id: body.employeeId },
      select: {
        id: true,
        joinDate: true,
        probationEndDate: true,
        basicSalary: true,
        nationality: true,
        isTerminated: true,
        leaveAccrualStartDate: true,
        allowances: { where: { isMonthly: true }, select: { name: true, amount: true, isMonthly: true } },
        leaves: {
          where: {
            status: { in: [...BALANCE_CONSUMING_STATUSES] as LeaveStatus[] },
            leaveType: { in: [...BALANCE_LEAVE_TYPES] as LeaveType[] },
          },
          select: { leaveType: true, status: true, startDate: true, endDate: true, createdAt: true, totalDays: true, paidDays: true },
        },
        loans: {
          where: { status: { in: [...LOAN_DEDUCTIBLE_STATUSES] }, isForgiven: false, remainingAmount: { gt: 0 } },
          select: {
            remainingAmount: true,
            installments: { where: { payroll: { status: PAYROLL_STATUS.DRAFT } }, select: { month: true, year: true, amount: true } },
          },
        },
        overtimeRequests: {
          where: { status: 'APPROVED', date: { lte: lastDate }, paidInSettlementId: null },
          select: { id: true, date: true, type: true, hours: true, amount: true, updatedAt: true, paidInPayrollId: true, paidInSettlementId: true },
        },
        payrolls: {
          where: { status: { in: [PAYROLL_STATUS.APPROVED, PAYROLL_STATUS.PAID] } },
          select: { month: true, year: true, createdAt: true },
        },
      },
    }),
    prisma.settlement.findFirst({
      where: {
        employeeId: body.employeeId,
        status: { in: [SETTLEMENT_STATUS.PENDING_APPROVAL, SETTLEMENT_STATUS.OWNER_APPROVED] },
      },
      select: { id: true },
    }),
    // DOM-004: one END_OF_SERVICE settlement per employee unless the owner rejected it.
    prisma.settlement.findFirst({
      where: { employeeId: body.employeeId, type: 'END_OF_SERVICE', status: { not: SETTLEMENT_STATUS.REJECTED } },
      select: { id: true, status: true },
    }),
    loadPayrollSettings(prisma),
    getNumericSetting(prisma, SETTING_KEYS.ANNUAL_LEAVE_DAYS),
    getNumericSetting(prisma, SETTING_KEYS.EXIT_REENTRY_VISA_FEE),
  ]);
  if (!employee) throw notFound('الموظف غير موجود');
  const [legacyCutoff, holders] = await Promise.all([
    overtimeLegacyCutoff(),
    overtimeHolders(prisma, employee.overtimeRequests.map((o) => o.paidInPayrollId)),
  ]);

  // The last month's working days must not be paid twice.
  const lastMonth = monthOf(lastDate);
  const lastMonthAlreadyPaid =
    !!body.lastWorkingDate && employee.payrolls.some((p) => p.year === lastMonth.year && p.month === lastMonth.month);

  // Overtime: only END_OF_SERVICE pays it, and only what payroll will not pay.
  const dueOvertime =
    body.type === 'END_OF_SERVICE'
      ? employee.overtimeRequests.filter((ot) => overtimeDueInSettlement(ot, employee.payrolls, lastDate, { legacyCutoff, holders }))
      : [];
  const unpaidOvertime = sumMoney(dueOvertime.map((ot) => overtimeAmount(ot, employee, settings)));
  const outstandingLoans = outstandingLoansForSettlement(employee.loans, lastDate);

  const flightTicketAllowance = body.flightTicketOption === 'amount' ? roundMoney(body.flightTicketAmount ?? 0) : 0;

  // Manual entitlements: explicit field, or derived from a legacy combined value
  // (which already contains its own overtime estimate, so server overtime is not added again).
  // Only the server-computed overtime is reserved (paidInSettlementId) and re-checked at approval.
  let manualEntitlements: number;
  let overtime: number;
  let serverOvertime: boolean;
  if (body.manualEntitlements !== undefined) {
    manualEntitlements = body.manualEntitlements;
    overtime = unpaidOvertime;
    serverOvertime = true;
  } else {
    manualEntitlements = Math.max(0, roundMoney((body.additionalEntitlements ?? 0) - flightTicketAllowance));
    overtime = 0;
    serverOvertime = false;
  }
  const manualDeductions =
    body.manualDeductions !== undefined
      ? body.manualDeductions
      : Math.max(
          0,
          roundMoney(
            (body.totalDeductions ?? body.additionalDeductions ?? 0) - (body.loansDeduction ?? 0) - (body.excessLeaveDeduction ?? 0),
          ),
        );

  const calc = computeSettlement({
    type: body.type,
    terminationReason: body.terminationReason ?? null,
    salaryBasis: body.salaryBasis,
    employee: {
      basicSalary: employee.basicSalary,
      allowances: employee.allowances,
      joinDate: employee.joinDate,
      nationality: employee.nationality,
      leaveAccrualStartDate: employee.leaveAccrualStartDate,
    },
    lastWorkingDate: body.lastWorkingDate ?? null,
    asOf,
    leaves: employee.leaves,
    leaveStartDate: body.leaveStartDate ?? null,
    leaveEndDate: body.leaveEndDate ?? null,
    requestedLeaveDays: body.requestedLeaveDays ?? null,
    lastMonthAlreadyPaid,
    excessDayCost: body.excessDaysSponsorshipCost ?? null,
    waiveExcessCost: body.waiveExcessCost === true,
    flightTicketOption: body.flightTicketOption ?? null,
    flightTicketAmount: body.flightTicketAmount ?? null,
    outstandingLoans,
    overtime,
    manualEntitlements,
    manualDeductions,
    leaveOutsideKsa: body.leaveOutsideKsa === true,
    annualLeaveDaysSetting,
    visaBaseFee: visaBaseFee !== null && visaBaseFee >= 0 ? visaBaseFee : null,
  });

  const overtimeIds = serverOvertime ? dueOvertime.map((ot) => ot.id) : [];

  // DOM-004: PROBATION / ARTICLE_80 drop the award; they are refused unless their conditions hold.
  let reasonProblem: ReturnType<typeof terminationReasonProblem> = null;
  let forfeitedAward = 0;
  let investigationId: string | null = null;
  if (body.type === 'END_OF_SERVICE' && (body.terminationReason === 'PROBATION' || body.terminationReason === 'ARTICLE_80')) {
    forfeitedAward = endOfServiceAward(calc.salaryUsed, yearsOfService(employee.joinDate, lastDate), 'COMPANY_TERMINATION');
    investigationId = body.terminationReason === 'ARTICLE_80' ? await guiltyInvestigationId(employee.id) : null;
    reasonProblem = terminationReasonProblem({
      terminationReason: body.terminationReason,
      lastWorkingDate: lastDate,
      joinDate: employee.joinDate,
      probationEndDate: employee.probationEndDate,
      article80Clause: body.article80Clause,
      hasGuiltyInvestigation: !!investigationId,
      forfeitedAward,
    });
  }

  return { employee, existingSettlement, existingEndOfService, calc, overtimeIds, serverOvertime, reasonProblem, forfeitedAward, investigationId };
}

const SETTLEMENT_STATUS_LABELS: Record<string, string> = {
  PENDING_APPROVAL: 'بانتظار تعميد صاحب العمل',
  OWNER_APPROVED: 'معتمدة',
  PAID: 'مدفوعة',
};

function endOfServiceExistsMessage(status: string): string {
  return `يوجد للموظف تصفية نهاية خدمة سابقة (${SETTLEMENT_STATUS_LABELS[status] ?? status}). لا تُنشأ تصفية نهاية خدمة أخرى إلا إذا رُفضت السابقة.`;
}

/**
 * POST /api/settlements — HR creates a settlement; every amount is computed on the server.
 * With { preview: true } nothing is written: returns { calculation, warnings } (page preview).
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.HR);
    const body = await parseBody(req, CreateSettlementSchema);

    if (body.type === 'END_OF_SERVICE' && !body.lastWorkingDate) throw badRequest('آخر يوم عمل مطلوب لتصفية نهاية الخدمة');

    const { employee, existingSettlement, existingEndOfService, calc, overtimeIds, serverOvertime, reasonProblem, forfeitedAward, investigationId } =
      await computeForRequest(body);
    const isEndOfService = body.type === 'END_OF_SERVICE';
    const terminatedLeaveSettlement = employee.isTerminated && !isEndOfService;
    const TERMINATED_LEAVE_MSG = 'الموظف منتهية خدمته، ولا تُنشأ له إلا تصفية نهاية الخدمة';

    // DOM-004 (same rule as PATCH /api/employees/[id] terminate): the employer may not end the
    // contract during an approved maternity / sick leave in effect. Resignation / Article 81 are the
    // employee's own decision and stay allowed. Only SUPER_ADMIN may proceed (audited as usual).
    let protectedLeaveMsg: string | null = null;
    if (isEndOfService && !WORKER_ENDED_REASONS.includes(body.terminationReason ?? '')) {
      const protectedLeaves = await prisma.leave.findMany({
        where: { employeeId: employee.id, status: 'APPROVED', leaveType: { in: ['MATERNITY', 'SICK'] } },
        select: { id: true, leaveType: true, status: true, startDate: true, endDate: true, isReturned: true, actualReturnDate: true },
      });
      const active = activeProtectedLeave(protectedLeaves, [body.lastWorkingDate ?? today(), today()]);
      if (active) {
        const kind = active.leaveType === 'MATERNITY' ? 'إجازة وضع' : 'إجازة مرضية';
        protectedLeaveMsg = `لا يجوز لصاحب العمل إنهاء العقد أثناء ${kind} سارية (من ${dateKey(active.startDate)} إلى ${dateKey(active.endDate)}). انتظر انتهاء الإجازة أو راجع الإدارة القانونية.`;
      }
    }

    if (body.preview === true) {
      const warnings: string[] = [];
      if (terminatedLeaveSettlement) warnings.push(TERMINATED_LEAVE_MSG);
      if (isEndOfService && existingEndOfService) warnings.push(endOfServiceExistsMessage(existingEndOfService.status));
      else if (existingSettlement) warnings.push('يوجد معاملة تصفية قائمة حالياً للموظف');
      if (isEndOfService && employee.isTerminated && !existingEndOfService) {
        warnings.push('الموظف مسجَّل منتهي الخدمة دون تصفية نهاية خدمة. يمكن إنشاء تصفيته الآن لتسجيل مستحقاته.');
      }
      if (isEndOfService && isCounselPendingReason(body.terminationReason)) {
        warnings.push(`احتُسبت المكافأة كاملة لهذا السبب (${COUNSEL_PENDING_NOTE})`);
      }
      // DOM-005: open obligations of the leaver (read only; nothing is blocked on the server).
      if (isEndOfService) {
        warnings.push(...openObligationWarnings(await loadOpenObligations(employee.id, body.lastWorkingDate ?? today())));
      }
      return NextResponse.json({
        preview: true,
        calculation: calc,
        warnings,
        blockers: [...(reasonProblem ? [reasonProblem.message] : []), ...(protectedLeaveMsg ? [protectedLeaveMsg] : [])],
        ...(reasonProblem ? { forfeitedAward } : {}),
      });
    }

    if (terminatedLeaveSettlement) throw conflict(TERMINATED_LEAVE_MSG);
    if (protectedLeaveMsg && user.role !== 'SUPER_ADMIN') throw conflict(protectedLeaveMsg);
    if (isEndOfService && existingEndOfService) throw conflict(endOfServiceExistsMessage(existingEndOfService.status));
    if (existingSettlement) {
      throw conflict('يوجد معاملة تصفية قائمة حالياً للموظف. لا يمكن عمل تصفية أخرى.');
    }
    if (reasonProblem) throw badRequest(reasonProblem.message, { code: reasonProblem.code, forfeitedAward });

    // Tag notes with early renewal marker if needed
    let finalNotes = body.additionalNotes ?? null;
    if (body.needsEarlyRenewal) {
      const tag = '[NEEDS_EARLY_RENEWAL]';
      finalNotes = finalNotes ? `${tag}\n${finalNotes}` : tag;
    }
    const article80Clause = isEndOfService && body.terminationReason === 'ARTICLE_80' ? (body.article80Clause ?? null) : null;
    if (article80Clause) {
      const line = article80NoteLine(article80Clause);
      finalNotes = finalNotes ? `${line}\n${finalNotes}` : line;
    }

    const settlement = await prisma.$transaction(async (tx) => {
      // Re-checked inside the transaction (two HR users saving at the same time).
      const concurrent = await tx.settlement.findFirst({
        where: {
          employeeId: body.employeeId,
          OR: [
            { status: { in: [SETTLEMENT_STATUS.PENDING_APPROVAL, SETTLEMENT_STATUS.OWNER_APPROVED] } },
            ...(isEndOfService ? [{ type: 'END_OF_SERVICE' as const, status: { not: SETTLEMENT_STATUS.REJECTED } }] : []),
          ],
        },
        select: { id: true },
      });
      if (concurrent) throw conflict('يوجد معاملة تصفية قائمة حالياً للموظف. لا يمكن عمل تصفية أخرى.');

      const created = await tx.settlement.create({
        data: {
          employeeId: body.employeeId,
          type: body.type,
          terminationReason: body.terminationReason ?? null,
          salaryBasis: body.salaryBasis,
          lastWorkingDate: body.lastWorkingDate ?? null,
          workingDaysInMonth: calc.workingDaysInMonth,
          workingDaysSalary: calc.workingDaysSalary,
          yearsOfService: calc.yearsOfService,
          endOfServiceAmount: calc.endOfServiceAmount,
          unusedLeaveDays: calc.accruedLeaveDays,
          leaveCompensation: calc.leaveCompensation,
          additionalEntitlements: calc.additionalEntitlements,
          additionalDeductions: calc.totalDeductions,
          additionalNotes: finalNotes,
          totalSettlement: calc.totalSettlement,
          loansDeduction: calc.loansDeduction,
          // null = overtime folded into a legacy combined value (not tracked / re-checked).
          overtimeAmount: serverOvertime ? calc.overtime : null,
          status: SETTLEMENT_STATUS.PENDING_APPROVAL, // بانتظار تعميد صاحب العمل
        },
      });

      // Reserve the overtime this settlement pays so payroll never pays it too. A payroll
      // generation that took one of them since the calculation -> 409 (recompute).
      if (overtimeIds.length) {
        const reserved = await tx.overtimeRequest.updateMany({
          where: { id: { in: overtimeIds }, status: 'APPROVED', paidInSettlementId: null },
          data: { paidInSettlementId: created.id },
        });
        if (reserved.count !== overtimeIds.length) {
          throw conflict('تغيّرت طلبات العمل الإضافي للموظف أثناء الحفظ، يرجى إعادة الاحتساب والمحاولة مجدداً');
        }
      }

      // إنشاء تأشيرة خروج نهائي إن وجد
      if (body.type === 'END_OF_SERVICE' && body.requestFinalExitVisa === true) {
        await tx.visa.create({
          data: {
            employeeId: body.employeeId,
            visaType: 'خروج نهائي',
            status: 'PENDING_PAYMENT',
            deductedFrom: 'مربوط آلياً بتصفية المستحقات',
          },
        });
      }

      if (body.type === 'LEAVE_SETTLEMENT' && body.leaveOutsideKsa === true) {
        await tx.visa.create({
          data: {
            employeeId: body.employeeId,
            visaType: 'خروج وعودة',
            status: 'PENDING_PAYMENT',
            deductedFrom: `مدفوعة من حساب الشركة: ${calc.visaFeeAmount || DEFAULT_EXIT_REENTRY_VISA_FEE} ر.س`,
            ticketStatus: body.flightFrom && body.flightTo ? 'PENDING' : null,
            flightFrom: body.flightFrom ?? null,
            flightTo: body.flightTo ?? null,
            departureDate: body.flightDateFrom ?? null,
            returnDate: body.flightDateTo ?? null,
          },
        });
      }

      // loansDeduction / overtimeAmount are stored on the row and re-checked at owner approval
      // (approveSettlement); the audit entry keeps them for traceability.
      await logAudit(
        {
          userId: user.id,
          action: 'CREATE',
          entityType: 'SETTLEMENT',
          entityId: created.id,
          details: {
            employeeId: body.employeeId,
            type: body.type,
            total: calc.totalSettlement,
            [SETTLEMENT_LOANS_AUDIT_KEY]: calc.loansDeduction,
            overtime: calc.overtime,
            overtimeIds,
            terminationReason: body.terminationReason ?? null,
            ...(article80Clause ? { article80Clause, investigationId } : {}),
            ...(isEndOfService && employee.isTerminated ? { employeeAlreadyTerminated: true } : {}),
          },
          ipAddress: getClientIp(req),
        },
        tx,
      );
      return created;
    });

    // ملاحظة: تصفير الرصيد وتغيير حالة الموظف يتم فقط بعد اعتماد صاحب العمل (approveSettlement)
    return NextResponse.json({ message: 'تم إنشاء التصفية بنجاح', settlement, calculation: calc }, { status: 201 });
  } catch (err) {
    return handleApiError(err, 'settlements:POST');
  }
}

const UpdateSettlementSchema = z.object({
  id: zId,
  status: z.preprocess(
    emptyToUndefined,
    z.enum([SETTLEMENT_STATUS.OWNER_APPROVED, SETTLEMENT_STATUS.REJECTED, SETTLEMENT_STATUS.PAID]).optional(),
  ),
  transferReceiptUrl: zOptText(2000),
  ownerNotes: zOptText(5000),
});

/**
 * PUT /api/settlements { id, status?, transferReceiptUrl?, ownerNotes? }
 * OWNER_APPROVED / REJECTED: owner only. PAID: finance only. Without status: update notes/receipt.
 */
export async function PUT(req: Request) {
  try {
    const user = await requireUser(UPDATE_ROLES);
    const body = await parseBody(req, UpdateSettlementSchema);
    const ctx = { ipAddress: getClientIp(req) };

    const updated = await prisma.$transaction(
      async (tx) => {
        switch (body.status) {
          case SETTLEMENT_STATUS.OWNER_APPROVED:
            return approveSettlement(tx, body.id, user, body.ownerNotes, ctx);
          case SETTLEMENT_STATUS.REJECTED:
            return rejectSettlement(tx, body.id, user, body.ownerNotes, ctx);
          case SETTLEMENT_STATUS.PAID:
            return markSettlementPaid(tx, body.id, body.transferReceiptUrl ?? null, user, ctx);
          default: {
            const data: { ownerNotes?: string | null; transferReceiptUrl?: string | null } = {};
            if (body.ownerNotes !== undefined) {
              if (!roleIn(user.role, ROLE_GROUPS.OWNER)) throw forbidden();
              data.ownerNotes = body.ownerNotes;
            }
            if (body.transferReceiptUrl !== undefined) {
              if (!roleIn(user.role, ROLE_GROUPS.FINANCE)) throw forbidden();
              data.transferReceiptUrl = body.transferReceiptUrl;
            }
            if (!Object.keys(data).length) throw badRequest('لا توجد بيانات للتحديث');
            const existing = await tx.settlement.findUnique({ where: { id: body.id }, select: { id: true } });
            if (!existing) throw notFound('التصفية غير موجودة');
            const s = await tx.settlement.update({ where: { id: body.id }, data });
            await logAudit(
              { userId: user.id, action: 'UPDATE', entityType: 'SETTLEMENT', entityId: body.id, details: data, ipAddress: ctx.ipAddress },
              tx,
            );
            return s;
          }
        }
      },
      { timeout: 30000, maxWait: 10000 },
    );

    return NextResponse.json({ message: 'تم تحديث التصفية', data: updated });
  } catch (err) {
    return handleApiError(err, 'settlements:PUT');
  }
}
