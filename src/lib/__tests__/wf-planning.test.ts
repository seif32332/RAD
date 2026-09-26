// Workforce plan («خطة القوى العاملة», src/lib/workforce/planning.ts). Hand-computed: a hire from mid-plan,
// a backfill after an exit, the exit one-off (EOSB) and the provision release, raises by pct / amount and
// scope, the attrition line and the trailing turnover rate, plan vs actual with a partial month and exact
// drivers, the maker-checker rules, the Nitaqat / localization effects and determinism.
import { describe, expect, it } from 'vitest';
import {
  arabicMonths,
  decidePlanAction,
  planVsActual,
  projectPlan,
  planTurnover,
  comparePlanProjections,
  type PayrollActualRow,
  type PlanBaseInput,
  type PlanDefinition,
  type PlanPositionInput,
  type PlanRaiseInput,
} from '@/lib/workforce/planning';
import { computeExitCost } from '@/lib/workforce/exit-cost';
import { computeTrueCost } from '@/lib/workforce/true-cost';
import { nitaqatEstimate, type NitaqatActivityRow, type NitaqatCurveRow } from '@/lib/workforce/nitaqat';
import type { LocalizationDecisionRow } from '@/lib/workforce/saudization';
import type { WfEmployeeInput } from '@/lib/workforce';
import { COMPANY, SEED_GOSI, SEED_RULES, assume, d, emp } from './wf-fixtures';

const base = (employees: WfEmployeeInput[], over: Partial<PlanBaseInput> = {}): PlanBaseInput => ({
  employees,
  companies: [COMPANY],
  rules: SEED_RULES,
  gosiRates: SEED_GOSI,
  assumptions: [],
  ...over,
});

const plan = (over: Partial<PlanDefinition> = {}): PlanDefinition => ({
  id: 'plan-1',
  name: 'خطة 2027',
  companyId: 'c1',
  fromMonth: '2027-01',
  months: 12,
  attritionPct: 0,
  positions: [],
  raises: [],
  ...over,
});

const hire = (over: Partial<PlanPositionInput> = {}): PlanPositionInput => ({
  id: 'p-hire',
  kind: 'NEW_HIRE',
  title: 'محاسب',
  nationalityClass: 'EXPAT',
  basicSalary: 3000,
  startMonth: '2027-07',
  ...over,
});

const saudiA = () => emp({ id: 'a', name: 'أحمد', basicSalary: 10000, departmentId: 'd1', joinDate: d('2020-01-01'), qiwaContractDocumented: true });

