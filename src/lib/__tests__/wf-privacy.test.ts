// Disability / identity privacy of the workforce engine (review fix 2, finding 1): HRDF categories as codes,
// neutral wording for viewers outside the HR group, stripped snapshot inputs, read-time redaction.
import { describe, expect, it } from 'vitest';
import { PAYROLL_HIDDEN_FIELDS } from '@/lib/employee';
import {
  HRDF_NEUTRAL_CATEGORIES_TEXT,
  SENSITIVE_EMPLOYEE_FIELDS,
  canSeeDisability,
  computeTrueCost,
  hrdfNote,
  redactCostLine,
  redactMonths,
  redactSnapshotJson,
  stripSensitiveEmployeeFields,
  type CostLine,
  type TrueCostResult,
  type WfCompanyInput,
} from '@/lib/workforce';
import { COMPANY, SEED_GOSI, SEED_RULES, assume, d, emp } from './wf-fixtures';

const companies: WfCompanyInput[] = [COMPANY, { id: 'c-sme', name: 'صغيرة', isIndustrialLicensed: false }];
const staff = [
  emp({ id: 'dis', isDisabled: true, joinDate: d('2026-06-01'), basicSalary: 4000, branchCity: 'Abha', legalCompanyId: 'c-sme', gosiRegime: 'NEW' }),
  emp({ id: 'fem', gender: 'FEMALE', joinDate: d('2026-06-01'), basicSalary: 6000, branchCity: 'الرياض', gosiRegime: 'NEW' }),
  emp({ id: 'base', joinDate: d('2026-06-01'), basicSalary: 6000, branchCity: 'الرياض', gosiRegime: 'NEW' }),
];
const run: TrueCostResult = computeTrueCost({ employees: staff, companies, rules: SEED_RULES, gosiRates: SEED_GOSI, assumptions: [assume('COMPANY_IS_SME', 1, null, 'c-sme')] }, { startMonth: '2026-09', months: 2 });
const hrdf = (id: string) => run.employees.find((e) => e.employeeId === id)!.months[0].lines.find((l) => l.key === 'HRDF_SUBSIDY')!;
const SENSITIVE_WORDS = /إعاقة|isDisabled|muawama|DISABLED|dateOfBirth/;

describe('engine: HRDF categories as structured codes', () => {
  it('the HRDF line carries the codes and the HR wording', () => {
    expect(hrdf('dis').categories).toEqual(['DISABLED', 'SME', 'OUTSIDE_MAJOR_CITIES']);
    expect(hrdf('dis').note).toBe('مشروط بقبول هدف؛ الفئات: ذو إعاقة، منشأة صغيرة أو متوسطة، خارج الرياض وجدة والدمام والخبر');
    expect(hrdf('fem').categories).toEqual(['FEMALE']);
    expect(hrdf('base').categories).toBeUndefined();
    expect(hrdf('base').note).toBe('مشروط بقبول هدف');
    expect(hrdfNote('REDACTED')).toBe(`مشروط بقبول هدف؛ الفئات: ${HRDF_NEUTRAL_CATEGORIES_TEXT}`);
  });
});

describe('who may see disability (same as isDisabled in the employees API)', () => {
  it.each([
    ['SUPER_ADMIN', true],
    ['COMPANY_ADMIN', true],
    ['HR_MANAGER', true],
    ['FINANCE_MANAGER', false],
    ['PAYROLL_ADMIN', false],
    ['BRANCH_MANAGER', false],
    [null, false],
  ])('%s -> %s', (role, ok) => {
    expect(canSeeDisability(role)).toBe(ok);
  });

  it('SENSITIVE_EMPLOYEE_FIELDS = PAYROLL_HIDDEN_FIELDS of the employees API', () => {
    expect([...SENSITIVE_EMPLOYEE_FIELDS].sort()).toEqual([...PAYROLL_HIDDEN_FIELDS].sort());
  });
});

describe('redaction for viewers outside the HR group', () => {
  it('every HRDF line with categories gets the neutral text (not only the disabled one); the amount stays', () => {
    for (const id of ['dis', 'fem']) {
      const l = redactCostLine(hrdf(id));
      expect(l.note).toBe(`مشروط بقبول هدف؛ الفئات: ${HRDF_NEUTRAL_CATEGORIES_TEXT}`);
      expect(l.categories).toBeUndefined();
      expect(l.amount).toBe(hrdf(id).amount);
      expect(l.basis).toBe(hrdf(id).basis);
    }
    expect(redactCostLine(hrdf('base'))).toBe(hrdf('base')); // no list: unchanged
    const basic = run.employees[0].months[0].lines.find((l) => l.key === 'BASIC')!;
    expect(redactCostLine(basic)).toBe(basic);
  });

  it('redactMonths leaves no disability wording or code, and does not mutate the engine result', () => {
    const e = run.employees.find((x) => x.employeeId === 'dis')!;
    const out = redactMonths(e.months);
    expect(JSON.stringify(out)).not.toMatch(SENSITIVE_WORDS);
    expect(JSON.stringify(e.months)).toContain('ذو إعاقة');
    expect(out.map((m) => m.totals)).toEqual(e.months.map((m) => m.totals));
  });

  it('stored inputs drop identity and disability fields', () => {
    const s = stripSensitiveEmployeeFields({ ...staff[0], muawamaCertExpiry: d('2027-01-01'), iqamaOrIdNumber: '1' });
    for (const f of SENSITIVE_EMPLOYEE_FIELDS) expect(f in s).toBe(false);
    expect(s.basicSalary).toBe(4000);
  });

  it('read-time redaction of an OLD snapshot (full inputs, note without codes)', () => {
    const oldLine: CostLine = { key: 'HRDF_SUBSIDY', label: 'دعم هدف', amount: -2000, basis: '60% × 4,000', status: 'USER_INPUT', ruleKeys: [], kind: 'SUBSIDY', note: 'مشروط بقبول هدف؛ الفئات: ذو إعاقة، منشأة صغيرة أو متوسطة' };
    const snapshot = {
      inputs: { employees: [{ id: 'dis', isDisabled: true, dateOfBirth: '1990-01-01', basicSalary: 4000 }], employee: { id: 'dis', isDisabled: true, muawamaCertExpiry: '2027-01-01', leaves: [] } },
      outputs: { months: [{ month: '2026-09', lines: [oldLine, { ...hrdf('dis') }] }], text: 'ملاحظة: ذو إعاقة' },
    };
    const out = redactSnapshotJson(snapshot) as typeof snapshot;
    const json = JSON.stringify(out);
    expect(json).not.toMatch(SENSITIVE_WORDS);
    expect(out.outputs.months[0].lines[0]).toMatchObject({ amount: -2000, note: `مشروط بقبول هدف؛ الفئات: ${HRDF_NEUTRAL_CATEGORIES_TEXT}` });
    expect(out.outputs.months[0].lines[1].amount).toBe(hrdf('dis').amount);
    expect(out.inputs.employees[0].basicSalary).toBe(4000);
    expect(JSON.stringify(snapshot)).toContain('isDisabled'); // input not mutated
  });
});
