// EmployeeFinancialChange: the REQUEST of a pay or bank-identity change (pay-to-be.md BR-PAY-009 as amended
// by ARC-PAY-A2; DOMAIN_MODEL §1.1). State machine (CHECK EmployeeFinancialChange_status_check, 9zg):
//
//   LEGACY_UNVERIFIED --confirmLegacyFinancialChange (the employee, portal)--> PENDING
//   PENDING --decideFinancialChange APPROVE (second person)--> PENDING_EFFECT --applyFinancialChange--> APPLIED
//   PENDING --decideFinancialChange REJECT--> REJECTED
//   LEGACY_UNVERIFIED | PENDING | PENDING_EFFECT --cancelFinancialChange / exit--> CANCELLED
//
// Rules:
//   - the values asked for live in the request only; the Employee columns keep the APPLIED ones (BR-PAY-009);
//   - one PENDING request per (employee, field) (EX-PAY-005; partial unique index);
//   - the decider is not the requester and not the employee (DEC-PO-003 / 007, BR-PAY-001), nor anyone who
//     filed the original of a legacy request (G1b); SINGLE_OPERATOR records a self-act instead (BR-PAY-020);
//   - an IBAN that replaces an IBAN on file is asked by the employee himself from the portal (BR-PAY-009,
//     RT-PAY-301); the first IBAN of a new or cash-paid employee comes with the hiring (FORM, IMPORT,
//     ONBOARDING) or an edit;
//   - approved and due (effective date today or earlier): applied in the same transaction; a later date
//     waits as PENDING_EFFECT for the apply-financial-changes job (or the payroll run) on that day;
//   - a bank identity starts on the day it is applied, never earlier (ADR-0001 #8).
// Every exported transition takes an operation key: a repeat replays the first result (ARCH-014).
import type { PaymentMethod, Prisma } from '@prisma/client';
import { encryptField } from '@/lib/crypto';
import { todayKey } from '@/lib/dates';
import { badRequest, conflict, forbidden, notFound } from '@/lib/http';
import { normalizeIban } from '@/lib/iban';
import { roundMoney } from '@/lib/money';
import {
  activeAt,
  assertTransactionClient,
  audit,
  decideByMode,
  emitEvent,
  idempotent,
  resolveOperatorMode,
  runMoneyOperation,
  type CompensationAllowance,
  type GuardDecision,
  type GuardReason,
  type MoneyActor,
  type OperatorMode,
  type TxClient,
} from '@/modules/platform';
import { employeeForCompensation } from '@/modules/people';
import { sameCompensation, toPeriodAllowances, type RequestedAllowance } from '../allowances';
import { ibanFingerprint, ibanLast4, maskedIban } from '../bank';
import {
  DAY,
  FINANCIAL_CHANGE_SELECT,
  FINANCIAL_CHANGE_SOURCES,
  IbanSelfServiceOnlyError,
  OPEN_FINANCIAL_CHANGE_STATUSES,
  SAUDI_IBAN_SHAPE,
  financialChangeView,
  type ChangeRow,
  type FinancialChangeField,
  type FinancialChangeSource,
  type FinancialChangeView,
} from '../model';
import {
  FINANCIAL_CHANGE_APPLY,
  FINANCIAL_CHANGE_CANCEL,
  FINANCIAL_CHANGE_DECIDE,
  FINANCIAL_CHANGE_EXIT_CANCEL,
  FINANCIAL_CHANGE_REJECT,
  FINANCIAL_CHANGE_REQUEST,
} from '../operations';
import { applyBankIdentity, applyDecision } from './apply';

async function loadChange(tx: TxClient, id: string): Promise<ChangeRow> {
  const row = await tx.employeeFinancialChange.findUnique({ where: { id }, select: FINANCIAL_CHANGE_SELECT });
  if (!row) throw notFound('طلب التغيير المالي غير موجود');
  return row;
}

// ---------------------------------------------------------------------------------------------------
// requestFinancialChange
// ---------------------------------------------------------------------------------------------------

