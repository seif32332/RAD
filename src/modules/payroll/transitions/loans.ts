// Loan transitions (pay-to-be §11 row 3, BR-PAY-017; BL-PAY-003): the sole writer of Loan behind
// money.gateway, with the person of every stage (BR-PAY-006) and an operation key per call.
//
//   PENDING ─manager─► MANAGER_APPROVED ─HR─► HR_APPROVED ─transfer─► FINANCE_TRANSFERRED ─review─► FINANCE_APPROVED
//   (owner may approve PENDING / MANAGER_APPROVED on behalf of manager + HR → HR_APPROVED)
//   REJECTED before the transfer; FORGIVEN (active loan); COMPLETED (paid by payroll or a settlement).
//
// Segregation (gateway): no approval step, transfer, review or forgiveness on one's own loan
// (BR-PAY-001); the transferring finance user is none of the manager / HR / owner approvers
// (BR-PAY-017, BR-PAY-002). Roles and the team scope of managers stay the caller's checks (authz).
import { conflict, notFound } from '@/lib/http';
import { roundMoney, sumMoney } from '@/lib/money';
import { LOAN_DEDUCTIBLE_STATUSES, LOAN_STATUS, PAYROLL_STATUS } from '@/lib/constants';
import { assertTransactionClient, audit, emitEvent, idempotent, runMoneyOperation, type MoneyActor, type MoneyOperation, type MoneyRunInfo, type TxClient } from '@/modules/platform';
import { LOAN_APPROVE, LOAN_CREATE, LOAN_FINANCE_REVIEW, LOAN_FORGIVE, LOAN_REJECT, LOAN_SETTLE, LOAN_TRANSFER, type LoanSubject } from '../operations';
import { loanStageRule, type LoanStage } from '../policy';
import { releaseLoanInstallmentsFromDrafts } from './drafts';

type LoanRow = Awaited<ReturnType<TxClient['loan']['findUniqueOrThrow']>>;

async function loanGuardFailed(w: TxClient, id: string, message: string): Promise<never> {
  const exists = await w.loan.findUnique({ where: { id }, select: { id: true } });
  if (!exists) throw notFound('طلب السلفة غير موجود');
  throw conflict(message);
}

async function recordLoan(w: TxClient, info: MoneyRunInfo, key: string, loan: LoanRow, verb: string, before: unknown, after: unknown, ipAddress?: string | null) {
  await audit(w, {
    actor: info.auditActor,
    action: info.operation,
    entity: { type: 'Loan', id: loan.id },
    before,
    after,
    operationKey: key,
    ipAddress: ipAddress ?? null,
    reason: info.selfAct ? `SELF_ACT_SINGLE_OPERATOR: ${info.reasons.join(',')}` : null,
  });
  await emitEvent(w, {
    type: `payroll.loan.${verb}`,
    aggregateType: 'Loan',
    aggregateId: loan.id,
    idempotencyKey: `${key}:payroll.loan.${verb}`,
    payload: { loanId: loan.id, employeeId: loan.employeeId, status: loan.status, remainingAmount: loan.remainingAmount },
    actorId: info.actorUserId,
  });
}

interface LoanActInput {
  actor: MoneyActor;
  loanId: string;
  operationKey: string;
  ipAddress?: string | null;
}

async function loanAct(tx: TxClient, op: MoneyOperation<LoanSubject>, input: LoanActInput, fn: (w: TxClient, info: MoneyRunInfo) => Promise<LoanRow>): Promise<LoanRow> {
  const outcome = await idempotent(tx, { key: input.operationKey, operation: op.name, actorId: input.actor.id }, (t) =>
    runMoneyOperation(t, op, { actor: input.actor, input: { loanId: input.loanId }, operationKey: input.operationKey }, fn),
  );
  return outcome.result;
}

export interface CreateLoanInput {
  actor: MoneyActor;
  employeeId: string;
  amount: number;
  monthlyInstallment: number;
  reason: string;
  operationKey: string;
  ipAddress?: string | null;
}

