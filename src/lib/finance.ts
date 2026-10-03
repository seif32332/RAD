// Financial workflows: loans, deductions (penalties) and settlements — the role and team checks of the
// screens, in front of the money writers (P1-PAY-A, ARCH-004):
//   - loans and deductions: src/modules/payroll transitions (behind money.gateway);
//   - payment requests: src/modules/finance transitions;
//   - settlements: the Settlement row is still written here (offboarding's table; it moves with P3-OFF),
//     each write inside its own registered gateway operation (settlement.*, listed legacy writers), and
//     the settlement's money effects go through their owners: payroll (drafts dropped, loans paid off),
//     time (overtime reservations), finance (the payment request), lifecycle (the exit) and offboarding
//     (the effect log, passed in as ctx.recordEffects: offboarding sits above payroll, §5.3).
//
// Every function runs inside a caller-provided transaction. The transitions are guarded (updateMany
// where status in [...]) and keyed (operation key: a repeat replays the first result; another user's
// second decision is a 409), so double clicks / concurrent requests never apply side effects twice.
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
import { paidAtDate, type SettlementPaymentProof } from '@/lib/settlement-payment';
import 'server-only';
import type { Prisma } from '@prisma/client';
import type { AuthUser } from '@/lib/auth';
import { logAudit } from '@/lib/audit';
import { decryptField } from '@/lib/crypto';
import { conflict, forbidden, notFound, badRequest } from '@/lib/http';
import { roundMoney } from '@/lib/money';
import { addDays, dateKey, today } from '@/lib/dates';
import {
  DEDUCTION_PENDING_STATUSES,
  DEDUCTION_STATUS,
  LOAN_IN_DECISION_STATUSES,
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
} from '@/lib/payroll';
import { monthOf } from '@/lib/settlement';
import { dailyRate } from '@/lib/payroll-core';
import { TERMINATION_TO_EXIT_REASON, type EmployeeExitReason } from '@/lib/workforce/reasons';
import * as payroll from '@/modules/payroll';
import { createPaymentRequest, payPaymentRequest } from '@/modules/finance';
import {
  assertNoBlockingDiscrepancies,
  decideMakerChecker,
  defineMoneyOperation,
  moneyActorOf,
  resolveOperatorMode,
  runMoneyOperation,
  type OperatorMode,
  type TxClient,
} from '@/modules/platform';
import { linkOvertimeToSettlement, unlinkOvertimeFromSettlement } from '@/modules/time';

/** Article 70: a single disciplinary deduction may not exceed five days' wage. */
export const MAX_PENALTY_DAYS = 5;

/** Throws 400 when a penalty amount exceeds five days' wage (Article 70). */
export function assertWithinPenaltyCap(amount: number, dailyWage: number): void {
  if (dailyWage > 0 && amount > roundMoney(dailyWage * MAX_PENALTY_DAYS) + 0.005) {
    throw badRequest(`لا يجوز أن يتجاوز الجزاء الواحد أجر ${MAX_PENALTY_DAYS} أيام (${roundMoney(dailyWage * MAX_PENALTY_DAYS)} ريال) وفق المادة 70 من نظام العمل`);
  }
}
import { assertCanManageEmployee } from '@/lib/hr-workflows';
import { resolveActor, scopedContext } from '@/modules/iam';
import { lifecycleCompanies, transitionEmploymentState, type TransitionOutcome } from '@/modules/lifecycle';
// Types only: offboarding sits above finance (§5.3); the approval gets the log writer from its caller.
import type { RecordSettlementEffects, SettlementEffectInput } from '@/modules/offboarding';

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

/** Optional request context: audit IP and the operation key (Idempotency-Key, else derived). */
export interface FinanceCtx {
  ipAddress?: string | null;
  operationKey?: string | null;
}

export type LoanStage = payroll.LoanStage;

function requireRole(user: AuthUser, group: readonly string[]): void {
  if (!roleIn(user.role, group)) throw forbidden();
}

/** The caller's key, else (transition, entity, user): a repeat by the same user replays, another user's is a new decision. */
function keyOf(ctx: FinanceCtx | undefined, ...parts: string[]): string {
  return ctx?.operationKey?.trim() || parts.join(':');
}

