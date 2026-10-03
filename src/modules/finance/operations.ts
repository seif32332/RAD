// finance's money operations (money.gateway, ARCH-004): the payment request (PaymentRequest) from
// filing to payment. finance sits BELOW payroll (DOMAIN_BOUNDARIES §5.3, ADR-0002 #7): it calls
// nothing above it; the linked records (settlement, loan, visa) are the callers' business.
import { legalCompanyOfEmployees } from '@/modules/people';
import { defineMoneyOperation, type TxClient } from '@/modules/platform';

export interface PaymentSubject {
  paymentRequestId: string;
}

async function beneficiaryOf(tx: TxClient, input: PaymentSubject) {
  const row = await tx.paymentRequest.findUnique({ where: { id: input.paymentRequestId }, select: { beneficiaryEmployeeId: true } });
  return row?.beneficiaryEmployeeId ? [row.beneficiaryEmployeeId] : [];
}

async function approversOf(tx: TxClient, input: PaymentSubject) {
  const row = await tx.paymentRequest.findUnique({ where: { id: input.paymentRequestId }, select: { approvedById: true, requestedById: true } });
  return [row?.approvedById, row?.requestedById];
}

/** Filing a request: a pending request for oneself is allowed (DEC-PO-006). */
export const PAYMENT_CREATE = defineMoneyOperation<{ beneficiaryEmployeeId: string | null }>({
  name: 'finance.paymentRequest.create',
  owner: 'finance',
  act: 'REQUEST',
  source: 'USER',
  writes: { PaymentRequest: '*' },
});

/** Owner approval PENDING_OWNER → PENDING_FINANCE: not the requester, not the beneficiary. */
export const PAYMENT_APPROVE = defineMoneyOperation<PaymentSubject>({
  name: 'finance.paymentRequest.approve',
  owner: 'finance',
  act: 'APPROVE',
  source: 'USER',
  writes: { PaymentRequest: ['status', 'returnReason', 'approvedById', 'approvedAt'] },
  beneficiaries: beneficiaryOf,
  companyOf: async (tx, input) => legalCompanyOfEmployees(tx, await beneficiaryOf(tx, input)),
});

/**
 * Finance records the payment PENDING_FINANCE → PAID: not the beneficiary (DEC-PO-015 keeps PAY a
 * beneficiary act for a payment request), not its requester nor its approver (BR-PAY-002, DEC-PO-005).
 */
export const PAYMENT_PAY = defineMoneyOperation<PaymentSubject>({
  name: 'finance.paymentRequest.pay',
  owner: 'finance',
  act: 'PAY',
  source: 'USER',
  writes: { PaymentRequest: ['status', 'receiptUrl', 'paidById', 'paidAt'] },
  beneficiaries: beneficiaryOf,
  companyOf: async (tx, input) => legalCompanyOfEmployees(tx, await beneficiaryOf(tx, input)),
  approvers: approversOf,
});

/** Returning (رد السداد) or rejecting an open request. */
export const PAYMENT_RETURN = defineMoneyOperation<PaymentSubject>({
  name: 'finance.paymentRequest.return',
  owner: 'finance',
  act: 'REJECT',
  source: 'USER',
  writes: { PaymentRequest: ['status', 'returnReason'] },
});

/** Editing the fields of a request before approval (amount / payee), or its receipt / note. */
export const PAYMENT_EDIT = defineMoneyOperation<PaymentSubject>({
  name: 'finance.paymentRequest.edit',
  owner: 'finance',
  act: 'REQUEST',
  source: 'USER',
  writes: { PaymentRequest: ['title', 'reason', 'amount', 'accountNumber', 'receiptUrl', 'returnReason'] },
});

/** Deleting an unpaid, unlinked request. */
export const PAYMENT_DELETE = defineMoneyOperation<PaymentSubject>({
  name: 'finance.paymentRequest.delete',
  owner: 'finance',
  act: 'REJECT',
  source: 'USER',
  writes: { PaymentRequest: '*' },
});

/**
 * Closing the requests of a linked record as an effect of its own transition (a renewal confirmed or
 * re-filed, a leave cancelled with its visa): SYSTEM, no money moves.
 */
export const PAYMENT_CLOSE_LINKED = defineMoneyOperation<Record<string, never>>({
  name: 'finance.paymentRequest.closeLinked',
  owner: 'finance',
  act: 'RELEASE',
  source: 'SYSTEM',
  writes: { PaymentRequest: ['status', 'returnReason'] },
});
