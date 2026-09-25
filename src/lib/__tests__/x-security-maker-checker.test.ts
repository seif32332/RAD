import { describe, expect, it } from 'vitest';
import { decideMakerChecker, parseBooleanSetting } from '@/app/api/payments/access';

const base = { actorId: 'u1', actorRole: 'COMPANY_ADMIN', allowSelfApproval: false } as const;

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
  });

  it('allows legacy rows without a requester, flagged as unknown', () => {
    expect(decideMakerChecker({ ...base, step: 'PAY', requestedById: null })).toEqual({ ok: true, basis: 'UNKNOWN_REQUESTER' });
    expect(decideMakerChecker({ ...base, step: 'PAY', requestedById: undefined })).toEqual({ ok: true, basis: 'UNKNOWN_REQUESTER' });
  });

  it('SUPER_ADMIN may self-approve (audited override)', () => {
    expect(decideMakerChecker({ ...base, actorRole: 'SUPER_ADMIN', step: 'APPROVE', requestedById: 'u1' })).toEqual({
      ok: true,
      basis: 'SUPER_ADMIN_OVERRIDE',
    });
  });

  it('allow_self_approval=true lets small companies opt in (audited)', () => {
    expect(decideMakerChecker({ ...base, allowSelfApproval: true, step: 'PAY', requestedById: 'u1' })).toEqual({
      ok: true,
      basis: 'SETTING_ALLOW_SELF_APPROVAL',
    });
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
