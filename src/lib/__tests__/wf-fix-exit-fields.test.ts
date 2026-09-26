import { describe, expect, it } from 'vitest';
import { EXIT_REASONS, WORKFORCE_PAYROLL_HIDDEN_FIELDS, defaultExitVoluntary } from '@/app/api/employees/_workforce-fields';
import { EXIT_VOLUNTARY_DEFAULT, exitFieldsForTermination } from '@/lib/finance';
import { TERMINATION_REASONS } from '@/lib/settlement';
import { TERMINATION_TO_EXIT_REASON } from '@/lib/workforce/reasons';
import { PAYROLL_HIDDEN_FIELDS, redactForPayroll } from '@/lib/employee';
import { SAUDI_NATIONALITY, isSaudiNationalityValue, normalizeNationality } from '@/lib/employee-shared';
import { NATIONALITY_RECLASSIFIED, isSaudiNational } from '@/lib/nationality';

describe('EXIT_VOLUNTARY_DEFAULT (finance.ts local copy) agrees with defaultExitVoluntary', () => {
  it.each(EXIT_REASONS.map((r) => [r]))('%s', (reason) => {
    expect(EXIT_VOLUNTARY_DEFAULT[reason]).toBe(defaultExitVoluntary(reason));
  });
  it('covers exactly the employee exit reasons', () => {
    expect(Object.keys(EXIT_VOLUNTARY_DEFAULT).sort()).toEqual([...EXIT_REASONS].sort());
  });
});

describe('exitFieldsForTermination (settlement approval -> employee file)', () => {
  it('maps every settlement reason through TERMINATION_TO_EXIT_REASON with the default voluntary flag', () => {
    for (const t of TERMINATION_REASONS) {
      const exitReason = TERMINATION_TO_EXIT_REASON[t];
      expect(exitFieldsForTermination(t)).toEqual({ exitReason, exitVoluntary: defaultExitVoluntary(exitReason) });
    }
  });
  it('resignation is voluntary, company termination / article 80 are not, probation / contract end are unknown', () => {
    expect(exitFieldsForTermination('RESIGNATION')).toEqual({ exitReason: 'RESIGNATION', exitVoluntary: true });
    expect(exitFieldsForTermination('COMPANY_TERMINATION')).toEqual({ exitReason: 'EMPLOYER_TERMINATION', exitVoluntary: false });
    expect(exitFieldsForTermination('ARTICLE_80')).toEqual({ exitReason: 'ARTICLE_80', exitVoluntary: false });
    expect(exitFieldsForTermination('PROBATION')).toEqual({ exitReason: 'PROBATION', exitVoluntary: null });
    expect(exitFieldsForTermination('CONTRACT_EXPIRY')).toEqual({ exitReason: 'CONTRACT_END', exitVoluntary: null });
    expect(exitFieldsForTermination('ARTICLE_81')).toEqual({ exitReason: 'OTHER', exitVoluntary: null });
  });
  it('no / unknown settlement reason -> nothing recorded', () => {
    expect(exitFieldsForTermination(null)).toBeNull();
    expect(exitFieldsForTermination(undefined)).toBeNull();
    expect(exitFieldsForTermination('')).toBeNull();
    expect(exitFieldsForTermination('SOMETHING_ELSE')).toBeNull();
    expect(exitFieldsForTermination('toString')).toBeNull();
  });
  it('the absconding path (leave ABSCOND) records a voluntary exit', () => {
    expect(defaultExitVoluntary('ABSCONDING')).toBe(true);
  });
});

describe('payroll redaction includes the disability data', () => {
  it('PAYROLL_HIDDEN_FIELDS contains every WORKFORCE_PAYROLL_HIDDEN_FIELDS entry', () => {
    for (const f of WORKFORCE_PAYROLL_HIDDEN_FIELDS) expect(PAYROLL_HIDDEN_FIELDS as ReadonlyArray<string>).toContain(f);
  });
  it('redactForPayroll drops isDisabled / muawamaCertExpiry and keeps the cost inputs', () => {
    const row = { id: 'e1', basicSalary: 5000, isDisabled: true, muawamaCertExpiry: '2027-01-01', medicalInsuranceClass: 'A', dependentsCount: 1 };
    expect(redactForPayroll(row)).toEqual({ id: 'e1', basicSalary: 5000, medicalInsuranceClass: 'A', dependentsCount: 1 });
  });
});

describe('isSaudiNationalityValue delegates to isSaudiNational', () => {
  const samples = [
    'SAUDI', 'saudi', 'Saudi Arabia', 'saudi arabian', 'sa', 'KSA', 'سعودي', 'سعودى', 'سعودية', 'السعودية',
    'سعودي الجنسية', 'مواطن سعودي', 'Saudi national', 'غير سعودي', 'Non-Saudi', 'Not Saudi', 'مصري', 'Emirati', 'كويتي',
    '', '   ', null, undefined, 5,
  ];
  it.each(samples.map((v) => [v]))('%s', (v) => {
    expect(isSaudiNationalityValue(v)).toBe(isSaudiNational(v));
  });
  it('every legacy alias normalizeNationality maps to Saudi is still Saudi (no regression)', () => {
    for (const v of ['saudi', 'saudi arabia', 'saudi arabian', 'sa', 'ksa', 'سعودي', 'سعودى', 'سعودية', 'السعودية']) {
      expect(normalizeNationality(v)).toBe(SAUDI_NATIONALITY);
      expect(isSaudiNationalityValue(v)).toBe(true);
    }
  });
  it('the reclassified values follow the canonical rule', () => {
    for (const r of NATIONALITY_RECLASSIFIED) expect(isSaudiNationalityValue(r.value)).toBe(r.now);
  });
});
