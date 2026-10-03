// Deduction (penalty) transitions (pay-to-be §11 row 4, BR-PAY-010; BL-PAY-003): the sole writer of
// Deduction behind money.gateway, every status or amount change included (investigation outcome,
// objection, manager penalty, referral), with the users behind issuedBy / approvedBy (BR-PAY-006).
//
//   issued ─► DEDUCTED (due in payroll) | PENDING_AMOUNT_APPROVAL ─approve─► DEDUCTED
//   DEDUCTED ─object─► OBJECTION_SUBMITTED ─resolve─► WAIVED | DEDUCTED
//   … ─request waiver─► PENDING_WAIVE_APPROVAL ─reject request─► DEDUCTED | ─accept─► WAIVED
//   … ─refer─► UNDER_INVESTIGATION ─verdict─► WAIVED (innocent) | PENDING_AMOUNT_APPROVAL (guilty / closed)
//   REJECTED (HR refuses a manager's violation)
//
// Segregation (gateway): nobody prices, approves, waives, rejects, suspends or clears his own penalty
// (BR-PAY-001: WAIVE / SUSPEND / APPROVE); filing a violation, an objection or a waiver request is a
// request. Once linked to an approved payroll line a deduction no longer moves (isLinkedToPayroll).
import { conflict, notFound } from '@/lib/http';
import { assertPayrollReady } from '@/modules/compensation';
import { roundMoney } from '@/lib/money';
import { DEDUCTION_STATUS } from '@/lib/constants';
import { assertTransactionClient, audit, emitEvent, idempotent, runMoneyOperation, type MoneyActor, type MoneyOperation, type MoneyRunInfo, type TxClient } from '@/modules/platform';
import { DEDUCTION_APPROVE, DEDUCTION_CREATE, DEDUCTION_REQUEST, DEDUCTION_SUSPEND, DEDUCTION_WAIVE, type DeductionSubject } from '../operations';
import { releaseDeductionReservation } from './drafts';

type DeductionRow = Awaited<ReturnType<TxClient['deduction']['findUniqueOrThrow']>>;

const RESERVATION = { id: true, employeeId: true, amount: true, status: true, payrollMonth: true, isLinkedToPayroll: true } as const;

/** The deciding user: id for the FK, name for the legacy display column. */
export interface DeductionActor extends MoneyActor {
  name: string;
}

interface DeductionActInput {
  actor: DeductionActor;
  deductionId: string;
  operationKey: string;
  ipAddress?: string | null;
}

async function recordDeduction(w: TxClient, info: MoneyRunInfo, key: string, d: DeductionRow, verb: string, before: unknown, after: unknown, ipAddress?: string | null) {
  await audit(w, {
    actor: info.auditActor,
    action: info.operation,
    entity: { type: 'Deduction', id: d.id },
    before,
    after,
    operationKey: key,
    ipAddress: ipAddress ?? null,
    reason: info.selfAct ? `SELF_ACT_SINGLE_OPERATOR: ${info.reasons.join(',')}` : null,
  });
  await emitEvent(w, {
    type: `payroll.deduction.${verb}`,
    aggregateType: 'Deduction',
    aggregateId: d.id,
    idempotencyKey: `${key}:payroll.deduction.${verb}`,
    payload: { deductionId: d.id, employeeId: d.employeeId, status: d.status, amount: d.amount },
    actorId: info.actorUserId,
  });
}

async function deductionAct(
  tx: TxClient,
  op: MoneyOperation<DeductionSubject>,
  input: { actor: MoneyActor; operationKey: string },
  subject: DeductionSubject,
  fn: (w: TxClient, info: MoneyRunInfo) => Promise<DeductionRow>,
): Promise<DeductionRow> {
  const outcome = await idempotent(tx, { key: input.operationKey, operation: op.name, actorId: input.actor.id }, (t) =>
    runMoneyOperation(t, op, { actor: input.actor, input: subject, operationKey: input.operationKey }, fn),
  );
  return outcome.result;
}

async function guardFailed(w: TxClient, id: string, message: string): Promise<never> {
  const exists = await w.deduction.findUnique({ where: { id }, select: { id: true } });
  if (!exists) throw notFound('المخالفة غير موجودة');
  throw conflict(message);
}

