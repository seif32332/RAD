// Review fix 2 (engine): housing type conflicts are flagged, the small-establishment extension is flagged
// after 2027-02, the exit cost reconciles with the settlement screen's last-month salary, and ambiguous
// Saudi nationality values are flagged.
import { describe, expect, it } from 'vitest';
import { computeSettlement } from '@/lib/settlement';
import {
  SMALL_EST_EXTENSION_UNCERTAIN_MESSAGE,
  computeExitCost,
  computeTrueCost,
  contributoryWage,
  type AssumptionRow,
  type RuleRow,
  type TrueCostResult,
  type WfEmployeeInput,
} from '@/lib/workforce';
import { COMPANY, SEED_GOSI, SEED_RULES, assume, d, emp, housing } from './wf-fixtures';

function run(employees: WfEmployeeInput[], startMonth: string, months = 1, assumptions: AssumptionRow[] = [], rules: RuleRow[] = SEED_RULES): TrueCostResult {
  return computeTrueCost({ employees, companies: [COMPANY], rules, gosiRates: SEED_GOSI, assumptions }, { startMonth, months });
}
const flagsOf = (r: TrueCostResult, id: string) => r.employees.find((e) => e.employeeId === id)!.flags;

describe('housing allowance type conflicts (HOUSING_TYPE_CONFLICT)', () => {
  it('name «بدل سكن», type FOOD, countsTowardGosi: the engine follows the type and flags the payroll difference', () => {
    const a = { name: 'بدل سكن', amount: 2000, isMonthly: true, countsTowardGosi: true, allowanceType: 'FOOD' };
    const cw = contributoryWage(10000, [a], 45000);
    expect(cw.raw).toBe(10000);
    expect(cw.payrollDiff).toBe(2000);
    expect(cw.typeConflicts).toEqual([{ name: 'بدل سكن', amount: 2000, allowanceType: 'FOOD', reason: 'TYPED_NOT_HOUSING_BUT_GOSI' }]);
    const r = run([emp({ id: 'h', basicSalary: 10000, allowances: [a] })], '2026-09');
    const f = flagsOf(r, 'h').find((x) => x.code === 'HOUSING_TYPE_CONFLICT');
    expect(f).toMatchObject({ severity: 'WARNING', lineKey: 'GOSI_EMPLOYER' });
    expect(f?.message).toContain('بدل سكن');
    expect(f?.message).toContain('أعلى بـ 2,000');
    expect(r.flags.some((x) => x.code === 'HOUSING_TYPE_CONFLICT')).toBe(true); // reaches the overview data quality
  });

  it('type HOUSING but not flagged for GOSI: engine counts it, payroll does not (negative difference)', () => {
    const cw = contributoryWage(8000, [{ name: 'سكن', amount: 1500, isMonthly: true, countsTowardGosi: false, allowanceType: 'HOUSING' }], 45000);
    expect(cw.raw).toBe(9500);
    expect(cw.payrollDiff).toBe(-1500);
    expect(cw.typeConflicts[0].reason).toBe('HOUSING_NOT_GOSI');
  });

  it('name says housing, type TRANSPORT, not flagged: same base as payroll, still reported', () => {
    const cw = contributoryWage(8000, [{ name: 'Housing', amount: 1000, isMonthly: true, countsTowardGosi: false, allowanceType: 'TRANSPORT' }], 45000);
    expect(cw.payrollDiff).toBe(0);
    expect(cw.typeConflicts[0].reason).toBe('TYPED_NOT_HOUSING_BUT_NAME');
  });

  it('consistent allowances raise nothing', () => {
    const r = run([emp({ id: 'ok', allowances: [housing(2000), { name: 'بدل نقل', amount: 500, isMonthly: true, countsTowardGosi: false, allowanceType: 'TRANSPORT' }] })], '2026-09');
    expect(flagsOf(r, 'ok').some((f) => f.code === 'HOUSING_TYPE_CONFLICT')).toBe(false);
    expect(contributoryWage(8000, [housing(2000)], 45000).payrollDiff).toBe(0);
  });
});

