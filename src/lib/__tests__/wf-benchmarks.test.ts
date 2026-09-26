// «المؤشرات الداخلية» (src/lib/workforce/benchmarks.ts): hand-computed cases. SPEC §9.
import { describe, expect, it } from 'vitest';
import {
  BENCHMARK_SOURCE,
  COMPLEMENTARY_SUPPRESSED_TEXT,
  INSUFFICIENT_DATA,
  SCOPE_COMPLEMENT_REASON,
  SCOPE_SUPPRESSED_REASON,
  SMALL_COUNT_REASON,
  SUPPRESSED_TEXT,
  benchmarkPeriod,
  computeBenchmarks,
  leaveDaysInPeriod,
  newHireAttrition,
  scopeDisclosure,
  suppressGroups,
  timeToHire,
  trailingTurnoverRate,
  type BenchmarksInput,
  type BmEmployee,
  type BmPopulationEmployee,
} from '@/lib/workforce/benchmarks';

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
const ASOF = D('2026-06-30');

function emp(id: string, o: Partial<BmEmployee> = {}): BmEmployee {
  return { id, joinDate: D('2020-01-01'), isTerminated: false, terminationDate: null, nationality: 'سعودي', departmentId: 'A', departmentName: 'الإدارة أ', basicSalary: 8000, monthlyAllowances: 2000, ...o };
}

/** 10 active in A, 6 active in C, 3 expat leavers in B. */
function workforce(): BmEmployee[] {
  const out: BmEmployee[] = [];
  for (let i = 0; i < 10; i++) out.push(emp(`a${i}`));
  for (let i = 0; i < 6; i++) out.push(emp(`c${i}`, { departmentId: 'C', departmentName: 'الإدارة ج' }));
  const leaver = (id: string, date: string, v: boolean | null) =>
    emp(id, { isTerminated: true, terminationDate: D(date), exitVoluntary: v, nationality: 'مصري', departmentId: 'B', departmentName: 'الإدارة ب' });
  out.push(leaver('l1', '2025-12-31', true), leaver('l2', '2026-03-15', false), leaver('l3', '2026-06-30', null));
  return out;
}

function emptyInput(employees: BmEmployee[]): BenchmarksInput {
  return { employees, payrolls: [], overtimeRequests: [], attendance: [], leaves: [], settlements: [], jobRequests: [], govFees: [] };
}

describe('benchmarkPeriod', () => {
  it('N calendar months ending with the month of asOf', () => {
    const p = benchmarkPeriod(D('2026-09-26'), 3);
    expect(p.from).toBe('2026-07-01');
    expect(p.to).toBe('2026-09-26');
    expect(p.monthKeys).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(p.partialLastMonth).toBe(true);
    expect(benchmarkPeriod(ASOF, 12).monthKeys[0]).toBe('2025-07');
    expect(benchmarkPeriod(ASOF, 12).partialLastMonth).toBe(false);
  });
});