describe('projectPlan — hires, backfills, exits', () => {
  it('a hire from mid-plan: basic 3,000 × 6, GOSI 2% × 3,000 × 6, levy 700 × 6, head count 1 → 2', () => {
    const p = projectPlan(base([saudiA()]), plan({ positions: [hire()] }));
    const item = p.items[0];
    const line = (k: string) => item.lines.find((l) => l.key === k)?.amount;
    expect(item.start).toBe('2027-07');
    expect(line('BASIC')).toBe(18000);
    expect(line('GOSI_EMPLOYER')).toBe(360);
    expect(line('EXPAT_LEVY')).toBe(4200);
    expect(p.series.map((m) => m.headcount.total)).toEqual([1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2]);
    expect(p.series[6].headcount).toMatchObject({ saudi: 1, expat: 1, hires: 1 });
    expect(p.series.map((m) => m.levy)).toEqual([0, 0, 0, 0, 0, 0, 700, 700, 700, 700, 700, 700]);
    // Equal to a direct true cost engine call with the same hypothetical employee.
    const tc = computeTrueCost(
      { employees: [saudiA(), { id: 'plan:p-hire', name: 'محاسب', nationality: 'وافد', gender: 'MALE', dateOfBirth: null, joinDate: d('2027-07-01'), basicSalary: 3000, allowances: [], gosiRegime: null, legalCompanyId: 'c1', contractType: 'FULL_TIME', dependentsCount: 0, isPlanned: true, qiwaContractDocumented: true }],
        companies: [COMPANY], rules: SEED_RULES, gosiRates: SEED_GOSI, assumptions: [] },
      { startMonth: '2027-01', months: 12, employeeIds: ['a', 'plan:p-hire'] },
    );
    expect(p.series.map((m) => m.cost)).toEqual(tc.series.map((m) => m.cost));
    expect(item.windows['12']).toEqual(tc.employees.find((r) => r.employeeId === 'plan:p-hire')!.totals.next12);
    // The plan adds exactly the hire (baseline = the Saudi alone).
    expect(p.totals['12']!.deltaAfterHrdf).toBe(item.windows['12']!.net);
  });

  it('a backfill after an exit starts in the exit month (handover), the leaver stops after it', () => {
    const b = emp({ id: 'b', name: 'بندر', basicSalary: 6000, joinDate: d('2022-01-01'), qiwaContractDocumented: true });
    const p = projectPlan(
      base([saudiA(), b]),
      plan({
        positions: [
          { id: 'x1', kind: 'EXIT', title: 'خروج بندر', exitEmployeeId: 'b', exitMonth: '2027-03', exitReason: 'RESIGNATION' },
          { id: 'bf', kind: 'BACKFILL', title: 'بديل بندر', exitEmployeeId: 'b', nationalityClass: 'SAUDI', basicSalary: 7000, startMonth: '2027-01' },
        ],
      }),
    );
    const bf = p.items.find((i) => i.positionId === 'bf')!;
    expect(bf.start).toBe('2027-03');
    expect(bf.exit).toBe('2027-03');
    expect(bf.lines.find((l) => l.key === 'BASIC')!.amount).toBe(7000 * 10);
    expect(bf.why.join(' ')).toContain('شهر تسليم');
    // Head count: 2, 2, 3 (handover), then 2.
    expect(p.series.map((m) => m.headcount.total)).toEqual([2, 2, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
    expect(p.series[3].headcount.plannedExits).toBe(1);
    const x = p.items.find((i) => i.positionId === 'x1')!;
    expect(x.lastWorkingDate).toBe('2027-03-31');
    // The leaver's saving = 9 months of his basic (and the other lines).
    expect(x.lines.find((l) => l.key === 'BASIC')!.amount).toBe(-6000 * 9);
    // A new Saudi hire (NEW regime) at 7,000 is not below the Nitaqat threshold: no wage flag.
    expect(p.flags.some((f) => f.code === 'SAUDI_WAGE_BELOW_NITAQAT')).toBe(false);
  });

  it('exit one-off: employer termination after exactly 5 years = 2.5 × 8,000 = 20,000; the 6-month provision (2,000) is released', () => {
    const e = emp({ id: 'e', name: 'إبراهيم', basicSalary: 8000, joinDate: d('2022-01-01'), leaveAccrualStartDate: d('2026-12-31') });
    const pos: PlanPositionInput = { id: 'x', kind: 'EXIT', title: 'إنهاء', exitEmployeeId: 'e', exitMonth: '2026-12', exitReason: 'EMPLOYER_TERMINATION' };
    const p = projectPlan(base([e]), plan({ fromMonth: '2026-07', positions: [pos] }));
    const item = p.items[0];
    expect(item.exitCost!.lines.find((l) => l.key === 'EOSB')!.amount).toBe(20000);
    expect(item.exitCost!.lines.find((l) => l.key === 'NOTICE_PAY')!.amount).toBe(0); // notice served
    // Same number as a direct computeExitCost on the last working day.
    const direct = computeExitCost({ employee: { ...e, terminationDate: d('2026-12-31'), leaves: [], loans: [] }, reason: 'EMPLOYER_TERMINATION', lastWorkingDate: d('2026-12-31'), noticeServed: true, companyEmployees: [e], company: COMPANY, rules: SEED_RULES, gosiRates: SEED_GOSI, assumptions: [], salaryBasis: 'total' });
    expect(item.exitCost!.payable).toBe(direct.totals.payable);
    // EOSB liability 2026-06-30 = 8,000 × 0.5 × 4.5 = 18,000; 2026-12-31 = 20,000: accrued in the plan 2,000.
    expect(item.exitCost!.accrualRelease).toBe(-2000);
    expect(p.series[5].exitOneOff).toBe(direct.totals.payable);
    expect(p.series[5].exitAccrualRelease).toBe(-2000);
    expect(p.series[0].exitOneOff).toBe(0);
    expect(p.totals.horizon!.totalBeforeHrdf).toBe(Math.round((p.totals.horizon!.cost + direct.totals.payable - 2000) * 100) / 100);
    expect(p.flags.some((f) => f.code === 'EXIT_DETAILS_MISSING')).toBe(true);
  });
});

describe('projectPlan — raises', () => {
  it('10% for department d1 from April and +500 for everyone from July', () => {
    const b = emp({ id: 'b', name: 'بدر', basicSalary: 5000, departmentId: 'd2', joinDate: d('2021-01-01') });
    const raises: PlanRaiseInput[] = [
      { id: 'r1', scope: 'DEPARTMENT', scopeId: 'd1', pct: 10, effectiveMonth: '2027-04' },
      { id: 'r2', scope: 'ALL', amount: 500, effectiveMonth: '2027-07' },
    ];
    const p = projectPlan(base([saudiA(), b]), plan({ raises }));
    // A: 3 × 10,000 + 3 × 11,000 + 6 × 11,500 = 132,000. B: 6 × 5,000 + 6 × 5,500 = 63,000.
    const basic = p.composition.find((c) => c.key === 'BASIC')!.horizon;
    expect(basic).toBe(132000 + 63000);
    const r1 = p.raises.find((r) => r.raiseId === 'r1')!;
    const r2 = p.raises.find((r) => r.raiseId === 'r2')!;
    expect(r1).toMatchObject({ employees: 1, basicDeltaMonthly: 1000, basicDeltaTotal: 9000 });
    expect(r2).toMatchObject({ employees: 2, basicDeltaMonthly: 1000, basicDeltaTotal: 6000 });
    // Raises effect (all lines) ≥ the basic delta (GOSI and EOSB follow the basic).
    expect(p.raisesEffect['12']!.cost).toBeGreaterThan(15000);
    // The organisation's annual raise assumption does not apply inside a plan.
    const withAssumption = projectPlan(base([saudiA(), b], { assumptions: [assume('ANNUAL_RAISE_PCT', 5)] }), plan({ raises, fromMonth: '2026-12', months: 12 }));
    expect(withAssumption.flags.some((f) => f.code === 'ANNUAL_RAISE_REPLACED')).toBe(true);
  });

  it('a raise does not reach an employee who joins on/after its month, nor a hire starting after it', () => {
    const late = emp({ id: 'late', basicSalary: 4000, joinDate: d('2027-05-10') });
    const p = projectPlan(base([saudiA(), late]), plan({ raises: [{ id: 'r', scope: 'ALL', pct: 10, effectiveMonth: '2027-05' }], positions: [hire({ startMonth: '2027-02', basicSalary: 3000 }), hire({ id: 'p2', startMonth: '2027-06' })] }));
    // a (10,000 -> 11,000) and the hire of February (3,000 -> 3,300): 1,000 + 300.
    expect(p.raises[0]).toMatchObject({ employees: 2, basicDeltaMonthly: 1300 });
    expect(p.items.find((i) => i.positionId === 'p2')!.lines.find((l) => l.key === 'BASIC')!.amount).toBe(3000 * 7);
  });
});

describe('attrition and turnover', () => {
  it('planTurnover (the internal-benchmarks definition): 1 exit ÷ mean month-end head count 9.17 = 10.91%', () => {
    const list = [
      ...Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, joinDate: d('2020-01-01') })),
      { id: 'leaver', joinDate: d('2020-01-01'), terminationDate: d('2026-03-15'), isTerminated: true },
      { id: 'joiner', joinDate: d('2026-01-01') },
      { id: 'old', joinDate: d('2020-01-01'), terminationDate: d('2025-06-01'), isTerminated: true },
    ];
    // Month ends Oct 2025 .. Sep 2026: 8 × 12 + leaver 5 (Oct–Feb) + joiner 9 (Jan–Sep) = 110 ÷ 12 = 9.17.
    const t = planTurnover(list, d('2026-09-30'));
    expect(t).toMatchObject({ from: '2025-10-01', to: '2026-09-30', leavers: 1, avgHeadcount: 9.17, ratePct: 10.91 });
    // Below 5 on average: no rate (same privacy rule as «المؤشرات الداخلية»).
    expect(planTurnover(list.slice(0, 3), d('2026-09-30')).ratePct).toBeNull();
  });

  it('the attrition line = −(1 − (1 − 12%)^(i/12)) × the current employees’ cost, separate from the named head count', () => {
    const p = projectPlan(base([saudiA()]), plan({ attritionPct: 12, positions: [hire()] }));
    const a = p.series;
    expect(a[0].attrition.cost).toBe(0);
    for (const i of [1, 6, 11]) {
      // The current employees without a planned exit = the baseline here (no raise, no exit): Ahmad alone.
      const f = 1 - Math.pow(0.88, i / 12);
      expect(a[i].attrition.cost).toBe(Math.round(-f * a[i].baseline.cost * 100) / 100);
      expect(a[i].attrition.subsidy).toBeCloseTo(-f * a[i].baseline.subsidy, 2);
      expect(a[i].headcount.total).toBe(i >= 6 ? 2 : 1);
      expect(a[i].expectedLeavers).toBeCloseTo(1 - Math.pow(0.88, i / 12), 2);
    }
    expect(p.totals['12']!.totalBeforeHrdf).toBeCloseTo(p.totals['12']!.cost + p.totals['12']!.attrition.cost, 2);
    expect(p.attrition).toMatchObject({ pct: 12, source: 'PLAN' });
  });

  it('attritionPct null = the actual trailing rate up to turnoverAsOf', () => {
    const e = saudiA();
    const p = projectPlan(
      base([e], { turnoverEmployees: [...['a', 'b', 'c', 'e', 'f'].map((id) => ({ id, joinDate: d('2020-01-01'), legalCompanyId: 'c1' })), { id: 'z', joinDate: d('2020-01-01'), terminationDate: d('2026-06-30'), isTerminated: true, legalCompanyId: 'c1' }] }),
      plan({ attritionPct: null }),
      { turnoverAsOf: d('2026-12-31') },
    );
    // Month ends of 2026: 6 × 6 (Jan–Jun) + 5 × 6 = 66 ÷ 12 = 5.5; 1 exit ÷ 5.5 = 18.18%.
    expect(p.attrition).toMatchObject({ pct: 18.18, source: 'ACTUAL' });
    expect(p.flags.some((f) => f.code === 'ATTRITION_DEFAULT')).toBe(true);
  });
});