describe('small-establishment exemption after 2027-02 (SMALL_EST_EXTENSION_UNCERTAIN)', () => {
  const staff = [emp({ id: 's1' }), emp({ id: 's2' }), ...[1, 2, 3].map((i) => emp({ id: `x${i}`, nationality: 'هندي', joinDate: d(`2021-0${i}-01`), basicSalary: 3000 }))];
  const owner = [assume('OWNER_FULL_TIME', 1, null, 'c1')];
  const levy = (r: TrueCostResult, month: string) => r.employees.find((e) => e.employeeId === 'x1')!.months.find((m) => m.month === month)!.lines.find((l) => l.key === 'EXPAT_LEVY')!;

  it('January 2027 exempt as before; from February 2027 flagged and PROVISIONAL (no invented end date)', () => {
    const r = run(staff, '2027-01', 3, owner);
    expect(levy(r, '2027-01')).toMatchObject({ amount: 0, status: 'USER_INPUT' });
    expect(levy(r, '2027-02')).toMatchObject({ amount: 0, status: 'PROVISIONAL' });
    expect(levy(r, '2027-02').note).toContain(SMALL_EST_EXTENSION_UNCERTAIN_MESSAGE);
    const f = flagsOf(r, 'x1').find((x) => x.code === 'SMALL_EST_EXTENSION_UNCERTAIN');
    expect(f?.message).toBe(`${SMALL_EST_EXTENSION_UNCERTAIN_MESSAGE} (الإعفاء مفترض مستمراً من 2027-02)`);
    expect(f?.severity).toBe('WARNING');
  });

  it('not flagged before 2027-02, nor when the rule has a recorded end date', () => {
    expect(flagsOf(run(staff, '2026-06', 8, owner), 'x1').some((f) => f.code === 'SMALL_EST_EXTENSION_UNCERTAIN')).toBe(false);
    const ended = SEED_RULES.map((r) => (r.key === 'SMALL_EST_MAX_WORKERS' ? { ...r, effectiveTo: d('2030-01-31') } : r));
    expect(flagsOf(run(staff, '2027-03', 1, owner, ended), 'x1').some((f) => f.code === 'SMALL_EST_EXTENSION_UNCERTAIN')).toBe(false);
  });

  it('exit cost: the levy tier change after 2027-02 with an exemption is flagged too', () => {
    const leaver = staff[2];
    const r = computeExitCost({ employee: { ...leaver, leaves: [], loans: [] }, reason: 'RESIGNATION', lastWorkingDate: d('2027-03-15'), noticeServed: true, companyEmployees: staff, company: COMPANY, rules: SEED_RULES, gosiRates: SEED_GOSI, assumptions: owner });
    expect(r.flags.some((f) => f.code === 'SMALL_EST_EXTENSION_UNCERTAIN')).toBe(true);
  });
});

describe('exit cost vs the settlement screen: last month salary', () => {
  const w = emp({ id: 'w', joinDate: d('2023-09-01'), basicSalary: 7000, allowances: [housing(2000)] });
  const exit = (lastMonthAlreadyPaid?: boolean) =>
    computeExitCost({ employee: { ...w, leaves: [], loans: [] }, reason: 'RESIGNATION', lastWorkingDate: d('2026-08-31'), noticeServed: true, companyEmployees: [w], company: COMPANY, rules: SEED_RULES, gosiRates: SEED_GOSI, assumptions: [], lastMonthAlreadyPaid });
  const screen = (paid: boolean) =>
    computeSettlement({ type: 'END_OF_SERVICE', terminationReason: 'RESIGNATION', salaryBasis: 'total', employee: { basicSalary: 7000, allowances: [housing(2000)], joinDate: w.joinDate, nationality: w.nationality }, lastWorkingDate: d('2026-08-31'), asOf: d('2026-08-31'), leaves: [], lastMonthAlreadyPaid: paid, outstandingLoans: 0, overtime: 0, manualEntitlements: 0, manualDeductions: 0 });

  it('both totals: without the last month (= screen when paid) and with it (= screen when unpaid)', () => {
    const r = exit(false);
    expect(r.settlementScreenTotal).toBe(screen(true).totalSettlement);
    expect(r.lastMonth).toEqual({ workingDays: 31, salary: 9300, settlementTotalIfUnpaid: screen(false).totalSettlement, paidByPayroll: false });
    expect(r.lastMonth.settlementTotalIfUnpaid).toBe(r.settlementScreenTotal + 9300);
    expect(r.totals.netToEmployee).toBe(r.settlementScreenTotal); // the exit cost itself never counts that salary
    expect(exit(true).lastMonth.paidByPayroll).toBe(true);
    expect(exit().lastMonth.paidByPayroll).toBeNull();
  });
});

describe('ambiguous Saudi nationality values (NATIONALITY_AMBIGUOUS)', () => {
  it.each(['بسعودي', 'Saudi-born Egyptian', 'مصري سعودي المولد'])('%s: not Saudi, flagged', (nat) => {
    const r = run([emp({ id: 'n', nationality: nat })], '2026-09');
    expect(r.employees[0].nationalityClass).toBe('EXPAT');
    expect(flagsOf(r, 'n').some((f) => f.code === 'NATIONALITY_AMBIGUOUS')).toBe(true);
  });

  it.each(['سعودي', 'غير سعودي', 'Non-Saudi', 'مصري'])('%s: not flagged', (nat) => {
    expect(flagsOf(run([emp({ id: 'n', nationality: nat })], '2026-09'), 'n').some((f) => f.code === 'NATIONALITY_AMBIGUOUS')).toBe(false);
  });
});
