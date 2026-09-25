import { describe, expect, it } from 'vitest';
import {
  article80NoteLine,
  openObligationWarnings,
  paymentOverdueDays,
  probationLimitDate,
  statutoryPaymentDeadline,
  terminationReasonProblem,
  type TerminationReasonCheck,
} from '@/app/api/settlements/route';
import { activeProtectedLeave, type ProtectedLeaveLike } from '@/app/api/employees/[id]/route';
import { abscondProblem } from '@/app/api/leaves/[id]/action/route';

const d = (k: string) => new Date(`${k}T00:00:00.000Z`);

const base: TerminationReasonCheck = {
  terminationReason: 'PROBATION',
  lastWorkingDate: d('2026-09-25'),
  joinDate: d('2021-01-01'),
  probationEndDate: null,
  article80Clause: null,
  hasGuiltyInvestigation: false,
  forfeitedAward: 17722,
};

describe('WP-2 probation guard (DOM-004)', () => {
  it('limit is joinDate + 180 days without a probation end date', () => {
    expect(probationLimitDate(d('2026-01-01'), null).toISOString().slice(0, 10)).toBe('2026-06-30');
  });

  it('uses the recorded probation end date, capped at 180 days', () => {
    expect(probationLimitDate(d('2026-01-01'), d('2026-03-31')).toISOString().slice(0, 10)).toBe('2026-03-31');
    expect(probationLimitDate(d('2026-01-01'), d('2027-01-01')).toISOString().slice(0, 10)).toBe('2026-06-30');
  });

  it('refuses PROBATION for an employee who joined in 2021 and names the dropped award', () => {
    const p = terminationReasonProblem(base);
    expect(p?.code).toBe('PROBATION_EXPIRED');
    expect(p?.message).toContain('17,722');
    expect(p?.message).toContain('ر.س');
  });

  it('accepts PROBATION on or before the limit', () => {
    expect(terminationReasonProblem({ ...base, joinDate: d('2026-06-01'), lastWorkingDate: d('2026-09-25') })).toBeNull();
    expect(terminationReasonProblem({ ...base, joinDate: d('2026-01-01'), lastWorkingDate: d('2026-06-30') })).toBeNull();
    expect(terminationReasonProblem({ ...base, joinDate: d('2026-01-01'), lastWorkingDate: d('2026-07-01') })?.code).toBe('PROBATION_EXPIRED');
  });

  it('refuses PROBATION after a shorter recorded probation end date', () => {
    const p = terminationReasonProblem({ ...base, joinDate: d('2026-06-01'), probationEndDate: d('2026-08-30'), lastWorkingDate: d('2026-09-01') });
    expect(p?.code).toBe('PROBATION_EXPIRED');
  });
});

describe('WP-2 article 80 guard (DOM-004)', () => {
  const a80 = { ...base, terminationReason: 'ARTICLE_80' as const };

  it('requires the paragraph first', () => {
    const p = terminationReasonProblem({ ...a80, hasGuiltyInvestigation: true });
    expect(p?.code).toBe('ARTICLE_80_CLAUSE_REQUIRED');
    expect(p?.message).toContain('17,722');
  });

  it('requires a guilty investigation', () => {
    const p = terminationReasonProblem({ ...a80, article80Clause: 3 });
    expect(p?.code).toBe('ARTICLE_80_NO_GUILTY_INVESTIGATION');
    expect(p?.message).toContain('ثبتت فيه الإدانة');
  });

  it('accepts a paragraph with a guilty investigation', () => {
    expect(terminationReasonProblem({ ...a80, article80Clause: 3, hasGuiltyInvestigation: true })).toBeNull();
  });

  it('never blocks the other reasons', () => {
    for (const r of ['COMPANY_TERMINATION', 'RESIGNATION', 'ARTICLE_81', 'ARTICLE_87', 'CONTRACT_EXPIRY', null]) {
      expect(terminationReasonProblem({ ...base, terminationReason: r })).toBeNull();
    }
  });

  it('stores the paragraph as a note marker', () => {
    expect(article80NoteLine(7)).toBe('[ARTICLE_80_CLAUSE:7] فصل بموجب المادة 80 — الفقرة 7');
  });
});

describe('WP-2 article 88 payment deadline', () => {
  it('one week when the employer ended the contract', () => {
    const dl = statutoryPaymentDeadline({ type: 'END_OF_SERVICE', terminationReason: 'COMPANY_TERMINATION', lastWorkingDate: d('2026-09-10') });
    expect(dl).toEqual({ dueDate: '2026-09-17', days: 7, endedBy: 'EMPLOYER' });
  });

  it('two weeks on resignation or article 81', () => {
    expect(statutoryPaymentDeadline({ type: 'END_OF_SERVICE', terminationReason: 'RESIGNATION', lastWorkingDate: d('2026-09-10') })?.dueDate).toBe('2026-09-24');
    expect(statutoryPaymentDeadline({ type: 'END_OF_SERVICE', terminationReason: 'ARTICLE_81', lastWorkingDate: d('2026-09-10') })?.days).toBe(14);
  });

  it('one week (stricter) for a missing reason; none for leave settlements or without a date', () => {
    expect(statutoryPaymentDeadline({ type: 'END_OF_SERVICE', terminationReason: null, lastWorkingDate: d('2026-09-10') })?.days).toBe(7);
    expect(statutoryPaymentDeadline({ type: 'LEAVE_SETTLEMENT', terminationReason: null, lastWorkingDate: d('2026-09-10') })).toBeNull();
    expect(statutoryPaymentDeadline({ type: 'END_OF_SERVICE', terminationReason: 'RESIGNATION', lastWorkingDate: null })).toBeNull();
  });

  it('counts overdue days only while not paid or rejected', () => {
    const dl = statutoryPaymentDeadline({ type: 'END_OF_SERVICE', terminationReason: 'COMPANY_TERMINATION', lastWorkingDate: d('2026-09-10') });
    expect(paymentOverdueDays(dl, 'PENDING_APPROVAL', d('2026-09-17'))).toBe(0);
    expect(paymentOverdueDays(dl, 'PENDING_APPROVAL', d('2026-09-20'))).toBe(3);
    expect(paymentOverdueDays(dl, 'OWNER_APPROVED', d('2026-09-25'))).toBe(8);
    expect(paymentOverdueDays(dl, 'PAID', d('2026-09-25'))).toBe(0);
    expect(paymentOverdueDays(dl, 'REJECTED', d('2026-09-25'))).toBe(0);
    expect(paymentOverdueDays(null, 'PENDING_APPROVAL', d('2026-09-25'))).toBe(0);
  });
});

