// compensation.applyDecision and compensation.applyBankIdentity (SOURCE_OF_TRUTH: the sole writers of
// CompensationPeriod / BankIdentityPeriod, through platform/effective, ARCH-012 / ARCH-021) and the
// projector of the Employee pay columns (ARC-PAY-A4: basicSalary, the recurring Allowance rows, the
// bank columns, payrollReady are written here and nowhere else).
//
// Both are SYSTEM operations behind money.gateway: the two-person rule was applied by the decision that
// calls them (an EmployeeFinancialChange decided by a second person, a decision letter approved by two
// people). Idempotent per operation key (OperationLog replays the result). The employee row is locked
// first (ADR-0002 #2): two applications for one employee never interleave.
//
//   applyDecision      the compensation in force FROM the effective date: the period covering that day is
//                      ended at it (or replaced when it starts that very day) and a new period runs to the
//                      start of the next one (or open). Back-dating is allowed (a correction); the caller
//                      refuses a date inside a payroll month already approved (no retro path before
//                      BL-PAY-008b).
//   applyBankIdentity  the bank identity FROM THE DAY IT IS APPLIED, never earlier (ADR-0001 #8).
//   applyChangeOrderPay the pay part of an approved promotion / raise decision on its effective date.
import { randomUUID } from 'node:crypto';
import type { PaymentMethod } from '@prisma/client';
import { decryptField } from '@/lib/crypto';
import { todayKey } from '@/lib/dates';
import { conflict } from '@/lib/http';
import { roundMoney } from '@/lib/money';
import { employeeForCompensation, lockEmployees } from '@/modules/people';
import {
  activeAt,
  assertTransactionClient,
  audit,
  closePeriod,
  emitEvent,
  idempotent,
  openPeriod,
  periodsOf,
  runMoneyOperation,
  supersedePeriod,
  toDateOnly,
  type AuditActor,
  type BankIdentityAttrs,
  type CompensationAllowance,
  type CompensationAttrs,
  type DateOnly,
  type PeriodOp,
  type PeriodView,
  type TxClient,
} from '@/modules/platform';
import { BANK_IDENTITY_OPENED_EVENT } from '../model';
import { BANK_IDENTITY_APPLY, COMPENSATION_APPLY } from '../operations';

export interface PeriodSource {
  /** FINANCIAL_CHANGE | CHANGE_ORDER | … (UPPER_SNAKE_CASE, platform/effective). */
  type: string;
  id: string;
}

export interface ApplyDecisionInput {
  employeeId: string;
  /** First day the compensation is in force ('YYYY-MM-DD'). */
  effectiveDate: DateOnly;
  /** The whole compensation from that day (basic + the recurring allowances). */
  attrs: CompensationAttrs;
  source: PeriodSource;
  /** The person behind the decision (the second person, the issuer of the letter), recorded; null for a job. */
  triggeredById: string | null;
  companyId?: string | null;
  operationKey: string;
}

export interface ApplyBankIdentityInput {
  employeeId: string;
  attrs: BankIdentityAttrs;
  source: PeriodSource;
  triggeredById: string | null;
  companyId?: string | null;
  operationKey: string;
  /** The application day (default: today in Riyadh). Never earlier than today. */
  today?: string;
}

const actorOf = (userId: string | null): AuditActor => (userId ? { type: 'USER', id: userId } : { type: 'SYSTEM', id: COMPENSATION_APPLY.name });

/** Every allowance of a new period carries the id of its projection row (new ones get a fresh id). */
function withAllowanceIds(attrs: CompensationAttrs): CompensationAttrs {
  return {
    basicSalary: roundMoney(attrs.basicSalary),
    gosiBaseOverride: attrs.gosiBaseOverride ?? null,
    allowances: attrs.allowances.map((a) => ({ ...a, amount: roundMoney(a.amount), allowanceId: a.allowanceId ?? randomUUID() })),
  };
}

