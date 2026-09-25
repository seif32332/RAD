import { describe, expect, it } from 'vitest';
import {
  accruedLeaveBalance,
  computeSettlement,
  endOfServiceAward,
  exitReentryVisaFee,
  monthOf,
  yearsOfService,
  type SettlementInput,
  type SettlementLeaveLike,
} from '@/lib/settlement';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe('endOfServiceAward (Saudi Labor Law arts. 84/85)', () => {
  const wage = 10000;

  it('termination by the employer: half a month per year for 5 years, a full month per year after', () => {
    expect(endOfServiceAward(wage, 3, 'COMPANY_TERMINATION')).toBe(15000);
    expect(endOfServiceAward(wage, 5, 'COMPANY_TERMINATION')).toBe(25000);
    expect(endOfServiceAward(wage, 7.5, 'COMPANY_TERMINATION')).toBe(50000);
    expect(endOfServiceAward(wage, 12, 'COMPANY_TERMINATION')).toBe(95000);
  });

  it('prorates fractions of a year', () => {
    expect(endOfServiceAward(wage, 0.5, 'COMPANY_TERMINATION')).toBe(2500);
    expect(endOfServiceAward(12000, 1 + 1 / 12, 'COMPANY_TERMINATION')).toBe(6500);
  });

  it('resignation: nothing under 2 years, 1/3 for 2-5, 2/3 for 5-10, full from 10 years', () => {
    expect(endOfServiceAward(wage, 1.9, 'RESIGNATION')).toBe(0);
    expect(endOfServiceAward(wage, 2, 'RESIGNATION')).toBe(3333.33);
    expect(endOfServiceAward(wage, 3, 'RESIGNATION')).toBe(5000); // 15000 / 3
    expect(endOfServiceAward(wage, 7, 'RESIGNATION')).toBe(30000); // (25000 + 20000) * 2/3
    expect(endOfServiceAward(wage, 10, 'RESIGNATION')).toBe(75000); // full award
    expect(endOfServiceAward(wage, 12, 'RESIGNATION')).toBe(95000);
  });

  it('article 80 dismissal and probation termination pay nothing', () => {
    expect(endOfServiceAward(wage, 12, 'ARTICLE_80')).toBe(0);
    expect(endOfServiceAward(wage, 0.2, 'PROBATION')).toBe(0);
  });

  it('treats a missing reason as termination and guards bad input', () => {
    expect(endOfServiceAward(wage, 3, null)).toBe(15000);
    expect(endOfServiceAward(wage, 0, 'COMPANY_TERMINATION')).toBe(0);
    expect(endOfServiceAward(wage, -1, 'COMPANY_TERMINATION')).toBe(0);
    expect(endOfServiceAward(0, 5, 'COMPANY_TERMINATION')).toBe(0);
    expect(endOfServiceAward(wage, Number.NaN, 'COMPANY_TERMINATION')).toBe(0);
  });
});

describe('yearsOfService (last working day inclusive)', () => {
  it('counts exact anniversaries as whole years', () => {
    expect(yearsOfService(d('2020-01-01'), d('2022-12-31'))).toBe(3);
    expect(yearsOfService(d('2021-03-15'), d('2026-03-14'))).toBe(5);
    expect(yearsOfService(d('2014-01-01'), d('2025-12-31'))).toBe(12);
  });

  it('counts months as 1/12 and remaining days as 1/360', () => {
    expect(yearsOfService(d('2019-01-01'), d('2026-06-30'))).toBeCloseTo(7.5, 10);
    expect(yearsOfService(d('2026-01-01'), d('2026-01-31'))).toBeCloseTo(1 / 12, 10);
    expect(yearsOfService(d('2026-01-01'), d('2026-01-10'))).toBeCloseTo(10 / 360, 10);
    // 29 Feb anniversaries fall on 28 Feb in non-leap years.
    expect(yearsOfService(d('2024-02-29'), d('2025-02-27'))).toBe(1);
    expect(yearsOfService(d('2024-02-29'), d('2025-02-26'))).toBeCloseTo(11 / 12 + 29 / 360, 10);
  });

  it('returns 0 without a join date or when the last day is before joining', () => {
    expect(yearsOfService(null, d('2026-01-01'))).toBe(0);
    expect(yearsOfService(undefined, d('2026-01-01'))).toBe(0);
    expect(yearsOfService(d('2026-05-10'), d('2026-05-01'))).toBe(0);
    expect(yearsOfService(d('2026-05-10'), d('2025-05-01'))).toBe(0);
  });

  it('feeds the award: 1.9 years of service resigning gets nothing', () => {
    const years = yearsOfService(d('2024-09-01'), d('2026-07-20'));
    expect(years).toBeLessThan(2);
    expect(endOfServiceAward(9000, years, 'RESIGNATION')).toBe(0);
  });
});

const leave = (p: Partial<SettlementLeaveLike> & { startDate: Date }): SettlementLeaveLike => ({
  leaveType: 'ANNUAL',
  status: 'APPROVED',
  endDate: p.startDate,
  createdAt: p.startDate,
  totalDays: p.paidDays ?? 0,
  paidDays: 0,
  ...p,
});

