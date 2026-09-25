import { describe, expect, it } from 'vitest';
import {
  computePayrollLine,
  DEDUCTIONS_EXCEED_NOTE,
  DEFAULT_PAYROLL_SETTINGS,
  employeeDeductionsTotal,
  hasStoredBreakdown,
  payrollBreakdownColumns,
  payrollTotals,
  type PayrollLineInput,
  type StoredPayrollRow,
} from '@/lib/payroll';
import { DEFAULT_GOSI_RATES, type GosiRateLike } from '@/lib/gosi';
import { sumMoney } from '@/lib/money';
import {
  computeSettlement,
  COUNSEL_PENDING_NOTE,
  endOfServiceAward,
  FULL_AWARD_PENDING_COUNSEL_REASONS,
  isCounselPendingReason,
  TERMINATION_REASONS,
} from '@/lib/settlement';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

const RATES: GosiRateLike[] = [
  ...DEFAULT_GOSI_RATES,
  { regime: 'NEW', isSaudi: true, effectiveFrom: d('2024-07-03'), employeeRate: 9.75, employerRate: 11.75, minWage: 1500, maxWage: 45000, isProvisional: true },
  { regime: 'NEW', isSaudi: true, effectiveFrom: d('2026-07-01'), employeeRate: 10.75, employerRate: 12.75, minWage: 1500, maxWage: 45000, isProvisional: true },
];

type Over = Partial<Omit<PayrollLineInput, 'employee'>> & { employee?: Partial<PayrollLineInput['employee']> };

function line(over: Over = {}) {
  return computePayrollLine({
    year: 2026,
    month: 9,
    bonuses: [],
    overtimes: [],
    deductions: [],
    leaves: [],
    loans: [],
    settings: DEFAULT_PAYROLL_SETTINGS,
    gosiRates: RATES,
    ...over,
    employee: {
      basicSalary: 10000,
      nationality: 'سعودي',
      gosiDeduction: null,
      joinDate: d('2020-01-01'),
      gosiRegime: 'OLD',
      allowances: [
        { name: 'بدل سكن', amount: 2500, isMonthly: true, countsTowardGosi: true },
        { name: 'بدل نقل', amount: 500, isMonthly: true, countsTowardGosi: false },
      ],
      ...(over.employee ?? {}),
    },
  });
}

function expectConsistent(r: ReturnType<typeof line>) {
  const cols = payrollBreakdownColumns(r);
  // totalDeductions = sum of the employee-side columns; employer GOSI is NOT deducted.
  expect(employeeDeductionsTotal(cols)).toBe(r.totalDeductions);
  const gross = sumMoney([r.basicSalary, r.totalAllowances, r.overtimeCost]);
  expect(r.netSalary).toBe(Math.max(0, Math.round((gross - r.totalDeductions) * 100) / 100));
  expect(cols.bonusAmount).toBe(r.breakdown.bonuses);
}

