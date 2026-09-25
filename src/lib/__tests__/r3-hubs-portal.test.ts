import { describe, expect, it } from 'vitest';
import {
  UNLINKED_ACCOUNT_MESSAGE,
  cancellableLeaveId,
  isUnlinkedAccount,
  leavePreviewQuery,
  parseLeavePreview,
  safeHref,
} from '@/app/portal/_lib';

describe('isUnlinkedAccount', () => {
  it('only true for a loaded session without an employee file', () => {
    expect(isUnlinkedAccount({ employeeId: null }, false)).toBe(true);
    expect(isUnlinkedAccount({ employeeId: '' }, false)).toBe(true);
    expect(isUnlinkedAccount({}, false)).toBe(true);
    expect(isUnlinkedAccount({ employeeId: 'e1' }, false)).toBe(false);
    expect(isUnlinkedAccount({ employeeId: null }, true)).toBe(false);
    expect(isUnlinkedAccount(null, false)).toBe(false);
  });
  it('message matches the requested wording', () => {
    expect(UNLINKED_ACCOUNT_MESSAGE).toBe('حسابك غير مرتبط بملف موظف — تواصل مع الموارد البشرية');
  });
});

describe('safeHref', () => {
  it('allows same-origin paths and http(s) URLs', () => {
    expect(safeHref('/api/files/abc')).toBe('/api/files/abc');
    expect(safeHref(' https://example.com/a.pdf ')).toBe('https://example.com/a.pdf');
    expect(safeHref('http://x.test')).toBe('http://x.test');
  });
  it('rejects scripts, data URLs, protocol-relative and blanks', () => {
    for (const v of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,x', '//evil.test/x', '/\\evil.test', 'https://', '', null, undefined, 'ftp://x']) {
      expect(safeHref(v)).toBeNull();
    }
  });
});

describe('leavePreviewQuery', () => {
  const base = { leaveType: 'ANNUAL', startDate: '2026-12-01', endDate: '2026-12-05', acceptUnpaidExtraDays: false, isOutsideKSA: true };
  it('builds the query without employeeId', () => {
    const q = new URLSearchParams(leavePreviewQuery(base) ?? '');
    expect(Object.fromEntries(q)).toEqual({
      leaveType: 'ANNUAL', startDate: '2026-12-01', endDate: '2026-12-05', acceptUnpaidExtraDays: 'false', isOutsideKSA: 'true',
    });
    expect(q.has('employeeId')).toBe(false);
  });
  it('same-day leave is valid', () => {
    expect(leavePreviewQuery({ ...base, endDate: '2026-12-01' })).not.toBeNull();
  });
  it('null for incomplete or inverted ranges', () => {
    expect(leavePreviewQuery({ ...base, startDate: '' })).toBeNull();
    expect(leavePreviewQuery({ ...base, endDate: '2026-1-5' })).toBeNull();
    expect(leavePreviewQuery({ ...base, endDate: '2026-11-30' })).toBeNull();
  });
  it('defaults an empty leave type to ANNUAL', () => {
    expect(new URLSearchParams(leavePreviewQuery({ ...base, leaveType: '' }) ?? '').get('leaveType')).toBe('ANNUAL');
  });
});

describe('parseLeavePreview', () => {
  it('normalizes a server preview', () => {
    expect(parseLeavePreview({
      totalDays: 5, paidDays: 3, unpaidDays: 2, totalDeduction: 400, issue: null, issueMessage: null,
      needsVisa: true, exitReentryVisaCost: 200, balance: { available: 3.4 },
    })).toEqual({
      totalDays: 5, paidDays: 3, unpaidDays: 2, totalDeduction: 400, issue: null, issueMessage: null,
      needsVisa: true, exitReentryVisaCost: 200, balance: { available: 3.4 },
    });
  });
  it('fills missing numbers with 0 and keeps the issue', () => {
    expect(parseLeavePreview({ totalDays: 2, paidDays: 0, issue: 'EXCESS_NOT_ACCEPTED', issueMessage: 'x' })).toMatchObject({
      unpaidDays: 0, totalDeduction: 0, exitReentryVisaCost: 0, needsVisa: false, issue: 'EXCESS_NOT_ACCEPTED', issueMessage: 'x', balance: null,
    });
  });
  it('rejects non-preview payloads', () => {
    expect(parseLeavePreview(null)).toBeNull();
    expect(parseLeavePreview({ message: 'error' })).toBeNull();
    expect(parseLeavePreview([1, 2])).toBeNull();
  });
});

describe('cancellableLeaveId', () => {
  it('returns the id of an own PENDING leave', () => {
    expect(cancellableLeaveId({ status: 'PENDING', leaveId: 'l1', canCancel: true })).toBe('l1');
  });
  it('null for other rows', () => {
    expect(cancellableLeaveId({ status: 'APPROVED', leaveId: 'l1', canCancel: true })).toBeNull();
    expect(cancellableLeaveId({ status: 'PENDING', leaveId: 'l1', canCancel: false })).toBeNull();
    expect(cancellableLeaveId({ status: 'PENDING', canCancel: true })).toBeNull();
    expect(cancellableLeaveId({ status: 'PENDING' })).toBeNull();
  });
});
