// Decision sensitivity («حساسية القرار», SPEC §11, src/lib/workforce/sensitivity.ts): hand-checked swings
// on the same engines as the decision pages, the three scenarios, determinism, no invented ranges.
import { describe, expect, it } from 'vitest';
import {
  assumptionRange,
  attachReference,
  exitSensitivity,
  hireSensitivity,
  medicalExtremes,
  planSensitivity,
  sensitivityRows,
  withRangeOverrides,
  type SensitivityOutcome,
} from '@/lib/workforce/sensitivity';
import { hireScenario, type HireScenarioInput } from '@/lib/workforce/hiring';
import { computeExitCost } from '@/lib/workforce/exit-cost';
import { projectPlan } from '@/lib/workforce/planning';
import { resolveAssumption } from '@/lib/workforce/assumptions';
import type { AssumptionRow, ExitCostInput, WfCompanyInput } from '@/lib/workforce/types';
import { COMPANY, SEED_GOSI, SEED_RULES, assume, d, emp, housing } from './wf-fixtures';

const range = (key: string, low: number, base: number, high: number, companyId = ''): AssumptionRow => assume(key, base, JSON.stringify({ low, base, high }), companyId);
const CO: WfCompanyInput = { ...COMPANY, costSettings: { overtimeHourlyBasis: 'BASIC', medicalPremiums: { A: 6000, C: 1200, DEPENDENT: 600 }, iqamaFeeYear: null } };
const factor = (o: SensitivityOutcome, key: string) => o.factors.find((f) => f.key === key)!;

describe('assumption rows of one evaluation', () => {
  const rows = [range('ANNUAL_TICKET_COST', 1000, 2000, 3000), range('VACANCY_MONTHS', 1, 2, 4, 'c1'), assume('INCLUDE_HRDF', null, 'true')];

  it('collapses every range to the scenario value, or the pinned side for one key', () => {
    const low = sensitivityRows(rows, { scenario: 'low' });
    expect(resolveAssumption(low, 'ANNUAL_TICKET_COST', 'c1', 'high').value).toBe(1000);
    expect(resolveAssumption(low, 'VACANCY_MONTHS', 'c1', 'high').value).toBe(1);
    const pinned = sensitivityRows(rows, { scenario: 'base', rangePin: { key: 'VACANCY_MONTHS', side: 'high' } });
    expect(resolveAssumption(pinned, 'ANNUAL_TICKET_COST', 'c1', 'low').value).toBe(2000);
    expect(resolveAssumption(pinned, 'VACANCY_MONTHS', 'c1', 'low').value).toBe(4);
  });

  it('forces INCLUDE_HRDF for every company', () => {
    const off = sensitivityRows([...rows, assume('INCLUDE_HRDF', null, 'true', 'c1')], { scenario: 'base', hrdf: false });
    expect(resolveAssumption(off, 'INCLUDE_HRDF', 'c1').value).toBe(false);
  });

  it('ranges for this calculation only: base = the value in force; no base entered -> not applied (nothing invented)', () => {
    const o = withRangeOverrides([assume('RECRUITMENT_COST_SAUDI', 10000)], 'c1', { RECRUITMENT_COST_SAUDI: { low: 5000, high: 20000 }, VACANCY_MONTHS: { low: 1, high: 3 } });
    expect(assumptionRange(o.rows, 'RECRUITMENT_COST_SAUDI', 'c1')).toEqual({ low: 5000, base: 10000, high: 20000 });
    expect(o.missingBase).toEqual(['VACANCY_MONTHS']);
    expect(assumptionRange(o.rows, 'VACANCY_MONTHS', 'c1')).toBeNull();
    expect(withRangeOverrides([assume('RECRUITMENT_COST_SAUDI', 10000)], 'c1', { RECRUITMENT_COST_SAUDI: { low: 12000, high: 20000 } }).invalid).toEqual(['RECRUITMENT_COST_SAUDI']);
  });

  it('medical extremes: cheapest and most expensive entered class, none with fewer than two', () => {
    expect(medicalExtremes(CO)).toEqual({ low: { cls: 'C', premium: 1200 }, high: { cls: 'A', premium: 6000 } });
    expect(medicalExtremes({ ...CO, costSettings: { ...CO.costSettings!, medicalPremiums: { A: 6000 } } })).toBeNull();
    expect(medicalExtremes(COMPANY)).toBeNull();
  });
});

