// The payroll of one legal company for one month (ARC-PAY-A7; LIFECYCLE_MODEL §2.3; BL-PAY-006):
//
//   DRAFT ─generate─► CALCULATED ─approve (every line)─► APPROVED ─pay─► PAID
//
// generate is a SYSTEM operation triggered by a registered person; it writes only DRAFT lines and never
// changes an approved number. approve and pay are USER operations behind money.gateway and the L4 gate
// (assertNoBlockingDiscrepancies for that company and month), and never in one call (BL-PAY-008). The
// approver never approves his own line: it stays DRAFT, reserved for someone else, and the month is
// APPROVED only when every line is (BR-PAY-001 / BR-PAY-004 at month level until BL-PAY-008b). The
// payer is none of the approvers of the lines and of their inputs (BR-PAY-002). The employment gate
// (BL-PAY-025) holds the approval while an employment change is not reflected in the drafts.
//
// Concurrency: every transition moves PayrollMonth.version with a guarded updateMany (compare and
// swap): of two concurrent writers of the same month, one wins, the other gets 409. Idempotency: the
// user transitions run under their operation key (OperationLog): a repeat replays the first result.
import { markBonusesPaid, linkBonusesToPayroll } from '@/modules/compensation';
import { conflict, notFound } from '@/lib/http';
import { roundMoney } from '@/lib/money';
import { DEDUCTION_PAYABLE_STATUSES, LOAN_STATUS, PAYROLL_STATUS } from '@/lib/constants';
import { payrollMonthKey } from '@/lib/payroll-core';
import {
  assertNoBlockingDiscrepancies,
  assertTransactionClient,
  audit,
  emitEvent,
  idempotent,
  resolveOperatorMode,
  runMoneyOperation,
  type MoneyActor,
  type OperatorMode,
  type TxClient,
} from '@/modules/platform';
import { lockEmployees } from '@/modules/people';
import { linkOvertimeToPayroll } from '@/modules/time';
import { assertEmploymentGate } from '../gate';
import { PAYROLL_MONTH_STATUS } from '../policy';
import { GOSI_DEDUCTION_SET, PAYROLL_APPROVE, PAYROLL_GENERATE, PAYROLL_LINE_REGENERATE, PAYROLL_PAY } from '../operations';
import { releaseDraftLines } from './drafts';


const period = (year: number, month: number) => payrollMonthKey(year, month);

/** One generated DRAFT line (the stored columns of Payroll, computed by the generation). */
export interface GeneratedLine {
  id: string;
  employeeId: string;
  month: number;
  year: number;
  basicSalary: number;
  totalAllowances: number;
  totalDeductions: number;
  overtimeCost: number;
  netSalary: number;
  gosiEmployee: number;
  gosiEmployer: number;
  loansDeduction: number;
  violationsDeduction: number;
  leaveDeduction: number;
  otherDeductions: number;
  bonusAmount: number;
  housingAllowance?: number | null;
  transportAllowance?: number | null;
  otherAllowances?: number | null;
  needsReview: boolean;
  reviewNote: string | null;
  status: typeof PAYROLL_STATUS.DRAFT;
}

/** What a generation computed (outside the transaction, by src/lib/payroll.ts) and asks to commit. */
export interface GenerationPlan {
  companyId: string;
  year: number;
  month: number;
  /** Only these employees' lines are replaced (the payroll.employment consumer); omitted = the company's whole month. */
  employeeIds?: readonly string[];
  /** Employees the computation looked at (orphan installments of the month are cleared for them). */
  scopeEmployeeIds: readonly string[];
  supplementary: boolean;
  /** Non-DRAFT lines of (company, month) the computation saw: a change meanwhile means the month moved. */
  finalizedCount: number;
  /** The month's version the computation started from (compare and swap). */
  version: number;
  /** DRAFT lines the new ones replace. */
  replaceDraftIds: readonly string[];
  rows: readonly GeneratedLine[];
  installments: readonly { id: string; loanId: string; payrollId: string; month: number; year: number; amount: number }[];
  bonusReservations: readonly { payrollId: string; allowanceIds: readonly string[] }[];
  overtimeReservations: readonly { payrollId: string; overtimeIds: readonly string[] }[];
  /** Deductions the lines take whole: reserved for the month (linked on approval). */
  reservedDeductionIds: readonly string[];
  /** Deductions offered but not taken (they did not fit, BL-PAY-030): marked deferred, never reserved. */
  deferredDeductionIds: readonly string[];
}

