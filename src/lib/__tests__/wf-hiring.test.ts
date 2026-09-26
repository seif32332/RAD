// Hiring scenarios (src/lib/workforce/hiring.ts): the candidate numbers equal direct true cost engine
// calls; levy tier interaction (800 -> 700, end of the small-establishment exemption); HRDF net; Nitaqat
// and localization before / after; overtime capacity; outsourcing; determinism. Hand-computed.
import { describe, expect, it } from 'vitest';
import { candidateEmployee, hireScenario, type HireCandidate, type HireScenarioInput } from '@/lib/workforce/hiring';
import { computeTrueCost } from '@/lib/workforce/true-cost';
import type { NitaqatActivityRow, NitaqatCurveRow } from '@/lib/workforce/nitaqat';
import type { LocalizationDecisionRow } from '@/lib/workforce/saudization';
import type { WfEmployeeInput } from '@/lib/workforce';
import { COMPANY, SEED_GOSI, SEED_RULES, assume, d, emp } from './wf-fixtures';

// Business services constants verified from the guide annex (TEST FIXTURES, not seed data).
const BIZ: NitaqatActivityRow = { key: 'test-biz', nameAr: 'خدمات الاعمال', code: '481', status: 'VERIFIED_PRIMARY', page: 14 };
const BIZ_M = [1.03, 1.03, 2.19, 2.19];
const BIZ_C: Record<number, number[]> = { 2026: [33.78, 42.62, 43.62, 54.82], 2027: [36.78, 45.62, 46.62, 57.82], 2028: [39.78, 48.62, 49.62, 60.82] };
const BIZ_CURVES: NitaqatCurveRow[] = [2026, 2027, 2028].flatMap((year) =>
  (['LOW_GREEN', 'MEDIUM_GREEN', 'HIGH_GREEN', 'PLATINUM'] as const).map((band, i) => ({ activityKey: 'test-biz', band, year, m: BIZ_M[i], c: BIZ_C[year][i], status: 'VERIFIED_PRIMARY' })),
);
const ACCT: LocalizationDecisionRow = {
  id: 'acct',
  groupNameAr: 'مهن المحاسبة',
  occupationsJson: JSON.stringify(['محاسب']),
  phasesJson: JSON.stringify([{ pct: 40, effectiveFrom: '2025-10-27' }]),
  minEstablishmentSize: 5,
  minWage: 6000,
  status: 'VERIFIED_PRIMARY',
};

const saudi = (over: Partial<WfEmployeeInput> = {}) => emp({ nationality: 'سعودي', basicSalary: 5000, qiwaContractDocumented: true, joinDate: d('2024-01-01'), gosiRegime: 'OLD', ...over });
const expat = (over: Partial<WfEmployeeInput> = {}) => emp({ nationality: 'هندي', basicSalary: 3000, joinDate: d('2024-01-01'), gosiRegime: null, ...over });
const many = (n: number, f: (i: number) => WfEmployeeInput) => Array.from({ length: n }, (_, i) => f(i));

function input(employees: WfEmployeeInput[], candidates: HireCandidate[], over: Partial<HireScenarioInput> = {}): HireScenarioInput {
  return {
    company: COMPANY,
    companyEmployees: employees,
    nitaqat: { activity: BIZ, curves: BIZ_CURVES },
    decisions: [ACCT],
    rules: SEED_RULES,
    gosiRates: SEED_GOSI,
    assumptions: [],
    startMonth: '2026-10',
    candidates,
    ...over,
  };
}

const SAUDI_F: HireCandidate = { kind: 'SAUDI', basicSalary: 6000, gender: 'FEMALE', city: 'أبها', occupationName: 'محاسب' };
const EXPAT_C: HireCandidate = { kind: 'EXPAT', basicSalary: 3000, occupationName: 'محاسب', nationality: 'مصري' };

