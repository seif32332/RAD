// Workforce API response shaping and validation (src/app/api/workforce/_lib/views.ts + schemas.ts).
// Pure: the engine runs on the test fixtures; no database, no Next.js runtime.
import { describe, expect, it } from 'vitest';
import { ASSUMPTION_DEFS, computeOverview, computeTrueCost, resolveAssumption, resolveCompanyAssumptions, type AssumptionKey, type AssumptionRow } from '@/lib/workforce';
import {
  assumptionEvidence,
  assumptionFormValue,
  buildOverviewResponse,
  buildRulesView,
  companySettingsEvidence,
  settingsOf,
  compositionForWindow,
  pageSummaries,
  summarizeEmployee,
  validateAssumptionValue,
  withAssumptionOverrides,
} from '@/app/api/workforce/_lib/views';
import { exitCostSchema, newRuleVersionSchema, overviewQuerySchema, trueCostQuerySchema, assumptionsPutSchema } from '@/app/api/workforce/_lib/schemas';
import { evidenceForLine } from '@/app/api/workforce/_lib/shared';
import { COMPANY, SEED_GOSI, SEED_RULES, assume, d, emp, housing } from './wf-fixtures';

const employees = [
  emp({ id: 'a', name: 'أحمد', employeeNo: 'E1', basicSalary: 9000, allowances: [housing(2000)] }),
  emp({ id: 'b', name: 'بدر', employeeNo: 'E2', basicSalary: 5000, nationality: 'هندي', medicalInsuranceClass: 'B' }),
  emp({ id: 'c', name: 'جمال', employeeNo: 'E3', basicSalary: 12000, gosiRegime: null }),
];
const COMPANY_WITH_SETTINGS = { ...COMPANY, costSettings: { overtimeHourlyBasis: 'BASIC' as const, medicalPremiums: { A: 6000 }, iqamaFeeYear: null } };
const tc = computeTrueCost({ employees, companies: [COMPANY_WITH_SETTINGS], rules: SEED_RULES, gosiRates: SEED_GOSI, assumptions: [] }, { startMonth: '2026-09', months: 36 });

describe('employee summaries and paging', () => {
  const rows = tc.employees.map(summarizeEmployee);

  it('summary totals are the engine totals (no recomputation)', () => {
    for (const e of tc.employees) {
      const s = rows.find((r) => r.employeeId === e.employeeId)!;
      expect(s.month1).toEqual(e.totals.month1);
      expect(s.next12).toEqual(e.totals.next12);
      expect(s.next36).toEqual(e.totals.next36);
      expect(s.eosbLiabilityEmployer).toBe(e.liabilities.eosbEmployerAtStart);
    }
  });

  it('flags are deduplicated by code', () => {
    const c = rows.find((r) => r.employeeId === 'c')!;
    expect(c.flags.map((f) => f.code)).toContain('MISSING_GOSI_REGIME');
    expect(new Set(c.flags.map((f) => f.code)).size).toBe(c.flags.length);
  });

  it('search, sort and page', () => {
    const byCost = pageSummaries(rows, { take: 2, skip: 0 });
    expect(byCost.total).toBe(3);
    expect(byCost.items.map((r) => r.employeeId)).toEqual(['c', 'a']);
    expect(pageSummaries(rows, { take: 2, skip: 2 }).items.map((r) => r.employeeId)).toEqual(['b']);
    expect(pageSummaries(rows, { q: 'e2', take: 10, skip: 0 }).items.map((r) => r.employeeId)).toEqual(['b']);
    expect(pageSummaries(rows, { q: 'جمال', take: 10, skip: 0 }).total).toBe(1);
    expect(pageSummaries(rows, { sort: 'name', take: 10, skip: 0 }).items.map((r) => r.name)).toEqual(['أحمد', 'بدر', 'جمال']);
    expect(pageSummaries(rows, { flagged: true, take: 10, skip: 0 }).items.every((r) => r.flags.some((f) => f.severity !== 'INFO'))).toBe(true);
  });
});

