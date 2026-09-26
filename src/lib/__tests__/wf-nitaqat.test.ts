// Nitaqat Mutawar estimate (src/lib/workforce/nitaqat.ts): weights, caps (incl. conflict), the Qiwa
// documentation gate, the ≤5 rule, thresholds with ln, years 2026 → 2028, margins, the 26-week average,
// viewer restriction and determinism. Every expected number is computed by hand in the comments.
// Curve constants are the two activities verified from the guide annex (TEST FIXTURES, not seed data).
import { describe, expect, it } from 'vitest';
import {
  bandForCounts,
  bandThreshold,
  capRules,
  curveSetFor,
  hiresToReach,
  isRetailWholesaleActivity,
  nitaqatCounts,
  nitaqatEstimate,
  nitaqatWeight,
  restrictEstimate,
  type NitaqatActivityRow,
  type NitaqatCurveRow,
  type NitaqatEntityInput,
} from '@/lib/workforce/nitaqat';
import type { WfEmployeeInput } from '@/lib/workforce';
import { d, emp, housing, transport } from './wf-fixtures';

const BANDS = ['LOW_GREEN', 'MEDIUM_GREEN', 'HIGH_GREEN', 'PLATINUM'] as const;

function curves(key: string, m: [number, number, number, number], c: Record<2026 | 2027 | 2028, [number, number, number, number]>): NitaqatCurveRow[] {
  const out: NitaqatCurveRow[] = [];
  for (const y of [2026, 2027, 2028] as const) BANDS.forEach((b, i) => out.push({ activityKey: key, band: b, year: y, m: m[i], c: c[y][i], status: 'VERIFIED_PRIMARY', page: 13, sourceUrl: 'https://example.test/guide.pdf' }));
  return out;
}

// Financial institutions: m = 2.60, c = 50 / 57 / 62 / 65 every year.
const FIN: NitaqatActivityRow = { key: 'test-fin', nameAr: 'المؤسسات المالية', code: '480', status: 'VERIFIED_PRIMARY', page: 13 };
const FIN_CURVES = curves('test-fin', [2.6, 2.6, 2.6, 2.6], { 2026: [50, 57, 62, 65], 2027: [50, 57, 62, 65], 2028: [50, 57, 62, 65] });
// Business services.
const BIZ: NitaqatActivityRow = { key: 'test-biz', nameAr: 'خدمات الاعمال', code: '481', status: 'VERIFIED_PRIMARY', page: 14 };
const BIZ_CURVES = curves('test-biz', [1.03, 1.03, 2.19, 2.19], {
  2026: [33.78, 42.62, 43.62, 54.82],
  2027: [36.78, 45.62, 46.62, 57.82],
  2028: [39.78, 48.62, 49.62, 60.82],
});

const DATE = d('2026-09-26');
const saudi = (over: Partial<WfEmployeeInput> = {}) => emp({ nationality: 'سعودي', basicSalary: 5000, qiwaContractDocumented: true, joinDate: d('2024-01-01'), ...over });
const expat = (over: Partial<WfEmployeeInput> = {}) => emp({ nationality: 'هندي', basicSalary: 3000, joinDate: d('2024-01-01'), gosiRegime: null, ...over });
const many = (n: number, f: (i: number) => WfEmployeeInput) => Array.from({ length: n }, (_, i) => f(i));
const entity = (employees: WfEmployeeInput[], over: Partial<NitaqatEntityInput> = {}): NitaqatEntityInput => ({ companyId: 'c1', companyName: 'شركة', activity: BIZ, curves: BIZ_CURVES, employees, ...over });