describe('computePayrollLine with the GOSI rate table (stored breakdown)', () => {
  it('Saudi OLD: GOSI on basic + flagged allowances; employer share recorded, not deducted', () => {
    const r = line();
    expect(r.breakdown.gosi).toBe(1218.75); // 12,500 x 9.75%
    expect(r.breakdown.gosiEmployer).toBe(1468.75); // 12,500 x 11.75%
    expect(r.totalDeductions).toBe(1218.75);
    expect(r.netSalary).toBe(13000 - 1218.75);
    expect(r.needsReview).toBe(false);
    expect(r.reviewNote).toBeNull();
    expectConsistent(r);
  });

  it('a housing allowance NOT flagged countsTowardGosi is not in the wage (no name regex)', () => {
    const r = line({ employee: { allowances: [{ name: 'بدل سكن', amount: 2500, isMonthly: true, countsTowardGosi: false }] } });
    expect(r.breakdown.gosi).toBe(975);
  });

  it('UNKNOWN regime: line generated with OLD rates and flagged (never blocks)', () => {
    const r = line({ employee: { gosiRegime: 'UNKNOWN' } });
    expect(r.breakdown.gosi).toBe(1218.75);
    expect(r.needsReview).toBe(true);
    expect(r.reviewNote).toContain('نظام التأمينات غير مؤكد');
    expect(r.netSalary).toBeGreaterThan(0);
    expectConsistent(r);
  });

  it('NEW regime July boundary: June vs July 2026', () => {
    expect(line({ month: 6, employee: { gosiRegime: 'NEW' } }).breakdown.gosi).toBe(1218.75);
    const july = line({ month: 7, employee: { gosiRegime: 'NEW' } });
    expect(july.breakdown.gosi).toBe(1343.75); // 12,500 x 10.75%
    expect(july.breakdown.gosiEmployer).toBe(1593.75);
    expect(july.gosiProvisional).toBe(true);
    expect(july.needsReview).toBe(false);
  });

  it('non-Saudi: employer 2% only', () => {
    const r = line({ employee: { nationality: 'هندي', gosiRegime: 'UNKNOWN' } });
    expect(r.breakdown.gosi).toBe(0);
    expect(r.breakdown.gosiEmployer).toBe(250);
    expect(r.needsReview).toBe(false);
    expect(r.totalDeductions).toBe(0);
  });

  it('empty nationality is flagged for review', () => {
    const r = line({ employee: { nationality: '' } });
    expect(r.needsReview).toBe(true);
    expect(r.reviewNote).toContain('الجنسية غير محددة');
  });

  it('manual override keeps the employee amount and notes it', () => {
    const r = line({ employee: { gosiDeduction: 400 } });
    expect(r.breakdown.gosi).toBe(400);
    expect(r.breakdown.gosiEmployer).toBe(1468.75);
    expect(r.reviewNote).toContain('مبلغ يدوي');
    expect(r.needsReview).toBe(false);
  });

  it('breakdown sums equal totals with loans, violations, leave and bonuses', () => {
    const r = line({
      bonuses: [{ id: 'b1', amount: 750 }],
      deductions: [{ id: 'x1', amount: 300.3 }, { id: 'x2', amount: 99.99 }],
      loans: [{ id: 'l1', monthlyInstallment: 1000, remaining: 5000 }],
      leaves: [
        { id: 'lv', leaveType: 'UNPAID', startDate: d('2026-09-10'), endDate: d('2026-09-12'), totalDays: 3, unpaidDays: 3, totalDeduction: null },
      ],
    });
    const cols = payrollBreakdownColumns(r);
    expect(cols.bonusAmount).toBe(750);
    expect(cols.violationsDeduction).toBe(400.29);
    expect(cols.loansDeduction).toBe(1000);
    expect(cols.leaveDeduction).toBe(1299.99); // 3 days x daily rate 433.33 (13,000 / 30, rounded)
    expect(cols.gosiEmployee).toBe(1218.75);
    expect(cols.otherDeductions).toBe(0);
    expectConsistent(r);
  });

  it('deductions above the month pay: net 0, flagged, columns still add up', () => {
    const r = line({ deductions: [{ id: 'x', amount: 20000 }] });
    expect(r.netSalary).toBe(0);
    expect(r.needsReview).toBe(true);
    expect(r.reviewNote).toContain(DEDUCTIONS_EXCEED_NOTE);
    expect(employeeDeductionsTotal(payrollBreakdownColumns(r))).toBe(r.totalDeductions);
  });

  it('legacy path (no gosiRates) is unchanged: no employer share, no flags', () => {
    const r = line({ gosiRates: undefined });
    expect(r.breakdown.gosiEmployer).toBe(0);
    expect(r.needsReview).toBe(false);
  });
});