export interface RequestFinancialChangeInput {
  actor: MoneyActor;
  employeeId: string;
  source: FinancialChangeSource;
  /**
   * First day the change is in force ('YYYY-MM-DD'). Default: today (Riyadh). A new employee's pay: the
   * join date. A bank identity is never earlier than today.
   */
  effectiveDate?: string | null;
  /** The whole compensation asked for (basic + recurring allowances), or nothing. */
  compensation?: { basicSalary: number; allowances: readonly RequestedAllowance[] } | null;
  /** The bank identity asked for, or nothing. */
  bank?: { iban: string | null; bankName: string | null; paymentMethod: PaymentMethod } | null;
  note?: string | null;
  /** The import run the row belongs to (approved together by another person). */
  batchKey?: string | null;
  operationKey: string;
  ipAddress?: string | null;
}

export interface RequestFinancialChangeResult {
  changes: FinancialChangeView[];
  /** Fields left out because the values asked for are the ones in force. */
  unchanged: FinancialChangeField[];
  replayed: boolean;
}

function dayOf(value: string | null | undefined, fallback: string, what: string): string {
  const d = value ?? fallback;
  if (!DAY.test(d)) throw badRequest(`${what}: تاريخ غير صالح`);
  return d;
}

/**
 * Files the request(s) of a pay and / or bank change for one employee (one row per field that really
 * changes). Nothing changes in force: a second person decides (decideFinancialChange).
 */