describe('accruedLeaveBalance', () => {
  it('accrues 21 days a year during the first 5 years and 30 after', () => {
    expect(accruedLeaveBalance({ joinDate: d('2021-01-01'), asOf: d('2022-01-01'), leaves: [] })).toBeCloseTo(21, 2);
    expect(
      accruedLeaveBalance({ joinDate: d('2015-01-01'), accrualStartDate: d('2023-01-01'), asOf: d('2024-01-01'), leaves: [] }),
    ).toBeCloseTo(30, 2);
  });

  it('subtracts paid days only and can go negative', () => {
    const leaves = [
      leave({ startDate: d('2021-03-01'), paidDays: 10, totalDays: 10 }),
      leave({ startDate: d('2021-05-01'), paidDays: 0, totalDays: 6 }), // fully unpaid: balance untouched
      leave({ startDate: d('2021-07-01'), paidDays: 15, totalDays: 15, status: 'COMPLETED' }),
      leave({ startDate: d('2021-08-01'), paidDays: 5, status: 'REJECTED' }),
      leave({ startDate: d('2021-09-01'), paidDays: 5, leaveType: 'SICK' }),
    ];
    expect(accruedLeaveBalance({ joinDate: d('2021-01-01'), asOf: d('2022-01-01'), leaves })).toBeCloseTo(21 - 25, 2);
  });

  it('counts totalDays for legacy leaves without paidDays', () => {
    const legacy: SettlementLeaveLike = { ...leave({ startDate: d('2021-03-01') }), paidDays: null, totalDays: 4 };
    expect(accruedLeaveBalance({ joinDate: d('2021-01-01'), asOf: d('2022-01-01'), leaves: [legacy] })).toBeCloseTo(17, 2);
  });

  it('does not subtract the leave being settled', () => {
    const current = leave({ startDate: d('2022-01-02'), endDate: d('2022-01-31'), paidDays: 21, createdAt: d('2021-12-20') });
    expect(
      accruedLeaveBalance({
        joinDate: d('2021-01-01'),
        asOf: d('2022-01-01'),
        leaves: [current],
        currentLeaveStart: d('2022-01-02'),
        currentLeaveEnd: d('2022-01-31'),
      }),
    ).toBeCloseTo(21, 2);
  });

  it('honours a company setting above the statutory minimum', () => {
    expect(
      accruedLeaveBalance({ joinDate: d('2021-01-01'), asOf: d('2022-01-01'), leaves: [], annualLeaveDaysSetting: 25 }),
    ).toBeCloseTo(25, 2);
  });

  it('returns 0 without a join date', () => {
    expect(accruedLeaveBalance({ joinDate: null, asOf: d('2022-01-01'), leaves: [] })).toBe(0);
  });
});

describe('exitReentryVisaFee', () => {
  it('scales with the leave length', () => {
    expect(exitReentryVisaFee(30)).toBe(200);
    expect(exitReentryVisaFee(60)).toBe(200);
    expect(exitReentryVisaFee(61)).toBe(300);
    expect(exitReentryVisaFee(90)).toBe(300);
    expect(exitReentryVisaFee(120)).toBe(400);
    expect(exitReentryVisaFee(121)).toBe(500);
  });
});