describe('WP-2 open obligations (DOM-005, warnings only)', () => {
  const none = { assets: [], sims: [], vehicles: [], futureLeaves: [], exitReentryVisas: [], pendingPayments: [] };

  it('no warning without obligations', () => {
    expect(openObligationWarnings(none)).toEqual([]);
  });

  it('asset + SIM + vehicle give three warnings', () => {
    const w = openObligationWarnings({ ...none, assets: ['لابتوب'], sims: ['0550000000'], vehicles: ['ABC 123'] });
    expect(w).toHaveLength(3);
    expect(w[0]).toContain('لابتوب');
    expect(w[1]).toContain('0550000000');
    expect(w[2]).toContain('ABC 123');
  });

  it('lists at most five items per warning', () => {
    const [w] = openObligationWarnings({ ...none, assets: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] });
    expect(w).toContain('(7)');
    expect(w).toContain('و2 غيرها');
    expect(w).not.toContain('f');
  });

  it('covers future leaves, exit/re-entry visas and pending payments', () => {
    const w = openObligationWarnings({ ...none, futureLeaves: ['سنوية'], exitReentryVisas: ['بانتظار الدفع'], pendingPayments: ['رسوم (200 ر.س)'] });
    expect(w).toHaveLength(3);
  });
});

describe('WP-2 protected leave on direct termination (DOM-004)', () => {
  const leave = (over: Partial<ProtectedLeaveLike>): ProtectedLeaveLike => ({
    id: 'l1',
    leaveType: 'MATERNITY',
    status: 'APPROVED',
    startDate: d('2026-09-01'),
    endDate: d('2026-11-24'),
    isReturned: false,
    actualReturnDate: null,
    ...over,
  });

  it('finds an approved maternity / sick leave in effect', () => {
    expect(activeProtectedLeave([leave({})], [d('2026-09-25')])?.id).toBe('l1');
    expect(activeProtectedLeave([leave({ leaveType: 'SICK' })], [d('2026-09-01')])?.id).toBe('l1');
    expect(activeProtectedLeave([leave({})], [d('2026-11-24')])?.id).toBe('l1');
  });

  it('ignores other types, other statuses, other days and a leave already returned from', () => {
    expect(activeProtectedLeave([leave({ leaveType: 'ANNUAL' })], [d('2026-09-25')])).toBeNull();
    expect(activeProtectedLeave([leave({ status: 'PENDING' })], [d('2026-09-25')])).toBeNull();
    expect(activeProtectedLeave([leave({})], [d('2026-11-25'), d('2026-08-31')])).toBeNull();
    expect(activeProtectedLeave([leave({ isReturned: true, actualReturnDate: d('2026-09-20') })], [d('2026-09-25')])).toBeNull();
  });

  it('checks every given day (termination date and today)', () => {
    expect(activeProtectedLeave([leave({})], [d('2026-12-31'), d('2026-09-25')])?.id).toBe('l1');
  });
});

describe('WP-2 abscond guard (DOM-004)', () => {
  const asOf = d('2026-09-25');

  it('refuses maternity and sick leaves', () => {
    expect(abscondProblem({ leaveType: 'MATERNITY', endDate: d('2026-09-01') }, asOf)).toContain('إجازة وضع');
    expect(abscondProblem({ leaveType: 'SICK', endDate: d('2026-09-01') }, asOf)).toContain('إجازة مرضية');
  });

  it('refuses before the leave end date has passed', () => {
    expect(abscondProblem({ leaveType: 'ANNUAL', endDate: d('2026-10-10') }, asOf)).toContain('لم تنتهِ الإجازة');
    expect(abscondProblem({ leaveType: 'ANNUAL', endDate: d('2026-09-25') }, asOf)).toContain('لم تنتهِ الإجازة');
  });

  it('accepts an ended annual leave, with a termination date after its end', () => {
    expect(abscondProblem({ leaveType: 'ANNUAL', endDate: d('2026-09-24') }, asOf)).toBeNull();
    expect(abscondProblem({ leaveType: 'ANNUAL', endDate: d('2026-09-10') }, asOf, d('2026-09-20'))).toBeNull();
    expect(abscondProblem({ leaveType: 'ANNUAL', endDate: d('2026-09-10') }, asOf, d('2026-09-10'))).toContain('بعد تاريخ نهاية الإجازة');
  });
});