/** Opens the compensation in force from `day` (see the header). Returns the active row starting that day. */
async function openCompensationFrom(
  tx: TxClient,
  employeeId: string,
  day: string,
  attrs: CompensationAttrs,
  source: PeriodSource,
  op: PeriodOp,
): Promise<PeriodView<'COMPENSATION'>> {
  const rows = await periodsOf(tx, 'COMPENSATION', employeeId);
  const covering = rows.find((r) => r.validFrom <= day && (r.validTo === null || r.validTo > day));
  const next = rows.find((r) => r.validFrom > day);
  if (covering && covering.validFrom === day) {
    const r = await supersedePeriod(tx, 'COMPENSATION', covering.id, { reason: 'CORRECTION', source, successor: { attrs } }, op);
    return r.successor as PeriodView<'COMPENSATION'>;
  }
  const end = next ? next.validFrom : covering ? covering.validTo : null;
  if (covering) await closePeriod(tx, 'COMPENSATION', covering.id, { validTo: day, source }, op);
  return (await openPeriod(tx, 'COMPENSATION', { employeeId, validFrom: day, validTo: end, source, attrs }, op)).period;
}

// ---------------------------------------------------------------------------------------------------
// The projector (ARC-PAY-A4)
// ---------------------------------------------------------------------------------------------------

/** The period shown on the file: the one in force today, else the latest one that started, else the first one. */
function displayed<K extends 'COMPENSATION' | 'BANK_IDENTITY'>(rows: PeriodView<K>[], day: string): PeriodView<K> | null {
  const inForce = rows.find((r) => r.validFrom <= day && (r.validTo === null || r.validTo > day));
  if (inForce) return inForce;
  const started = rows.filter((r) => r.validFrom <= day);
  return started.length ? started[started.length - 1] : (rows[0] ?? null);
}

/**
 * Writes the Employee pay projection from the facts: basicSalary and the recurring Allowance rows from the
 * compensation shown on the file, the bank columns from the bank identity, and payrollReady once both are
 * there (it never goes back to false: a legacy employee stays ready, DEC-PO-017 / LEGACY_READY). Must run
 * inside COMPENSATION_APPLY or BANK_IDENTITY_APPLY (their contexts allow exactly these columns).
 */
async function projectEmployeePay(tx: TxClient, employeeId: string, day: string, what: { compensation: boolean; bank: boolean }): Promise<Record<string, unknown>> {
  const [comps, banks, emp] = await Promise.all([
    periodsOf(tx, 'COMPENSATION', employeeId),
    periodsOf(tx, 'BANK_IDENTITY', employeeId),
    employeeForCompensation(tx, employeeId),
  ]);
  if (!emp) throw conflict('الموظف غير موجود');
  const comp = displayed(comps, day);
  const bank = displayed(banks, day);
  let basicSalary: number | undefined;
  let ibanNumber: string | null | undefined;
  let bankName: string | null | undefined;
  let salaryPaymentMethod: PaymentMethod | undefined;
  let payrollReady: true | undefined;
  if (what.compensation && comp) {
    const basic = Number(comp.attrs.basicSalary);
    if (roundMoney(emp.basicSalary) !== basic) basicSalary = basic;
    await syncRecurringAllowances(tx, employeeId, (comp.attrs.allowances ?? []) as CompensationAllowance[]);
  }
  if (what.bank && bank) {
    const iban = bank.attrs.paymentMethod === 'CASH' ? null : readable(bank.attrs.ibanEncrypted as string | null);
    if ((emp.ibanNumber ?? null) !== iban) ibanNumber = iban;
    const name = (bank.attrs.bankName as string | null) ?? null;
    if ((emp.bankName ?? null) !== name) bankName = name;
    if (emp.salaryPaymentMethod !== bank.attrs.paymentMethod) salaryPaymentMethod = bank.attrs.paymentMethod as PaymentMethod;
  }
  const bankReady = bank ? bank.attrs.paymentMethod === 'CASH' || !!bank.attrs.ibanEncrypted : false;
  if (!emp.payrollReady && comps.length > 0 && bankReady) payrollReady = true;
  const changed = { basicSalary, ibanNumber, bankName, salaryPaymentMethod, payrollReady };
  const projected = Object.fromEntries(Object.entries(changed).filter(([, v]) => v !== undefined));
  if (Object.keys(projected).length) {
    await tx.employee.update({ where: { id: employeeId }, data: { basicSalary, ibanNumber, bankName, salaryPaymentMethod, payrollReady }, select: { id: true } });
  }
  return projected;
}