describe('overview response', () => {
  const ov = computeOverview(tc, { rules: SEED_RULES, gosiRates: SEED_GOSI });

  it('composition for a window sums the engine series', () => {
    for (const h of [12, 24, 36]) {
      const comp = compositionForWindow(tc, h);
      for (const c of comp) {
        const expected = Math.round(tc.series.slice(0, h).reduce((s, x) => s + (x.byLine[c.key] ?? 0), 0) * 100) / 100;
        expect(c.amount).toBeCloseTo(expected, 2);
      }
    }
    // 36-month window = the engine's horizon composition.
    for (const c of compositionForWindow(tc, 36)) expect(c.amount).toBeCloseTo(tc.composition.find((x) => x.key === c.key)!.horizon, 2);
    for (const c of compositionForWindow(tc, 12)) expect(c.amount).toBeCloseTo(tc.composition.find((x) => x.key === c.key)!.next12, 2);
  });

  it('KPIs are the engine KPIs; the window follows the horizon; events are cut to the window', () => {
    const r12 = buildOverviewResponse(tc, ov, 12, 'base');
    const r36 = buildOverviewResponse(tc, ov, 36, 'base');
    expect(r12.kpis.thisMonth).toEqual(ov.kpis.thisMonth);
    expect(r12.kpis.next36).toEqual(ov.kpis.next36);
    expect(r12.kpis.window).toEqual(tc.totals.next12);
    expect(r36.kpis.window).toEqual(tc.totals.next36);
    expect(r12.upcomingEvents.every((e) => e.appliesFromMonth <= '2027-08')).toBe(true);
    expect(r12.upcomingEvents.map((e) => e.effectiveFrom)).toContain('2027-07-01'); // GOSI step inside 2026-09..2027-08
    expect(r12.upcomingEvents.map((e) => e.effectiveFrom)).not.toContain('2028-07-01');
    expect(r36.upcomingEvents.map((e) => e.effectiveFrom)).toContain('2028-07-01');
    expect(r36.byCompany[0].window).toEqual(ov.byCompany[0].totals.next36);
  });

  it('data quality carries a fix target and a bounded employee sample', () => {
    const r = buildOverviewResponse(tc, ov, 36, 'base');
    const gosi = r.dataQuality.find((x) => x.code === 'MISSING_GOSI_REGIME')!;
    expect(gosi.fix).toBe('EMPLOYEE');
    expect(gosi.sample).toEqual([{ id: 'c', name: 'جمال' }]);
    const med = r.dataQuality.find((x) => x.code === 'MISSING_MEDICAL_PREMIUM');
    expect(med?.fix).toBe('COMPANY');
    expect(med?.companies).toEqual([{ id: 'c1', name: 'شركة الاختبار' }]);
    const prov = r.dataQuality.find((x) => x.code === 'PROVISIONAL_RULE');
    expect(prov?.fix).toBe('RULES');
    expect(prov?.ruleKeys.length).toBeGreaterThan(0);
  });
});