export async function requestFinancialChange(tx: TxClient, input: RequestFinancialChangeInput): Promise<RequestFinancialChangeResult> {
  assertTransactionClient(tx, 'requestFinancialChange');
  if (!input.compensation && !input.bank) throw badRequest('لا توجد قيمة مالية مطلوب تغييرها');
  if (!(FINANCIAL_CHANGE_SOURCES as readonly string[]).includes(input.source)) throw badRequest('مصدر الطلب غير معروف');
  if (input.source === 'PORTAL') {
    if (input.compensation) throw forbidden('لا يُطلب تغيير الأجر من البوابة الذاتية');
    if (!input.actor.employeeId || input.actor.employeeId !== input.employeeId) throw forbidden('يقدّم الموظف طلب تغيير آيبانه بنفسه فقط');
  }
  const emp = await employeeForCompensation(tx, input.employeeId);
  if (!emp) throw notFound('الموظف غير موجود');
  const companyId = emp.legalCompanyId;
  const today = todayKey();
  const joinKey = emp.joinDate.toISOString().slice(0, 10);

  const outcome = await idempotent(tx, { key: input.operationKey, operation: FINANCIAL_CHANGE_REQUEST.name, actorId: input.actor.id, companyId }, (t) =>
    runMoneyOperation(t, FINANCIAL_CHANGE_REQUEST, { actor: input.actor, input: { employeeId: input.employeeId }, operationKey: input.operationKey, companyId }, async (w, info) => {
      const created: ChangeRow[] = [];
      const unchanged: FinancialChangeField[] = [];
      const pendingOf = (field: FinancialChangeField) => w.employeeFinancialChange.findFirst({ where: { employeeId: input.employeeId, field, status: 'PENDING' }, select: { id: true } });

      if (input.compensation) {
        const effective = dayOf(input.effectiveDate, today, 'تاريخ النفاذ');
        if (effective < joinKey) throw badRequest('تاريخ نفاذ الأجر يسبق تاريخ مباشرة الموظف');
        const basic = roundMoney(input.compensation.basicSalary);
        if (!(basic > 0)) throw badRequest('الراتب الأساسي يجب أن يكون أكبر من صفر');
        const allowances = toPeriodAllowances(input.compensation.allowances);
        const current = await activeAt(w, 'COMPENSATION', input.employeeId, effective);
        const currentValues = current ? { basicSalary: Number(current.attrs.basicSalary), allowances: (current.attrs.allowances ?? []) as CompensationAllowance[] } : null;
        if (currentValues && sameCompensation(currentValues, { basicSalary: basic, allowances })) {
          unchanged.push('COMPENSATION');
        } else {
          if (await pendingOf('COMPENSATION')) throw conflict('يوجد طلب تغيير أجر معلّق لهذا الموظف بانتظار الاعتماد', { code: 'FINANCIAL_CHANGE_PENDING' });
          created.push(
            await w.employeeFinancialChange.create({
              data: {
                employeeId: input.employeeId,
                companyId,
                field: 'COMPENSATION',
                source: input.source,
                status: 'PENDING',
                effectiveDate: new Date(`${effective}T00:00:00.000Z`),
                compensation: { basicSalary: basic, allowances } as unknown as Prisma.InputJsonValue,
                beforeJson: (currentValues ?? undefined) as Prisma.InputJsonValue | undefined,
                note: input.note?.trim() || null,
                batchKey: input.batchKey ?? null,
                requestedById: input.actor.id,
                operationKey: `${input.operationKey}:COMPENSATION`,
              },
              select: FINANCIAL_CHANGE_SELECT,
            }),
          );
        }
      }

      if (input.bank) {
        const effective = dayOf(input.effectiveDate && input.effectiveDate > today ? input.effectiveDate : null, today, 'تاريخ النفاذ');
        const method = input.bank.paymentMethod;
        const iban = method === 'CASH' ? '' : normalizeIban(input.bank.iban ?? '');
        if (method !== 'CASH' && !SAUDI_IBAN_SHAPE.test(iban)) throw badRequest('رقم الآيبان مطلوب للتحويل البنكي (SA متبوعاً بـ 22 خانة)');
        const fingerprint = iban ? ibanFingerprint(iban) : null;
        const bankName = input.bank.bankName?.trim() || null;
        const current = await activeAt(w, 'BANK_IDENTITY', input.employeeId, today);
        const sameIdentity =
          current &&
          current.attrs.paymentMethod === method &&
          ((current.attrs.bankName as string | null) ?? null) === bankName &&
          ((current.attrs.ibanFingerprint as string | null) ?? null) === fingerprint;
        if (sameIdentity) {
          unchanged.push('BANK_IDENTITY');
        } else {
          const hasIbanOnFile = !!current && current.attrs.paymentMethod !== 'CASH' && !!current.attrs.ibanEncrypted;
          const ibanReplaced = hasIbanOnFile && !!fingerprint && fingerprint !== ((current?.attrs.ibanFingerprint as string | null) ?? null);
          if (ibanReplaced && input.source !== 'PORTAL') throw new IbanSelfServiceOnlyError();
          if (await pendingOf('BANK_IDENTITY')) throw conflict('يوجد طلب تغيير آيبان أو طريقة صرف معلّق لهذا الموظف بانتظار الاعتماد', { code: 'FINANCIAL_CHANGE_PENDING' });
          if (input.source === 'PORTAL') {
            // A new request of the employee replaces his migrated legacy one (req-to-be §17 C11).
            await w.employeeFinancialChange.updateMany({
              where: { employeeId: input.employeeId, field: 'BANK_IDENTITY', status: 'LEGACY_UNVERIFIED' },
              data: { status: 'CANCELLED', cancelledById: input.actor.id, cancelledAt: new Date(), cancelReason: 'SUPERSEDED' },
            });
          }
          created.push(
            await w.employeeFinancialChange.create({
              data: {
                employeeId: input.employeeId,
                companyId,
                field: 'BANK_IDENTITY',
                source: input.source,
                status: 'PENDING',
                effectiveDate: new Date(`${effective}T00:00:00.000Z`),
                ibanEncrypted: iban ? encryptField(iban) : null,
                ibanFingerprint: fingerprint,
                ibanLast4: iban ? ibanLast4(iban) : null,
                bankName,
                paymentMethod: method,
                beforeJson: current
                  ? ({ paymentMethod: current.attrs.paymentMethod, bankName: current.attrs.bankName ?? null, ibanMasked: maskedIban(current.attrs.ibanLast4 as string | null) } as Prisma.InputJsonValue)
                  : undefined,
                note: input.note?.trim() || null,
                batchKey: input.batchKey ?? null,
                requestedById: input.actor.id,
                operationKey: `${input.operationKey}:BANK_IDENTITY`,
              },
              select: FINANCIAL_CHANGE_SELECT,
            }),
          );
        }
      }

      for (const c of created) {
        await audit(w, {
          actor: info.auditActor,
          action: FINANCIAL_CHANGE_REQUEST.name,
          entity: { type: 'EmployeeFinancialChange', id: c.id, companyId },
          after: { employeeId: c.employeeId, field: c.field, source: c.source, effectiveDate: c.effectiveDate, compensation: c.compensation, paymentMethod: c.paymentMethod, ibanLast4: c.ibanLast4, bankName: c.bankName },
          operationKey: input.operationKey,
          ipAddress: input.ipAddress ?? null,
        });
        await emitEvent(w, {
          type: 'compensation.financialChange.requested',
          aggregateType: 'EmployeeFinancialChange',
          aggregateId: c.id,
          idempotencyKey: `${input.operationKey}:${c.field}:compensation.financialChange.requested`,
          payload: { changeId: c.id, employeeId: c.employeeId, field: c.field, source: c.source, effectiveDate: c.effectiveDate.toISOString().slice(0, 10) },
          companyId,
          actorId: input.actor.id,
        });
      }
      return { changes: created.map(financialChangeView), unchanged };
    }),
  );
  return { ...(outcome.result as { changes: FinancialChangeView[]; unchanged: FinancialChangeField[] }), replayed: outcome.replayed };
}