describe('weights (Qiwa)', () => {
  const ctx = { date: DATE, entitySize: 10, retail: false };
  it('Saudi wage bands on the GOSI wage (basic + housing; transport excluded)', () => {
    expect(nitaqatWeight(saudi({ basicSalary: 2999 }), ctx).weight).toBe(0);
    expect(nitaqatWeight(saudi({ basicSalary: 3000 }), ctx).weight).toBe(0.5);
    expect(nitaqatWeight(saudi({ basicSalary: 3999 }), ctx).weight).toBe(0.5);
    expect(nitaqatWeight(saudi({ basicSalary: 4000 }), ctx).weight).toBe(1);
    // 3,000 basic + 1,000 housing = 4,000 -> 1; + 1,000 transport stays 3,000 -> 0.5.
    expect(nitaqatWeight(saudi({ basicSalary: 3000, allowances: [housing(1000)] }), ctx).weight).toBe(1);
    expect(nitaqatWeight(saudi({ basicSalary: 3000, allowances: [transport(1000)] }), ctx).weight).toBe(0.5);
  });
  it('disabled: 4 at >= 4,000; 1 below; entity 50+ needs a valid Muawama certificate', () => {
    expect(nitaqatWeight(saudi({ isDisabled: true, basicSalary: 5000 }), ctx)).toMatchObject({ weight: 4, weightClass: 'DISABLED', capCategory: 'DISABLED', fallbackWeight: 1 });
    expect(nitaqatWeight(saudi({ isDisabled: true, basicSalary: 3500 }), ctx)).toMatchObject({ weight: 1, weightClass: 'DISABLED_ONE', note: 'DISABLED_LOW_WAGE' });
    const big = { ...ctx, entitySize: 50 };
    expect(nitaqatWeight(saudi({ isDisabled: true, basicSalary: 5000 }), big)).toMatchObject({ weight: 1, note: 'MUAWAMA_MISSING' });
    expect(nitaqatWeight(saudi({ isDisabled: true, basicSalary: 5000, muawamaCertExpiry: d('2026-09-25') }), big).weight).toBe(1); // expired
    expect(nitaqatWeight(saudi({ isDisabled: true, basicSalary: 5000, muawamaCertExpiry: d('2026-09-26') }), big).weight).toBe(4); // valid on the date
  });
  it('student 0.5 (2,000+; below 0), part-time 0.5, GCC 1 on the Saudi side, expat 1 on the other side', () => {
    expect(nitaqatWeight(saudi({ isStudent: true, basicSalary: 2500 }), ctx)).toMatchObject({ weight: 0.5, weightClass: 'STUDENT', capCategory: 'STUDENT', fallbackWeight: 0 });
    expect(nitaqatWeight(saudi({ isStudent: true, basicSalary: 1999 }), ctx)).toMatchObject({ weight: 0, note: 'STUDENT_LOW_WAGE' });
    expect(nitaqatWeight(saudi({ isStudent: true, basicSalary: 3500 }), ctx)).toMatchObject({ weight: 0.5, weightClass: 'SAUDI_HALF', capCategory: null });
    expect(nitaqatWeight(saudi({ contractType: 'PART_TIME', basicSalary: 9000 }), ctx)).toMatchObject({ weight: 0.5, weightClass: 'PART_TIME' });
    expect(nitaqatWeight(saudi({ nationality: 'كويتي' }), ctx)).toMatchObject({ side: 'SAUDI', weight: 1, weightClass: 'GCC', capCategory: 'GCC' });
    expect(nitaqatWeight(expat(), ctx)).toMatchObject({ side: 'EXPAT', weight: 1, counted: true });
  });
  it('documentation gate from 2026-04-15: undocumented Saudi / GCC count 0, out of X, potential weight kept', () => {
    const w = nitaqatWeight(saudi({ qiwaContractDocumented: false, basicSalary: 5000 }), ctx);
    expect(w).toMatchObject({ weight: 0, counted: false, weightClass: 'UNDOCUMENTED', potentialWeight: 1 });
    expect(nitaqatWeight(saudi({ qiwaContractDocumented: false }), { ...ctx, date: d('2026-04-14') }).counted).toBe(true);
    // Documented after the date: not yet counted on the date.
    expect(nitaqatWeight(saudi({ qiwaContractDocumented: true, qiwaContractDocumentedAt: d('2026-10-01') }), ctx).counted).toBe(false);
    expect(nitaqatWeight(saudi({ nationality: 'إماراتي', qiwaContractDocumented: false }), ctx).counted).toBe(false);
  });
  it('retail / wholesale caps only for activity 460', () => {
    expect(isRetailWholesaleActivity({ nameAr: 'البيع بالجملة والتجزئة العامة', code: '460' })).toBe(true);
    expect(isRetailWholesaleActivity({ nameAr: 'البيع بالتجزئة للعطور والساعات', code: '435' })).toBe(false);
    expect(isRetailWholesaleActivity({ nameAr: 'البيع بالجملة والتجزئة العامة', code: null })).toBe(true);
    expect(capRules({ entitySize: 10, retail: true }).find((r) => r.id === 'STUDENT')!.pct).toBe(40);
    expect(capRules({ entitySize: 60, retail: false }).find((r) => r.id === 'DISABLED')!.pct).toBe(10);
  });
});

