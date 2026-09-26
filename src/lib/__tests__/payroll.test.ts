import { describe, expect, it } from 'vitest';
import { roundMoney } from '@/lib/money';
import {
  basicHourlyRate,
  computePayrollLine,
  dailyRate,
  DEFAULT_PAYROLL_SETTINGS,
  employmentDaysInMonth,
  gosiEmployeeAmount,
  housingAllowance,
  isSaudiNational,
  isWeekend,
  leaveDeductionForMonth,
  monthlyWage,
  overtimeAmount,
  overtimeBasisForEmployee,
  overtimeHourlyRate,
  normalizeOvertimeBasis,
  payrollCompanyId,
  totalHourlyRate,
  parsePayrollMonthKey,
  parsePayrollSettings,
  payrollMonthKey,
  settlementCoverage,
  type LeaveLike,
  type PayrollLineInput,
} from '@/lib/payroll';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

const housing = { name: 'بدل سكن', amount: 2500, isMonthly: true };
const transport = { name: 'بدل نقل', amount: 500, isMonthly: true };
const bonus = { name: 'مكافأة', amount: 1000, isMonthly: false };

type LineOverrides = Partial<Omit<PayrollLineInput, 'employee'>> & { employee?: Partial<PayrollLineInput['employee']> };

function line(over: LineOverrides) {
  const { employee, ...rest } = over;
  return computePayrollLine({
    year: 2026,
    month: 9,
    bonuses: [],
    overtimes: [],
    deductions: [],
    leaves: [],
    loans: [],
    settings: DEFAULT_PAYROLL_SETTINGS,
    ...rest,
    employee: {
      basicSalary: 10000,
      nationality: 'مصري',
      gosiDeduction: null,
      joinDate: d('2020-01-01'),
      allowances: [],
      ...employee,
    },
  });
}

describe('rates', () => {
  it('dailyRate = (basic + recurring allowances) / 30; one-off bonuses excluded', () => {
    const emp = { basicSalary: 9000, allowances: [{ ...housing, amount: 2250 }, bonus] };
    expect(monthlyWage(emp)).toBe(11250);
    expect(dailyRate(emp)).toBe(375);
    expect(dailyRate(emp, 'basic')).toBe(300);
    expect(dailyRate({ basicSalary: null })).toBe(0);
    expect(housingAllowance([housing, transport, bonus])).toBe(2500);
  });

  it('basic hourly rate = basic / (30 x hours per day)', () => {
    expect(basicHourlyRate({ basicSalary: 9000 })).toBe(37.5);
    expect(basicHourlyRate({ basicSalary: 9000 }, { ...DEFAULT_PAYROLL_SETTINGS, workHoursPerDay: 10 })).toBe(30);
  });
});

describe('overtime', () => {
  const emp = { basicSalary: 9000 };

  it('weekday hours use the 1.5 multiplier', () => {
    expect(overtimeAmount({ date: d('2026-09-23'), type: 'HOURS', hours: 2, amount: null }, emp)).toBe(112.5);
  });

  it('Friday / Saturday (5-day week) use the weekend multiplier', () => {
    expect(isWeekend(d('2026-09-25'))).toBe(true); // Friday
    expect(isWeekend(d('2026-09-26'))).toBe(true); // Saturday
    expect(isWeekend(d('2026-09-27'))).toBe(false); // Sunday
    expect(overtimeAmount({ date: d('2026-09-25'), type: 'HOURS', hours: 2, amount: null }, emp)).toBe(150);
    const sixDays = { ...DEFAULT_PAYROLL_SETTINGS, workDaysPerWeek: 6 };
    expect(overtimeAmount({ date: d('2026-09-26'), type: 'HOURS', hours: 2, amount: null }, emp, sixDays)).toBe(112.5);
  });

  it('lump sum requests pay the fixed amount; negative input is ignored', () => {
    expect(overtimeAmount({ date: d('2026-09-23'), type: 'LUMP_SUM', hours: 5, amount: 300 }, emp)).toBe(300);
    expect(overtimeAmount({ date: d('2026-09-23'), type: 'HOURS', hours: -3, amount: null }, emp)).toBe(0);
  });
});

