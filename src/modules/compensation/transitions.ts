// compensation transitions (P1-PAY-A slice): the sole writer of Allowance and SalaryChange and of the
// Employee pay projection columns, each behind its money.gateway operation (./operations). The period
// model (CompensationPeriod through applyDecision, EmployeeFinancialChange as a request) is P1-PAY-B;
// these writers keep today's behaviour while guarding it (BR-PAY-001) and recording who did it.
//
// User transitions take an operation key (OperationLog: a repeat replays the result) and write audit +
// event in the caller's transaction. The bonus link writers are effects of payroll operations: they run
// under their own SYSTEM operation and are idempotent by nature (guarded updateMany).
import type { PaymentMethod } from '@prisma/client';
import { badRequest, conflict } from '@/lib/http';
import { roundMoney } from '@/lib/money';
import { assertTransactionClient, audit, emitEvent, idempotent, runMoneyOperation, type MoneyActor, type TxClient } from '@/modules/platform';
import { BONUS_CREATE, BONUS_PAYROLL_LINK, CHANGE_ORDER_APPLY, PAY_EDIT, PAY_INITIAL } from './operations';

const uniq = (ids: readonly string[]) => [...new Set(ids.filter(Boolean))];

// ---------------------------------------------------------------------------------------------------
// One-off bonuses
// ---------------------------------------------------------------------------------------------------

export interface CreateBonusInput {
  actor: MoneyActor;
  employeeId: string;
  name: string;
  amount: number;
  /** Payroll month that pays it (the caller skips months already approved). */
  payrollMonth: number;
  payrollYear: number;
  companyId?: string | null;
  operationKey: string;
  ipAddress?: string | null;
}

/** A one-off bonus (Allowance isMonthly=false), APPROVED by its creator until BL-PAY-007. */
export async function createBonus(tx: TxClient, input: CreateBonusInput) {
  assertTransactionClient(tx, 'createBonus');
  const amount = roundMoney(input.amount);
  if (!(amount > 0)) throw badRequest('يرجى إدخال مبلغ المكافأة');
  const outcome = await idempotent(tx, { key: input.operationKey, operation: BONUS_CREATE.name, actorId: input.actor.id, companyId: input.companyId ?? null }, (t) =>
    runMoneyOperation(t, BONUS_CREATE, { actor: input.actor, input: { employeeId: input.employeeId }, operationKey: input.operationKey, companyId: input.companyId }, async (w, info) => {
      const now = new Date();
      const row = await w.allowance.create({
        data: {
          employeeId: input.employeeId,
          name: input.name,
          amount,
          isMonthly: false, // مكافأة / بدل طارئ لمرة واحدة
          allowanceType: 'OTHER', // a one-off bonus is never a housing / transport / food allowance
          payrollMonth: input.payrollMonth,
          payrollYear: input.payrollYear,
          isPaid: false,
          status: 'APPROVED',
          createdById: input.actor.id,
          approvedById: input.actor.id,
          approvedAt: now,
        },
      });
      await audit(w, {
        actor: info.auditActor,
        action: BONUS_CREATE.name,
        entity: { type: 'Allowance', id: row.id, companyId: input.companyId ?? null },
        after: { employeeId: row.employeeId, amount: row.amount, payrollMonth: row.payrollMonth, payrollYear: row.payrollYear },
        operationKey: input.operationKey,
        ipAddress: input.ipAddress ?? null,
        reason: info.selfAct ? 'SELF_ACT_SINGLE_OPERATOR' : null,
      });
      await emitEvent(w, {
        type: 'compensation.bonus.created',
        aggregateType: 'Allowance',
        aggregateId: row.id,
        idempotencyKey: `${input.operationKey}:compensation.bonus.created`,
        payload: { allowanceId: row.id, employeeId: row.employeeId, amount: row.amount, month: row.payrollMonth, year: row.payrollYear },
        companyId: input.companyId ?? null,
        actorId: input.actor.id,
      });
      return row;
    }),
  );
  return outcome.result;
}

