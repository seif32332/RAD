import { describe, expect, it } from 'vitest';
import { computeLeaveBalance } from '@/lib/leave';
import { computeTrueCost, fmt, leaveDaysAccrued, type AssumptionRow, type CostLineKey, type TrueCostOptions, type TrueCostResult, type WfCompanyInput, type WfEmployeeInput } from '@/lib/workforce';
import { COMPANY, INDUSTRIAL, SEED_GOSI, SEED_RULES, assume, d, emp, housing, transport } from './wf-fixtures';

function run(employees: WfEmployeeInput[], opts: Partial<TrueCostOptions> & { startMonth: string }, assumptions: AssumptionRow[] = [], companies: WfCompanyInput[] = [COMPANY, INDUSTRIAL]): TrueCostResult {
  return computeTrueCost({ employees, companies, rules: SEED_RULES, gosiRates: SEED_GOSI, assumptions }, { months: 1, ...opts });
}

function line(res: TrueCostResult, empId: string, month: string, key: CostLineKey) {
  const e = res.employees.find((x) => x.employeeId === empId);
  const m = e?.months.find((x) => x.month === month);
  return m?.lines.find((l) => l.key === key);
}

const amount = (res: TrueCostResult, empId: string, month: string, key: CostLineKey) => line(res, empId, month, key)?.amount;

describe('GOSI employer share (calculateGosi with the dated table)', () => {
  const newSaudi = emp({ id: 'new', gosiRegime: 'NEW', basicSalary: 8000, allowances: [housing(2000), transport(500)] });
  const oldSaudi = emp({ id: 'old', gosiRegime: 'OLD', basicSalary: 8000, allowances: [housing(2000), transport(500)] });
  const res = run([newSaudi, oldSaudi], { startMonth: '2026-06', months: 14 });

  it('NEW regime steps on 2026-07-01 and 2027-07-01 (wage = basic + housing, transport excluded)', () => {
    expect(amount(res, 'new', '2026-06', 'GOSI_EMPLOYER')).toBe(1225); // 12.25% × 10,000
    expect(amount(res, 'new', '2026-07', 'GOSI_EMPLOYER')).toBe(1275); // 12.75%
    expect(amount(res, 'new', '2027-06', 'GOSI_EMPLOYER')).toBe(1275);
    expect(amount(res, 'new', '2027-07', 'GOSI_EMPLOYER')).toBe(1325); // 13.25%
    expect(line(res, 'new', '2026-07', 'GOSI_EMPLOYER')?.basis).toBe('12.75% × 10,000');
    expect(line(res, 'new', '2026-07', 'GOSI_EMPLOYER')?.status).toBe('VERIFIED_PRIMARY');
  });

  it('legacy regime stays at 11.75%', () => {
    for (const m of ['2026-06', '2026-07', '2027-07']) expect(amount(res, 'old', m, 'GOSI_EMPLOYER')).toBe(1175);
  });

  it('45,000 cap', () => {
    const r = run([emp({ id: 'rich', basicSalary: 50000, allowances: [housing(5000)] })], { startMonth: '2026-09' });
    expect(amount(r, 'rich', '2026-09', 'GOSI_EMPLOYER')).toBe(5287.5); // 11.75% × 45,000
    expect(line(r, 'rich', '2026-09', 'GOSI_EMPLOYER')?.note).toContain('فوق الحد الأعلى');
    expect(r.employees[0].months[0].contributoryWage).toBe(45000);
  });

  it('UNKNOWN regime Saudi: OLD rates + review flag; expat: 2% hazards', () => {
    const r = run([emp({ id: 'unk', gosiRegime: 'UNKNOWN', basicSalary: 10000 }), emp({ id: 'x', nationality: 'مصري', basicSalary: 5000, allowances: [housing(1250)] })], { startMonth: '2026-09' });
    expect(amount(r, 'unk', '2026-09', 'GOSI_EMPLOYER')).toBe(1175);
    expect(line(r, 'unk', '2026-09', 'GOSI_EMPLOYER')?.status).toBe('PROVISIONAL');
    expect(r.employees.find((e) => e.employeeId === 'unk')?.flags.map((f) => f.code)).toContain('MISSING_GOSI_REGIME');
    expect(amount(r, 'x', '2026-09', 'GOSI_EMPLOYER')).toBe(125);
  });

  it('housing: allowanceType wins, then the payroll flag, then the name (flagged)', () => {
    const r = run(
      [
        emp({
          id: 'h',
          basicSalary: 10000,
          allowances: [
            { name: 'بدل السكن', amount: 2000, isMonthly: true, countsTowardGosi: false, allowanceType: null },
            { name: 'بدل خاص', amount: 700, isMonthly: true, countsTowardGosi: true, allowanceType: 'TRANSPORT' },
          ],
        }),
      ],
      { startMonth: '2026-09' },
    );
    expect(amount(r, 'h', '2026-09', 'GOSI_EMPLOYER')).toBe(1410); // 11.75% × 12,000
    expect(r.employees[0].flags.map((f) => f.code)).toContain('HOUSING_INFERRED_FROM_NAME');
  });

  it('prorates a mid-month joiner by calendar days', () => {
    const r = run([emp({ id: 'j', joinDate: d('2026-06-16'), gosiRegime: 'NEW', basicSalary: 8000, allowances: [housing(2000)] })], { startMonth: '2026-06' });
    expect(amount(r, 'j', '2026-06', 'BASIC')).toBe(4000); // 8,000 × 15/30
    expect(amount(r, 'j', '2026-06', 'GOSI_EMPLOYER')).toBe(612.5);
  });
});