export interface GenerationResult {
  payrollMonthId: string;
  status: string;
  version: number;
  created: number;
  replacedDrafts: number;
}

async function ensureMonth(tx: TxClient, companyId: string, year: number, month: number) {
  const found = await tx.payrollMonth.findUnique({ where: { companyId_year_month: { companyId, year, month } } });
  if (found) return found;
  return tx.payrollMonth.create({ data: { companyId, year, month, status: PAYROLL_MONTH_STATUS.DRAFT } });
}

/**
 * Commits a generation (or the consumer's regeneration of some employees) of one company's month:
 * drops the DRAFT lines it replaces (and their reservations), writes the new lines with their company
 * and month, installments, bonus / overtime / deduction reservations, and moves the month to
 * CALCULATED. Refuses (409) when the month moved since the computation (version, finalized lines).
 * Runs under its operation key: a repeat replays the first result.
 */
export async function commitPayrollGeneration(
  tx: TxClient,
  input: { plan: GenerationPlan; actor: MoneyActor | null; operationKey: string; regenerate?: boolean },
): Promise<GenerationResult & { replayed: boolean }> {
  assertTransactionClient(tx, 'commitPayrollGeneration');
  const { plan } = input;
  const op = input.regenerate ? PAYROLL_LINE_REGENERATE : PAYROLL_GENERATE;
  const outcome = await idempotent(tx, { key: input.operationKey, operation: op.name, actorId: input.actor?.id ?? null, companyId: plan.companyId }, (t) =>
    runMoneyOperation(t, op, { actor: input.actor, input: { companyId: plan.companyId, year: plan.year, month: plan.month }, operationKey: input.operationKey, companyId: plan.companyId }, async (w, info) => {
      // ADR-0002 #2 / ARCH-019: the employees written for are locked first, by ascending id.
      await lockEmployees(w, [...plan.scopeEmployeeIds, ...plan.rows.map((r) => r.employeeId)], 'ALL');
      const monthRow = await ensureMonth(w, plan.companyId, plan.year, plan.month);
      const moved = await w.payrollMonth.updateMany({ where: { id: monthRow.id, version: plan.version }, data: { version: { increment: 1 } } });
      if (moved.count === 0) throw conflict('تغيّر مسير هذا الشهر أثناء التوليد (توليد أو اعتماد آخر)، يرجى تحديث الصفحة والمحاولة مجدداً');
      const finalizedNow = await w.payroll.count({
        where: { companyId: plan.companyId, year: plan.year, month: plan.month, status: { not: PAYROLL_STATUS.DRAFT }, ...(plan.employeeIds ? { employeeId: { in: [...plan.employeeIds] } } : {}) },
      });
      if (finalizedNow !== plan.finalizedCount) throw conflict('تم اعتماد مسير هذا الشهر أثناء التوليد، يرجى تحديث الصفحة');

      const { deleted: replacedDrafts } = await releaseDraftLines(w, plan.replaceDraftIds, input.operationKey);
      if (plan.scopeEmployeeIds.length) {
        // Orphan installments of this month (their draft was deleted elsewhere), for the employees looked at.
        await w.loanInstallment.deleteMany({ where: { month: plan.month, year: plan.year, payrollId: null, loan: { employeeId: { in: [...plan.scopeEmployeeIds] } } } });
      }
      if (plan.rows.length) {
        await w.payroll.createMany({
          data: plan.rows.map((r) => ({ ...r, companyId: plan.companyId, payrollMonthId: monthRow.id, generatedById: info.actorUserId })),
        });
      }
      if (plan.installments.length) await w.loanInstallment.createMany({ data: [...plan.installments] });
      await linkBonusesToPayroll(w, { reservations: plan.bonusReservations, month: plan.month, year: plan.year, operationKey: input.operationKey });
      await linkOvertimeToPayroll(w, { reservations: plan.overtimeReservations, operationKey: input.operationKey });
      if (plan.reservedDeductionIds.length) {
        await w.deduction.updateMany({ where: { id: { in: [...plan.reservedDeductionIds] }, isLinkedToPayroll: false }, data: { payrollMonth: period(plan.year, plan.month) } });
      }
      if (plan.deferredDeductionIds.length) {
        // BL-PAY-030: a deduction the line could not fit is not this month's (no reservation, so the
        // approval never links it) and stays due for the next generated month (deferredPayrollMonth).
        const key = period(plan.year, plan.month);
        await w.deduction.updateMany({
          where: { id: { in: [...plan.deferredDeductionIds] }, isLinkedToPayroll: false, OR: [{ payrollMonth: null }, { payrollMonth: key }] },
          data: { payrollMonth: null, deferredPayrollMonth: key },
        });
      }
      const drafts = await w.payroll.count({ where: { payrollMonthId: monthRow.id, status: PAYROLL_STATUS.DRAFT } });
      const total = await w.payroll.count({ where: { payrollMonthId: monthRow.id } });
      const status = drafts > 0 || total === 0 ? PAYROLL_MONTH_STATUS.CALCULATED : monthRow.status === PAYROLL_MONTH_STATUS.PAID ? PAYROLL_MONTH_STATUS.PAID : PAYROLL_MONTH_STATUS.APPROVED;
      const after = await w.payrollMonth.update({
        where: { id: monthRow.id },
        data: { status, calculatedAt: new Date(), calculatedById: info.actorUserId },
        select: { id: true, status: true, version: true },
      });
      await audit(w, {
        actor: info.auditActor,
        action: op.name,
        entity: { type: 'PayrollMonth', id: monthRow.id, companyId: plan.companyId },
        before: { status: monthRow.status, version: monthRow.version },
        after: { status: after.status, version: after.version, created: plan.rows.length, replacedDrafts, employeeIds: plan.employeeIds ?? null, triggeredBy: input.actor?.id ?? null },
        operationKey: input.operationKey,
      });
      await emitEvent(w, {
        type: input.regenerate ? 'payroll.line.regenerated' : 'payroll.month.calculated',
        aggregateType: 'PayrollMonth',
        aggregateId: monthRow.id,
        idempotencyKey: `${input.operationKey}:${input.regenerate ? 'payroll.line.regenerated' : 'payroll.month.calculated'}`,
        payload: { payrollMonthId: monthRow.id, companyId: plan.companyId, year: plan.year, month: plan.month, lines: plan.rows.length, employeeIds: plan.employeeIds ?? null },
        companyId: plan.companyId,
        actorId: input.actor?.id ?? null,
      });
      return { payrollMonthId: monthRow.id, status: after.status, version: after.version, created: plan.rows.length, replacedDrafts };
    }),
  );
  return { ...outcome.result, replayed: outcome.replayed };
}

