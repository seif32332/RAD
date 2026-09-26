// Financial workflow state machines: loans, deductions (penalties) and settlements.
//
// Every helper runs inside a caller-provided transaction, guards the previous status
// atomically (updateMany ... where status in [...]) and throws conflict() (409) when the
// record was already processed, so double clicks / concurrent requests can never apply
// side effects twice. Missing records throw notFound() (404).
//
// Loan approval chain (matches src/app/loans/page.tsx):
//   PENDING --MANAGER--> MANAGER_APPROVED --HR--> HR_APPROVED
//   HR_APPROVED --markLoanTransferred (finance attaches the transfer receipt)--> FINANCE_TRANSFERRED
//   FINANCE_TRANSFERRED --FINANCE (final confirmation, UI "HR_FINAL")--> FINANCE_APPROVED (active)
//   OWNER may approve a loan still PENDING / MANAGER_APPROVED on behalf of manager + HR -> HR_APPROVED.
//   Branch / department managers act only on loans of their team (assertCanManageEmployee).
//   Installments are deducted by payroll while the loan is FINANCE_TRANSFERRED / FINANCE_APPROVED.
//
// Deductions: approve = the penalty stands (-> DEDUCTED, due in payroll);
//             reject  = the penalty is dropped (-> REJECTED, or WAIVED for a waive request).
import 'server-only';
import type { Prisma } from '@prisma/client';
import type { AuthUser } from '@/lib/auth';
import { logAudit } from '@/lib/audit';
import { enforceMakerChecker } from '@/app/api/payments/maker-checker';
import { decryptField } from '@/lib/crypto';
import { conflict, forbidden, notFound, badRequest } from '@/lib/http';
import { roundMoney, sumMoney } from '@/lib/money';
import { today } from '@/lib/dates';
import {
  DEDUCTION_PENDING_STATUSES,
  DEDUCTION_STATUS,
  LOAN_DEDUCTIBLE_STATUSES,
  LOAN_PENDING_STATUSES,
  LOAN_STATUS,
  PAYROLL_STATUS,
  ROLE_GROUPS,
  SETTLEMENT_STATUS,
  roleIn,
} from '@/lib/constants';
import {
  loadPayrollSettings,
  overtimeAmount,
  overtimeBasisForEmployee,
  OVERTIME_BASIS_SELECT,
  overtimeDueInSettlement,
  overtimeHolders,
  overtimeLegacyCutoff,
  releaseDeductionFromDraft,
  releaseEmployeeDraftsFrom,
  releaseLoanFromDrafts,
} from '@/lib/payroll';
import { monthOf } from '@/lib/settlement';
import { dailyRate } from '@/lib/payroll-core';
import { TERMINATION_TO_EXIT_REASON, type EmployeeExitReason } from '@/lib/workforce/reasons';

/** Article 70: a single disciplinary deduction may not exceed five days' wage. */
export const MAX_PENALTY_DAYS = 5;

/** Throws 400 when a penalty amount exceeds five days' wage (Article 70). */
export function assertWithinPenaltyCap(amount: number, dailyWage: number): void {
  if (dailyWage > 0 && amount > roundMoney(dailyWage * MAX_PENALTY_DAYS) + 0.005) {
    throw badRequest(`لا يجوز أن يتجاوز الجزاء الواحد أجر ${MAX_PENALTY_DAYS} أيام (${roundMoney(dailyWage * MAX_PENALTY_DAYS)} ريال) وفق المادة 70 من نظام العمل`);
  }
}
import { assertCanManageEmployee } from '@/lib/hr-workflows';
import { deactivateEmployeeUser, type DeactivateResult } from '@/lib/access';

type Tx = Prisma.TransactionClient;

/**
 * Default of Employee.exitVoluntary per structured exit reason. LOCAL COPY of defaultExitVoluntary()
 * in src/app/api/employees/_workforce-fields.ts: the lib layer does not import from src/app (see
 * src/lib/workforce/reasons.ts), and reasons.ts has no equivalent helper.
 * src/lib/__tests__/wf-fix-exit-fields.test.ts fails if the two drift apart.
 */
export const EXIT_VOLUNTARY_DEFAULT: Readonly<Record<EmployeeExitReason, boolean | null>> = {
  RESIGNATION: true,
  RETIREMENT: true,
  ABSCONDING: true,
  EMPLOYER_TERMINATION: false,
  ARTICLE_80: false,
  DEATH: false,
  CONTRACT_END: null,
  MUTUAL_AGREEMENT: null,
  PROBATION: null,
  OTHER: null,
};

/**
 * Employee.exitReason / exitVoluntary to record when an END_OF_SERVICE settlement terminates the
 * employee: the settlement's TerminationReason mapped with TERMINATION_TO_EXIT_REASON, and the
 * voluntary flag defaulted from that reason. Null when the settlement has no (known) reason.
 */