/** payroll.generate: the draft line `payrollId` reserves these unpaid bonuses (paid in `month/year`). */
export async function linkBonusesToPayroll(
  tx: TxClient,
  input: { reservations: readonly { payrollId: string; allowanceIds: readonly string[] }[]; month: number; year: number; operationKey: string },
): Promise<{ linked: number }> {
  assertTransactionClient(tx, 'linkBonusesToPayroll');
  const payrollIds = input.reservations.map((r) => r.payrollId);
  if (!input.reservations.some((r) => r.allowanceIds.length)) return { linked: 0 };
  return runMoneyOperation(tx, BONUS_PAYROLL_LINK, { actor: null, input: { payrollIds }, operationKey: `${input.operationKey}:bonus.link` }, async (t) => {
    let linked = 0;
    for (const r of input.reservations) {
      const ids = uniq(r.allowanceIds);
      if (!ids.length) continue;
      const res = await t.allowance.updateMany({
        where: { id: { in: ids }, isPaid: false },
        data: { paidInPayrollId: r.payrollId, payrollMonth: input.month, payrollYear: input.year },
      });
      linked += res.count;
    }
    return { linked };
  });
}

/** The draft lines are replaced or dropped: their unpaid bonuses are free again. */
export async function unlinkBonusesFromPayrolls(tx: TxClient, input: { payrollIds: readonly string[]; operationKey: string }): Promise<{ released: number }> {
  assertTransactionClient(tx, 'unlinkBonusesFromPayrolls');
  const payrollIds = uniq(input.payrollIds);
  if (!payrollIds.length) return { released: 0 };
  return runMoneyOperation(tx, BONUS_PAYROLL_LINK, { actor: null, input: { payrollIds }, operationKey: `${input.operationKey}:bonus.unlink` }, async (t) => {
    const res = await t.allowance.updateMany({ where: { paidInPayrollId: { in: payrollIds }, isPaid: false }, data: { paidInPayrollId: null } });
    return { released: res.count };
  });
}

/** The lines are approved: the bonuses they hold are paid (once: only unpaid rows move). */
export async function markBonusesPaid(tx: TxClient, input: { payrollIds: readonly string[]; operationKey: string }): Promise<{ paid: number }> {
  assertTransactionClient(tx, 'markBonusesPaid');
  const payrollIds = uniq(input.payrollIds);
  if (!payrollIds.length) return { paid: 0 };
  return runMoneyOperation(tx, BONUS_PAYROLL_LINK, { actor: null, input: { payrollIds }, operationKey: `${input.operationKey}:bonus.paid` }, async (t) => {
    const res = await t.allowance.updateMany({ where: { paidInPayrollId: { in: payrollIds }, isPaid: false }, data: { isPaid: true } });
    return { paid: res.count };
  });
}

// ---------------------------------------------------------------------------------------------------
// Pay edits of the employee file
// ---------------------------------------------------------------------------------------------------

export interface RecurringAllowance {
  name: string;
  amount: number;
  countsTowardGosi: boolean;
  allowanceType: string | null;
}

export interface EmployeePayChange {
  basicSalary?: number;
  salaryPaymentMethod?: PaymentMethod;
  ibanNumber?: string | null;
  bankName?: string | null;
}

export interface EditEmployeePayInput {
  actor: MoneyActor;
  employeeId: string;
  companyId?: string | null;
  /** Only the CHANGED columns (the caller drops what the form echoed back unchanged, BR-PAY-018). */
  pay?: EmployeePayChange;
  /** Replaces the recurring allowances (one-off bonuses are kept). */
  allowances?: readonly RecurringAllowance[];
  /** The values before the edit, for the audit (read by the caller in its transaction). */
  before?: Record<string, unknown>;
  operationKey: string;
  ipAddress?: string | null;
}