// ---------------------------------------------------------------------------------------------------
// decideFinancialChange
// ---------------------------------------------------------------------------------------------------

export interface DecideFinancialChangeInput {
  actor: MoneyActor;
  changeId: string;
  decision: 'APPROVE' | 'REJECT';
  note?: string | null;
  operationKey: string;
  ipAddress?: string | null;
  /**
   * The caller's check that the effective date does not reach into a payroll month already approved
   * (payroll sits above compensation: the route passes payroll's check down). Applied to a pay change only.
   */
  assertEffectiveDateOpen?: (tx: TxClient, employeeId: string, effectiveDate: string) => Promise<void>;
}

export interface DecideFinancialChangeResult {
  change: FinancialChangeView;
  /** The approved change was due and is in force now. */
  applied: boolean;
  selfAct: boolean;
  replayed: boolean;
}

/** The second-person rule of a decision, in the tenant's operator mode (ENFORCED refuses, SINGLE_OPERATOR records). */
function secondPersonDecision(row: ChangeRow, actor: MoneyActor, mode: OperatorMode): GuardDecision {
  const reasons: GuardReason[] = [];
  if ((row.requestedById && row.requestedById === actor.id) || row.legacyFiledByUserIds.includes(actor.id)) reasons.push('SAME_PERSON_TWICE');
  if (actor.employeeId && actor.employeeId === row.employeeId) reasons.push('SELF_BENEFICIARY');
  return decideByMode(reasons, mode);
}

/**
 * The second person approves or rejects a PENDING request. An approval whose effective date has come is
 * applied in the same transaction (applyFinancialChange); a later one waits as PENDING_EFFECT.
 */