export function exitFieldsForTermination(
  terminationReason: string | null | undefined,
): { exitReason: EmployeeExitReason; exitVoluntary: boolean | null } | null {
  if (!terminationReason || !Object.prototype.hasOwnProperty.call(TERMINATION_TO_EXIT_REASON, terminationReason)) return null;
  const exitReason = (TERMINATION_TO_EXIT_REASON as Readonly<Record<string, EmployeeExitReason>>)[terminationReason];
  return { exitReason, exitVoluntary: EXIT_VOLUNTARY_DEFAULT[exitReason] };
}

/** Optional request context for audit logging. */
export interface FinanceCtx {
  ipAddress?: string | null;
}

export type LoanStage = 'MANAGER' | 'HR' | 'FINANCE' | 'OWNER';

function requireRole(user: AuthUser, group: readonly string[]): void {
  if (!roleIn(user.role, group)) throw forbidden();
}

async function guardFailed(exists: Promise<unknown>, message: string): Promise<never> {
  if (!(await exists)) throw notFound();
  throw conflict(message);
}

// ---------------------------------------------------------------------------
// Loans
// ---------------------------------------------------------------------------

const LOAN_STAGE_RULES: Record<
  LoanStage,
  { from: readonly string[]; roles: readonly string[]; data: (now: Date) => Prisma.LoanUpdateManyMutationInput }
> = {
  MANAGER: {
    from: [LOAN_STATUS.PENDING],
    roles: [...new Set([...ROLE_GROUPS.MANAGERS, ...ROLE_GROUPS.PAYROLL])],
    data: (now) => ({ status: LOAN_STATUS.MANAGER_APPROVED, isManagerApproved: true, managerApprovedAt: now }),
  },
  HR: {
    from: [LOAN_STATUS.PENDING, LOAN_STATUS.MANAGER_APPROVED],
    roles: ROLE_GROUPS.PAYROLL,
    data: (now) => ({ status: LOAN_STATUS.HR_APPROVED, isHrApproved: true, hrApprovedAt: now }),
  },
  FINANCE: {
    from: [LOAN_STATUS.FINANCE_TRANSFERRED],
    roles: ROLE_GROUPS.PAYROLL,
    data: (now) => ({ status: LOAN_STATUS.FINANCE_APPROVED, isFinanceApproved: true, financeApprovedAt: now }),
  },
  OWNER: {
    // Not HR_APPROVED: the loan already went to finance (a second owner approval must be a 409).
    from: [LOAN_STATUS.PENDING, LOAN_STATUS.MANAGER_APPROVED],
    roles: ROLE_GROUPS.OWNER,
    data: (now) => ({
      status: LOAN_STATUS.HR_APPROVED,
      isManagerApproved: true,
      managerApprovedAt: now,
      isHrApproved: true,
      hrApprovedAt: now,
    }),
  },
};

/** Loan statuses from which a stage applies (pure view of LOAN_STAGE_RULES). */
export function loanStageFromStatuses(stage: LoanStage): readonly string[] {
  return LOAN_STAGE_RULES[stage]?.from ?? [];
}

/** Branch / department managers (not HR / payroll / owner) act only on loans of their team. */
export function loanNeedsTeamScope(role: string | null | undefined): boolean {
  return !roleIn(role, ROLE_GROUPS.PAYROLL) && !roleIn(role, ROLE_GROUPS.OWNER);
}

/** Loan statuses a role may reject from: team managers only before HR approval, payroll any pending stage. */
export function loanRejectableStatuses(role: string | null | undefined): string[] {
  return loanNeedsTeamScope(role) ? [LOAN_STATUS.PENDING, LOAN_STATUS.MANAGER_APPROVED] : [...LOAN_PENDING_STATUSES];
}

/**
 * Branch / department managers (not HR / payroll / owner) act only on loans of their team
 * (assertCanManageEmployee: direct reports, own branch / department, never their own loan).
 */
async function assertLoanScope(tx: Tx, loanId: string, user: AuthUser): Promise<void> {
  if (!loanNeedsTeamScope(user.role)) return;
  const loan = await tx.loan.findUnique({
    where: { id: loanId },
    select: { employee: { select: { id: true, directManagerId: true, branchId: true, departmentId: true } } },
  });
  if (!loan) throw notFound('طلب السلفة غير موجود');
  await assertCanManageEmployee(tx, user, loan.employee);
}

