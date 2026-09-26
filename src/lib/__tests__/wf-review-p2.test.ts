// Independent review of Phase 2 (Workforce Decision Engine), verified findings:
// P2-1 HRDF eligibility frozen at the application window (no phantom subsidy on a raise; the solver's
//      raise cost is the COST delta only);
// P2-2 no per-person weight for a viewer who may not see disability (solver lines, estimate breakdown,
//      documentation weight);
// P2-3 the ≤5 rule evidence split into the verified rule and the provisional weight interpretation;
// P2-4 seed script: canonical files by default, create-only, DIFFERS report, --force-update;
// P2-5 explicit rounding of the localization head count.
// Hand-computed expectations in the comments.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { nitaqatEstimate, restrictEstimate, restrictFlags, type NitaqatActivityRow, type NitaqatCurveRow, type NitaqatEntityInput } from '@/lib/workforce/nitaqat';
import { requiredSaudisText, restrictSolve, solveToBand } from '@/lib/workforce/saudization';
import { computeTrueCost } from '@/lib/workforce/true-cost';
import type { TrueCostResult, WfEmployeeInput } from '@/lib/workforce';
import { COMPANY, SEED_GOSI, SEED_RULES, d, emp } from './wf-fixtures';

const run = (employees: WfEmployeeInput[], startMonth = '2026-09', months = 12): TrueCostResult =>
  computeTrueCost({ employees, companies: [COMPANY], rules: SEED_RULES, gosiRates: SEED_GOSI, assumptions: [] }, { startMonth, months });
const hrdfMonths = (r: TrueCostResult, id: string) =>
  r.employees.find((e) => e.employeeId === id)!.months.filter((m) => m.lines.some((l) => l.key === 'HRDF_SUBSIDY')).map((m) => m.month);
const hrdfAmount = (r: TrueCostResult, id: string, month: string) =>
  r.employees.find((e) => e.employeeId === id)!.months.find((m) => m.month === month)!.lines.find((l) => l.key === 'HRDF_SUBSIDY')?.amount;

// ---------------------------------------------------------------------------
// P2-1 HRDF application window
// ---------------------------------------------------------------------------

