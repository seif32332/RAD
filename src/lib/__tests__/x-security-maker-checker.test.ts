// BL-PAY-008 (DEC-PO-002, DEC-PO-005; pay-to-be BR-PAY-002): the maker-checker of a payment request has
// no exception any more — not SUPER_ADMIN, not the allow_self_approval setting, not a legacy request
// without a requester (UNKNOWN_REQUESTER). The screens' pure rule (payments/access.ts) and the gateway's
// (platform decideMakerChecker) agree.
import { describe, expect, it } from 'vitest';
import { decideMakerChecker, parseBooleanSetting } from '@/app/api/payments/access';
import { decideMakerChecker as gatewayMakerChecker } from '@/modules/platform';

const base = { actorId: 'u1', actorRole: 'COMPANY_ADMIN' } as const;

describe('decideMakerChecker', () => {
  it('refuses the requester approving or paying their own request (regression: self-approval path)', () => {
    const approve = decideMakerChecker({ ...base, step: 'APPROVE', requestedById: 'u1' });
    expect(approve.ok).toBe(false);
    if (!approve.ok) expect(approve.message).toContain('اعتماد');
    const pay = decideMakerChecker({ ...base, step: 'PAY', requestedById: 'u1', actorRole: 'FINANCE_MANAGER' });
    expect(pay.ok).toBe(false);
    if (!pay.ok) expect(pay.message).toContain('سداد');
  });

  it('allows a different user', () => {
    expect(decideMakerChecker({ ...base, step: 'APPROVE', requestedById: 'u2' })).toEqual({ ok: true, basis: 'DIFFERENT_USER' });
    expect(decideMakerChecker({ ...base, step: 'PAY', requestedById: 'u2', approvedById: 'u3' })).toEqual({ ok: true, basis: 'DIFFERENT_USER' });
  });

  it('SUPER_ADMIN may NOT self-approve or self-pay any more (BL-PAY-008)', () => {
    expect(decideMakerChecker({ ...base, actorRole: 'SUPER_ADMIN', step: 'APPROVE', requestedById: 'u1' }).ok).toBe(false);
    expect(decideMakerChecker({ ...base, actorRole: 'SUPER_ADMIN', step: 'PAY', requestedById: 'u1' }).ok).toBe(false);
  });

  it('the approver of a request may not record it as paid (BR-PAY-002, DEC-PO-005)', () => {
    expect(decideMakerChecker({ ...base, step: 'PAY', requestedById: 'u2', approvedById: 'u1' }).ok).toBe(false);
  });

  it('a legacy request with neither requester nor approver is not paid before attestation (no UNKNOWN_REQUESTER pass)', () => {
    expect(decideMakerChecker({ ...base, step: 'PAY', requestedById: null }).ok).toBe(false);
    expect(decideMakerChecker({ ...base, step: 'PAY', requestedById: undefined, approvedById: null }).ok).toBe(false);
    // With a recorded approver, a different payer may pay it.
    expect(decideMakerChecker({ ...base, step: 'PAY', requestedById: null, approvedById: 'u9' }).ok).toBe(true);
    // Approving a legacy request is not blocked by the missing requester.
    expect(decideMakerChecker({ ...base, step: 'APPROVE', requestedById: null }).ok).toBe(true);
  });

  it('agrees with the gateway rule in ENFORCED; SINGLE_OPERATOR records a self-act instead of refusing', () => {
    const cases = [
      { step: 'APPROVE' as const, requestedById: 'u1', approvedById: null },
      { step: 'APPROVE' as const, requestedById: 'u2', approvedById: null },
      { step: 'PAY' as const, requestedById: 'u1', approvedById: 'u2' },
      { step: 'PAY' as const, requestedById: 'u2', approvedById: 'u1' },
      { step: 'PAY' as const, requestedById: 'u2', approvedById: 'u3' },
      { step: 'PAY' as const, requestedById: null, approvedById: null },
    ];
    for (const c of cases) {
      const screen = decideMakerChecker({ ...base, ...c });
      const gate = gatewayMakerChecker({ step: c.step, actor: { userId: 'u1', employeeId: null }, requestedById: c.requestedById, approvedById: c.approvedById, mode: 'ENFORCED' });
      expect(gate.ok, JSON.stringify(c)).toBe(screen.ok);
      const single = gatewayMakerChecker({ step: c.step, actor: { userId: 'u1', employeeId: null }, requestedById: c.requestedById, approvedById: c.approvedById, mode: 'SINGLE_OPERATOR' });
      expect(single.ok).toBe(true);
      expect(single.selfAct).toBe(!screen.ok);
    }
  });
});

describe('parseBooleanSetting', () => {
  it('accepts true / "true" in any case, everything else is false', () => {
    expect(parseBooleanSetting('true')).toBe(true);
    expect(parseBooleanSetting('"true"')).toBe(true);
    expect(parseBooleanSetting(' TRUE ')).toBe(true);
    expect(parseBooleanSetting('false')).toBe(false);
    expect(parseBooleanSetting('1')).toBe(false);
    expect(parseBooleanSetting('')).toBe(false);
    expect(parseBooleanSetting(null)).toBe(false);
    expect(parseBooleanSetting(undefined)).toBe(false);
  });
});