/** Advances a loan one approval step. Returns the updated loan. */
export async function approveLoanStep(tx: Tx, loanId: string, stage: LoanStage, user: AuthUser, ctx: FinanceCtx = {}) {
  const rule = LOAN_STAGE_RULES[stage];
  if (!rule) throw badRequest('مرحلة اعتماد غير معروفة');
  requireRole(user, rule.roles);
  await assertLoanScope(tx, loanId, user);
  const now = new Date();
  const res = await tx.loan.updateMany({
    where: { id: loanId, status: { in: [...rule.from] } },
    data: rule.data(now),
  });
  if (res.count === 0) {
    await guardFailed(tx.loan.findUnique({ where: { id: loanId }, select: { id: true } }), 'تمت معالجة هذه المرحلة من طلب السلفة مسبقاً أو أن الطلب ليس في المرحلة الصحيحة');
  }
  const loan = await tx.loan.findUniqueOrThrow({ where: { id: loanId } });
  await logAudit(
    { userId: user.id, action: 'APPROVE', entityType: 'LOAN', entityId: loanId, details: { stage, status: loan.status }, ipAddress: ctx.ipAddress },
    tx,
  );
  return loan;
}

/**
 * Rejects a loan that is still pending (before the money is transferred). Branch / department
 * managers may only reject loans of their team that HR has not approved yet.
 */
export async function rejectLoan(tx: Tx, loanId: string, user: AuthUser, reason?: string | null, ctx: FinanceCtx = {}) {
  requireRole(user, [...new Set([...ROLE_GROUPS.MANAGERS, ...ROLE_GROUPS.PAYROLL])]);
  await assertLoanScope(tx, loanId, user);
  const res = await tx.loan.updateMany({
    where: { id: loanId, status: { in: loanRejectableStatuses(user.role) } },
    data: { status: LOAN_STATUS.REJECTED },
  });
  if (res.count === 0) {
    await guardFailed(tx.loan.findUnique({ where: { id: loanId }, select: { id: true } }), 'لا يمكن رفض السلفة: تمت معالجتها مسبقاً');
  }
  const loan = await tx.loan.findUniqueOrThrow({ where: { id: loanId } });
  await logAudit(
    { userId: user.id, action: 'REJECT', entityType: 'LOAN', entityId: loanId, details: { reason: reason ?? null }, ipAddress: ctx.ipAddress },
    tx,
  );
  return loan;
}

/** Finance attaches the transfer receipt: HR_APPROVED -> FINANCE_TRANSFERRED. */
export async function markLoanTransferred(tx: Tx, loanId: string, receiptUrl: string | null, user: AuthUser, ctx: FinanceCtx = {}) {
  requireRole(user, ROLE_GROUPS.FINANCE);
  const now = new Date();
  const res = await tx.loan.updateMany({
    where: {
      id: loanId,
      isFinanceTransferred: false,
      OR: [
        { status: LOAN_STATUS.HR_APPROVED },
        // Legacy rows: HR approval recorded only in the flag (old incoming-requests flow).
        { status: { in: [LOAN_STATUS.PENDING, LOAN_STATUS.MANAGER_APPROVED] }, isHrApproved: true },
      ],
    },
    data: {
      status: LOAN_STATUS.FINANCE_TRANSFERRED,
      isFinanceTransferred: true,
      financeTransferredAt: now,
      receiptUrl: receiptUrl ?? null,
    },
  });
  if (res.count === 0) {
    await guardFailed(
      tx.loan.findUnique({ where: { id: loanId }, select: { id: true } }),
      'لا يمكن تسجيل التحويل: السلفة لم تعتمد من الموارد البشرية أو تم تحويلها مسبقاً',
    );
  }
  const loan = await tx.loan.findUniqueOrThrow({ where: { id: loanId } });
  await logAudit(
    { userId: user.id, action: 'UPDATE', entityType: 'LOAN', entityId: loanId, details: { status: loan.status, receiptUrl }, ipAddress: ctx.ipAddress },
    tx,
  );
  return loan;
}

/** Company forgives the remaining balance of an active loan. Draft payroll installments are released. */
export async function forgiveLoan(tx: Tx, loanId: string, user: AuthUser, ctx: FinanceCtx = {}) {
  requireRole(user, ROLE_GROUPS.PAYROLL);
  const before = await tx.loan.findUnique({ where: { id: loanId }, select: { remainingAmount: true } });
  if (!before) throw notFound();
  const res = await tx.loan.updateMany({
    where: { id: loanId, isForgiven: false, remainingAmount: { gt: 0 }, status: { in: [...LOAN_DEDUCTIBLE_STATUSES] } },
    data: { isForgiven: true, remainingAmount: 0, status: LOAN_STATUS.FORGIVEN },
  });
  if (res.count === 0) throw conflict('لا يمكن إسقاط السلفة: ليست سلفة نشطة أو تم إسقاطها/سدادها مسبقاً');
  await releaseLoanFromDrafts(tx, loanId);
  const loan = await tx.loan.findUniqueOrThrow({ where: { id: loanId } });
  await logAudit(
    {
      userId: user.id,
      action: 'UPDATE',
      entityType: 'LOAN',
      entityId: loanId,
      details: { forgiven: true, forgivenAmount: before.remainingAmount },
      ipAddress: ctx.ipAddress,
    },
    tx,
  );
  return loan;
}