describe('payrollTotals / hasStoredBreakdown (server totals from stored rows)', () => {
  const row = (over: Partial<StoredPayrollRow>): StoredPayrollRow => ({
    status: 'DRAFT',
    basicSalary: 10000,
    totalAllowances: 3750,
    overtimeCost: 100,
    totalDeductions: 2619.04,
    netSalary: 11230.96,
    gosiEmployee: 1218.75,
    gosiEmployer: 1468.75,
    loansDeduction: 1000,
    violationsDeduction: 400.29,
    leaveDeduction: 0,
    otherDeductions: 0,
    bonusAmount: 750,
    needsReview: false,
    reviewNote: null,
    ...over,
  });

  it('sums the stored columns; employer cost = gross + employer GOSI', () => {
    const rows = [row({}), row({ needsReview: true, gosiEmployer: 200, gosiEmployee: 0, totalDeductions: 1400.29, netSalary: 12449.71 })];
    const t = payrollTotals(rows);
    expect(t.basicSalary).toBe(20000);
    expect(t.bonusAmount).toBe(1500);
    expect(t.recurringAllowances).toBe(6000);
    expect(t.gross).toBe(27700);
    expect(t.gosiEmployer).toBe(1668.75);
    expect(t.employerCost).toBe(29368.75);
    expect(t.totalDeductions).toBe(sumMoney([t.gosiEmployee, t.loansDeduction, t.violationsDeduction, t.leaveDeduction, t.otherDeductions]));
    expect(t.netSalary).toBe(sumMoney([11230.96, 12449.71]));
  });

  it('rows generated before the breakdown columns are detected, never guessed', () => {
    expect(hasStoredBreakdown(row({}))).toBe(true);
    expect(hasStoredBreakdown(row({ gosiEmployee: 0, loansDeduction: 0, violationsDeduction: 0 }))).toBe(false);
    expect(hasStoredBreakdown(row({ totalDeductions: 0, gosiEmployee: 0, loansDeduction: 0, violationsDeduction: 0 }))).toBe(true);
  });
});

describe('settlement: ARTICLE_81 / ARTICLE_87 / CONTRACT_EXPIRY (pending counsel)', () => {
  const wage = 10000;

  it('are accepted reasons and flagged as pending the counsel', () => {
    for (const r of ['ARTICLE_81', 'ARTICLE_87', 'CONTRACT_EXPIRY'] as const) {
      expect(TERMINATION_REASONS).toContain(r);
      expect(FULL_AWARD_PENDING_COUNSEL_REASONS).toContain(r);
      expect(isCounselPendingReason(r)).toBe(true);
    }
    expect(isCounselPendingReason('RESIGNATION')).toBe(false);
    expect(isCounselPendingReason(null)).toBe(false);
    expect(COUNSEL_PENDING_NOTE).toBe('بانتظار تأكيد المستشار');
  });

  it('give the full award, same as an employer termination (incl. < 2 years)', () => {
    for (const years of [1, 3, 5, 7.5, 12]) {
      const full = endOfServiceAward(wage, years, 'COMPANY_TERMINATION');
      expect(endOfServiceAward(wage, years, 'ARTICLE_81')).toBe(full);
      expect(endOfServiceAward(wage, years, 'ARTICLE_87')).toBe(full);
      expect(endOfServiceAward(wage, years, 'CONTRACT_EXPIRY')).toBe(full);
    }
    expect(endOfServiceAward(wage, 3, 'ARTICLE_81')).toBe(15000);
    expect(endOfServiceAward(wage, 3, 'RESIGNATION')).toBe(5000);
  });

  it('computeSettlement uses the full award for ARTICLE_81', () => {
    const base = {
      type: 'END_OF_SERVICE' as const,
      salaryBasis: 'total' as const,
      employee: { basicSalary: 8000, allowances: [{ amount: 2000, isMonthly: true }], joinDate: d('2023-01-01'), nationality: 'سعودي' },
      lastWorkingDate: d('2025-12-31'),
      asOf: d('2026-01-05'),
      leaves: [],
      outstandingLoans: 0,
      overtime: 0,
      manualEntitlements: 0,
      manualDeductions: 0,
    };
    const a81 = computeSettlement({ ...base, terminationReason: 'ARTICLE_81' });
    const company = computeSettlement({ ...base, terminationReason: 'COMPANY_TERMINATION' });
    const resign = computeSettlement({ ...base, terminationReason: 'RESIGNATION' });
    expect(a81.endOfServiceAmount).toBe(15000); // 3 years x half a month of 10,000
    expect(a81.endOfServiceAmount).toBe(company.endOfServiceAmount);
    expect(resign.endOfServiceAmount).toBe(5000);
  });
});
