// time transitions (first slice, P1-PAY-A): the sole writer of the overtime reservation links
// (OvertimeRequest.paidInPayrollId / paidInSettlementId, money columns behind money.gateway) and of the
// overtime decision / direct assignment with their actor columns (BR-PAY-006). The rest of the time
// module (DayRecord, attendance close) arrives with its own package.
//
// The link writers are EFFECTS of a payroll or settlement operation: they run in the caller's
// transaction under their own SYSTEM gateway operation, and are idempotent by nature (guarded
// updateMany: a repeat finds nothing to link or unlink). decideOvertime / assignOvertime are user
// transitions: operation key (OperationLog), gateway guard (BR-PAY-001), audit and event.
import { conflict, notFound } from '@/lib/http';
import { assertPayrollReady } from '@/modules/compensation';
import { roundMoney } from '@/lib/money';
import { assertTransactionClient, audit, emitEvent, idempotent, runMoneyOperation, type MoneyActor, type OperatorMode, type TxClient } from '@/modules/platform';
import { OVERTIME_ASSIGN, OVERTIME_DECIDE, OVERTIME_PAYROLL_LINK, OVERTIME_SETTLEMENT_LINK } from './operations';

const uniq = (ids: readonly string[]) => [...new Set(ids.filter(Boolean))];

/**
 * Reserves approved, still unpaid overtime rows for the draft lines that pay them. Only rows free of
 * any payroll and settlement link are taken; a row taken meanwhile (a settlement, a concurrent run)
 * makes the generation fail (409) instead of paying it twice.
 */
export async function linkOvertimeToPayroll(
  tx: TxClient,
  input: { reservations: readonly { payrollId: string; overtimeIds: readonly string[] }[]; operationKey: string },
): Promise<{ linked: number }> {
  assertTransactionClient(tx, 'linkOvertimeToPayroll');
  const all = input.reservations.flatMap((r) => r.overtimeIds);
  if (!all.length) return { linked: 0 };
  return runMoneyOperation(tx, OVERTIME_PAYROLL_LINK, { actor: null, input: { overtimeIds: all }, operationKey: `${input.operationKey}:overtime.link` }, async (t) => {
    let linked = 0;
    for (const r of input.reservations) {
      const ids = uniq(r.overtimeIds);
      if (!ids.length) continue;
      const res = await t.overtimeRequest.updateMany({
        where: { id: { in: ids }, status: 'APPROVED', paidInPayrollId: null, paidInSettlementId: null },
        data: { paidInPayrollId: r.payrollId },
      });
      if (res.count !== ids.length) throw conflict('تغيّرت طلبات العمل الإضافي أثناء توليد المسير (تصفية أو توليد آخر)، يرجى إعادة التوليد');
      linked += res.count;
    }
    return { linked };
  });
}

/** Releases the overtime held by draft lines being replaced or dropped (they become payable again). */
export async function unlinkOvertimeFromPayrolls(tx: TxClient, input: { payrollIds: readonly string[]; operationKey: string }): Promise<{ released: number }> {
  assertTransactionClient(tx, 'unlinkOvertimeFromPayrolls');
  const payrollIds = uniq(input.payrollIds);
  if (!payrollIds.length) return { released: 0 };
  return runMoneyOperation(tx, OVERTIME_PAYROLL_LINK, { actor: null, input: { payrollIds }, operationKey: `${input.operationKey}:overtime.unlink` }, async (t) => {
    const res = await t.overtimeRequest.updateMany({ where: { paidInPayrollId: { in: payrollIds } }, data: { paidInPayrollId: null } });
    return { released: res.count };
  });
}

/** A settlement reserves the approved overtime rows it pays; a row reserved (or no longer approved) meanwhile is a 409. */
export async function linkOvertimeToSettlement(
  tx: TxClient,
  input: { settlementId: string; overtimeIds: readonly string[]; operationKey: string; conflictMessage?: string },
): Promise<{ linked: number }> {
  assertTransactionClient(tx, 'linkOvertimeToSettlement');
  const ids = uniq(input.overtimeIds);
  if (!ids.length) return { linked: 0 };
  return runMoneyOperation(tx, OVERTIME_SETTLEMENT_LINK, { actor: null, input: { overtimeIds: ids, settlementId: input.settlementId }, operationKey: `${input.operationKey}:overtime.linkSettlement` }, async (t) => {
    const res = await t.overtimeRequest.updateMany({ where: { id: { in: ids }, status: 'APPROVED', paidInSettlementId: null }, data: { paidInSettlementId: input.settlementId } });
    if (res.count !== ids.length) throw conflict(input.conflictMessage ?? 'تغيّرت طلبات العمل الإضافي للموظف أثناء العملية، يرجى المحاولة مجدداً');
    return { linked: res.count };
  });
}

/** Releases overtime a settlement reserved (all of them, or the listed ones). */
export async function unlinkOvertimeFromSettlement(
  tx: TxClient,
  input: { settlementId: string; overtimeIds?: readonly string[]; operationKey: string },
): Promise<{ released: number }> {
  assertTransactionClient(tx, 'unlinkOvertimeFromSettlement');
  const ids = input.overtimeIds ? uniq(input.overtimeIds) : null;
  if (ids && !ids.length) return { released: 0 };
  return runMoneyOperation(tx, OVERTIME_SETTLEMENT_LINK, { actor: null, input: { settlementId: input.settlementId }, operationKey: `${input.operationKey}:overtime.unlinkSettlement` }, async (t) => {
    const res = await t.overtimeRequest.updateMany({
      where: { paidInSettlementId: input.settlementId, ...(ids ? { id: { in: ids } } : {}) },
      data: { paidInSettlementId: null },
    });
    return { released: res.count };
  });
}