export interface MonthActInput {
  actor: MoneyActor;
  companyId: string;
  year: number;
  month: number;
  operationKey: string;
  ipAddress?: string | null;
  /** The tenant's operator mode when the caller already read it on the server (never a client value); else read here. */
  mode?: OperatorMode;
}

export interface ApproveMonthResult {
  count: number;
  payrollIds: string[];
  loansCompleted: number;
  /** Lines left DRAFT because they are the approver's own (BR-PAY-001): someone else approves them. */
  reservedEmployeeIds: string[];
  monthStatus: string;
  replayed: boolean;
}

type DraftLine = { id: string; employeeId: string; createdAt: Date };

/**
 * BL-PAY-030: the approval links a line's reserved deductions as collected, so it refuses (409) a line
 * that reserves deductions but records more deductions than it pays (a draft generated before
 * takeDeductions, whose net was clamped at 0): regenerating the month defers what does not fit. A line
 * of the current computation never trips it: it reserves a positive deduction only when it fits.
 */
async function assertDeductionsTaken(tx: TxClient, payrollIds: readonly string[], key: string): Promise<void> {
  if (!payrollIds.length) return;
  const rows = await tx.payroll.findMany({
    where: { id: { in: [...payrollIds] } },
    select: { employeeId: true, basicSalary: true, totalAllowances: true, overtimeCost: true, totalDeductions: true },
  });
  const short = rows.filter((r) => roundMoney(r.basicSalary + r.totalAllowances + r.overtimeCost - r.totalDeductions) < -0.005);
  if (!short.length) return;
  const reservedFor = await tx.deduction.findMany({
    where: { employeeId: { in: short.map((r) => r.employeeId) }, payrollMonth: key, isLinkedToPayroll: false, amount: { gt: 0 }, status: { in: [...DEDUCTION_PAYABLE_STATUSES] } },
    select: { employeeId: true },
    distinct: ['employeeId'],
  });
  if (reservedFor.length) {
    throw conflict(`${reservedFor.length} سطر في مسير ${key} يسجل خصومات أكثر مما يتسع له أجر الشهر (مسودة قديمة): يرجى إعادة توليد المسير قبل الاعتماد`);
  }
}

