// Payroll domain logic (legacy code of the payroll module, DOMAIN_BOUNDARIES §5.1: the computation).
//
// Every WRITE of payroll money lives in src/modules/payroll (transitions behind money.gateway, P1-PAY-A):
// this file computes a month (reads) and hands the result to commitPayrollGeneration, and wraps the
// month approval / payment for the routes. A payroll month belongs to ONE legal company (ARC-PAY-A7).
//
// The PURE part (rates, proration, overtime, leave deductions, GOSI, the per-employee payroll
// line, settlement coverage) lives in src/lib/payroll-core.ts so client components can import
// it; it is re-exported from here. This file contains the database helpers that take a Prisma
// client / transaction client and are used by the payroll routes and by src/lib/finance.ts.
//
// - Loan installments are recorded as LoanInstallment rows when a DRAFT is generated and
//   are applied to Loan.remainingAmount exactly once, when the payroll is APPROVED.
// - One-off bonuses (Allowance.isMonthly=false) are reserved by a draft (paidInPayrollId)
//   and marked isPaid when that payroll is approved.
// - Deductions are reserved by a draft (Deduction.payrollMonth='YYYY-MM') and linked
//   (isLinkedToPayroll=true) when the payroll is approved, so they are never deducted twice. A draft
//   reserves only the deductions its line takes whole (takeDeductions, BL-PAY-030); one that does not
//   fit is marked Deduction.deferredPayrollMonth and offered again by the next generated month.
// - Approved overtime is reserved by the draft that pays it (OvertimeRequest.paidInPayrollId);
//   the link becomes final when that payroll is approved and is released when the draft is
//   regenerated / dropped. Overtime approved after its month's payroll was generated is paid
//   by the next generated month (overtimeDueInMonth).
// - The overtime hourly basis is the company setting Company.overtimeHourlyBasis of the employee's
//   legal company (else actual company; none -> BASIC), read at generation time: only DRAFT rows are
//   (re)generated, so APPROVED / PAID rows keep the amount computed when they were generated.
import { randomUUID } from 'crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { MoneyActor, TxClient } from '@/modules/platform';
import { prisma } from '@/lib/prisma';
import { roundMoney, sumMoney } from '@/lib/money';
import { addDays, dateKey, monthRange } from '@/lib/dates';
import {
  DEDUCTION_PAYABLE_STATUSES,
  LEAVE_STATUS,
  LOAN_DEDUCTIBLE_STATUSES,
  PAYROLL_STATUS,
  SETTLEMENT_VOID_STATUSES,
} from '@/lib/constants';
import { conflict } from '@/lib/http';
import { decryptField } from '@/lib/crypto';
import {
  computePayrollLine,
  countPayrollReviewKeys,
  employeeDeductionsTotal,
  monthIndex,
  payrollBreakdownColumns,
  overtimeBasisForEmployee,
  overtimeDueInMonth,
  OVERTIME_BASIS_SELECT,
  parsePayrollSettings,
  payrollMonthKey,
  PAYROLL_SETTING_KEYS,
  settlementCoverage,
  settlementCoversMonth,
  type OvertimeHolders,
  type PayrollBreakdownColumns,
  type PayrollReviewFilterKey,
  type AllowanceLike,
  type PayrollSettings,
  type SalaryLike,
} from '@/lib/payroll-core';
import { DEFAULT_GOSI_RATES, pickGosiRate, type GosiRateLike } from '@/lib/gosi';
import { createRulesReader } from '@/modules/rules';
import { PAYABLE_BONUS_STATUS, compensationOnDay, compensationSegments, type CompensationSegment } from '@/modules/compensation';
import { currentPeriodStart, employedDuringWhere, employmentGapsWithin, employmentSpansOf } from '@/modules/lifecycle';
import {
  approvePayrollMonth,
  commitPayrollGeneration,
  payrollEligible,
  markPayrollMonthPaid,
  runPayrollTransaction,
  type TxRunner,
  type ApproveMonthResult,
  type GeneratedLine,
  type GenerationPlan,
} from '@/modules/payroll';

export * from '@/lib/payroll-core';

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

type Tx = Prisma.TransactionClient;

export async function loadPayrollSettings(db: Tx): Promise<PayrollSettings> {
  const rows = await db.systemSetting.findMany({
    where: { key: { in: Object.values(PAYROLL_SETTING_KEYS) } },
    select: { key: true, value: true },
  });
  return parsePayrollSettings(rows);
}

/**
 * The dated GOSI rate table (DEC-003), loaded once per payroll generation. Falls back to the
 * documented OLD-regime rows (DEFAULT_GOSI_RATES) when the table is empty.
 */