describe('computeSettlement', () => {
  const base = (over: Partial<SettlementInput>): SettlementInput => ({
    type: 'END_OF_SERVICE',
    terminationReason: 'COMPANY_TERMINATION',
    salaryBasis: 'total',
    employee: {
      basicSalary: 8000,
      allowances: [
        { name: 'بدل سكن', amount: 2000, isMonthly: true },
        { name: 'مكافأة', amount: 5000, isMonthly: false },
      ],
      joinDate: d('2016-01-02'),
      nationality: 'مصري',
      leaveAccrualStartDate: d('2025-01-01'),
    },
    lastWorkingDate: d('2026-01-01'),
    asOf: d('2026-01-10'),
    leaves: [],
    outstandingLoans: 0,
    overtime: 0,
    manualEntitlements: 0,
    manualDeductions: 0,
    ...over,
  });

  it('end of service after 10 years: award, working days, leave compensation and loans', () => {
    const leaves: SettlementLeaveLike[] = [
      leave({ startDate: d('2025-06-10'), endDate: d('2025-06-19'), paidDays: 10, createdAt: d('2025-06-01') }),
      leave({ startDate: d('2025-08-10'), paidDays: 4, status: 'COMPLETED', createdAt: d('2025-08-01') }),
      leave({ startDate: d('2025-10-10'), paidDays: 0, totalDays: 5, createdAt: d('2025-10-01') }),
      leave({ startDate: d('2024-05-10'), paidDays: 7, createdAt: d('2024-05-01') }), // before the accrual start
    ];
    const r = computeSettlement(base({ leaves, outstandingLoans: 1500 }));
    expect(r.salaryUsed).toBe(10000); // one-off bonus is not part of the wage
    expect(r.dailySalary).toBe(333.33);
    expect(r.yearsOfService).toBe(10);
    expect(r.endOfServiceAmount).toBe(75000);
    expect(r.workingDaysInMonth).toBe(1);
    expect(r.workingDaysSalary).toBe(333.33);
    expect(r.accruedLeaveDays).toBeCloseTo(16, 2); // 30 accrued - 10 - 4
    expect(r.leaveDaysToPay).toBeCloseTo(16, 2);
    expect(r.leaveCompensation).toBe(5333.28);
    expect(r.loansDeduction).toBe(1500);
    expect(r.totalDeductions).toBe(1500);
    expect(r.totalSettlement).toBe(79166.61);
  });

  it('article 80: no award but unused leave is still paid', () => {
    const r = computeSettlement(base({ terminationReason: 'ARTICLE_80' }));
    expect(r.endOfServiceAmount).toBe(0);
    expect(r.leaveCompensation).toBe(roundTo(333.33 * 30));
    expect(r.totalSettlement).toBe(roundTo(333.33 + 333.33 * 30));
  });

  it('resignation after 7 years pays two thirds', () => {
    const r = computeSettlement(
      base({
        terminationReason: 'RESIGNATION',
        employee: { ...base({}).employee, joinDate: d('2019-01-02') },
      }),
    );
    expect(r.yearsOfService).toBe(7);
    expect(r.endOfServiceAmount).toBe(30000);
  });

  it('does not pay the working days of a month already paid by payroll', () => {
    const r = computeSettlement(base({ lastMonthAlreadyPaid: true }));
    expect(r.workingDaysInMonth).toBe(0);
    expect(r.workingDaysSalary).toBe(0);
  });

  it('charges a negative leave balance to non-Saudis only', () => {
    const over = {
      employee: { basicSalary: 3000, allowances: [], joinDate: d('2024-01-01'), nationality: 'مصري', leaveAccrualStartDate: null },
      lastWorkingDate: d('2024-07-01'), // 182 days -> 10.47 accrued
      leaves: [leave({ startDate: d('2024-03-01'), paidDays: 15 })],
    } satisfies Partial<SettlementInput>;
    const foreign = computeSettlement(base(over));
    expect(foreign.accruedLeaveDays).toBeCloseTo(-4.53, 2);
    expect(foreign.leaveCompensation).toBe(0);
    expect(foreign.excessDeduction).toBe(135.9);
    const saudi = computeSettlement(base({ ...over, employee: { ...over.employee, nationality: 'سعودي' } }));
    expect(saudi.excessDeduction).toBe(0);
    const waived = computeSettlement(base({ ...over, waiveExcessCost: true }));
    expect(waived.excessDeduction).toBe(0);
  });

  it('leave settlement: pays up to the balance, charges excess days and the visa fee', () => {
    const current = leave({ startDate: d('2022-01-02'), endDate: d('2022-01-31'), paidDays: 21, createdAt: d('2021-12-20') });
    const r = computeSettlement(
      base({
        type: 'LEAVE_SETTLEMENT',
        terminationReason: null,
        employee: { basicSalary: 3000, allowances: [], joinDate: d('2021-01-01'), nationality: 'هندي', leaveAccrualStartDate: null },
        lastWorkingDate: d('2022-01-01'),
        leaves: [current],
        leaveStartDate: d('2022-01-02'),
        leaveEndDate: d('2022-01-31'),
        requestedLeaveDays: 30,
        leaveOutsideKsa: true,
      }),
    );
    expect(r.endOfServiceAmount).toBe(0);
    expect(r.accruedLeaveDays).toBeCloseTo(21, 2);
    expect(r.leaveDaysToPay).toBeCloseTo(21, 2);
    expect(r.excessDays).toBeCloseTo(9, 2);
    expect(r.excessDeduction).toBe(270);
    expect(r.leaveCompensation).toBe(2100);
    expect(r.visaFeeAmount).toBe(200);
    expect(r.workingDaysSalary).toBe(100);
    expect(r.totalSettlement).toBe(1930);
  });

  it('adds manual entitlements, flight ticket and overtime; subtracts manual deductions', () => {
    const r = computeSettlement(
      base({
        terminationReason: 'ARTICLE_80',
        flightTicketOption: 'amount',
        flightTicketAmount: 1200,
        overtime: 250.555,
        manualEntitlements: 100,
        manualDeductions: 50,
      }),
    );
    expect(r.overtime).toBe(250.56);
    expect(r.additionalEntitlements).toBe(1550.56);
    expect(r.totalDeductions).toBe(50);
  });

  it('basic salary basis ignores allowances', () => {
    const r = computeSettlement(base({ salaryBasis: 'basic' }));
    expect(r.salaryUsed).toBe(8000);
    expect(r.dailySalary).toBe(266.67);
    expect(r.endOfServiceAmount).toBe(60000);
  });
});

describe('monthOf', () => {
  it('returns the stored calendar month', () => {
    expect(monthOf(d('2026-12-31'))).toEqual({ year: 2026, month: 12 });
    expect(monthOf(d('2026-01-01'))).toEqual({ year: 2026, month: 1 });
  });
});

function roundTo(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