/**
 * Approves the DRAFT lines of a company's month (the approver's own line excepted), applying their
 * effects once: bonuses paid, the month's deductions linked, loan balances decremented (loan COMPLETED
 * at 0). `precheck` runs in the transaction before any write (the legacy settlement-coverage check).
 */
export async function approvePayrollMonth(
  tx: TxClient,
  input: MonthActInput & { precheck?: (tx: TxClient, drafts: readonly DraftLine[]) => Promise<void> },
): Promise<ApproveMonthResult> {
  assertTransactionClient(tx, 'approvePayrollMonth');
  const outcome = await idempotent(tx, { key: input.operationKey, operation: PAYROLL_APPROVE.name, actorId: input.actor.id, companyId: input.companyId }, async (t) => {
    const monthRow = await t.payrollMonth.findUnique({ where: { companyId_year_month: { companyId: input.companyId, year: input.year, month: input.month } } });
    const noDrafts = `لا توجد مسودات رواتب بانتظار الاعتماد لشهر ${input.month}/${input.year}`;
    if (!monthRow) throw conflict(noDrafts);
    await assertNoBlockingDiscrepancies(t, { operation: 'payroll.approve', companyId: input.companyId, period: period(input.year, input.month) });
    const drafts: DraftLine[] = await t.payroll.findMany({
      where: { payrollMonthId: monthRow.id, status: PAYROLL_STATUS.DRAFT },
      select: { id: true, employeeId: true, createdAt: true },
      orderBy: { id: 'asc' },
    });
    if (!drafts.length) throw conflict(noDrafts);
    await assertEmploymentGate(t, { year: input.year, month: input.month, employeeIds: drafts.map((d) => d.employeeId) });
    if (input.precheck) await input.precheck(t, drafts);

    const mode = input.mode ?? (await resolveOperatorMode(t));
    const own = input.actor.employeeId;
    // ENFORCED: the approver's own line is reserved for someone else. If it is the only one, the
    // gateway refuses the act (recorded as money.guard.blocked). SINGLE_OPERATOR: approved as a self-act.
    const others = mode === 'SINGLE_OPERATOR' || !own ? drafts : drafts.filter((d) => d.employeeId !== own);
    const toApprove = others.length ? others : drafts;
    const reserved = drafts.filter((d) => !toApprove.includes(d)).map((d) => d.employeeId);
    await assertDeductionsTaken(t, toApprove.map((d) => d.id), period(input.year, input.month));

    return runMoneyOperation(
      t,
      PAYROLL_APPROVE,
      { actor: input.actor, input: { companyId: input.companyId, year: input.year, month: input.month, lineEmployeeIds: toApprove.map((d) => d.employeeId) }, operationKey: input.operationKey, companyId: input.companyId, mode },
      async (w, info) => {
        // ADR-0002 #2 / ARCH-019: the employees of the approved lines are locked first, by ascending id.
        await lockEmployees(w, toApprove.map((d) => d.employeeId), 'ALL');
        const moved = await w.payrollMonth.updateMany({ where: { id: monthRow.id, version: monthRow.version }, data: { version: { increment: 1 } } });
        if (moved.count === 0) throw conflict('تم تعديل مسير الرواتب من مستخدم آخر أثناء الاعتماد، يرجى تحديث الصفحة والمحاولة مجدداً');
        const ids = toApprove.map((d) => d.id);
        const now = new Date();
        const res = await w.payroll.updateMany({
          where: { id: { in: ids }, status: PAYROLL_STATUS.DRAFT },
          data: { status: PAYROLL_STATUS.APPROVED, approvedById: input.actor.id, approvedAt: now },
        });
        if (res.count !== ids.length) throw conflict('تم تعديل مسير الرواتب من مستخدم آخر أثناء الاعتماد، يرجى تحديث الصفحة والمحاولة مجدداً');

        await markBonusesPaid(w, { payrollIds: ids, operationKey: input.operationKey });
        await w.deduction.updateMany({
          where: {
            employeeId: { in: toApprove.map((d) => d.employeeId) },
            payrollMonth: period(input.year, input.month),
            isLinkedToPayroll: false,
            status: { in: [...DEDUCTION_PAYABLE_STATUSES] },
          },
          data: { isLinkedToPayroll: true },
        });
        const installments = await w.loanInstallment.findMany({ where: { payrollId: { in: ids } }, select: { loanId: true, amount: true } });
        const perLoan = new Map<string, number>();
        for (const i of installments) perLoan.set(i.loanId, roundMoney((perLoan.get(i.loanId) ?? 0) + i.amount));
        for (const [loanId, amount] of [...perLoan].sort(([a], [b]) => a.localeCompare(b))) {
          await w.loan.update({ where: { id: loanId }, data: { remainingAmount: { decrement: amount } } });
        }
        let loansCompleted = 0;
        if (perLoan.size) {
          const done = await w.loan.updateMany({
            where: { id: { in: [...perLoan.keys()] }, remainingAmount: { lte: 0.009 }, isForgiven: false },
            data: { remainingAmount: 0, status: LOAN_STATUS.COMPLETED },
          });
          loansCompleted = done.count;
        }
        const left = await w.payroll.count({ where: { payrollMonthId: monthRow.id, status: PAYROLL_STATUS.DRAFT } });
        const monthStatus = left === 0 ? PAYROLL_MONTH_STATUS.APPROVED : PAYROLL_MONTH_STATUS.CALCULATED;
        await w.payrollMonth.update({
          where: { id: monthRow.id },
          data: left === 0 ? { status: monthStatus, approvedById: input.actor.id, approvedAt: now } : { status: monthStatus },
        });
        await audit(w, {
          actor: info.auditActor,
          action: PAYROLL_APPROVE.name,
          entity: { type: 'PayrollMonth', id: monthRow.id, companyId: input.companyId },
          before: { status: monthRow.status, drafts: drafts.length },
          after: { status: monthStatus, approved: ids.length, reservedEmployeeIds: reserved, loansCompleted },
          operationKey: input.operationKey,
          ipAddress: input.ipAddress ?? null,
          reason: info.selfAct ? `SELF_ACT_SINGLE_OPERATOR: ${info.reasons.join(',')}` : null,
        });
        const payload = { payrollMonthId: monthRow.id, companyId: input.companyId, year: input.year, month: input.month, approved: ids.length, reservedEmployeeIds: reserved, status: monthStatus };
        await emitEvent(w, {
          type: 'payroll.line.approved',
          aggregateType: 'PayrollMonth',
          aggregateId: monthRow.id,
          idempotencyKey: `${input.operationKey}:payroll.line.approved`,
          payload: { ...payload, payrollIds: ids },
          companyId: input.companyId,
          actorId: input.actor.id,
        });
        if (monthStatus === PAYROLL_MONTH_STATUS.APPROVED) {
          await emitEvent(w, {
            type: 'payroll.month.approved',
            aggregateType: 'PayrollMonth',
            aggregateId: monthRow.id,
            idempotencyKey: `${input.operationKey}:payroll.month.approved`,
            payload,
            companyId: input.companyId,
            actorId: input.actor.id,
          });
        }
        return { count: ids.length, payrollIds: ids, loansCompleted, reservedEmployeeIds: reserved, monthStatus };
      },
    );
  });
  return { ...outcome.result, replayed: outcome.replayed };
}