describe('overtime hourly basis (company setting Company.overtimeHourlyBasis)', () => {
  // basic 6,000 + recurring allowances 2,000 (+ a one-off bonus that never counts), 8 h/day.
  // basic hourly = 6,000 / 240 = 25; total hourly = 8,000 / 240 = 33.333...
  const worker = { basicSalary: 6000, allowances: [housing, bonus] };
  const weekday = { date: d('2026-09-23'), type: 'HOURS', hours: 10, amount: null };
  const friday = { date: d('2026-09-25'), type: 'HOURS', hours: 10, amount: null };

  it('BASIC (default) reproduces the historical amount exactly, allowances ignored', () => {
    // The expression overtimeAmount used before the setting existed.
    const historical = (h: number, basic: number, m: number) => roundMoney(h * (basic / (30 * 8)) * m);
    for (const [ot, m] of [[weekday, 1.5], [friday, 2]] as const) {
      expect(overtimeAmount(ot, worker)).toBe(historical(10, 6000, m));
      expect(overtimeAmount(ot, worker, DEFAULT_PAYROLL_SETTINGS, 'BASIC')).toBe(overtimeAmount(ot, { basicSalary: 6000 }));
    }
    expect(overtimeAmount(weekday, worker)).toBe(375);
    expect(overtimeAmount(friday, worker)).toBe(500);
    // Odd rates: same float expression as before the setting existed.
    for (const basic of [3333.33, 7777, 12345.67]) {
      for (const hours of [0.5, 1.25, 7, 13.3]) {
        const ot = { date: d('2026-09-23'), type: 'HOURS', hours, amount: null };
        expect(overtimeAmount(ot, { basicSalary: basic, allowances: [housing] }, DEFAULT_PAYROLL_SETTINGS, 'BASIC')).toBe(historical(hours, basic, 1.5));
      }
    }
  });

  it('TOTAL_PLUS_HALF_BASIC: total hourly + (multiplier − 1) × basic hourly', () => {
    const w = { basicSalary: 6000, allowances: [{ amount: 2000, isMonthly: true }, bonus] };
    expect(totalHourlyRate(w)).toBeCloseTo(33.3333, 4);
    // weekday 1.5: 10 × (33.333 + 0.5 × 25) = 458.33
    expect(overtimeHourlyRate(w, 1.5, DEFAULT_PAYROLL_SETTINGS, 'TOTAL_PLUS_HALF_BASIC')).toBeCloseTo(45.8333, 4);
    expect(overtimeAmount(weekday, w, DEFAULT_PAYROLL_SETTINGS, 'TOTAL_PLUS_HALF_BASIC')).toBe(458.33);
    // weekend 2.0: 10 × (33.333 + 1.0 × 25) = 583.33
    expect(overtimeAmount(friday, w, DEFAULT_PAYROLL_SETTINGS, 'TOTAL_PLUS_HALF_BASIC')).toBe(583.33);
    // Custom multipliers / hours per day.
    const s = { ...DEFAULT_PAYROLL_SETTINGS, overtimeMultiplier: 1.75, workHoursPerDay: 10 };
    expect(overtimeAmount(weekday, w, s, 'TOTAL_PLUS_HALF_BASIC')).toBe(416.67); // 10 × (8,000/300 + 0.75 × 20)
    // No allowances: total = basic -> basic hourly × multiplier (same as BASIC).
    expect(overtimeAmount(weekday, { basicSalary: 6000 }, DEFAULT_PAYROLL_SETTINGS, 'TOTAL_PLUS_HALF_BASIC')).toBe(375);
    // Lump sums are unaffected by the basis.
    expect(overtimeAmount({ date: d('2026-09-23'), type: 'LUMP_SUM', hours: 5, amount: 300 }, w, DEFAULT_PAYROLL_SETTINGS, 'TOTAL_PLUS_HALF_BASIC')).toBe(300);
  });

  it('company resolution: legal company, else actual company, else BASIC; unknown values are BASIC', () => {
    expect(normalizeOvertimeBasis('total_plus_half_basic')).toBe('TOTAL_PLUS_HALF_BASIC');
    expect(normalizeOvertimeBasis('X')).toBe('BASIC');
    expect(normalizeOvertimeBasis(null)).toBe('BASIC');
    const T = { overtimeHourlyBasis: 'TOTAL_PLUS_HALF_BASIC' };
    const B = { overtimeHourlyBasis: 'BASIC' };
    expect(overtimeBasisForEmployee({ legalCompany: B, actualCompany: T })).toBe('BASIC');
    expect(overtimeBasisForEmployee({ legalCompany: null, actualCompany: T })).toBe('TOTAL_PLUS_HALF_BASIC');
    expect(overtimeBasisForEmployee({ legalCompany: null, actualCompany: null })).toBe('BASIC');
    expect(payrollCompanyId({ legalCompanyId: null, actualCompanyId: 'a' })).toBe('a');
    expect(payrollCompanyId({ legalCompanyId: 'l', actualCompanyId: 'a' })).toBe('l');
  });

  it('payroll line: BASIC / omitted basis give the historical overtime; TOTAL_PLUS_HALF_BASIC uses the recurring allowances', () => {
    const overtimes = [weekday, friday];
    const employee = { basicSalary: 6000, allowances: [{ name: 'بدل سكن', amount: 2000, isMonthly: true }] };
    const omitted = line({ overtimes, employee });
    expect(omitted.overtimeCost).toBe(875); // 375 + 500
    expect(line({ overtimes, employee, overtimeBasis: 'BASIC' }).overtimeCost).toBe(875);
    const lit = line({ overtimes, employee, overtimeBasis: 'TOTAL_PLUS_HALF_BASIC' });
    expect(lit.overtimeCost).toBe(1041.66); // 458.33 + 583.33
    expect(lit.netSalary - omitted.netSalary).toBeCloseTo(1041.66 - 875, 2);
  });
});