// ---------------------------------------------------------------------------
// Loans
// ---------------------------------------------------------------------------

const LOAN_STAGE_ROLES: Record<LoanStage, readonly string[]> = {
  MANAGER: [...new Set([...ROLE_GROUPS.MANAGERS, ...ROLE_GROUPS.PAYROLL])],
  HR: ROLE_GROUPS.PAYROLL,
  FINANCE: ROLE_GROUPS.PAYROLL,
  OWNER: ROLE_GROUPS.OWNER,
};

/** Loan statuses from which a stage applies (pure view of payroll's loanStageRule). */
export function loanStageFromStatuses(stage: LoanStage): readonly string[] {
  if (!LOAN_STAGE_ROLES[stage]) return [];
  return payroll.loanStageRule(stage, '-', new Date(0))?.from ?? [];
}

/** Branch / department managers (not HR / payroll / owner) act only on loans of their team. */
export function loanNeedsTeamScope(role: string | null | undefined): boolean {
  return !roleIn(role, ROLE_GROUPS.PAYROLL) && !roleIn(role, ROLE_GROUPS.OWNER);
}

/**
 * Loan statuses a rejection applies to (BL-PAY-027, F4): the in-decision statuses only, for every role.
 * An HR_APPROVED loan is decided and waits for the transfer: rejecting it is no longer possible (its
 * cancellation before the transfer is a later, two-person request, BL-WFE-012).
 */
