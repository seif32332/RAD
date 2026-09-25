import { describe, expect, it } from 'vitest';
import {
  annualEntitlementRates,
  computeLeaveBalance,
  computeLeaveRequest,
  computeSickLeaveTiers,
  dailyWage,
  isSaudiNationality,
  leaveDeductionForMonth,
  rangesOverlap,
  recalculateShortenedLeave,
  splitLeaveDaysByMonth,
  type LeaveBalanceLeave,
} from '@/lib/leave';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

const annual = (p: Partial<LeaveBalanceLeave> & { startDate: string }): LeaveBalanceLeave => ({
  leaveType: 'ANNUAL',
  status: 'APPROVED',
  paidDays: 0,
  endDate: p.startDate,
  createdAt: p.startDate,
  ...p,
});

describe('annualEntitlementRates', () => {
  it('never goes below the statutory 21/30 days', () => {
    expect(annualEntitlementRates()).toEqual({ under5: 21, from5: 30 });
    expect(annualEntitlementRates(10)).toEqual({ under5: 21, from5: 30 });
    expect(annualEntitlementRates(25)).toEqual({ under5: 25, from5: 30 });
    expect(annualEntitlementRates(35)).toEqual({ under5: 35, from5: 35 });
    expect(annualEntitlementRates(Number.NaN)).toEqual({ under5: 21, from5: 30 });
  });
});