describe('trailingTurnoverRate', () => {
  // Month-end headcounts 2025-07..2026-06: Jul–Dec 19 (l1 still employed on its last day 31 Dec),
  // Jan–Feb 18, Mar–Jun 17 (l3 employed on 30 Jun) → (6×19 + 2×18 + 4×17) / 12 = 218 / 12 = 18.1667.
  const r = trailingTurnoverRate(workforce(), ASOF, 12);

  it('exits ÷ average month-end headcount × 100, split by exitVoluntary', () => {
    expect(r.exits).toBe(3);
    expect(r.averageHeadcount).toBe(18.17);
    expect(r.overall.numerator).toBe(3);
    expect(r.overall.denominator).toBe(18.17);
    expect(r.overall.value).toBe(16.51); // 3 / 18.1667 = 16.5138%
    expect(r.overall.extra?.annualized).toBe(16.51);
    expect(r.voluntary.value).toBe(5.5); // 1 / 18.1667
    expect(r.voluntary.numerator).toBe(1);
    expect(r.involuntary.numerator).toBe(1);
    expect(r.unknownType.numerator).toBe(1);
    expect(r.overall.dataQuality.some((q) => q.includes('طوعي'))).toBe(true);
    expect(r.overall.source).toBe(BENCHMARK_SOURCE);
    expect(r.overall.period.from).toBe('2025-07-01');
  });

  it('suppresses groups below 5 and the next smallest group (complementary suppression)', () => {
    const byKey = Object.fromEntries(r.byDepartment.map((x) => [x.key, x]));
    // B: (6×3 + 2×2 + 4×1) / 12 = 2.17 < 5 → «أقل من 5»; C (6) is the smallest remaining → hidden too; A shown.
    expect(byKey.B).toMatchObject({ suppressed: true, suppressedText: SUPPRESSED_TEXT, value: null, numerator: null, size: null });
    expect(byKey.C).toMatchObject({ suppressed: true, suppressedText: COMPLEMENTARY_SUPPRESSED_TEXT, value: null });
    expect(byKey.A).toMatchObject({ suppressed: false, size: 10, value: 0, numerator: 0 });
    // Nationality: 2 groups, the expat one is small → both hidden.
    expect(r.byNationality.every((x) => x.suppressed)).toBe(true);
    // Tenure: everyone in 5–10 years → one visible group with all 3 exits.
    expect(r.byTenure).toHaveLength(1);
    expect(r.byTenure[0]).toMatchObject({ key: 'Y5_10', suppressed: false, numerator: 3, value: 16.51 });
  });

  it('monthly series: exits of the month ÷ month-end headcount', () => {
    const dec = r.series.find((s) => s.month === '2025-12')!;
    expect(dec).toMatchObject({ numerator: 1, denominator: 19, value: 5.26 });
    expect(r.series.find((s) => s.month === '2026-01')).toMatchObject({ numerator: 0, denominator: 18, value: 0 });
  });

  it('a terminated employee without a termination date is excluded and reported', () => {
    const r2 = trailingTurnoverRate([...workforce(), emp('x', { isTerminated: true, terminationDate: null })], ASOF, 12);
    expect(r2.exits).toBe(3);
    expect(r2.averageHeadcount).toBe(18.17);
    expect(r2.overall.dataQuality.some((q) => q.includes('بلا تاريخ إنهاء'))).toBe(true);
  });

  it('no data → null with the reason, never a default number', () => {
    const r3 = trailingTurnoverRate([], ASOF, 12);
    expect(r3.overall.value).toBeNull();
    expect(r3.overall.reason).toBe(INSUFFICIENT_DATA);
  });
});

describe('suppressGroups', () => {
  it('drops empty groups, hides < 5 and one complementary group; nothing extra when two groups are small', () => {
    const g = (key: string, size: number) => ({ key, label: key, size, value: size, numerator: size, denominator: size });
    const one = suppressGroups([g('a', 4), g('b', 7), g('c', 20), g('z', 0)]);
    expect(one.map((x) => [x.key, x.suppressedText])).toEqual([
      ['a', SUPPRESSED_TEXT],
      ['b', COMPLEMENTARY_SUPPRESSED_TEXT],
      ['c', null],
    ]);
    const two = suppressGroups([g('a', 4), g('b', 3), g('c', 20)]);
    expect(two.map((x) => x.suppressedText)).toEqual([SUPPRESSED_TEXT, SUPPRESSED_TEXT, null]);
    expect(suppressGroups([g('a', 5)])[0].suppressed).toBe(false);
  });
});

describe('time to hire (approximation)', () => {
  it('mean days from the job request to the hired candidate (else the fulfilled request update), labelled approximate', () => {
    const m = timeToHire(
      [
        { id: 'j1', createdAt: D('2026-01-01'), fulfilledAt: D('2026-01-31') }, // 30 days
        { id: 'j2', createdAt: D('2026-02-01'), fulfilledAt: D('2026-03-01'), hiredAt: D('2026-02-11') }, // 10 days (hired date wins)
        { id: 'j3', createdAt: D('2024-11-01'), fulfilledAt: D('2025-01-01') }, // outside the period
      ],
      ASOF,
      12,
    );
    expect(m).toMatchObject({ value: 20, numerator: 40, denominator: 2, approximate: true });
    expect(m.extra?.median).toBe(20);
    expect(m.dataQuality[0]).toContain('تقريبي');
  });
});