describe('P2-1 HRDF eligibility is decided once, in the application window (months 4–6)', () => {
  it('hired 2025-01 at 3,500, raised to 4,000 in the horizon: no subsidy (window 2025-04..06 was below 4,000)', () => {
    const planned = emp({ id: 'h1', joinDate: d('2025-01-01'), basicSalary: 3500, salaryChanges: [{ effectiveDate: d('2026-09-01'), basicSalary: 4000, isPlanned: true }] });
    expect(hrdfMonths(run([planned]), 'h1')).toEqual([]);
    // Same with a disabled employee (who would get +10%).
    const dis = emp({ id: 'h2', joinDate: d('2025-01-01'), basicSalary: 3500, isDisabled: true, salaryChanges: [{ effectiveDate: d('2026-09-01'), basicSalary: 4000, isPlanned: true }] });
    expect(hrdfMonths(run([dis]), 'h2')).toEqual([]);
  });

  it('a raise inside the window qualifies from that month; a raise after the window does not', () => {
    // Joined 2026-07: window = 2026-10 (k 3), 11, 12. Raised to 4,000 on 2026-11-01 -> eligible from 2026-11.
    const inWindow = emp({ id: 'w1', joinDate: d('2026-07-01'), basicSalary: 3500, salaryChanges: [{ effectiveDate: d('2026-11-01'), basicSalary: 4000, isPlanned: true }] });
    // Joined 2026-03: window = 2026-06..08 at 3,500. Raised on 2026-09-01 (k 6): never eligible.
    const afterWindow = emp({ id: 'w2', joinDate: d('2026-03-01'), basicSalary: 3500, salaryChanges: [{ effectiveDate: d('2026-09-01'), basicSalary: 4000, isPlanned: true }] });
    const r = run([inWindow, afterWindow]);
    const m1 = hrdfMonths(r, 'w1');
    expect(m1[0]).toBe('2026-11');
    expect(m1).toHaveLength(10); // 2026-11 .. 2027-08 (horizon end)
    expect(hrdfAmount(r, 'w1', '2026-11')).toBe(-1200); // 30% × 4,000 (Riyadh, male)
    expect(hrdfMonths(r, 'w2')).toEqual([]);
  });

  it('eligible in the window: the amount follows the actual wage later (caps), eligibility is not re-checked', () => {
    // Joined 2026-06 at 5,000: window 2026-09 qualifies. Raised to 20,000 (above the 15,000 band) in 2027-01:
    // still supported, capped at 3,000 (30% × 20,000 = 6,000 -> 3,000).
    const e = emp({ id: 'a1', joinDate: d('2026-06-01'), basicSalary: 5000, salaryChanges: [{ effectiveDate: d('2027-01-01'), basicSalary: 20000, isPlanned: true }] });
    const r = run([e]);
    expect(hrdfAmount(r, 'a1', '2026-09')).toBe(-1500);
    expect(hrdfAmount(r, 'a1', '2027-01')).toBe(-3000);
  });

  it('window before the horizon: salary history decides; unknown history -> no subsidy + flag', () => {
    // Joined 2025-06 (window 2025-09..11). Current basic 5,000.
    // (a) no change recorded: the current basic is the window wage -> eligible (k 15 in 2026-09).
    const a = emp({ id: 'ha', joinDate: d('2025-06-01'), basicSalary: 5000 });
    // (b) raised from an unknown wage to 5,000 on 2026-01 (after the window), nothing earlier: unknown.
    const b = emp({ id: 'hb', joinDate: d('2025-06-01'), basicSalary: 5000, salaryChanges: [{ effectiveDate: d('2026-01-01'), basicSalary: 5000, isPlanned: false }] });
    // (c) a change on 2025-06-01 to 3,500 (the window wage), then 5,000 on 2026-01: not eligible.
    const c = emp({ id: 'hc', joinDate: d('2025-06-01'), basicSalary: 5000, salaryChanges: [{ effectiveDate: d('2025-06-01'), basicSalary: 3500, isPlanned: false }, { effectiveDate: d('2026-01-01'), basicSalary: 5000, isPlanned: false }] });
    const r = run([a, b, c]);
    expect(hrdfAmount(r, 'ha', '2026-09')).toBe(-1500);
    expect(hrdfMonths(r, 'hb')).toEqual([]);
    expect(r.employees.find((x) => x.employeeId === 'hb')!.flags.some((f) => f.code === 'HRDF_WINDOW_WAGE_UNKNOWN')).toBe(true);
    expect(hrdfMonths(r, 'hc')).toEqual([]);
    expect(r.employees.find((x) => x.employeeId === 'hc')!.flags.some((f) => f.code === 'HRDF_WINDOW_WAGE_UNKNOWN')).toBe(false);
  });

  it('a hypothetical new hire keeps the subsidy (he applies in his own window)', () => {
    const hire = emp({ id: 'n1', joinDate: d('2026-09-01'), basicSalary: 4000, isPlanned: true, gosiRegime: 'NEW' });
    const m = hrdfMonths(run([hire]), 'n1');
    expect(m[0]).toBe('2026-12'); // month 4
  });
});

// ---------------------------------------------------------------------------
// Solver fixtures (business services 2026, test constants)
// ---------------------------------------------------------------------------

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

// Raise 3,500 -> 4,000 of a Saudi hired 2025-01 (OLD regime, < 5 years of service), per month:
// +500 basic + 11.75% × 500 = 58.75 GOSI + 500 × 0.5 / 12 = 20.83 EOSB accrual = 579.58.
const RAISE_COST = 579.58;

describe('P2-1 solver: a raise costs its cost delta, never a phantom HRDF saving', () => {
  it('company A: A-H1 hired 2025-01 at 3,500 -> 4,000 costs +579.58 / month (positive)', () => {
    // 3 Saudis + A-H1 (3,500: 0.5) + 6 expats: S = 3.5, X = 10, 36.84%; MEDIUM(10) = 1.03 ln 10 + 42.62 = 44.99%.
    // Raise -> S = 4: 40%; 1 hire: 5/11 = 45.45% >= MEDIUM(11) = 45.09%. Without the raise 4.5/10.5 = 42.86%
    // < 45.09%: the raise is kept (1 raise + 1 hire).
    const emps = [...many(3, () => saudi()), saudi({ id: 'A-H1', joinDate: d('2025-01-01'), basicSalary: 3500 }), ...many(6, () => expat())];
    const r = solveToBand({ entity: entity(emps), targetBand: 'MEDIUM_GREEN', byDate: DATE, cost });
    const a = r.actions.find((x) => x.employeeId === 'A-H1')!;
    expect(a.kind).toBe('RAISE');
    expect(a.monthlyCost).toBeCloseTo(RAISE_COST, 1);
    expect(a.monthlyNetAvg).toBeCloseTo(RAISE_COST, 1);
    expect(a.monthlyNetAvg!).toBeGreaterThan(0);
  });

  it('disabled at 3,500 (weight 1 -> 4 on the raise): the same positive cost', () => {
    // 10 Saudis + d1 (disabled, 3,500) + 10 expats, target PLATINUM: raise d1 + 3 hires (wf-saudization test).
    const emps = [...many(10, () => saudi()), saudi({ id: 'd1', joinDate: d('2025-01-01'), basicSalary: 3500, isDisabled: true }), ...many(10, () => expat())];
    const r = solveToBand({ entity: entity(emps), targetBand: 'PLATINUM', byDate: DATE, cost });
    const a = r.actions.find((x) => x.kind === 'RAISE')!;
    expect(a).toMatchObject({ employeeId: 'd1', weightGain: 3 });
    expect(a.monthlyCost).toBeCloseTo(RAISE_COST, 1);
    expect(a.monthlyNetAvg).toBeCloseTo(RAISE_COST, 1);
    // Hires keep their HRDF (net below cost from month 4).
    const h = r.actions.find((x) => x.kind === 'HIRE')!;
    expect(h.monthlyNetAvg!).toBeLessThan(h.monthlyCost!);
  });
});