/** Files a loan (PENDING): the employee for himself, or payroll for an employee. */
export async function createLoan(tx: TxClient, input: CreateLoanInput): Promise<LoanRow> {
  assertTransactionClient(tx, 'createLoan');
  const outcome = await idempotent(tx, { key: input.operationKey, operation: LOAN_CREATE.name, actorId: input.actor.id }, (t) =>
    runMoneyOperation(t, LOAN_CREATE, { actor: input.actor, input: { employeeId: input.employeeId }, operationKey: input.operationKey }, async (w, info) => {
      const amount = roundMoney(input.amount);
      const loan = await w.loan.create({
        data: {
          employeeId: input.employeeId,
          amount,
          monthlyInstallment: roundMoney(input.monthlyInstallment),
          reason: input.reason,
          remainingAmount: amount,
          status: LOAN_STATUS.PENDING,
          createdById: input.actor.id,
        },
      });
      await recordLoan(w, info, input.operationKey, loan, 'created', null, { employeeId: loan.employeeId, amount: loan.amount, monthlyInstallment: loan.monthlyInstallment }, input.ipAddress);
      return loan;
    }),
  );
  return outcome.result;
}

/** One approval step (manager, HR, finance review, owner on behalf of manager + HR). */
export async function approveLoanStep(tx: TxClient, input: LoanActInput & { stage: LoanStage }): Promise<LoanRow> {
  assertTransactionClient(tx, 'approveLoanStep');
  const op = input.stage === 'FINANCE' ? LOAN_FINANCE_REVIEW : LOAN_APPROVE;
  return loanAct(tx, op, input, async (w, info) => {
    const rule = loanStageRule(input.stage, input.actor.id, new Date());
    const before = await w.loan.findUnique({ where: { id: input.loanId }, select: { status: true } });
    const res = await w.loan.updateMany({ where: { id: input.loanId, status: { in: [...rule.from] } }, data: rule.data });
    if (res.count === 0) await loanGuardFailed(w, input.loanId, 'تمت معالجة هذه المرحلة من طلب السلفة مسبقاً أو أن الطلب ليس في المرحلة الصحيحة');
    const loan = await w.loan.findUniqueOrThrow({ where: { id: input.loanId } });
    await recordLoan(w, info, input.operationKey, loan, 'approved', before, { stage: input.stage, status: loan.status }, input.ipAddress);
    return loan;
  });
}

/** Rejects a loan still pending, from the statuses the caller's role may reject. */
export async function rejectLoan(tx: TxClient, input: LoanActInput & { from: readonly string[]; reason?: string | null }): Promise<LoanRow> {
  assertTransactionClient(tx, 'rejectLoan');
  return loanAct(tx, LOAN_REJECT, input, async (w, info) => {
    const before = await w.loan.findUnique({ where: { id: input.loanId }, select: { status: true } });
    const res = await w.loan.updateMany({
      where: { id: input.loanId, status: { in: [...input.from] } },
      data: { status: LOAN_STATUS.REJECTED, rejectedById: input.actor.id, rejectedAt: new Date() },
    });
    if (res.count === 0) await loanGuardFailed(w, input.loanId, 'لا يمكن رفض السلفة: تمت معالجتها مسبقاً');
    const loan = await w.loan.findUniqueOrThrow({ where: { id: input.loanId } });
    await recordLoan(w, info, input.operationKey, loan, 'rejected', before, { status: loan.status, reason: input.reason ?? null }, input.ipAddress);
    return loan;
  });
}

/** Finance records the transfer with its receipt: HR_APPROVED → FINANCE_TRANSFERRED (legacy HR flag accepted). */
export async function markLoanTransferred(tx: TxClient, input: LoanActInput & { receiptUrl: string | null }): Promise<LoanRow> {
  assertTransactionClient(tx, 'markLoanTransferred');
  return loanAct(tx, LOAN_TRANSFER, input, async (w, info) => {
    const res = await w.loan.updateMany({
      where: {
        id: input.loanId,
        isFinanceTransferred: false,
        OR: [
          { status: LOAN_STATUS.HR_APPROVED },
          // Legacy rows: HR approval recorded only in the flag (old incoming-requests flow).
          { status: { in: [LOAN_STATUS.PENDING, LOAN_STATUS.MANAGER_APPROVED] }, isHrApproved: true },
        ],
      },
      data: { status: LOAN_STATUS.FINANCE_TRANSFERRED, isFinanceTransferred: true, financeTransferredAt: new Date(), receiptUrl: input.receiptUrl ?? null, transferredById: input.actor.id },
    });
    if (res.count === 0) await loanGuardFailed(w, input.loanId, 'لا يمكن تسجيل التحويل: السلفة لم تعتمد من الموارد البشرية أو تم تحويلها مسبقاً');
    const loan = await w.loan.findUniqueOrThrow({ where: { id: input.loanId } });
    await recordLoan(w, info, input.operationKey, loan, 'transferred', null, { status: loan.status, receiptUrl: input.receiptUrl }, input.ipAddress);
    return loan;
  });
}