describe('settings and keys', () => {
  it('invalid or out-of-range settings fall back to the defaults', () => {
    const s = parsePayrollSettings([
      { key: 'overtime_rate_multiplier', value: '2' },
      { key: 'gosi_employee_percentage', value: 'abc' },
      { key: 'default_work_hours_per_day', value: '0' },
      { key: 'default_work_days_per_week', value: '6' },
    ]);
    expect(s.overtimeMultiplier).toBe(2);
    expect(s.gosiEmployeePercentage).toBe(9.75);
    expect(s.workHoursPerDay).toBe(8);
    expect(s.workDaysPerWeek).toBe(6);
    expect(s.gosiEmployeePercentageNonSaudi).toBe(0);
  });

  it('payroll month keys', () => {
    expect(payrollMonthKey(2026, 3)).toBe('2026-03');
    expect(parsePayrollMonthKey('2026-12')).toEqual({ year: 2026, month: 12 });
    expect(parsePayrollMonthKey('2026-13')).toBeNull();
    expect(parsePayrollMonthKey(null)).toBeNull();
  });

  it('isSaudiNational', () => {
    expect(isSaudiNational('سعودي')).toBe(true);
    expect(isSaudiNational('سعودية')).toBe(true);
    expect(isSaudiNational('Saudi')).toBe(true);
    expect(isSaudiNational('KSA')).toBe(true);
    expect(isSaudiNational('غير سعودي')).toBe(false);
    expect(isSaudiNational('Non-Saudi')).toBe(false);
    expect(isSaudiNational('مصري')).toBe(false);
    expect(isSaudiNational('')).toBe(false);
    expect(isSaudiNational(null)).toBe(false);
  });
});