describe('hire scenario sensitivity (hand-checked)', () => {
  const staff = [emp({ id: 's1', basicSalary: 5000, qiwaContractDocumented: true }), emp({ id: 'x1', nationality: 'هندي', gosiRegime: null, basicSalary: 3000 })];
  const input: HireScenarioInput = {
    company: CO,
    companyEmployees: staff,
    nitaqat: { activity: null, curves: [] },
    decisions: [],
    rules: SEED_RULES,
    gosiRates: SEED_GOSI,
    assumptions: [range('ANNUAL_TICKET_COST', 1200, 2400, 3600)],
    startMonth: '2026-10',
    candidates: [
      { kind: 'SAUDI', label: 'سعودية', basicSalary: 6000, housingAllowance: 1000, gender: 'FEMALE', medicalClass: 'A' },
      { kind: 'EXPAT', label: 'وافد', basicSalary: 4000, nationality: 'مصري', medicalClass: 'C' },
      { kind: 'OVERTIME', label: 'إضافي', overtimeHoursPerMonth: 20, basicSalary: 4800, housingAllowance: 1200 },
    ],
  };
  const r = hireSensitivity(input, { horizon: 36 });
  const page = hireScenario(input);
  const [saudi, expat, ot] = r.outcomes;

  it('base = the page figure (after HRDF, with the levy effect) for every candidate', () => {
    r.outcomes.forEach((o, i) => expect(o.base).toBe(page.candidates[i].windows[36].total));
  });

  it('HRDF: swing = |subsidy over 36 months| for the Saudi candidate, 0 for the expat', () => {
    const f = factor(saudi, 'INCLUDE_HRDF');
    expect(page.candidates[0].windows[36].subsidy).toBeLessThan(0);
    expect(f.low).toBe(saudi.base);
    expect(f.high).toBeCloseTo(saudi.base - page.candidates[0].windows[36].subsidy, 2);
    expect(f.swing).toBeCloseTo(-page.candidates[0].windows[36].subsidy, 2);
    expect(factor(expat, 'INCLUDE_HRDF').swing).toBe(0);
  });

  it('medical class: (6,000 − 1,200) ÷ 12 × 36 = 14,400 for each hire', () => {
    const f = factor(saudi, 'MEDICAL_CLASS');
    expect(f.swing).toBe(14400);
    expect(f.lowText).toContain('C');
    expect(f.highText).toContain('A');
    expect(factor(expat, 'MEDICAL_CLASS').swing).toBe(14400);
    // the expat entered class C = the low extreme: its base equals the low result
    expect(factor(expat, 'MEDICAL_CLASS').low).toBe(expat.base);
  });

  it('annual ticket range 1,200 / 2,400 / 3,600: expat swing = 2,400 ÷ 12 × 36 = 7,200; the scenarios follow the range', () => {
    const f = factor(expat, 'ANNUAL_TICKET_COST');
    expect(f.swing).toBe(7200);
    expect(f.lowDelta).toBe(-3600);
    expect(f.highDelta).toBe(3600);
    expect(factor(saudi, 'ANNUAL_TICKET_COST').swing).toBe(0);
    expect(expat.scenarios.low).toBe(expat.base - 3600);
    expect(expat.scenarios.high).toBe(expat.base + 3600);
    expect(r.ranges).toEqual([expect.objectContaining({ key: 'ANNUAL_TICKET_COST', low: 1200, base: 2400, high: 3600, origin: 'STORED' })]);
  });

  it('overtime basis (Art. 107): 20 h × (hour of 6,000 + 50% hour of 4,800 − 1.5 × hour of 4,800) × 36 = 20 × (25 + 10 − 30) × 36 = 3,600', () => {
    const f = factor(ot, 'OVERTIME_BASIS');
    expect(f.low).toBe(20 * 30 * 36);
    expect(f.high).toBe(20 * 35 * 36);
    expect(f.swing).toBe(3600);
  });

  it('sorted by swing; skipped factors carry a reason; deterministic', () => {
    for (const o of r.outcomes) o.factors.forEach((f, i, a) => i && expect(a[i - 1].swing).toBeGreaterThanOrEqual(f.swing));
    expect(r.skipped.map((s) => s.key)).toEqual(expect.arrayContaining(['ANNUAL_RAISE_PCT', 'EXIT_REENTRY_VISAS_PER_YEAR', 'RECRUITMENT_COST_SAUDI', 'VACANCY_MONTHS']));
    expect(r.skipped.every((s) => s.reason.length > 0)).toBe(true);
    expect(JSON.stringify(hireSensitivity(input, { horizon: 36 }))).toBe(JSON.stringify(r));
    const shuffled = { ...input, assumptions: [...input.assumptions].reverse() };
    expect(JSON.stringify(hireSensitivity(shuffled, { horizon: 36 }).outcomes)).toBe(JSON.stringify(r.outcomes));
  });

  it('no range entered: the three scenarios are equal and every range factor is skipped', () => {
    const plain = hireSensitivity({ ...input, assumptions: [] }, { horizon: 12 });
    for (const o of plain.outcomes) expect(o.scenarios).toEqual({ low: o.base, base: o.base, high: o.base });
    expect(plain.outcomes.flatMap((o) => o.factors.map((f) => f.key))).not.toContain('ANNUAL_TICKET_COST');
    expect(plain.notes.join(' ')).toContain('السيناريوهات الثلاثة متساوية');
  });
});