describe('computeLeaveBalance', () => {
  it('accrues 21 days in a full (non-leap) year during the first 5 years', () => {
    const b = computeLeaveBalance({ joinDate: '2021-01-01', asOf: '2022-01-01', leaves: [] });
    expect(b.accrued).toBe(21);
    expect(b.available).toBe(21);
    expect(b.annualEntitlement).toBe(21);
    expect(b.serviceYears).toBe(1);
    expect(b.accrualStartDate).toBe('2021-01-01');
    expect(b.asOf).toBe('2022-01-01');
  });

  it('prorates partial years by day', () => {
    const b = computeLeaveBalance({ joinDate: '2021-01-01', asOf: '2021-07-02', leaves: [] }); // 182 days
    expect(b.accrued).toBe(10.47);
    expect(computeLeaveBalance({ joinDate: '2021-01-01', asOf: '2021-01-01', leaves: [] }).accrued).toBe(0);
  });

  it('switches to 30 days a year after 5 years of service', () => {
    const b = computeLeaveBalance({ joinDate: '2019-01-01', asOf: '2025-01-01', leaves: [] });
    // 1826 days before the 5-year mark (2024-01-01) at 21/365, 366 days after at 30/365
    expect(b.accrued).toBe(Math.round(((1826 * 21 + 366 * 30) / 365) * 100) / 100);
    expect(b.annualEntitlement).toBe(30);

    const afterSettlement = computeLeaveBalance({
      joinDate: '2015-01-01',
      leaveAccrualStartDate: '2023-01-01',
      asOf: '2024-01-01',
      leaves: [],
    });
    expect(afterSettlement.accrued).toBe(30);
  });

  it('straddles the 5-year mark within one accrual period', () => {
    const b = computeLeaveBalance({
      joinDate: '2019-01-01',
      leaveAccrualStartDate: '2023-01-01',
      asOf: '2025-01-01',
      leaves: [],
    });
    expect(b.accrued).toBe(Math.round(((365 * 21 + 366 * 30) / 365) * 100) / 100);
  });

  it('deducts paid days of approved and completed balance leaves only', () => {
    const leaves: LeaveBalanceLeave[] = [
      annual({ id: 'a', startDate: '2021-03-01', paidDays: 5 }),
      annual({ id: 'b', startDate: '2021-04-01', paidDays: 3, status: 'COMPLETED' }),
      annual({ id: 'c', startDate: '2021-05-01', paidDays: 2, leaveType: 'EMERGENCY' }),
      annual({ id: 'd', startDate: '2021-06-01', paidDays: 4, status: 'PENDING' }),
      annual({ id: 'e', startDate: '2021-07-01', paidDays: 6, status: 'REJECTED' }),
      annual({ id: 'f', startDate: '2021-08-01', paidDays: 7, leaveType: 'SICK' }),
      annual({ id: 'g', startDate: '2021-09-01', paidDays: 0, status: 'APPROVED' }), // fully unpaid
    ];
    const b = computeLeaveBalance({ joinDate: '2021-01-01', asOf: '2022-01-01', leaves });
    expect(b.taken).toBe(10);
    expect(b.pending).toBe(4);
    expect(b.available).toBe(11);

    const excluding = computeLeaveBalance({ joinDate: '2021-01-01', asOf: '2022-01-01', leaves, excludeLeaveId: 'a' });
    expect(excluding.taken).toBe(5);
  });

  it('is not reset when the employee returns from leave (COMPLETED still counts)', () => {
    const approved = computeLeaveBalance({
      joinDate: '2021-01-01',
      asOf: '2022-01-01',
      leaves: [annual({ startDate: '2021-03-01', endDate: '2021-03-10', paidDays: 10 })],
    });
    const returned = computeLeaveBalance({
      joinDate: '2021-01-01',
      asOf: '2022-01-01',
      leaves: [annual({ startDate: '2021-03-01', endDate: '2021-03-10', paidDays: 10, status: 'COMPLETED' })],
    });
    expect(returned.available).toBe(approved.available);
    expect(returned.available).toBe(11);
    expect(returned.accrualStartDate).toBe('2021-01-01');
  });

  it('ignores leaves recorded before the accrual start (already settled)', () => {
    const b = computeLeaveBalance({
      joinDate: '2019-01-01',
      leaveAccrualStartDate: '2021-01-01',
      asOf: '2022-01-01',
      leaves: [annual({ startDate: '2020-12-01', paidDays: 10 }), annual({ startDate: '2021-02-01', paidDays: 5 })],
    });
    expect(b.taken).toBe(5);
    expect(b.available).toBe(16);
  });

  it('never returns a negative available balance', () => {
    const b = computeLeaveBalance({
      joinDate: '2021-01-01',
      asOf: '2021-06-01',
      leaves: [annual({ startDate: '2021-02-01', paidDays: 30 })],
    });
    expect(b.available).toBe(0);
  });

  it('counts legacy leaves without paidDays as totalDays - unpaidDays', () => {
    const b = computeLeaveBalance({
      joinDate: '2021-01-01',
      asOf: '2022-01-01',
      leaves: [annual({ startDate: '2021-02-01', paidDays: null, totalDays: 6, unpaidDays: 2 })],
    });
    expect(b.taken).toBe(4);
  });

  it('applies a company setting above the statutory minimum', () => {
    const b = computeLeaveBalance({ joinDate: '2021-01-01', asOf: '2022-01-01', leaves: [], annualLeaveDaysSetting: 25 });
    expect(b.accrued).toBe(25);
  });

  it('never accrues from before the join date', () => {
    const b = computeLeaveBalance({
      joinDate: '2021-01-01',
      leaveAccrualStartDate: '2020-01-01',
      asOf: '2022-01-01',
      leaves: [],
    });
    expect(b.accrualStartDate).toBe('2021-01-01');
    expect(b.accrued).toBe(21);
  });
});

describe('computeSickLeaveTiers (art. 117)', () => {
  it('splits into full / 75% / unpaid / beyond 120 days', () => {
    expect(computeSickLeaveTiers(0, 10)).toEqual({ past: 0, full: 10, partial: 0, unpaid: 0, beyond: 0 });
    expect(computeSickLeaveTiers(20, 20)).toEqual({ past: 20, full: 10, partial: 10, unpaid: 0, beyond: 0 });
    expect(computeSickLeaveTiers(25, 100)).toEqual({ past: 25, full: 5, partial: 60, unpaid: 30, beyond: 5 });
    expect(computeSickLeaveTiers(-5, 1)).toEqual({ past: 0, full: 1, partial: 0, unpaid: 0, beyond: 0 });
  });
});