describe('plan vs actual', () => {
  it('partial month (no stored employer GOSI) compares without GOSI; drivers add up to the variance', () => {
    const a = emp({ id: 'a', name: 'أحمد', basicSalary: 8000, joinDate: d('2020-01-01') });
    const def = plan({ fromMonth: '2026-07', positions: [hire({ id: 'h', startMonth: '2026-08', basicSalary: 3000 })] });
    const p = projectPlan(base([a]), def);
    // Planned: A 8,000 + GOSI 11.75% (940) = 8,940; the expat hire 3,000 + 2% (60) = 3,060 from August.
    expect(p.people.find((x) => x.id === 'a')!.comparable.slice(0, 2)).toEqual([8940, 8940]);
    expect(p.people.find((x) => x.kind === 'HIRE')!.comparable.slice(0, 2)).toEqual([0, 3060]);
    const row = (employeeId: string, month: number, over: Partial<PayrollActualRow>): PayrollActualRow => ({ employeeId, year: 2026, month, status: 'APPROVED', basicSalary: 0, totalAllowances: 0, overtimeCost: 0, gosiEmployer: 0, bonusAmount: 0, ...over });
    const rows: PayrollActualRow[] = [
      row('a', 7, { basicSalary: 8000 }), // legacy row: gosiEmployer not stored
      row('a', 8, { basicSalary: 8500, gosiEmployer: 998.75, overtimeCost: 200 }),
      row('j', 8, { basicSalary: 3200, gosiEmployer: 64 }),
      row('k', 8, { basicSalary: 5000, gosiEmployer: 587.5, status: 'PAID' }),
      row('k', 9, { basicSalary: 5000, gosiEmployer: 587.5, status: 'DRAFT' }), // not counted
    ];
    const employees = [
      { id: 'a', name: 'أحمد', joinDate: d('2020-01-01'), legalCompanyId: 'c1', nationality: 'سعودي' },
      { id: 'j', name: 'جون', joinDate: d('2026-08-01'), legalCompanyId: 'c1', nationality: 'هندي' },
      { id: 'k', name: 'خالد', joinDate: d('2026-08-15'), legalCompanyId: 'c1', nationality: 'سعودي' },
    ];
    const r = planVsActual(def, p, rows, d('2026-09-30'), { employees });
    expect(r.monthsWithoutPayroll).toEqual(['2026-09']);
    const [jul, aug] = r.months;
    expect(jul).toMatchObject({ month: '2026-07', partial: true, planned: 8000, actual: 8000, variance: 0 });
    // August: planned 8,940 + 3,060 = 12,000; actual (8,500 + 998.75 + 200) + (3,200 + 64) + (5,000 + 587.5) = 18,550.25.
    expect(aug).toMatchObject({ month: '2026-08', partial: false, planned: 12000, actual: 18550.25, variance: 6550.25, plannedHeadcount: 2, actualHeadcount: 3 });
    expect(aug.drivers).toEqual({ SALARY_DIFF: 558.75, HIRE_FILLED_DIFF: 204, OVERTIME_BONUS: 200, UNPLANNED_HIRE: 5587.5 });
    const sum = Object.values(aug.drivers).reduce((s, v) => s + (v ?? 0), 0);
    expect(Math.round(sum * 100) / 100).toBe(aug.variance);
    expect(r.cumulative).toMatchObject({ planned: 20000, actual: 26550.25, variance: 6550.25, partial: true, months: 2 });
    expect(r.drivers.find((x) => x.key === 'UNPLANNED_HIRE')!.people[0]).toMatchObject({ id: 'k', name: 'خالد', amount: 5587.5 });
  });

  it('a planned hire not done and an unplanned exit are negative drivers', () => {
    const a = emp({ id: 'a', basicSalary: 8000, joinDate: d('2020-01-01') });
    const b = emp({ id: 'b', nationality: 'هندي', gosiRegime: null, basicSalary: 4000, joinDate: d('2020-01-01') });
    const def = plan({ fromMonth: '2026-07', positions: [hire({ id: 'h', startMonth: '2026-07' })] });
    const p = projectPlan(base([a, b]), def);
    const rows: PayrollActualRow[] = [{ employeeId: 'a', year: 2026, month: 7, status: 'PAID', basicSalary: 8000, totalAllowances: 0, overtimeCost: 0, gosiEmployer: 940, bonusAmount: 0 }];
    const r = planVsActual(def, p, rows, d('2026-07-31'), { employees: [{ id: 'a', name: 'أ', joinDate: d('2020-01-01') }, { id: 'b', name: 'ب', joinDate: d('2020-01-01'), terminationDate: d('2026-06-30'), isTerminated: true }] });
    expect(r.months[0].drivers).toEqual({ UNPLANNED_EXIT: -4080, PLANNED_HIRE_NOT_DONE: -3060 });
    expect(r.months[0].variance).toBe(-7140);
  });
});

