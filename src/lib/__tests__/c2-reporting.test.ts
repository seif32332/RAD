// WP-6 (council DOM-003 phase 1 / DOM-009): payroll review codes (flags only, numbers
// unchanged) and the reporting helpers behind the dashboard, owner report and payroll hub.
import { describe, expect, it } from 'vitest';
import {
  computePayrollLine,
  countPayrollReviewKeys,
  currentPayrollMonth,
  DEDUCTIONS_EXCEED_NOTE,
  DEFAULT_PAYROLL_SETTINGS,
  defaultPayrollMonth,
  employeeDeductionsTotal,
  estimateMonthWage,
  isMonthNotAfter,
  monthsInRange,
  payrollBreakdownColumns,
  payrollMonthLabel,
  payrollReviewFlags,
  payrollReviewKeys,
  reportMonthKind,
  reviewNoteCodes,
  reviewNoteText,
  type PayrollLineInput,
} from '@/lib/payroll';
import { DEFAULT_GOSI_RATES } from '@/lib/gosi';
import { ibanCheckDigits } from '@/lib/iban';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const VALID_IBAN = `SA${ibanCheckDigits('SA', '80000000608010167519')}80000000608010167519`;

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
    gosiRates: DEFAULT_GOSI_RATES,
    ...over,
    employee: {
      basicSalary: 5000,
      nationality: 'سعودي',
      gosiDeduction: null,
      joinDate: d('2020-01-01'),
      gosiRegime: 'OLD',
      allowances: [],
      ...(over.employee ?? {}),
    },
  });
}

/** Same line without the payment check: every amount must be identical. */
const amounts = (r: ReturnType<typeof line>) => ({
  basicSalary: r.basicSalary,
  totalAllowances: r.totalAllowances,
  overtimeCost: r.overtimeCost,
  totalDeductions: r.totalDeductions,
  netSalary: r.netSalary,
  breakdown: r.breakdown,
  loanInstallments: r.loanInstallments,
});

describe('council scenario: wage 5,000, penalties 2,700, installment 3,000', () => {
  const scenario: Over = {
    deductions: [{ id: 'p1', amount: 2700 }],
    loans: [{ id: 'l1', monthlyInstallment: 3000, remaining: 9000 }],
  };

  it('numbers are the current behaviour (net clamped to 0, the loan takes only what is left)', () => {
    const r = line(scenario);
    expect(r.breakdown.gosi).toBe(487.5); // 5,000 x 9.75% (OLD Saudi)
    expect(r.breakdown.penalties).toBe(2700);
    expect(r.breakdown.loanInstallments).toBe(1812.5); // 5,000 - 2,700 - 487.5
    expect(r.loanInstallments).toEqual([{ loanId: 'l1', amount: 1812.5 }]);
    expect(r.totalDeductions).toBe(5000);
    expect(r.netSalary).toBe(0);
    expect(employeeDeductionsTotal(payrollBreakdownColumns(r))).toBe(r.totalDeductions);
  });

  it('is flagged with CAP_PENALTY, CAP_LOAN, CAP_HALF, NET_ZERO and DEDUCTIONS_EXCEED (equality)', () => {
    const r = line(scenario);
    expect(r.needsReview).toBe(true);
    const codes = reviewNoteCodes(r.reviewNote);
    for (const c of ['CAP_PENALTY', 'CAP_LOAN', 'CAP_HALF', 'NET_ZERO', 'DEDUCTIONS_EXCEED'] as const) expect(codes).toContain(c);
    expect(r.reviewNote).toContain('[CAP_PENALTY]');
    expect(r.reviewNote).toContain('[NET_ZERO]');
    expect(r.reviewNote).toContain(DEDUCTIONS_EXCEED_NOTE);
  });

  it('the payment check never changes a number', () => {
    const plain = line(scenario);
    const withPayment = line({ ...scenario, payment: { method: 'BANK_TRANSFER', iban: null } });
    expect(amounts(withPayment)).toEqual(amounts(plain));
    expect(reviewNoteCodes(withPayment.reviewNote)).toContain('IBAN_MISSING');
  });
});

