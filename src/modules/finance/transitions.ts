// finance transitions (P1-PAY-A): the sole writer of PaymentRequest, every write behind its money.gateway
// operation (./operations). A user transition takes an operation key (OperationLog: a repeat replays),
// is guarded (updateMany where status = FROM) and writes audit + event in the caller's transaction.
//
// Segregation (pay-to-be BR-PAY-001 / 002, DEC-PO-005, BL-PAY-008): the approver is not the requester
// nor the beneficiary; the payer is not the beneficiary, the requester nor the approver; a request with
// neither a recorded requester nor approver is not paid before a second person attests it (BR-PAY-015,
// BL-PAY-009). No role and no setting is an exception; SINGLE_OPERATOR records the act (BR-PAY-020).
import type { PaymentStatus, Prisma } from '@prisma/client';
import { badRequest, conflict, notFound } from '@/lib/http';
import { roundMoney } from '@/lib/money';
import {
  assertTransactionClient,
  audit,
  decideMakerChecker,
  emitEvent,
  idempotent,
  resolveOperatorMode,
  runMoneyOperation,
  type MoneyActor,
  type MoneyRunInfo,
  type TxClient,
} from '@/modules/platform';
import { PAYMENT_APPROVE, PAYMENT_CLOSE_LINKED, PAYMENT_CREATE, PAYMENT_DELETE, PAYMENT_EDIT, PAYMENT_PAY, PAYMENT_RETURN } from './operations';

const OPEN: PaymentStatus[] = ['PENDING_OWNER', 'PENDING_FINANCE'];

type PaymentRow = Prisma.PaymentRequestGetPayload<Record<string, never>>;

async function recordAndEmit(
  w: TxClient,
  info: MoneyRunInfo,
  input: { operationKey: string; ipAddress?: string | null; companyId?: string | null },
  row: { id: string; status: string; amount: number; entityType: string | null; entityId: string | null },
  event: string,
  before: unknown,
  after: unknown,
) {
  await audit(w, {
    actor: info.auditActor,
    action: info.operation,
    entity: { type: 'PaymentRequest', id: row.id, companyId: input.companyId ?? null },
    before,
    after,
    operationKey: input.operationKey,
    ipAddress: input.ipAddress ?? null,
    reason: info.selfAct ? `SELF_ACT_SINGLE_OPERATOR: ${info.reasons.join(',')}` : null,
  });
  await emitEvent(w, {
    type: `finance.paymentRequest.${event}`,
    aggregateType: 'PaymentRequest',
    aggregateId: row.id,
    idempotencyKey: `${input.operationKey}:finance.paymentRequest.${event}`,
    payload: { paymentRequestId: row.id, status: row.status, amount: row.amount, entityType: row.entityType, entityId: row.entityId },
    companyId: input.companyId ?? null,
    actorId: info.actorUserId,
  });
}

async function guardFailed(w: TxClient, id: string, message: string): Promise<never> {
  const exists = await w.paymentRequest.findUnique({ where: { id }, select: { id: true } });
  if (!exists) throw notFound('طلب السداد غير موجود');
  throw conflict(message);
}

export interface CreatePaymentRequestInput {
  actor: MoneyActor;
  title: string;
  reason?: string | null;
  amount: number;
  accountNumber?: string | null;
  receiptUrl?: string | null;
  /** PENDING_OWNER (needs the owner's approval) or PENDING_FINANCE (already approved by its record's own flow). */
  status: 'PENDING_OWNER' | 'PENDING_FINANCE';
  entityType?: string | null;
  entityId?: string | null;
  documentType?: string | null;
  /** The employee the money goes to (the caller knows its linked record), else null. */
  beneficiaryEmployeeId?: string | null;
  /** Who filed it (default the actor): a settlement's request is filed by its HR creator (BR-PAY-012). */
  requestedById?: string | null;
  /** Set when the record's own approval stands for the owner's (a settlement approved by the owner). */
  approvedById?: string | null;
  companyId?: string | null;
  operationKey: string;
  ipAddress?: string | null;
}