describe('maker-checker', () => {
  const at = (action: Parameters<typeof decidePlanAction>[0]['action'], status: string, actorId: string, actorRole: string) =>
    decidePlanAction({ action, status, actorId, actorRole, createdById: 'hr', submittedById: status === 'SUBMITTED' ? 'fin' : null });
  it('submit by HR / finance / owners; approve only by an owner other than the submitter and the creator', () => {
    expect(at('SUBMIT', 'DRAFT', 'hr', 'HR_MANAGER')).toEqual({ ok: true, nextStatus: 'SUBMITTED' });
    expect(at('SUBMIT', 'REJECTED', 'fin', 'FINANCE_MANAGER')).toEqual({ ok: true, nextStatus: 'SUBMITTED' });
    expect(at('SUBMIT', 'DRAFT', 'x', 'EMPLOYEE')).toMatchObject({ ok: false, httpStatus: 403 });
    expect(at('SUBMIT', 'APPROVED', 'hr', 'HR_MANAGER')).toMatchObject({ ok: false, httpStatus: 409 });
    expect(at('APPROVE', 'SUBMITTED', 'hrm', 'HR_MANAGER')).toMatchObject({ ok: false, httpStatus: 403 });
    expect(at('APPROVE', 'SUBMITTED', 'owner', 'COMPANY_ADMIN')).toEqual({ ok: true, nextStatus: 'APPROVED' });
    expect(at('REJECT', 'SUBMITTED', 'owner', 'SUPER_ADMIN')).toEqual({ ok: true, nextStatus: 'REJECTED' });
    expect(decidePlanAction({ action: 'APPROVE', status: 'SUBMITTED', actorId: 'boss', actorRole: 'SUPER_ADMIN', createdById: 'hr', submittedById: 'boss' })).toMatchObject({ ok: false, httpStatus: 403 });
    expect(decidePlanAction({ action: 'APPROVE', status: 'SUBMITTED', actorId: 'boss', actorRole: 'SUPER_ADMIN', createdById: 'boss', submittedById: 'hr' })).toMatchObject({ ok: false, httpStatus: 403 });
    expect(decidePlanAction({ action: 'APPROVE', status: 'SUBMITTED', actorId: 'boss', actorRole: 'SUPER_ADMIN', createdById: 'hr', submittedById: null })).toMatchObject({ ok: false, httpStatus: 409 });
    expect(at('APPROVE', 'DRAFT', 'owner', 'COMPANY_ADMIN')).toMatchObject({ ok: false, httpStatus: 409 });
  });
  it('approved plans are read-only; archive rules; copy', () => {
    expect(at('EDIT', 'APPROVED', 'owner', 'SUPER_ADMIN')).toMatchObject({ ok: false, httpStatus: 409 });
    expect(at('EDIT', 'SUBMITTED', 'hr', 'HR_MANAGER')).toMatchObject({ ok: false, httpStatus: 409 });
    expect(at('EDIT', 'REJECTED', 'hr', 'HR_MANAGER')).toEqual({ ok: true, nextStatus: 'REJECTED' });
    expect(at('ARCHIVE', 'APPROVED', 'hr', 'HR_MANAGER')).toMatchObject({ ok: false, httpStatus: 403 });
    expect(at('ARCHIVE', 'APPROVED', 'owner', 'COMPANY_ADMIN')).toEqual({ ok: true, nextStatus: 'ARCHIVED' });
    expect(at('ARCHIVE', 'SUBMITTED', 'owner', 'COMPANY_ADMIN')).toMatchObject({ ok: false, httpStatus: 409 });
    expect(at('ARCHIVE', 'DRAFT', 'fin', 'FINANCE_MANAGER')).toEqual({ ok: true, nextStatus: 'ARCHIVED' });
    expect(at('COPY', 'APPROVED', 'fin', 'FINANCE_MANAGER')).toEqual({ ok: true, nextStatus: 'DRAFT' });
    expect(at('COPY', 'APPROVED', 'x', 'GOV_RELATIONS')).toMatchObject({ ok: false, httpStatus: 403 });
  });
});