/**
 * HR changes an employee's pay in the file: the changed pay columns and / or the recurring allowances,
 * never the actor's own (BR-PAY-001; SINGLE_OPERATOR: recorded self-act). Replays for the same key.
 */
export async function editEmployeePay(tx: TxClient, input: EditEmployeePayInput) {
  assertTransactionClient(tx, 'editEmployeePay');
  const pay = input.pay ?? {};
  const touchesPay = Object.values(pay).some((v) => v !== undefined);
  if (!touchesPay && !input.allowances) return { employeeId: input.employeeId, changed: false, replayed: false };
  const outcome = await idempotent(tx, { key: input.operationKey, operation: PAY_EDIT.name, actorId: input.actor.id, companyId: input.companyId ?? null }, (t) =>
    runMoneyOperation(t, PAY_EDIT, { actor: input.actor, input: { employeeId: input.employeeId }, operationKey: input.operationKey, companyId: input.companyId }, async (w, info) => {
      if (touchesPay) {
        await w.employee.update({
          where: { id: input.employeeId },
          data: {
            basicSalary: pay.basicSalary !== undefined ? roundMoney(pay.basicSalary) : undefined,
            salaryPaymentMethod: pay.salaryPaymentMethod ?? undefined,
            ibanNumber: pay.ibanNumber,
            bankName: pay.bankName,
          },
          select: { id: true },
        });
      }
      if (input.allowances) await replaceRecurring(w, input.employeeId, input.allowances, input.actor.id);
      await audit(w, {
        actor: info.auditActor,
        action: PAY_EDIT.name,
        entity: { type: 'Employee', id: input.employeeId, companyId: input.companyId ?? null },
        before: input.before ?? null,
        after: { ...pay, ...(input.allowances ? { allowances: input.allowances } : {}) },
        operationKey: input.operationKey,
        ipAddress: input.ipAddress ?? null,
        reason: info.selfAct ? 'SELF_ACT_SINGLE_OPERATOR' : null,
      });
      await emitEvent(w, {
        type: 'compensation.pay.edited',
        aggregateType: 'Employee',
        aggregateId: input.employeeId,
        idempotencyKey: `${input.operationKey}:compensation.pay.edited`,
        payload: { employeeId: input.employeeId, columns: Object.keys(pay).filter((k) => (pay as Record<string, unknown>)[k] !== undefined), allowances: !!input.allowances },
        companyId: input.companyId ?? null,
        actorId: input.actor.id,
      });
      return { employeeId: input.employeeId, changed: true };
    }),
  );
  return { ...outcome.result, replayed: outcome.replayed };
}

async function replaceRecurring(w: TxClient, employeeId: string, rows: readonly RecurringAllowance[], actorId: string | null) {
  await w.allowance.deleteMany({ where: { employeeId, isMonthly: true } });
  if (!rows.length) return;
  const now = new Date();
  await w.allowance.createMany({
    data: rows.map((a) => ({
      employeeId,
      name: a.name,
      amount: roundMoney(a.amount),
      isMonthly: true,
      countsTowardGosi: a.countsTowardGosi,
      allowanceType: a.allowanceType,
      status: 'APPROVED',
      createdById: actorId,
      approvedById: actorId,
      approvedAt: now,
    })),
  });
}

/** The recurring allowances of an employee created in the same transaction (no replay key needed). */
export async function setInitialAllowances(
  tx: TxClient,
  input: { actor: MoneyActor; employeeId: string; allowances: readonly RecurringAllowance[]; companyId?: string | null; operationKey: string },
): Promise<{ created: number }> {
  assertTransactionClient(tx, 'setInitialAllowances');
  if (!input.allowances.length) return { created: 0 };
  return runMoneyOperation(tx, PAY_INITIAL, { actor: input.actor, input: { employeeId: input.employeeId }, operationKey: input.operationKey, companyId: input.companyId }, async (w, info) => {
    const existing = await w.allowance.count({ where: { employeeId: input.employeeId, isMonthly: true } });
    if (existing > 0) return { created: 0 }; // a repeat: the rows are there already
    await replaceRecurring(w, input.employeeId, input.allowances, input.actor.id);
    await audit(w, {
      actor: info.auditActor,
      action: PAY_INITIAL.name,
      entity: { type: 'Employee', id: input.employeeId, companyId: input.companyId ?? null },
      after: { allowances: input.allowances },
      operationKey: input.operationKey,
    });
    return { created: input.allowances.length };
  });
}