/**
 * APPROVED → PAID for a company's month (manual until BL-PAY-020 reconciles the signed bank file):
 * every line approved, no blocking discrepancy for the company and month, the payer none of the
 * approvers of the lines and their inputs (the gateway, BR-PAY-002).
 */
export async function markPayrollMonthPaid(tx: TxClient, input: MonthActInput): Promise<{ count: number; replayed: boolean }> {
  assertTransactionClient(tx, 'markPayrollMonthPaid');
  const outcome = await idempotent(tx, { key: input.operationKey, operation: PAYROLL_PAY.name, actorId: input.actor.id, companyId: input.companyId }, async (t) => {
    const monthRow = await t.payrollMonth.findUnique({ where: { companyId_year_month: { companyId: input.companyId, year: input.year, month: input.month } } });
    if (!monthRow || monthRow.status !== PAYROLL_MONTH_STATUS.APPROVED) {
      const drafts = monthRow ? await t.payroll.count({ where: { payrollMonthId: monthRow.id, status: PAYROLL_STATUS.DRAFT } }) : 0;
      throw conflict(
        drafts > 0
          ? `لا يمكن تسجيل صرف شهر ${input.month}/${input.year}: ${drafts} سطر لم يُعتمد بعد (منها سطر المعتمد نفسه إن وُجد، يعتمده شخص آخر)`
          : `لا يوجد مسير معتمد بانتظار الصرف لشهر ${input.month}/${input.year}`,
      );
    }
    await assertNoBlockingDiscrepancies(t, { operation: 'payroll.pay', companyId: input.companyId, period: period(input.year, input.month) });
    return runMoneyOperation(t, PAYROLL_PAY, { actor: input.actor, input: { companyId: input.companyId, year: input.year, month: input.month }, operationKey: input.operationKey, companyId: input.companyId, mode: input.mode }, async (w, info) => {
      const lineEmployees = await w.payroll.findMany({ where: { payrollMonthId: monthRow.id }, select: { employeeId: true } });
      await lockEmployees(w, lineEmployees.map((l) => l.employeeId), 'ALL'); // ADR-0002 #2
      const moved = await w.payrollMonth.updateMany({ where: { id: monthRow.id, version: monthRow.version, status: PAYROLL_MONTH_STATUS.APPROVED }, data: { version: { increment: 1 } } });
      if (moved.count === 0) throw conflict('تم تعديل مسير الرواتب من مستخدم آخر، يرجى تحديث الصفحة');
      const now = new Date();
      const res = await w.payroll.updateMany({ where: { payrollMonthId: monthRow.id, status: PAYROLL_STATUS.APPROVED }, data: { status: PAYROLL_STATUS.PAID, paidAt: now, paidById: input.actor.id } });
      if (res.count === 0) throw conflict(`لا يوجد مسير معتمد بانتظار الصرف لشهر ${input.month}/${input.year}`);
      await w.payrollMonth.update({ where: { id: monthRow.id }, data: { status: PAYROLL_MONTH_STATUS.PAID, paidAt: now, paidById: input.actor.id } });
      await audit(w, {
        actor: info.auditActor,
        action: PAYROLL_PAY.name,
        entity: { type: 'PayrollMonth', id: monthRow.id, companyId: input.companyId },
        before: { status: monthRow.status },
        after: { status: PAYROLL_MONTH_STATUS.PAID, lines: res.count },
        operationKey: input.operationKey,
        ipAddress: input.ipAddress ?? null,
        reason: info.selfAct ? `SELF_ACT_SINGLE_OPERATOR: ${info.reasons.join(',')}` : null,
      });
      await emitEvent(w, {
        type: 'payroll.month.paid',
        aggregateType: 'PayrollMonth',
        aggregateId: monthRow.id,
        idempotencyKey: `${input.operationKey}:payroll.month.paid`,
        payload: { payrollMonthId: monthRow.id, companyId: input.companyId, year: input.year, month: input.month, lines: res.count },
        companyId: input.companyId,
        actorId: input.actor.id,
      });
      return { count: res.count };
    });
  });
  return { ...outcome.result, replayed: outcome.replayed };
}