export async function loadGosiRates(db: Tx): Promise<GosiRateLike[]> {
  const rows = await db.gosiRate.findMany({
    select: {
      regime: true,
      isSaudi: true,
      effectiveFrom: true,
      employeeRate: true,
      employerRate: true,
      minWage: true,
      maxWage: true,
      isProvisional: true,
    },
    orderBy: { effectiveFrom: 'asc' },
  });
  return rows.length ? rows : [...DEFAULT_GOSI_RATES];
}

/** Migration that added OvertimeRequest.paidInPayrollId / paidInSettlementId. */
export const OVERTIME_LINK_MIGRATION = '3_sessions_uploads_and_breakdowns';
let overtimeCutoffCache: Date | null = null;

/**
 * When the overtime link columns were added (finished_at of OVERTIME_LINK_MIGRATION): unlinked
 * overtime approved before it is "legacy" and uses the timestamp inference (see
 * src/lib/payroll-core.ts). null when unknown (e.g. schema applied with db push): every unlinked
 * row is then treated as legacy. Always read with the root client, never inside a transaction
 * (a failing query would abort it).
 */
export async function overtimeLegacyCutoff(): Promise<Date | null> {
  if (overtimeCutoffCache) return overtimeCutoffCache;
  try {
    const rows = await prisma.$queryRaw<Array<{ finished_at: Date | null }>>`
      SELECT finished_at FROM "_prisma_migrations"
      WHERE migration_name = ${OVERTIME_LINK_MIGRATION} AND finished_at IS NOT NULL AND rolled_back_at IS NULL
      LIMIT 1`;
    const at = rows[0]?.finished_at ?? null;
    if (at) overtimeCutoffCache = at;
    return at;
  } catch {
    return null;
  }
}

/** Payroll rows referenced by overtime links (for overtimeDueInSettlement). */
export async function overtimeHolders(db: Tx, payrollIds: ReadonlyArray<string | null | undefined>): Promise<OvertimeHolders> {
  const ids = [...new Set(payrollIds.filter((id): id is string => !!id))];
  if (!ids.length) return new Map();
  const rows = await db.payroll.findMany({ where: { id: { in: ids } }, select: { id: true, year: true, month: true, status: true } });
  return new Map(rows.map((r) => [r.id, { year: r.year, month: r.month, status: r.status }]));
}

/** Distinct (year, month) that currently have DRAFT payrolls (of the companies the client sees). */
export async function draftMonths(db: Tx): Promise<Array<{ year: number; month: number }>> {
  const rows = await db.payroll.findMany({
    where: { status: PAYROLL_STATUS.DRAFT },
    select: { year: true, month: true },
    distinct: ['year', 'month'],
    orderBy: [{ year: 'asc' }, { month: 'asc' }],
  });
  return rows;
}

/** Companies that have lines in (year, month), with the month's status (of the companies the client sees). */
export async function payrollMonthCompanies(db: Tx, year: number, month: number): Promise<Array<{ companyId: string; companyName: string; status: string; drafts: number }>> {
  const [months, drafts] = await Promise.all([
    db.payrollMonth.findMany({ where: { year, month }, select: { companyId: true, status: true, company: { select: { nameArabic: true } } }, orderBy: { companyId: 'asc' } }),
    db.payroll.groupBy({ by: ['companyId'], where: { year, month, status: PAYROLL_STATUS.DRAFT }, _count: { _all: true } }),
  ]);
  const byCompany = new Map(drafts.map((d) => [d.companyId, d._count._all]));
  return months.map((m) => ({ companyId: m.companyId, companyName: m.company.nameArabic, status: m.status, drafts: byCompany.get(m.companyId) ?? 0 }));
}

/** The salary of a compensation segment in the shape of the payroll rules (recurring allowances, isMonthly). */
function salaryOf(seg: CompensationSegment | undefined): SalaryLike {
  return {
    basicSalary: seg?.basicSalary ?? 0,
    allowances: (seg?.allowances ?? []).map((a) => ({ name: a.name, amount: a.amount, isMonthly: true, allowanceType: a.allowanceType ?? null, countsTowardGosi: a.countsTowardGosi })),
  };
}

// ---------------------------------------------------------------------------
// Approval and payment of a company's month (writers: src/modules/payroll, behind money.gateway)
// ---------------------------------------------------------------------------

/**
 * The legacy settlement-coverage check of an approval, run in its transaction before any write: a
 * draft generated BEFORE a settlement that covers this month would pay what the settlement pays (last
 * month's working days, settled leave days, overtime / installments it holds): regenerate first.
 */