export interface DecideOvertimeInput {
  actor: MoneyActor;
  overtimeId: string;
  status: 'APPROVED' | 'REJECTED';
  operationKey: string;
  ipAddress?: string | null;
  /** Operator mode already read by the caller (else the gateway reads it; never from the client). */
  mode?: OperatorMode;
}

/**
 * PENDING → APPROVED | REJECTED, once (guarded updateMany), by someone who is not the employee
 * (BR-PAY-001 through the gateway), with decidedById / decidedAt (BR-PAY-006), audit and event.
 * Replays the recorded result for the same operation key.
 */
export async function decideOvertime(tx: TxClient, input: DecideOvertimeInput) {
  assertTransactionClient(tx, 'decideOvertime');
  const outcome = await idempotent(tx, { key: input.operationKey, operation: OVERTIME_DECIDE.name, actorId: input.actor.id }, (t) =>
    runMoneyOperation(t, OVERTIME_DECIDE, { actor: input.actor, input: { overtimeId: input.overtimeId }, operationKey: input.operationKey, mode: input.mode }, async (w, info) => {
      if (input.status === 'APPROVED') {
        // BR-PAY-009: no overtime approval before the employee's pay is applied.
        const ot = await w.overtimeRequest.findUnique({ where: { id: input.overtimeId }, select: { employeeId: true } });
        if (ot) await assertPayrollReady(w, ot.employeeId);
      }
      const now = new Date();
      const res = await w.overtimeRequest.updateMany({
        where: { id: input.overtimeId, status: 'PENDING' },
        data: { status: input.status, decidedById: input.actor.id, decidedAt: now },
      });
      if (res.count === 0) {
        const exists = await w.overtimeRequest.findUnique({ where: { id: input.overtimeId }, select: { id: true } });
        if (!exists) throw notFound();
        throw conflict('تمت معالجة طلب العمل الإضافي مسبقاً');
      }
      const row = await w.overtimeRequest.findUniqueOrThrow({ where: { id: input.overtimeId } });
      await audit(w, {
        actor: info.auditActor,
        action: OVERTIME_DECIDE.name,
        entity: { type: 'OvertimeRequest', id: row.id },
        before: { status: 'PENDING' },
        after: { status: row.status, decidedById: row.decidedById },
        operationKey: input.operationKey,
        ipAddress: input.ipAddress ?? null,
        reason: info.selfAct ? 'SELF_ACT_SINGLE_OPERATOR' : null,
      });
      await emitEvent(w, {
        type: 'time.overtime.decided',
        aggregateType: 'OvertimeRequest',
        aggregateId: row.id,
        idempotencyKey: `${input.operationKey}:time.overtime.decided`,
        payload: { overtimeId: row.id, employeeId: row.employeeId, status: row.status },
        actorId: input.actor.id,
      });
      return row;
    }),
  );
  return outcome.result;
}

export interface AssignOvertimeInput {
  actor: MoneyActor;
  employeeId: string;
  date: Date;
  type: string;
  hours: number;
  amount: number;
  reason: string | null;
  operationKey: string;
  ipAddress?: string | null;
}

/**
 * HR assigns overtime directly (effective at once until BL-PAY-007 makes it PENDING): never to oneself
 * (BR-PAY-001), with createdById / decidedById, audit and event. Replays for the same operation key.
 */
export async function assignOvertime(tx: TxClient, input: AssignOvertimeInput) {
  assertTransactionClient(tx, 'assignOvertime');
  const outcome = await idempotent(tx, { key: input.operationKey, operation: OVERTIME_ASSIGN.name, actorId: input.actor.id }, (t) =>
    runMoneyOperation(t, OVERTIME_ASSIGN, { actor: input.actor, input: { employeeId: input.employeeId }, operationKey: input.operationKey }, async (w, info) => {
      await assertPayrollReady(w, input.employeeId); // BR-PAY-009: no overtime before the pay is applied
      const now = new Date();
      const row = await w.overtimeRequest.create({
        data: {
          employeeId: input.employeeId,
          date: input.date,
          type: input.type,
          hours: roundMoney(input.hours),
          amount: roundMoney(input.amount),
          reason: input.reason,
          status: 'APPROVED',
          createdById: input.actor.id,
          decidedById: input.actor.id,
          decidedAt: now,
        },
      });
      await audit(w, {
        actor: info.auditActor,
        action: OVERTIME_ASSIGN.name,
        entity: { type: 'OvertimeRequest', id: row.id },
        after: { employeeId: row.employeeId, type: row.type, hours: row.hours, amount: row.amount, status: row.status },
        operationKey: input.operationKey,
        ipAddress: input.ipAddress ?? null,
        reason: info.selfAct ? 'SELF_ACT_SINGLE_OPERATOR' : null,
      });
      await emitEvent(w, {
        type: 'time.overtime.assigned',
        aggregateType: 'OvertimeRequest',
        aggregateId: row.id,
        idempotencyKey: `${input.operationKey}:time.overtime.assigned`,
        payload: { overtimeId: row.id, employeeId: row.employeeId },
        actorId: input.actor.id,
      });
      return row;
    }),
  );
  return outcome.result;
}
