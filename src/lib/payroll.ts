// Payroll domain logic.
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
//   (isLinkedToPayroll=true) when the payroll is approved, so they are never deducted twice.
// - Approved overtime is reserved by the draft that pays it (OvertimeRequest.paidInPayrollId);
//   the link becomes final when that payroll is approved and is released when the draft is
//   regenerated / dropped. Overtime approved after its month's payroll was generated is paid
//   by the next generated month (overtimeDueInMonth).
import { randomUUID } from 'crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { roundMoney, sumMoney } from '@/lib/money';
import { addDays, dateKey, monthRange } from '@/lib/dates';
import {
  DEDUCTION_PAYABLE_STATUSES,
  LEAVE_STATUS,
  LOAN_DEDUCTIBLE_STATUSES,
  LOAN_STATUS,
  PAYROLL_STATUS,
  SETTLEMENT_STATUS,
} from '@/lib/constants';
import { conflict } from '@/lib/http';
import { decryptField } from '@/lib/crypto';
import {
  computePayrollLine,
  countPayrollReviewKeys,
  employeeDeductionsTotal,
  monthIndex,
  payrollBreakdownColumns,
  overtimeDueInMonth,
  parsePayrollMonthKey,
  parsePayrollSettings,
  payrollMonthKey,
  PAYROLL_SETTING_KEYS,
  settlementCoverage,
  settlementCoversMonth,
  type OvertimeHolders,
  type PayrollBreakdownColumns,
  type PayrollReviewFilterKey,
  type PayrollSettings,
  type SalaryLike,
} from '@/lib/payroll-core';
import { DEFAULT_GOSI_RATES, pickGosiRate, type GosiRateLike } from '@/lib/gosi';

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

/** Breakdown column a refunded amount came from. */
export type RefundKind = 'loan' | 'violation';

/**
 * Recompute a DRAFT payroll's net after its deductions were reduced by `amount` (a released
 * loan installment or violation). The matching breakdown column (loansDeduction /
 * violationsDeduction) is reduced too, so totalDeductions stays the sum of the stored columns.
 */
export async function refundDraftPayroll(tx: Tx, payrollId: string, amount: number, kind?: RefundKind): Promise<void> {
  if (!(amount > 0)) return;
  const p = await tx.payroll.findUnique({
    where: { id: payrollId },
    select: {
      status: true,
      basicSalary: true,
      totalAllowances: true,
      overtimeCost: true,
      totalDeductions: true,
      loansDeduction: true,
      violationsDeduction: true,
    },
  });
  if (!p || p.status !== PAYROLL_STATUS.DRAFT) return;
  const totalDeductions = Math.max(0, roundMoney(p.totalDeductions - amount));
  const netSalary = Math.max(0, roundMoney(p.basicSalary + p.totalAllowances + p.overtimeCost - totalDeductions));
  const data: Prisma.PayrollUpdateInput = { totalDeductions, netSalary };
  if (kind === 'loan') data.loansDeduction = Math.max(0, roundMoney(p.loansDeduction - amount));
  if (kind === 'violation') data.violationsDeduction = Math.max(0, roundMoney(p.violationsDeduction - amount));
  await tx.payroll.update({ where: { id: payrollId }, data });
}

/** Removes a loan's installments from DRAFT payrolls (e.g. loan forgiven / settled) and refunds those drafts. */
export async function releaseLoanFromDrafts(tx: Tx, loanId: string): Promise<void> {
  const rows = await tx.loanInstallment.findMany({
    where: { loanId, OR: [{ payrollId: null }, { payroll: { status: PAYROLL_STATUS.DRAFT } }] },
    select: { id: true, payrollId: true, amount: true },
  });
  for (const r of rows) {
    if (r.payrollId) await refundDraftPayroll(tx, r.payrollId, r.amount, 'loan');
  }
  if (rows.length) await tx.loanInstallment.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
}

/**
 * Removes a deduction's reservation by a DRAFT payroll (it was waived / rejected / referred)
 * and refunds that draft. No-op for deductions already linked to an approved payroll.
 */