describe('assumption evidence', () => {
  it('entered values are USER_INPUT, missing ones MISSING, system defaults DERIVED', () => {
    const rows: AssumptionRow[] = [assume('ANNUAL_TICKET_COST', 1800), assume('VACANCY_MONTHS', 2, null, 'c1')];
    const g = assumptionEvidence(rows, null, 'base');
    expect(g['ASSUMPTION:ANNUAL_TICKET_COST']).toMatchObject({ status: 'USER_INPUT', value: 1800 });
    expect(g['ASSUMPTION:VACANCY_MONTHS'].status).toBe('MISSING');
    expect(g['ASSUMPTION:INCLUDE_HRDF'].status).toBe('DERIVED');
    const c = assumptionEvidence(rows, 'c1', 'base');
    expect(c['ASSUMPTION:VACANCY_MONTHS']).toMatchObject({ status: 'USER_INPUT', value: 2 });
    expect(c['ASSUMPTION:VACANCY_MONTHS'].sourceQuote).toContain('مدخل لهذه الشركة');
  });

  it('exit-cost overrides win over company and global rows, for this calculation only', () => {
    const rows: AssumptionRow[] = [assume('RECRUITMENT_COST_SAUDI', 5000), assume('RECRUITMENT_COST_SAUDI', 7000, null, 'c1'), assume('VACANCY_MONTHS', 1)];
    const out = withAssumptionOverrides(rows, 'c1', { recruitmentCostSaudi: 9000 });
    expect(resolveCompanyAssumptions(out, 'c1').recruitmentCostSaudi.value).toBe(9000);
    expect(resolveCompanyAssumptions(out, 'c1').vacancyMonths.value).toBe(1);
    expect(rows).toHaveLength(3); // input untouched
    expect(withAssumptionOverrides(rows, null, undefined)).toEqual(rows);
    expect(resolveCompanyAssumptions(withAssumptionOverrides(rows, null, { vacancyMonths: 4 }), null).vacancyMonths.value).toBe(4);
  });
});

describe('company settings evidence («لماذا؟» cites إعدادات الشركة)', () => {
  it('COMPANY:* keys cite the company by name with a link to its settings', () => {
    const ev = companySettingsEvidence({ companyId: 'c1', name: 'شركة الاختبار', overtimeHourlyBasis: 'TOTAL_PLUS_HALF_BASIC', medicalPremiums: { A: 6000, DEPENDENT: 1200 }, iqamaFeeYear: 600 });
    expect(ev['COMPANY:IQAMA_FEE_YEAR']).toMatchObject({ status: 'USER_INPUT', value: 600, sourceUrl: '/companies/c1/edit#company-cost-settings' });
    expect(ev['COMPANY:IQAMA_FEE_YEAR'].sourceQuote).toContain('إعدادات الشركة: شركة الاختبار');
    expect(ev['COMPANY:MEDICAL_PREMIUMS'].status).toBe('USER_INPUT');
    expect(ev['COMPANY:MEDICAL_PREMIUMS'].sourceQuote).toContain('A: 6,000');
    expect(ev['COMPANY:MEDICAL_PREMIUMS'].sourceQuote).toContain('غير مدخل: VIP');
    expect(ev['COMPANY:OVERTIME_HOURLY_BASIS'].sourceQuote).toContain('50%');
    const none = companySettingsEvidence({ companyId: 'c1', name: 'شركة الاختبار', overtimeHourlyBasis: 'BASIC', medicalPremiums: {}, iqamaFeeYear: null });
    expect(none['COMPANY:MEDICAL_PREMIUMS'].status).toBe('MISSING');
    expect(none['COMPANY:IQAMA_FEE_YEAR'].status).toBe('MISSING');
    expect(companySettingsEvidence(null)['COMPANY:OVERTIME_HOURLY_BASIS'].status).toBe('MISSING');
  });

  it('evidenceForLine resolves COMPANY:* keys from the merged evidence record', () => {
    const ev = companySettingsEvidence(settingsOf(tc, 'c1'));
    const lineA = tc.employees.find((e) => e.employeeId === 'a')!.months[0].lines.find((l) => l.key === 'MEDICAL')!;
    const out = evidenceForLine(lineA, '2026-09', tc.explanations.MEDICAL, ev);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: 'COMPANY:MEDICAL_PREMIUMS', status: 'USER_INPUT' });
    expect(out[0].sourceQuote).toContain('إعدادات الشركة: شركة الاختبار');
  });
});