/** The projection keeps the IBAN as the file always showed it (plaintext; the fact holds it encrypted). */
function readable(value: string | null): string | null {
  if (!value) return null;
  try {
    return decryptField(value);
  } catch {
    return value;
  }
}

/** The recurring Allowance rows mirror the period's allowances (one row per item, id = allowanceId). */
async function syncRecurringAllowances(tx: TxClient, employeeId: string, items: readonly CompensationAllowance[]): Promise<void> {
  const rows = await tx.allowance.findMany({ where: { employeeId, isMonthly: true }, select: { id: true, name: true, amount: true, countsTowardGosi: true, allowanceType: true } });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const keep = new Set<string>();
  const now = new Date();
  for (const item of items) {
    const id = item.allowanceId ?? null;
    const type = item.allowanceType ?? (item.line === 'OTHER' ? null : item.line);
    const row = id ? byId.get(id) : undefined;
    if (row) {
      keep.add(row.id);
      if (row.name !== item.name || roundMoney(row.amount) !== roundMoney(item.amount) || row.countsTowardGosi !== item.countsTowardGosi || (row.allowanceType ?? null) !== type) {
        await tx.allowance.update({ where: { id: row.id }, data: { name: item.name, amount: roundMoney(item.amount), countsTowardGosi: item.countsTowardGosi, allowanceType: type } });
      }
      continue;
    }
    const created = await tx.allowance.create({
      data: {
        ...(id ? { id } : {}),
        employeeId,
        name: item.name,
        amount: roundMoney(item.amount),
        isMonthly: true,
        countsTowardGosi: item.countsTowardGosi,
        allowanceType: type,
        status: 'APPROVED',
        approvedAt: now,
      },
      select: { id: true },
    });
    keep.add(created.id);
  }
  const drop = rows.filter((r) => !keep.has(r.id)).map((r) => r.id);
  if (drop.length) await tx.allowance.deleteMany({ where: { id: { in: drop }, isMonthly: true } });
}

// ---------------------------------------------------------------------------------------------------
// applyDecision
// ---------------------------------------------------------------------------------------------------

export interface ApplyDecisionResult {
  period: PeriodView<'COMPENSATION'>;
  projected: Record<string, unknown>;
  replayed: boolean;
}

/**
 * compensation.applyDecision: the compensation `attrs` in force from `effectiveDate` (a new period, or the
 * replacement of the one starting that day), then the projection. SYSTEM operation; a repeat with the same
 * key replays the result.
 */
export async function applyDecision(tx: TxClient, input: ApplyDecisionInput): Promise<ApplyDecisionResult> {
  assertTransactionClient(tx, 'applyDecision');
  const day = toDateOnly(input.effectiveDate, 'effectiveDate').toISOString().slice(0, 10);
  const companyId = input.companyId ?? null;
  const outcome = await idempotent(tx, { key: input.operationKey, operation: COMPENSATION_APPLY.name, actorId: input.triggeredById, companyId }, (t) =>
    runMoneyOperation(t, COMPENSATION_APPLY, { actor: input.triggeredById ? { id: input.triggeredById, employeeId: null } : null, input: { employeeId: input.employeeId }, operationKey: input.operationKey, companyId }, async (w) => {
      await lockEmployees(w, [input.employeeId], 'ALL');
      const attrs = withAllowanceIds(input.attrs);
      const op: PeriodOp = { key: input.operationKey, actor: actorOf(input.triggeredById), companyId };
      const period = await openCompensationFrom(w, input.employeeId, day, attrs, input.source, op);
      const projected = await projectEmployeePay(w, input.employeeId, todayKey(), { compensation: true, bank: false });
      await audit(w, {
        actor: actorOf(input.triggeredById),
        action: COMPENSATION_APPLY.name,
        entity: { type: 'Employee', id: input.employeeId, companyId },
        after: { periodId: period.id, validFrom: period.validFrom, validTo: period.validTo, source: input.source, basicSalary: attrs.basicSalary, allowances: attrs.allowances.length, projected: Object.keys(projected) },
        operationKey: input.operationKey,
      });
      // The period events (compensation.periodOpened / periodClosed / periodSuperseded) are written by
      // platform/effective in this transaction; payroll consumes them (payroll.compensation).
      return { period, projected };
    }),
  );
  return { ...(outcome.result as { period: PeriodView<'COMPENSATION'>; projected: Record<string, unknown> }), replayed: outcome.replayed };
}