export async function decideFinancialChange(tx: TxClient, input: DecideFinancialChangeInput): Promise<DecideFinancialChangeResult> {
  assertTransactionClient(tx, 'decideFinancialChange');
  if (input.decision !== 'APPROVE' && input.decision !== 'REJECT') throw badRequest('القرار غير معروف');
  const row = await loadChange(tx, input.changeId);
  const companyId = row.companyId;
  const outcome = await idempotent(tx, { key: input.operationKey, operation: `compensation.financialChange.${input.decision === 'APPROVE' ? 'decide' : 'reject'}`, actorId: input.actor.id, companyId }, async (t) => {
    if (row.status !== 'PENDING') throw conflict('تم البت في هذا الطلب مسبقاً', { code: 'FINANCIAL_CHANGE_NOT_PENDING', status: row.status });
    const effective = row.effectiveDate.toISOString().slice(0, 10);
    if (input.decision === 'APPROVE' && row.field === 'COMPENSATION' && input.assertEffectiveDateOpen) await input.assertEffectiveDateOpen(t, row.employeeId, effective);
    const mode = await resolveOperatorMode(t, companyId);
    const decision = secondPersonDecision(row, input.actor, mode);
    const op = input.decision === 'APPROVE' ? FINANCIAL_CHANGE_DECIDE : FINANCIAL_CHANGE_REJECT;
    const decided = await runMoneyOperation(t, op, { actor: input.actor, input: { employeeId: row.employeeId }, operationKey: input.operationKey, companyId, decision }, async (w, info) => {
      const now = new Date();
      const moved = await w.employeeFinancialChange.updateMany({
        where: { id: row.id, status: 'PENDING' },
        data: {
          status: input.decision === 'APPROVE' ? 'PENDING_EFFECT' : 'REJECTED',
          decidedById: input.actor.id,
          decidedAt: now,
          decisionNote: input.note?.trim() || null,
          decisionSelfAct: info.selfAct,
        },
      });
      if (moved.count !== 1) throw conflict('تم البت في هذا الطلب مسبقاً', { code: 'FINANCIAL_CHANGE_NOT_PENDING' });
      await audit(w, {
        actor: info.auditActor,
        action: op.name,
        entity: { type: 'EmployeeFinancialChange', id: row.id, companyId },
        before: { status: row.status },
        after: { status: input.decision === 'APPROVE' ? 'PENDING_EFFECT' : 'REJECTED', note: input.note ?? null, selfAct: info.selfAct },
        reason: info.selfAct ? `SELF_ACT_SINGLE_OPERATOR: ${info.reasons.join(',')}` : null,
        operationKey: input.operationKey,
        ipAddress: input.ipAddress ?? null,
      });
      await emitEvent(w, {
        type: 'compensation.financialChange.decided',
        aggregateType: 'EmployeeFinancialChange',
        aggregateId: row.id,
        idempotencyKey: `${input.operationKey}:compensation.financialChange.decided`,
        payload: { changeId: row.id, employeeId: row.employeeId, field: row.field, decision: input.decision, effectiveDate: effective, selfAct: info.selfAct },
        companyId,
        actorId: input.actor.id,
      });
      return { selfAct: info.selfAct };
    });
    let applied = false;
    if (input.decision === 'APPROVE' && effective <= todayKey()) {
      await applyFinancialChange(t, { changeId: row.id, operationKey: `${input.operationKey}:apply`, triggeredById: input.actor.id });
      applied = true;
    }
    return { change: financialChangeView(await loadChange(t, row.id)), applied, selfAct: decided.selfAct };
  });
  return { ...(outcome.result as Omit<DecideFinancialChangeResult, 'replayed'>), replayed: outcome.replayed };
}

// ---------------------------------------------------------------------------------------------------
// applyFinancialChange (SYSTEM)
// ---------------------------------------------------------------------------------------------------

export interface ApplyFinancialChangeInput {
  changeId: string;
  operationKey: string;
  /** The decider (recorded on the period), or null for the job. */
  triggeredById?: string | null;
  /** The application day ('YYYY-MM-DD', default today in Riyadh; the job passes its business day). */
  today?: string;
}

/**
 * A decided change whose effective date has come: the pay through compensation.applyDecision (period
 * from the effective date) or the bank identity through compensation.applyBankIdentity (from today).
 * PENDING_EFFECT → APPLIED once; a change in any other state is refused (409), a repeat key replays.
 */