// ---------------------------------------------------------------------------
// P2-2 privacy: finance repro (one disabled Saudi at 3,500, target PLATINUM)
// ---------------------------------------------------------------------------

describe('P2-2 no line reveals a single disabled employee to a viewer outside HR', () => {
  const emps = [...many(10, () => saudi()), saudi({ id: 'd1', name: 'موظف مرجّح', joinDate: d('2025-01-01'), basicSalary: 3500, isDisabled: true }), ...many(10, () => expat())];

  it('solver: raises merged without weight or percentage, hires without weight; alternative lines too', () => {
    const full = solveToBand({ entity: entity(emps), targetBand: 'PLATINUM', byDate: DATE, cost, options: { replaceExpats: true } });
    const r = restrictSolve(full, restrictFlags);
    expect(r.actions.map((a) => [a.kind, a.count, a.weightGain, a.pctAfter])).toEqual([
      ['RAISE', 1, null, null],
      ['HIRE', 3, null, full.after!.pct],
    ]);
    expect(r.actions[0].monthlyCost).toBeCloseTo(RAISE_COST, 1);
    for (const a of [...r.actions, ...(r.alternative?.actions ?? [])]) expect(a.weightGain).toBeNull();
    for (const a of r.alternative?.actions ?? []) expect(a.pctAfter).toBeNull();
    const json = JSON.stringify(r.actions);
    expect(json).not.toMatch(/d1|موظف مرجّح|"weightGain":\d/);
  });

  it('an ordinary raise gets the same restricted form (the form itself does not tell)', () => {
    const plain = [...many(10, () => saudi()), saudi({ id: 'p1', basicSalary: 3500 }), ...many(10, () => expat())];
    const r = restrictSolve(solveToBand({ entity: entity(plain), targetBand: 'HIGH_GREEN', byDate: DATE, cost }), restrictFlags);
    const raise = r.actions.find((a) => a.kind === 'RAISE');
    if (raise) expect(raise).toMatchObject({ employeeId: null, weightGain: null, pctAfter: null });
    for (const a of r.actions) expect(a.weightGain).toBeNull();
  });

  it('documentation merged without weight (one undocumented disabled Saudi would add +4)', () => {
    const list = [...many(10, () => saudi()), saudi({ id: 'u1', basicSalary: 5000, isDisabled: true, qiwaContractDocumented: false }), ...many(10, () => expat())];
    const full = solveToBand({ entity: entity(list), targetBand: 'PLATINUM', byDate: DATE, cost });
    expect(full.actions[0]).toMatchObject({ kind: 'DOCUMENT', employeeId: 'u1', weightGain: 4 });
    const r = restrictSolve(full, restrictFlags);
    expect(r.actions[0]).toMatchObject({ kind: 'DOCUMENT', count: 1, weightGain: null, pctAfter: null, bandAfter: null, employeeId: null });
    // Estimate: the undocumented flag carries no weight, no potential-weight field.
    const est = restrictEstimate(nitaqatEstimate(entity(list), DATE));
    const flag = est.flags.find((f) => f.code === 'UNDOCUMENTED_QIWA')!;
    expect(flag.message).not.toMatch(/يضيف/);
    expect(flag).not.toHaveProperty('restrictedMessage');
    expect(JSON.stringify(est)).not.toMatch(/undocumentedPotentialWeight/);
  });

  it('estimate: no special-categories row; one Saudi-side total that reconciles with the counts', () => {
    const full = nitaqatEstimate(entity(emps), DATE);
    const est = restrictEstimate(full);
    expect(est.breakdown.map((b) => b.weightClass)).toEqual(['SAUDI_TOTAL', 'EXPAT']);
    const total = est.breakdown[0];
    expect(total.persons).toBe(11);
    expect(total.weight).toBe(full.counts.saudiWeighted); // 10 + 1 (disabled below 4,000)
    expect(JSON.stringify(est.breakdown)).not.toMatch(/SPECIAL|DISABLED|إعاقة|مرجّحة خاصة/);
  });
});