export interface CreateDeductionInput {
  actor: DeductionActor;
  operationKey: string;
  ipAddress?: string | null;
  data: {
    employeeId: string;
    amount: number;
    date: Date;
    reason: string;
    category: string;
    violationType: string | null;
    occurrenceNumber: number;
    severity: string;
    deductionDays: number;
    dailySalary: number | null;
    hasFinancialImpact: boolean;
    issuedBy: string;
    status: string;
    lawArticle: string | null;
    isReferredToInvestigation?: boolean;
    investigationId?: string | null;
  };
}

/** Issues a violation: DEDUCTED at once (HR, within one day's wage) or waiting for amount approval. */
export async function createDeduction(tx: TxClient, input: CreateDeductionInput): Promise<DeductionRow> {
  assertTransactionClient(tx, 'createDeduction');
  const d = input.data;
  return deductionAct(tx, DEDUCTION_CREATE, input, { employeeId: d.employeeId }, async (w, info) => {
    if (roundMoney(d.amount) > 0) await assertPayrollReady(w, d.employeeId); // BR-PAY-009: no penalty before the pay is applied
    const effective = d.status === DEDUCTION_STATUS.DEDUCTED;
    const row = await w.deduction.create({
      data: {
        employeeId: d.employeeId,
        amount: roundMoney(d.amount),
        date: d.date,
        reason: d.reason,
        category: d.category,
        violationType: d.violationType,
        occurrenceNumber: d.occurrenceNumber,
        severity: d.severity,
        deductionDays: d.deductionDays,
        dailySalary: d.dailySalary,
        hasFinancialImpact: d.hasFinancialImpact,
        issuedBy: d.issuedBy,
        issuedById: input.actor.id,
        status: d.status,
        lawArticle: d.lawArticle,
        isReferredToInvestigation: d.isReferredToInvestigation ?? false,
        investigationId: d.investigationId ?? null,
        ...(effective ? { approvedBy: input.actor.name, approvedAt: new Date(), decidedById: input.actor.id } : {}),
      },
    });
    await recordDeduction(w, info, input.operationKey, row, 'created', null, { employeeId: row.employeeId, amount: row.amount, status: row.status }, input.ipAddress);
    return row;
  });
}

/**
 * HR approves (prices) a pending violation or refuses a waiver request: → DEDUCTED, due in payroll.
 * `amount` replaces the amount (the Article 70 cap is the caller's check, from the effective wage).
 */
export async function approveDeduction(tx: TxClient, input: DeductionActInput & { amount?: number; from: readonly string[] }): Promise<DeductionRow> {
  assertTransactionClient(tx, 'approveDeduction');
  return deductionAct(tx, DEDUCTION_APPROVE, input, { deductionId: input.deductionId }, async (w, info) => {
    const before = await w.deduction.findUnique({ where: { id: input.deductionId }, select: RESERVATION });
    const amount = input.amount !== undefined ? roundMoney(input.amount) : undefined;
    const res = await w.deduction.updateMany({
      where: { id: input.deductionId, status: { in: [...input.from] }, isLinkedToPayroll: false },
      data: {
        status: DEDUCTION_STATUS.DEDUCTED,
        approvedBy: input.actor.name,
        approvedAt: new Date(),
        decidedById: input.actor.id,
        ...(amount !== undefined ? { amount, hasFinancialImpact: amount > 0 } : {}),
      },
    });
    if (res.count === 0) await guardFailed(w, input.deductionId, 'تمت معالجة هذه المخالفة مسبقاً');
    const row = await w.deduction.findUniqueOrThrow({ where: { id: input.deductionId } });
    await recordDeduction(w, info, input.operationKey, row, 'approved', before, { status: row.status, amount: row.amount }, input.ipAddress);
    return row;
  });
}

/** HR refuses a manager's violation (→ REJECTED) or accepts a waiver request (→ WAIVED). */
export async function rejectDeduction(tx: TxClient, input: DeductionActInput & { from: readonly string[]; reason?: string | null }): Promise<DeductionRow> {
  assertTransactionClient(tx, 'rejectDeduction');
  return deductionAct(tx, DEDUCTION_WAIVE, input, { deductionId: input.deductionId }, async (w, info) => {
    const current = await w.deduction.findUnique({ where: { id: input.deductionId }, select: RESERVATION });
    if (!current) throw notFound();
    const next = current.status === DEDUCTION_STATUS.PENDING_WAIVE_APPROVAL ? DEDUCTION_STATUS.WAIVED : DEDUCTION_STATUS.REJECTED;
    const res = await w.deduction.updateMany({
      where: { id: input.deductionId, status: { in: [...input.from] }, isLinkedToPayroll: false },
      data: { status: next, approvedBy: input.actor.name, approvedAt: new Date(), decidedById: input.actor.id },
    });
    if (res.count === 0) throw conflict('تمت معالجة هذه المخالفة مسبقاً');
    await releaseDeductionReservation(w, current);
    const row = await w.deduction.findUniqueOrThrow({ where: { id: input.deductionId } });
    await recordDeduction(w, info, input.operationKey, row, 'rejected', current, { status: next, reason: input.reason ?? null }, input.ipAddress);
    return row;
  });
}