describe('computeLeaveRequest', () => {
  it('annual leave within the balance is fully paid', () => {
    const r = computeLeaveRequest({ leaveType: 'ANNUAL', totalDays: 10, availableBalance: 15, dailyRate: 100 });
    expect(r).toMatchObject({ paidDays: 10, unpaidDays: 0, totalDeduction: 0, issue: null });
  });

  it('annual leave above the balance: whole balance days are paid, the rest unpaid', () => {
    const r = computeLeaveRequest({ leaveType: 'ANNUAL', totalDays: 10, availableBalance: 7.6, dailyRate: 100 });
    expect(r).toMatchObject({ paidDays: 7, unpaidDays: 3, totalDeduction: 300, issue: 'EXCESS_NOT_ACCEPTED' });
    const accepted = computeLeaveRequest({
      leaveType: 'ANNUAL',
      totalDays: 10,
      availableBalance: 7.6,
      dailyRate: 100,
      acceptUnpaidExtraDays: true,
    });
    expect(accepted.issue).toBeNull();
    const waived = computeLeaveRequest({
      leaveType: 'ANNUAL',
      totalDays: 10,
      availableBalance: 7.6,
      dailyRate: 100,
      acceptUnpaidExtraDays: true,
      waiveDeduction: true,
    });
    expect(waived).toMatchObject({ unpaidDays: 3, totalDeduction: 0 });
  });

  it('unpaid leave is refused while there is annual balance', () => {
    expect(computeLeaveRequest({ leaveType: 'UNPAID', totalDays: 5, availableBalance: 3, dailyRate: 100 })).toMatchObject({
      paidDays: 0,
      unpaidDays: 5,
      totalDeduction: 500,
      issue: 'UNPAID_WITH_BALANCE',
    });
    expect(computeLeaveRequest({ leaveType: 'UNPAID', totalDays: 5, availableBalance: 0.5, dailyRate: 100 }).issue).toBeNull();
  });

  it('sick leave deducts 25% on the 75% tier and 100% on unpaid days', () => {
    const r = computeLeaveRequest({ leaveType: 'SICK', totalDays: 10, availableBalance: 0, dailyRate: 100, pastSickDays: 25 });
    expect(r).toMatchObject({ paidDays: 10, unpaidDays: 0, totalDeduction: 125, issue: null });
    const over = computeLeaveRequest({ leaveType: 'SICK', totalDays: 10, availableBalance: 0, dailyRate: 100, pastSickDays: 115 });
    expect(over).toMatchObject({ paidDays: 0, unpaidDays: 10, totalDeduction: 1000, issue: 'SICK_LIMIT_EXCEEDED' });
  });
});

describe('dailyWage / isSaudiNationality', () => {
  it('dailyWage = basic / 30', () => {
    expect(dailyWage(9000)).toBe(300);
    expect(dailyWage(10000)).toBe(333.33);
    expect(dailyWage(null)).toBe(0);
  });

  it('recognizes Saudi nationality labels', () => {
    expect(isSaudiNationality('سعودي')).toBe(true);
    expect(isSaudiNationality(' Saudi ')).toBe(true);
    expect(isSaudiNationality('غير سعودي')).toBe(false);
    expect(isSaudiNationality('مصري')).toBe(false);
    expect(isSaudiNationality(null)).toBe(false);
  });
});

describe('splitLeaveDaysByMonth', () => {
  it('splits a leave across months, paid days first', () => {
    expect(splitLeaveDaysByMonth('2026-01-28', '2026-02-03', 5)).toEqual([
      { year: 2026, month: 1, days: 4, paidDays: 4, unpaidDays: 0 },
      { year: 2026, month: 2, days: 3, paidDays: 1, unpaidDays: 2 },
    ]);
  });

  it('crosses the year boundary and treats missing paidDays as all paid', () => {
    expect(splitLeaveDaysByMonth(d('2025-12-30'), d('2026-01-02'))).toEqual([
      { year: 2025, month: 12, days: 2, paidDays: 2, unpaidDays: 0 },
      { year: 2026, month: 1, days: 2, paidDays: 2, unpaidDays: 0 },
    ]);
  });

  it('handles single-day and multi-month leaves', () => {
    expect(splitLeaveDaysByMonth('2026-03-15', '2026-03-15', 0)).toEqual([
      { year: 2026, month: 3, days: 1, paidDays: 0, unpaidDays: 1 },
    ]);
    const long = splitLeaveDaysByMonth('2024-01-15', '2024-04-10', 30);
    expect(long.map((r) => r.days)).toEqual([17, 29, 31, 10]);
    expect(long.reduce((s, r) => s + r.paidDays, 0)).toBe(30);
    expect(long.reduce((s, r) => s + r.unpaidDays, 0)).toBe(57);
  });

  it('returns nothing for an inverted range', () => {
    expect(splitLeaveDaysByMonth('2026-03-15', '2026-03-10', 0)).toEqual([]);
  });
});