describe('rules register view', () => {
  const rules = [
    { key: 'IQAMA_FEE_YEAR', domain: 'EXPAT_FEES', label: 'رسوم الإقامة', value: 650, unit: 'SAR_YEAR', effectiveFrom: d('2020-01-01'), status: 'PROVISIONAL' },
    { key: 'IQAMA_FEE_YEAR', domain: 'EXPAT_FEES', label: 'رسوم الإقامة', value: 700, unit: 'SAR_YEAR', effectiveFrom: d('2027-01-01'), status: 'VERIFIED_PRIMARY', sourceUrl: 'https://example.gov.sa' },
    { key: 'NOTICE_DAYS_EMPLOYER', domain: 'LABOR_LAW', label: 'الإشعار', value: 60, unit: 'DAYS', effectiveFrom: d('2025-02-19'), status: 'VERIFIED_PRIMARY' },
    { key: 'OLD_KEY', domain: 'LABOR_LAW', label: 'قديم', value: 1, unit: null, effectiveFrom: d('2010-01-01'), status: 'weird' },
    { key: 'OLD_KEY', domain: 'LABOR_LAW', label: 'قديم', value: 2, unit: null, effectiveFrom: d('2015-01-01'), status: 'VERIFIED_PRIMARY' },
  ];
  const view = buildRulesView(rules, SEED_GOSI, '2026-09-26');

  it('groups by domain in the fixed order, GOSI rates first in GOSI', () => {
    expect(view.map((v) => v.domain)).toEqual(['GOSI', 'LABOR_LAW', 'EXPAT_FEES']);
    expect(view[0].keys.map((k) => k.key)).toEqual(['GOSI_RATE:NEW:NON_SA', 'GOSI_RATE:NEW:SA', 'GOSI_RATE:OLD:NON_SA', 'GOSI_RATE:OLD:SA']);
  });

  it('marks CURRENT / FUTURE / SUPERSEDED versions and normalises unknown statuses to PROVISIONAL', () => {
    const iq = view.find((v) => v.domain === 'EXPAT_FEES')!.keys[0];
    expect(iq.versions.map((v) => v.state)).toEqual(['CURRENT', 'FUTURE']);
    expect(iq.current?.value).toBe(650);
    const old = view.find((v) => v.domain === 'LABOR_LAW')!.keys.find((k) => k.key === 'OLD_KEY')!;
    expect(old.versions.map((v) => [v.state, v.status])).toEqual([
      ['SUPERSEDED', 'PROVISIONAL'],
      ['CURRENT', 'VERIFIED_PRIMARY'],
    ]);
    const sa = view[0].keys.find((k) => k.key === 'GOSI_RATE:NEW:SA')!;
    expect(sa.current?.value).toBe(12.75);
    expect(sa.versions.filter((v) => v.state === 'FUTURE').map((v) => v.effectiveFrom)).toEqual(['2027-07-01', '2028-07-01']);
  });
});