/**
 * Pays off an employee's active loans through a settlement (called at owner approval, AFTER
 * the drafts from the settlement's last month onwards were dropped).
 * Installments still held by the remaining DRAFT payrolls (earlier months) stay on the loan:
 * remainingAmount becomes exactly those installments, which payroll collects when the drafts are
 * approved (the loan then completes). Everything else is paid by the settlement; a loan with
 * nothing held by drafts is COMPLETED immediately.
 * Returns the amount the settlement collects (= outstandingLoansForSettlement at this moment).
 */
export async function settleEmployeeLoans(
  tx: Tx,
  employeeId: string,
  user: AuthUser,
  ctx: FinanceCtx = {},
): Promise<{ count: number; collected: number }> {
  const loans = await tx.loan.findMany({
    where: { employeeId, isForgiven: false, remainingAmount: { gt: 0 }, status: { in: [...LOAN_DEDUCTIBLE_STATUSES] } },
    select: {
      id: true,
      remainingAmount: true,
      installments: { where: { payroll: { status: PAYROLL_STATUS.DRAFT } }, select: { amount: true } },
    },
  });
  const settled: Array<{ id: string; collected: number; leftForPayroll: number }> = [];
  for (const l of loans) {
    const held = Math.min(l.remainingAmount, sumMoney(l.installments.map((i) => i.amount)));
    const collected = Math.max(0, roundMoney(l.remainingAmount - held));
    if (held > 0.009) {
      await tx.loan.updateMany({ where: { id: l.id, isForgiven: false }, data: { remainingAmount: roundMoney(held) } });
    } else {
      await tx.loan.updateMany({
        where: { id: l.id, isForgiven: false },
        data: { remainingAmount: 0, status: LOAN_STATUS.COMPLETED },
      });
    }
    settled.push({ id: l.id, collected, leftForPayroll: roundMoney(held) });
  }
  const collected = sumMoney(settled.map((s) => s.collected));
  if (settled.length) {
    await logAudit(
      {
        userId: user.id,
        action: 'UPDATE',
        entityType: 'LOAN',
        entityId: employeeId,
        details: { settledBySettlement: settled },
        ipAddress: ctx.ipAddress,
      },
      tx,
    );
  }
  return { count: settled.length, collected };
}

// ---------------------------------------------------------------------------
// Deductions (penalties)
// ---------------------------------------------------------------------------

const DEDUCTION_APPROVABLE = [...DEDUCTION_PENDING_STATUSES, DEDUCTION_STATUS.PENDING_WAIVE_APPROVAL];

const deductionGuardSelect = {
  id: true,
  employeeId: true,
  amount: true,
  status: true,
  payrollMonth: true,
  isLinkedToPayroll: true,
} as const;

/**
 * HR approves a manager-issued violation (optionally pricing it) or refuses a waive request:
 * pending -> DEDUCTED (due in the next payroll).
 */
export async function approveDeduction(
  tx: Tx,
  deductionId: string,
  user: AuthUser,
  opts: { amount?: number; ipAddress?: string | null } = {},
) {
  requireRole(user, ROLE_GROUPS.PAYROLL);
  const amount = opts.amount !== undefined ? roundMoney(opts.amount) : undefined;
  if (amount !== undefined && (!Number.isFinite(amount) || amount < 0)) throw badRequest('مبلغ الخصم غير صالح');
  // Article 70 cap applies to the final amount, whichever approval path is used.
  const current = await tx.deduction.findUnique({
    where: { id: deductionId },
    select: { amount: true, employee: { select: { basicSalary: true, allowances: { where: { isMonthly: true }, select: { name: true, amount: true, isMonthly: true } } } } },
  });
  if (!current) throw notFound('المخالفة غير موجودة');
  assertWithinPenaltyCap(amount ?? current.amount, dailyRate(current.employee));
  const res = await tx.deduction.updateMany({
    where: { id: deductionId, status: { in: DEDUCTION_APPROVABLE }, isLinkedToPayroll: false },
    data: {
      status: DEDUCTION_STATUS.DEDUCTED,
      approvedBy: user.name,
      approvedAt: new Date(),
      ...(amount !== undefined ? { amount, hasFinancialImpact: amount > 0 } : {}),
    },
  });
  if (res.count === 0) {
    await guardFailed(tx.deduction.findUnique({ where: { id: deductionId }, select: { id: true } }), 'تمت معالجة هذه المخالفة مسبقاً');
  }
  const d = await tx.deduction.findUniqueOrThrow({ where: { id: deductionId } });
  await logAudit(
    { userId: user.id, action: 'APPROVE', entityType: 'DEDUCTION', entityId: deductionId, details: { status: d.status, amount: d.amount }, ipAddress: opts.ipAddress },
    tx,
  );
  return d;
}