describe('GOSI', () => {
  it('9.75% of basic + housing for Saudis, 0 for non-Saudis', () => {
    const base = { gosiDeduction: null, basicSalary: 10000, housing: 2500, factor: 1 };
    expect(gosiEmployeeAmount({ ...base, nationality: 'سعودي' })).toBe(1218.75);
    expect(gosiEmployeeAmount({ ...base, nationality: 'هندي' })).toBe(0);
  });

  it('caps the contributory wage at 45,000 and prorates partial months', () => {
    expect(gosiEmployeeAmount({ nationality: 'سعودي', gosiDeduction: null, basicSalary: 50000, housing: 0, factor: 1 })).toBe(4387.5);
    expect(gosiEmployeeAmount({ nationality: 'سعودي', gosiDeduction: null, basicSalary: 10000, housing: 2500, factor: 0.5 })).toBe(
      609.38,
    );
  });

  it('a fixed gosiDeduction on the employee overrides the percentage', () => {
    expect(gosiEmployeeAmount({ nationality: 'هندي', gosiDeduction: 300, basicSalary: 10000, housing: 0, factor: 1 })).toBe(300);
    expect(gosiEmployeeAmount({ nationality: 'هندي', gosiDeduction: 300, basicSalary: 10000, housing: 0, factor: 0.5 })).toBe(150);
  });
});

describe('employmentDaysInMonth', () => {
  it('prorates joiners and leavers by calendar days', () => {
    expect(employmentDaysInMonth({ year: 2026, month: 9, joinDate: d('2026-09-16') })).toEqual({
      eligibleDays: 15,
      daysInMonth: 30,
      factor: 0.5,
    });
    expect(employmentDaysInMonth({ year: 2026, month: 2, joinDate: d('2020-01-01'), employmentEnd: d('2026-02-10') }).eligibleDays).toBe(10);
    expect(employmentDaysInMonth({ year: 2026, month: 9, joinDate: d('2026-10-01') }).eligibleDays).toBe(0);
    expect(
      employmentDaysInMonth({
        year: 2026,
        month: 9,
        joinDate: d('2020-01-01'),
        excluded: [{ start: d('2026-09-01'), end: d('2026-09-10') }],
      }).eligibleDays,
    ).toBe(20);
  });
});