/** HR waives a penalty completely (anything not yet deducted in an approved payroll). */
export async function waiveDeduction(tx: TxClient, input: DeductionActInput): Promise<DeductionRow> {
  assertTransactionClient(tx, 'waiveDeduction');
  return deductionAct(tx, DEDUCTION_WAIVE, input, { deductionId: input.deductionId }, async (w, info) => {
    const current = await w.deduction.findUnique({ where: { id: input.deductionId }, select: RESERVATION });
    if (!current) throw notFound();
    if (current.isLinkedToPayroll) throw conflict('لا يمكن إسقاط المخالفة لأنها خُصمت في مسير رواتب معتمد');
    const res = await w.deduction.updateMany({
      where: { id: input.deductionId, isLinkedToPayroll: false, status: { notIn: [DEDUCTION_STATUS.WAIVED, DEDUCTION_STATUS.REJECTED] } },
      data: { status: DEDUCTION_STATUS.WAIVED, approvedBy: input.actor.name, approvedAt: new Date(), decidedById: input.actor.id },
    });
    if (res.count === 0) throw conflict('المخالفة مُسقطة أو مرفوضة مسبقاً');
    await releaseDeductionReservation(w, current);
    const row = await w.deduction.findUniqueOrThrow({ where: { id: input.deductionId } });
    await recordDeduction(w, info, input.operationKey, row, 'waived', current, { status: row.status }, input.ipAddress);
    return row;
  });
}

/**
 * Refers a violation to an investigation (→ UNDER_INVESTIGATION): it stops being payable and leaves any
 * draft line that reserved it. `notIn`: the statuses that cannot be referred (the caller's list).
 * A referral is not a decision (BL-PAY-027, RT-WFE-712): decidedById keeps the person who decided the
 * penalty (BR-PAY-002 reads it); the referrer is recorded in the audit row only.
 */
export async function referDeductionToInvestigation(
  tx: TxClient,
  input: DeductionActInput & { investigationId: string; notIn: readonly string[]; employeeId?: string; message?: string },
): Promise<DeductionRow> {
  assertTransactionClient(tx, 'referDeductionToInvestigation');
  return deductionAct(tx, DEDUCTION_SUSPEND, input, { deductionId: input.deductionId }, async (w, info) => {
    const current = await w.deduction.findUnique({ where: { id: input.deductionId }, select: { ...RESERVATION, investigationId: true } });
    if (!current) throw notFound('المخالفة المرتبطة غير موجودة');
    if (input.employeeId && current.employeeId !== input.employeeId) throw conflict('المخالفة المرتبطة لا تخص الموظف المحال للتحقيق');
    const res = await w.deduction.updateMany({
      where: { id: input.deductionId, investigationId: null, isReferredToInvestigation: false, isLinkedToPayroll: false, status: { notIn: [...input.notIn] } },
      data: { isReferredToInvestigation: true, investigationId: input.investigationId, status: DEDUCTION_STATUS.UNDER_INVESTIGATION },
    });
    if (res.count === 0) throw conflict(input.message ?? 'لا يمكن إحالة المخالفة: تمت إحالتها أو معالجتها مسبقاً');
    await releaseDeductionReservation(w, current);
    const row = await w.deduction.findUniqueOrThrow({ where: { id: input.deductionId } });
    await recordDeduction(w, info, input.operationKey, row, 'referred', current, { status: row.status, investigationId: input.investigationId, referredById: input.actor.id }, input.ipAddress);
    return row;
  });
}