describe('caps', () => {
  it('disabled: the combined 15% is stricter than the own 20% -> 1 admitted, conflict flagged', () => {
    // 10 Saudis (5,000) + 3 disabled (5,000) + 7 expats. Base = 13 Saudi nationals.
    // Own cap floor(20% × 13 = 2.6) = 2; combined floor(15% × 13 = 1.95) = 1 -> one at 4, two at 1.
    // Saudi side = 10 + 4 + 1 + 1 = 16; X = 20; pct = 16 / 23 = 69.565%.
    const emps = [...many(10, () => saudi()), ...many(3, () => saudi({ isDisabled: true })), ...many(7, () => expat())];
    const c = nitaqatCounts(emps, DATE, false);
    expect(c.saudiPersons).toBe(13);
    expect(c.caps.find((x) => x.id === 'DISABLED')!.maxPersons).toBe(2);
    expect(c.caps.find((x) => x.id === 'DISABLED_RELEASED_STUDENT')!.maxPersons).toBe(1);
    expect(c.saudiWeighted).toBe(16);
    expect(c.x).toBe(20);
    expect(c.capConflict).toBe(true);
    const e = nitaqatEstimate(entity(emps), DATE);
    expect(e.pct).toBeCloseTo(69.57, 2);
    expect(e.flags.map((f) => f.code)).toEqual(expect.arrayContaining(['CAP_APPLIED', 'CAP_INTERPRETATION']));
  });
  it('retail (460): combined 40% -> the own cap binds (2 admitted), no conflict', () => {
    const emps = [...many(10, () => saudi()), ...many(3, () => saudi({ isDisabled: true })), ...many(7, () => expat())];
    const c = nitaqatCounts(emps, DATE, true);
    // 10 + 4 + 4 + 1 = 19.
    expect(c.saudiWeighted).toBe(19);
    expect(c.capConflict).toBe(false);
  });
  it('students 10%: floor(2.3) = 2 at 0.5, the third at its wage weight (0)', () => {
    const emps = [...many(20, () => saudi()), ...many(3, () => saudi({ isStudent: true, basicSalary: 2500 }))];
    const c = nitaqatCounts(emps, DATE, false);
    expect(c.saudiWeighted).toBe(21);
  });
  it('GCC 10% of Saudis: floor(1) -> one GCC counts 1, the other 0 (never an expat)', () => {
    const emps = [...many(10, () => saudi()), saudi({ nationality: 'كويتي' }), saudi({ nationality: 'قطري' }), expat()];
    const c = nitaqatCounts(emps, DATE, false);
    expect(c.saudiWeighted).toBe(11);
    expect(c.expats).toBe(1);
    expect(c.gccPersons).toBe(2);
    expect(c.x).toBe(13);
  });
});