describe('assumption validation (ASSUMPTION_DEFS)', () => {
  const ok = (key: AssumptionKey, raw: unknown) => {
    const r = validateAssumptionValue(key, raw);
    if (!r.ok) throw new Error(r.message);
    return r.store;
  };

  it('numbers: bounds, ranges and removal', () => {
    expect(ok('ANNUAL_TICKET_COST', 2000)).toEqual({ remove: false, value: 2000, valueJson: null });
    expect(ok('ANNUAL_TICKET_COST', '2500')).toEqual({ remove: false, value: 2500, valueJson: null });
    expect(ok('ANNUAL_TICKET_COST', null)).toEqual({ remove: true });
    expect(ok('VACANCY_MONTHS', { low: 1, base: 2, high: 3 })).toEqual({ remove: false, value: 2, valueJson: '{"low":1,"base":2,"high":3}' });
    expect(ok('VACANCY_MONTHS', { base: 2 })).toEqual({ remove: false, value: 2, valueJson: null });
    expect(validateAssumptionValue('VACANCY_MONTHS', 40).ok).toBe(false);
    expect(validateAssumptionValue('ANNUAL_TICKET_COST', -1).ok).toBe(false);
    expect(validateAssumptionValue('ANNUAL_TICKET_COST', 'abc').ok).toBe(false);
    expect(validateAssumptionValue('VACANCY_MONTHS', { low: 3, base: 2, high: 4 }).ok).toBe(false);
    expect(validateAssumptionValue('VACANCY_MONTHS', { base: 2, mid: 3 }).ok).toBe(false);
    expect(ok('ANNUAL_RAISE_PCT', -5)).toMatchObject({ value: -5 });
  });

  it('the moved keys (company settings) are no longer assumptions; PUT refuses them with an Arabic message', () => {
    for (const key of ['MEDICAL_PREMIUM_BY_CLASS', 'MEDICAL_PREMIUM_DEFAULT', 'DEPENDENT_MEDICAL_PREMIUM', 'OVERTIME_HOURLY_BASIS']) {
      expect(key in ASSUMPTION_DEFS).toBe(false);
      const r = assumptionsPutSchema.safeParse({ companyId: '', items: [{ key, value: 1 }] });
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues[0].message).toContain('إعدادات الشركة');
    }
    const unknown = assumptionsPutSchema.safeParse({ companyId: '', items: [{ key: 'NOPE', value: 1 }] });
    expect(unknown.success ? '' : unknown.error.issues[0].message).toBe('افتراض غير معروف');
    expect(assumptionsPutSchema.safeParse({ companyId: '', items: [{ key: 'ANNUAL_TICKET_COST', value: 1 }] }).success).toBe(true);
  });

  it('booleans and enums', () => {
    expect(ok('INCLUDE_HRDF', false)).toEqual({ remove: false, value: null, valueJson: 'false' });
    expect(ok('COMPANY_IS_SME', 'true')).toEqual({ remove: false, value: null, valueJson: 'true' });
    expect(validateAssumptionValue('COMPANY_IS_SME', 1).ok).toBe(false);
    expect(ok('DEPENDENTS_FEE_PAID_BY_DEFAULT', 'COMPANY')).toEqual({ remove: false, value: null, valueJson: '"COMPANY"' });
    expect(validateAssumptionValue('DEPENDENTS_FEE_PAID_BY_DEFAULT', 'company').ok).toBe(false);
  });

  it('stored rows resolve in the engine to the validated value (round trip with the form value)', () => {
    const cases: Array<[AssumptionKey, unknown, unknown]> = [
      ['ANNUAL_TICKET_COST', 2000, 2000],
      ['VACANCY_MONTHS', { low: 1, base: 2, high: 3 }, 2],
      ['INCLUDE_HRDF', false, false],
      ['DEPENDENTS_FEE_PAID_BY_DEFAULT', 'COMPANY', 'COMPANY'],
    ];
    for (const [key, raw, resolved] of cases) {
      const s = ok(key, raw);
      if (s.remove) throw new Error('unexpected remove');
      const row: AssumptionRow = { key, companyId: '', value: s.value, valueJson: s.valueJson };
      expect(resolveAssumption([row], key, null, 'base').value).toEqual(resolved);
      expect(assumptionFormValue(key, row)).toEqual(raw);
    }
    const ranged: AssumptionRow = { key: 'VACANCY_MONTHS', companyId: '', value: 2, valueJson: '{"low":1,"base":2,"high":3}' };
    expect(resolveAssumption([ranged], 'VACANCY_MONTHS', null, 'high').value).toBe(3);
    expect(resolveAssumption([ranged], 'VACANCY_MONTHS', null, 'low').value).toBe(1);
  });
});