describe('payment readiness codes', () => {
  it('no IBAN on a bank transfer -> IBAN_MISSING', () => {
    const r = line({ payment: { method: 'BANK_TRANSFER', iban: '' } });
    expect(r.needsReview).toBe(true);
    expect(reviewNoteCodes(r.reviewNote)).toEqual(['IBAN_MISSING']);
    expect(r.netSalary).toBe(line().netSalary);
  });

  it('bad checksum -> IBAN_INVALID; valid IBAN -> no flag', () => {
    expect(reviewNoteCodes(line({ payment: { method: 'WPS', iban: 'SA0000000000000000000000' } }).reviewNote)).toEqual(['IBAN_INVALID']);
    const ok = line({ payment: { method: 'WPS', iban: VALID_IBAN } });
    expect(ok.needsReview).toBe(false);
    expect(ok.reviewNote).toBeNull();
  });

  it('cash payment -> CASH (the IBAN is not required)', () => {
    expect(reviewNoteCodes(line({ payment: { method: 'CASH', iban: null } }).reviewNote)).toEqual(['CASH']);
  });

  it('basic salary 0 -> BASIC_ZERO', () => {
    const r = line({ employee: { basicSalary: 0, allowances: [{ name: 'بدل', amount: 1000, isMonthly: true }] } });
    expect(reviewNoteCodes(r.reviewNote)).toContain('BASIC_ZERO');
  });
});

describe('cap thresholds (flags only)', () => {
  const base = {
    basicFull: 3000,
    dailyRate: 100,
    earnedWage: 3000,
    gross: 3000,
    leaveDeductions: 0,
    penalties: 0,
    gosi: 0,
    other: 0,
    loanTotal: 0,
    totalDeductions: 0,
    netSalary: 3000,
  };
  const codes = (over: Partial<typeof base>) => payrollReviewFlags({ ...base, ...over }).map((f) => f.code);

  it('penalties: exactly 5 days is allowed, above is flagged', () => {
    expect(codes({ penalties: 500, totalDeductions: 500, netSalary: 2500 })).toEqual([]);
    expect(codes({ penalties: 500.01, totalDeductions: 500.01, netSalary: 2499.99 })).toEqual(['CAP_PENALTY']);
  });

  it('loan: exactly 10% is allowed, above is flagged', () => {
    expect(codes({ loanTotal: 300, totalDeductions: 300, netSalary: 2700 })).toEqual([]);
    expect(codes({ loanTotal: 301, totalDeductions: 301, netSalary: 2699 })).toEqual(['CAP_LOAN']);
  });

  it('half cap uses the pay due after absence; absence itself is not a deduction', () => {
    // 1,000 absence: due after absence 2,000, half = 1,000. Deductions 1,000 -> not above.
    expect(codes({ leaveDeductions: 1000, gosi: 300, penalties: 500, loanTotal: 200, totalDeductions: 2000, netSalary: 1000 })).toEqual([]);
    expect(codes({ leaveDeductions: 1000, gosi: 300, penalties: 500, loanTotal: 201, totalDeductions: 2001, netSalary: 999 })).toEqual(['CAP_HALF']);
    // Unpaid leave for the whole month is not a cap breach (only NET_ZERO).
    expect(codes({ leaveDeductions: 3000, totalDeductions: 3000, netSalary: 0 })).toEqual(['NET_ZERO']);
  });
});

describe('DEDUCTIONS_EXCEED includes equality', () => {
  it('deductions exactly equal to the month pay are flagged', () => {
    // 5,000 wage, GOSI 487.5, penalties 4,512.5 -> deductions == gross, net 0.
    const r = line({ deductions: [{ id: 'x', amount: 4512.5 }] });
    expect(r.totalDeductions).toBe(5000);
    expect(r.netSalary).toBe(0);
    expect(reviewNoteCodes(r.reviewNote)).toContain('DEDUCTIONS_EXCEED');
  });

  it('a normal line is not flagged', () => {
    const r = line({ deductions: [{ id: 'x', amount: 100 }] });
    expect(r.needsReview).toBe(false);
    expect(r.reviewNote).toBeNull();
  });
});