describe('thresholds and bands', () => {
  const ln10 = Math.log(10);
  it('Y = m·ln(X) + c (natural log) for 2026 / 2027 / 2028', () => {
    // Business services, X = 10: LOW = 1.03 × 2.302585 + 33.78 = 36.1517; +3 per year.
    expect(bandThreshold(1.03, 33.78, 10)).toBeCloseTo(1.03 * ln10 + 33.78, 10);
    const s26 = curveSetFor(BIZ_CURVES, 'test-biz', 2026);
    const s28 = curveSetFor(BIZ_CURVES, 'test-biz', 2028);
    expect(bandThreshold(s26.byBand.LOW_GREEN!.m, s26.byBand.LOW_GREEN!.c, 10)).toBeCloseTo(36.1517, 3);
    expect(bandThreshold(s26.byBand.HIGH_GREEN!.m, s26.byBand.HIGH_GREEN!.c, 10)).toBeCloseTo(48.6627, 3);
    expect(bandThreshold(s28.byBand.PLATINUM!.m, s28.byBand.PLATINUM!.c, 10)).toBeCloseTo(65.8627, 3);
    // Financial institutions X = 100: 2.6 × 4.605170 + 50 = 61.9734.
    const f = curveSetFor(FIN_CURVES, 'test-fin', 2027);
    expect(bandThreshold(f.byBand.LOW_GREEN!.m, f.byBand.LOW_GREEN!.c, 100)).toBeCloseTo(61.9734, 3);
  });
  it('estimate: 4 Saudis + 6 expats = 40% -> LOW_GREEN in 2026 and 2027, RED in 2028', () => {
    const e = nitaqatEstimate(entity([...many(4, () => saudi()), ...many(6, () => expat())]), DATE);
    expect(e.status).toBe('OK');
    expect(e.counts).toMatchObject({ x: 10, saudiWeighted: 4, expats: 6 });
    expect(e.pct).toBe(40);
    expect(e.band).toBe('LOW_GREEN');
    expect(e.thresholds.map((t) => t.y)).toEqual([36.15, 44.99, 48.66, 59.86]);
    expect(e.thresholdsByYear.map((y) => [y.year, y.band])).toEqual([
      [2026, 'LOW_GREEN'],
      [2027, 'LOW_GREEN'], // LOW 2027 = 39.15
      [2028, 'RED'], // LOW 2028 = 42.15
    ]);
    // Margin up: 1 hire -> 5 / 11 = 45.45% >= MED(11) = 1.03 ln 11 + 42.62 = 45.09.
    expect(e.margin.up).toEqual({ band: 'MEDIUM_GREEN', pctGap: 4.99, saudiHires: 1 });
    // Margin down: +1 expat 4/11 = 36.36 >= LOW(11) 36.25 ok; +2 -> 33.33 < 36.34: 1 expat. One Saudi
    // leaving: 3/9 = 33.33 < LOW(9) 36.04 -> 0.
    expect(e.margin.down).toEqual({ band: 'RED', pctCushion: 3.85, expatsBeforeDrop: 1, saudiExitsBeforeDrop: 0 });
    expect(e.consequences!.conflict).toMatch(/متعارض/);
    expect(e.evidence.some((x) => x.key.startsWith('NITAQAT_CURVE:test-biz:LOW_GREEN:2026'))).toBe(true);
  });
  it('band boundaries: lower bound inclusive, upper exclusive', () => {
    const set = curveSetFor(FIN_CURVES, 'test-fin', 2026);
    // X = 1 is the ≤5 regime; check the formula regime at X = e^1 ≈ use counts with X = 10 directly.
    const y = bandThreshold(2.6, 57, 10); // MEDIUM threshold at X = 10: 62.9867
    const s = (y / 100) * 10; // weighted Saudis giving exactly y% with S + E = 10
    expect(bandForCounts(s, 10 - s, 10, set).band).toBe('MEDIUM_GREEN');
    expect(bandForCounts(s - 0.01, 10 - s + 0.01, 10, set).band).toBe('LOW_GREEN');
  });
  it('financial institutions: 7 Saudis + 3 expats = 70% at X = 10 -> HIGH_GREEN (PLATINUM from 70.99)', () => {
    // 2.6 × ln 10 = 5.9867: LOW 55.99, MED 62.99, HIGH 67.99, PLAT 70.99.
    const e = nitaqatEstimate(entity([...many(7, () => saudi()), ...many(3, () => expat())], { activity: FIN, curves: FIN_CURVES }), DATE);
    expect(e.thresholds.map((t) => t.y)).toEqual([55.99, 62.99, 67.99, 70.99]);
    expect(e).toMatchObject({ pct: 70, band: 'HIGH_GREEN' });
    // 1 hire: 8 / 11 = 72.73% >= PLAT(11) = 2.6 ln 11 + 65 = 71.23.
    expect(e.margin.up).toMatchObject({ band: 'PLATINUM', saudiHires: 1 });
  });
  it('years after 2028 use the 2028 constants (flagged)', () => {
    const e = nitaqatEstimate(entity([...many(4, () => saudi()), ...many(6, () => expat())]), d('2030-03-01'));
    expect(e.curveYear).toBe(2028);
    expect(e.band).toBe('RED');
    expect(e.flags.some((f) => f.code === 'YEAR_BEYOND_TABLE')).toBe(true);
  });
  it('≤5 rule: 1 weighted Saudi -> LOW_GREEN, 0.5 -> RED; the curve applies from 6 (hires cross regimes)', () => {
    const green = nitaqatEstimate(entity([saudi(), ...many(4, () => expat())]), DATE);
    expect(green).toMatchObject({ band: 'LOW_GREEN', smallEntity: true });
    const red = nitaqatEstimate(entity([saudi({ basicSalary: 3500 }), ...many(4, () => expat())]), DATE);
    expect(red.band).toBe('RED');
    // 1 hire: S = 1.5, X = 6 -> 1.5 / 5.5 = 27.27% < LOW(6) 35.63: RED. 2 hires: 2.5 / 6.5 = 38.46% >= LOW(7) 35.78.
    expect(red.margin.up!.saudiHires).toBe(2);
    expect(hiresToReach(0.5, 4, 5, curveSetFor(BIZ_CURVES, 'test-biz', 2026), 'LOW_GREEN')).toBe(2);
  });
  it('NO_ACTIVITY without activity or curves; NO_EMPLOYEES without counted workers', () => {
    expect(nitaqatEstimate(entity([saudi()], { activity: null }), DATE).status).toBe('NO_ACTIVITY');
    expect(nitaqatEstimate(entity([saudi()], { curves: [] }), DATE).status).toBe('NO_ACTIVITY');
    expect(nitaqatEstimate(entity([saudi({ qiwaContractDocumented: false })]), DATE).status).toBe('NO_EMPLOYEES');
  });
});