export async function applyFinancialChange(tx: TxClient, input: ApplyFinancialChangeInput): Promise<{ change: FinancialChangeView; replayed: boolean }> {
  assertTransactionClient(tx, 'applyFinancialChange');
  const row = await loadChange(tx, input.changeId);
  const companyId = row.companyId;
  const outcome = await idempotent(tx, { key: input.operationKey, operation: FINANCIAL_CHANGE_APPLY.name, actorId: input.triggeredById ?? null, companyId }, async (t) => {
    if (row.status !== 'PENDING_EFFECT') throw conflict('طلب التغيير المالي ليس بانتظار التطبيق', { code: 'FINANCIAL_CHANGE_NOT_DUE', status: row.status });
    const effective = row.effectiveDate.toISOString().slice(0, 10);
    const today = input.today ?? todayKey();
    if (today < todayKey()) throw conflict('لا يُطبَّق طلب التغيير المالي بتاريخ سابق ليوم تطبيقه', { code: 'FINANCIAL_CHANGE_NOT_DUE' });
    if (effective > today) throw conflict('لم يحن تاريخ نفاذ طلب التغيير المالي بعد', { code: 'FINANCIAL_CHANGE_NOT_DUE' });
    const source = { type: 'FINANCIAL_CHANGE', id: row.id };
    const trigger = input.triggeredById ?? row.decidedById ?? null;
    let compensationPeriodId: string | null = null;
    let bankIdentityPeriodId: string | null = null;
    if (row.field === 'COMPENSATION') {
      const comp = row.compensation as unknown as { basicSalary: number; allowances: CompensationAllowance[] };
      const r = await applyDecision(t, {
        employeeId: row.employeeId,
        effectiveDate: effective,
        attrs: { basicSalary: Number(comp.basicSalary), allowances: comp.allowances ?? [], gosiBaseOverride: null },
        source,
        triggeredById: trigger,
        companyId,
        operationKey: `${input.operationKey}:period`,
      });
      compensationPeriodId = r.period.id;
    } else {
      const full = await t.employeeFinancialChange.findUniqueOrThrow({ where: { id: row.id }, select: { ibanEncrypted: true, ibanFingerprint: true } });
      const r = await applyBankIdentity(t, {
        employeeId: row.employeeId,
        attrs: {
          paymentMethod: row.paymentMethod as 'CASH' | 'BANK_TRANSFER' | 'WPS',
          ibanEncrypted: full.ibanEncrypted,
          ibanFingerprint: full.ibanFingerprint,
          ibanLast4: row.ibanLast4,
          bankName: row.bankName,
        },
        source,
        triggeredById: trigger,
        companyId,
        operationKey: `${input.operationKey}:bank`,
        today,
      });
      bankIdentityPeriodId = r.period.id;
    }
    await runMoneyOperation(t, FINANCIAL_CHANGE_APPLY, { actor: null, input: { employeeId: row.employeeId }, operationKey: input.operationKey, companyId }, async (w, info) => {
      const moved = await w.employeeFinancialChange.updateMany({
        where: { id: row.id, status: 'PENDING_EFFECT' },
        data: { status: 'APPLIED', appliedAt: new Date(), compensationPeriodId, bankIdentityPeriodId },
      });
      if (moved.count !== 1) throw conflict('طلب التغيير المالي ليس بانتظار التطبيق', { code: 'FINANCIAL_CHANGE_NOT_DUE' });
      await audit(w, {
        actor: info.auditActor,
        action: FINANCIAL_CHANGE_APPLY.name,
        entity: { type: 'EmployeeFinancialChange', id: row.id, companyId },
        before: { status: 'PENDING_EFFECT' },
        after: { status: 'APPLIED', compensationPeriodId, bankIdentityPeriodId },
        operationKey: input.operationKey,
      });
      await emitEvent(w, {
        type: 'compensation.financialChange.applied',
        aggregateType: 'EmployeeFinancialChange',
        aggregateId: row.id,
        idempotencyKey: `${input.operationKey}:compensation.financialChange.applied`,
        payload: { changeId: row.id, employeeId: row.employeeId, field: row.field, effectiveDate: effective, compensationPeriodId, bankIdentityPeriodId },
        companyId,
        actorId: trigger,
      });
    });
    return { change: financialChangeView(await loadChange(t, row.id)) };
  });
  return { ...(outcome.result as { change: FinancialChangeView }), replayed: outcome.replayed };
}