export function loanRejectableStatuses(_role?: string | null): string[] {
  return [...LOAN_IN_DECISION_STATUSES];
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

/** Advances a loan one approval step (payroll.approveLoanStep; never on one's own loan). */
export async function approveLoanStep(tx: Tx, loanId: string, stage: LoanStage, user: AuthUser, ctx: FinanceCtx = {}) {
  const roles = LOAN_STAGE_ROLES[stage];
  if (!roles) throw badRequest('مرحلة اعتماد غير معروفة');
  requireRole(user, roles);
  await assertLoanScope(tx, loanId, user);
  return payroll.approveLoanStep(tx, { actor: moneyActorOf(user), loanId, stage, operationKey: keyOf(ctx, 'loan.approve', stage, loanId, user.id), ipAddress: ctx.ipAddress });
}

/**
 * Rejects a loan that is still pending (before the money is transferred). Branch / department
 * managers may only reject loans of their team that HR has not approved yet.
 */
export async function rejectLoan(tx: Tx, loanId: string, user: AuthUser, reason?: string | null, ctx: FinanceCtx = {}) {
  requireRole(user, [...new Set([...ROLE_GROUPS.MANAGERS, ...ROLE_GROUPS.PAYROLL])]);
  await assertLoanScope(tx, loanId, user);
  return payroll.rejectLoan(tx, { actor: moneyActorOf(user), loanId, from: loanRejectableStatuses(user.role), reason, operationKey: keyOf(ctx, 'loan.reject', loanId, user.id), ipAddress: ctx.ipAddress });
}

/** Finance attaches the transfer receipt: HR_APPROVED -> FINANCE_TRANSFERRED (not by an approver of the loan). */
export async function markLoanTransferred(tx: Tx, loanId: string, receiptUrl: string | null, user: AuthUser, ctx: FinanceCtx = {}) {
  requireRole(user, ROLE_GROUPS.FINANCE);
  return payroll.markLoanTransferred(tx, { actor: moneyActorOf(user), loanId, receiptUrl, operationKey: keyOf(ctx, 'loan.transfer', loanId, user.id), ipAddress: ctx.ipAddress });
}

/** Company forgives the remaining balance of an active loan. Draft payroll installments are released. */
export async function forgiveLoan(tx: Tx, loanId: string, user: AuthUser, ctx: FinanceCtx = {}) {
  requireRole(user, ROLE_GROUPS.PAYROLL);
  return payroll.forgiveLoan(tx, { actor: moneyActorOf(user), loanId, operationKey: keyOf(ctx, 'loan.forgive', loanId, user.id), ipAddress: ctx.ipAddress });
}

// ---------------------------------------------------------------------------
// Deductions (penalties)
// ---------------------------------------------------------------------------

const DEDUCTION_APPROVABLE = [...DEDUCTION_PENDING_STATUSES, DEDUCTION_STATUS.PENDING_WAIVE_APPROVAL];

const deductionActor = (user: AuthUser) => ({ ...moneyActorOf(user), name: user.name });

/**
 * HR approves a manager-issued violation (optionally pricing it) or refuses a waive request:
 * pending -> DEDUCTED (due in the next payroll). Never on one's own penalty.
 */
export async function approveDeduction(
  tx: Tx,
  deductionId: string,
  user: AuthUser,
  opts: { amount?: number; ipAddress?: string | null; operationKey?: string | null } = {},
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
  return payroll.approveDeduction(tx, {
    actor: deductionActor(user),
    deductionId,
    amount,
    from: DEDUCTION_APPROVABLE,
    operationKey: keyOf(opts, 'deduction.approve', deductionId, user.id, amount !== undefined ? String(amount) : '-'),
    ipAddress: opts.ipAddress,
  });
}

/** HR refuses a manager-issued violation (-> REJECTED) or accepts a waive request (-> WAIVED). */
export async function rejectDeduction(tx: Tx, deductionId: string, user: AuthUser, reason?: string | null, ctx: FinanceCtx = {}) {
  requireRole(user, ROLE_GROUPS.PAYROLL);
  return payroll.rejectDeduction(tx, { actor: deductionActor(user), deductionId, from: DEDUCTION_APPROVABLE, reason, operationKey: keyOf(ctx, 'deduction.reject', deductionId, user.id), ipAddress: ctx.ipAddress });
}

/** HR waives a penalty completely (any state except already deducted in an approved payroll). */
export async function waiveDeduction(tx: Tx, deductionId: string, user: AuthUser, ctx: FinanceCtx = {}) {
  requireRole(user, ROLE_GROUPS.PAYROLL);
  return payroll.waiveDeduction(tx, { actor: deductionActor(user), deductionId, operationKey: keyOf(ctx, 'deduction.waive', deductionId, user.id), ipAddress: ctx.ipAddress });
}

// ---------------------------------------------------------------------------
// Settlements (the Settlement row: offboarding's, listed legacy writer until P3-OFF)
// ---------------------------------------------------------------------------

interface SettlementSubject {
  settlementId: string;
}

async function settlementEmployee(tx: TxClient, input: SettlementSubject) {
  const s = await tx.settlement.findUnique({ where: { id: input.settlementId }, select: { employeeId: true } });
  return s ? [s.employeeId] : [];
}

/**
 * The owner's approval of a settlement (BR-PAY-012): never the settlement of the approver himself
 * (BR-PAY-001), and not by the HR user who created it. Writes the Settlement row and the leave accrual
 * start (the named source of §2 "settlement.approve يكتب leaveAccrualStartDate").
 */
export const SETTLEMENT_APPROVE = defineMoneyOperation<SettlementSubject>({
  name: 'settlement.approve',
  owner: 'offboarding',
  act: 'APPROVE',
  source: 'USER',
  writes: { Settlement: '*' },
  beneficiaries: settlementEmployee,
  legacySite: 'src/lib/finance.ts',
});

/** HR files a settlement (a request: the owner approves it); createdById recorded (BR-PAY-012). */
export const SETTLEMENT_CREATE = defineMoneyOperation<{ employeeId: string }>({
  name: 'settlement.create',
  owner: 'offboarding',
  act: 'REQUEST',
  source: 'USER',
  writes: { Settlement: '*' },
  legacySite: 'src/app/api/settlements/route.ts',
});

/** The owner's notes or finance's receipt on a settlement (no amount, no status). */
export const SETTLEMENT_NOTE = defineMoneyOperation<SettlementSubject>({
  name: 'settlement.note',
  owner: 'offboarding',
  act: 'REQUEST',
  source: 'USER',
  writes: { Settlement: ['ownerNotes', 'transferReceiptUrl'] },
  legacySite: 'src/app/api/settlements/route.ts',
});

/** The owner's rejection (the reserved overtime is released through time). */
export const SETTLEMENT_REJECT = defineMoneyOperation<SettlementSubject>({
  name: 'settlement.reject',
  owner: 'offboarding',
  act: 'REJECT',
  source: 'USER',
  writes: { Settlement: ['status', 'ownerNotes'] },
  legacySite: 'src/lib/finance.ts',
});

/** Finance records the payment: not the employee, not the creator nor the approver (BR-PAY-012). */
export const SETTLEMENT_PAY = defineMoneyOperation<SettlementSubject>({
  name: 'settlement.pay',
  owner: 'offboarding',
  act: 'PAY',
  source: 'USER',
  writes: { Settlement: ['status', 'transferReceiptUrl', 'paymentMethod', 'paymentReference', 'paidAt', 'paidById'] },
  beneficiaries: settlementEmployee,
  approvers: async (tx, input) => {
    const s = await tx.settlement.findUnique({ where: { id: input.settlementId }, select: { approvedById: true, createdById: true } });
    return s ? [s.approvedById, s.createdById] : [];
  },
  legacySite: 'src/lib/finance.ts',
});

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
 * The reservations are written by time (linkOvertimeToSettlement / unlinkOvertimeFromSettlement).
 * Returns the amount difference (added - released).
 */
async function settleOvertime(tx: Tx, settlement: SettlementForApproval, lastDay: Date, operationKey: string): Promise<{ adjustment: number; released: number; added: number }> {
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
  if (release.length) await unlinkOvertimeFromSettlement(tx, { settlementId: settlement.id, overtimeIds: release, operationKey });
  if (add.length) {
    await linkOvertimeToSettlement(tx, {
      settlementId: settlement.id,
      overtimeIds: add,
      operationKey,
      conflictMessage: 'تغيّرت طلبات العمل الإضافي للموظف أثناء الاعتماد، يرجى المحاولة مجدداً',
    });
  }
  // A settlement never pays more overtime back than it recorded.
  const adjustment = roundMoney(added - Math.min(released, settlement.overtimeAmount ?? 0));
  return { adjustment, released, added };
}

/**
 * Settlement approval side effects on payroll, loans and overtime, in a deterministic order:
 * 1. drafts from the last working month onwards are dropped (payroll.dropEmployeeDraftsFrom;
 *    END_OF_SERVICE: that month is paid by the settlement; LEAVE_SETTLEMENT: they must be regenerated
 *    to exclude the settled days); their overtime reservations are released;
 * 2. loans are paid off except the installments held by the remaining (earlier) drafts
 *    (payroll.settleLoansForSettlement);
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
  operationKey: string,
): Promise<{ totalSettlement: number; loansDeduction: number; loansAdjustment: number; overtimeAdjustment: number; data: Prisma.SettlementUpdateInput }> {
  const { year, month } = monthOf(lastDay);
  await payroll.dropEmployeeDraftsFrom(tx, { employeeId: settlement.employeeId, year, month, operationKey });
  const { collected } = await payroll.settleLoansForSettlement(tx, { employeeId: settlement.employeeId, operationKey });

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
    overtimeAdjustment = (await settleOvertime(tx, settlement, lastDay, operationKey)).adjustment;
    if (Math.abs(overtimeAdjustment) >= 0.01) {
      totalSettlement = roundMoney(totalSettlement + overtimeAdjustment);
      data.overtimeAmount = Math.max(0, roundMoney(settlement.overtimeAmount + overtimeAdjustment));
      data.additionalEntitlements = Math.max(0, roundMoney((settlement.additionalEntitlements ?? 0) + overtimeAdjustment));
    }
  }

  if (Math.abs(loansAdjustment) >= 0.01 || Math.abs(overtimeAdjustment) >= 0.01) data.totalSettlement = totalSettlement;
  // Written by approveSettlement together with the effect log (one settlement write).
  return { totalSettlement, loansDeduction: collected, loansAdjustment, overtimeAdjustment, data };
}

/**
 * What a settlement approval may change for the employee (BL-LCY-015 effect log, lcy-to-be.md
 * BR-LCY-014): loans, draft payrolls, overtime reservations, leave accrual start, employment
 * projections and the login. Read before and after the approval's effects.
 */
async function approvalSnapshot(tx: Tx, employeeId: string) {
  const [employee, loans, drafts, overtime] = await Promise.all([
    tx.employee.findUniqueOrThrow({
      where: { id: employeeId },
      select: {
        leaveAccrualStartDate: true,
        employmentState: true,
        isTerminated: true,
        terminationDate: true,
        exitReason: true,
        exitVoluntary: true,
        user: { select: { id: true, isActive: true, documentsOnlyUntil: true } },
      },
    }),
    tx.loan.findMany({ where: { employeeId }, select: { id: true, remainingAmount: true, status: true, isForgiven: true }, orderBy: { id: 'asc' } }),
    tx.payroll.findMany({ where: { employeeId, status: PAYROLL_STATUS.DRAFT }, select: { id: true, year: true, month: true }, orderBy: { id: 'asc' } }),
    tx.overtimeRequest.findMany({ where: { employeeId }, select: { id: true, paidInSettlementId: true }, orderBy: { id: 'asc' } }),
  ]);
  return { employee, loans, drafts, overtime };
}

type ApprovalSnapshot = Awaited<ReturnType<typeof approvalSnapshot>>;

/**
 * The effect log of the approval (SettlementEffect rows, BL-LCY-015): every changed value with its
 * before and after. Loans, overtime reservations and dropped drafts reference their row; the leave
 * accrual, the employment projections and the login reference the employee and are listed only when
 * they changed (the employment also when a state change was recorded); the payment request always.
 * Migration 9zd moved the former approvalEffects column with the same rules.
 */
function settlementEffects(
  employeeId: string,
  before: ApprovalSnapshot,
  after: ApprovalSnapshot,
  extra: { paymentRequestId: string | null; paymentRequestCreated: boolean; employment: TransitionOutcome | null },
): SettlementEffectInput[] {
  const out: SettlementEffectInput[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const loan = (l: ApprovalSnapshot['loans'][number]) => ({ remainingAmount: l.remainingAmount, status: l.status, isForgiven: l.isForgiven });
  const afterLoans = new Map(after.loans.map((l) => [l.id, l]));
  for (const b of before.loans) {
    const a = afterLoans.get(b.id);
    if (!a || !same(loan(a), loan(b))) out.push({ kind: 'LOAN', refId: b.id, before: loan(b), after: a ? loan(a) : null });
  }
  const afterOt = new Map(after.overtime.map((o) => [o.id, o.paidInSettlementId]));
  for (const o of before.overtime) {
    if (afterOt.has(o.id) && afterOt.get(o.id) !== o.paidInSettlementId) {
      out.push({ kind: 'OVERTIME', refId: o.id, before: { paidInSettlementId: o.paidInSettlementId }, after: { paidInSettlementId: afterOt.get(o.id) ?? null } });
    }
  }
  const kept = new Set(after.drafts.map((d) => d.id));
  for (const d of before.drafts) if (!kept.has(d.id)) out.push({ kind: 'PAYROLL_DRAFT', refId: d.id, before: { year: d.year, month: d.month }, after: null });
  const accrual = (x: ApprovalSnapshot['employee']) => ({ leaveAccrualStartDate: dateKey(x.leaveAccrualStartDate) });
  if (!same(accrual(before.employee), accrual(after.employee))) {
    out.push({ kind: 'LEAVE_ACCRUAL', refId: employeeId, before: accrual(before.employee), after: accrual(after.employee) });
  }
  if (extra.paymentRequestId) {
    out.push({ kind: 'PAYMENT_REQUEST', refId: extra.paymentRequestId, before: null, after: { paymentRequestId: extra.paymentRequestId, created: extra.paymentRequestCreated } });
  }
  const emp = (x: ApprovalSnapshot['employee']) => ({
    employmentState: x.employmentState,
    isTerminated: x.isTerminated,
    terminationDate: dateKey(x.terminationDate),
    exitReason: x.exitReason,
    exitVoluntary: x.exitVoluntary,
  });
  const changed = extra.employment?.changed ? extra.employment : null;
  if (changed || !same(emp(before.employee), emp(after.employee))) {
    out.push({
      kind: 'EMPLOYMENT',
      refId: employeeId,
      before: emp(before.employee),
      after: { ...emp(after.employee), stateChangeId: changed?.stateChangeId ?? null, transition: changed?.transition ?? null },
    });
  }
  const login = (x: ApprovalSnapshot['employee']) => (x.user ? { isActive: x.user.isActive, documentsOnlyUntil: x.user.documentsOnlyUntil?.toISOString() ?? null } : null);
  if (!same(login(before.employee), login(after.employee))) out.push({ kind: 'LOGIN', refId: employeeId, before: login(before.employee), after: login(after.employee) });
  return out;
}

/** The approval's context: the settlement effect log writer of offboarding (routes pass recordSettlementEffects). */
export interface SettlementApprovalCtx extends FinanceCtx {
  recordEffects: RecordSettlementEffects;
  /** The tenant's operator mode when the server already read it (never a client value); else read here. */
  mode?: OperatorMode;
}

/**
 * Owner approval: PENDING_APPROVAL -> OWNER_APPROVED (settlement.approve behind money.gateway: not
 * one's own settlement, not by its creator). Resets the leave accrual, exits the employee
 * (END_OF_SERVICE) through lifecycle.transitionEmploymentState (T1 / T3, or nothing for the same last
 * day; the login ends only when the employee becomes TERMINATED, with the terminated_access_days
 * grace), drops draft payrolls from the last working month, pays off the loans and re-checks the
 * overtime (settleLoansOvertimeAndDrafts, which may adjust the total), files exactly one
 * PaymentRequest for finance with the final total (requester = the HR creator, approver = the owner,
 * BR-PAY-012), and records every effect with its previous value (SettlementEffect rows through
 * ctx.recordEffects = offboarding.recordSettlementEffects, same transaction, BL-LCY-015) so a later
 * reversal (R1) can restore them. The L4 gate (settlement.approve, that employee) runs first.
 */
export async function approveSettlement(tx: Tx, settlementId: string, user: AuthUser, notes: string | null | undefined, ctx: SettlementApprovalCtx) {
  requireRole(user, ROLE_GROUPS.OWNER);
  const operationKey = keyOf(ctx, 'settlement.approve', settlementId);
  const head = await tx.settlement.findUnique({ where: { id: settlementId }, select: { employeeId: true, createdById: true, employee: { select: { legalCompanyId: true } } } });
  if (!head) throw notFound('التصفية غير موجودة');
  if (head.employee.legalCompanyId) {
    await assertNoBlockingDiscrepancies(tx, { operation: 'settlement.approve', companyId: head.employee.legalCompanyId, employeeIds: [head.employeeId] });
  }
  const actor = moneyActorOf(user);
  // The creator is not the approver (BR-PAY-012) in the tenant's operator mode (BL-PAY-027, RT-WFE-710):
  // ENFORCED refuses (SAME_PERSON_TWICE); SINGLE_OPERATOR lets the sole owner approve the settlement he
  // filed, recorded as SELF_ACT_SINGLE_OPERATOR by the gateway.
  const mode = ctx.mode ?? (await resolveOperatorMode(tx));
  const makerChecker = decideMakerChecker({ step: 'APPROVE', actor: { userId: actor.id, employeeId: actor.employeeId }, requestedById: head.createdById, mode });
  return runMoneyOperation(
    tx,
    SETTLEMENT_APPROVE,
    {
      actor,
      input: { settlementId },
      operationKey,
      companyId: head.employee.legalCompanyId,
      mode,
      decision: makerChecker,
    },
    async (w) => {
      const now = new Date();
      const res = await w.settlement.updateMany({
        where: { id: settlementId, status: SETTLEMENT_STATUS.PENDING_APPROVAL },
        data: { status: SETTLEMENT_STATUS.OWNER_APPROVED, approvedById: user.id, approvedAt: now, ...(notes !== undefined ? { ownerNotes: notes } : {}) },
      });
      if (res.count === 0) throw conflict('تم اتخاذ قرار بشأن هذه التصفية مسبقاً');
      const settlement = await w.settlement.findUniqueOrThrow({
        where: { id: settlementId },
        include: {
          employee: { select: { id: true, firstNameArabic: true, lastNameArabic: true, employeeId: true, bankName: true, ibanNumber: true, exitReason: true, exitVoluntary: true, legalCompanyId: true } },
        },
      });
      const emp = settlement.employee;
      const before = await approvalSnapshot(w, emp.id);

      const lastDay = settlement.lastWorkingDate ?? today();
      // The accrued leave balance was paid in this settlement. End of service: accrual restarts the day
      // after the last working day while it is still ahead (the employee works until then, BR-LCY-011).
      const accrualStart = settlement.type === 'END_OF_SERVICE' && lastDay.getTime() > today().getTime() ? addDays(lastDay, 1) : today();
      await w.employee.update({ where: { id: emp.id }, data: { leaveAccrualStartDate: accrualStart } });
      let employment: TransitionOutcome | null = null;
      if (settlement.type === 'END_OF_SERVICE') {
        // Structured exit: a reason already recorded on the employee is kept, else the settlement's.
        const exit = exitFieldsForTermination(settlement.terminationReason);
        const scope = await resolveActor(w, user);
        employment = await transitionEmploymentState(w, {
          employeeId: emp.id,
          command: 'EXIT',
          date: lastDay,
          exitReason: emp.exitReason ?? exit?.exitReason ?? null,
          exitVoluntary: emp.exitReason ? emp.exitVoluntary : (exit?.exitVoluntary ?? null),
          reason: `اعتماد تصفية نهاية الخدمة ${settlementId}`,
          source: { type: 'SETTLEMENT', id: settlementId },
          actor: { type: 'USER', id: user.id },
          operationKey: `settlement.approve:${settlementId}:employment`,
          companyIds: lifecycleCompanies(scopedContext(scope)),
          access: { ipAddress: ctx.ipAddress ?? null },
        });
      }
      const effects = await settleLoansOvertimeAndDrafts(w, settlement, lastDay, operationKey);

      const existingPayment = await w.paymentRequest.findFirst({
        where: { entityType: 'SETTLEMENT', entityId: settlementId, status: { not: 'RETURNED' } },
        select: { id: true },
      });
      let paymentRequestId = existingPayment?.id ?? null;
      if (!existingPayment) {
        const created = await createPaymentRequest(w, {
          actor,
          title: `تصفية مستحقات - ${emp.firstNameArabic} ${emp.lastNameArabic}`,
          reason: `اعتماد تصفية مستحقات. رقم الموظف: ${emp.employeeId}`,
          amount: Math.max(0, effects.totalSettlement),
          accountNumber: `تحويل بنكي | بنك: ${emp.bankName || '-'} | آيبان: ${safeDecrypt(emp.ibanNumber) || '-'}`,
          status: 'PENDING_FINANCE',
          // BR-PAY-012: the linked request's requester is the HR creator, its approver the owner.
          requestedById: settlement.createdById ?? null,
          approvedById: user.id,
          beneficiaryEmployeeId: emp.id,
          entityId: settlement.id,
          entityType: 'SETTLEMENT',
          companyId: emp.legalCompanyId,
          operationKey: `${operationKey}:paymentRequest`,
          ipAddress: ctx.ipAddress,
        });
        paymentRequestId = created.id;
      }

      const after = await approvalSnapshot(w, emp.id);
      await w.settlement.update({ where: { id: settlement.id }, data: effects.data });
      await ctx.recordEffects(w, {
        settlementId: settlement.id,
        effects: settlementEffects(emp.id, before, after, { paymentRequestId, paymentRequestCreated: !existingPayment, employment }),
      });
      const access = employment?.access ?? null;
      const exitRecorded = employment?.changed ? { exitReason: employment.exitReason, exitVoluntary: employment.exitVoluntary } : null;

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
        w,
      );
      return w.settlement.findUniqueOrThrow({ where: { id: settlementId } });
    },
  );
}

/**
 * Owner rejection: PENDING_APPROVAL -> REJECTED (no side effects on the employee). The overtime
 * the settlement reserved is released so payroll can pay it.
 */
export async function rejectSettlement(tx: Tx, settlementId: string, user: AuthUser, notes?: string | null, ctx: FinanceCtx = {}) {
  requireRole(user, ROLE_GROUPS.OWNER);
  const operationKey = keyOf(ctx, 'settlement.reject', settlementId, user.id);
  return runMoneyOperation(tx, SETTLEMENT_REJECT, { actor: moneyActorOf(user), input: { settlementId }, operationKey }, async (w) => {
    const res = await w.settlement.updateMany({
      where: { id: settlementId, status: SETTLEMENT_STATUS.PENDING_APPROVAL },
      data: { status: SETTLEMENT_STATUS.REJECTED, ...(notes !== undefined ? { ownerNotes: notes } : {}) },
    });
    if (res.count === 0) {
      const exists = await w.settlement.findUnique({ where: { id: settlementId }, select: { id: true } });
      if (!exists) throw notFound();
      throw conflict('تم اتخاذ قرار بشأن هذه التصفية مسبقاً');
    }
    const releasedOvertime = await unlinkOvertimeFromSettlement(w, { settlementId, operationKey });
    await logAudit(
      {
        userId: user.id,
        action: 'REJECT',
        entityType: 'SETTLEMENT',
        entityId: settlementId,
        details: { notes: notes ?? null, releasedOvertime: releasedOvertime.released },
        ipAddress: ctx.ipAddress,
      },
      w,
    );
    return w.settlement.findUniqueOrThrow({ where: { id: settlementId } });
  });
}

/**
 * Finance confirms the transfer: OWNER_APPROVED -> PAID, with the payment proof (method, reference,
 * actual day) the settlement statement's discharge refers to (settlement.pay behind money.gateway:
 * the payer is not the employee, the HR creator nor the approving owner, BR-PAY-012; the L4 gate of
 * that employee first). The linked PaymentRequest is paid too (finance.payPaymentRequest, same rules).
 * Paying a LEAVE_SETTLEMENT does not touch the employee: "on leave" is computed from the approved
 * Leave rows (BR-LCY-008, BL-LCY-002), and ON_LEAVE is never stored (EV-3016, EV-3017).
 */
export async function markSettlementPaid(
  tx: Tx,
  settlementId: string,
  receiptUrl: string | null,
  user: AuthUser,
  ctx: FinanceCtx = {},
  proof: SettlementPaymentProof,
) {
  requireRole(user, ROLE_GROUPS.FINANCE);
  const operationKey = keyOf(ctx, 'settlement.pay', settlementId, user.id);
  const head = await tx.settlement.findUnique({ where: { id: settlementId }, select: { employeeId: true, employee: { select: { legalCompanyId: true } } } });
  if (!head) throw notFound();
  if (head.employee?.legalCompanyId) {
    await assertNoBlockingDiscrepancies(tx, { operation: 'settlement.pay', companyId: head.employee.legalCompanyId, employeeIds: [head.employeeId] });
  }
  const actor = moneyActorOf(user);
  return runMoneyOperation(tx, SETTLEMENT_PAY, { actor, input: { settlementId }, operationKey, companyId: head.employee?.legalCompanyId ?? null }, async (w) => {
    const res = await w.settlement.updateMany({
      where: { id: settlementId, status: SETTLEMENT_STATUS.OWNER_APPROVED },
      data: {
        status: SETTLEMENT_STATUS.PAID,
        ...(receiptUrl ? { transferReceiptUrl: receiptUrl } : {}),
        paymentMethod: proof.paymentMethod,
        paymentReference: proof.paymentReference,
        paidAt: paidAtDate(proof.paidAt),
        paidById: user.id,
      },
    });
    if (res.count === 0) throw conflict('لا يمكن تأكيد الصرف: التصفية غير معتمدة من صاحب العمل أو تم صرفها مسبقاً');
    const settlement = await w.settlement.findUniqueOrThrow({ where: { id: settlementId } });
    const openPayments = await w.paymentRequest.findMany({
      where: { entityType: 'SETTLEMENT', entityId: settlementId, status: 'PENDING_FINANCE' },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    for (const payment of openPayments) {
      await payPaymentRequest(w, {
        actor,
        paymentRequestId: payment.id,
        receiptUrl: receiptUrl ?? settlement.transferReceiptUrl ?? `settlement:${settlementId}`,
        operationKey: `${operationKey}:payment:${payment.id}`,
        ipAddress: ctx.ipAddress,
      });
    }
    await logAudit(
      { userId: user.id, action: 'UPDATE', entityType: 'SETTLEMENT', entityId: settlementId, details: { status: SETTLEMENT_STATUS.PAID, receiptUrl, ...proof }, ipAddress: ctx.ipAddress },
      w,
    );
    return settlement;
  });
}