describe('exit sensitivity (hand-checked)', () => {
  const worker = emp({ id: 'w', joinDate: d('2019-09-01'), basicSalary: 7000, allowances: [housing(2000)], medicalInsuranceClass: 'A' });
  const input: ExitCostInput = {
    employee: { ...worker, leaves: [], loans: [] },
    reason: 'COMPANY_TERMINATION',
    lastWorkingDate: d('2026-08-31'),
    noticeServed: false,
    companyEmployees: [worker],
    company: CO,
    rules: SEED_RULES,
    gosiRates: SEED_GOSI,
    assumptions: [range('RECRUITMENT_COST_SAUDI', 5000, 10000, 20000), range('VACANCY_MONTHS', 1, 2, 3)],
  };
  const r = exitSensitivity(input);
  const o = r.outcomes[0];
  const base = computeExitCost({ ...input, assumptions: sensitivityRows(input.assumptions, { scenario: 'base' }) });
  const monthly = base.lines.find((l) => l.key === 'VACANCY')!.amount / 2;

  it('figure = net paid to the employee + replacement (recruitment + vacancy), without the Art. 77 risk', () => {
    expect(base.totals.risk).toBeGreaterThan(0);
    expect(o.base).toBeCloseTo(base.totals.netToEmployee + 10000 + 2 * monthly, 2);
    expect(r.notes[0]).toContain('المادة 77');
  });

  it('recruitment swing 15,000; vacancy swing = 2 months of the role cost; scenarios move both', () => {
    expect(factor(o, 'RECRUITMENT_COST_SAUDI').swing).toBe(15000);
    expect(factor(o, 'VACANCY_MONTHS').swing).toBeCloseTo(2 * monthly, 2);
    expect(o.scenarios.low).toBeCloseTo(base.totals.netToEmployee + 5000 + monthly, 2);
    expect(o.scenarios.high).toBeCloseTo(base.totals.netToEmployee + 20000 + 3 * monthly, 2);
  });

  it('medical class moves the vacancy cost only: (500 − 100) × 2 vacancy months = 800', () => {
    expect(factor(o, 'MEDICAL_CLASS').swing).toBe(800);
    expect(r.skipped.map((s) => s.key)).toEqual(expect.arrayContaining(['RECRUITMENT_COST_EXPAT', 'INCLUDE_HRDF', 'OVERTIME_BASIS', 'ANNUAL_RAISE_PCT']));
  });

  it('ranges given for this calculation only override a single stored value', () => {
    const pinned = { ...input, assumptions: [assume('RECRUITMENT_COST_SAUDI', 10000), assume('VACANCY_MONTHS', 2)] };
    expect(exitSensitivity(pinned).outcomes[0].factors.map((f) => f.key)).toEqual(['MEDICAL_CLASS']);
    const withRanges = exitSensitivity(pinned, { ranges: { RECRUITMENT_COST_SAUDI: { low: 5000, high: 20000 } } });
    expect(factor(withRanges.outcomes[0], 'RECRUITMENT_COST_SAUDI').swing).toBe(15000);
    expect(withRanges.ranges[0].origin).toBe('REQUEST');
  });
});