/** The employee's GOSI deduction edited in the file (payroll's projection column; never one's own). */
export async function setEmployeeGosiDeduction(
  tx: TxClient,
  input: { actor: MoneyActor; employeeId: string; gosiDeduction: number; before?: number | null; companyId?: string | null; operationKey: string; ipAddress?: string | null },
): Promise<{ employeeId: string; gosiDeduction: number; replayed: boolean }> {
  assertTransactionClient(tx, 'setEmployeeGosiDeduction');
  const value = roundMoney(input.gosiDeduction);
  const outcome = await idempotent(tx, { key: input.operationKey, operation: GOSI_DEDUCTION_SET.name, actorId: input.actor.id, companyId: input.companyId ?? null }, (t) =>
    runMoneyOperation(t, GOSI_DEDUCTION_SET, { actor: input.actor, input: { employeeId: input.employeeId }, operationKey: input.operationKey, companyId: input.companyId }, async (w, info) => {
      const res = await w.employee.updateMany({ where: { id: input.employeeId }, data: { gosiDeduction: value } });
      if (res.count === 0) throw notFound('الموظف غير موجود');
      await audit(w, {
        actor: info.auditActor,
        action: GOSI_DEDUCTION_SET.name,
        entity: { type: 'Employee', id: input.employeeId, companyId: input.companyId ?? null },
        before: { gosiDeduction: input.before ?? null },
        after: { gosiDeduction: value },
        operationKey: input.operationKey,
        ipAddress: input.ipAddress ?? null,
        reason: info.selfAct ? 'SELF_ACT_SINGLE_OPERATOR' : null,
      });
      await emitEvent(w, {
        type: 'payroll.gosiDeduction.changed',
        aggregateType: 'Employee',
        aggregateId: input.employeeId,
        idempotencyKey: `${input.operationKey}:payroll.gosiDeduction.changed`,
        payload: { employeeId: input.employeeId, gosiDeduction: value },
        companyId: input.companyId ?? null,
        actorId: input.actor.id,
      });
      return { employeeId: input.employeeId, gosiDeduction: value };
    }),
  );
  return { ...outcome.result, replayed: outcome.replayed };
}