export async function releaseDeductionFromDraft(
  tx: Tx,
  d: { id: string; employeeId: string; amount: number; payrollMonth: string | null; isLinkedToPayroll: boolean },
): Promise<void> {
  if (d.isLinkedToPayroll || !d.payrollMonth) return;
  const ym = parsePayrollMonthKey(d.payrollMonth);
  if (ym) {
    const draft = await tx.payroll.findFirst({
      where: { employeeId: d.employeeId, month: ym.month, year: ym.year, status: PAYROLL_STATUS.DRAFT },
      select: { id: true },
    });
    if (draft) await refundDraftPayroll(tx, draft.id, d.amount, 'violation');
  }
  await tx.deduction.updateMany({ where: { id: d.id, isLinkedToPayroll: false }, data: { payrollMonth: null } });
}

/** Deletes DRAFT payrolls and releases everything they reserved (bonuses, overtime, deductions, loan installments). */
export async function releaseDraftPayrolls(tx: Tx, payrollIds: string[]): Promise<number> {
  if (!payrollIds.length) return 0;
  const drafts = await tx.payroll.findMany({
    where: { id: { in: payrollIds }, status: PAYROLL_STATUS.DRAFT },
    select: { id: true, employeeId: true, month: true, year: true },
  });
  if (!drafts.length) return 0;
  const ids = drafts.map((d) => d.id);
  await tx.allowance.updateMany({ where: { paidInPayrollId: { in: ids }, isPaid: false }, data: { paidInPayrollId: null } });
  await tx.overtimeRequest.updateMany({ where: { paidInPayrollId: { in: ids } }, data: { paidInPayrollId: null } });

  const byMonth = new Map<string, string[]>();
  for (const d of drafts) {
    const key = payrollMonthKey(d.year, d.month);
    byMonth.set(key, [...(byMonth.get(key) ?? []), d.employeeId]);
  }
  for (const [key, employeeIds] of byMonth) {
    await tx.deduction.updateMany({
      where: { employeeId: { in: employeeIds }, payrollMonth: key, isLinkedToPayroll: false },
      data: { payrollMonth: null },
    });
  }
  await tx.loanInstallment.deleteMany({ where: { payrollId: { in: ids } } });
  const res = await tx.payroll.deleteMany({ where: { id: { in: ids }, status: PAYROLL_STATUS.DRAFT } });
  return res.count;
}

/** Deletes an employee's DRAFT payrolls from a given month onwards (used when a settlement is approved). */
export async function releaseEmployeeDraftsFrom(tx: Tx, employeeId: string, year: number, month: number): Promise<number> {
  const drafts = await tx.payroll.findMany({
    where: {
      employeeId,
      status: PAYROLL_STATUS.DRAFT,
      OR: [{ year: { gt: year } }, { year, month: { gte: month } }],
    },
    select: { id: true },
  });
  return releaseDraftPayrolls(
    tx,
    drafts.map((d) => d.id),
  );
}

/** Distinct (year, month) that currently have DRAFT payrolls. */
export async function draftMonths(db: Tx): Promise<Array<{ year: number; month: number }>> {
  const rows = await db.payroll.findMany({
    where: { status: PAYROLL_STATUS.DRAFT },
    select: { year: true, month: true },
    distinct: ['year', 'month'],
    orderBy: [{ year: 'asc' }, { month: 'asc' }],
  });
  return rows;
}

/**
 * DRAFT -> APPROVED for every draft of one month, and applies side effects exactly once:
 * loan balances are decremented by the recorded installments (loan COMPLETED at 0),
 * reserved one-off bonuses become isPaid, reserved deductions become isLinkedToPayroll and the
 * overtime the drafts hold (paidInPayrollId) stays linked to the now-approved rows (= paid).
 */
