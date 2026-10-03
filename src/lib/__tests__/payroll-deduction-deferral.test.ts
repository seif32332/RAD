// BL-PAY-030 (RT-WFE-744): a payroll line takes deductions WHOLE, oldest first (date, then id), only while
// they fit in what the month leaves after unpaid leave and GOSI; what does not fit is deferred (never
// recorded as collected) and flagged. Before the fix every offered deduction was counted in full and the
// net clamped at 0, so the excess was linked as collected without being taken.
import { describe, expect, it } from 'vitest';
import {
  computePayrollLine,
  DEFAULT_PAYROLL_SETTINGS,
  employeeDeductionsTotal,
  payrollBreakdownColumns,
  reviewNoteCodes,
  takeDeductions,
  type PayrollLineInput,
} from '@/lib/payroll';
import { DEFAULT_GOSI_RATES } from '@/lib/gosi';
import { roundMoney, sumMoney } from '@/lib/money';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

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

const gross = (r: ReturnType<typeof line>) => roundMoney(r.basicSalary + r.totalAllowances + r.overtimeCost);
/** What the line could give to deductions: gross less unpaid leave and GOSI. */
const room = (r: ReturnType<typeof line>) => Math.max(0, roundMoney(gross(r) - r.breakdown.leaveDeductions - r.breakdown.gosi));

