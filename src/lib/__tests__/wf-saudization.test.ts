// Saudization planner (src/lib/workforce/saudization.ts): the band solver (minimality, documentation
// first, raises and their pruning, replacements, costs = the true cost engine) and occupation
// localization compliance (matching in Arabic / English / codes, phases, size ranges, variants,
// half-up rounding, shortfalls). Hand-computed expectations in the comments. Curves = test fixtures.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bandForCounts, curveSetFor, type NitaqatActivityRow, type NitaqatCurveRow, type NitaqatEntityInput } from '@/lib/workforce/nitaqat';
import {
  hypotheticalSaudi,
  localizationCompliance,
  localizationShortfall,
  normalizeOccupation,
  parseDecision,
  phaseOn,
  requiredSaudis,
  restrictSolve,
  solveToBand,
  type LocalizationDecisionRow,
} from '@/lib/workforce/saudization';
import { restrictFlags } from '@/lib/workforce/nitaqat';
import { computeTrueCost } from '@/lib/workforce/true-cost';
import type { WfEmployeeInput } from '@/lib/workforce';
import { COMPANY, SEED_GOSI, SEED_RULES, d, emp } from './wf-fixtures';

// Business services constants verified from the guide annex (TEST FIXTURES, not seed data).
const BIZ: NitaqatActivityRow = { key: 'test-biz', nameAr: 'خدمات الاعمال', code: '481', status: 'VERIFIED_PRIMARY', page: 14 };
const BIZ_M = [1.03, 1.03, 2.19, 2.19];
const BIZ_C: Record<number, number[]> = { 2026: [33.78, 42.62, 43.62, 54.82], 2027: [36.78, 45.62, 46.62, 57.82], 2028: [39.78, 48.62, 49.62, 60.82] };
const BIZ_CURVES: NitaqatCurveRow[] = [2026, 2027, 2028].flatMap((year) =>
  (['LOW_GREEN', 'MEDIUM_GREEN', 'HIGH_GREEN', 'PLATINUM'] as const).map((band, i) => ({ activityKey: 'test-biz', band, year, m: BIZ_M[i], c: BIZ_C[year][i], status: 'VERIFIED_PRIMARY' })),
);

const DATE = d('2026-09-26');
const saudi = (over: Partial<WfEmployeeInput> = {}) => emp({ nationality: 'سعودي', basicSalary: 5000, qiwaContractDocumented: true, joinDate: d('2024-01-01'), gosiRegime: 'OLD', ...over });
const expat = (over: Partial<WfEmployeeInput> = {}) => emp({ nationality: 'هندي', basicSalary: 3000, joinDate: d('2024-01-01'), gosiRegime: null, ...over });
const many = (n: number, f: (i: number) => WfEmployeeInput) => Array.from({ length: n }, (_, i) => f(i));
const entity = (employees: WfEmployeeInput[]): NitaqatEntityInput => ({ companyId: 'c1', companyName: 'شركة', activity: BIZ, curves: BIZ_CURVES, employees });
const cost = { company: COMPANY, rules: SEED_RULES, gosiRates: SEED_GOSI, assumptions: [], months: 12 };