// ---------------------------------------------------------------------------
// P2-3 small-entity evidence
// ---------------------------------------------------------------------------

describe('P2-3 the ≤5 rule: verified rule + provisional weight interpretation', () => {
  it('two evidence lines with their own status', () => {
    const e = nitaqatEstimate(entity([saudi({ basicSalary: 4000 }), expat(), expat()]), DATE);
    expect(e.smallEntity).toBe(true);
    const rule = e.evidence.find((x) => x.key === 'NITAQAT:SMALL_ENTITY')!;
    const weight = e.evidence.find((x) => x.key === 'NITAQAT:SMALL_ENTITY_WEIGHT')!;
    expect(rule.status).toBe('VERIFIED_PRIMARY');
    expect(rule.label).not.toMatch(/موزون/);
    expect(weight.status).toBe('PROVISIONAL');
    expect(weight.label).toMatch(/4,000/);
    expect(e.overallStatus).toBe('PROVISIONAL');
  });
});

// ---------------------------------------------------------------------------
// P2-5 rounding text
// ---------------------------------------------------------------------------

describe('P2-5 required head count with explicit rounding', () => {
  it('40% × 6 = 2.4 -> 2; whole results without the rounding note', () => {
    expect(requiredSaudisText(6, 40)).toBe('المطلوب 2 = 40% × 6 = 2.4 مقرّبة');
    expect(requiredSaudisText(23, 50)).toBe('المطلوب 12 = 50% × 23 = 11.5 مقرّبة');
    expect(requiredSaudisText(10, 40)).toBe('المطلوب 4 = 40% × 10');
  });
});

// ---------------------------------------------------------------------------
// P2-4 seed script
// ---------------------------------------------------------------------------

describe('P2-4 seed-nitaqat: canonical files by default', () => {
  it('no file argument -> prisma/data/nitaqat-2026 (41 activities, 492 curves, 8 decisions, all with a source URL)', async () => {
    const out = execFileSync(process.execPath, [path.resolve('scripts/seed-nitaqat.mjs'), '--no-db', '--json'], { encoding: 'utf8' });
    const s = JSON.parse(out);
    expect(s.input).toMatch(/canonical/);
    expect(s.files).toEqual(['rules.json', 'curves.json', 'localization-decisions.json', 'sources.json']);
    expect(s.activities.total).toBe(41);
    expect(s.curves.total).toBe(492);
    expect(s.decisions.total).toBe(8);
    expect(s.errors).toEqual([]);
  });

  it('text normalization makes formatting-only changes stable; real changes are listed per field', () => {
    // The script has a shebang (not importable through vite): run the checks in a plain node process.
    const url = pathToFileURL(path.resolve('scripts/seed-nitaqat.mjs')).href;
    const code = String.raw`
      const mod = await import(${JSON.stringify(url)});
      const plan = (note, sourceFile) => mod.buildPlan(mod.classifyInputs([[{ groupNameAr: 'مهن', occupations: ['محاسب'], phases: [{ pct: 30, effectiveFrom: '2026-01-01' }], note, sourceFile, page: 3 }], [{ sourceFile: 'mkt.pdf', officialUrl: 'https://example.test/mkt.pdf' }]])).decisions[0];
      const a = plan('ملاحظة', 'mkt.pdf');
      const b = plan('ملاحظة  \r\n', 'C:\\extract\\mkt.pdf');
      const fields = ['notes', 'minWage', 'sourceUrl'];
      console.log(JSON.stringify({
        bare: [mod.bareFile('C:\\extract\\mkt.pdf'), mod.bareFile('extract/mkt.pdf')],
        join: mod.joinText([' a \r\n', null, '', 'b'], '\n'),
        same: JSON.stringify(a) === JSON.stringify(b),
        sourceUrl: a.sourceUrl,
        notes: a.notes,
        noDiff: mod.diffFields(a, b, fields),
        diff: mod.diffFields({ ...a, minWage: 5000 }, a, fields),
      }));`;
    const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' }));
    expect(out.bare).toEqual(['mkt.pdf', 'mkt.pdf']);
    expect(out.join).toBe('a\nb');
    expect(out.same).toBe(true);
    expect(out.sourceUrl).toBe('https://example.test/mkt.pdf'); // from sources.json
    expect(out.notes).toBe('ملاحظة\nملف المصدر: mkt.pdf\nالصفحات: 3');
    expect(out.noDiff).toEqual([]);
    expect(out.diff).toEqual([{ field: 'minWage', db: 5000, file: null }]);
  });
});