describe('leaveDeductionForMonth (leave.ts)', () => {
  const lv = { startDate: '2026-01-28', endDate: '2026-02-03', paidDays: 5, unpaidDays: 2, totalDeduction: 200 };

  it('charges the deduction in the month of the unpaid days', () => {
    expect(leaveDeductionForMonth(lv, 2026, 1)).toBe(0);
    expect(leaveDeductionForMonth(lv, 2026, 2)).toBe(200);
    expect(leaveDeductionForMonth(lv, 2026, 3)).toBe(0);
  });

  it('prorates by all days when the deduction is not tied to unpaid days (75% sick days)', () => {
    const sick = { startDate: '2026-01-27', endDate: '2026-02-05', paidDays: 10, unpaidDays: 0, totalDeduction: 250 };
    expect(leaveDeductionForMonth(sick, 2026, 1)).toBe(125);
    expect(leaveDeductionForMonth(sick, 2026, 2)).toBe(125);
  });

  it('returns 0 without a deduction', () => {
    expect(leaveDeductionForMonth({ ...lv, totalDeduction: 0 }, 2026, 2)).toBe(0);
    expect(leaveDeductionForMonth({ ...lv, totalDeduction: null }, 2026, 2)).toBe(0);
  });
});

describe('recalculateShortenedLeave', () => {
  it('removes unpaid days first when returning early', () => {
    expect(
      recalculateShortenedLeave({
        leaveType: 'ANNUAL',
        paidDays: 5,
        unpaidDays: 5,
        totalDeduction: 500,
        dailyDeductionRate: 100,
        newTotalDays: 7,
      }),
    ).toEqual({ totalDays: 7, paidDays: 5, unpaidDays: 2, totalDeduction: 200 });
    expect(
      recalculateShortenedLeave({
        leaveType: 'ANNUAL',
        paidDays: 5,
        unpaidDays: 5,
        totalDeduction: 500,
        dailyDeductionRate: 100,
        newTotalDays: 3,
      }),
    ).toEqual({ totalDays: 3, paidDays: 3, unpaidDays: 0, totalDeduction: 0 });
  });

  it('keeps a waived deduction waived', () => {
    expect(
      recalculateShortenedLeave({
        leaveType: 'ANNUAL',
        paidDays: 5,
        unpaidDays: 5,
        totalDeduction: 0,
        dailyDeductionRate: 100,
        newTotalDays: 8,
      }).totalDeduction,
    ).toBe(0);
  });

  it('recomputes sick tiers for the shorter leave', () => {
    expect(
      recalculateShortenedLeave({
        leaveType: 'SICK',
        paidDays: 10,
        unpaidDays: 0,
        totalDeduction: 125,
        dailyDeductionRate: 100,
        newTotalDays: 6,
        pastSickDays: 25,
      }),
    ).toEqual({ totalDays: 6, paidDays: 6, unpaidDays: 0, totalDeduction: 25 });
  });
});

describe('rangesOverlap', () => {
  it('detects shared days (inclusive)', () => {
    expect(rangesOverlap('2026-01-01', '2026-01-10', '2026-01-10', '2026-01-20')).toBe(true);
    expect(rangesOverlap('2026-01-01', '2026-01-10', '2026-01-11', '2026-01-20')).toBe(false);
    expect(rangesOverlap('2026-01-05', '2026-01-06', '2026-01-01', '2026-01-31')).toBe(true);
  });
});