function settlementCoveragePrecheck(year: number, month: number) {
  return async (tx: TxClient, drafts: readonly { id: string; employeeId: string; createdAt: Date }[]) => {
    const employees = await tx.employee.findMany({
      where: { id: { in: [...new Set(drafts.map((d) => d.employeeId))] } },
      select: {
        id: true,
        firstNameArabic: true,
        lastNameArabic: true,
        // BL-LCY-012 site 2: void settlements (rejected / reversed) never count; period-scoped below.
        settlements: {
          where: { status: { notIn: [...SETTLEMENT_VOID_STATUSES] } },
          select: { type: true, status: true, lastWorkingDate: true, createdAt: true, salaryBasis: true, leaveCompensation: true, leavePaidDays: true },
        },
      },
    });
    const byId = new Map(employees.map((e) => [e.id, e]));
    const spans = await employmentSpansOf(tx, employees.map((e) => e.id));
    // The rate of a settled leave day: the compensation in force at the month's end (ARCH-011: the facts).
    const pay = await compensationOnDay(tx, employees.map((e) => e.id), dateKey(monthRange(year, month).end) as string);
    const stale = drafts.filter((d) => {
      const e = byId.get(d.employeeId);
      if (!e) return false;
      const newer = e.settlements.filter((s) => s.createdAt > d.createdAt);
      return settlementCoversMonth(newer, salaryOf(pay.get(e.id)), year, month, { periodStart: currentPeriodStart(spans.get(e.id)) });
    });
    if (stale.length) {
      const names = stale
        .slice(0, 5)
        .map((d) => byId.get(d.employeeId))
        .map((e) => `${e?.firstNameArabic ?? ''} ${e?.lastNameArabic ?? ''}`.trim())
        .join('، ');
      throw conflict(
        `أُنشئت تصفية بعد توليد مسودة ${month}/${year} للموظفين: ${names}${stale.length > 5 ? ' وآخرين' : ''}. يرجى إعادة توليد مسير الشهر قبل الاعتماد`,
      );
    }
  };
}

type RunnerClient = TxRunner;

/**
 * DRAFT → APPROVED for a company's month (payroll.approvePayrollMonth behind money.gateway): the
 * approver's own line stays DRAFT for someone else; effects applied once (bonuses paid, deductions
 * linked, loans decremented). One company per call: there is no multi-company approval (§5.4.3).
 */
export async function approveCompanyPayrollMonth(
  _db: RunnerClient,
  input: { companyId: string; year: number; month: number; actor: MoneyActor; operationKey: string; ipAddress?: string | null },
): Promise<ApproveMonthResult> {
  // The root client: the caller checked the company is in the actor's scope, and the transition locks
  // the employees with raw SQL (ADR-0002 #2), which the scoped client refuses (ARCH-009).
  return runPayrollTransaction(prisma, (tx) => approvePayrollMonth(tx, { ...input, precheck: settlementCoveragePrecheck(input.year, input.month) }));
}

