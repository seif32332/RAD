import { describe, expect, it } from 'vitest';
import {
  calculateGosi,
  DEFAULT_GOSI_RATES,
  GOSI_NOTES,
  gosiBaseWage,
  isSaudiForGosi,
  joinReviewNotes,
  pickGosiRate,
  type GosiRateLike,
} from '@/lib/gosi';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

/** Same rows as the GosiRate seed (NEW Saudi steps provisional). */
const RATES: GosiRateLike[] = [
  { regime: 'OLD', isSaudi: true, effectiveFrom: d('2000-01-01'), employeeRate: 9.75, employerRate: 11.75, minWage: 1500, maxWage: 45000, isProvisional: false },
  { regime: 'OLD', isSaudi: false, effectiveFrom: d('2000-01-01'), employeeRate: 0, employerRate: 2, minWage: 1500, maxWage: 45000, isProvisional: false },
  { regime: 'NEW', isSaudi: false, effectiveFrom: d('2024-07-03'), employeeRate: 0, employerRate: 2, minWage: 1500, maxWage: 45000, isProvisional: false },
  { regime: 'NEW', isSaudi: true, effectiveFrom: d('2024-07-03'), employeeRate: 9.75, employerRate: 11.75, minWage: 1500, maxWage: 45000, isProvisional: true },
  { regime: 'NEW', isSaudi: true, effectiveFrom: d('2025-07-01'), employeeRate: 10.25, employerRate: 12.25, minWage: 1500, maxWage: 45000, isProvisional: true },
  { regime: 'NEW', isSaudi: true, effectiveFrom: d('2026-07-01'), employeeRate: 10.75, employerRate: 12.75, minWage: 1500, maxWage: 45000, isProvisional: true },
  { regime: 'NEW', isSaudi: true, effectiveFrom: d('2027-07-01'), employeeRate: 11.25, employerRate: 13.25, minWage: 1500, maxWage: 45000, isProvisional: true },
  { regime: 'NEW', isSaudi: true, effectiveFrom: d('2028-07-01'), employeeRate: 11.75, employerRate: 13.75, minWage: 1500, maxWage: 45000, isProvisional: true },
];

const saudi = (over: Partial<Parameters<typeof calculateGosi>[0]> = {}) =>
  calculateGosi({ isSaudi: true, regime: 'OLD', contributoryWage: 12500, month: 9, year: 2026, rates: RATES, ...over });

describe('isSaudiForGosi', () => {
  it('detects Saudi spellings and rejects "non-Saudi"', () => {
    expect(isSaudiForGosi('سعودي')).toBe(true);
    expect(isSaudiForGosi('سعودية')).toBe(true);
    expect(isSaudiForGosi('SAUDI')).toBe(true);
    expect(isSaudiForGosi(' Saudi Arabia ')).toBe(true);
    expect(isSaudiForGosi('غير سعودي')).toBe(false);
    expect(isSaudiForGosi('Non-Saudi')).toBe(false);
    expect(isSaudiForGosi('مصري')).toBe(false);
    expect(isSaudiForGosi('')).toBe(false);
    expect(isSaudiForGosi(null)).toBe(false);
  });
});

describe('gosiBaseWage (explicit countsTowardGosi flag, not the name)', () => {
  it('adds only recurring allowances flagged countsTowardGosi', () => {
    const allowances = [
      { name: 'بدل سكن', amount: 2500, isMonthly: true, countsTowardGosi: true },
      { name: 'بدل نقل', amount: 500, isMonthly: true, countsTowardGosi: false },
      { name: 'سكن عيني (غير معلَّم)', amount: 1000, isMonthly: true, countsTowardGosi: false },
      { name: 'بدل خاضع', amount: 300, isMonthly: true, countsTowardGosi: true },
      { name: 'مكافأة', amount: 900, isMonthly: false, countsTowardGosi: true },
    ];
    expect(gosiBaseWage(10000, allowances)).toBe(12800);
    expect(gosiBaseWage(null, [])).toBe(0);
  });
});

describe('pickGosiRate (row effective on the first day of the payroll month)', () => {
  it('uses the step effective on the 1st: June 2025 old step, July 2025 new step', () => {
    expect(pickGosiRate(RATES, 'NEW', true, 2025, 6)?.employeeRate).toBe(9.75);
    expect(pickGosiRate(RATES, 'NEW', true, 2025, 7)?.employeeRate).toBe(10.25);
    expect(pickGosiRate(RATES, 'NEW', true, 2026, 6)?.employeeRate).toBe(10.25);
    expect(pickGosiRate(RATES, 'NEW', true, 2026, 7)?.employeeRate).toBe(10.75);
  });
  it('July 2024: the NEW row starting on the 3rd applies to that month', () => {
    expect(pickGosiRate(RATES, 'NEW', true, 2024, 7)?.effectiveFrom.toISOString().slice(0, 10)).toBe('2024-07-03');
    expect(pickGosiRate(RATES, 'NEW', true, 2024, 6)).toBeNull();
  });
});

