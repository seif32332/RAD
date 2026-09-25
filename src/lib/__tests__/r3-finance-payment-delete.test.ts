import { describe, expect, it } from 'vitest';
import {
  LINKED_PAYMENT_ENTITY_TYPES,
  isLinkedPaymentRequest,
  paymentDeleteBlockReason,
} from '@/app/api/payments/access';

describe('isLinkedPaymentRequest', () => {
  it('detects visa / settlement / loan requests', () => {
    for (const t of LINKED_PAYMENT_ENTITY_TYPES) expect(isLinkedPaymentRequest(t)).toBe(true);
  });
  it('treats manual and renewal requests as unlinked', () => {
    expect(isLinkedPaymentRequest(null)).toBe(false);
    expect(isLinkedPaymentRequest(undefined)).toBe(false);
    expect(isLinkedPaymentRequest('')).toBe(false);
    expect(isLinkedPaymentRequest('Branch')).toBe(false);
    expect(isLinkedPaymentRequest('visa')).toBe(false);
  });
});

describe('paymentDeleteBlockReason', () => {
  it('allows deleting open or returned manual requests', () => {
    expect(paymentDeleteBlockReason({ status: 'PENDING_OWNER', entityType: null })).toBeNull();
    expect(paymentDeleteBlockReason({ status: 'PENDING_FINANCE' })).toBeNull();
    expect(paymentDeleteBlockReason({ status: 'RETURNED', entityType: 'Employee' })).toBeNull();
  });

  it('blocks paid / completed requests whatever the link', () => {
    expect(paymentDeleteBlockReason({ status: 'PAID', entityType: null })).toMatch(/تم صرفه/);
    expect(paymentDeleteBlockReason({ status: 'COMPLETED', entityType: 'VISA' })).toMatch(/تم صرفه/);
  });

  it('blocks linked requests in every unpaid status', () => {
    for (const entityType of ['VISA', 'SETTLEMENT', 'LOAN']) {
      for (const status of ['PENDING_OWNER', 'PENDING_FINANCE']) {
        expect(paymentDeleteBlockReason({ status, entityType })).toMatch(/رد السداد/);
      }
      expect(paymentDeleteBlockReason({ status: 'RETURNED', entityType })).toMatch(/محفوظاً كسجل/);
    }
    expect(paymentDeleteBlockReason({ status: 'PENDING_FINANCE', entityType: 'VISA' })).toMatch(/تأشيرة/);
    expect(paymentDeleteBlockReason({ status: 'PENDING_FINANCE', entityType: 'SETTLEMENT' })).toMatch(/تصفية/);
    expect(paymentDeleteBlockReason({ status: 'PENDING_FINANCE', entityType: 'LOAN' })).toMatch(/سلفة/);
  });

  it('blocks unknown statuses', () => {
    expect(paymentDeleteBlockReason({ status: 'SOMETHING' })).not.toBeNull();
  });
});