describe('BL-PAY-030: deductions above the available pay are deferred, never recorded as collected', () => {
  // Wage 5,000, GOSI 487.5 (OLD Saudi 9.75%): 4,512.5 free for deductions.
  const offered = [
    { id: 'A', amount: 3000, date: d('2026-09-05') },
    { id: 'B', amount: 2000, date: d('2026-09-03') },
    { id: 'C', amount: 1000, date: d('2026-09-10') },
  ];

  it('takes whole deductions oldest first while they fit; the rest is deferred; taken <= available', () => {
    const r = line({ deductions: offered });
    expect(room(r)).toBe(4512.5);
    // B (oldest) 2,000 fits -> 2,512.5 left; A 3,000 does not -> deferred; C 1,000 fits.
    expect(r.deductionsTaken).toEqual(['B', 'C']);
    expect(r.deductionsDeferred).toEqual([{ id: 'A', amount: 3000 }]);
    expect(r.breakdown.penalties).toBe(3000);
    expect(r.breakdown.penalties).toBeLessThanOrEqual(room(r));
    expect(r.netSalary).toBe(1512.5); // 5,000 - 487.5 - 3,000: nothing clamped
    expect(r.totalDeductions).toBeLessThanOrEqual(gross(r));
    expect(employeeDeductionsTotal(payrollBreakdownColumns(r))).toBe(r.totalDeductions);
    expect(r.needsReview).toBe(true);
    expect(reviewNoteCodes(r.reviewNote)).toContain('DEDUCTION_DEFERRED');
    expect(reviewNoteCodes(r.reviewNote)).not.toContain('DEDUCTION_OVER_MONTH');
  });

  it('the order is deterministic: date, then id, whatever the input order', () => {
    const permutations = [offered, [...offered].reverse(), [offered[2], offered[0], offered[1]]];
    const results = permutations.map((p) => line({ deductions: p }));
    for (const r of results) {
      expect(r.deductionsTaken).toEqual(['B', 'C']);
      expect(r.deductionsDeferred).toEqual([{ id: 'A', amount: 3000 }]);
    }
    // Same date: the id decides.
    const sameDay = [
      { id: 'z', amount: 3000, date: d('2026-09-01') },
      { id: 'a', amount: 3000, date: d('2026-09-01') },
    ];
    expect(takeDeductions(sameDay, 4000)).toEqual({ ids: ['a'], total: 3000, deferred: [{ id: 'z', amount: 3000 }] });
    expect(takeDeductions([...sameDay].reverse(), 4000)).toEqual({ ids: ['a'], total: 3000, deferred: [{ id: 'z', amount: 3000 }] });
  });

  it('a short final month: the deduction that does not fit is deferred whole, the employee keeps the pay', () => {
    // Employed 3 days of September: 500 earned, GOSI 48.75, 451.25 free; a 1,000 deduction is deferred.
    const r = line({ employmentEnd: d('2026-09-03'), deductions: [{ id: 'X', amount: 1000, date: d('2026-09-02') }] });
    expect(gross(r)).toBe(500);
    expect(r.deductionsTaken).toEqual([]);
    expect(r.deductionsDeferred).toEqual([{ id: 'X', amount: 1000 }]);
    expect(r.breakdown.penalties).toBe(0);
    expect(r.netSalary).toBe(451.25);
    // 1,000 fits a whole month (4,512.5): not an "over a month" deduction.
    expect(reviewNoteCodes(r.reviewNote)).toEqual(expect.arrayContaining(['DEDUCTION_DEFERRED']));
    expect(reviewNoteCodes(r.reviewNote)).not.toContain('DEDUCTION_OVER_MONTH');
  });

  it('a single deduction larger than a whole month never fits: deferred, flagged DEDUCTION_OVER_MONTH, smaller ones still taken', () => {
    const r = line({
      deductions: [
        { id: 'BIG', amount: 20000, date: d('2026-08-01') },
        { id: 'small', amount: 100, date: d('2026-09-01') },
      ],
    });
    expect(r.deductionsTaken).toEqual(['small']);
    expect(r.deductionsDeferred).toEqual([{ id: 'BIG', amount: 20000 }]);
    expect(r.breakdown.penalties).toBe(100);
    expect(reviewNoteCodes(r.reviewNote)).toEqual(expect.arrayContaining(['DEDUCTION_DEFERRED', 'DEDUCTION_OVER_MONTH']));
  });

  it('a deduction that fits exactly is taken (net 0, DEDUCTIONS_EXCEED), nothing deferred', () => {
    const r = line({ deductions: [{ id: 'x', amount: 4512.5 }] });
    expect(r.deductionsTaken).toEqual(['x']);
    expect(r.deductionsDeferred).toEqual([]);
    expect(r.netSalary).toBe(0);
    expect(reviewNoteCodes(r.reviewNote)).toContain('DEDUCTIONS_EXCEED');
    expect(reviewNoteCodes(r.reviewNote)).not.toContain('DEDUCTION_DEFERRED');
  });

  it('loans take only what the deductions leave', () => {
    const r = line({
      deductions: [{ id: 'p', amount: 4000 }],
      loans: [{ id: 'L', monthlyInstallment: 1000, remaining: 5000 }],
    });
    expect(r.breakdown.penalties).toBe(4000);
    expect(r.loanInstallments).toEqual([{ loanId: 'L', amount: 512.5 }]);
    expect(r.netSalary).toBe(0);
  });

  it('property: the line never records more deductions than the month pays (leave + GOSI within the pay)', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 300; i++) {
      const count = 1 + Math.floor(rnd() * 6);
      const deductions = Array.from({ length: count }, (_, k) => ({ id: `d${k}`, amount: roundMoney(rnd() * 4000), date: d(`2026-0${1 + Math.floor(rnd() * 9)}-1${k}`) }));
      const end = rnd() < 0.3 ? d(`2026-09-${String(1 + Math.floor(rnd() * 28)).padStart(2, '0')}`) : null;
      const r = line({ deductions, employmentEnd: end, employee: { basicSalary: 1500 + Math.floor(rnd() * 9000) } });
      expect(r.breakdown.penalties).toBeLessThanOrEqual(room(r) + 0.001);
      expect(r.totalDeductions).toBeLessThanOrEqual(gross(r) + 0.001);
      const taken = deductions.filter((x) => r.deductionsTaken.includes(x.id));
      expect(r.breakdown.penalties).toBe(sumMoney(taken.map((x) => x.amount)));
      expect(r.deductionsTaken.length + r.deductionsDeferred.length).toBe(count);
    }
  });
});