// ---------------------------------------------------------------------------------------------------
// cancelFinancialChange, confirmLegacyFinancialChange
// ---------------------------------------------------------------------------------------------------

export interface CancelFinancialChangeInput {
  actor: MoneyActor;
  changeId: string;
  reason?: string | null;
  operationKey: string;
  ipAddress?: string | null;
}

/** A request not applied yet is withdrawn (the caller checks who may: the requester, the employee, or HR). */
export async function cancelFinancialChange(tx: TxClient, input: CancelFinancialChangeInput): Promise<{ change: FinancialChangeView; replayed: boolean }> {
  assertTransactionClient(tx, 'cancelFinancialChange');
  const row = await loadChange(tx, input.changeId);
  const outcome = await idempotent(tx, { key: input.operationKey, operation: FINANCIAL_CHANGE_CANCEL.name, actorId: input.actor.id, companyId: row.companyId }, (t) =>
    runMoneyOperation(t, FINANCIAL_CHANGE_CANCEL, { actor: input.actor, input: { employeeId: row.employeeId }, operationKey: input.operationKey, companyId: row.companyId }, async (w, info) => {
      const moved = await w.employeeFinancialChange.updateMany({
        where: { id: row.id, status: { in: [...OPEN_FINANCIAL_CHANGE_STATUSES] } },
        data: { status: 'CANCELLED', cancelledById: input.actor.id, cancelledAt: new Date(), cancelReason: input.reason?.trim() || 'CANCELLED' },
      });
      if (moved.count !== 1) throw conflict('لا يمكن إلغاء طلب طُبِّق أو بُتّ فيه', { code: 'FINANCIAL_CHANGE_CLOSED', status: row.status });
      await audit(w, {
        actor: info.auditActor,
        action: FINANCIAL_CHANGE_CANCEL.name,
        entity: { type: 'EmployeeFinancialChange', id: row.id, companyId: row.companyId },
        before: { status: row.status },
        after: { status: 'CANCELLED', reason: input.reason ?? null },
        operationKey: input.operationKey,
        ipAddress: input.ipAddress ?? null,
      });
      return { change: financialChangeView(await loadChange(w, row.id)) };
    }),
  );
  return { ...(outcome.result as { change: FinancialChangeView }), replayed: outcome.replayed };
}

/**
 * The employee confirms, from his portal and after seeing the full IBAN, a migrated LEGACY_UNVERIFIED IBAN
 * request: it becomes his own PENDING request (requestedById = him), decided by a second person who is
 * not among the original filers (req-to-be §17 C11, RT-REQ-201).
 */