describe('request schemas', () => {
  it('horizon and scenario', () => {
    expect(overviewQuerySchema.parse({})).toEqual({ months: 36, scenario: 'base' });
    expect(overviewQuerySchema.parse({ months: '12', scenario: 'high' })).toEqual({ months: 12, scenario: 'high' });
    expect(overviewQuerySchema.safeParse({ months: '18' }).success).toBe(false);
    expect(overviewQuerySchema.safeParse({ scenario: 'worst' }).success).toBe(false);
    const q = trueCostQuerySchema.parse({ take: '50', flagged: '1' });
    expect(q).toMatchObject({ take: 50, skip: 0, sort: 'cost', flagged: true });
    expect(trueCostQuerySchema.safeParse({ take: '500' }).success).toBe(false);
  });

  it('exit cost: a settlement basis is required when the exit reason has no mapping', () => {
    const base = { employeeId: 'x', lastWorkingDate: '2026-10-31', noticeServed: false };
    expect(exitCostSchema.safeParse({ ...base, exitReason: 'RESIGNATION' }).success).toBe(true);
    const mutual = exitCostSchema.safeParse({ ...base, exitReason: 'MUTUAL_AGREEMENT' });
    expect(mutual.success).toBe(false);
    if (!mutual.success) expect(mutual.error.issues[0].path).toEqual(['settlementReason']);
    expect(exitCostSchema.safeParse({ ...base, exitReason: 'OTHER', settlementReason: 'COMPANY_TERMINATION' }).success).toBe(true);
    expect(exitCostSchema.safeParse({ ...base, exitReason: 'NOPE' }).success).toBe(false);
    expect(exitCostSchema.safeParse({ ...base, exitReason: 'RESIGNATION', assumptionsOverride: { recruitmentCostSaudi: 1, other: 2 } }).success).toBe(false);
    expect(exitCostSchema.safeParse({ ...base, exitReason: 'RESIGNATION', assumptionsOverride: { vacancyMonths: 40 } }).success).toBe(false);
  });

  it('new rule version: source link required unless USER_INPUT; value required; history fields only', () => {
    const b = { key: 'IQAMA_FEE_YEAR', value: 650, effectiveFrom: '2027-01-01', status: 'VERIFIED_PRIMARY' };
    expect(newRuleVersionSchema.safeParse(b).success).toBe(false);
    expect(newRuleVersionSchema.safeParse({ ...b, sourceUrl: 'https://www.gd.gov.sa/x' }).success).toBe(true);
    expect(newRuleVersionSchema.safeParse({ ...b, status: 'USER_INPUT' }).success).toBe(true);
    expect(newRuleVersionSchema.safeParse({ ...b, status: 'MISSING', sourceUrl: 'https://a.b' }).success).toBe(false);
    expect(newRuleVersionSchema.safeParse({ ...b, value: undefined, status: 'USER_INPUT' }).success).toBe(false);
    expect(newRuleVersionSchema.safeParse({ ...b, status: 'USER_INPUT', valueJson: '{bad' }).success).toBe(false);
    expect(newRuleVersionSchema.safeParse({ ...b, key: 'iqama fee', status: 'USER_INPUT' }).success).toBe(false);
    expect(newRuleVersionSchema.safeParse({ ...b, sourceUrl: 'javascript:alert(1)' }).success).toBe(false);
    expect(newRuleVersionSchema.safeParse({ ...b, status: 'USER_INPUT', id: 'x' }).success).toBe(false);
  });

  it('assumptions PUT: known keys, no duplicates', () => {
    expect(assumptionsPutSchema.safeParse({ companyId: '', items: [{ key: 'ANNUAL_TICKET_COST', value: 1 }] }).success).toBe(true);
    expect(assumptionsPutSchema.safeParse({ companyId: '', items: [{ key: 'NOPE', value: 1 }] }).success).toBe(false);
    expect(assumptionsPutSchema.safeParse({ companyId: '', items: [] }).success).toBe(false);
    expect(assumptionsPutSchema.safeParse({ companyId: '', items: [{ key: 'VACANCY_MONTHS', value: 1 }, { key: 'VACANCY_MONTHS', value: 2 }] }).success).toBe(false);
  });
});