describe('new-hire attrition', () => {
  const people = [
    emp('n1', { joinDate: D('2026-01-10'), isTerminated: true, terminationDate: D('2026-02-20') }), // left before 10 Apr
    emp('n2', { joinDate: D('2026-02-01') }), // 3-month window ends 1 May, stayed
    emp('n3', { joinDate: D('2026-05-01') }), // window ends 1 Aug > asOf: not yet in a cohort
  ];
  it('cohort = hires whose first 3 months ended inside the period', () => {
    expect(newHireAttrition(people, ASOF, 12, 3)).toMatchObject({ numerator: 1, denominator: 2, value: 50 });
  });
  it('no complete 6-month window → null with the reason', () => {
    const m = newHireAttrition(people, ASOF, 12, 6);
    expect(m.value).toBeNull();
    expect(m.reason).toBe(INSUFFICIENT_DATA);
  });
});

describe('computeBenchmarks', () => {
  const staff = workforce();
  const input: BenchmarksInput = {
    ...emptyInput(staff),
    attendance: [
      { employeeId: 'a0', month: '2026-05', present: 18, absent: 2 },
      { employeeId: 'a1', month: '2026-06', present: 20, absent: 0 },
      { employeeId: 'a2', month: '2024-01', present: 0, absent: 20 }, // outside the period
      { employeeId: 'ghost', month: '2026-06', present: 0, absent: 30 }, // not in scope
    ],
    leaves: [
      { employeeId: 'a0', leaveType: 'SICK', startDate: D('2026-03-01'), endDate: D('2026-03-10'), totalDays: 10 },
      { employeeId: 'a1', leaveType: 'SICK', startDate: D('2025-06-21'), endDate: D('2025-07-10'), totalDays: 20 }, // 10 of 20 days inside
      { employeeId: 'a2', leaveType: 'ANNUAL', startDate: D('2026-03-01'), endDate: D('2026-03-10'), totalDays: 10 },
    ],
    settlements: [
      { employeeId: 'l1', type: 'END_OF_SERVICE', status: 'PAID', endOfServiceAmount: 30000, leaveCompensation: 5000, terminationReason: 'RESIGNATION', lastWorkingDate: D('2025-12-31'), createdAt: D('2026-01-05'), salaryBasis: 'total' },
      { employeeId: 'l2', type: 'END_OF_SERVICE', status: 'OWNER_APPROVED', endOfServiceAmount: 99999, leaveCompensation: 0, terminationReason: null, lastWorkingDate: D('2026-03-15'), createdAt: D('2026-03-20') },
    ],
    payrolls: [
      ...['a0', 'a1', 'a2', 'a3', 'a4'].map((id) => ({ employeeId: id, year: 2026, month: 5, basicSalary: 8000, totalAllowances: 2000, overtimeCost: id === 'a0' ? 300 : 0, gosiEmployer: 1175 })),
      { employeeId: 'a0', year: 2024, month: 5, basicSalary: 1, totalAllowances: 1, overtimeCost: 1, gosiEmployer: 1 }, // outside
    ],
    overtimeRequests: [
      { employeeId: 'a0', date: D('2026-05-10'), hours: 6, type: 'HOURS' },
      { employeeId: 'a1', date: D('2026-05-11'), hours: 0, amount: 200, type: 'LUMP_SUM' },
    ],
    govFees: [
      { employeeId: 'l2', documentType: 'IQAMA', amount: 9700, paidAt: D('2025-09-01') },
      { employeeId: 'l2', documentType: 'PASSPORT', amount: 500, paidAt: D('2025-09-01') }, // not a government fee of this metric
    ],
    recruitmentCost: { saudi: null, expat: 4000 },
  };
  const r = computeBenchmarks(input, { asOf: ASOF, months: 12 });
  // The same data without the minimum group size: the raw values behind the small-count suppression.
  const raw = computeBenchmarks(input, { asOf: ASOF, months: 12, minGroupSize: 1 });

  it('absence rate = absent ÷ (present + absent) of the recorded days in scope and period', () => {
    expect(raw.absence.rate).toMatchObject({ numerator: 2, denominator: 40, value: 5 });
    expect(r.absence.series.find((s) => s.month === '2026-05')).toMatchObject({ suppressed: true, value: null }); // 1 person
  });

  it('sick days per employee: overlap-prorated days ÷ average headcount', () => {
    // 10 + 20 × 10/20 = 20 days; 20 / 18.1667 = 1.1009
    expect(r.absence.sickDaysPerEmployee.numerator).toBe(20);
    expect(r.absence.sickDaysPerEmployee.value).toBe(1.1);
    expect(leaveDaysInPeriod({ employeeId: 'x', leaveType: 'SICK', startDate: D('2025-06-21'), endDate: D('2025-07-10'), totalDays: 20 }, D('2025-07-01'), ASOF)).toBe(10);
  });

  it('end of service actually paid vs the engine art. 84 accrual (PAID only)', () => {
    // l1: 2020-01-01 → 2025-12-31 = 6 years, wage 8,000 + 2,000 → 0.5×5×10,000 + 1×10,000 = 35,000 accrued; 30,000 paid.
    expect(raw.endOfService.paidPerExit).toMatchObject({ numerator: 30000, denominator: 1, value: 30000 });
    expect(raw.endOfService.paidVsAccrued).toMatchObject({ numerator: 30000, denominator: 35000, value: 85.71 });
    expect(raw.endOfService.paidPerExit.dataQuality.some((q) => q.includes('لم تُدفع'))).toBe(true);
  });

  it('cost of turnover = EOSB + leave payout + recruitment assumption (only where entered)', () => {
    // 30,000 + 5,000 + 3 expat exits × 4,000 = 47,000; per exit 47,000 / 3.
    expect(raw.turnoverCost.total).toMatchObject({ value: 47000 });
    expect(raw.turnoverCost.total.extra).toEqual({ eosbPaid: 30000, leavePaid: 5000, recruitment: 12000 });
    expect(raw.turnoverCost.perExit).toMatchObject({ denominator: 3, value: 15666.67 });
  });

  it('cost per employee per month from approved / paid payroll; overtime from payroll and approved requests', () => {
    // (8,000 + 2,000 + 1,175) × 5 + 300 = 56,175 over 5 rows.
    expect(r.costPerEmployee.perMonth).toMatchObject({ numerator: 56175, denominator: 5, value: 11235 });
    expect(r.overtime.cost).toMatchObject({ numerator: 300, value: 25 });
    expect(r.overtime.hours.value).toBe(6);
    expect(r.overtime.hours.dataQuality.some((q) => q.includes('مقطوع'))).toBe(true);
  });

  it('government fees per expat per year (lump sums, approximate); expat group below 5 is suppressed', () => {
    expect(r.govFees.perExpatPerYear.value).toBeNull();
    expect(r.govFees.perExpatPerYear.reason).toContain(SUPPRESSED_TEXT);
    const expats = Array.from({ length: 5 }, (_, i) => emp(`e${i}`, { nationality: 'هندي' }));
    const g = computeBenchmarks({ ...emptyInput(expats), govFees: [{ employeeId: 'e0', documentType: 'IQAMA', amount: 10000, paidAt: D('2026-01-10') }, { employeeId: 'e1', documentType: 'IQAMA_RENEWAL', amount: 5000, paidAt: D('2026-02-10') }] }, { asOf: ASOF, months: 6 });
    // 15,000 / 5 expats × 12 / 6 = 6,000 per expat per year
    expect(g.govFees.perExpatPerYear).toMatchObject({ numerator: 15000, denominator: 5, value: 6000, approximate: true });
  });

  it('a scope below 5 people shows no metric at all', () => {
    const small = computeBenchmarks({ ...emptyInput([emp('s1'), emp('s2'), emp('s3')]), attendance: [{ employeeId: 's1', month: '2026-06', present: 1, absent: 1 }] }, { asOf: ASOF, months: 12 });
    expect(small.scopeSuppressed).toBe(true);
    expect(small.absence.rate).toMatchObject({ value: null, numerator: null, denominator: null, reason: SCOPE_SUPPRESSED_REASON });
    expect(small.turnover.overall.value).toBeNull();
    expect(small.turnover.byDepartment).toEqual([]);
    expect(small.absence.series).toEqual([]);
    expect(small.headcount.average).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Review of Phase 3: small-count metrics, the generalized complementary rule and sub-scope differencing
// ---------------------------------------------------------------------------

describe('small counts and complementary suppression (review P3)', () => {
  const g = (key: string, size: number) => ({ key, label: key, size, value: size, numerator: size, denominator: size });

  it('suppressed groups together below 5 → the next smallest groups are hidden too', () => {
    // 2 + 2 = 4 < 5: total − the others would reveal the pair; c (7) is hidden with them, d stays.
    expect(suppressGroups([g('a', 2), g('b', 2), g('c', 7), g('d', 20)]).map((x) => x.suppressedText)).toEqual([SUPPRESSED_TEXT, SUPPRESSED_TEXT, COMPLEMENTARY_SUPPRESSED_TEXT, null]);
    // 4 + 3 = 7 ≥ 5: nothing extra (unchanged).
    expect(suppressGroups([g('a', 4), g('b', 3), g('c', 20)]).map((x) => x.suppressedText)).toEqual([SUPPRESSED_TEXT, SUPPRESSED_TEXT, null]);
  });

  it('per-case / per-person metrics on fewer than 5 cases are hidden «أقل من 5 حالات», counts included', () => {
    const staff = workforce();
    const r = computeBenchmarks(
      {
        ...emptyInput(staff),
        attendance: [{ employeeId: 'a0', month: '2026-05', present: 18, absent: 2 }],
        settlements: [{ employeeId: 'l1', type: 'END_OF_SERVICE', status: 'PAID', endOfServiceAmount: 30000, leaveCompensation: 5000, terminationReason: 'RESIGNATION', lastWorkingDate: D('2025-12-31'), createdAt: D('2026-01-05') }],
        jobRequests: [
          { id: 'j1', createdAt: D('2026-01-01'), fulfilledAt: D('2026-01-31') },
          { id: 'j2', createdAt: D('2026-02-01'), fulfilledAt: D('2026-03-01'), hiredAt: D('2026-02-11') },
        ],
      },
      { asOf: ASOF, months: 12 },
    );
    expect(r.scopeSuppressed).toBe(false);
    for (const m of [r.endOfService.paidPerExit, r.endOfService.paidVsAccrued, r.tenure.leavers, r.turnoverCost.perExit, r.turnoverCost.total, r.timeToHire, r.absence.rate]) {
      expect(m).toMatchObject({ value: null, numerator: null, denominator: null, reason: SMALL_COUNT_REASON });
      expect(m.dataQuality.some((q) => /\d/.test(q))).toBe(false);
      if (m.extra) expect(Object.values(m.extra).every((v) => v === null)).toBe(true);
    }
    // 16 employees at the end of the period, 18.17 on average: not small, still shown.
    expect(r.tenure.active.value).not.toBeNull();
    expect(r.turnover.overall.value).toBe(16.51);
  });
});

describe('scopeDisclosure: no recovery of a small group by subtraction (review P3)', () => {
  // Company X: A 8, B 6, C 3 (all in branch br1); company Y: D 10 (branch br2). 12 months to 30 Jun 2026.
  const person = (id: string, legalCompanyId: string, branchId: string, departmentId: string, o: Partial<BmPopulationEmployee> = {}): BmPopulationEmployee => ({
    id,
    joinDate: D('2020-01-01'),
    isTerminated: false,
    terminationDate: null,
    legalCompanyId,
    branchId,
    departmentId,
    ...o,
  });
  const many = (prefix: string, n: number, co: string, br: string, dept: string, o: Partial<BmPopulationEmployee> = {}) => Array.from({ length: n }, (_, i) => person(`${prefix}${i}`, co, br, dept, o));
  const org = [...many('a', 8, 'X', 'br1', 'A'), ...many('b', 6, 'X', 'br1', 'B'), ...many('c', 3, 'X', 'br1', 'C'), ...many('d', 10, 'Y', 'br2', 'D')];
  const dis = (f: Parameters<typeof scopeDisclosure>[1], pop = org) => scopeDisclosure(pop, f, ASOF, 12);

  it('(a) a scope below 5 is hidden', () => {
    expect(dis({ departmentId: 'C' })).toMatchObject({ hidden: true, reason: SCOPE_SUPPRESSED_REASON });
  });

  it('(c) the group hidden to protect C in the company breakdown is hidden when queried directly, with any filter combination', () => {
    // X by department: C (3) «أقل من 5», B (6) the smallest remaining → complementary. Company − A − B would give C.
    for (const f of [{ departmentId: 'B' }, { companyId: 'X', departmentId: 'B' }, { branchId: 'br1', departmentId: 'B' }, { companyId: 'X', branchId: 'br1', departmentId: 'B' }]) {
      expect(dis(f)).toMatchObject({ hidden: true, reason: SCOPE_COMPLEMENT_REASON });
    }
    // A is shown in the company breakdown anyway: still shown; company − A = B + C (9), not C alone.
    expect(dis({ departmentId: 'A' })).toMatchObject({ hidden: false, hiddenMonths: [] });
    expect(dis({ companyId: 'X' })).toMatchObject({ hidden: false });
    expect(dis({})).toMatchObject({ hidden: false, hiddenMonths: [] });
  });

  it('(b)/(c) the rest of a wider scope below 5 hides the scope (branch br1 = company X but 2 people)', () => {
    const pop = [...org, ...many('e', 2, 'X', 'br3', 'A')];
    expect(dis({ branchId: 'br1' }, pop)).toMatchObject({ hidden: true, reason: SCOPE_COMPLEMENT_REASON });
    expect(dis({ companyId: 'X', branchId: 'br1' }, pop)).toMatchObject({ hidden: true, reason: SCOPE_COMPLEMENT_REASON });
  });

  it('monthly series: a month is hidden when the rest of the wider scope is below 5 that month', () => {
    // B: 6 people, 3 of them leave on 15 May 2026 → B ≥ 5 on average (5.5), 3 at the end of May and June.
    const pop = [
      ...many('a', 8, 'X', 'br1', 'A'),
      ...many('b', 3, 'X', 'br1', 'B'),
      ...many('bx', 3, 'X', 'br1', 'B', { isTerminated: true, terminationDate: D('2026-05-15') }),
      ...many('d', 10, 'Y', 'br2', 'D'),
    ];
    const d = dis({ departmentId: 'A' }, pop);
    expect(d.hidden).toBe(false);
    expect(d.hiddenMonths).toEqual(['2026-05', '2026-06']);
    // Applied to every monthly series of the scope's result.
    const staff: BmEmployee[] = many('a', 8, 'X', 'br1', 'A').map((e) => ({ ...e, nationality: 'سعودي' }));
    const r = computeBenchmarks({ ...emptyInput(staff), attendance: staff.map((e) => ({ employeeId: e.id, month: '2026-05', present: 20, absent: 1 })) }, { asOf: ASOF, months: 12, disclosure: d });
    expect(r.turnover.series.filter((x) => x.suppressed).map((x) => x.month)).toEqual(['2026-05', '2026-06']);
    expect(r.turnover.series.find((x) => x.month === '2026-05')).toMatchObject({ value: null, numerator: null, denominator: null });
    expect(r.absence.series.find((x) => x.month === '2026-05')).toMatchObject({ suppressed: true, value: null, numerator: null });
    expect(r.overtime.series.find((x) => x.month === '2026-06')).toMatchObject({ suppressed: true, hours: null, cost: null });
    expect(r.turnover.series.find((x) => x.month === '2026-04')).toMatchObject({ suppressed: false, denominator: 8 });
  });

  it('a hidden disclosure hides the whole result with its reason', () => {
    const staff = many('b', 6, 'X', 'br1', 'B').map((e) => ({ ...e, nationality: 'سعودي' }) as BmEmployee);
    const r = computeBenchmarks(emptyInput(staff), { asOf: ASOF, months: 12, disclosure: dis({ departmentId: 'B' }) });
    expect(r.scopeSuppressed).toBe(true);
    expect(r.turnover.overall).toMatchObject({ value: null, numerator: null, reason: SCOPE_COMPLEMENT_REASON });
    expect(r.turnover.series).toEqual([]);
    expect(r.headcount.average).toBe(0);
  });
});
