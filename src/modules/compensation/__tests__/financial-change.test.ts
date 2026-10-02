// P1-PAY-B pure parts (no database): the one allowance classification of compensation equals payroll's,
// the request payload helpers, the IBAN fingerprint / mask, the safe view of a request, and the payroll
// line computed by compensation segment (one segment = the legacy single-salary result, two = prorated).
import { describe, expect, it } from 'vitest';
import { allowanceLine, computePayrollLine, DEFAULT_PAYROLL_SETTINGS } from '@/lib/payroll-core';
import { createHash } from 'node:crypto';
import { allowanceLineOf, sameCompensation, toPeriodAllowances } from '../allowances';
import { ibanFingerprint, ibanLast4, maskedIban } from '../bank';
import { financialChangeView, FINANCIAL_CHANGE_SELECT, type ChangeRow } from '../model';

describe('compensation allowances (P1-PAY-B)', () => {
  it('allowanceLineOf is payroll\'s allowanceLine (type first, then the name)', () => {
    const cases: Array<[string | null, string]> = [
      ['HOUSING', 'x'], ['housing', 'بدل نقل'], ['TRANSPORT', 'سكن'], ['FOOD', 'بدل سكن'], ['OTHER', 'transport'],
      [null, 'بدل سكن'], [null, 'Housing allowance'], [null, 'بدل مواصلات'], [null, 'بدل نقل'], [null, 'Transport'], [null, 'بدل جوال'], ['', 'سكن'],
    ];
    for (const [type, name] of cases) expect(allowanceLineOf(type, name)).toBe(allowanceLine({ allowanceType: type, name }));
  });

  it('toPeriodAllowances rounds to the halala, drops empty rows and stores the line; sameCompensation ignores order and ids', () => {
    const items = toPeriodAllowances([
      { name: ' بدل سكن ', amount: 1500.004, countsTowardGosi: true, allowanceType: null },
      { name: 'بدل نقل', amount: 0, countsTowardGosi: false, allowanceType: 'TRANSPORT' },
      { name: '', amount: 10, countsTowardGosi: false, allowanceType: null },
      { name: 'بدل طعام', amount: 300, countsTowardGosi: false, allowanceType: 'FOOD' },
    ]);
    expect(items).toEqual([
      { name: 'بدل سكن', line: 'HOUSING', allowanceType: null, amount: 1500, countsTowardGosi: true },
      { name: 'بدل طعام', line: 'OTHER', allowanceType: 'FOOD', amount: 300, countsTowardGosi: false },
    ]);
    const withIds = items.map((a, i) => ({ ...a, allowanceId: `id-${i}` })).reverse();
    expect(sameCompensation({ basicSalary: 5000, allowances: items }, { basicSalary: 5000.001, allowances: withIds })).toBe(true);
    expect(sameCompensation({ basicSalary: 5000, allowances: items }, { basicSalary: 5000, allowances: items.slice(1) })).toBe(false);
    expect(sameCompensation({ basicSalary: 5000, allowances: items }, { basicSalary: 5100, allowances: items })).toBe(false);
  });
});

describe('IBAN fingerprint and mask (BR-PAY-006)', () => {
  const iban = 'SA0380000000608010167519';
  it('the fingerprint is sha256 of the normalized IBAN (spaces, dashes, case, Arabic digits, bidi marks)', () => {
    const expected = createHash('sha256').update(iban).digest('hex');
    expect(ibanFingerprint(iban)).toBe(expected);
    expect(ibanFingerprint(' sa03 8000-0000 ٦٠٨٠١٠١٦٧٥١٩')).toBe(expected);
    expect(ibanFingerprint('‏' + iban.toLowerCase())).toBe(expected);
    expect(ibanFingerprint('')).toBeNull();
    expect(ibanLast4(iban)).toBe('7519');
    expect(maskedIban('7519')).toBe(`SA${'*'.repeat(18)}7519`);
    expect(maskedIban('7519')).toHaveLength(24);
  });

  it('the view of a request never carries the IBAN (only the masked last 4)', () => {
    expect(Object.keys(FINANCIAL_CHANGE_SELECT)).not.toContain('ibanEncrypted');
    expect(Object.keys(FINANCIAL_CHANGE_SELECT)).not.toContain('ibanFingerprint');
    const row = {
      id: 'c1', employeeId: 'e1', companyId: 'co', field: 'BANK_IDENTITY', source: 'PORTAL', status: 'PENDING', effectiveDate: new Date('2026-10-02T00:00:00Z'),
      compensation: null, ibanLast4: '7519', bankName: 'بنك', paymentMethod: 'BANK_TRANSFER', beforeJson: null, note: null, batchKey: null,
      requestedById: 'u1', requestedAt: new Date('2026-10-02T08:00:00Z'), decidedById: null, decidedAt: null, decisionNote: null, decisionSelfAct: false,
      cancelledById: null, cancelledAt: null, cancelReason: null, appliedAt: null, compensationPeriodId: null, bankIdentityPeriodId: null, legacyFiledByUserIds: [],
    } as unknown as ChangeRow;
    const v = financialChangeView(row);
    expect(v.bank).toEqual({ paymentMethod: 'BANK_TRANSFER', bankName: 'بنك', ibanMasked: `SA${'*'.repeat(18)}7519` });
    expect(JSON.stringify(v)).not.toMatch(/SA\d{22}/);
  });
});

describe('payroll line by compensation segment (ARCH-011, P1-PAY-B)', () => {
  const base = {
    year: 2030,
    month: 4,
    employee: { basicSalary: 3000, nationality: 'IN', gosiDeduction: 0, joinDate: new Date('2020-01-01'), allowances: [{ name: 'بدل سكن', amount: 750, isMonthly: true }] },
    bonuses: [],
    overtimes: [],
    deductions: [],
    leaves: [],
    loans: [],
    settings: DEFAULT_PAYROLL_SETTINGS,
  };

  it('one segment covering the month is exactly the single-salary computation (joiner mid-month too)', () => {
    for (const joinDate of [new Date('2020-01-01'), new Date('2030-04-11')]) {
      const legacy = computePayrollLine({ ...base, employee: { ...base.employee, joinDate } });
      const seg = computePayrollLine({ ...base, employee: { ...base.employee, joinDate }, compensationSegments: [{ from: '2030-04-01', to: '2030-04-30', basicSalary: 3000, allowances: base.employee.allowances }] });
      expect(seg).toEqual(legacy);
    }
  });

  it('two segments are prorated over their own days; days without a segment are not paid', () => {
    const line = computePayrollLine({
      ...base,
      employee: { ...base.employee, basicSalary: 6000 },
      compensationSegments: [
        { from: '2030-04-01', to: '2030-04-15', basicSalary: 3000, allowances: [{ name: 'بدل سكن', amount: 750, isMonthly: true }] },
        { from: '2030-04-16', to: '2030-04-30', basicSalary: 6000, allowances: [{ name: 'بدل سكن', amount: 1500, isMonthly: true }] },
      ],
    });
    expect([line.basicSalary, line.breakdown.recurringAllowances, line.breakdown.housingAllowances, line.eligibleDays]).toEqual([4500, 1125, 1125, 30]);
    const gap = computePayrollLine({ ...base, compensationSegments: [{ from: '2030-04-11', to: '2030-04-30', basicSalary: 3000, allowances: [] }] });
    expect([gap.basicSalary, gap.eligibleDays]).toEqual([2000, 20]);
  });
});