// ---------------------------------------------------------------------------------------------------
// Promotion / raise decisions (EmployeeChangeOrder, applied by documents' applyChangeOrder)
// ---------------------------------------------------------------------------------------------------

export interface ChangeOrderPayInput {
  employeeId: string;
  orderId: string;
  documentId: string;
  effectiveDate: Date;
  basicSalary: number | null;
  /** Monthly allowances to set: the row to update (found by the caller's classification) or a new one. */
  allowances: readonly { kind: 'HOUSING' | 'TRANSPORT'; rowId: string | null; amount: number }[];
  /** The user who issued the order, or null for the job. */
  triggeredById: string | null;
}

/**
 * The pay part of an approved decision on its effective date (SYSTEM operation): the basic salary, the
 * housing / transport allowance and the SalaryChange history row. Guarded by the order's own atomic
 * applied-once flag (the caller's transaction); this writer adds nothing else of its own.
 */
export async function applyChangeOrderPay(tx: TxClient, input: ChangeOrderPayInput): Promise<{ allowances: Record<string, { from: number; to: number }> }> {
  assertTransactionClient(tx, 'applyChangeOrderPay');
  const actor = input.triggeredById ? { id: input.triggeredById, employeeId: null } : null;
  return runMoneyOperation(tx, CHANGE_ORDER_APPLY, { actor, input: { employeeId: input.employeeId }, operationKey: `changeOrder:${input.orderId}:pay` }, async (w, info) => {
    if (input.basicSalary !== null) {
      await w.employee.update({ where: { id: input.employeeId }, data: { basicSalary: roundMoney(input.basicSalary) }, select: { id: true } });
      await w.salaryChange.create({
        data: {
          employeeId: input.employeeId,
          effectiveDate: input.effectiveDate,
          basicSalary: roundMoney(input.basicSalary),
          reason: `قرار ترقية/زيادة (${input.documentId})`,
          isPlanned: false,
          createdById: input.triggeredById,
        },
      });
    }
    const allowances: Record<string, { from: number; to: number }> = {};
    for (const a of input.allowances) {
      if (a.rowId) {
        const row = await w.allowance.findUnique({ where: { id: a.rowId }, select: { employeeId: true, amount: true, isMonthly: true } });
        if (!row || row.employeeId !== input.employeeId || !row.isMonthly) throw conflict('بدل الموظف تغيّر قبل تطبيق القرار');
        await w.allowance.update({ where: { id: a.rowId }, data: { amount: roundMoney(a.amount) } });
        allowances[a.kind] = { from: row.amount, to: a.amount };
      } else {
        await w.allowance.create({
          data: {
            employeeId: input.employeeId,
            name: a.kind === 'HOUSING' ? 'بدل سكن' : 'بدل نقل',
            amount: roundMoney(a.amount),
            isMonthly: true,
            allowanceType: a.kind,
            countsTowardGosi: a.kind === 'HOUSING',
            status: 'APPROVED',
            createdById: input.triggeredById,
            approvedById: input.triggeredById,
            approvedAt: new Date(),
          },
        });
        allowances[a.kind] = { from: 0, to: a.amount };
      }
    }
    await audit(w, {
      actor: info.auditActor,
      action: CHANGE_ORDER_APPLY.name,
      entity: { type: 'Employee', id: input.employeeId },
      after: { orderId: input.orderId, basicSalary: input.basicSalary, allowances, triggeredById: input.triggeredById },
      operationKey: `changeOrder:${input.orderId}:pay`,
    });
    return { allowances };
  });
}