describe('expat levy (700 / 800 per legal company)', () => {
  const saudis = [emp({ id: 's1' }), emp({ id: 's2' })];
  const expats = [1, 2, 3, 4, 5].map((i) => emp({ id: `x${i}`, nationality: 'هندي', joinDate: d(`2021-0${i}-01`), basicSalary: 3000 }));

  it('first N expats (N = Saudi count) at 700, the rest at 800; OWNER_FULL_TIME not entered -> no exemption, flagged', () => {
    const r = run([...saudis, ...expats], { startMonth: '2026-01' });
    expect(['x1', 'x2', 'x3', 'x4', 'x5'].map((id) => amount(r, id, '2026-01', 'EXPAT_LEVY'))).toEqual([700, 700, 800, 800, 800]);
    expect(r.companies.find((c) => c.companyId === 'c1')?.months[0]).toMatchObject({ saudi: 2, expat: 5, within: 2, above: 3, exempt: 0, levyTotal: 3800 });
    expect(r.flags.some((f) => f.code === 'MISSING_ASSUMPTION' && f.lineKey === 'EXPAT_LEVY')).toBe(true);
    expect(line(r, 'x3', '2026-01', 'EXPAT_LEVY')?.basis).toContain('يتجاوز عدد السعوديين (2)');
  });

  it('small establishment (<= 9): 4 exempt when the owner is full time and a full-time Saudi exists', () => {
    const r = run([...saudis, ...expats], { startMonth: '2026-01' }, [assume('OWNER_FULL_TIME', 1, null, 'c1')]);
    expect(['x1', 'x2', 'x3', 'x4', 'x5'].map((id) => amount(r, id, '2026-01', 'EXPAT_LEVY'))).toEqual([0, 0, 0, 0, 700]);
    expect(line(r, 'x1', '2026-01', 'EXPAT_LEVY')?.status).toBe('USER_INPUT');
    expect(r.employees.find((e) => e.employeeId === 'x1')?.flags.map((f) => f.code)).toContain('SMALL_EST_EXEMPTION_ASSUMED');
  });

  it('small establishment without a Saudi: 2 exempt, the rest above the Saudi count (800)', () => {
    const r = run(expats.slice(0, 3), { startMonth: '2026-01' }, [assume('OWNER_FULL_TIME', 1)]);
    expect(['x1', 'x2', 'x3'].map((id) => amount(r, id, '2026-01', 'EXPAT_LEVY'))).toEqual([0, 0, 800]);
  });

  it('no exemption above 9 workers', () => {
    const many = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => emp({ id: `y${i}`, nationality: 'هندي', joinDate: d(`2021-0${i}-01`) }));
    const r = run([...saudis, ...many], { startMonth: '2026-01' }, [assume('OWNER_FULL_TIME', 1)]);
    expect(r.companies[0].months[0]).toMatchObject({ headcount: 10, exempt: 0, within: 2, above: 6, levyTotal: 6200 });
  });

  it('licensed industrial establishment: levy 0 from the cancellation (2025-12-17 applies to December 2025)', () => {
    const staff = [emp({ id: 'is', legalCompanyId: 'c-ind' }), emp({ id: 'ix1', nationality: 'هندي', legalCompanyId: 'c-ind', joinDate: d('2021-01-01') }), emp({ id: 'ix2', nationality: 'هندي', legalCompanyId: 'c-ind', joinDate: d('2021-02-01') })];
    const r = run([...staff, ...saudis, ...expats.slice(0, 1)], { startMonth: '2025-11', months: 3 });
    expect(amount(r, 'ix1', '2025-11', 'EXPAT_LEVY')).toBe(700);
    expect(amount(r, 'ix2', '2025-11', 'EXPAT_LEVY')).toBe(800);
    expect(amount(r, 'ix1', '2025-12', 'EXPAT_LEVY')).toBe(0);
    expect(amount(r, 'ix2', '2026-01', 'EXPAT_LEVY')).toBe(0);
    expect(line(r, 'ix2', '2026-01', 'EXPAT_LEVY')?.basis).toContain('صناعية');
    // A non-industrial company is unaffected.
    expect(amount(r, 'x1', '2026-01', 'EXPAT_LEVY')).toBe(700);
  });

  it('GCC nationals are neither Saudi nor expat for the levy; missing legal company -> 800 flagged', () => {
    const r = run([emp({ id: 'sa' }), emp({ id: 'kw', nationality: 'كويتي' }), emp({ id: 'z1', nationality: 'هندي', joinDate: d('2021-01-01') }), emp({ id: 'z2', nationality: 'هندي', joinDate: d('2021-02-01') }), emp({ id: 'nc', nationality: 'هندي', legalCompanyId: null })], { startMonth: '2026-01' });
    expect(amount(r, 'z1', '2026-01', 'EXPAT_LEVY')).toBe(700);
    expect(amount(r, 'z2', '2026-01', 'EXPAT_LEVY')).toBe(800);
    expect(line(r, 'kw', '2026-01', 'EXPAT_LEVY')).toBeUndefined();
    expect(amount(r, 'kw', '2026-01', 'GOSI_EMPLOYER')).toBe(160); // 2% × 8,000
    expect(r.employees.find((e) => e.employeeId === 'kw')?.flags.map((f) => f.code)).toContain('GCC_PENSION_NOT_MODELLED');
    expect(amount(r, 'nc', '2026-01', 'EXPAT_LEVY')).toBe(800);
    expect(r.employees.find((e) => e.employeeId === 'nc')?.flags.map((f) => f.code)).toContain('MISSING_LEGAL_COMPANY');
  });
});