// ---------------------------------------------------------------------------------------------------
// applyBankIdentity
// ---------------------------------------------------------------------------------------------------

export interface ApplyBankIdentityResult {
  period: PeriodView<'BANK_IDENTITY'>;
  projected: Record<string, unknown>;
  replayed: boolean;
}

/** compensation.applyBankIdentity: the bank identity from the application day (ADR-0001 #8), then the projection. */
export async function applyBankIdentity(tx: TxClient, input: ApplyBankIdentityInput): Promise<ApplyBankIdentityResult> {
  assertTransactionClient(tx, 'applyBankIdentity');
  const day = input.today ?? todayKey();
  if (day < todayKey()) throw conflict('الهوية البنكية لا تُطبَّق بتاريخ سابق ليوم تطبيقها');
  const companyId = input.companyId ?? null;
  const outcome = await idempotent(tx, { key: input.operationKey, operation: BANK_IDENTITY_APPLY.name, actorId: input.triggeredById, companyId }, (t) =>
    runMoneyOperation(t, BANK_IDENTITY_APPLY, { actor: input.triggeredById ? { id: input.triggeredById, employeeId: null } : null, input: { employeeId: input.employeeId }, operationKey: input.operationKey, companyId }, async (w) => {
      await lockEmployees(w, [input.employeeId], 'ALL');
      const op: PeriodOp = { key: input.operationKey, actor: actorOf(input.triggeredById), companyId };
      // Every column given (a successor of a CORRECTION copies what is not given: a CASH identity must not keep an IBAN).
      const attrs: BankIdentityAttrs = {
        paymentMethod: input.attrs.paymentMethod,
        ibanEncrypted: input.attrs.ibanEncrypted ?? null,
        ibanFingerprint: input.attrs.ibanFingerprint ?? null,
        ibanLast4: input.attrs.ibanLast4 ?? null,
        bankName: input.attrs.bankName ?? null,
      };
      const current = await activeAt(w, 'BANK_IDENTITY', input.employeeId, day);
      let period: PeriodView<'BANK_IDENTITY'>;
      if (current && current.validFrom === day) {
        period = (await supersedePeriod(w, 'BANK_IDENTITY', current.id, { reason: 'CORRECTION', source: input.source, successor: { attrs } }, op)).successor as PeriodView<'BANK_IDENTITY'>;
      } else {
        if (current) await closePeriod(w, 'BANK_IDENTITY', current.id, { validTo: day, source: input.source }, op);
        period = (await openPeriod(w, 'BANK_IDENTITY', { employeeId: input.employeeId, validFrom: day, validTo: null, source: input.source, attrs }, op)).period;
      }
      const projected = await projectEmployeePay(w, input.employeeId, todayKey(), { compensation: false, bank: true });
      await audit(w, {
        actor: actorOf(input.triggeredById),
        action: BANK_IDENTITY_APPLY.name,
        entity: { type: 'Employee', id: input.employeeId, companyId },
        after: { periodId: period.id, validFrom: period.validFrom, source: input.source, paymentMethod: input.attrs.paymentMethod, ibanLast4: input.attrs.ibanLast4 ?? null, projected: Object.keys(projected) },
        operationKey: input.operationKey,
      });
      await emitEvent(w, {
        type: BANK_IDENTITY_OPENED_EVENT,
        aggregateType: 'Employee',
        aggregateId: input.employeeId,
        idempotencyKey: `${input.operationKey}:${BANK_IDENTITY_OPENED_EVENT}`,
        payload: { employeeId: input.employeeId, periodId: period.id, validFrom: period.validFrom, paymentMethod: input.attrs.paymentMethod, ibanLast4: input.attrs.ibanLast4 ?? null, source: input.source },
        companyId,
        actorId: input.triggeredById,
        effectiveDate: toDateOnly(period.validFrom),
      });
      return { period, projected };
    }),
  );
  return { ...(outcome.result as { period: PeriodView<'BANK_IDENTITY'>; projected: Record<string, unknown> }), replayed: outcome.replayed };
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
  /** Monthly allowances to set: the projection row the caller found for the kind (its allowanceId in the period), or a new one. */
  allowances: readonly { kind: 'HOUSING' | 'TRANSPORT'; rowId: string | null; amount: number }[];
  /** The user who issued the order, or null for the job. */
  triggeredById: string | null;
}