/** Files a payment request (the requester is recorded for the maker-checker). Replays for the same key. */
export async function createPaymentRequest(tx: TxClient, input: CreatePaymentRequestInput): Promise<PaymentRow> {
  assertTransactionClient(tx, 'createPaymentRequest');
  const amount = roundMoney(input.amount);
  if (!Number.isFinite(amount) || amount < 0) throw badRequest('مبلغ طلب السداد غير صالح');
  const outcome = await idempotent(tx, { key: input.operationKey, operation: PAYMENT_CREATE.name, actorId: input.actor.id, companyId: input.companyId ?? null }, (t) =>
    runMoneyOperation(t, PAYMENT_CREATE, { actor: input.actor, input: { beneficiaryEmployeeId: input.beneficiaryEmployeeId ?? null }, operationKey: input.operationKey, companyId: input.companyId }, async (w, info) => {
      const approvedById = input.approvedById ?? null;
      const row = await w.paymentRequest.create({
        data: {
          title: input.title,
          reason: input.reason ?? null,
          amount,
          accountNumber: input.accountNumber ?? null,
          receiptUrl: input.receiptUrl ?? null,
          status: input.status,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          documentType: input.documentType ?? null,
          beneficiaryEmployeeId: input.beneficiaryEmployeeId ?? null,
          requestedById: input.requestedById === undefined ? input.actor.id : input.requestedById,
          approvedById,
          approvedAt: approvedById ? new Date() : null,
        },
      });
      await recordAndEmit(w, info, input, row, 'created', null, { title: row.title, amount: row.amount, status: row.status, entityType: row.entityType, entityId: row.entityId });
      return row;
    }),
  );
  return outcome.result;
}

export interface PaymentActInput {
  actor: MoneyActor;
  paymentRequestId: string;
  operationKey: string;
  companyId?: string | null;
  ipAddress?: string | null;
}

/** Owner approval PENDING_OWNER → PENDING_FINANCE (maker ≠ checker, not one's own money). */
export async function approvePaymentRequest(tx: TxClient, input: PaymentActInput): Promise<PaymentRow> {
  assertTransactionClient(tx, 'approvePaymentRequest');
  const outcome = await idempotent(tx, { key: input.operationKey, operation: PAYMENT_APPROVE.name, actorId: input.actor.id, companyId: input.companyId ?? null }, async (t) => {
    const current = await t.paymentRequest.findUnique({ where: { id: input.paymentRequestId } });
    if (!current) throw notFound('أمر الصرف غير موجود');
    if (current.status !== 'PENDING_OWNER') throw conflict('تم اتخاذ قرار بشأن أمر الصرف مسبقاً');
    const mode = await resolveOperatorMode(t);
    const decision = decideMakerChecker({ step: 'APPROVE', actor: { userId: input.actor.id, employeeId: input.actor.employeeId }, requestedById: current.requestedById, mode });
    return runMoneyOperation(t, PAYMENT_APPROVE, { actor: input.actor, input: { paymentRequestId: current.id }, operationKey: input.operationKey, companyId: input.companyId, mode, decision }, async (w, info) => {
      const res = await w.paymentRequest.updateMany({
        where: { id: current.id, status: 'PENDING_OWNER' },
        data: { status: 'PENDING_FINANCE', returnReason: null, approvedById: input.actor.id, approvedAt: new Date() },
      });
      if (res.count === 0) await guardFailed(w, current.id, 'تم اتخاذ قرار بشأن أمر الصرف مسبقاً');
      const row = await w.paymentRequest.findUniqueOrThrow({ where: { id: current.id } });
      await recordAndEmit(w, info, input, row, 'approved', { status: current.status }, { status: row.status, approvedById: row.approvedById, requestedById: row.requestedById });
      return row;
    });
  });
  return outcome.result;
}

/** Owner rejection or finance return of an open request (RETURNED, with the reason). */
export async function returnPaymentRequest(tx: TxClient, input: PaymentActInput & { reason: string; from?: readonly PaymentStatus[] }): Promise<PaymentRow> {
  assertTransactionClient(tx, 'returnPaymentRequest');
  const reason = input.reason?.trim();
  if (!reason) throw badRequest('يرجى كتابة سبب رد السداد');
  const from = input.from ? [...input.from] : OPEN;
  const outcome = await idempotent(tx, { key: input.operationKey, operation: PAYMENT_RETURN.name, actorId: input.actor.id, companyId: input.companyId ?? null }, (t) =>
    runMoneyOperation(t, PAYMENT_RETURN, { actor: input.actor, input: { paymentRequestId: input.paymentRequestId }, operationKey: input.operationKey, companyId: input.companyId }, async (w, info) => {
      const before = await w.paymentRequest.findUnique({ where: { id: input.paymentRequestId }, select: { status: true } });
      const res = await w.paymentRequest.updateMany({ where: { id: input.paymentRequestId, status: { in: from } }, data: { status: 'RETURNED', returnReason: reason } });
      if (res.count === 0) await guardFailed(w, input.paymentRequestId, 'لا يمكن رد السداد: تم سداده أو رده مسبقاً');
      const row = await w.paymentRequest.findUniqueOrThrow({ where: { id: input.paymentRequestId } });
      await recordAndEmit(w, info, input, row, 'returned', before, { status: row.status, returnReason: reason });
      return row;
    }),
  );
  return outcome.result;
}

