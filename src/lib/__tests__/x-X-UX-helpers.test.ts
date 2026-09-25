import { describe, expect, it } from 'vitest';
import { formatLeaveDays, hrLinkRequestMessage } from '@/app/portal/_lib';
import { trapTabIndex } from '@/components/ui/focus-trap';
import { alertBadgeLabel, buildOnboarding } from '@/app/api/dashboard/onboarding';
import { errorFields, validateLoginForm } from '@/components/ui/login-validation';

describe('formatLeaveDays (single leave-balance display rule)', () => {
  it('shows whole days without decimals', () => {
    expect(formatLeaveDays(48)).toBe('48');
    expect(formatLeaveDays(0)).toBe('0');
    expect(formatLeaveDays(30.0)).toBe('30');
  });
  it('shows one decimal only when fractional', () => {
    expect(formatLeaveDays(48.4)).toBe('48.4');
    expect(formatLeaveDays(2.5)).toBe('2.5');
  });
  it('truncates to one decimal, never rounding up past the real balance', () => {
    expect(formatLeaveDays(48.46)).toBe('48.4');
    expect(formatLeaveDays(48.99)).toBe('48.9');
    expect(formatLeaveDays(0.05)).toBe('0');
  });
  it('is robust to binary floating-point noise', () => {
    expect(formatLeaveDays(2.3)).toBe('2.3'); // 2.3 * 10 = 22.999999999999996
    expect(formatLeaveDays(0.1 + 0.2)).toBe('0.3');
    expect(formatLeaveDays(4.35)).toBe('4.3');
  });
  it('handles negative balances conservatively and unknown values', () => {
    expect(formatLeaveDays(-2.35)).toBe('-2.4');
    expect(formatLeaveDays(-0.01)).toBe('-0.1');
    expect(formatLeaveDays(null)).toBe('—');
    expect(formatLeaveDays(undefined)).toBe('—');
    expect(formatLeaveDays(Number.NaN)).toBe('—');
    expect(formatLeaveDays(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('hrLinkRequestMessage', () => {
  it('includes the account identity when known', () => {
    const m = hrLinkRequestMessage({ name: ' سارة ', email: 'sara@example.test' });
    expect(m).toContain('الاسم: سارة');
    expect(m).toContain('حساب الدخول: sara@example.test');
    expect(m).toContain('ربط حسابي');
  });
  it('omits missing fields', () => {
    const m = hrLinkRequestMessage({ name: '', email: null });
    expect(m).not.toContain('الاسم:');
    expect(m).not.toContain('حساب الدخول:');
  });
});

describe('trapTabIndex (Modal focus trap)', () => {
  it('wraps Tab from the last element to the first', () => {
    expect(trapTabIndex(4, 5, false)).toBe(0);
  });
  it('wraps Shift+Tab from the first element to the last', () => {
    expect(trapTabIndex(0, 5, true)).toBe(4);
  });
  it('lets the browser move focus inside the dialog', () => {
    expect(trapTabIndex(1, 5, false)).toBeNull();
    expect(trapTabIndex(3, 5, true)).toBeNull();
  });
  it('pulls focus from the container / outside into the dialog', () => {
    expect(trapTabIndex(-1, 5, false)).toBe(0);
    expect(trapTabIndex(-1, 5, true)).toBe(4);
    expect(trapTabIndex(9, 5, false)).toBe(0);
  });
  it('keeps focus on the container when nothing is focusable', () => {
    expect(trapTabIndex(-1, 0, false)).toBe(-1);
  });
  it('single focusable element: Tab and Shift+Tab stay on it', () => {
    expect(trapTabIndex(0, 1, false)).toBe(0);
    expect(trapTabIndex(0, 1, true)).toBe(0);
  });
});

describe('buildOnboarding (admin checklist)', () => {
  it('empty tenant: nothing done, first step is the company', () => {
    const o = buildOnboarding({});
    expect(o.total).toBe(6);
    expect(o.completed).toBe(0);
    expect(o.allDone).toBe(false);
    expect(o.steps[0].key).toBe('companies');
    expect(o.steps.every((s) => typeof s.href === 'string' && s.href.startsWith('/'))).toBe(true);
  });
  it('marks steps done from positive counts only', () => {
    const o = buildOnboarding({ companies: 2, branches: 3, employees: 30, linkedUsers: 0, workSchedules: -1, payrolls: Number.NaN });
    expect(o.steps.filter((s) => s.done).map((s) => s.key)).toEqual(['companies', 'branches', 'employees']);
    expect(o.completed).toBe(3);
    expect(o.steps.find((s) => s.key === 'workSchedules')?.count).toBe(0);
  });
  it('all done', () => {
    const o = buildOnboarding({ companies: 1, branches: 1, employees: 1, linkedUsers: 1, workSchedules: 1, payrolls: 1 });
    expect(o.allDone).toBe(true);
  });
});

describe('alertBadgeLabel (honest empty state)', () => {
  it('counts active alerts', () => {
    expect(alertBadgeLabel(3, 10)).toEqual({ label: '3 تنبيه نشط', tone: 'alert' });
  });
  it('does not claim "no alerts" when nothing is on file', () => {
    expect(alertBadgeLabel(0, 0)).toEqual({ label: 'لم تُسجَّل وثائق بعد', tone: 'empty' });
  });
  it('claims "no alerts" only when documents are tracked', () => {
    expect(alertBadgeLabel(0, 5)).toEqual({ label: 'لا تنبيهات حالياً', tone: 'ok' });
  });
});

describe('validateLoginForm (inline Arabic validation)', () => {
  it('requires both fields', () => {
    const e = validateLoginForm({ email: '  ', password: '' });
    expect(e.email).toBe('أدخل البريد الإلكتروني');
    expect(e.password).toBe('أدخل كلمة المرور');
    expect(errorFields(e)).toEqual(['email', 'password']);
  });
  it('rejects a malformed email', () => {
    expect(validateLoginForm({ email: 'admin', password: 'x' }).email).toMatch(/صيغة البريد/);
    expect(validateLoginForm({ email: 'a b@c.d', password: 'x' }).email).toMatch(/صيغة البريد/);
  });
  it('accepts a well-formed email (trimmed) and any non-empty password', () => {
    const e = validateLoginForm({ email: ' user@company.sa ', password: ' ' });
    expect(e).toEqual({});
    expect(errorFields(e)).toEqual([]);
  });
});