describe('other expat fees and medical', () => {
  const x = (over: Partial<WfEmployeeInput>) => emp({ nationality: 'فلبيني', ...over });

  it('work permit 100/12 and iqama 650/12 (provisional)', () => {
    const r = run([x({ id: 'f' })], { startMonth: '2026-09' });
    expect(amount(r, 'f', '2026-09', 'WORK_PERMIT')).toBe(8.33);
    expect(amount(r, 'f', '2026-09', 'IQAMA')).toBe(54.17);
    expect(line(r, 'f', '2026-09', 'IQAMA')?.status).toBe('PROVISIONAL');
    expect(r.flags.some((f) => f.code === 'PROVISIONAL_RULE' && f.ruleKey === 'IQAMA_FEE_YEAR')).toBe(true);
  });

  it('dependents fee 400 × count only when the company pays (employee field overrides the default)', () => {
    const staff = [x({ id: 'pc', dependentsCount: 2, dependentsFeePaidBy: 'COMPANY' }), x({ id: 'pe', dependentsCount: 2, dependentsFeePaidBy: 'EMPLOYEE' }), x({ id: 'pd', dependentsCount: 2 })];
    const r = run(staff, { startMonth: '2026-09' });
    expect(amount(r, 'pc', '2026-09', 'DEPENDENTS_FEE')).toBe(800);
    expect(line(r, 'pc', '2026-09', 'DEPENDENTS_FEE')?.status).toBe('VERIFIED_PRIMARY');
    expect(line(r, 'pe', '2026-09', 'DEPENDENTS_FEE')).toBeUndefined();
    expect(line(r, 'pd', '2026-09', 'DEPENDENTS_FEE')).toBeUndefined(); // default EMPLOYEE

    const r2 = run(staff, { startMonth: '2026-09' }, [assume('DEPENDENTS_FEE_PAID_BY_DEFAULT', null, '"COMPANY"')]);
    expect(amount(r2, 'pd', '2026-09', 'DEPENDENTS_FEE')).toBe(800);
    expect(line(r2, 'pd', '2026-09', 'DEPENDENTS_FEE')?.status).toBe('USER_INPUT');
    expect(line(r2, 'pe', '2026-09', 'DEPENDENTS_FEE')).toBeUndefined();
  });

  it('exit/re-entry visas and annual ticket from assumptions; missing ticket is a MISSING line', () => {
    const r = run([x({ id: 't' })], { startMonth: '2026-09' });
    expect(line(r, 't', '2026-09', 'EXIT_REENTRY')).toBeUndefined();
    expect(line(r, 't', '2026-09', 'ANNUAL_TICKET')).toMatchObject({ amount: 0, status: 'MISSING' });
    const r2 = run([x({ id: 't' })], { startMonth: '2026-09' }, [assume('EXIT_REENTRY_VISAS_PER_YEAR', 2), assume('ANNUAL_TICKET_COST', 2400)]);
    expect(line(r2, 't', '2026-09', 'EXIT_REENTRY')).toMatchObject({ amount: 33.33, status: 'USER_INPUT' });
    expect(amount(r2, 't', '2026-09', 'ANNUAL_TICKET')).toBe(200);
  });

  it('medical premium per class and per dependent come from the company settings; missing class premium -> MISSING + flag with companyId', () => {
    const staff = [emp({ id: 'ma', medicalInsuranceClass: 'a' }), emp({ id: 'mb', medicalInsuranceClass: 'B' }), emp({ id: 'mn' }), emp({ id: 'md', medicalInsuranceClass: 'A', dependentsCount: 2 })];
    const r = run(staff, { startMonth: '2026-09' });
    expect(line(r, 'mn', '2026-09', 'MEDICAL')).toMatchObject({ amount: 0, status: 'MISSING' });
    expect(r.employees.find((e) => e.employeeId === 'mn')?.flags.map((f) => f.code)).toContain('MISSING_MEDICAL_CLASS');

    const withSettings = { ...COMPANY, costSettings: { overtimeHourlyBasis: 'BASIC' as const, medicalPremiums: { A: 6000, DEPENDENT: 1200 }, iqamaFeeYear: null } };
    const r2 = run(staff, { startMonth: '2026-09' }, [], [withSettings, INDUSTRIAL]);
    expect(line(r2, 'ma', '2026-09', 'MEDICAL')).toMatchObject({ amount: 500, status: 'USER_INPUT', ruleKeys: ['COMPANY:MEDICAL_PREMIUMS'] });
    expect(line(r2, 'ma', '2026-09', 'MEDICAL')?.note).toBe('إعدادات الشركة: شركة الاختبار');
    expect(line(r2, 'mb', '2026-09', 'MEDICAL')).toMatchObject({ amount: 0, status: 'MISSING' });
    const mbFlag = r2.employees.find((e) => e.employeeId === 'mb')?.flags.find((f) => f.code === 'MISSING_MEDICAL_PREMIUM');
    expect(mbFlag).toMatchObject({ companyId: 'c1', lineKey: 'MEDICAL' });
    expect(amount(r2, 'md', '2026-09', 'MEDICAL_DEPENDENTS')).toBe(200); // 2 × 1,200 / 12
    expect(r2.companySettingsUsed).toEqual([{ companyId: 'c1', name: 'شركة الاختبار', overtimeHourlyBasis: 'BASIC', medicalPremiums: { A: 6000, DEPENDENT: 1200 }, iqamaFeeYear: null }]);
    expect(r2.employees.find((e) => e.employeeId === 'ma')?.settingsCompanyId).toBe('c1');
  });

  it('old WorkforceAssumption rows of the moved keys are ignored (company settings are the single source)', () => {
    const staff = [emp({ id: 'ma', medicalInsuranceClass: 'A', dependentsCount: 1 })];
    const legacy = [assume('MEDICAL_PREMIUM_BY_CLASS', null, '{"A": 6000}'), assume('MEDICAL_PREMIUM_DEFAULT', 5000), assume('DEPENDENT_MEDICAL_PREMIUM', 1200), assume('OVERTIME_HOURLY_BASIS', null, '"TOTAL_PLUS_HALF_BASIC"')];
    const r = run(staff, { startMonth: '2026-09' }, legacy);
    expect(line(r, 'ma', '2026-09', 'MEDICAL')).toMatchObject({ amount: 0, status: 'MISSING' });
    expect(line(r, 'ma', '2026-09', 'MEDICAL_DEPENDENTS')).toMatchObject({ amount: 0, status: 'MISSING' });
    expect(r.assumptionsUsed.map((a) => a.key)).not.toContain('MEDICAL_PREMIUM_BY_CLASS');
  });

  it('settings company = legal company, else actual company', () => {
    const actual = { id: 'c-act', name: 'الفعلية', isIndustrialLicensed: false, costSettings: { overtimeHourlyBasis: 'BASIC' as const, medicalPremiums: { B: 2400 }, iqamaFeeYear: 1200 } };
    const noLegal = emp({ id: 'nl', nationality: 'هندي', legalCompanyId: null, actualCompanyId: 'c-act', medicalInsuranceClass: 'B' });
    const r = run([noLegal], { startMonth: '2026-09' }, [], [COMPANY, actual]);
    expect(amount(r, 'nl', '2026-09', 'MEDICAL')).toBe(200);
    expect(line(r, 'nl', '2026-09', 'IQAMA')).toMatchObject({ amount: 100, status: 'USER_INPUT', ruleKeys: ['COMPANY:IQAMA_FEE_YEAR'] });
    expect(r.employees[0].settingsCompanyId).toBe('c-act');
    expect(r.employees[0].legalCompanyId).toBeNull(); // the levy still uses the legal company only
  });

  it('iqama fee: company setting (USER_INPUT) or the rule register (PROVISIONAL)', () => {
    const fee = { ...COMPANY, costSettings: { overtimeHourlyBasis: 'BASIC' as const, medicalPremiums: {}, iqamaFeeYear: 600 } };
    const r = run([x({ id: 'f1' })], { startMonth: '2026-09' }, [], [fee]);
    expect(line(r, 'f1', '2026-09', 'IQAMA')).toMatchObject({ amount: 50, basis: '600 ÷ 12', status: 'USER_INPUT', ruleKeys: ['COMPANY:IQAMA_FEE_YEAR'], note: 'إعدادات الشركة: شركة الاختبار' });
    expect(r.flags.some((f) => f.ruleKey === 'IQAMA_FEE_YEAR')).toBe(false);
    const r2 = run([x({ id: 'f2' })], { startMonth: '2026-09' });
    expect(line(r2, 'f2', '2026-09', 'IQAMA')).toMatchObject({ amount: 54.17, status: 'PROVISIONAL', ruleKeys: ['IQAMA_FEE_YEAR'] });
  });

  it('planned overtime uses the company basis with the payroll formula', () => {
    const basic = emp({ id: 'ob', basicSalary: 6000, allowances: [transport(2000)], overtimeHoursPerMonth: 10 });
    const r = run([basic], { startMonth: '2026-09' });
    expect(line(r, 'ob', '2026-09', 'OVERTIME')).toMatchObject({ amount: 375, status: 'USER_INPUT' }); // 10 × 25 × 1.5
    expect(line(r, 'ob', '2026-09', 'OVERTIME')?.ruleKeys).toContain('COMPANY:OVERTIME_HOURLY_BASIS');
    const lit = { ...COMPANY, costSettings: { overtimeHourlyBasis: 'TOTAL_PLUS_HALF_BASIC' as const, medicalPremiums: {}, iqamaFeeYear: null } };
    const r2 = run([basic], { startMonth: '2026-09' }, [], [lit]);
    expect(amount(r2, 'ob', '2026-09', 'OVERTIME')).toBe(458.33); // 10 × (8,000/240 + 0.5 × 25)
  });

  it('Saudis pay no expat fees', () => {
    const r = run([emp({ id: 's' })], { startMonth: '2026-09' });
    for (const k of ['EXPAT_LEVY', 'WORK_PERMIT', 'IQAMA', 'DEPENDENTS_FEE', 'ANNUAL_TICKET'] as CostLineKey[]) expect(line(r, 's', '2026-09', k)).toBeUndefined();
  });
});

