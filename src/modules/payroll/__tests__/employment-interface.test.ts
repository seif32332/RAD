// BL-LCY-012 (lcy-to-be.md BR-LCY-011): the payroll interface to lifecycle, pure parts. payrollEligible
// (one condition, from employmentEnd), the void statuses and period scoping of settlementCoverage, the
// lifecycle batch readers (gaps between periods, current period), the first month an employment event
// affects, and the D1 conversion of a legacy TERMINATED row with a future day once NOTICE is released.
import { describe, expect, it } from 'vitest';
import { payrollEligible, effectiveMonthOf } from '@/modules/payroll';
import { currentPeriodStart, employedDuringWhere, employmentGapsWithin, NOTICE_STATE_RELEASED, planTransition, type CurrentEmployment } from '@/modules/lifecycle';
import { employmentDaysInMonth, settlementCoverage, settlementCoversMonth } from '@/lib/payroll-core';
import { SETTLEMENT_REVERSED, SETTLEMENT_STATUS, SETTLEMENT_VOID_STATUSES, isSettlementVoid } from '@/lib/constants';
import { paymentOverdueDays } from '@/app/api/settlements/route';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const joinDate = d('2024-01-01');

describe('payrollEligible (BR-LCY-011): the date, not the state', () => {
  it('NOTICE is released', () => {
    expect(NOTICE_STATE_RELEASED).toBe(true);
  });

  const cases: Array<[string, Parameters<typeof payrollEligible>[0]['employee'], number, string | null, boolean | string]> = [
    ['ACTIVE', { employmentState: 'ACTIVE', isTerminated: false, terminationDate: null, joinDate }, 3, null, true],
    ['NOTICE, last day in the month', { employmentState: 'NOTICE', isTerminated: false, terminationDate: d('2071-03-20'), joinDate }, 3, '2071-03-20', true],
    ['NOTICE, the month after the last day', { employmentState: 'NOTICE', isTerminated: false, terminationDate: d('2071-03-20'), joinDate }, 4, '2071-03-20', 'ENDED_BEFORE_MONTH'],
    ['TERMINATED, last day in the month', { employmentState: 'TERMINATED', isTerminated: true, terminationDate: d('2071-03-15'), joinDate }, 3, '2071-03-15', true],
    ['TERMINATED, the month after', { employmentState: 'TERMINATED', isTerminated: true, terminationDate: d('2071-03-15'), joinDate }, 4, '2071-03-15', 'ENDED_BEFORE_MONTH'],
    ['TERMINATED without a date', { employmentState: 'TERMINATED', isTerminated: true, terminationDate: null, joinDate }, 3, null, 'TERMINATED_WITHOUT_DATE'],
    ['legacy projection (no state), terminated with a date', { employmentState: null, isTerminated: true, terminationDate: d('2071-03-15'), joinDate }, 3, '2071-03-15', true],
    ['legacy ACTIVE row with a stray date: no end', { employmentState: null, isTerminated: false, terminationDate: d('2071-03-15'), joinDate }, 4, null, true],
    ['not joined yet', { employmentState: 'ACTIVE', isTerminated: false, terminationDate: null, joinDate: d('2071-04-02') }, 3, null, 'NOT_JOINED'],
  ];
  it.each(cases)('%s', (_name, employee, month, end, expected) => {
    const r = payrollEligible({ employee, year: 2071, month });
    expect(r.employmentEnd ? r.employmentEnd.toISOString().slice(0, 10) : null).toBe(end);
    if (expected === true) expect(r.eligible).toBe(true);
    else expect(r).toMatchObject({ eligible: false, reason: expected });
  });

  it('an END_OF_SERVICE settlement of the current period ends the payroll from its last month', () => {
    const employee = { employmentState: 'NOTICE' as const, isTerminated: false, terminationDate: d('2071-03-20'), joinDate };
    expect(payrollEligible({ employee, year: 2071, month: 2, settlementFinalDay: d('2071-03-20') }).eligible).toBe(true);
    expect(payrollEligible({ employee, year: 2071, month: 3, settlementFinalDay: d('2071-03-20') })).toMatchObject({ eligible: false, reason: 'SETTLED_BY_EOS' });
  });

  it('NOTICE mid-month is prorated to the last day exactly like TERMINATED (20 of 31 days)', () => {
    for (const state of ['NOTICE', 'TERMINATED'] as const) {
      const r = payrollEligible({ employee: { employmentState: state, isTerminated: state === 'TERMINATED', terminationDate: d('2071-03-20'), joinDate }, year: 2071, month: 3 });
      expect(employmentDaysInMonth({ year: 2071, month: 3, joinDate, employmentEnd: r.employmentEnd })).toMatchObject({ eligibleDays: 20, daysInMonth: 31 });
    }
  });
});