describe('stored review notes: codes, counts and display text', () => {
  it('codes from new notes, the old uncoded note and GOSI notes', () => {
    expect(reviewNoteCodes('[CAP_LOAN] نص | [NET_ZERO] صافي الراتب صفر')).toEqual(['CAP_LOAN', 'NET_ZERO']);
    expect(reviewNoteCodes('الخصومات تتجاوز مستحقات الشهر')).toEqual(['DEDUCTIONS_EXCEED']);
    expect(reviewNoteCodes('نظام التأمينات غير مؤكد')).toEqual(['GOSI']);
    expect(reviewNoteCodes('[NOT_A_CODE] x')).toEqual([]);
    expect(reviewNoteCodes(null)).toEqual([]);
  });

  it('a flagged row with no known code counts as OTHER; unflagged rows are not counted', () => {
    expect(payrollReviewKeys({ needsReview: true, reviewNote: 'سبب يدوي' })).toEqual(['OTHER']);
    const counts = countPayrollReviewKeys([
      { needsReview: true, reviewNote: '[CAP_PENALTY] a | [NET_ZERO] b' },
      { needsReview: true, reviewNote: '[NET_ZERO] b' },
      { needsReview: false, reviewNote: 'مبلغ يدوي' },
      { needsReview: true, reviewNote: null },
    ]);
    expect(counts).toEqual({ CAP_PENALTY: 1, NET_ZERO: 2, OTHER: 1 });
  });

  it('display text drops the code markers', () => {
    expect(reviewNoteText('[NET_ZERO] صافي الراتب صفر | مبلغ يدوي')).toBe('صافي الراتب صفر | مبلغ يدوي');
  });
});

describe('reference month and month helpers', () => {
  it('current month follows Riyadh, not UTC', () => {
    // 2026-09-30 22:00 UTC is already 1 October in Riyadh.
    expect(currentPayrollMonth(new Date('2026-09-30T22:00:00Z'))).toEqual({ year: 2026, month: 10 });
  });

  it('a month in the future (e.g. 2098) is never the reference / default month', () => {
    const cur = { year: 2026, month: 9 };
    expect(isMonthNotAfter({ year: 2098, month: 3 }, cur)).toBe(false);
    expect(isMonthNotAfter({ year: 2026, month: 9 }, cur)).toBe(true);
    expect(defaultPayrollMonth([{ year: 2098, month: 3 }, { year: 2026, month: 7 }, { year: 2025, month: 12 }], cur)).toEqual({ year: 2026, month: 7 });
    expect(defaultPayrollMonth([{ year: 2026, month: 9 }, { year: 2026, month: 10 }], cur)).toEqual({ year: 2026, month: 9 });
    expect(defaultPayrollMonth([{ year: 2027, month: 1 }], cur)).toBeNull();
  });

  it('Arabic month label', () => {
    expect(payrollMonthLabel(2026, 3)).toBe('مارس 2026');
    expect(payrollMonthLabel(2026, 9)).toBe('سبتمبر 2026');
  });

  it('months of a period', () => {
    expect(monthsInRange('2026-01-15', '2026-03-01')).toEqual([
      { year: 2026, month: 1 },
      { year: 2026, month: 2 },
      { year: 2026, month: 3 },
    ]);
    expect(monthsInRange('2026-12-01', '2027-01-31')).toEqual([{ year: 2026, month: 12 }, { year: 2027, month: 1 }]);
    expect(monthsInRange('2026-03-01', '2026-01-01')).toEqual([]);
  });

  it('actual / missing / estimate', () => {
    const cur = { year: 2026, month: 9 };
    expect(reportMonthKind({ year: 2026, month: 8 }, cur, true)).toBe('ACTUAL');
    expect(reportMonthKind({ year: 2026, month: 8 }, cur, false)).toBe('MISSING');
    expect(reportMonthKind({ year: 2026, month: 9 }, cur, true)).toBe('ACTUAL');
    expect(reportMonthKind({ year: 2026, month: 9 }, cur, false)).toBe('ESTIMATE');
    // Approved lines stored for a future month are not "actual".
    expect(reportMonthKind({ year: 2098, month: 3 }, cur, true)).toBe('ESTIMATE');
  });

  it('estimate excludes employees who have not started and prorates the joining month', () => {
    const emps = [
      { basicSalary: 3000, joinDate: '2020-01-01', allowances: [{ amount: 1000, isMonthly: true }, { amount: 500, isMonthly: false }] },
      { basicSalary: 6000, joinDate: '2026-11-16' }, // joins mid-November (30 days -> 15/30)
      { basicSalary: 9000, joinDate: '2027-02-01' }, // not started by December
    ];
    expect(estimateMonthWage(emps, 2026, 10)).toEqual({ amount: 4000, employees: 1 });
    expect(estimateMonthWage(emps, 2026, 11)).toEqual({ amount: 7000, employees: 2 });
    expect(estimateMonthWage(emps, 2026, 12)).toEqual({ amount: 10000, employees: 2 });
  });
});