describe('Nitaqat, localization and flags', () => {
  const BIZ: NitaqatActivityRow = { key: 'test-biz', nameAr: 'خدمات الاعمال', code: '481', status: 'VERIFIED_PRIMARY', page: 14 };
  const M = [1.03, 1.03, 2.19, 2.19];
  const C: Record<number, number[]> = { 2026: [33.78, 42.62, 43.62, 54.82], 2027: [36.78, 45.62, 46.62, 57.82], 2028: [39.78, 48.62, 49.62, 60.82] };
  const CURVES: NitaqatCurveRow[] = [2026, 2027, 2028].flatMap((year) => (['LOW_GREEN', 'MEDIUM_GREEN', 'HIGH_GREEN', 'PLATINUM'] as const).map((band, i) => ({ activityKey: 'test-biz', band, year, m: M[i], c: C[year][i], status: 'VERIFIED_PRIMARY' })));
  const CO = { ...COMPANY, nitaqatActivityKey: 'test-biz' };
  const saudi = (id: string, over: Partial<WfEmployeeInput> = {}) => emp({ id, basicSalary: 6000, qiwaContractDocumented: true, joinDate: d('2022-01-01'), ...over });
  const expat = (id: string, over: Partial<WfEmployeeInput> = {}) => emp({ id, nationality: 'هندي', gosiRegime: null, basicSalary: 3000, joinDate: d('2022-01-01'), ...over });

  it('year-end Nitaqat equals a direct estimate of the planned workforce; an exit that drops the band is flagged', () => {
    const emps = [...['s1', 's2', 's3', 's4'].map((i) => saudi(i)), ...Array.from({ length: 6 }, (_, i) => expat(`x${i}`))];
    const def = plan({ positions: [{ id: 'out', kind: 'EXIT', title: 'خروج', exitEmployeeId: 's1', exitMonth: '2027-02', exitReason: 'RESIGNATION' }, hire({ id: 'lowsaudi', nationalityClass: 'SAUDI', basicSalary: 3500 })] });
    const p = projectPlan(base(emps, { companies: [CO], nitaqat: { activities: [BIZ], curves: CURVES } }), def);
    const y1 = p.companies[0].years[0];
    const planned = [...emps.filter((e) => e.id !== 's1'), { ...emps[0], terminationDate: d('2027-02-28') }];
    const direct = nitaqatEstimate({ companyId: 'c1', companyName: CO.name, activity: BIZ, curves: CURVES, employees: [...planned, { id: 'plan:lowsaudi', name: 'x', nationality: 'سعودي', gender: 'MALE', joinDate: d('2027-07-01'), basicSalary: 3500, allowances: [], legalCompanyId: 'c1', isPlanned: true, qiwaContractDocumented: true }] }, d('2027-12-31'), { average: false });
    expect(y1.nitaqat!.plan).toMatchObject({ band: direct.band, pct: direct.pct, x: direct.counts.x });
    expect(y1.nitaqat!.baseline.x).toBe(10);
    expect(p.flags.find((f) => f.code === 'SAUDI_WAGE_BELOW_NITAQAT')?.message).toContain('0.5');
    if (y1.nitaqat!.change === 'DOWN') expect(p.flags.some((f) => f.code === 'NITAQAT_BAND_DROP')).toBe(true);
  });

  it('an exit that creates a localization shortfall is flagged on the position', () => {
    const ACCT: LocalizationDecisionRow = { id: 'acct', groupNameAr: 'مهن المحاسبة', occupationsJson: JSON.stringify(['محاسب']), phasesJson: JSON.stringify([{ pct: 40, effectiveFrom: '2025-10-27' }]), minEstablishmentSize: null, minWage: null, status: 'VERIFIED_PRIMARY' };
    const emps = [saudi('s1', { occupationName: 'محاسب' }), saudi('s2', { occupationName: 'محاسب' }), ...['x1', 'x2', 'x3'].map((i) => expat(i, { occupationName: 'محاسب' }))];
    const def = plan({ positions: [{ id: 'out', kind: 'EXIT', title: 'خروج محاسب', exitEmployeeId: 's1', exitMonth: '2027-03', exitReason: 'RESIGNATION' }] });
    const p = projectPlan(base(emps, { decisions: [ACCT] }), def);
    const f = p.items[0].flags.find((x) => x.code === 'EXIT_LOCALIZATION_SHORTFALL');
    expect(f?.message).toContain('مهن المحاسبة');
    // With a Saudi accountant backfill in the same month there is no shortfall.
    const p2 = projectPlan(base(emps, { decisions: [ACCT] }), plan({ positions: [...def.positions, { id: 'bf', kind: 'BACKFILL', title: 'بديل', exitEmployeeId: 's1', nationalityClass: 'SAUDI', basicSalary: 7000, occupationName: 'محاسب', startMonth: '2027-03' }] }));
    expect(p2.flags.some((x) => x.code === 'EXIT_LOCALIZATION_SHORTFALL')).toBe(false);
  });

  it('flags: unknown leaver, backfill without exit, raise with no match, start after the plan', () => {
    const p = projectPlan(
      base([saudiA()]),
      plan({
        positions: [
          { id: 'u', kind: 'EXIT', title: 'مجهول', exitEmployeeId: 'nobody', exitMonth: '2027-02', exitReason: 'RESIGNATION' },
          { id: 'bf', kind: 'BACKFILL', title: 'بديل', exitEmployeeId: 'a', nationalityClass: 'SAUDI', basicSalary: 9000, startMonth: '2027-02' },
          hire({ id: 'late', startMonth: '2028-03' }),
        ],
        raises: [{ id: 'r', scope: 'DEPARTMENT', scopeId: 'none', pct: 5, effectiveMonth: '2027-03' }],
      }),
    );
    const codes = p.flags.map((f) => f.code).filter((c) => c !== 'NITAQAT_NOT_ESTIMATED').sort();
    expect(codes).toEqual(['BACKFILL_NO_EXIT', 'EXIT_EMPLOYEE_UNKNOWN', 'RAISE_NO_MATCH', 'START_OUTSIDE_PLAN']);
  });
});