describe('settlement void statuses and period scoping (BL-LCY-012 sites 1-2)', () => {
  const salary = { basicSalary: 6000, allowances: [] };
  const eos = (status: string, last = '2071-03-20') => ({ type: 'END_OF_SERVICE', status, lastWorkingDate: d(last), createdAt: d('2071-03-01'), salaryBasis: 'total', leaveCompensation: 0 });

  it('the void statuses are REJECTED and REVERSED, and only those', () => {
    expect([...SETTLEMENT_VOID_STATUSES].sort()).toEqual(['REJECTED', 'REVERSED']);
    expect(SETTLEMENT_REVERSED).toBe('REVERSED');
  });

  it.each([...Object.values(SETTLEMENT_STATUS), SETTLEMENT_REVERSED].map((s) => [s]))('every status: %s', (status) => {
    const cov = settlementCoverage([eos(status)], salary);
    const counts = !isSettlementVoid(status);
    expect(cov.finalDay ? cov.finalDay.toISOString().slice(0, 10) : null).toBe(counts ? '2071-03-20' : null);
    expect(settlementCoversMonth([eos(status)], salary, 2071, 3)).toBe(counts);
    // The overdue count of article 88 (a display reader) stops for void settlements too.
    expect(paymentOverdueDays({ dueDate: '2071-03-27', days: 7, endedBy: 'EMPLOYER' }, status, d('2071-04-10')) > 0).toBe(counts && status !== 'PAID');
  });

  it('an END_OF_SERVICE of an earlier period (before a rehire) no longer ends the payroll; it excludes only the days of its last month', () => {
    const cov = settlementCoverage([eos('PAID', '2071-03-10')], salary, { periodStart: '2071-03-21' });
    expect(cov.finalDay).toBeNull();
    expect(cov.excluded.map((r) => [r.start.toISOString().slice(0, 10), r.end.toISOString().slice(0, 10)])).toEqual([['2071-03-01', '2071-03-10']]);
    expect(settlementCoversMonth([eos('PAID', '2071-03-10')], salary, 2071, 4, { periodStart: '2071-03-21' })).toBe(false);
    // Of the current period: unchanged.
    expect(settlementCoverage([eos('PAID', '2071-03-25')], salary, { periodStart: '2071-03-21' }).finalDay?.toISOString().slice(0, 10)).toBe('2071-03-25');
  });
});

describe('lifecycle batch readers for payroll', () => {
  const spans = [
    { validFrom: '2024-01-01', validTo: '2071-03-11' },
    { validFrom: '2071-03-21', validTo: null },
  ];
  it('employmentGapsWithin: only the days between two periods, clipped to the range', () => {
    expect(employmentGapsWithin(spans, '2071-03-01', '2071-03-31')).toEqual([{ start: '2071-03-11', end: '2071-03-20' }]);
    expect(employmentGapsWithin(spans, '2071-04-01', '2071-04-30')).toEqual([]);
    expect(employmentGapsWithin(spans.slice(0, 1), '2071-03-01', '2071-03-31')).toEqual([]);
    expect(employmentGapsWithin(undefined, '2071-03-01', '2071-03-31')).toEqual([]);
  });
  it('currentPeriodStart: the open period, else the latest', () => {
    expect(currentPeriodStart(spans)).toBe('2071-03-21');
    expect(currentPeriodStart([spans[0]])).toBe('2024-01-01');
    expect(currentPeriodStart(undefined)).toBeNull();
  });
  it('rehire in the month: the gap is not paid (10 + 11 of 31 days)', () => {
    const gaps = employmentGapsWithin(spans, '2071-03-01', '2071-03-31').map((g) => ({ start: d(g.start), end: d(g.end) }));
    expect(employmentDaysInMonth({ year: 2071, month: 3, joinDate, excluded: gaps }).eligibleDays).toBe(21);
  });
  it('employedDuringWhere: NOTICE / TERMINATED count until their last day; a TERMINATED row without a date never', () => {
    const w = employedDuringWhere('2071-03-01', '2071-03-31');
    expect(w.joinDate).toEqual({ lte: d('2071-03-31') });
    expect(w.OR).toContainEqual({ employmentState: { in: ['NOTICE', 'TERMINATED'] }, terminationDate: { gte: d('2071-03-01') } });
    expect(w.OR).toContainEqual({ employmentState: null, isTerminated: false });
  });
});

describe('the first month an employment event affects (payroll.employment, the gate)', () => {
  const ev = (payload: Record<string, string>) => ({ payload, effectiveDate: null, occurredAt: d('2071-01-01') });
  it('affectsFrom wins over effectiveDate (a D1 moving the last day later, a V1)', () => {
    expect(effectiveMonthOf(ev({ effectiveDate: '2071-04-10', affectsFrom: '2071-03-20' }))).toEqual({ year: 2071, month: 3 });
    expect(effectiveMonthOf(ev({ effectiveDate: '2071-04-10' }))).toEqual({ year: 2071, month: 4 });
  });
});

describe('D1 converts a legacy TERMINATED row with a future last day to NOTICE (NOTICE_CANDIDATE, ADR-0004 #3)', () => {
  const cur: CurrentEmployment = {
    state: 'TERMINATED',
    terminationDate: '2071-03-20',
    exitReason: 'RESIGNATION',
    exitVoluntary: true,
    joinDate: '2024-01-01',
    period: { id: 'p', lineageId: 'l', validFrom: '2024-01-01', validTo: '2071-03-21' },
    latestChangeId: 'c',
    previousLineageEnd: null,
  };
  it('same date, released: TERMINATED → NOTICE (login re-enabled by HR)', () => {
    const p = planTransition(cur, { command: 'AMEND', date: '2071-03-20' }, '2071-03-01', true);
    expect(p).toMatchObject({ kind: 'APPLY', fromState: 'TERMINATED', toState: 'NOTICE', loginReenableRequired: true, events: ['employment.exitAmended'] });
  });
  it('same date, not released (the old meaning): nothing to correct', () => {
    expect(planTransition(cur, { command: 'AMEND', date: '2071-03-20' }, '2071-03-01', false)).toMatchObject({ kind: 'NO_CHANGE', reason: 'NOTHING_TO_CORRECT' });
  });
  it('a past last day stays TERMINATED: nothing to correct', () => {
    expect(planTransition(cur, { command: 'AMEND', date: '2071-03-20' }, '2071-03-25', true)).toMatchObject({ kind: 'NO_CHANGE' });
  });
});