describe('computePayrollLine', () => {
  it('full month for a Saudi: basic + allowances - GOSI', () => {
    const r = line({ employee: { nationality: 'سعودي', allowances: [housing, transport] } });
    expect(r.basicSalary).toBe(10000);
    expect(r.totalAllowances).toBe(3000);
    expect(r.breakdown.gosi).toBe(1218.75);
    expect(r.totalDeductions).toBe(1218.75);
    expect(r.netSalary).toBe(11781.25);
    expect(r.factor).toBe(1);
  });

  it('non-Saudi pays no GOSI by default', () => {
    const r = line({ employee: { allowances: [housing, transport] } });
    expect(r.breakdown.gosi).toBe(0);
    expect(r.netSalary).toBe(13000);
  });

  it('prorates a mid-month joiner; one-off bonuses are paid in full', () => {
    const r = line({
      employee: { nationality: 'سعودي', joinDate: d('2026-09-16'), allowances: [housing, transport] },
      bonuses: [{ id: 'b1', amount: 500 }],
    });
    expect(r.eligibleDays).toBe(15);
    expect(r.basicSalary).toBe(5000);
    expect(r.breakdown.recurringAllowances).toBe(1500);
    expect(r.breakdown.bonuses).toBe(500);
    expect(r.totalAllowances).toBe(2000);
    expect(r.breakdown.gosi).toBe(609.38);
    expect(r.netSalary).toBe(6390.62);
  });

  it('prorates the month of termination', () => {
    const r = line({ year: 2026, month: 2, employmentEnd: d('2026-02-10') });
    expect(r.eligibleDays).toBe(10);
    expect(r.daysInMonth).toBe(28);
    expect(r.basicSalary).toBe(3571.43);
  });

  it('caps a loan installment by the remaining amount and by the available salary', () => {
    const r = line({
      employee: { basicSalary: 5000 },
      loans: [
        { id: 'L1', monthlyInstallment: 1000, remaining: 400 },
        { id: 'L2', monthlyInstallment: 1000, remaining: 5000 },
      ],
    });
    expect(r.loanInstallments).toEqual([
      { loanId: 'L1', amount: 400 },
      { loanId: 'L2', amount: 1000 },
    ]);
    expect(r.breakdown.loanInstallments).toBe(1400);
    expect(r.netSalary).toBe(3600);

    const poor = line({
      employee: { basicSalary: 1000 },
      deductions: [{ id: 'D1', amount: 200 }],
      loans: [{ id: 'L1', monthlyInstallment: 1500, remaining: 5000 }],
    });
    expect(poor.loanInstallments).toEqual([{ loanId: 'L1', amount: 800 }]);
    expect(poor.netSalary).toBe(0);

    const settled = line({ loans: [{ id: 'L1', monthlyInstallment: 1000, remaining: 0 }] });
    expect(settled.loanInstallments).toEqual([]);
  });

  it('adds overtime and subtracts approved deductions', () => {
    const r = line({
      employee: { basicSalary: 9000 },
      overtimes: [
        { date: d('2026-09-23'), type: 'HOURS', hours: 2, amount: null },
        { date: d('2026-09-25'), type: 'HOURS', hours: 2, amount: null },
      ],
      deductions: [
        { id: 'D1', amount: 100.1 },
        { id: 'D2', amount: 200.2 },
      ],
    });
    expect(r.overtimeCost).toBe(262.5);
    expect(r.breakdown.penalties).toBe(300.3);
    expect(r.netSalary).toBe(8962.2);
  });

  it('never returns a negative net salary', () => {
    const r = line({ employee: { basicSalary: 1000 }, deductions: [{ id: 'D1', amount: 5000 }] });
    expect(r.netSalary).toBe(0);
  });
});