/**
 * Finance records the payment PENDING_FINANCE → PAID with the receipt. The payer is none of the
 * beneficiary, the requester and the approver (the gateway); a request without either recorded is
 * refused until attested (BR-PAY-015). The caller applies the linked record's effects in the same
 * transaction (settlement, loan transfer, visa).
 */
export async function payPaymentRequest(tx: TxClient, input: PaymentActInput & { receiptUrl: string }): Promise<PaymentRow> {
  assertTransactionClient(tx, 'payPaymentRequest');
  if (!input.receiptUrl) throw badRequest('الرجاء إرفاق صورة السداد أو التحويل');
  const outcome = await idempotent(tx, { key: input.operationKey, operation: PAYMENT_PAY.name, actorId: input.actor.id, companyId: input.companyId ?? null }, async (t) => {
    const current = await t.paymentRequest.findUnique({ where: { id: input.paymentRequestId } });
    if (!current) throw notFound('طلب السداد غير موجود');
    if (current.status !== 'PENDING_FINANCE') throw conflict('لا يمكن تأكيد السداد: الطلب غير معتمد للصرف أو تم سداده مسبقاً');
    const mode = await resolveOperatorMode(t);
    const decision = decideMakerChecker({ step: 'PAY', actor: { userId: input.actor.id, employeeId: input.actor.employeeId }, requestedById: current.requestedById, approvedById: current.approvedById, mode });
    return runMoneyOperation(t, PAYMENT_PAY, { actor: input.actor, input: { paymentRequestId: current.id }, operationKey: input.operationKey, companyId: input.companyId, mode, decision }, async (w, info) => {
      const res = await w.paymentRequest.updateMany({
        where: { id: current.id, status: 'PENDING_FINANCE' },
        data: { status: 'PAID', receiptUrl: input.receiptUrl, paidById: input.actor.id, paidAt: new Date() },
      });
      if (res.count === 0) await guardFailed(w, current.id, 'لا يمكن تأكيد السداد: الطلب غير معتمد للصرف أو تم سداده مسبقاً');
      const row = await w.paymentRequest.findUniqueOrThrow({ where: { id: current.id } });
      await recordAndEmit(w, info, input, row, 'paid', { status: current.status }, { status: row.status, paidById: row.paidById, receiptUrl: row.receiptUrl, requestedById: row.requestedById, approvedById: row.approvedById });
      return row;
    });
  });
  return outcome.result;
}

export interface EditPaymentRequestInput extends PaymentActInput {
  fields: { title?: string; reason?: string | null; amount?: number; accountNumber?: string | null; receiptUrl?: string | null; returnReason?: string | null };
}