/** The employee objects to his penalty (→ OBJECTION_SUBMITTED): a request, it leaves the draft line. */
export async function submitDeductionObjection(tx: TxClient, input: DeductionActInput & { objectionText: string }): Promise<DeductionRow> {
  assertTransactionClient(tx, 'submitDeductionObjection');
  return deductionAct(tx, DEDUCTION_REQUEST, input, { deductionId: input.deductionId }, async (w, info) => {
    const current = await w.deduction.findUnique({ where: { id: input.deductionId }, select: RESERVATION });
    if (!current) throw notFound('المخالفة غير موجودة');
    const res = await w.deduction.updateMany({
      where: { id: input.deductionId, hasObjection: false, isLinkedToPayroll: false, status: { in: [DEDUCTION_STATUS.DEDUCTED, DEDUCTION_STATUS.PENDING_AMOUNT_APPROVAL, 'COMPLETED'] } },
      data: { hasObjection: true, objectionText: input.objectionText, objectionDate: new Date(), objectionStatus: 'PENDING', status: DEDUCTION_STATUS.OBJECTION_SUBMITTED },
    });
    if (res.count === 0) throw conflict('لا يمكن الاعتراض على هذه المخالفة (تم الاعتراض أو خُصمت مسبقاً)');
    await releaseDeductionReservation(w, current);
    const row = await w.deduction.findUniqueOrThrow({ where: { id: input.deductionId } });
    await recordDeduction(w, info, input.operationKey, row, 'objected', current, { status: row.status }, input.ipAddress);
    return row;
  });
}

/** HR decides an objection: ACCEPTED → WAIVED (a waiver), REJECTED → DEDUCTED (the penalty stands). */
export async function resolveDeductionObjection(tx: TxClient, input: DeductionActInput & { decision: 'ACCEPTED' | 'REJECTED' }): Promise<DeductionRow> {
  assertTransactionClient(tx, 'resolveDeductionObjection');
  const op = input.decision === 'ACCEPTED' ? DEDUCTION_WAIVE : DEDUCTION_APPROVE;
  return deductionAct(tx, op, input, { deductionId: input.deductionId }, async (w, info) => {
    const res = await w.deduction.updateMany({
      where: { id: input.deductionId, status: DEDUCTION_STATUS.OBJECTION_SUBMITTED },
      data: {
        objectionStatus: input.decision,
        status: input.decision === 'ACCEPTED' ? DEDUCTION_STATUS.WAIVED : DEDUCTION_STATUS.DEDUCTED,
        approvedBy: input.actor.name,
        approvedAt: new Date(),
        decidedById: input.actor.id,
      },
    });
    if (res.count === 0) await guardFailed(w, input.deductionId, 'تم البت في الاعتراض مسبقاً');
    const row = await w.deduction.findUniqueOrThrow({ where: { id: input.deductionId } });
    await recordDeduction(w, info, input.operationKey, row, 'objectionResolved', { status: DEDUCTION_STATUS.OBJECTION_SUBMITTED }, { status: row.status, decision: input.decision }, input.ipAddress);
    return row;
  });
}

/** A manager (or HR) asks HR to waive a penalty (→ PENDING_WAIVE_APPROVAL): a request. */
export async function requestDeductionWaiver(tx: TxClient, input: DeductionActInput): Promise<DeductionRow> {
  assertTransactionClient(tx, 'requestDeductionWaiver');
  return deductionAct(tx, DEDUCTION_REQUEST, input, { deductionId: input.deductionId }, async (w, info) => {
    const current = await w.deduction.findUnique({ where: { id: input.deductionId }, select: RESERVATION });
    if (!current) throw notFound('المخالفة غير موجودة');
    const res = await w.deduction.updateMany({
      where: {
        id: input.deductionId,
        isLinkedToPayroll: false,
        status: { in: [DEDUCTION_STATUS.DEDUCTED, DEDUCTION_STATUS.OBJECTION_REJECTED, DEDUCTION_STATUS.PENDING_AMOUNT_APPROVAL, 'COMPLETED'] },
      },
      data: { status: DEDUCTION_STATUS.PENDING_WAIVE_APPROVAL },
    });
    if (res.count === 0) throw conflict('لا يمكن طلب إسقاط هذه المخالفة (خُصمت أو عولجت مسبقاً)');
    await releaseDeductionReservation(w, current);
    const row = await w.deduction.findUniqueOrThrow({ where: { id: input.deductionId } });
    await recordDeduction(w, info, input.operationKey, row, 'waiverRequested', current, { status: row.status }, input.ipAddress);
    return row;
  });
}