describe('HRDF employment support (conditional negative line)', () => {
  const companies: WfCompanyInput[] = [COMPANY, { id: 'c-sme', name: 'صغيرة', isIndustrialLicensed: false }, { id: 'c-no', name: 'بدون دعم', isIndustrialLicensed: false }];
  const staff = [
    emp({ id: 'f', gender: 'FEMALE', joinDate: d('2026-08-15'), basicSalary: 7000, allowances: [housing(2000)], branchCity: 'جدة', gosiRegime: 'NEW' }),
    emp({ id: 'dis', isDisabled: true, joinDate: d('2026-06-01'), basicSalary: 4000, branchCity: 'Abha', legalCompanyId: 'c-sme', gosiRegime: 'NEW' }),
    emp({ id: 'base', joinDate: d('2026-05-01'), basicSalary: 5000, branchCity: 'Riyadh', gosiRegime: 'NEW' }),
    emp({ id: 'high', joinDate: d('2026-05-01'), basicSalary: 16000, gosiRegime: 'NEW' }),
    emp({ id: 'exp', nationality: 'مصري', joinDate: d('2026-05-01'), basicSalary: 5000 }),
    emp({ id: 'pt', joinDate: d('2026-05-01'), basicSalary: 5000, contractType: 'PART_TIME', gosiRegime: 'NEW' }),
    emp({ id: 'no', joinDate: d('2026-05-01'), basicSalary: 5000, legalCompanyId: 'c-no', gosiRegime: 'NEW' }),
  ];
  const r = run(staff, { startMonth: '2026-08', months: 30 }, [assume('COMPANY_IS_SME', 1, null, 'c-sme'), assume('INCLUDE_HRDF', 0, null, 'c-no')], companies);

  it('30% + 10% for a woman, capped at 3,000 SAR, months 4..27 after joining', () => {
    expect(line(r, 'f', '2026-10', 'HRDF_SUBSIDY')).toBeUndefined(); // month 3
    expect(line(r, 'f', '2026-11', 'HRDF_SUBSIDY')).toMatchObject({ amount: -3000, kind: 'SUBSIDY' }); // 40% × 9,000 = 3,600 -> 3,000
    expect(line(r, 'f', '2026-11', 'HRDF_SUBSIDY')?.basis).toContain('بالسقف 3,000');
    expect(amount(r, 'f', '2028-10', 'HRDF_SUBSIDY')).toBe(-3000); // month 27
    expect(line(r, 'f', '2028-11', 'HRDF_SUBSIDY')).toBeUndefined(); // month 28
    expect(r.employees.find((e) => e.employeeId === 'f')?.months.filter((m) => m.lines.some((l) => l.key === 'HRDF_SUBSIDY')).length).toBe(24);
  });

  it('disabled + SME + outside the four cities = 60%, capped at 50% of the wage', () => {
    const l = line(r, 'dis', '2026-09', 'HRDF_SUBSIDY');
    expect(l?.amount).toBe(-2000); // 60% × 4,000 = 2,400 -> 50% × 4,000
    expect(l?.basis).toContain('50%');
    expect(l?.status).toBe('USER_INPUT'); // SME comes from an assumption
    expect(line(r, 'dis', '2026-08', 'HRDF_SUBSIDY')).toBeUndefined(); // month 3
  });

  it('base 30% in Riyadh; ineligible cases produce no line', () => {
    expect(amount(r, 'base', '2026-08', 'HRDF_SUBSIDY')).toBe(-1500);
    for (const id of ['high', 'exp', 'pt', 'no']) expect(r.employees.find((e) => e.employeeId === id)?.months.some((m) => m.lines.some((l) => l.key === 'HRDF_SUBSIDY'))).toBe(false);
  });

  it('totals before and after the subsidy', () => {
    const m = r.employees.find((e) => e.employeeId === 'base')!.months[0];
    const cost = m.lines.filter((l) => l.kind === 'COST').reduce((s, l) => s + l.amount, 0);
    expect(m.totals.cost).toBeCloseTo(cost, 2);
    expect(m.totals.subsidy).toBe(-1500);
    expect(m.totals.net).toBeCloseTo(cost - 1500, 2);
    expect(r.flags.some((f) => f.code === 'HRDF_CONDITIONAL')).toBe(true);
  });

  it('no support before the HRDF rules are in force (2026-08-01)', () => {
    const early = run([emp({ id: 'e', joinDate: d('2026-03-01'), basicSalary: 5000 })], { startMonth: '2026-06', months: 3 });
    expect(line(early, 'e', '2026-06', 'HRDF_SUBSIDY')).toBeUndefined();
    expect(line(early, 'e', '2026-07', 'HRDF_SUBSIDY')).toBeUndefined();
    expect(amount(early, 'e', '2026-08', 'HRDF_SUBSIDY')).toBe(-1500);
  });
});