export async function approvePayrollMonth(
  tx: Tx,
  year: number,
  month: number,
): Promise<{ count: number; payrollIds: string[]; loansCompleted: number }> {
  const drafts = await tx.payroll.findMany({
    where: { year, month, status: PAYROLL_STATUS.DRAFT },
    select: {
      id: true,
      employeeId: true,
      createdAt: true,
      employee: {
        select: {
          firstNameArabic: true,
          lastNameArabic: true,
          basicSalary: true,
          allowances: { where: { isMonthly: true }, select: { name: true, amount: true, isMonthly: true } },
          settlements: {
            where: { status: { not: SETTLEMENT_STATUS.REJECTED } },
            select: { type: true, status: true, lastWorkingDate: true, createdAt: true, salaryBasis: true, leaveCompensation: true },
          },
        },
      },
    },
  });
  if (!drafts.length) throw conflict(`لا توجد مسودات رواتب بانتظار الاعتماد لشهر ${month}/${year}`);
  // A draft generated BEFORE a settlement that covers this month would pay what the settlement
  // pays (last month's working days, settled leave days, overtime / installments it holds):
  // the month must be regenerated first (generation applies settlementCoverage).
  const stale = drafts.filter((d) => {
    const newer = d.employee.settlements.filter((s) => s.createdAt > d.createdAt);
    return settlementCoversMonth(newer, { basicSalary: d.employee.basicSalary, allowances: d.employee.allowances }, year, month);
  });
  if (stale.length) {
    const names = stale.slice(0, 5).map((d) => `${d.employee.firstNameArabic} ${d.employee.lastNameArabic}`.trim()).join('، ');
    throw conflict(
      `أُنشئت تصفية بعد توليد مسودة ${month}/${year} للموظفين: ${names}${stale.length > 5 ? ' وآخرين' : ''}. يرجى إعادة توليد مسير الشهر قبل الاعتماد`,
    );
  }
  const ids = drafts.map((d) => d.id);

  const res = await tx.payroll.updateMany({
    where: { id: { in: ids }, status: PAYROLL_STATUS.DRAFT },
    data: { status: PAYROLL_STATUS.APPROVED },
  });
  if (res.count !== ids.length) {
    throw conflict('تم تعديل مسير الرواتب من مستخدم آخر أثناء الاعتماد، يرجى تحديث الصفحة والمحاولة مجدداً');
  }

  await tx.allowance.updateMany({ where: { paidInPayrollId: { in: ids }, isPaid: false }, data: { isPaid: true } });
  await tx.deduction.updateMany({
    where: {
      employeeId: { in: drafts.map((d) => d.employeeId) },
      payrollMonth: payrollMonthKey(year, month),
      isLinkedToPayroll: false,
      status: { in: [...DEDUCTION_PAYABLE_STATUSES] },
    },
    data: { isLinkedToPayroll: true },
  });

  const installments = await tx.loanInstallment.findMany({
    where: { payrollId: { in: ids } },
    select: { loanId: true, amount: true },
  });
  const perLoan = new Map<string, number>();
  for (const i of installments) perLoan.set(i.loanId, roundMoney((perLoan.get(i.loanId) ?? 0) + i.amount));
  for (const [loanId, amount] of perLoan) {
    await tx.loan.update({ where: { id: loanId }, data: { remainingAmount: { decrement: amount } } });
  }
  let loansCompleted = 0;
  if (perLoan.size) {
    const done = await tx.loan.updateMany({
      where: { id: { in: [...perLoan.keys()] }, remainingAmount: { lte: 0.009 }, isForgiven: false },
      data: { remainingAmount: 0, status: LOAN_STATUS.COMPLETED },
    });
    loansCompleted = done.count;
  }
  return { count: res.count, payrollIds: ids, loansCompleted };
}