/** Field edits: amount / payee / title only before the owner's approval; receipt and note any time open. */
export async function editPaymentRequest(tx: TxClient, input: EditPaymentRequestInput): Promise<PaymentRow> {
  assertTransactionClient(tx, 'editPaymentRequest');
  const f = input.fields;
  const financial = Object.fromEntries(
    Object.entries({ title: f.title, reason: f.reason, amount: f.amount !== undefined ? roundMoney(f.amount) : undefined, accountNumber: f.accountNumber }).filter(([, v]) => v !== undefined),
  );
  const other = Object.fromEntries(Object.entries({ receiptUrl: f.receiptUrl, returnReason: f.returnReason }).filter(([, v]) => v !== undefined));
  if (!Object.keys(financial).length && !Object.keys(other).length) throw badRequest('لا توجد بيانات للتحديث');
  const outcome = await idempotent(tx, { key: input.operationKey, operation: PAYMENT_EDIT.name, actorId: input.actor.id, companyId: input.companyId ?? null }, (t) =>
    runMoneyOperation(t, PAYMENT_EDIT, { actor: input.actor, input: { paymentRequestId: input.paymentRequestId }, operationKey: input.operationKey, companyId: input.companyId }, async (w, info) => {
      const before = await w.paymentRequest.findUnique({ where: { id: input.paymentRequestId } });
      // Amount / payee changes after approval would bypass the owner's approval.
      const where: Prisma.PaymentRequestWhereInput = { id: input.paymentRequestId, ...(Object.keys(financial).length ? { status: { in: ['PENDING_OWNER', 'RETURNED'] as PaymentStatus[] } } : {}) };
      const res = await w.paymentRequest.updateMany({
        where,
        data: {
          title: financial.title as string | undefined,
          reason: financial.reason as string | null | undefined,
          amount: financial.amount as number | undefined,
          accountNumber: financial.accountNumber as string | null | undefined,
          receiptUrl: other.receiptUrl as string | null | undefined,
          returnReason: other.returnReason as string | null | undefined,
        },
      });
      if (res.count === 0) await guardFailed(w, input.paymentRequestId, 'لا يمكن تعديل بيانات السداد بعد اعتماده أو سداده');
      const row = await w.paymentRequest.findUniqueOrThrow({ where: { id: input.paymentRequestId } });
      await recordAndEmit(w, info, input, row, 'edited', before ? { title: before.title, amount: before.amount, accountNumber: before.accountNumber } : null, { ...financial, ...other });
      return row;
    }),
  );
  return outcome.result;
}

/** Deletes an unpaid request that is not linked to a visa / settlement / loan (they are returned instead). */
export async function deletePaymentRequest(tx: TxClient, input: PaymentActInput & { linkedEntityTypes: readonly string[] }): Promise<{ id: string; deleted: boolean }> {
  assertTransactionClient(tx, 'deletePaymentRequest');
  const outcome = await idempotent(tx, { key: input.operationKey, operation: PAYMENT_DELETE.name, actorId: input.actor.id, companyId: input.companyId ?? null }, (t) =>
    runMoneyOperation(t, PAYMENT_DELETE, { actor: input.actor, input: { paymentRequestId: input.paymentRequestId }, operationKey: input.operationKey, companyId: input.companyId }, async (w, info) => {
      const before = await w.paymentRequest.findUnique({ where: { id: input.paymentRequestId } });
      if (!before) throw notFound('طلب السداد غير موجود');
      const res = await w.paymentRequest.deleteMany({
        where: {
          id: input.paymentRequestId,
          status: { in: ['PENDING_OWNER', 'PENDING_FINANCE', 'RETURNED'] },
          OR: [{ entityType: null }, { entityType: { notIn: [...input.linkedEntityTypes] } }],
        },
      });
      if (res.count === 0) throw conflict('لا يمكن حذف طلب سداد تم صرفه');
      await recordAndEmit(w, info, input, before, 'deleted', { title: before.title, amount: before.amount, status: before.status }, null);
      return { id: before.id, deleted: true };
    }),
  );
  return outcome.result;
}

export interface CloseLinkedPaymentsInput {
  /** The linked record: one (entityId [+ documentType]) or several of a type. */
  entityType?: string;
  entityIds?: readonly string[];
  entityId?: string;
  documentType?: string;
  from: readonly PaymentStatus[];
  to: 'COMPLETED' | 'RETURNED';
  returnReason?: string | null;
  operationKey: string;
}

/**
 * Closes the requests of a linked record as an effect of that record's own transition (a renewal
 * confirmed or re-filed, a leave cancelled with its visa). SYSTEM operation: idempotent by nature.
 */
export async function closeLinkedPaymentRequests(tx: TxClient, input: CloseLinkedPaymentsInput): Promise<{ closed: number }> {
  assertTransactionClient(tx, 'closeLinkedPaymentRequests');
  if (!input.entityId && !input.entityIds?.length) return { closed: 0 };
  return runMoneyOperation(tx, PAYMENT_CLOSE_LINKED, { actor: null, input: {}, operationKey: `${input.operationKey}:payments.closeLinked` }, async (w) => {
    const res = await w.paymentRequest.updateMany({
      where: {
        ...(input.entityType ? { entityType: input.entityType } : {}),
        ...(input.entityId ? { entityId: input.entityId } : { entityId: { in: [...(input.entityIds ?? [])] } }),
        ...(input.documentType ? { documentType: input.documentType } : {}),
        status: { in: [...input.from] },
      },
      data: { status: input.to, ...(input.returnReason !== undefined ? { returnReason: input.returnReason } : {}) },
    });
    return { closed: res.count };
  });
}