describe('EOSB accrual and leave provision', () => {
  const e = emp({ id: 'v', joinDate: d('2021-09-01'), basicSalary: 10000 });
  const r = run([e], { startMonth: '2026-08', months: 3 });

  it('EOSB accrual crosses the 5-year boundary (half month -> full month per year)', () => {
    expect(amount(r, 'v', '2026-08', 'EOSB_ACCRUAL')).toBe(416.67); // 25,000 − 24,583.33
    expect(line(r, 'v', '2026-08', 'EOSB_ACCRUAL')?.basis).toBe('25,000 − 24,583.33');
    expect(amount(r, 'v', '2026-09', 'EOSB_ACCRUAL')).toBe(833.33); // 25,833.33 − 25,000
    expect(amount(r, 'v', '2026-10', 'EOSB_ACCRUAL')).toBe(833.34); // 26,666.67 − 25,833.33
    expect(r.employees[0].liabilities).toMatchObject({ eosbEmployerAtStart: 24583.33, eosbResignationAtStart: 8194.44, eosbEmployerAtEnd: 26666.67 });
  });

  it('leave accrual 21 -> 30 days/year at the 5-year anniversary, valued at wage/30, MEMO by default', () => {
    expect(line(r, 'v', '2026-08', 'LEAVE_ACCRUAL')).toMatchObject({ amount: 593.33, kind: 'MEMO' }); // 1.78 d × 333.33
    expect(line(r, 'v', '2026-08', 'LEAVE_ACCRUAL')?.basis).toContain('21 يوماً');
    expect(amount(r, 'v', '2026-09', 'LEAVE_ACCRUAL')).toBe(813.33); // (1×21 + 29×30)/365 = 2.44 d
    expect(amount(r, 'v', '2026-10', 'LEAVE_ACCRUAL')).toBe(849.99); // 31×30/365 = 2.55 d
    const m = r.employees[0].months[0];
    expect(m.memo).toBe(593.33);
    expect(m.totals.cost).toBe(roundSum(m.lines.filter((l) => l.kind === 'COST').map((l) => l.amount)));
    const inTotal = run([e], { startMonth: '2026-08', leaveAccrualInTotal: true });
    expect(line(inTotal, 'v', '2026-08', 'LEAVE_ACCRUAL')?.kind).toBe('COST');
    expect(inTotal.employees[0].months[0].totals.cost).toBeCloseTo(m.totals.cost + 593.33, 2);
  });

  it("salary basis 'basic' ignores allowances in the EOSB wage", () => {
    const withAllow = emp({ id: 'w', joinDate: d('2021-09-01'), basicSalary: 10000, allowances: [housing(2000)] });
    const total = run([withAllow], { startMonth: '2026-08' });
    const basic = run([withAllow], { startMonth: '2026-08', salaryBasis: 'basic' });
    expect(amount(total, 'w', '2026-08', 'EOSB_ACCRUAL')).toBe(500); // 30,000 − 29,500
    expect(amount(basic, 'w', '2026-08', 'EOSB_ACCRUAL')).toBe(416.67);
  });
});