/** APPROVED → PAID for a company's month (payroll.markPayrollMonthPaid behind money.gateway). */
export async function payCompanyPayrollMonth(
  _db: RunnerClient,
  input: { companyId: string; year: number; month: number; actor: MoneyActor; operationKey: string; ipAddress?: string | null },
): Promise<{ count: number; replayed: boolean }> {
  return runPayrollTransaction(prisma, (tx) => markPayrollMonthPaid(tx, input)); // root client: see approveCompanyPayrollMonth
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export type GeneratedPayrollRow = GeneratedLine;

export interface GeneratePayrollResult {
  rows: GeneratedPayrollRow[];
  skippedFinalized: number;
  /** Employees skipped because they already have a line this month in another company. */
  skippedOtherCompany: number;
  replacedDrafts: number;
  /** Lines flagged for review (they are generated anyway: one employee never blocks the run). */
  needsReview: number;
  /** Lines whose GOSI used a provisional rate row. */
  provisionalGosi: number;
  /** Flagged lines per review code (a line with several codes counts once per code). */
  reviewCounts: Partial<Record<PayrollReviewFilterKey, number>>;
  /** null when the company had nobody to pay and nothing to replace (no month opened). */
  payrollMonthId: string | null;
  monthStatus: string | null;
  replayed: boolean;
}

/**
 * Decrypted IBAN for the payment-readiness check. A value that cannot be decrypted is returned
 * as stored (still encrypted), so the line is flagged IBAN_INVALID instead of silently passing.
 */
function readableIban(value: string | null): string | null {
  try {
    return decryptField(value);
  } catch {
    return value;
  }
}

export interface PlanInput {
  companyId: string;
  year: number;
  month: number;
  /** Month already approved: only employees without a finalized line get a draft. */
  supplementary?: boolean;
  /** Only these employees (the payroll.employment consumer); omitted = the company's whole month. */
  employeeIds?: readonly string[];
}

export interface PlanOutcome {
  plan: GenerationPlan;
  skippedFinalized: number;
  skippedOtherCompany: number;
  provisionalGosi: number;
}

/**
 * Computes a generation of one company's month (read only): the DRAFT lines of the company's employees
 * (legal company), what they reserve, and the drafts they replace. Throws 409 when the company's month
 * already has approved / paid lines and this is not a supplementary run.
 */
export async function computeGenerationPlan(db: Tx, input: PlanInput): Promise<PlanOutcome> {
  const { companyId, year, month } = input;
  const { start: monthStart, end: monthEnd } = monthRange(year, month);
  const nextMonthStart = addDays(monthEnd, 1);
  const key = payrollMonthKey(year, month);
  const thisIdx = monthIndex(year, month);
  const only = input.employeeIds ? [...new Set(input.employeeIds)] : null;

  const [monthRow, existing] = await Promise.all([
    db.payrollMonth.findUnique({ where: { companyId_year_month: { companyId, year, month } }, select: { version: true } }),
    db.payroll.findMany({
      where: { companyId, year, month, ...(only ? { employeeId: { in: only } } : {}) },
      select: { id: true, employeeId: true, status: true, isFinalSettlement: true },
    }),
  ]);
  const finalized = existing.filter((p) => p.status !== PAYROLL_STATUS.DRAFT);
  if (finalized.length && !input.supplementary && !only) {
    throw conflict(`مسير رواتب شهر ${month}/${year} معتمد أو مصروف مسبقاً (${finalized.length} موظف) ولا يمكن إعادة توليده`);
  }
  const skip = new Set(existing.filter((p) => p.status !== PAYROLL_STATUS.DRAFT || p.isFinalSettlement).map((p) => p.employeeId));
  const draftIds = existing.filter((p) => p.status === PAYROLL_STATUS.DRAFT && !p.isFinalSettlement).map((p) => p.id);
  const draftIdSet = new Set(draftIds);

  const settings = await loadPayrollSettings(db);
  const gosiRates = await loadGosiRates(db); // loaded once per generation
  const legacyCutoff = await overtimeLegacyCutoff();
  const lookBack = addDays(monthStart, -800); // sick-leave tiers look back one year from each leave start
  const overtimeLookBack = addDays(monthStart, -400); // legacy carried-over overtime: up to about a year back

  const employees = await db.employee.findMany({
    where: {
      legalCompanyId: companyId,
      ...(only ? { id: { in: only } } : {}),
      // BL-LCY-012: in service on a day of the month (lifecycle reader; NOTICE until its last day).
      ...employedDuringWhere(monthStart, monthEnd),
    },
    select: {
      id: true,
      nationality: true,
      gosiDeduction: true,
      gosiRegime: true,
      joinDate: true,
      employmentState: true,
      isTerminated: true,
      terminationDate: true,
      legalCompanyId: true,
      // Payment-readiness review flags only (IBAN_MISSING / IBAN_INVALID / CASH).
      ibanNumber: true,
      salaryPaymentMethod: true,
      // Company cost setting «طريقة حساب أجر العمل الإضافي» (legal company, else actual company).
      ...OVERTIME_BASIS_SELECT,
      // One-off bonuses only: the recurring allowances are part of the compensation (CompensationPeriod).
      allowances: {
        // BL-PAY-027 (RT-WFE-701): only APPROVED one-off bonuses pay (compensation PAYABLE_BONUS_STATUS).
        where: { isMonthly: false, isPaid: false, status: PAYABLE_BONUS_STATUS },
        select: {
          id: true,
          name: true,
          amount: true,
          isMonthly: true,
          countsTowardGosi: true,
          allowanceType: true,
          payrollMonth: true,
          payrollYear: true,
          paidInPayrollId: true,
        },
      },
      overtimeRequests: {
        // Approved overtime up to this month that nothing paid yet (or that a draft being
        // replaced holds). Legacy unlinked rows: look back about a year (see overtimeDueInMonth).
        where: {
          status: 'APPROVED',
          date: { lt: nextMonthStart },
          paidInSettlementId: null,
          AND: [
            { OR: [{ paidInPayrollId: null }, ...(draftIds.length ? [{ paidInPayrollId: { in: draftIds } }] : [])] },
            { OR: [{ date: { gte: overtimeLookBack } }, ...(legacyCutoff ? [{ updatedAt: { gte: legacyCutoff } }] : [])] },
          ],
        },
        select: { id: true, date: true, type: true, hours: true, amount: true, updatedAt: true, paidInPayrollId: true, paidInSettlementId: true },
      },
      deductions: {
        where: {
          status: { in: [...DEDUCTION_PAYABLE_STATUSES] },
          isLinkedToPayroll: false,
          date: { lt: nextMonthStart },
          OR: [{ payrollMonth: null }, { payrollMonth: key }],
        },
        select: { id: true, amount: true, date: true, approvedAt: true, deferredPayrollMonth: true },
      },
      loans: {
        where: { status: { in: [...LOAN_DEDUCTIBLE_STATUSES] }, isForgiven: false, remainingAmount: { gt: 0 } },
        select: {
          id: true,
          monthlyInstallment: true,
          remainingAmount: true,
          createdAt: true,
          installments: {
            where: { payroll: { status: PAYROLL_STATUS.DRAFT } },
            select: { month: true, year: true, amount: true },
          },
        },
        orderBy: { createdAt: 'asc' },
      },
      leaves: {
        where: {
          status: { in: [LEAVE_STATUS.APPROVED, LEAVE_STATUS.COMPLETED] },
          startDate: { lte: monthEnd },
          endDate: { gte: lookBack },
        },
        select: {
          id: true,
          leaveType: true,
          startDate: true,
          endDate: true,
          totalDays: true,
          unpaidDays: true,
          totalDeduction: true,
        },
      },
      // BL-LCY-012 site 1: void settlements (rejected / reversed) never count; period-scoped below.
      settlements: {
        where: { status: { notIn: [...SETTLEMENT_VOID_STATUSES] } },
        select: { type: true, status: true, lastWorkingDate: true, createdAt: true, salaryBasis: true, leaveCompensation: true, leavePaidDays: true },
      },
      payrolls: {
        where: { status: { in: [PAYROLL_STATUS.APPROVED, PAYROLL_STATUS.PAID] } },
        select: { month: true, year: true, createdAt: true },
      },
    },
  });

  // One line per employee and month (until BL-PAY-008b prorates a transfer): an employee with a line
  // of this month in another company (a transfer after that company generated) is skipped here.
  const elsewhere = new Set(
    (
      await db.payroll.findMany({
        where: { year, month, employeeId: { in: employees.map((e) => e.id) }, OR: [{ companyId: null }, { companyId: { not: companyId } }] },
        select: { employeeId: true },
      })
    ).map((r) => r.employeeId),
  );

  // Employment periods (lifecycle): the current period scopes the settlements, the gaps between periods
  // (a termination then a rehire in the month) are not paid.
  const spans = await employmentSpansOf(db, employees.map((e) => e.id));
  // The pay of each day of the month (P1-PAY-B, ARCH-011): the CompensationPeriods in force, never the
  // Employee projection. A mid-month change is prorated by segment; the per-day rates and the approved
  // snapshot are BL-PAY-008b.
  const pay = await compensationSegments(db, employees.map((e) => e.id), dateKey(monthStart) as string, dateKey(monthEnd) as string);

  const rows: GeneratedPayrollRow[] = [];
  const installments: Array<{ id: string; loanId: string; payrollId: string; month: number; year: number; amount: number }> = [];
  const bonusReservations: Array<{ payrollId: string; allowanceIds: string[] }> = [];
  const overtimeReservations: Array<{ payrollId: string; overtimeIds: string[] }> = [];
  const reservedDeductionIds: string[] = [];
  const deferredDeductionIds: string[] = [];
  let provisionalGosi = 0;
  // Regulatory values per legal company (P1-RULE): read once per generation, overrides included.
  const rules = createRulesReader(db);

  for (const emp of employees) {
    if (skip.has(emp.id) || elsewhere.has(emp.id)) continue;

    const segments = pay.get(emp.id) ?? [];
    // No compensation in force on any day of the month (a new hire whose pay is not decided yet, a legacy
    // file without salary: INV-EFF-02 / INV-SAL-01 LEGACY_READY): nothing is paid, items wait.
    if (!segments.length) continue;
    const salary = salaryOf(segments[segments.length - 1]);
    const recurring = salary.allowances as AllowanceLike[];
    const empSpans = spans.get(emp.id);
    const coverage = settlementCoverage(emp.settlements, salary, { periodStart: currentPeriodStart(empSpans) });
    // payrollEligible (BL-LCY-012): the one condition, from lifecycle's employmentEnd (NOTICE included)
    // and the EOS settlement of the current period (it pays its last month).
    const eligibility = payrollEligible({ employee: emp, year, month, settlementFinalDay: coverage.finalDay });
    if (!eligibility.eligible) continue;
    const employmentEnd = eligibility.employmentEnd;
    const excluded = [
      ...coverage.excluded,
      ...employmentGapsWithin(empSpans, monthStart, monthEnd).map((g) => ({ start: new Date(`${g.start}T00:00:00.000Z`), end: new Date(`${g.end}T00:00:00.000Z`) })),
    ];

    // One-off bonuses due up to this month and not reserved by another month's draft.
    const bonuses = emp.allowances.filter((a) => {
      if (a.paidInPayrollId && !draftIdSet.has(a.paidInPayrollId)) return false;
      if (a.payrollYear == null || a.payrollMonth == null) return true; // legacy: first generation after creation
      return monthIndex(a.payrollYear, a.payrollMonth) <= thisIdx;
    });

    // Deductions: this month's, plus earlier ones that were never deducted (their month had no
    // finalized payroll, or they became payable after that payroll was generated - a deduction
    // that was payable at generation time was reserved by it and linked on approval).
    // Payroll.createdAt (generation time) is used, not updatedAt (which moves when it is paid).
    // A deduction a generation offered but could not fit (deferredPayrollMonth, BL-PAY-030) is never
    // a stale one: it stays due until a payroll line takes it.
    const generatedByMonth = new Map(emp.payrolls.map((p) => [payrollMonthKey(p.year, p.month), p.createdAt]));
    const deductions = emp.deductions.filter((d) => {
      if (d.date >= monthStart) return true;
      if (d.deferredPayrollMonth) return true;
      const k = (dateKey(d.date) ?? '').slice(0, 7);
      const generatedAt = generatedByMonth.get(k);
      if (!generatedAt) return true;
      return !!d.approvedAt && d.approvedAt > generatedAt;
    });

    const overtimes = emp.overtimeRequests.filter((ot) =>
      overtimeDueInMonth(ot, emp.payrolls, year, month, { legacyCutoff, replacing: draftIdSet }),
    );

    const loans = emp.loans.map((l) => {
      const reservedElsewhere = sumMoney(
        l.installments.filter((i) => !(i.month === month && i.year === year)).map((i) => i.amount),
      );
      return { id: l.id, monthlyInstallment: l.monthlyInstallment, remaining: roundMoney(l.remainingAmount - reservedElsewhere) };
    });

    const law = await rules.laborLaw(emp.legalCompanyId ?? null, monthEnd);
    const line = computePayrollLine({
      year,
      month,
      sickLeaveLaw: law.sickLeave,
      employee: {
        basicSalary: salary.basicSalary,
        nationality: emp.nationality,
        gosiDeduction: emp.gosiDeduction,
        joinDate: emp.joinDate,
        allowances: recurring,
        gosiRegime: emp.gosiRegime,
      },
      gosiRates,
      employmentEnd,
      excluded,
      compensationSegments: segments.map((s) => ({ from: s.from, to: s.to, basicSalary: s.basicSalary, allowances: salaryOf(s).allowances as AllowanceLike[] })),
      bonuses: bonuses.map((b) => ({ id: b.id, amount: b.amount })),
      overtimes,
      deductions: deductions.map((d) => ({ id: d.id, amount: d.amount, date: d.date })),
      leaves: emp.leaves,
      loans,
      settings,
      overtimeBasis: overtimeBasisForEmployee(emp),
      payment: { method: emp.salaryPaymentMethod, iban: readableIban(emp.ibanNumber) },
    });

    // Nothing to pay this month (not employed / fully covered by a settlement): carry items forward.
    if (line.eligibleDays === 0 && bonuses.length === 0 && overtimes.length === 0) continue;

    if (line.gosiProvisional) provisionalGosi++;
    const id = randomUUID();
    rows.push({
      id,
      employeeId: emp.id,
      month,
      year,
      basicSalary: line.basicSalary,
      totalAllowances: line.totalAllowances,
      totalDeductions: line.totalDeductions,
      overtimeCost: line.overtimeCost,
      netSalary: line.netSalary,
      ...payrollBreakdownColumns(line),
      status: PAYROLL_STATUS.DRAFT,
    });
    for (const li of line.loanInstallments) {
      installments.push({ id: randomUUID(), loanId: li.loanId, payrollId: id, month, year, amount: li.amount });
    }
    if (bonuses.length) bonusReservations.push({ payrollId: id, allowanceIds: bonuses.map((b) => b.id) });
    if (overtimes.length) overtimeReservations.push({ payrollId: id, overtimeIds: overtimes.map((o) => o.id) });
    // Only the deductions the line takes are reserved (and linked on approval); the others are marked
    // deferred and offered again next month (BL-PAY-030).
    reservedDeductionIds.push(...line.deductionsTaken);
    deferredDeductionIds.push(...line.deductionsDeferred.map((d) => d.id));
  }

  return {
    plan: {
      companyId,
      year,
      month,
      ...(only ? { employeeIds: only } : {}),
      scopeEmployeeIds: employees.map((e) => e.id),
      supplementary: !!input.supplementary,
      finalizedCount: finalized.length,
      version: monthRow?.version ?? 0,
      replaceDraftIds: draftIds,
      rows,
      installments,
      bonusReservations,
      overtimeReservations,
      reservedDeductionIds,
      deferredDeductionIds,
    },
    skippedFinalized: skip.size,
    skippedOtherCompany: [...elsewhere].filter((id) => !skip.has(id)).length,
    provisionalGosi,
  };
}

/**
 * Generates (or regenerates) the DRAFT payroll of ONE company's month (payroll.generate, a SYSTEM
 * operation triggered by `actor`): the computation reads first, then src/modules/payroll commits it in
 * one transaction behind money.gateway. Only DRAFT lines are replaced; 409 when the month already has
 * approved / paid lines (unless `supplementary`), or when the month moved since the computation.
 * The operation key (default: company, month, the month's version, the mode) makes a double click
 * replay the first result.
 */
export async function generatePayrollMonth(
  db: PrismaClient,
  input: PlanInput & { actor: MoneyActor; operationKey?: string },
): Promise<GeneratePayrollResult> {
  const outcome = await computeGenerationPlan(db, input);
  const { plan } = outcome;
  if (!plan.rows.length && !plan.replaceDraftIds.length) {
    // Nobody to pay and nothing to replace: no month is opened for the company.
    return {
      rows: [],
      skippedFinalized: outcome.skippedFinalized,
      skippedOtherCompany: outcome.skippedOtherCompany,
      replacedDrafts: 0,
      needsReview: 0,
      provisionalGosi: 0,
      reviewCounts: {},
      payrollMonthId: null,
      monthStatus: null,
      replayed: false,
    };
  }
  const operationKey = input.operationKey ?? `payroll.generate:${plan.companyId}:${payrollMonthKey(plan.year, plan.month)}:v${plan.version}:${plan.supplementary ? 'supplementary' : 'full'}`;
  // The plan was computed through the caller's (scoped) client; the commit runs on the root client, which
  // the employee lock of ADR-0002 #2 needs (raw SQL, refused on a scoped client). Every row it writes
  // belongs to the plan's company.
  const committed = await runPayrollTransaction(prisma, (tx) => commitPayrollGeneration(tx, { plan, actor: input.actor, operationKey }));
  const rows = [...plan.rows];
  return {
    rows,
    skippedFinalized: outcome.skippedFinalized,
    skippedOtherCompany: outcome.skippedOtherCompany,
    replacedDrafts: committed.replacedDrafts,
    needsReview: rows.filter((r) => r.needsReview).length,
    provisionalGosi: outcome.provisionalGosi,
    reviewCounts: countPayrollReviewKeys(rows),
    payrollMonthId: committed.payrollMonthId,
    monthStatus: committed.status,
    replayed: committed.replayed,
  };
}

/**
 * The payroll.employment consumer's regeneration of one employee's line in one company's month, in the
 * consumer's transaction (BL-PAY-025): recomputed from the current facts and committed with the
 * consumption (src/modules/payroll/consumers.ts).
 */
export async function regenerateEmployeeLineForConsumer(
  ctx: { tx: TxClient; operationKey: string },
  target: { companyId: string; year: number; month: number; employeeId: string },
): Promise<void> {
  const { plan } = await computeGenerationPlan(ctx.tx, { companyId: target.companyId, year: target.year, month: target.month, employeeIds: [target.employeeId] });
  await commitPayrollGeneration(ctx.tx, {
    plan,
    actor: null,
    operationKey: `${ctx.operationKey}:${target.companyId}:${payrollMonthKey(target.year, target.month)}`,
    regenerate: true,
  });
}

// ---------------------------------------------------------------------------
// Month summary / export (server totals from the STORED rows, DEC-002 / DEC-010)
// ---------------------------------------------------------------------------

/** Stored columns needed for totals (one Payroll row). */
export interface StoredPayrollRow extends PayrollBreakdownColumns {
  status: string;
  basicSalary: number;
  totalAllowances: number;
  overtimeCost: number;
  totalDeductions: number;
  netSalary: number;
}

export interface PayrollTotals {
  basicSalary: number;
  /** Recurring allowances (totalAllowances minus one-off bonuses). */
  recurringAllowances: number;
  bonusAmount: number;
  totalAllowances: number;
  overtimeCost: number;
  gross: number;
  gosiEmployee: number;
  leaveDeduction: number;
  loansDeduction: number;
  violationsDeduction: number;
  otherDeductions: number;
  totalDeductions: number;
  netSalary: number;
  /** Employer GOSI share: company cost, not deducted from employees. */
  gosiEmployer: number;
  /** gross + employer GOSI. */
  employerCost: number;
}

/**
 * Whether a stored row's breakdown columns add up to its totalDeductions. Rows generated before
 * the breakdown columns existed have zeros there (their split is unknown, never guessed).
 */
export function hasStoredBreakdown(row: Pick<StoredPayrollRow, 'totalDeductions' | 'gosiEmployee' | 'loansDeduction' | 'violationsDeduction' | 'leaveDeduction' | 'otherDeductions'>): boolean {
  return Math.abs(employeeDeductionsTotal(row) - row.totalDeductions) < 0.01;
}

/** Totals of stored payroll rows (pure; every value from the stored columns). */
export function payrollTotals(rows: ReadonlyArray<StoredPayrollRow>): PayrollTotals {
  const sum = (f: (r: StoredPayrollRow) => number) => sumMoney(rows.map(f));
  const basicSalary = sum((r) => r.basicSalary);
  const totalAllowances = sum((r) => r.totalAllowances);
  const bonusAmount = sum((r) => r.bonusAmount);
  const overtimeCost = sum((r) => r.overtimeCost);
  const gross = sumMoney([basicSalary, totalAllowances, overtimeCost]);
  const gosiEmployer = sum((r) => r.gosiEmployer);
  return {
    basicSalary,
    recurringAllowances: roundMoney(totalAllowances - bonusAmount),
    bonusAmount,
    totalAllowances,
    overtimeCost,
    gross,
    gosiEmployee: sum((r) => r.gosiEmployee),
    leaveDeduction: sum((r) => r.leaveDeduction),
    loansDeduction: sum((r) => r.loansDeduction),
    violationsDeduction: sum((r) => r.violationsDeduction),
    otherDeductions: sum((r) => r.otherDeductions),
    totalDeductions: sum((r) => r.totalDeductions),
    netSalary: sum((r) => r.netSalary),
    gosiEmployer,
    employerCost: sumMoney([gross, gosiEmployer]),
  };
}

export const STORED_PAYROLL_SELECT = {
  status: true,
  basicSalary: true,
  totalAllowances: true,
  overtimeCost: true,
  totalDeductions: true,
  netSalary: true,
  gosiEmployee: true,
  gosiEmployer: true,
  loansDeduction: true,
  violationsDeduction: true,
  leaveDeduction: true,
  otherDeductions: true,
  bonusAmount: true,
  needsReview: true,
  reviewNote: true,
} as const;

export interface PayrollMonthSummary {
  month: number;
  year: number;
  count: number;
  byStatus: Record<string, number>;
  needsReviewCount: number;
  /** Flagged rows per review code (all statuses of the month). */
  reviewCounts: Partial<Record<PayrollReviewFilterKey, number>>;
  /** Rows without a stored breakdown (generated before the columns existed). */
  legacyRows: number;
  totals: PayrollTotals;
  /** Provisional GOSI rate rows in force for this month (awaiting counsel confirmation). */
  provisionalRates: Array<{ regime: string; isSaudi: boolean; effectiveFrom: Date; employeeRate: number; employerRate: number }>;
  /** Employees on this month's payroll whose regime is NEW (Saudis among them use the provisional rows). */
  newRegimeCount: number;
}

/** Server-side summary of one payroll month (all statuses), from the stored rows. */
export async function payrollMonthSummary(db: Tx, year: number, month: number): Promise<PayrollMonthSummary> {
  const [rows, rates, newRegimeCount] = await Promise.all([
    db.payroll.findMany({ where: { year, month }, select: STORED_PAYROLL_SELECT }),
    loadGosiRates(db),
    db.payroll.count({ where: { year, month, employee: { gosiRegime: 'NEW' } } }),
  ]);
  // The rate row in force for the month per (regime, isSaudi), listed when provisional.
  const provisionalRates: PayrollMonthSummary['provisionalRates'] = [];
  for (const key of new Set(rates.map((r) => `${r.regime}|${r.isSaudi}`))) {
    const [regime, saudi] = key.split('|');
    const r = pickGosiRate(rates, regime, saudi === 'true', year, month);
    if (r?.isProvisional) {
      provisionalRates.push({
        regime: String(r.regime),
        isSaudi: r.isSaudi,
        effectiveFrom: r.effectiveFrom,
        employeeRate: r.employeeRate,
        employerRate: r.employerRate,
      });
    }
  }
  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  return {
    month,
    year,
    count: rows.length,
    byStatus,
    needsReviewCount: rows.filter((r) => r.needsReview).length,
    reviewCounts: countPayrollReviewKeys(rows),
    legacyRows: rows.filter((r) => !hasStoredBreakdown(r)).length,
    totals: payrollTotals(rows),
    provisionalRates,
    newRegimeCount,
  };
}

/** Months that have payroll rows (newest first) with per-status counts and net totals. */
export async function payrollMonths(
  db: Tx,
): Promise<Array<{ year: number; month: number; status: string; count: number; netSalary: number }>> {
  const groups = await db.payroll.groupBy({
    by: ['year', 'month', 'status'],
    _count: { _all: true },
    _sum: { netSalary: true },
    orderBy: [{ year: 'desc' }, { month: 'desc' }],
  });
  return groups.map((g) => ({
    year: g.year,
    month: g.month,
    status: g.status,
    count: g._count._all,
    netSalary: roundMoney(g._sum.netSalary ?? 0),
  }));
}