describe('plan sensitivity', () => {
  it('base = projectPlan totals; HRDF swing = the plan subsidy; medical class on the planned hires', () => {
    const base = { employees: [emp({ id: 'e1', basicSalary: 5000 })], companies: [CO], rules: SEED_RULES, gosiRates: SEED_GOSI, assumptions: [] };
    const plan = {
      id: 'p1',
      name: 'خطة',
      companyId: 'c1',
      fromMonth: '2026-10',
      months: 12,
      attritionPct: 0,
      positions: [{ id: 'h1', kind: 'NEW_HIRE', title: 'محاسبة', companyId: 'c1', nationalityClass: 'SAUDI', gender: 'FEMALE', basicSalary: 6000, housingAllowance: 1000, medicalClass: 'A', startMonth: '2026-10' }],
      raises: [],
    };
    const r = planSensitivity(base, plan);
    const p = projectPlan(base, plan, { scenario: 'base' });
    const [total, delta] = r.outcomes;
    expect(total.base).toBe(p.totals.horizon!.totalAfterHrdf);
    expect(delta.base).toBe(p.totals.horizon!.deltaAfterHrdf);
    expect(factor(total, 'INCLUDE_HRDF').swing).toBeCloseTo(-p.totals.horizon!.subsidy - p.totals.horizon!.attrition.subsidy, 2);
    // one hire, 12 months: (6,000 − 1,200) ÷ 12 × 12 = 4,800
    expect(factor(total, 'MEDICAL_CLASS').swing).toBe(4800);
    expect(factor(delta, 'MEDICAL_CLASS').swing).toBe(4800);
    expect(r.skipped.find((s) => s.key === 'ANNUAL_RAISE_PCT')?.reason).toContain('الخطة');
  });
});

describe('differences are computed by the engine (the exports only print them)', () => {
  const staff = [emp({ id: 's1', basicSalary: 5000, qiwaContractDocumented: true })];
  const input: HireScenarioInput = {
    company: CO,
    companyEmployees: staff,
    nitaqat: { activity: null, curves: [] },
    decisions: [],
    rules: SEED_RULES,
    gosiRates: SEED_GOSI,
    assumptions: [range('ANNUAL_TICKET_COST', 1200, 2400, 3600)],
    startMonth: '2026-10',
    candidates: [{ kind: 'EXPAT', label: 'وافد', basicSalary: 4000, nationality: 'مصري', medicalClass: 'C' }],
  };
  const r = hireSensitivity(input, { horizon: 36 });
  const r2 = (n: number) => Math.round(n * 100) / 100;

  it('scenarioSpread = high − low and scenarioDeltas = low / high − base, rounded to 2 decimals', () => {
    for (const o of r.outcomes) {
      expect(o.scenarioSpread).toBe(r2(o.scenarios.high - o.scenarios.low));
      expect(o.scenarioDeltas).toEqual({ low: r2(o.scenarios.low - o.base), high: r2(o.scenarios.high - o.base) });
    }
    expect(r.outcomes[0].scenarioSpread).toBe(7200);
    expect(r.outcomes[0].scenarioDeltas).toEqual({ low: -3600, high: 3600 });
  });

  it('attachReference: live − approved per outcome, rounded; null when the approved value is absent', () => {
    const copy = JSON.parse(JSON.stringify(r)) as typeof r;
    copy.outcomes = [
      { ...copy.outcomes[0], id: 'total', base: 1000.1 },
      { ...copy.outcomes[0], id: 'delta', base: 50 },
    ];
    const ref = attachReference(copy, { label: 'المعتمد', createdAt: '2026-09-01T00:00:00.000Z', values: { total: 999.895, delta: null } });
    expect(copy.reference).toBe(ref);
    expect(ref.values).toEqual({ total: 999.895, delta: null });
    // 1000.10 − round2(999.895) = 1000.10 − 999.90 = 0.2 (not the unrounded 0.205)
    expect(ref.diffs.total).toBe(0.2);
    expect(ref.diffs.delta).toBeNull();
  });
});