function roundSum(v: number[]): number {
  return Math.round(v.reduce((s, x) => s + x, 0) * 100) / 100;
}

describe('raises, bonuses and exits', () => {
  it('ANNUAL_RAISE_PCT compounds every January after the first month; EOSB catches up on the new wage', () => {
    const r = run([emp({ id: 'r', joinDate: d('2020-01-01'), basicSalary: 10000 })], { startMonth: '2026-09', months: 18 }, [assume('ANNUAL_RAISE_PCT', 5)]);
    expect(amount(r, 'r', '2026-12', 'BASIC')).toBe(10000);
    expect(amount(r, 'r', '2027-01', 'BASIC')).toBe(10500);
    expect(line(r, 'r', '2027-01', 'BASIC')?.note).toContain('5%');
    expect(amount(r, 'r', '2028-01', 'BASIC')).toBe(11025);
    expect(amount(r, 'r', '2027-01', 'EOSB_ACCRUAL')).toBe(3125); // 48,125 (7y1m × 10,500) − 45,000 (7y × 10,000)
  });

  it('a dated SalaryChange overrides the raise for its calendar year', () => {
    const r = run(
      [emp({ id: 'c', basicSalary: 10000, salaryChanges: [{ effectiveDate: d('2027-03-01'), basicSalary: 9000, isPlanned: true }, { effectiveDate: d('2025-01-01'), basicSalary: 1, isPlanned: false }] })],
      { startMonth: '2026-09', months: 18 },
      [assume('ANNUAL_RAISE_PCT', 5)],
    );
    expect(amount(r, 'c', '2027-01', 'BASIC')).toBe(10000);
    expect(amount(r, 'c', '2027-03', 'BASIC')).toBe(9000);
    expect(line(r, 'c', '2027-03', 'BASIC')?.note).toBe('تغيير راتب مخطط');
    expect(amount(r, 'c', '2028-01', 'BASIC')).toBe(9450);
  });

  it('one-off bonus only in its payroll month and not in the wage', () => {
    const r = run([emp({ id: 'b', allowances: [{ name: 'مكافأة', amount: 5000, isMonthly: false, payrollYear: 2026, payrollMonth: 12, isPaid: false }] })], { startMonth: '2026-11', months: 3 });
    expect(line(r, 'b', '2026-11', 'ONE_OFF_BONUS')).toBeUndefined();
    expect(amount(r, 'b', '2026-12', 'ONE_OFF_BONUS')).toBe(5000);
    expect(line(r, 'b', '2027-01', 'ONE_OFF_BONUS')).toBeUndefined();
    expect(line(r, 'b', '2026-12', 'ALLOWANCES')).toBeUndefined();
  });

  it('no cost after the termination date or the contract end (flagged)', () => {
    const r = run([emp({ id: 't', terminationDate: d('2026-10-15') }), emp({ id: 'k', contractEndDate: d('2026-12-31') })], { startMonth: '2026-09', months: 5 });
    expect(amount(r, 't', '2026-10', 'BASIC')).toBe(3870.97); // 8,000 × 15/31
    const nov = r.employees.find((e) => e.employeeId === 't')!.months.find((m) => m.month === '2026-11')!;
    expect(nov).toMatchObject({ active: false, lines: [], totals: { cost: 0, subsidy: 0, net: 0 } });
    expect(r.employees.find((e) => e.employeeId === 't')?.exitDate).toBe('2026-10-15');
    expect(r.employees.find((e) => e.employeeId === 't')?.flags.map((f) => f.code)).toContain('EXITS_DURING_HORIZON');
    expect(r.employees.find((e) => e.employeeId === 'k')?.flags.map((f) => f.code)).toContain('CONTRACT_END_ASSUMED_EXIT');
    expect(r.employees.find((e) => e.employeeId === 'k')?.months.find((m) => m.month === '2027-01')?.active).toBe(false);
  });

  it('planned hire joins later: no cost before the join month', () => {
    const r = run([emp({ id: 'p', isPlanned: true, joinDate: d('2027-01-01') })], { startMonth: '2026-11', months: 3 });
    expect(r.employees[0].months.map((m) => m.active)).toEqual([false, false, true]);
    expect(r.employees[0].isPlanned).toBe(true);
  });
});