/** HR refuses a manager-issued violation (-> REJECTED) or accepts a waive request (-> WAIVED). */
export async function rejectDeduction(tx: Tx, deductionId: string, user: AuthUser, reason?: string | null, ctx: FinanceCtx = {}) {
  requireRole(user, ROLE_GROUPS.PAYROLL);
  const current = await tx.deduction.findUnique({ where: { id: deductionId }, select: deductionGuardSelect });
  if (!current) throw notFound();
  const isWaiveRequest = current.status === DEDUCTION_STATUS.PENDING_WAIVE_APPROVAL;
  const next = isWaiveRequest ? DEDUCTION_STATUS.WAIVED : DEDUCTION_STATUS.REJECTED;
  const res = await tx.deduction.updateMany({
    where: { id: deductionId, status: { in: DEDUCTION_APPROVABLE }, isLinkedToPayroll: false },
    data: { status: next, approvedBy: user.name, approvedAt: new Date() },
  });
  if (res.count === 0) throw conflict('تمت معالجة هذه المخالفة مسبقاً');
  await releaseDeductionFromDraft(tx, current);
  const d = await tx.deduction.findUniqueOrThrow({ where: { id: deductionId } });
  await logAudit(
    { userId: user.id, action: 'REJECT', entityType: 'DEDUCTION', entityId: deductionId, details: { status: next, reason: reason ?? null }, ipAddress: ctx.ipAddress },
    tx,
  );
  return d;
}

/** HR waives a penalty completely (any state except already deducted in an approved payroll). */
export async function waiveDeduction(tx: Tx, deductionId: string, user: AuthUser, ctx: FinanceCtx = {}) {
  requireRole(user, ROLE_GROUPS.PAYROLL);
  const current = await tx.deduction.findUnique({ where: { id: deductionId }, select: deductionGuardSelect });
  if (!current) throw notFound();
  if (current.isLinkedToPayroll) throw conflict('لا يمكن إسقاط المخالفة لأنها خُصمت في مسير رواتب معتمد');
  const res = await tx.deduction.updateMany({
    where: {
      id: deductionId,
      isLinkedToPayroll: false,
      status: { notIn: [DEDUCTION_STATUS.WAIVED, DEDUCTION_STATUS.REJECTED] },
    },
    data: { status: DEDUCTION_STATUS.WAIVED, approvedBy: user.name, approvedAt: new Date() },
  });
  if (res.count === 0) throw conflict('المخالفة مُسقطة أو مرفوضة مسبقاً');
  await releaseDeductionFromDraft(tx, current);
  const d = await tx.deduction.findUniqueOrThrow({ where: { id: deductionId } });
  await logAudit(
    { userId: user.id, action: 'UPDATE', entityType: 'DEDUCTION', entityId: deductionId, details: { status: DEDUCTION_STATUS.WAIVED }, ipAddress: ctx.ipAddress },
    tx,
  );
  return d;
}

// ---------------------------------------------------------------------------
// Settlements
// ---------------------------------------------------------------------------

function safeDecrypt(v: string | null | undefined): string | null {
  try {
    return decryptField(v);
  } catch {
    return null;
  }
}

/**
 * Key of the loans deduction recorded in the settlement's CREATE audit entry (POST /api/settlements).
 * Only read for settlements created before Settlement.loansDeduction existed.
 */
export const SETTLEMENT_LOANS_AUDIT_KEY = 'loansDeduction';