/** The Riyadh calendar day of a stored effective date (orders store Riyadh midnight as a timestamp). */
function riyadhDay(d: Date): string {
  return new Date(d.getTime() + 3 * 3600e3).toISOString().slice(0, 10);
}

/**
 * The pay part of an approved decision on its effective date: the compensation in force on that day with
 * the order's basic salary and housing / transport amounts, applied through applyDecision (source
 * CHANGE_ORDER), plus the SalaryChange history row. Guarded by the order's own applied-once flag (the
 * caller's transaction); a repeat replays (same operation key).
 */
export async function applyChangeOrderPay(tx: TxClient, input: ChangeOrderPayInput): Promise<{ allowances: Record<string, { from: number; to: number }>; replayed: boolean }> {
  assertTransactionClient(tx, 'applyChangeOrderPay');
  const day = riyadhDay(input.effectiveDate);
  const current = await activeAt(tx, 'COMPENSATION', input.employeeId, day);
  if (!current) throw conflict('لا توجد فترة أجر نافذة في تاريخ نفاذ القرار؛ يلزم تسجيل أجر الموظف أولاً');
  const allowances = ((current.attrs.allowances ?? []) as CompensationAllowance[]).map((a) => ({ ...a }));
  const changed: Record<string, { from: number; to: number }> = {};
  for (const a of input.allowances) {
    const byRow = a.rowId ? allowances.findIndex((x) => x.allowanceId === a.rowId) : -1;
    if (byRow >= 0 && allowances[byRow].line !== a.kind) throw conflict('بدل الموظف تغيّر قبل تطبيق القرار');
    const at = byRow >= 0 ? byRow : allowances.findIndex((x) => x.line === a.kind);
    if (at >= 0) {
      changed[a.kind] = { from: allowances[at].amount, to: roundMoney(a.amount) };
      allowances[at] = { ...allowances[at], amount: roundMoney(a.amount) };
    } else {
      changed[a.kind] = { from: 0, to: roundMoney(a.amount) };
      allowances.push({ name: a.kind === 'HOUSING' ? 'بدل سكن' : 'بدل نقل', line: a.kind, allowanceType: a.kind, amount: roundMoney(a.amount), countsTowardGosi: a.kind === 'HOUSING' });
    }
  }
  const basic = input.basicSalary !== null ? roundMoney(input.basicSalary) : Number(current.attrs.basicSalary);
  const key = `changeOrder:${input.orderId}:pay`;
  const r = await applyDecision(tx, {
    employeeId: input.employeeId,
    effectiveDate: day,
    attrs: { basicSalary: basic, allowances, gosiBaseOverride: (current.attrs.gosiBaseOverride as number | null) ?? null },
    source: { type: 'CHANGE_ORDER', id: input.orderId },
    triggeredById: input.triggeredById,
    operationKey: key,
  });
  if (input.basicSalary !== null && !r.replayed) {
    // The salary history the file shows (SalaryChange), written with the period in the same operation.
    await runMoneyOperation(tx, COMPENSATION_APPLY, { actor: null, input: { employeeId: input.employeeId }, operationKey: `${key}:history` }, (w) =>
      w.salaryChange.create({
        data: { employeeId: input.employeeId, effectiveDate: input.effectiveDate, basicSalary: basic, reason: `قرار ترقية/زيادة (${input.documentId})`, isPlanned: false, createdById: input.triggeredById },
      }),
    );
  }
  return { allowances: changed, replayed: r.replayed };
}