/** The company forgives the remaining balance of an active loan; its DRAFT installments are released. */
export async function forgiveLoan(tx: TxClient, input: LoanActInput): Promise<LoanRow> {
  assertTransactionClient(tx, 'forgiveLoan');
  return loanAct(tx, LOAN_FORGIVE, input, async (w, info) => {
    const before = await w.loan.findUnique({ where: { id: input.loanId }, select: { remainingAmount: true, status: true } });
    if (!before) throw notFound();
    const res = await w.loan.updateMany({
      where: { id: input.loanId, isForgiven: false, remainingAmount: { gt: 0 }, status: { in: [...LOAN_DEDUCTIBLE_STATUSES] } },
      data: { isForgiven: true, remainingAmount: 0, status: LOAN_STATUS.FORGIVEN, forgivenById: input.actor.id },
    });
    if (res.count === 0) throw conflict('لا يمكن إسقاط السلفة: ليست سلفة نشطة أو تم إسقاطها/سدادها مسبقاً');
    await releaseLoanInstallmentsFromDrafts(w, input.loanId);
    const loan = await w.loan.findUniqueOrThrow({ where: { id: input.loanId } });
    await recordLoan(w, info, input.operationKey, loan, 'forgiven', before, { forgivenAmount: before.remainingAmount, status: loan.status }, input.ipAddress);
    return loan;
  });
}

export interface SettledLoan {
  id: string;
  collected: number;
  leftForPayroll: number;
}

/**
 * The settlement approval pays off an employee's active loans (after the drafts from the settlement's
 * last month on were dropped): what the remaining DRAFT lines hold stays on the loan for payroll to
 * collect; the rest is collected by the settlement; a loan with nothing held is COMPLETED at once.
 * SYSTEM effect of the settlement approval. Returns what the settlement collects.
 */
export async function settleLoansForSettlement(
  tx: TxClient,
  input: { employeeId: string; operationKey: string },
): Promise<{ count: number; collected: number; loans: SettledLoan[] }> {
  assertTransactionClient(tx, 'settleLoansForSettlement');
  return runMoneyOperation(tx, LOAN_SETTLE, { actor: null, input: { employeeId: input.employeeId }, operationKey: `${input.operationKey}:payroll.loans.settle` }, async (w, info) => {
    const loans = await w.loan.findMany({
      where: { employeeId: input.employeeId, isForgiven: false, remainingAmount: { gt: 0 }, status: { in: [...LOAN_DEDUCTIBLE_STATUSES] } },
      select: { id: true, remainingAmount: true, installments: { where: { payroll: { status: PAYROLL_STATUS.DRAFT } }, select: { amount: true } } },
      orderBy: { id: 'asc' },
    });
    const settled: SettledLoan[] = [];
    for (const l of loans) {
      const held = Math.min(l.remainingAmount, sumMoney(l.installments.map((i) => i.amount)));
      const collected = Math.max(0, roundMoney(l.remainingAmount - held));
      // Compare and swap on the balance read: a concurrent collection of the same loan loses (409).
      const guard = { id: l.id, isForgiven: false, remainingAmount: l.remainingAmount, status: { in: [...LOAN_DEDUCTIBLE_STATUSES] } };
      const res =
        held > 0.009
          ? await w.loan.updateMany({ where: guard, data: { remainingAmount: roundMoney(held) } })
          : await w.loan.updateMany({ where: guard, data: { remainingAmount: 0, status: LOAN_STATUS.COMPLETED } });
      if (res.count === 0) throw conflict('تغيّر رصيد السلفة أثناء اعتماد التصفية، يرجى المحاولة مجدداً');
      settled.push({ id: l.id, collected, leftForPayroll: roundMoney(held) });
    }
    if (settled.length) {
      await audit(w, {
        actor: info.auditActor,
        action: LOAN_SETTLE.name,
        entity: { type: 'Employee', id: input.employeeId },
        after: { settledBySettlement: settled },
        operationKey: input.operationKey,
      });
    }
    return { count: settled.length, collected: sumMoney(settled.map((s) => s.collected)), loans: settled };
  });
}