describe('calculateGosi', () => {
  it('OLD Saudi: 9.75% employee / 11.75% employer', () => {
    const r = saudi();
    expect(r.employee).toBe(1218.75);
    expect(r.employer).toBe(1468.75);
    expect(r.needsReview).toBe(false);
    expect(r.provisional).toBe(false);
    expect(r.notes).toEqual([]);
  });

  it('NEW Saudi by month incl. the July boundary (provisional rows)', () => {
    const june = saudi({ regime: 'NEW', contributoryWage: 10000, month: 6, year: 2025 });
    expect(june.employee).toBe(975);
    expect(june.employer).toBe(1175);
    expect(june.provisional).toBe(true);
    expect(june.needsReview).toBe(false);
    expect(june.notes).toContain(GOSI_NOTES.PROVISIONAL);
    const july = saudi({ regime: 'NEW', contributoryWage: 10000, month: 7, year: 2025 });
    expect(july.employee).toBe(1025);
    expect(july.employer).toBe(1225);
    const sept2026 = saudi({ regime: 'NEW', contributoryWage: 10000, month: 9, year: 2026 });
    expect(sept2026.employee).toBe(1075);
    expect(sept2026.employer).toBe(1275);
  });

  it('UNKNOWN Saudi: OLD rates AND needsReview with the Arabic note', () => {
    const r = saudi({ regime: 'UNKNOWN', contributoryWage: 10000, month: 9, year: 2026 });
    expect(r.regimeUsed).toBe('OLD');
    expect(r.employee).toBe(975);
    expect(r.employer).toBe(1175);
    expect(r.needsReview).toBe(true);
    expect(r.notes).toContain('نظام التأمينات غير مؤكد');
    expect(saudi({ regime: null }).needsReview).toBe(true);
  });

  it('NEW Saudi before any NEW row (June 2024): OLD rates, flagged', () => {
    const r = saudi({ regime: 'NEW', contributoryWage: 10000, month: 6, year: 2024 });
    expect(r.regimeUsed).toBe('OLD');
    expect(r.employee).toBe(975);
    expect(r.needsReview).toBe(true);
    expect(r.notes).toContain(GOSI_NOTES.NO_RATE);
  });

  it('clamps the contributory wage to [1,500, 45,000]', () => {
    const low = saudi({ contributoryWage: 1000 });
    expect(low.contributoryWage).toBe(1500);
    expect(low.employee).toBe(146.25);
    expect(low.employer).toBe(176.25);
    const high = saudi({ contributoryWage: 60000 });
    expect(high.contributoryWage).toBe(45000);
    expect(high.employee).toBe(4387.5);
    expect(high.employer).toBe(5287.5);
    const exact = saudi({ contributoryWage: 45000 });
    expect(exact.employee).toBe(4387.5);
  });

  it('no wage -> no contribution', () => {
    const r = saudi({ contributoryWage: 0 });
    expect(r.employee).toBe(0);
    expect(r.employer).toBe(0);
  });

  it('non-Saudi: employer-only 2%, regime irrelevant and never flagged', () => {
    for (const regime of ['OLD', 'NEW', 'UNKNOWN']) {
      const r = calculateGosi({ isSaudi: false, regime, contributoryWage: 10000, month: 9, year: 2026, rates: RATES });
      expect(r.employee).toBe(0);
      expect(r.employer).toBe(200);
      expect(r.needsReview).toBe(false);
    }
    // Before the NEW non-Saudi row existed: falls back to the OLD non-Saudi row.
    const early = calculateGosi({ isSaudi: false, regime: 'NEW', contributoryWage: 10000, month: 1, year: 2024, rates: RATES });
    expect(early.employer).toBe(200);
    expect(early.needsReview).toBe(false);
  });

  it('Employee.gosiDeduction > 0 overrides the EMPLOYEE share only (prorated), marked "مبلغ يدوي"', () => {
    const r = saudi({ contributoryWage: 10000, employeeOverride: 500 });
    expect(r.employee).toBe(500);
    expect(r.employer).toBe(1175);
    expect(r.manualOverride).toBe(true);
    expect(r.notes).toContain('مبلغ يدوي');
    const half = saudi({ contributoryWage: 10000, employeeOverride: 500, factor: 0.5 });
    expect(half.employee).toBe(250);
    expect(half.employer).toBe(587.5);
    const nonSaudi = calculateGosi({ isSaudi: false, regime: 'OLD', contributoryWage: 10000, month: 9, year: 2026, rates: RATES, employeeOverride: 300 });
    expect(nonSaudi.employee).toBe(300);
    expect(nonSaudi.employer).toBe(200);
    expect(saudi({ employeeOverride: 0 }).manualOverride).toBe(false);
  });

  it('prorates both shares for partial months', () => {
    const r = saudi({ contributoryWage: 10000, factor: 15 / 30 });
    expect(r.employee).toBe(487.5);
    expect(r.employer).toBe(587.5);
  });

  it('empty rate table: Saudi line flagged, never throws', () => {
    const r = calculateGosi({ isSaudi: true, regime: 'OLD', contributoryWage: 10000, month: 9, year: 2026, rates: [] });
    expect(r.employee).toBe(0);
    expect(r.needsReview).toBe(true);
    expect(r.notes).toContain(GOSI_NOTES.NO_RATE);
    const fallback = calculateGosi({ isSaudi: true, regime: 'OLD', contributoryWage: 10000, month: 9, year: 2026, rates: DEFAULT_GOSI_RATES });
    expect(fallback.employee).toBe(975);
    expect(fallback.employer).toBe(1175);
  });

  it('joinReviewNotes de-duplicates and joins', () => {
    expect(joinReviewNotes([])).toBeNull();
    expect(joinReviewNotes(['أ', 'ب', 'أ', ' '])).toBe('أ | ب');
  });
});
