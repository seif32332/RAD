import { describe, expect, it } from 'vitest';
import { buildSnapshot, computeOverview, computeTrueCost, ENGINE_VERSION, stableStringify, type RuleRow } from '@/lib/workforce';
import { COMPANY, SEED_GOSI, SEED_RULES, d, emp, housing } from './wf-fixtures';

const FUTURE_RULES: RuleRow[] = [
  ...SEED_RULES,
  { key: 'IQAMA_FEE_YEAR', label: 'رسوم الإقامة', value: 800, unit: 'SAR_YEAR', effectiveFrom: d('2027-01-01'), status: 'PROVISIONAL' },
  { key: 'EXPAT_LEVY_ABOVE_SAUDI_COUNT', label: 'المقابل المالي الأعلى', value: 900, unit: 'SAR_MONTH', effectiveFrom: d('2027-01-01'), status: 'VERIFIED_PRIMARY' },
];

const staff = [
  emp({ id: 'n', gosiRegime: 'NEW', basicSalary: 8000, allowances: [housing(2000)] }),
  emp({ id: 'o', gosiRegime: 'OLD', basicSalary: 8000 }),
  emp({ id: 'x', nationality: 'هندي', joinDate: d('2021-01-01'), basicSalary: 3000 }),
  emp({ id: 'y', nationality: 'هندي', joinDate: d('2021-02-01'), basicSalary: 3000 }),
  emp({ id: 'z', nationality: 'هندي', joinDate: d('2021-03-01'), basicSalary: 3000 }),
];

describe('computeOverview', () => {
  const tc = computeTrueCost({ employees: staff, companies: [COMPANY], rules: FUTURE_RULES, gosiRates: SEED_GOSI, assumptions: [] }, { startMonth: '2026-09', months: 36 });
  const ov = computeOverview(tc, { rules: FUTURE_RULES, gosiRates: SEED_GOSI });

  it('KPIs come from the true cost result', () => {
    expect(ov.kpis.thisMonth).toEqual(tc.totals.month1);
    expect(ov.kpis.next12).toEqual(tc.totals.next12);
    expect(ov.kpis.next36).toEqual(tc.totals.next36);
    expect(ov.kpis).toMatchObject({ headcount: 5, saudi: 2, gcc: 0, expat: 3 });
    const eosb = tc.employees.reduce((s, e) => s + e.liabilities.eosbEmployerAtStart, 0);
    expect(ov.kpis.eosbLiabilityEmployer).toBeCloseTo(eosb, 2);
    expect(ov.disclaimer).toContain('قوى');
  });

  it('Saudi / expat counts and levy tiers per legal company', () => {
    expect(ov.legalCompanies).toEqual([
      expect.objectContaining({ companyId: 'c1', saudi: 2, expat: 3, within: 2, above: 1, monthlyLevy: 2200, rawSaudiRatioPct: 40 }),
    ]);
  });

  it('upcoming GOSI steps with their monthly impact on this workforce', () => {
    const gosi = ov.upcomingEvents.filter((e) => e.kind === 'GOSI_RATE');
    expect(gosi.map((e) => e.effectiveFrom)).toEqual(['2027-07-01', '2028-07-01']);
    expect(gosi[0]).toMatchObject({ appliesFromMonth: '2027-07', value: 13.25, previousValue: 12.75, affected: 1, estimatedMonthlyImpact: 50 }); // +0.5% × 10,000
    // Consistent with the projected series.
    const n = tc.employees.find((e) => e.employeeId === 'n')!;
    const g = (m: string) => n.months.find((x) => x.month === m)!.lines.find((l) => l.key === 'GOSI_EMPLOYER')!.amount;
    expect(g('2027-07') - g('2027-06')).toBe(50);
  });

  it('upcoming rule changes: proportional fee change and levy rate change', () => {
    const iqama = ov.upcomingEvents.find((e) => e.key === 'IQAMA_FEE_YEAR')!;
    expect(iqama).toMatchObject({ effectiveFrom: '2027-01-01', appliesFromMonth: '2027-01', value: 800, previousValue: 650, status: 'PROVISIONAL', estimatedMonthlyImpact: 37.5 }); // 3 × (66.67 − 54.17)
    const levy = ov.upcomingEvents.find((e) => e.key === 'EXPAT_LEVY_ABOVE_SAUDI_COUNT')!;
    expect(levy).toMatchObject({ affected: 1, estimatedMonthlyImpact: 100 });
    // Past rows are not "upcoming".
    expect(ov.upcomingEvents.some((e) => e.key === 'HRDF_BASE_PCT')).toBe(false);
    expect(ov.upcomingEvents.map((e) => e.effectiveFrom)).toEqual([...ov.upcomingEvents.map((e) => e.effectiveFrom)].sort());
  });

  it('data-quality summary counts flags by code', () => {
    const med = ov.dataQuality.find((q) => q.code === 'MISSING_MEDICAL_CLASS')!;
    expect(med).toMatchObject({ severity: 'WARNING', employees: 5 });
    expect(ov.dataQuality[0].severity === 'ERROR' || ov.dataQuality[0].severity === 'WARNING').toBe(true);
  });
});

describe('buildSnapshot', () => {
  it('stores the engine version, the exact rule versions and stable JSON', () => {
    const tc = computeTrueCost({ employees: staff, companies: [COMPANY], rules: SEED_RULES, gosiRates: SEED_GOSI, assumptions: [] }, { startMonth: '2026-09', months: 3 });
    const inputs = { startMonth: '2026-09', months: 3, at: d('2026-09-26'), scope: { b: 2, a: 1 } };
    const s1 = buildSnapshot('TRUE_COST', { type: 'ALL', title: 'كل المنشأة' }, inputs, tc, tc.rulesUsed);
    const s2 = buildSnapshot('TRUE_COST', { type: 'ALL', title: 'كل المنشأة' }, { scope: { a: 1, b: 2 }, at: d('2026-09-26'), months: 3, startMonth: '2026-09' }, tc, [...tc.rulesUsed].reverse());
    expect(s1).toEqual(s2);
    expect(s1).toMatchObject({ kind: 'TRUE_COST', subjectType: 'ALL', subjectId: null, engineVersion: ENGINE_VERSION });
    expect(ENGINE_VERSION).toBe('wf-1.0.0');
    expect(s1.inputs).toBe('{"at":"2026-09-26T00:00:00.000Z","months":3,"scope":{"a":1,"b":2},"startMonth":"2026-09"}');
    const versions = JSON.parse(s1.ruleVersions) as Array<{ key: string; effectiveFrom: string | null; status: string }>;
    expect(versions.find((v) => v.key === 'IQAMA_FEE_YEAR')).toEqual({ key: 'IQAMA_FEE_YEAR', effectiveFrom: '2020-01-01', status: 'PROVISIONAL', value: 650 });
    expect(versions.map((v) => v.key)).toEqual([...versions.map((v) => v.key)].sort());
    expect(JSON.parse(s1.outputs).engineVersion).toBe(ENGINE_VERSION);
  });

  it('stableStringify handles non-finite numbers, undefined and nested dates', () => {
    expect(stableStringify({ z: undefined, y: NaN, x: [d('2026-01-01'), Infinity] })).toBe('{"x":["2026-01-01T00:00:00.000Z",null],"y":null}');
  });
});