describe('documentation alert, 26-week average, restriction, determinism', () => {
  it('undocumented Saudis listed with their potential weight and an ERROR flag', () => {
    const e = nitaqatEstimate(entity([...many(3, () => saudi()), saudi({ id: 'u1', name: 'غير موثق', qiwaContractDocumented: false }), ...many(6, () => expat())]), DATE);
    // X = 9 (undocumented left out), 3 / 9 = 33.33% < LOW(9) 36.04 -> RED.
    expect(e.counts.x).toBe(9);
    expect(e.band).toBe('RED');
    expect(e.undocumented).toEqual([{ id: 'u1', name: 'غير موثق', potentialWeight: 1 }]);
    const f = e.flags.find((x) => x.code === 'UNDOCUMENTED_QIWA')!;
    expect(f.severity).toBe('ERROR');
    expect(f.employeeIds).toEqual(['u1']);
  });
  it('26-week average from weekly snapshots', () => {
    // An expat joined on 2026-09-01: active in 4 of the 26 weekly snapshots (09-26, 09-19, 09-12, 09-05).
    // avg E = (4 × 6 + 22 × 5) / 26 = 5.1538; avg S = 4; pct = 4 / 9.1538 = 43.70%.
    const emps = [...many(4, () => saudi()), ...many(5, () => expat()), expat({ joinDate: d('2026-09-01') })];
    const e = nitaqatEstimate(entity(emps), DATE);
    expect(e.average26w!.expats).toBeCloseTo(5.15, 2);
    expect(e.average26w!.pct).toBeCloseTo(43.7, 2);
    expect(e.pct).toBe(40);
  });
  it('restricted view: no names, special classes merged, sensitive flags neutral', () => {
    const emps = [...many(10, () => saudi()), ...many(3, () => saudi({ isDisabled: true })), saudi({ id: 'u9', qiwaContractDocumented: false }), ...many(7, () => expat())];
    const r = restrictEstimate(nitaqatEstimate(entity(emps), DATE));
    expect(r.persons).toEqual([]);
    expect(r.undocumented).toEqual([]);
    expect(r.undocumentedCount).toBe(1);
    expect(r.breakdown.some((b) => b.weightClass === 'DISABLED' || b.weightClass === 'DISABLED_ONE')).toBe(false);
    // One Saudi-side row (review fix P2-2): 10 × 1 + the 3 disabled (caps: one at 4, two at 1) = 16.
    expect(r.breakdown.map((b) => [b.weightClass, b.persons, b.weight])).toEqual([
      ['SAUDI_TOTAL', 13, 16],
      ['UNDOCUMENTED', 1, 0],
      ['EXPAT', 7, 7],
    ]);
    expect('undocumentedPotentialWeight' in r).toBe(false);
    // Person-level data only (the rule texts in evidence / assumptions name the categories generically).
    const json = JSON.stringify({ b: r.breakdown, f: r.flags, u: r.undocumented, p: r.persons, c: r.caps });
    expect(json).not.toMatch(/إعاقة|DISABLED|مواءمة/);
    expect(r.flags.every((f) => !f.employeeIds)).toBe(true);
  });
  it('deterministic: same input, same output (employee order does not matter)', () => {
    const emps = [...many(10, () => saudi()), ...many(3, () => saudi({ isDisabled: true })), ...many(7, () => expat())];
    const a = nitaqatEstimate(entity(emps), DATE);
    const b = nitaqatEstimate(entity([...emps].reverse()), DATE);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});