describe('aggregation, explanations, determinism, sensitivity, performance', () => {
  const staff = [
    emp({ id: 'a1', gosiRegime: 'NEW', allowances: [housing(2000)], branchId: 'b1', departmentId: 'd1' }),
    emp({ id: 'a2', nationality: 'هندي', branchId: 'b2', departmentId: 'd2', branchName: 'فرع 2', departmentName: 'إدارة 2' }),
    emp({ id: 'a3', nationality: 'هندي', legalCompanyId: 'c-ind', branchId: 'b2', departmentId: 'd2', branchName: 'فرع 2', departmentName: 'إدارة 2' }),
  ];

  it('group totals add up to the workforce total; composition by line key', () => {
    const r = run(staff, { startMonth: '2026-09', months: 12 });
    const sum = (gs: typeof r.byCompany) => Math.round(gs.reduce((s, g) => s + g.totals.next12.net, 0) * 100) / 100;
    expect(sum(r.byCompany)).toBeCloseTo(r.totals.next12.net, 2);
    expect(sum(r.byBranch)).toBeCloseTo(r.totals.next12.net, 2);
    expect(sum(r.byDepartment)).toBeCloseTo(r.totals.next12.net, 2);
    expect(r.composition.find((c) => c.key === 'LEAVE_ACCRUAL')?.kind).toBe('MEMO');
    expect(r.series[0].headcount).toBe(3);
    expect(r.totals.month1.cost).toBe(r.series[0].cost);
  });

  it('explanations carry each rule with value, status and source', () => {
    const r = run(staff, { startMonth: '2026-07' });
    const g = r.explanations.GOSI_EMPLOYER!;
    expect(g.formulaText).toContain('45,000');
    expect(g.rules.map((x) => x.key)).toEqual(expect.arrayContaining(['GOSI_MAX_CONTRIBUTORY_WAGE', 'GOSI_RATE:NEW:SA:2026-07-01']));
    const levy = r.explanations.EXPAT_LEVY!;
    expect(levy.rules.find((x) => x.key === 'EXPAT_LEVY_ABOVE_SAUDI_COUNT')).toMatchObject({ value: 800, status: 'VERIFIED_PRIMARY', effectiveFrom: '2020-01-01' });
    expect(levy.rules[0].sourceUrl).toContain('qiwa.sa');
    expect(r.explanations.EOSB_ACCRUAL!.rules[0].key).toBe('LAW:ART84');
    expect(r.rulesUsed.map((x) => x.key)).toEqual(expect.arrayContaining(['EXPAT_LEVY_WITHIN_SAUDI_COUNT', 'IQAMA_FEE_YEAR']));
  });

  it('reporting a subset keeps the legal company levy tiers', () => {
    const s = [emp({ id: 'q1' }), emp({ id: 'q2', nationality: 'هندي', joinDate: d('2021-01-01') }), emp({ id: 'q3', nationality: 'هندي', joinDate: d('2021-02-01') })];
    const only = run(s, { startMonth: '2026-09', employeeIds: ['q3'] });
    expect(only.employees.map((e) => e.employeeId)).toEqual(['q3']);
    expect(amount(only, 'q3', '2026-09', 'EXPAT_LEVY')).toBe(800);
  });

  it('deterministic: same input -> same output, independent of input order', () => {
    const a = run(staff, { startMonth: '2026-09', months: 24 });
    const b = run(staff, { startMonth: '2026-09', months: 24 });
    const c = run([...staff].reverse(), { startMonth: '2026-09', months: 24 });
    expect(b).toEqual(a);
    expect(JSON.stringify(c)).toBe(JSON.stringify(a));
  });

  it('sensitivity low / base / high moves the remaining assumptions only (company settings are single values)', () => {
    const rows = [assume('ANNUAL_TICKET_COST', null, '{"low": 1200, "base": 2400, "high": 4800}')];
    const withMed = { ...COMPANY, costSettings: { overtimeHourlyBasis: 'BASIC' as const, medicalPremiums: { A: 6000 }, iqamaFeeYear: null } };
    const [lo, ba, hi] = (['low', 'base', 'high'] as const).map((scenario) => run([emp({ id: 's', nationality: 'هندي', medicalInsuranceClass: 'A' })], { startMonth: '2026-09', scenario }, rows, [withMed]));
    expect([lo, ba, hi].map((x) => amount(x, 's', '2026-09', 'ANNUAL_TICKET'))).toEqual([100, 200, 400]);
    expect([lo, ba, hi].map((x) => amount(x, 's', '2026-09', 'MEDICAL'))).toEqual([500, 500, 500]);
    expect(hi.totals.month1.cost - lo.totals.month1.cost).toBe(300);
    expect(lo.scenario).toBe('low');
  });

  // Measured in isolation: ~0.45 s (plain Node) / ~0.55 s (vitest) for 1,000 × 36. Under the full parallel
  // suite the CPU is shared, so the test asserts LINEAR scaling (no O(n²)) plus a generous absolute guard.
  it('1,000 employees × 36 months: linear scaling and fast', () => {
    const big: WfEmployeeInput[] = [];
    for (let i = 0; i < 1000; i++) {
      big.push(
        emp({
          id: `p${String(i).padStart(4, '0')}`,
          nationality: i % 3 === 0 ? 'سعودي' : 'هندي',
          gosiRegime: i % 2 ? 'NEW' : 'OLD',
          legalCompanyId: `c${i % 5}`,
          joinDate: d(`20${10 + (i % 15)}-0${1 + (i % 9)}-15`),
          basicSalary: 3000 + (i % 40) * 250,
          allowances: [housing(1000), transport(300)],
          dependentsCount: i % 4,
          dependentsFeePaidBy: i % 2 ? 'COMPANY' : null,
          medicalInsuranceClass: 'A',
          branchId: `b${i % 7}`,
          departmentId: `d${i % 11}`,
        }),
      );
    }
    const companies = [0, 1, 2, 3, 4].map((i) => ({ id: `c${i}`, name: `c${i}`, isIndustrialLicensed: i === 4, costSettings: { overtimeHourlyBasis: 'BASIC' as const, medicalPremiums: { A: 6000 }, iqamaFeeYear: null } }));
    const assumptions = [assume('ANNUAL_RAISE_PCT', 3), assume('ANNUAL_TICKET_COST', 2000)];
    computeTrueCost({ employees: big.slice(0, 50), companies, rules: SEED_RULES, gosiRates: SEED_GOSI, assumptions }, { startMonth: '2026-09', months: 36 }); // warm-up
    const best = (n: number) => {
      let ms = Infinity;
      let res = computeTrueCost({ employees: big.slice(0, 1), companies, rules: SEED_RULES, gosiRates: SEED_GOSI, assumptions }, { startMonth: '2026-09', months: 1 });
      for (let k = 0; k < 2; k++) {
        const t0 = performance.now();
        res = computeTrueCost({ employees: big.slice(0, n), companies, rules: SEED_RULES, gosiRates: SEED_GOSI, assumptions }, { startMonth: '2026-09', months: 36 });
        ms = Math.min(ms, performance.now() - t0);
      }
      return { ms, res };
    };
    const small = best(100);
    const { ms, res: r } = best(1000);
    expect(r.employees).toHaveLength(1000);
    expect(r.series).toHaveLength(36);
    expect(ms).toBeLessThan(small.ms * 15 + 100); // ~10× for 10× the employees: linear
    expect(ms).toBeLessThan(3000);
  });
});