describe('hireScenario', () => {
  it('Saudi / expat numbers equal a direct computeTrueCost of the same hypothetical employee', () => {
    const emps = [...many(4, () => saudi()), ...many(6, () => expat())];
    const r = hireScenario(input(emps, [SAUDI_F, EXPAT_C]));
    r.candidates.forEach((c, i) => {
      const e = candidateEmployee([SAUDI_F, EXPAT_C][i], i, 'c1', d('2026-10-01'));
      const tc = computeTrueCost({ employees: [...emps, e], companies: [COMPANY], rules: SEED_RULES, gosiRates: SEED_GOSI, assumptions: [] }, { startMonth: '2026-10', months: 36, employeeIds: [e.id] });
      const t = tc.employees[0].totals;
      expect(c.windows[12]).toMatchObject(t.next12);
      expect(c.windows[24]).toMatchObject(t.next24);
      expect(c.windows[36]).toMatchObject(t.next36);
      expect(c.firstMonthCost).toBe(t.month1.cost);
    });
    expect(r.candidates[0].employeeId).toBe('candidate-1');
  });

  it('HRDF net: female, outside the major cities, 6,000 -> 50% capped at 3,000 from the 4th month', () => {
    const r = hireScenario(input([...many(4, () => saudi()), ...many(6, () => expat())], [SAUDI_F]));
    const w = r.candidates[0].windows;
    // Join 2026-10: support 2027-01 .. 2028-12. 12 m: 9 × 3,000; 24 m: 21 × 3,000; 36 m: 24 × 3,000.
    expect(w[12].subsidy).toBe(-27000);
    expect(w[24].subsidy).toBe(-63000);
    expect(w[36].subsidy).toBe(-72000);
    expect(w[12].net).toBeCloseTo(w[12].cost - 27000, 2);
  });

  it('levy tiers: a Saudi moves one expat from 800 to 700; an expat pays 800 himself', () => {
    // 2 Saudis + 3 expats (5 workers; owner assumption not entered -> no exemption): 700, 700, 800.
    const emps = [...many(2, () => saudi()), ...many(3, () => expat())];
    const r = hireScenario(input(emps, [SAUDI_F, EXPAT_C]));
    expect(r.candidates[0].levy).toMatchObject({ ownFirstMonth: 0, othersFirstMonth: -100 });
    expect(r.candidates[0].windows[12].levyOthers).toBe(-1200);
    expect(r.candidates[0].windows[12].total).toBeCloseTo(r.candidates[0].windows[12].net - 1200, 2);
    expect(r.candidates[1].levy).toMatchObject({ ownFirstMonth: 800, othersFirstMonth: 0 });
  });

  it('levy tiers: the 10th worker ends the small-establishment exemption for the others', () => {
    // 1 Saudi + 8 expats, owner full time: 9 workers -> 4 exempt, then 700 + 3 × 800 = 3,100.
    // With a 9th expat: 10 workers, no exemption: 700 + 8 × 800 = 7,100; the candidate pays 800 (last).
    // Others: 7,100 − 3,100 − 800 = +3,200 a month.
    const emps = [saudi(), ...many(8, () => expat())];
    const r = hireScenario(input(emps, [EXPAT_C], { assumptions: [assume('OWNER_FULL_TIME', 1)] }));
    expect(r.candidates[0].levy).toMatchObject({ ownFirstMonth: 800, othersFirstMonth: 3200 });
    expect(r.candidates[0].windows[12].levyOthers).toBe(38400);
    expect(r.candidates[0].levy.tierNote).toMatch(/إعفاء المنشأة الصغيرة/);
  });

  it('Nitaqat before / after (documented contract assumed) and localization of the occupation', () => {
    // 4 Saudis + 6 expats = 40% LOW. Saudi: 5/11 = 45.45% >= MED(11) 45.09 -> MEDIUM. Expat: 4/11 = 36.36 >= LOW(11) 36.25.
    const emps = [saudi({ occupationName: 'محاسب', basicSalary: 7000 }), ...many(3, () => saudi()), ...many(4, () => expat({ occupationName: 'محاسب' })), ...many(2, () => expat())];
    const r = hireScenario(input(emps, [SAUDI_F, EXPAT_C]));
    const [s, e] = r.candidates;
    expect(s.nitaqat).toMatchObject({ status: 'OK', before: { pct: 40, band: 'LOW_GREEN', x: 10 }, after: { pct: 45.45, band: 'MEDIUM_GREEN', x: 11 }, candidateWeight: 1, bandChanged: true });
    expect(e.nitaqat).toMatchObject({ status: 'OK', after: { pct: 36.36, band: 'LOW_GREEN' }, candidateWeight: 0, bandChanged: false });
    // Accounting 40%: 5 accountants, 1 Saudi counted, required round(2) = 2. Saudi at 6,000: 6 workers,
    // 2 counted, required round(2.4) = 2 -> compliant. Expat: 6 workers, 1 counted -> still short.
    expect(s.localization[0]).toMatchObject({ requiredPct: 40, before: { compliant: false, total: 5 }, after: { compliant: true, total: 6 }, candidateCounted: true });
    expect(e.localization[0]).toMatchObject({ after: { compliant: false, shortfallReplacements: 1 }, candidateCounted: false });
    expect(r.nitaqatBefore).toMatchObject({ status: 'OK', band: 'LOW_GREEN' });
  });

  it('overtime (payroll hourly, capacity) and outsourcing (quote)', () => {
    const r = hireScenario(
      input(
        [...many(4, () => saudi())],
        [
          { kind: 'OVERTIME', overtimeHoursPerMonth: 20, basicSalary: 6000 },
          { kind: 'OVERTIME', overtimeHoursPerMonth: 70, basicSalary: 6000 },
          { kind: 'OUTSOURCING', monthlyQuote: 5000 },
        ],
      ),
    );
    const [ot, ot70, out] = r.candidates;
    // 6,000 / (30 × 8) = 25 × 1.5 = 37.5 × 20 h = 750 a month.
    expect(ot.firstMonthCost).toBe(750);
    expect(ot.windows[12]).toMatchObject({ cost: 9000, net: 9000, total: 9000 });
    expect(ot.capacity).toMatchObject({ hoursPerYear: 240, capHours: 720, overCap: false });
    expect(ot70.capacity).toMatchObject({ hoursPerYear: 840, overCap: true });
    expect(out.windows[36].total).toBe(180000);
    expect(out.nitaqat.status).toBe('NOT_APPLICABLE');
  });

  it('deterministic', () => {
    const emps = [...many(4, () => saudi()), ...many(6, () => expat())];
    const a = hireScenario(input(emps, [SAUDI_F, EXPAT_C, { kind: 'OUTSOURCING', monthlyQuote: 4000 }]));
    const b = hireScenario(input([...emps].reverse(), [SAUDI_F, EXPAT_C, { kind: 'OUTSOURCING', monthlyQuote: 4000 }]));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});