describe('leave deductions in payroll', () => {
  const annualLeave = (over: Partial<LeaveLike>): LeaveLike => ({
    id: 'LV1',
    leaveType: 'ANNUAL',
    startDate: d('2026-09-26'),
    endDate: d('2026-10-05'),
    totalDays: 10,
    unpaidDays: 3,
    totalDeduction: 900,
    ...over,
  });

  it('deducts the recorded leave deduction once, in the month of the unpaid days', () => {
    const lv = annualLeave({});
    const sep = leaveDeductionForMonth(lv, [lv], 375, 2026, 9);
    const oct = leaveDeductionForMonth(lv, [lv], 375, 2026, 10);
    expect(sep.amount).toBe(0);
    expect(oct.unpaidDays).toBe(3);
    expect(oct.amount).toBe(900); // recorded amount, not 3 x rate on top of it
    expect(sep.amount + oct.amount).toBe(900);

    const septemberLine = line({ employee: { basicSalary: 9000 }, leaves: [lv] });
    expect(septemberLine.breakdown.leaveDeductions).toBe(0);
    const octoberLine = line({ month: 10, employee: { basicSalary: 9000 }, leaves: [lv] });
    expect(octoberLine.breakdown.leaveDeductions).toBe(900);
    expect(octoberLine.netSalary).toBe(8100);
  });

  it('splits the recorded deduction across months by unpaid days, adding up exactly', () => {
    const lv = annualLeave({ startDate: d('2026-09-24'), endDate: d('2026-10-03'), unpaidDays: 5, totalDeduction: 1000 });
    expect(leaveDeductionForMonth(lv, [lv], 375, 2026, 9).amount).toBe(400);
    expect(leaveDeductionForMonth(lv, [lv], 375, 2026, 10).amount).toBe(600);

    const odd = annualLeave({ startDate: d('2026-09-29'), endDate: d('2026-10-01'), totalDays: 3, unpaidDays: 3, totalDeduction: 100 });
    const a = leaveDeductionForMonth(odd, [odd], 375, 2026, 9).amount;
    const b = leaveDeductionForMonth(odd, [odd], 375, 2026, 10).amount;
    expect(a).toBe(66.67);
    expect(b).toBe(33.33);
    expect(Math.round((a + b) * 100) / 100).toBe(100);
  });

  it('a waived deduction (recorded 0) deducts nothing', () => {
    const lv = annualLeave({ totalDeduction: 0 });
    expect(leaveDeductionForMonth(lv, [lv], 375, 2026, 10).amount).toBe(0);
  });

  it('legacy leaves without a recorded deduction use unpaid days x daily rate', () => {
    const lv = annualLeave({ totalDeduction: null });
    expect(leaveDeductionForMonth(lv, [lv], 375, 2026, 10).amount).toBe(1125);
    const unpaid: LeaveLike = {
      id: 'U1',
      leaveType: 'UNPAID',
      startDate: d('2026-09-10'),
      endDate: d('2026-09-12'),
      totalDays: 3,
      unpaidDays: null,
      totalDeduction: null,
    };
    expect(leaveDeductionForMonth(unpaid, [unpaid], 300, 2026, 9).amount).toBe(900);
  });

  it('sick leave: the 75% tier is used to place the recorded deduction; legacy leaves compute it', () => {
    const prior: LeaveLike = {
      id: 'S0',
      leaveType: 'SICK',
      startDate: d('2026-06-01'),
      endDate: d('2026-06-25'),
      totalDays: 25,
      totalDeduction: 0,
    };
    const sick: LeaveLike = {
      id: 'S1',
      leaveType: 'SICK',
      startDate: d('2026-09-10'),
      endDate: d('2026-09-19'),
      totalDays: 10,
      totalDeduction: null,
    };
    const legacy = leaveDeductionForMonth(sick, [prior, sick], 375, 2026, 9);
    expect(legacy.sickReducedDays).toBe(5);
    expect(legacy.amount).toBe(468.75);
    const recorded = { ...sick, totalDeduction: 125 };
    expect(leaveDeductionForMonth(recorded, [prior, recorded], 375, 2026, 9).amount).toBe(125);
    // Days 1-30 of sick leave are fully paid.
    expect(leaveDeductionForMonth(prior, [prior, sick], 375, 2026, 6).amount).toBe(0);
  });
});

describe('settlementCoverage', () => {
  it('excludes the days a leave settlement already paid', () => {
    const cov = settlementCoverage(
      [
        {
          type: 'LEAVE_SETTLEMENT',
          status: 'PAID',
          lastWorkingDate: d('2026-09-10'),
          createdAt: d('2026-09-05'),
          salaryBasis: 'basic',
          leaveCompensation: 3000,
        },
      ],
      { basicSalary: 9000, allowances: [] },
    );
    expect(cov.finalDay).toBeNull();
    expect(cov.excluded.map((r) => [r.start.toISOString().slice(0, 10), r.end.toISOString().slice(0, 10)])).toEqual([
      ['2026-09-01', '2026-09-10'],
      ['2026-09-11', '2026-09-20'],
    ]);
    const r = line({ employee: { basicSalary: 9000 }, excluded: cov.excluded });
    expect(r.eligibleDays).toBe(10);
    expect(r.basicSalary).toBe(3000);
  });

  it('an end-of-service settlement ends payroll; rejected settlements are ignored', () => {
    const cov = settlementCoverage(
      [
        { type: 'END_OF_SERVICE', status: 'REJECTED', lastWorkingDate: d('2026-08-01'), createdAt: d('2026-08-01'), salaryBasis: null, leaveCompensation: null },
        { type: 'END_OF_SERVICE', status: 'OWNER_APPROVED', lastWorkingDate: d('2026-09-15'), createdAt: d('2026-09-01'), salaryBasis: null, leaveCompensation: null },
      ],
      { basicSalary: 9000 },
    );
    expect(cov.finalDay?.toISOString()).toBe('2026-09-15T00:00:00.000Z');
  });
});