describe('determinism and comparison', () => {
  it('same inputs (any order) → same projection; compare columns against the first', () => {
    const b = emp({ id: 'b', basicSalary: 5000, departmentId: 'd2', joinDate: d('2021-01-01') });
    const def = plan({ attritionPct: 5, positions: [hire(), hire({ id: 'p2', nationalityClass: 'SAUDI', basicSalary: 6000, startMonth: '2027-03' })], raises: [{ id: 'r', scope: 'ALL', pct: 3, effectiveMonth: '2027-06' }] });
    const p1 = projectPlan(base([saudiA(), b]), def);
    const p2 = projectPlan(base([b, saudiA()]), { ...def, positions: [...def.positions].reverse() });
    expect(JSON.stringify(p2)).toBe(JSON.stringify(p1));
    const cols = comparePlanProjections([
      { plan: { id: 'plan-1', name: 'أ', status: 'DRAFT' }, projection: p1 },
      { plan: { id: 'plan-2', name: 'ب', status: 'DRAFT' }, projection: projectPlan(base([saudiA(), b]), plan({ id: 'plan-2' })) },
    ]);
    expect(cols[0].vsFirst['12']).toBe(0);
    expect(cols[1].vsFirst['12']).toBe(Math.round((cols[1].totals['12']!.totalAfterHrdf - cols[0].totals['12']!.totalAfterHrdf) * 100) / 100);
    expect(cols[0].positions).toEqual({ NEW_HIRE: 2, BACKFILL: 0, EXIT: 0 });
  });
});