/** APPROVED -> PAID for one month. */
export async function markPayrollMonthPaid(tx: Tx, year: number, month: number): Promise<number> {
  const res = await tx.payroll.updateMany({
    where: { year, month, status: PAYROLL_STATUS.APPROVED },
    data: { status: PAYROLL_STATUS.PAID, paidAt: new Date() },
  });
  if (res.count === 0) throw conflict(`لا يوجد مسير معتمد بانتظار الصرف لشهر ${month}/${year}`);
  return res.count;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export interface GeneratedPayrollRow extends PayrollBreakdownColumns {
  id: string;
  employeeId: string;
  month: number;
  year: number;
  basicSalary: number;
  totalAllowances: number;
  totalDeductions: number;
  overtimeCost: number;
  netSalary: number;
  status: typeof PAYROLL_STATUS.DRAFT;
}

export interface GeneratePayrollResult {
  rows: GeneratedPayrollRow[];
  skippedFinalized: number;
  replacedDrafts: number;
  /** Lines flagged for review (they are generated anyway: one employee never blocks the run). */
  needsReview: number;
  /** Lines whose GOSI used a provisional rate row. */
  provisionalGosi: number;
  /** Flagged lines per review code (a line with several codes counts once per code). */
  reviewCounts: Partial<Record<PayrollReviewFilterKey, number>>;
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

/**
 * Generates (or regenerates) the DRAFT payroll of a month.
 * - Throws 409 if the month already has APPROVED/PAID payrolls, unless `supplementary` is true,
 *   in which case only employees without a finalized payroll that month get a draft.
 * - Reads are done up front; all writes happen in one transaction with a long timeout,
 *   using createMany / updateMany so hundreds of employees are handled in a few queries.
 */
export async function generatePayrollMonth(
  db: PrismaClient,
  year: number,
  month: number,
  opts: { supplementary?: boolean } = {},
): Promise<GeneratePayrollResult> {
  const { start: monthStart, end: monthEnd } = monthRange(year, month);
  const nextMonthStart = addDays(monthEnd, 1);
  const key = payrollMonthKey(year, month);
  const thisIdx = monthIndex(year, month);

  const existing = await db.payroll.findMany({
    where: { year, month },
    select: { id: true, employeeId: true, status: true, isFinalSettlement: true },
  });
  const finalized = existing.filter((p) => p.status !== PAYROLL_STATUS.DRAFT);
  if (finalized.length && !opts.supplementary) {
    throw conflict(
      `مسير رواتب شهر ${month}/${year} معتمد أو مصروف مسبقاً (${finalized.length} موظف) ولا يمكن إعادة توليده`,
    );
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
      joinDate: { lte: monthEnd },
      OR: [{ isTerminated: false }, { terminationDate: { gte: monthStart } }],
    },
    select: {
      id: true,
      basicSalary: true,
      nationality: true,
      gosiDeduction: true,
      gosiRegime: true,
      joinDate: true,
      isTerminated: true,
      terminationDate: true,
      // Payment-readiness review flags only (IBAN_MISSING / IBAN_INVALID / CASH).
      ibanNumber: true,
      salaryPaymentMethod: true,
      allowances: {
        where: { OR: [{ isMonthly: true }, { isMonthly: false, isPaid: false }] },
        select: {
          id: true,
          name: true,
          amount: true,
          isMonthly: true,
          countsTowardGosi: true,
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
        select: { id: true, amount: true, date: true, approvedAt: true },
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
      settlements: {
        where: { status: { not: SETTLEMENT_STATUS.REJECTED } },
        select: { type: true, status: true, lastWorkingDate: true, createdAt: true, salaryBasis: true, leaveCompensation: true },
      },
      payrolls: {
        where: { status: { in: [PAYROLL_STATUS.APPROVED, PAYROLL_STATUS.PAID] } },
        select: { month: true, year: true, createdAt: true },
      },
    },
  });

  const rows: GeneratedPayrollRow[] = [];
  const installments: Array<{ id: string; loanId: string; payrollId: string; month: number; year: number; amount: number }> = [];
  const bonusReservations: Array<{ payrollId: string; ids: string[] }> = [];
  const overtimeReservations: Array<{ payrollId: string; ids: string[] }> = [];
  const reservedDeductionIds: string[] = [];
  let provisionalGosi = 0;

  for (const emp of employees) {
    if (skip.has(emp.id)) continue;

    const recurring = emp.allowances.filter((a) => a.isMonthly);
    const salary: SalaryLike = { basicSalary: emp.basicSalary, allowances: recurring };
    const coverage = settlementCoverage(emp.settlements, salary);
    if (coverage.finalDay && coverage.finalDay <= monthEnd) continue; // final month paid by the EOS settlement

    let employmentEnd: Date | null = null;
    if (emp.isTerminated && emp.terminationDate) employmentEnd = emp.terminationDate;

    // One-off bonuses due up to this month and not reserved by another month's draft.
    const bonuses = emp.allowances.filter((a) => {
      if (a.isMonthly) return false;
      if (a.paidInPayrollId && !draftIdSet.has(a.paidInPayrollId)) return false;
      if (a.payrollYear == null || a.payrollMonth == null) return true; // legacy: first generation after creation
      return monthIndex(a.payrollYear, a.payrollMonth) <= thisIdx;
    });

    // Deductions: this month's, plus earlier ones that were never deducted (their month had no
    // finalized payroll, or they became payable after that payroll was generated - a deduction
    // that was payable at generation time was reserved by it and linked on approval).
    // Payroll.createdAt (generation time) is used, not updatedAt (which moves when it is paid).
    const generatedByMonth = new Map(emp.payrolls.map((p) => [payrollMonthKey(p.year, p.month), p.createdAt]));
    const deductions = emp.deductions.filter((d) => {
      if (d.date >= monthStart) return true;
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

    const line = computePayrollLine({
      year,
      month,
      employee: {
        basicSalary: emp.basicSalary,
        nationality: emp.nationality,
        gosiDeduction: emp.gosiDeduction,
        joinDate: emp.joinDate,
        allowances: recurring,
        gosiRegime: emp.gosiRegime,
      },
      gosiRates,
      employmentEnd,
      excluded: coverage.excluded,
      bonuses: bonuses.map((b) => ({ id: b.id, amount: b.amount })),
      overtimes,
      deductions: deductions.map((d) => ({ id: d.id, amount: d.amount })),
      leaves: emp.leaves,
      loans,
      settings,
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
    if (bonuses.length) bonusReservations.push({ payrollId: id, ids: bonuses.map((b) => b.id) });
    if (overtimes.length) overtimeReservations.push({ payrollId: id, ids: overtimes.map((o) => o.id) });
    reservedDeductionIds.push(...deductions.map((d) => d.id));
  }

  const result = await db.$transaction(
    async (tx) => {
      const finalizedNow = await tx.payroll.count({ where: { year, month, status: { not: PAYROLL_STATUS.DRAFT } } });
      if (finalizedNow !== finalized.length) {
        throw conflict('تم اعتماد مسير هذا الشهر أثناء التوليد، يرجى تحديث الصفحة');
      }
      const replacedDrafts = await releaseDraftPayrolls(tx, draftIds);
      // Orphan installments of this month (their draft was deleted elsewhere).
      await tx.loanInstallment.deleteMany({ where: { month, year, payrollId: null } });

      if (rows.length) await tx.payroll.createMany({ data: rows });
      if (installments.length) await tx.loanInstallment.createMany({ data: installments });
      for (const b of bonusReservations) {
        await tx.allowance.updateMany({
          where: { id: { in: b.ids }, isPaid: false },
          data: { paidInPayrollId: b.payrollId, payrollMonth: month, payrollYear: year },
        });
      }
      // Overtime: only rows still free after the replaced drafts were released. A row approved
      // into a settlement (or taken by a concurrent generation) since the reads would be paid twice.
      for (const o of overtimeReservations) {
        const res = await tx.overtimeRequest.updateMany({
          where: { id: { in: o.ids }, status: 'APPROVED', paidInPayrollId: null, paidInSettlementId: null },
          data: { paidInPayrollId: o.payrollId },
        });
        if (res.count !== o.ids.length) {
          throw conflict('تغيّرت طلبات العمل الإضافي أثناء توليد المسير (تصفية أو توليد آخر)، يرجى إعادة التوليد');
        }
      }
      if (reservedDeductionIds.length) {
        await tx.deduction.updateMany({
          where: { id: { in: reservedDeductionIds }, isLinkedToPayroll: false },
          data: { payrollMonth: key },
        });
      }
      return { replacedDrafts };
    },
    { timeout: 60000, maxWait: 10000 },
  );

  return {
    rows,
    skippedFinalized: skip.size,
    replacedDrafts: result.replacedDrafts,
    needsReview: rows.filter((r) => r.needsReview).length,
    provisionalGosi,
    reviewCounts: countPayrollReviewKeys(rows),
  };
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