export async function confirmLegacyFinancialChange(
  tx: TxClient,
  input: { actor: MoneyActor; changeId: string; operationKey: string; ipAddress?: string | null },
): Promise<{ change: FinancialChangeView; replayed: boolean }> {
  assertTransactionClient(tx, 'confirmLegacyFinancialChange');
  const row = await loadChange(tx, input.changeId);
  const outcome = await idempotent(tx, { key: input.operationKey, operation: `${FINANCIAL_CHANGE_CANCEL.name}.confirmLegacy`, actorId: input.actor.id, companyId: row.companyId }, (t) =>
    runMoneyOperation(t, FINANCIAL_CHANGE_CANCEL, { actor: input.actor, input: { employeeId: row.employeeId }, operationKey: input.operationKey, companyId: row.companyId }, async (w, info) => {
      if (!input.actor.employeeId || input.actor.employeeId !== row.employeeId) throw forbidden('يؤكد الموظف طلب آيبانه بنفسه فقط');
      if (row.status !== 'LEGACY_UNVERIFIED') throw conflict('هذا الطلب لا ينتظر تأكيدك', { code: 'FINANCIAL_CHANGE_NOT_LEGACY' });
      if (await w.employeeFinancialChange.findFirst({ where: { employeeId: row.employeeId, field: 'BANK_IDENTITY', status: 'PENDING' }, select: { id: true } })) {
        throw conflict('يوجد طلب تغيير آيبان معلّق آخر بانتظار الاعتماد', { code: 'FINANCIAL_CHANGE_PENDING' });
      }
      const moved = await w.employeeFinancialChange.updateMany({
        where: { id: row.id, status: 'LEGACY_UNVERIFIED' },
        data: { status: 'PENDING', requestedById: input.actor.id, requestedAt: new Date(), effectiveDate: new Date(`${todayKey()}T00:00:00.000Z`) },
      });
      if (moved.count !== 1) throw conflict('هذا الطلب لا ينتظر تأكيدك', { code: 'FINANCIAL_CHANGE_NOT_LEGACY' });
      await audit(w, {
        actor: info.auditActor,
        action: 'compensation.financialChange.confirmLegacy',
        entity: { type: 'EmployeeFinancialChange', id: row.id, companyId: row.companyId },
        before: { status: 'LEGACY_UNVERIFIED' },
        after: { status: 'PENDING', requestedById: input.actor.id },
        operationKey: input.operationKey,
        ipAddress: input.ipAddress ?? null,
      });
      return { change: financialChangeView(await loadChange(w, row.id)) };
    }),
  );
  return { ...(outcome.result as { change: FinancialChangeView }), replayed: outcome.replayed };
}

// ---------------------------------------------------------------------------------------------------
// Exit (consumer of employment.terminated, ARC-PAY-A2)
// ---------------------------------------------------------------------------------------------------

/**
 * The employee's employment ended on `lastWorkingDay`: his pay changes that would start after it (still
 * waiting for a decision or for their date) are cancelled. Bank changes stay (the settlement pays to the
 * bank identity). SYSTEM operation; idempotent by nature (only open rows move).
 */
export async function cancelFinancialChangesAfterExit(
  tx: TxClient,
  input: { employeeId: string; lastWorkingDay: string; operationKey: string },
): Promise<{ cancelled: number }> {
  assertTransactionClient(tx, 'cancelFinancialChangesAfterExit');
  if (!DAY.test(input.lastWorkingDay)) throw badRequest('lastWorkingDay must be YYYY-MM-DD');
  return runMoneyOperation(tx, FINANCIAL_CHANGE_EXIT_CANCEL, { actor: null, input: { employeeId: input.employeeId }, operationKey: input.operationKey }, async (w, info) => {
    const after = new Date(`${input.lastWorkingDay}T00:00:00.000Z`);
    const rows = await w.employeeFinancialChange.findMany({
      where: { employeeId: input.employeeId, field: 'COMPENSATION', status: { in: ['PENDING', 'PENDING_EFFECT'] }, effectiveDate: { gt: after } },
      select: { id: true, companyId: true, status: true },
    });
    if (!rows.length) return { cancelled: 0 };
    const res = await w.employeeFinancialChange.updateMany({
      where: { id: { in: rows.map((r) => r.id) }, status: { in: ['PENDING', 'PENDING_EFFECT'] } },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'EMPLOYMENT_ENDED' },
    });
    for (const r of rows) {
      await audit(w, {
        actor: info.auditActor,
        action: FINANCIAL_CHANGE_EXIT_CANCEL.name,
        entity: { type: 'EmployeeFinancialChange', id: r.id, companyId: r.companyId },
        before: { status: r.status },
        after: { status: 'CANCELLED', reason: 'EMPLOYMENT_ENDED', lastWorkingDay: input.lastWorkingDay },
        operationKey: input.operationKey,
      });
    }
    return { cancelled: res.count };
  });
}