export interface InvestigationOutcomeInput {
  actor: DeductionActor;
  investigationId: string;
  employeeId: string;
  verdict: 'INNOCENT' | 'GUILTY' | 'CLOSED';
  /** Statuses of the violations still waiting for the investigation. */
  awaiting: readonly string[];
  /** GUILTY with a penalty: it replaces the amount of the first linked violation, or becomes a new one. */
  penalty?: { amount: number; days: number; dailySalary: number | null; reason: string; category: string; severity: string | null } | null;
  operationKey: string;
  ipAddress?: string | null;
}

export interface InvestigationOutcome {
  waived: string[];
  penalized: string | null;
  created: string | null;
  pendingAmount: string[];
}

/**
 * The verdict of an investigation on its linked violations: INNOCENT drops them (a waiver, never on
 * one's own); GUILTY (with a penalty) / CLOSED sends them back to HR for amount approval (a request).
 */
export async function concludeInvestigationDeductions(tx: TxClient, input: InvestigationOutcomeInput): Promise<InvestigationOutcome> {
  assertTransactionClient(tx, 'concludeInvestigationDeductions');
  const op = input.verdict === 'INNOCENT' ? DEDUCTION_WAIVE : DEDUCTION_REQUEST;
  const outcome = await idempotent(tx, { key: input.operationKey, operation: `${op.name}.investigation`, actorId: input.actor.id }, (t) =>
    runMoneyOperation(t, op, { actor: input.actor, input: { employeeId: input.employeeId }, operationKey: input.operationKey }, async (w, info) => {
      const linked = await w.deduction.findMany({
        where: { investigationId: input.investigationId, status: { in: [...input.awaiting] }, isLinkedToPayroll: false },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
      const ids = linked.map((d) => d.id);
      const result: InvestigationOutcome = { waived: [], penalized: null, created: null, pendingAmount: [] };
      if (input.verdict === 'INNOCENT') {
        if (ids.length) {
          await w.deduction.updateMany({
            where: { id: { in: ids }, status: { in: [...input.awaiting] }, isLinkedToPayroll: false },
            data: { status: DEDUCTION_STATUS.WAIVED, approvedBy: input.actor.name, approvedAt: new Date(), decidedById: input.actor.id },
          });
        }
        result.waived = ids;
      } else {
        let remaining = ids;
        const p = input.verdict === 'GUILTY' ? input.penalty : null;
        if (p && (p.amount > 0 || p.days > 0)) {
          const penaltyData = {
            amount: roundMoney(p.amount),
            deductionDays: p.days,
            dailySalary: p.dailySalary,
            hasFinancialImpact: p.amount > 0,
            status: DEDUCTION_STATUS.PENDING_AMOUNT_APPROVAL,
          };
          if (ids.length) {
            const [first, ...rest] = ids;
            await w.deduction.update({ where: { id: first }, data: penaltyData });
            result.penalized = first;
            remaining = rest;
          } else {
            const created = await w.deduction.create({
              data: {
                ...penaltyData,
                employeeId: input.employeeId,
                date: new Date(),
                reason: p.reason.slice(0, 500),
                category: p.category,
                severity: p.severity,
                isReferredToInvestigation: true,
                investigationId: input.investigationId,
                issuedBy: input.actor.name,
                issuedById: input.actor.id,
              },
              select: { id: true },
            });
            result.created = created.id;
          }
        }
        if (remaining.length) {
          await w.deduction.updateMany({
            where: { id: { in: remaining }, status: { in: [...input.awaiting] }, isLinkedToPayroll: false },
            data: { status: DEDUCTION_STATUS.PENDING_AMOUNT_APPROVAL },
          });
        }
        result.pendingAmount = remaining;
      }
      await audit(w, {
        actor: info.auditActor,
        action: `${op.name}.investigation`,
        entity: { type: 'Investigation', id: input.investigationId },
        after: { verdict: input.verdict, ...result },
        operationKey: input.operationKey,
        ipAddress: input.ipAddress ?? null,
        reason: info.selfAct ? `SELF_ACT_SINGLE_OPERATOR: ${info.reasons.join(',')}` : null,
      });
      await emitEvent(w, {
        type: 'payroll.deduction.investigationConcluded',
        aggregateType: 'Investigation',
        aggregateId: input.investigationId,
        idempotencyKey: `${input.operationKey}:payroll.deduction.investigationConcluded`,
        payload: { investigationId: input.investigationId, employeeId: input.employeeId, verdict: input.verdict, ...result },
        actorId: input.actor.id,
      });
      return result;
    }),
  );
  return outcome.result;
}