describe('helpers', () => {
  it('leave accrual matches src/lib/leave.ts computeLeaveBalance (parity)', () => {
    const joins = ['2021-09-01', '2020-02-29', '2019-12-31', '2026-03-15', '2010-06-30'].map(d);
    const windows: Array<[string, string]> = [
      ['2026-07-31', '2026-08-31'],
      ['2026-08-31', '2026-09-30'],
      ['2025-02-28', '2025-03-31'],
      ['2026-02-28', '2026-03-31'],
      ['2024-12-31', '2025-01-31'],
      ['2026-03-10', '2026-03-31'],
      ['2026-05-31', '2026-05-31'],
    ];
    for (const join of joins)
      for (const [from, to] of windows)
        for (const setting of [null, 25, 35]) {
          const expected = computeLeaveBalance({ joinDate: join, leaveAccrualStartDate: d(from), asOf: d(to), leaves: [], annualLeaveDaysSetting: setting }).accrued;
          expect(leaveDaysAccrued(join, d(from), d(to), setting)).toBe(expected);
        }
  });

  it('fmt', () => {
    expect(fmt(8000)).toBe('8,000');
    expect(fmt(1234567.5)).toBe('1,234,567.5');
    expect(fmt(24583.333)).toBe('24,583.33');
    expect(fmt(0.05)).toBe('0.05');
    expect(fmt(-3000)).toBe('-3,000');
    expect(fmt(999.999)).toBe('1,000');
    expect(fmt(0)).toBe('0');
  });
});