describe('solveToBand', () => {
  const base = () => [...many(4, () => saudi()), ...many(6, () => expat())]; // 40%, LOW_GREEN (X = 10)

  it('minimum hires: MEDIUM needs 1, HIGH needs 2 (and one fewer does not reach)', () => {
    const med = solveToBand({ entity: entity(base()), targetBand: 'MEDIUM_GREEN', byDate: DATE });
    expect(med).toMatchObject({ status: 'OK', hires: 1, documentations: 0, raises: 0 });
    expect(med.after).toMatchObject({ band: 'MEDIUM_GREEN', pct: 45.45 });
    const high = solveToBand({ entity: entity(base()), targetBand: 'HIGH_GREEN', byDate: DATE });
    // k = 1: 5/11 = 45.45 < HIGH(11) 48.87; k = 2: 6/12 = 50% >= HIGH(12) = 2.19 ln 12 + 43.62 = 49.06.
    expect(high.hires).toBe(2);
    const set = curveSetFor(BIZ_CURVES, 'test-biz', 2026);
    expect(bandForCounts(5, 6, 11, set).band).not.toBe('HIGH_GREEN');
    expect(bandForCounts(6, 6, 12, set).band).toBe('HIGH_GREEN');
    expect(high.actions).toHaveLength(1);
    expect(high.actions[0]).toMatchObject({ kind: 'HIRE', count: 2, weightGain: 2, bandAfter: 'HIGH_GREEN' });
  });

  it('already reached / no activity', () => {
    expect(solveToBand({ entity: entity(base()), targetBand: 'LOW_GREEN', byDate: DATE }).status).toBe('ALREADY_REACHED');
    expect(solveToBand({ entity: { ...entity(base()), activity: null }, targetBand: 'LOW_GREEN', byDate: DATE }).status).toBe('NO_ACTIVITY');
  });

  it('documentation first (zero cost) replaces a hire', () => {
    // 3 documented + 1 undocumented Saudi + 6 expats: X = 9, 3/9 = 33.33% < LOW(9) 36.04 -> RED.
    const emps = [...many(3, () => saudi()), saudi({ id: 'undoc', name: 'غير موثق', qiwaContractDocumented: false }), ...many(6, () => expat())];
    const low = solveToBand({ entity: entity(emps), targetBand: 'LOW_GREEN', byDate: DATE });
    expect(low).toMatchObject({ hires: 0, documentations: 1 });
    expect(low.actions[0]).toMatchObject({ kind: 'DOCUMENT', employeeId: 'undoc', weightGain: 1, pctAfter: 40, bandAfter: 'LOW_GREEN', monthlyCost: 0 });
    const noDoc = solveToBand({ entity: entity(emps), targetBand: 'LOW_GREEN', byDate: DATE, options: { documentFirst: false } });
    // Without documenting: k = 1: 4/10 = 40% >= LOW(10) 36.15 -> 1 hire.
    expect(noDoc).toMatchObject({ hires: 1, documentations: 0 });
  });

  it('raises 3,000–3,999 -> 4,000 before hires; unnecessary raises are pruned', () => {
    // 3 Saudis at 5,000 + 2 at 3,500 (0.5 each) + 6 expats: S = 4, X = 11, 40% (LOW).
    const emps = () => [...many(3, () => saudi()), saudi({ id: 'r1', basicSalary: 3500 }), saudi({ id: 'r2', basicSalary: 3500 }), ...many(6, () => expat())];
    // MEDIUM(11) = 45.09: one raise -> 4.5 / 10.5 = 42.86 no; two -> 5 / 11 = 45.45 yes. 0 hires.
    const med = solveToBand({ entity: entity(emps()), targetBand: 'MEDIUM_GREEN', byDate: DATE });
    expect(med).toMatchObject({ hires: 0, raises: 2 });
    expect(med.actions.map((a) => [a.kind, a.employeeId, a.weightGain])).toEqual([
      ['RAISE', 'r1', 0.5],
      ['RAISE', 'r2', 0.5],
    ]);
    // HIGH: both raises + 1 hire: 6 / 12 = 50% >= HIGH(12) 49.06; one raise + 1 hire: 5.5 / 11.5 = 47.83 no.
    const high = solveToBand({ entity: entity(emps()), targetBand: 'HIGH_GREEN', byDate: DATE });
    expect(high).toMatchObject({ hires: 1, raises: 2 });
    // Without raises: 2 hires (5 + ... : k = 2 -> 6 / 12 = 50% >= HIGH(13) 49.24).
    expect(solveToBand({ entity: entity(emps()), targetBand: 'HIGH_GREEN', byDate: DATE, options: { raiseHalfWeight: false } }).hires).toBe(2);
    // PLATINUM(X) needs many hires: the raises are no longer needed with that number of hires and are pruned
    // only when the band is still reached without them.
    const plat = solveToBand({ entity: entity(emps()), targetBand: 'PLATINUM', byDate: DATE });
    const platNoRaise = solveToBand({ entity: entity(emps()), targetBand: 'PLATINUM', byDate: DATE, options: { raiseHalfWeight: false } });
    expect(plat.hires!).toBeLessThanOrEqual(platNoRaise.hires!);
    for (const r of [plat]) {
      // Minimality: one hire fewer (with the kept raises) does not reach the band.
      const kept = new Set(r.actions.filter((a) => a.kind === 'RAISE').map((a) => a.employeeId));
      const raised = emps().map((e) => (kept.has(e.id) ? { ...e, basicSalary: 4000 } : e));
      const hires = (k: number) => Array.from({ length: k }, (_, i) => hypotheticalSaudi(`h${i}`, 'h', 'c1', d('2026-09-01')));
      const band = (k: number) => solveToBand({ entity: entity([...raised, ...hires(k)]), targetBand: 'PLATINUM', byDate: DATE, options: { raiseHalfWeight: false, documentFirst: false } });
      expect(band(r.hires!).status).toBe('ALREADY_REACHED');
      expect(band(r.hires! - 1).status).toBe('OK');
    }
  });

  it('replacement alternative: HIGH with 1 replacement (5 / 10 = 50% >= HIGH(10) 48.66)', () => {
    const r = solveToBand({ entity: entity(base()), targetBand: 'HIGH_GREEN', byDate: DATE, options: { replaceExpats: true } });
    expect(r.hires).toBe(2);
    expect(r.alternative!.replacements).toBe(1);
    expect(r.alternative!.after).toMatchObject({ band: 'HIGH_GREEN', pct: 50, x: 10 });
  });

  it('hire cost = the true cost engine for the same hypothetical Saudi (NEW regime, HRDF, levy tier)', () => {
    const emps = base();
    const r = solveToBand({ entity: entity(emps), targetBand: 'MEDIUM_GREEN', byDate: DATE, cost });
    const hire = hypotheticalSaudi('plan-hire-0001', 'x', 'c1', d('2026-09-01'));
    const input = { employees: [...emps, hire], companies: [COMPANY], rules: SEED_RULES, gosiRates: SEED_GOSI, assumptions: [] };
    const tc = computeTrueCost(input, { startMonth: '2026-09', months: 12, employeeIds: [hire.id] });
    const noHire = computeTrueCost({ ...input, employees: emps }, { startMonth: '2026-09', months: 12, employeeIds: [] });
    const levy = (t: typeof tc) => t.companies.find((c) => c.companyId === 'c1')!.months.reduce((s, m) => s + m.levyTotal, 0);
    // 4 Saudis, 6 expats: 4 at 700 + 2 at 800 = 4,400; with a 5th Saudi: 5 × 700 + 800 = 4,300 -> −100 / month.
    expect(levy(tc) - levy(noHire)).toBe(-1200);
    const expected = Math.round(((tc.employees[0].totals.horizon.net - 1200) / 12) * 100) / 100;
    expect(r.actions[0].monthlyNetAvg).toBeCloseTo(expected, 2);
    expect(r.actions[0].monthlyCost).toBeCloseTo(tc.employees[0].totals.month1.cost - 100, 2);
    expect(r.hireProfile).toMatchObject({ basic: 4000, gosiWage: 4000, regime: 'NEW' });
  });

  it('raise cost = the true cost engine COST delta (useless raises pruned even without hires)', () => {
    const emps = [...many(3, () => saudi()), saudi({ id: 'r1', basicSalary: 3500 }), saudi({ id: 'r2', basicSalary: 3500 }), ...many(6, () => expat())];
    const r = solveToBand({ entity: entity(emps), targetBand: 'MEDIUM_GREEN', byDate: DATE, cost });
    const a1 = r.actions.find((a) => a.employeeId === 'r1')!;
    const run = (list: WfEmployeeInput[]) => computeTrueCost({ employees: list, companies: [COMPANY], rules: SEED_RULES, gosiRates: SEED_GOSI, assumptions: [] }, { startMonth: '2026-09', months: 12, employeeIds: ['r1'] }).employees[0];
    const before = run(emps);
    const after = run(emps.map((e) => (e.id === 'r1' ? { ...e, basicSalary: 4000 } : e)));
    expect(a1.monthlyCost).toBeCloseTo(after.totals.month1.cost - before.totals.month1.cost, 2);
    // Cost only (review fix P2-1): no HRDF change is part of a raise's cost.
    expect(a1.monthlyNetAvg).toBeCloseTo((after.totals.horizon.cost - before.totals.horizon.cost) / 12, 2);
    // A disabled Saudi at 3,500 already counts 1; raising him is refused by the combined cap here (base 5:
    // floor(0.75) = 0): the raise adds nothing and is pruned.
    const withDisabled = [...many(3, () => saudi()), saudi({ id: 'd1', basicSalary: 3500, isDisabled: true }), saudi({ id: 'r2', basicSalary: 3500 }), ...many(6, () => expat())];
    const r2 = solveToBand({ entity: entity(withDisabled), targetBand: 'MEDIUM_GREEN', byDate: DATE });
    expect(r2.actions.map((a) => a.employeeId)).toEqual(['r2']);
  });

  it('a disabled raise that is needed is merged (no name / id) in the restricted view', () => {
    // 10 Saudis + d1 (disabled, 3,500 -> counts 1) + 10 expats: S = 11, X = 21, 52.38% (HIGH).
    // PLATINUM(21) = 2.19 ln 21 + 54.82 = 61.49. Raise d1 -> 4 (own cap floor(2.2) = 2, combined
    // floor(1.65) = 1): S = 14; hires k: k = 2 -> 16/26 = 61.54 < 61.69; k = 3 -> 17/27 = 62.96 >= 61.78.
    // Without the raise 6 hires would be needed (k = 6: 17/27 = 62.96 >= 62.04).
    const emps = [...many(10, () => saudi()), saudi({ id: 'd1', name: 'موظف مرجّح', basicSalary: 3500, isDisabled: true }), ...many(10, () => expat())];
    const r = solveToBand({ entity: entity(emps), targetBand: 'PLATINUM', byDate: DATE });
    expect(r).toMatchObject({ raises: 1, hires: 3 });
    expect(r.actions[0]).toMatchObject({ kind: 'RAISE', employeeId: 'd1', weightGain: 3, sensitive: true });
    expect(solveToBand({ entity: entity(emps), targetBand: 'PLATINUM', byDate: DATE, options: { raiseHalfWeight: false } }).hires).toBe(6);
    const restricted = restrictSolve(r, restrictFlags);
    expect(JSON.stringify(restricted.actions)).not.toMatch(/d1|موظف مرجّح/);
    // Review fix P2-2: no per-line weight (the +3 would single out the disabled employee).
    expect(restricted.actions[0]).toMatchObject({ kind: 'RAISE', employeeId: null, name: null, count: 1, weightGain: null, pctAfter: null, bandAfter: null });
  });

  it('deterministic', () => {
    const list = base();
    const a = solveToBand({ entity: entity(list), targetBand: 'PLATINUM', byDate: DATE, options: { replaceExpats: true }, cost });
    const b = solveToBand({ entity: entity([...list].reverse()), targetBand: 'PLATINUM', byDate: DATE, options: { replaceExpats: true }, cost });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

// ---------------------------------------------------------------------------

const ACCT: LocalizationDecisionRow = {
  id: 'acct',
  groupNameAr: 'مهن المحاسبة',
  occupationsJson: JSON.stringify([{ code: '2622011', nameEn: 'General Accountant', nameAr: null }, { code: null, nameAr: 'محاسب' }]),
  phasesJson: JSON.stringify([
    { pct: 40, effectiveFrom: '2025-10-27', minWorkers: 5 },
    { pct: 50, effectiveFrom: '2026-10-27', minWorkers: 5 },
    { pct: 30, effectiveFrom: '2029-10-27', minWorkers: 3, maxWorkers: 4 },
  ]),
  minEstablishmentSize: 5,
  minWage: 6000,
  status: 'VERIFIED_PRIMARY',
};

describe('localization', () => {
  it('normalization, matching by Arabic / English / code', () => {
    expect(normalizeOccupation('المحاسب')).toBe(normalizeOccupation('محاسب'));
    expect(normalizeOccupation('  General   ACCOUNTANT ')).toBe('general accountant');
  });

  it('rounding half up and shortfalls', () => {
    expect(requiredSaudis(23, 40)).toBe(9); // 9.2
    expect(requiredSaudis(23, 50)).toBe(12); // 11.5
    expect(localizationShortfall(2, 7, 40)).toEqual({ required: 3, replacements: 1, hires: 1 });
    // 50% of 7 = 3.5 -> 4; hires: k = 3 -> 5 >= round(5) = 5.
    expect(localizationShortfall(2, 7, 50)).toEqual({ required: 4, replacements: 2, hires: 3 });
    expect(localizationShortfall(1, 3, 100)).toEqual({ required: 3, replacements: 2, hires: null });
  });

  const staff = () => [
    saudi({ id: 'a1', occupationName: 'محاسب', basicSalary: 7000 }),
    saudi({ id: 'a2', occupationName: 'المحاسب', basicSalary: 6000 }),
    saudi({ id: 'a3', occupationName: 'محاسب', basicSalary: 5000 }), // below 6,000
    saudi({ id: 'a4', occupationName: 'محاسب', basicSalary: 9000, qiwaContractDocumented: false }),
    expat({ id: 'a5', occupationCode: '2622011' }),
    expat({ id: 'a6', occupationName: 'General Accountant' }),
    expat({ id: 'a7', occupationName: 'محاسب' }),
    expat({ id: 'x1', occupationName: 'سائق' }),
    expat({ id: 'x2' }), // no occupation
  ];

  it('phase in force, counted Saudis, required heads, upcoming phases, unknown occupations', () => {
    const r = localizationCompliance({ companyId: 'c1', employees: staff(), decisions: [ACCT] }, DATE);
    const it0 = r.items[0];
    // 7 in the occupations; counted Saudis: a1, a2 (a3 below the wage, a4 undocumented). 40% × 7 = 2.8 -> 3.
    expect(it0).toMatchObject({ total: 7, saudisCounted: 2, saudisBelowMinWage: 1, saudisUndocumented: 1, requiredPct: 40, requiredSaudis: 3, compliant: false, shortfallReplacements: 1, shortfallHires: 1, applies: true });
    expect(it0.actualPct).toBeCloseTo(28.57, 2);
    expect(it0.upcoming.map((u) => [u.pct, u.effectiveFrom, u.monthsAway])).toEqual([[50, '2026-10-27', 1]]);
    expect(r.unknownOccupation).toMatchObject({ count: 1, employees: [{ id: 'x2' }] });
    // From 2026-10-27: 50% -> 4 required.
    const nov = localizationCompliance({ companyId: 'c1', employees: staff(), decisions: [ACCT] }, d('2026-11-01')).items[0];
    expect(nov).toMatchObject({ requiredPct: 50, requiredSaudis: 4, shortfallReplacements: 2, shortfallHires: 3 });
  });

  it('size ranges: 4 workers -> not applicable in 2026, the 3–4 phase applies from 2029-10-27', () => {
    const four = staff().filter((e) => ['a1', 'a2', 'a5', 'a6'].includes(e.id));
    const now = localizationCompliance({ companyId: 'c1', employees: four, decisions: [ACCT] }, DATE).items[0];
    expect(now).toMatchObject({ applies: false, compliant: null, total: 4 });
    expect(now.appliesReason).toMatch(/أقل من الحد الأدنى/);
    const later = localizationCompliance({ companyId: 'c1', employees: four, decisions: [ACCT] }, d('2029-11-01')).items[0];
    // 30% × 4 = 1.2 -> 1 required; 2 counted -> compliant.
    expect(later).toMatchObject({ applies: true, requiredPct: 30, requiredSaudis: 1, compliant: true });
  });

  it('activity variants: the variant without activity codes is used, the others listed', () => {
    const pharm = parseDecision({
      id: 'ph',
      groupNameAr: 'مهن الصيدلة',
      occupationsJson: '["صيدلي"]',
      phasesJson: JSON.stringify([
        { pct: 35, effectiveFrom: '2025-07-27', activity: 'الصيدليات', activityCodes: ['477211'] },
        { pct: 65, effectiveFrom: '2025-07-27', activity: 'المستشفيات', activityCodes: ['861011'] },
        { pct: 55, effectiveFrom: '2025-07-27', activity: 'باقي الأنشطة', activityCodes: [] },
      ]),
      minEstablishmentSize: 5,
      status: 'VERIFIED_PRIMARY',
    });
    const p = phaseOn(pharm.phases, '2026-09-26', 10, 5)!;
    expect(p.phase.pct).toBe(55);
    expect(p.variants.map((v) => v.pct).sort()).toEqual([35, 65]);
  });

  it('invalid JSON is reported, not thrown', () => {
    const bad = parseDecision({ id: 'b', groupNameAr: 'x', occupationsJson: '{', phasesJson: 'nope', status: 'PROVISIONAL' });
    expect(bad.parseError).toMatch(/JSON/);
    expect(bad.phases).toEqual([]);
  });
});

describe('seed script (dry-run, no database)', () => {
  it('builds activities (slug keys + prefix), 3 curve years per band, decisions with phase ranges', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-seed-'));
    const file = path.join(dir, 'in.json');
    const rows = ['LOW_GREEN', 'MEDIUM_GREEN', 'HIGH_GREEN', 'PLATINUM'].map((band, i) => ({ activityNameAr: 'خدمات الأعمال', activityCode: '481', sizeSegment: null, band, m: i < 2 ? 1.03 : 2.19, c2026: 33.78 + i, c2027: 36.78 + i, c2028: 39.78 + i, page: 14, confidence: i === 3 ? 'MEDIUM' : 'HIGH', note: 'fixture' }));
    const decisions = [
      {
        groupNameAr: 'مهن المحاسبة',
        occupations: [{ code: '2622011', nameEn: 'General Accountant', nameAr: null }],
        phases: [
          { pct: 40, effectiveFrom: '2025-10-27', appliesTo: 'establishments with >=5 workers' },
          { pct: 30, effectiveFrom: '2029-10-27', appliesTo: 'establishments with 3 or 4 workers in accounting professions' },
        ],
        minEstablishmentSize: 5,
        minWage: { bachelor: 6000, diploma: 4500 },
        decisionNo: '103108',
        decisionDate: '2025-01-26',
        status: 'VERIFIED_PRIMARY',
        page: 'p1, p9',
      },
    ];
    fs.writeFileSync(file, JSON.stringify({ curves: rows, decisions, source: { url: 'https://example.test/guide.pdf' } }));
    const out = execFileSync(process.execPath, [path.resolve('scripts/seed-nitaqat.mjs'), file, '--no-db', '--json', '--key-prefix', 'test-'], { encoding: 'utf8' });
    const s = JSON.parse(out);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(s.mode).toBe('dry-run (no db)');
    expect(s.activities).toMatchObject({ total: 1, ambiguous: 1 }); // one MEDIUM-confidence row -> AMBIGUOUS
    expect(s.keys).toEqual([{ key: 'test-خدمات-الاعمال', code: '481', status: 'AMBIGUOUS' }]);
    expect(s.curves.total).toBe(12);
    expect(s.decisionIds).toEqual(['test-loc-مهن-المحاسبه-103108']);
    expect(s.errors).toEqual([]);
  });
});