/** LEGACY: loans deduction recorded in the CREATE audit entry (null when absent). */
async function auditLoansDeduction(tx: Tx, settlementId: string): Promise<number | null> {
  const entry = await tx.auditLog.findFirst({
    where: { entityType: 'SETTLEMENT', entityId: settlementId, action: 'CREATE' },
    orderBy: { createdAt: 'asc' },
    select: { details: true },
  });
  if (!entry?.details) return null;
  try {
    const parsed: unknown = JSON.parse(entry.details);
    const v = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>)[SETTLEMENT_LOANS_AUDIT_KEY] : undefined;
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** Loans deduction the settlement was created with: the column, else the legacy audit entry. */
async function recordedLoansDeduction(tx: Tx, settlement: { id: string; loansDeduction: number | null }): Promise<number | null> {
  if (settlement.loansDeduction !== null && Number.isFinite(settlement.loansDeduction)) return settlement.loansDeduction;
  return auditLoansDeduction(tx, settlement.id);
}

interface SettlementForApproval {
  id: string;
  employeeId: string;
  type: string;
  totalSettlement: number | null;
  additionalEntitlements: number | null;
  additionalDeductions: number | null;
  loansDeduction: number | null;
  overtimeAmount: number | null;
}

/**
 * Overtime re-check at owner approval, for END_OF_SERVICE settlements created with
 * Settlement.overtimeAmount (after the drafts from the last month were dropped). The settlement
 * pays exactly what overtimeDueInSettlement selects now:
 * - overtime it reserved that a payroll paid meanwhile (the draft holding it was approved) is
 *   released (paidInSettlementId = null) and subtracted,
 * - overtime approved since the creation that no payroll will pay is reserved and added.
 * Returns the amount difference (added - released).
 */
async function settleOvertime(tx: Tx, settlement: SettlementForApproval, lastDay: Date): Promise<{ adjustment: number; released: number; added: number }> {
  const legacyCutoff = await overtimeLegacyCutoff();
  const [employee, settings] = await Promise.all([
    tx.employee.findUniqueOrThrow({
      where: { id: settlement.employeeId },
      select: {
        basicSalary: true,
        // Recurring allowances + company cost setting: the overtime hourly basis (payroll-core).
        allowances: { where: { isMonthly: true }, select: { amount: true, isMonthly: true } },
        ...OVERTIME_BASIS_SELECT,
        overtimeRequests: {
          where: {
            status: 'APPROVED',
            date: { lte: lastDay },
            OR: [{ paidInSettlementId: null }, { paidInSettlementId: settlement.id }],
          },
          select: { id: true, date: true, type: true, hours: true, amount: true, updatedAt: true, paidInPayrollId: true, paidInSettlementId: true },
        },
        payrolls: {
          where: { status: { in: [PAYROLL_STATUS.APPROVED, PAYROLL_STATUS.PAID] } },
          select: { month: true, year: true, createdAt: true },
        },
      },
    }),
    loadPayrollSettings(tx),
  ]);
  const holders = await overtimeHolders(tx, employee.overtimeRequests.map((o) => o.paidInPayrollId));
  const release: string[] = [];
  const add: string[] = [];
  let released = 0;
  let added = 0;
  // The settlement is not approved yet: its overtime delta uses the company's current setting.
  const basis = overtimeBasisForEmployee(employee);
  for (const ot of employee.overtimeRequests) {
    const due = overtimeDueInSettlement(ot, employee.payrolls, lastDay, { legacyCutoff, holders, settlementId: settlement.id });
    const reserved = ot.paidInSettlementId === settlement.id;
    if (reserved && !due) {
      release.push(ot.id);
      released = roundMoney(released + overtimeAmount(ot, employee, settings, basis));
    } else if (!reserved && due) {
      add.push(ot.id);
      added = roundMoney(added + overtimeAmount(ot, employee, settings, basis));
    }
  }
  if (release.length) {
    await tx.overtimeRequest.updateMany({ where: { id: { in: release }, paidInSettlementId: settlement.id }, data: { paidInSettlementId: null } });
  }
  if (add.length) {
    const res = await tx.overtimeRequest.updateMany({
      where: { id: { in: add }, paidInSettlementId: null },
      data: { paidInSettlementId: settlement.id },
    });
    if (res.count !== add.length) throw conflict('تغيّرت طلبات العمل الإضافي للموظف أثناء الاعتماد، يرجى المحاولة مجدداً');
  }
  // A settlement never pays more overtime back than it recorded.
  const adjustment = roundMoney(added - Math.min(released, settlement.overtimeAmount ?? 0));
  return { adjustment, released, added };
}

/**
 * Settlement approval side effects on payroll, loans and overtime, in a deterministic order:
 * 1. drafts from the last working month onwards are dropped (END_OF_SERVICE: that month is paid
 *    by the settlement; LEAVE_SETTLEMENT: they must be regenerated to exclude the settled days);
 *    their overtime reservations are released;
 * 2. loans are paid off except the installments held by the remaining (earlier) drafts;
 * 3. the loans deduction is recomputed with the same formula as at creation
 *    (outstandingLoansForSettlement) and compared with Settlement.loansDeduction (legacy rows:
 *    the CREATE audit entry); the difference (installments payroll collected in between, loans
 *    that changed) adjusts additionalDeductions / total;
 * 4. END_OF_SERVICE: the overtime is re-checked (settleOvertime) and the difference adjusts
 *    additionalEntitlements / overtimeAmount / total.
 */
async function settleLoansOvertimeAndDrafts(
  tx: Tx,
  settlement: SettlementForApproval,
  lastDay: Date,
  user: AuthUser,
  ctx: FinanceCtx,
): Promise<{ totalSettlement: number; loansDeduction: number; loansAdjustment: number; overtimeAdjustment: number }> {
  const { year, month } = monthOf(lastDay);
  await releaseEmployeeDraftsFrom(tx, settlement.employeeId, year, month);
  const { collected } = await settleEmployeeLoans(tx, settlement.employeeId, user, ctx);

  const data: Prisma.SettlementUpdateInput = {};
  let totalSettlement = roundMoney(settlement.totalSettlement ?? 0);

  let loansAdjustment = 0;
  const recorded = await recordedLoansDeduction(tx, settlement);
  if (recorded !== null) {
    loansAdjustment = roundMoney(recorded - collected);
    data.loansDeduction = collected;
    if (Math.abs(loansAdjustment) >= 0.01) {
      totalSettlement = roundMoney(totalSettlement + loansAdjustment);
      data.additionalDeductions = Math.max(0, roundMoney((settlement.additionalDeductions ?? 0) - loansAdjustment));
    }
  }

  let overtimeAdjustment = 0;
  if (settlement.type === 'END_OF_SERVICE' && settlement.overtimeAmount !== null) {
    overtimeAdjustment = (await settleOvertime(tx, settlement, lastDay)).adjustment;
    if (Math.abs(overtimeAdjustment) >= 0.01) {
      totalSettlement = roundMoney(totalSettlement + overtimeAdjustment);
      data.overtimeAmount = Math.max(0, roundMoney(settlement.overtimeAmount + overtimeAdjustment));
      data.additionalEntitlements = Math.max(0, roundMoney((settlement.additionalEntitlements ?? 0) + overtimeAdjustment));
    }
  }

  if (Math.abs(loansAdjustment) >= 0.01 || Math.abs(overtimeAdjustment) >= 0.01) data.totalSettlement = totalSettlement;
  if (Object.keys(data).length) await tx.settlement.update({ where: { id: settlement.id }, data });
  return { totalSettlement, loansDeduction: collected, loansAdjustment, overtimeAdjustment };
}

/**
 * Owner approval: PENDING_APPROVAL -> OWNER_APPROVED. Resets the leave accrual, terminates the
 * employee (END_OF_SERVICE) and deactivates their login in the same transaction
 * (deactivateEmployeeUser, honouring SystemSetting terminated_access_days), drops draft payrolls from the last working month, pays off the
 * loans and re-checks the overtime (settleLoansOvertimeAndDrafts, which may adjust the total)
 * and creates exactly one PaymentRequest for finance with the final total.
 */
export async function approveSettlement(tx: Tx, settlementId: string, user: AuthUser, notes?: string | null, ctx: FinanceCtx = {}) {
  requireRole(user, ROLE_GROUPS.OWNER);
  const res = await tx.settlement.updateMany({
    where: { id: settlementId, status: SETTLEMENT_STATUS.PENDING_APPROVAL },
    data: { status: SETTLEMENT_STATUS.OWNER_APPROVED, ...(notes !== undefined ? { ownerNotes: notes } : {}) },
  });
  if (res.count === 0) {
    await guardFailed(
      tx.settlement.findUnique({ where: { id: settlementId }, select: { id: true } }),
      'تم اتخاذ قرار بشأن هذه التصفية مسبقاً',
    );
  }
  const settlement = await tx.settlement.findUniqueOrThrow({
    where: { id: settlementId },
    include: {
      employee: { select: { id: true, firstNameArabic: true, lastNameArabic: true, employeeId: true, bankName: true, ibanNumber: true } },
    },
  });
  const emp = settlement.employee;

  const lastDay = settlement.lastWorkingDate ?? today();
  // The accrued leave balance was paid in this settlement.
  await tx.employee.update({ where: { id: emp.id }, data: { leaveAccrualStartDate: today() } });
  let access: DeactivateResult | null = null;
  let exitRecorded: ReturnType<typeof exitFieldsForTermination> = null;
  if (settlement.type === 'END_OF_SERVICE') {
    await tx.employee.update({
      where: { id: emp.id },
      data: { employmentStatus: 'EXCLUDED', isTerminated: true, terminationDate: lastDay },
    });
    // Structured exit (workforce engine): prefilled from the settlement reason, but a reason HR
    // already recorded on the employee file is never overwritten (guarded by exitReason: null).
    const exit = exitFieldsForTermination(settlement.terminationReason);
    if (exit) {
      const set = await tx.employee.updateMany({ where: { id: emp.id, exitReason: null }, data: exit });
      if (set.count > 0) exitRecorded = exit;
    }
    // DEC-002: the terminated employee's login stops working (same transaction; honours the
    // terminated_access_days grace period, default 0 = immediate, sessions revoked).
    access = await deactivateEmployeeUser(tx, emp.id, {
      reason: `اعتماد تصفية نهاية الخدمة ${settlementId}`,
      actorId: user.id,
      ipAddress: ctx.ipAddress ?? null,
    });
  }
  const effects = await settleLoansOvertimeAndDrafts(tx, settlement, lastDay, user, ctx);

  const existingPayment = await tx.paymentRequest.findFirst({
    where: { entityType: 'SETTLEMENT', entityId: settlementId, status: { not: 'RETURNED' } },
    select: { id: true },
  });
  if (!existingPayment) {
    await tx.paymentRequest.create({
      data: {
        title: `تصفية مستحقات - ${emp.firstNameArabic} ${emp.lastNameArabic}`,
        reason: `اعتماد تصفية مستحقات. رقم الموظف: ${emp.employeeId}`,
        amount: Math.max(0, effects.totalSettlement),
        accountNumber: `تحويل بنكي | بنك: ${emp.bankName || '-'} | آيبان: ${safeDecrypt(emp.ibanNumber) || '-'}`,
        status: 'PENDING_FINANCE',
        requestedById: user.id,
        approvedById: user.id,
        entityId: settlement.id,
        entityType: 'SETTLEMENT',
      },
    });
  }

  await logAudit(
    {
      userId: user.id,
      action: 'APPROVE',
      entityType: 'SETTLEMENT',
      entityId: settlementId,
      details: {
        status: SETTLEMENT_STATUS.OWNER_APPROVED,
        total: effects.totalSettlement,
        loansDeduction: effects.loansDeduction,
        loansAdjustment: effects.loansAdjustment,
        overtimeAdjustment: effects.overtimeAdjustment,
        userDeactivated: access?.deactivated ?? false,
        accessGraceDays: access?.graceDays ?? 0,
        exitReasonRecorded: exitRecorded?.exitReason ?? null,
        exitVoluntaryRecorded: exitRecorded?.exitVoluntary ?? null,
        notes: notes ?? null,
      },
      ipAddress: ctx.ipAddress,
    },
    tx,
  );
  return tx.settlement.findUniqueOrThrow({ where: { id: settlementId } });
}

/**
 * Owner rejection: PENDING_APPROVAL -> REJECTED (no side effects on the employee). The overtime
 * the settlement reserved is released so payroll can pay it.
 */
export async function rejectSettlement(tx: Tx, settlementId: string, user: AuthUser, notes?: string | null, ctx: FinanceCtx = {}) {
  requireRole(user, ROLE_GROUPS.OWNER);
  const res = await tx.settlement.updateMany({
    where: { id: settlementId, status: SETTLEMENT_STATUS.PENDING_APPROVAL },
    data: { status: SETTLEMENT_STATUS.REJECTED, ...(notes !== undefined ? { ownerNotes: notes } : {}) },
  });
  if (res.count === 0) {
    await guardFailed(
      tx.settlement.findUnique({ where: { id: settlementId }, select: { id: true } }),
      'تم اتخاذ قرار بشأن هذه التصفية مسبقاً',
    );
  }
  const releasedOvertime = await tx.overtimeRequest.updateMany({
    where: { paidInSettlementId: settlementId },
    data: { paidInSettlementId: null },
  });
  await logAudit(
    {
      userId: user.id,
      action: 'REJECT',
      entityType: 'SETTLEMENT',
      entityId: settlementId,
      details: { notes: notes ?? null, releasedOvertime: releasedOvertime.count },
      ipAddress: ctx.ipAddress,
    },
    tx,
  );
  return tx.settlement.findUniqueOrThrow({ where: { id: settlementId } });
}

/**
 * Finance confirms the transfer: OWNER_APPROVED -> PAID. The linked PaymentRequest is marked
 * PAID too; a LEAVE_SETTLEMENT puts the employee ON_LEAVE.
 */
export async function markSettlementPaid(tx: Tx, settlementId: string, receiptUrl: string | null, user: AuthUser, ctx: FinanceCtx = {}) {
  requireRole(user, ROLE_GROUPS.FINANCE);
  const res = await tx.settlement.updateMany({
    where: { id: settlementId, status: SETTLEMENT_STATUS.OWNER_APPROVED },
    data: { status: SETTLEMENT_STATUS.PAID, ...(receiptUrl ? { transferReceiptUrl: receiptUrl } : {}) },
  });
  if (res.count === 0) {
    await guardFailed(
      tx.settlement.findUnique({ where: { id: settlementId }, select: { id: true } }),
      'لا يمكن تأكيد الصرف: التصفية غير معتمدة من صاحب العمل أو تم صرفها مسبقاً',
    );
  }
  const settlement = await tx.settlement.findUniqueOrThrow({ where: { id: settlementId } });
  // Maker-checker: whoever approved the payout (requestedById) may not also record it as paid.
  const openPayments = await tx.paymentRequest.findMany({
    where: { entityType: 'SETTLEMENT', entityId: settlementId, status: { in: ['PENDING_OWNER', 'PENDING_FINANCE'] } },
    select: { id: true, requestedById: true },
  });
  for (const payment of openPayments) {
    await enforceMakerChecker(tx, 'PAY', user, payment, ctx.ipAddress ?? null);
  }
  await tx.paymentRequest.updateMany({
    where: { id: { in: openPayments.map((p) => p.id) } },
    data: { status: 'PAID', paidById: user.id, ...(receiptUrl ? { receiptUrl } : {}) },
  });
  if (settlement.type === 'LEAVE_SETTLEMENT') {
    await tx.employee.update({ where: { id: settlement.employeeId }, data: { employmentStatus: 'ON_LEAVE' } });
  }
  await logAudit(
    { userId: user.id, action: 'UPDATE', entityType: 'SETTLEMENT', entityId: settlementId, details: { status: SETTLEMENT_STATUS.PAID, receiptUrl }, ipAddress: ctx.ipAddress },
    tx,
  );
  return settlement;
}
