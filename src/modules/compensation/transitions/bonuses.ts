// compensation transitions: one-off bonuses (Allowance isMonthly=false; P1-PAY-A slice, BL-PAY-007
// makes them PENDING). Each behind its money.gateway operation (../operations), guarded (BR-PAY-001) and
// recording who did it. The pay itself (CompensationPeriod, BankIdentityPeriod, EmployeeFinancialChange)
// is ./apply.ts and ./financial-change.ts (P1-PAY-B).
//
// User transitions take an operation key (OperationLog: a repeat replays the result) and write audit +
// event in the caller's transaction. The bonus link writers are effects of payroll operations: they run
// under their own SYSTEM operation and are idempotent by nature (guarded updateMany).
import { badRequest, conflict } from '@/lib/http';
import { roundMoney } from '@/lib/money';
import { assertTransactionClient, audit, emitEvent, idempotent, runMoneyOperation, type MoneyActor, type TxClient } from '@/modules/platform';
import { PAYABLE_BONUS_STATUS } from '../model';
import { BONUS_CREATE, BONUS_PAYROLL_LINK } from '../operations';

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

/** payroll.generate: the draft line `payrollId` reserves these unpaid, APPROVED bonuses (paid in `month/year`). */
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
        where: { id: { in: ids }, isPaid: false, status: PAYABLE_BONUS_STATUS },
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

/**
 * The lines are approved: the bonuses they hold are paid (once: only unpaid rows move). A line holding a
 * bonus that is no longer APPROVED (withdrawn or rejected since the generation) is refused with 409:
 * the draft must be regenerated (BL-PAY-027, RT-WFE-701), the approval transaction rolls back.
 */
export async function markBonusesPaid(tx: TxClient, input: { payrollIds: readonly string[]; operationKey: string }): Promise<{ paid: number }> {
  assertTransactionClient(tx, 'markBonusesPaid');
  const payrollIds = uniq(input.payrollIds);
  if (!payrollIds.length) return { paid: 0 };
  return runMoneyOperation(tx, BONUS_PAYROLL_LINK, { actor: null, input: { payrollIds }, operationKey: `${input.operationKey}:bonus.paid` }, async (t) => {
    const stale = await t.allowance.count({ where: { paidInPayrollId: { in: payrollIds }, isPaid: false, status: { not: PAYABLE_BONUS_STATUS } } });
    if (stale > 0) throw conflict('يحمل المسير مكافأة لم تعد معتمدة (سُحبت أو رُفضت بعد التوليد)، يرجى إعادة توليد مسير الشهر قبل الاعتماد', { code: 'BONUS_NOT_APPROVED', count: stale });
    const res = await t.allowance.updateMany({ where: { paidInPayrollId: { in: payrollIds }, isPaid: false, status: PAYABLE_BONUS_STATUS }, data: { isPaid: true } });
    return { paid: res.count };
  });
}