// ---------------------------------------------------------------------------
// Review of Phase 3: authors may not decide, start-month matching, Arabic month counts
// ---------------------------------------------------------------------------

describe('maker-checker: authors of the content (review P3)', () => {
  const decide = (actorId: string, authorIds: string[] | null, action: 'APPROVE' | 'REJECT' = 'APPROVE') =>
    decidePlanAction({ action, status: 'SUBMITTED', actorId, actorRole: 'SUPER_ADMIN', createdById: 'hr', submittedById: 'hr', authorIds });

  it('an owner who edited the header, a position or a raise cannot approve or reject, even if someone else submitted', () => {
    const d = decide('boss', ['boss', 'hr']);
    expect(d).toMatchObject({ ok: false, httpStatus: 403 });
    expect(d.ok ? '' : d.message).toContain('شارك في إعدادها');
    expect(decide('boss', ['boss', 'hr'], 'REJECT')).toMatchObject({ ok: false, httpStatus: 403 });
  });

  it('a different owner who authored nothing may decide', () => {
    expect(decide('owner2', ['boss', 'hr'])).toEqual({ ok: true, nextStatus: 'APPROVED' });
    expect(decide('owner2', null)).toEqual({ ok: true, nextStatus: 'APPROVED' });
  });
});

describe('plan vs actual: a joiner fills a planned hire only from one month before its start (review P3)', () => {
  const a = emp({ id: 'a', name: 'أحمد', basicSalary: 8000, joinDate: d('2020-01-01') });
  const def = plan({ fromMonth: '2026-07', positions: [hire({ id: 'h', startMonth: '2026-09', basicSalary: 3000 })] });
  const p = projectPlan(base([a]), def);
  const row = (employeeId: string, month: number, basicSalary: number, gosiEmployer: number): PayrollActualRow => ({ employeeId, year: 2026, month, status: 'PAID', basicSalary, totalAllowances: 0, overtimeCost: 0, gosiEmployer, bonusAmount: 0 });
  const rowsFor = (j: string) => [7, 8, 9].flatMap((m) => [row('a', m, 8000, 940), ...(m >= (j === 'early' ? 7 : 8) ? [row(j, m, 3000, 60)] : [])]);

  it('joined two months before the planned start → an unplanned hire; the planned hire is not done', () => {
    const r = planVsActual(def, p, rowsFor('early'), d('2026-09-30'), { employees: [{ id: 'a', name: 'أحمد', joinDate: d('2020-01-01') }, { id: 'early', name: 'مبكر', joinDate: d('2026-07-01'), nationality: 'هندي', legalCompanyId: 'c1' }] });
    const sep = r.months.find((m) => m.month === '2026-09')!;
    expect(sep.drivers).toEqual({ UNPLANNED_HIRE: 3060, PLANNED_HIRE_NOT_DONE: -3060 });
    expect(r.drivers.find((x) => x.key === 'HIRE_FILLED_DIFF')).toBeUndefined();
  });

  it('joined one month before the planned start (tolerance) → fills the planned hire', () => {
    const r = planVsActual(def, p, rowsFor('ok'), d('2026-09-30'), { employees: [{ id: 'a', name: 'أحمد', joinDate: d('2020-01-01') }, { id: 'ok', name: 'في الموعد', joinDate: d('2026-08-01'), nationality: 'هندي', legalCompanyId: 'c1' }] });
    expect(r.months.find((m) => m.month === '2026-08')!.drivers).toEqual({ HIRE_FILLED_DIFF: 3060 });
    expect(r.months.find((m) => m.month === '2026-09')!.drivers).toEqual({});
    expect(r.explanations[0]).toContain('في 3 أشهر');
  });
});

describe('arabicMonths (review P3)', () => {
  it('1 شهر واحد، 2 شهران، 3–10 أشهر، 11+ شهراً', () => {
    expect([1, 2, 3, 10, 11, 12, 24, 0].map((n) => arabicMonths(n))).toEqual(['شهر واحد', 'شهران', '3 أشهر', '10 أشهر', '11 شهراً', '12 شهراً', '24 شهراً', '0 شهراً']);
    expect(arabicMonths(2, true)).toBe('شهرين'); // after a preposition: «في شهرين»
    expect(arabicMonths(12, true)).toBe('12 شهراً');
  });
});
