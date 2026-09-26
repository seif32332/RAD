import { describe, expect, it } from 'vitest';
import { computeSettlement } from '@/lib/settlement';
import { computeExitCost, computeTrueCost, type AssumptionRow, type ExitCostInput, type ExitCostResult, type ExitLineKey, type WfEmployeeInput } from '@/lib/workforce';
import { COMPANY, SEED_GOSI, SEED_RULES, assume, d, emp, housing } from './wf-fixtures';

const LWD = d('2026-08-31');

function exit(
  employee: WfEmployeeInput,
  reason: string,
  over: Partial<ExitCostInput> & { loans?: ExitCostInput['employee']['loans']; assumptions?: AssumptionRow[] } = {},
): ExitCostResult {
  const { loans, ...rest } = over;
  return computeExitCost({
    employee: { ...employee, leaves: [], loans: loans ?? [] },
    reason,
    lastWorkingDate: LWD,
    noticeServed: false,
    companyEmployees: [employee],
    company: COMPANY,
    rules: SEED_RULES,
    gosiRates: SEED_GOSI,
    assumptions: [],
    ...rest,
  });
}

const line = (r: ExitCostResult, key: ExitLineKey) => r.lines.find((l) => l.key === key);
/** basic 7,000 + housing 2,000 = wage 9,000, day rate 300. */
const worker = (joinDate: string, over: Partial<WfEmployeeInput> = {}) => emp({ id: `w-${joinDate}`, joinDate: d(joinDate), basicSalary: 7000, allowances: [housing(2000)], ...over });

describe('EOSB by reason and years (computeSettlement / endOfServiceAward)', () => {
  it.each([
    ['2025-09-01', 1, 0],
    ['2023-09-01', 3, 4500], // 9,000 × 0.5 × 3 = 13,500 ÷ 3
    ['2019-09-01', 7, 27000], // (22,500 + 18,000) × 2/3
    ['2014-09-01', 12, 85500], // 22,500 + 63,000, full after 10 years
  ])('resignation, joined %s (%i years) -> %i', (join, years, award) => {
    const r = exit(worker(join), 'RESIGNATION', { noticeServed: true });
    expect(r.yearsOfService).toBe(years);
    expect(line(r, 'EOSB')?.amount).toBe(award);
    expect(line(r, 'EOSB')?.status).toBe('VERIFIED_PRIMARY');
    expect(line(r, 'ART77_RISK')).toBeUndefined();
    expect(line(r, 'NOTICE_OWED_BY_EMPLOYEE')).toBeUndefined();
  });

  it('resignation without notice: 30 days owed by the employee is an offset, not a cost', () => {
    const r = exit(worker('2023-09-01'), 'RESIGNATION');
    expect(line(r, 'NOTICE_OWED_BY_EMPLOYEE')).toMatchObject({ amount: -9000, kind: 'OFFSET' });
    expect(r.totals.offsets).toBe(-9000);
  });

  it('employer termination without notice: full award + 60 days notice pay + separate art. 77 risk', () => {
    const r = exit(worker('2019-09-01'), 'COMPANY_TERMINATION');
    expect(line(r, 'EOSB')?.amount).toBe(40500);
    expect(line(r, 'NOTICE_PAY')).toMatchObject({ amount: 18000, kind: 'PAYABLE' });
    expect(line(r, 'ART77_RISK')).toMatchObject({ amount: 31500, kind: 'RISK' }); // 300 × 15 × 7
    expect(r.totals.risk).toBe(31500);
    const leave = line(r, 'LEAVE_PAYOUT')!.amount;
    expect(r.totals.payable).toBe(40500 + 18000 + leave);
    expect(r.totals.netToEmployee).toBe(r.totals.payable); // no offsets, risk excluded
  });

  it('employer termination with notice served: no pay in lieu; art. 77 minimum of 2 months', () => {
    const r = exit(worker('2025-09-01'), 'COMPANY_TERMINATION', { noticeServed: true });
    expect(line(r, 'NOTICE_PAY')?.amount).toBe(0);
    expect(line(r, 'ART77_RISK')?.amount).toBe(18000); // 300 × 15 × 1 = 4,500 < 2 × 9,000
    expect(line(r, 'ART77_RISK')?.basis).toContain('الحد الأدنى');
  });

  it('fixed-term contract: art. 77 risk = the remaining term', () => {
    const r = exit(worker('2023-09-01', { contractEndDate: d('2027-02-28') }), 'COMPANY_TERMINATION');
    expect(line(r, 'ART77_RISK')?.amount).toBe(54300); // 181 days × 9,000 / 30
  });

  it('article 80 and probation: no award, no notice, no art. 77 line', () => {
    for (const reason of ['ARTICLE_80', 'PROBATION']) {
      const r = exit(worker('2019-09-01'), reason);
      expect(line(r, 'EOSB')?.amount).toBe(0);
      expect(line(r, 'NOTICE_PAY')).toBeUndefined();
      expect(line(r, 'ART77_RISK')).toBeUndefined();
    }
  });

  it('counsel-pending reasons are PROVISIONAL with the existing note', () => {
    const r = exit(worker('2019-09-01'), 'CONTRACT_EXPIRY');
    expect(line(r, 'EOSB')).toMatchObject({ amount: 40500, status: 'PROVISIONAL' }); // 22,500 + 2 × 9,000, full award
    expect(line(r, 'EOSB')?.note).toContain('بانتظار تأكيد المستشار');
    expect(r.flags.map((f) => f.code)).toContain('COUNSEL_PENDING');
  });

  it('accepts Employee.exitReason values through the documented mapping', () => {
    expect(exit(worker('2019-09-01'), 'EMPLOYER_TERMINATION').reason).toBe('COMPANY_TERMINATION');
    const death = exit(worker('2019-09-01'), 'DEATH');
    expect(death.reason).toBe('ARTICLE_87');
    expect(death.reasonInput).toBe('DEATH');
    expect(death.flags.map((f) => f.code)).toContain('COUNSEL_PENDING');
    expect(() => exit(worker('2019-09-01'), 'MUTUAL_AGREEMENT')).toThrow(/settlement reason/);
    expect(() => exit(worker('2019-09-01'), 'NOPE')).toThrow();
  });
});

describe('leave payout, loans and the settlement screen', () => {
  it('leave payout (art. 111) and loans offset match computeSettlement exactly', () => {
    const w = worker('2023-09-01');
    const r = exit(w, 'RESIGNATION', { noticeServed: true, loans: [{ remainingAmount: 5000, installments: [] }] });
    expect(line(r, 'LEAVE_PAYOUT')?.amount).toBe(18900); // 1,095 days × 21/365 = 63 days × 300
    expect(line(r, 'LOANS_OFFSET')).toMatchObject({ amount: -5000, kind: 'OFFSET' });
    expect(r.totals.netToEmployee).toBe(4500 + 18900 - 5000);
    const screen = computeSettlement({
      type: 'END_OF_SERVICE',
      terminationReason: 'RESIGNATION',
      salaryBasis: 'total',
      employee: { basicSalary: 7000, allowances: [housing(2000)], joinDate: w.joinDate, nationality: w.nationality },
      lastWorkingDate: LWD,
      asOf: LWD,
      leaves: [],
      lastMonthAlreadyPaid: true,
      outstandingLoans: 5000,
      overtime: 0,
      manualEntitlements: 0,
      manualDeductions: 0,
    });
    expect(r.settlementScreenTotal).toBe(screen.totalSettlement);
    expect(r.totals.netToEmployee).toBe(screen.totalSettlement);
  });
});

describe('expat exit: sunk fees, replacement, levy tier change', () => {
  it('sunk prepaid iqama / work permit months', () => {
    const x = worker('2023-09-01', { nationality: 'هندي', iqamaExpiry: d('2027-03-15') });
    const r = exit(x, 'RESIGNATION', { noticeServed: true });
    expect(line(r, 'SUNK_IQAMA')).toMatchObject({ amount: 325, kind: 'SUNK' }); // 6 months × 650 / 12
    expect(line(r, 'SUNK_WORK_PERMIT')?.amount).toBe(50);
    expect(r.totals.sunkFees).toBe(375);
  });

  it('sunk iqama uses the company iqama fee when entered (USER_INPUT, COMPANY:IQAMA_FEE_YEAR)', () => {
    const x = worker('2023-09-01', { nationality: 'هندي', iqamaExpiry: d('2027-03-15') });
    const company = { ...COMPANY, costSettings: { overtimeHourlyBasis: 'BASIC' as const, medicalPremiums: {}, iqamaFeeYear: 1200 } };
    const r = exit(x, 'RESIGNATION', { noticeServed: true, company });
    expect(line(r, 'SUNK_IQAMA')).toMatchObject({ amount: 600, status: 'USER_INPUT', ruleKeys: ['COMPANY:IQAMA_FEE_YEAR'] }); // 6 × 1,200 / 12
    // No legal company: the actual company's settings apply (settingsCompany).
    const y = worker('2023-09-01', { nationality: 'هندي', iqamaExpiry: d('2027-03-15'), legalCompanyId: null, actualCompanyId: 'c1' });
    const r2 = exit(y, 'RESIGNATION', { noticeServed: true, company: null, settingsCompany: company });
    expect(line(r2, 'SUNK_IQAMA')?.amount).toBe(600);
  });

  it('replacement cost from assumptions (recruitment + vacancy × monthly cost); missing -> MISSING', () => {
    const x = worker('2023-09-01', { nationality: 'هندي' });
    const missing = exit(x, 'RESIGNATION', { noticeServed: true });
    expect(line(missing, 'RECRUITMENT')).toMatchObject({ amount: 0, status: 'MISSING' });
    const assumptions = [assume('RECRUITMENT_COST_EXPAT', 5000), assume('VACANCY_MONTHS', 2)];
    const r = exit(x, 'RESIGNATION', { noticeServed: true, assumptions });
    expect(line(r, 'RECRUITMENT')).toMatchObject({ amount: 5000, status: 'USER_INPUT' });
    const monthly = computeTrueCost({ employees: [x], companies: [COMPANY], rules: SEED_RULES, gosiRates: SEED_GOSI, assumptions }, { startMonth: '2026-08', months: 1 }).totals.month1.cost;
    expect(line(r, 'VACANCY')?.amount).toBe(Math.round(2 * monthly * 100) / 100);
    expect(r.totals.replacement).toBe(Math.round((5000 + 2 * monthly) * 100) / 100);
  });

  describe('levy tiers of the legal company after the exit', () => {
    const s1 = emp({ id: 's1' });
    const s2 = emp({ id: 's2' });
    const x1 = emp({ id: 'x1', nationality: 'هندي', joinDate: d('2021-01-01') });
    const x2 = emp({ id: 'x2', nationality: 'هندي', joinDate: d('2021-02-01') });
    const x3 = emp({ id: 'x3', nationality: 'هندي', joinDate: d('2021-03-01') });
    const all = [s1, s2, x1, x2, x3];
    const noExemption = [assume('OWNER_FULL_TIME', 0)];

    it('a Saudi leaving pushes one expat from 700 to 800 (+100 / month)', () => {
      const r = exit(s1, 'RESIGNATION', { noticeServed: true, companyEmployees: all, assumptions: noExemption });
      expect(r.levyImpact).toMatchObject({ month: '2026-09', deltaMonthly: 100 });
      expect(r.levyImpact?.before).toMatchObject({ saudi: 2, expat: 3, within: 2, above: 1, monthlyLevy: 2200 });
      expect(r.levyImpact?.after).toMatchObject({ saudi: 1, expat: 3, within: 1, above: 2, monthlyLevy: 2300 });
      expect(line(r, 'LEVY_TIER_CHANGE')).toMatchObject({ amount: 100, kind: 'ONGOING' });
      expect(r.totals.ongoingMonthlyDelta).toBe(100);
    });

    it('the last-ranked expat leaving: no change for the others', () => {
      const r = exit(x3, 'RESIGNATION', { noticeServed: true, companyEmployees: all, assumptions: noExemption });
      expect(r.levyImpact?.deltaMonthly).toBe(0);
      expect(r.levyImpact?.after.monthlyLevy).toBe(1400);
    });

    it('a 700-rate expat leaving moves an 800 expat down to 700 (−100 / month)', () => {
      const r = exit(x1, 'RESIGNATION', { noticeServed: true, companyEmployees: all, assumptions: noExemption });
      expect(r.levyImpact?.deltaMonthly).toBe(-100);
    });
  });
});

describe('exit cost is deterministic and explained', () => {
  it('same input -> same output; explanations cite the law and the rules', () => {
    const a = exit(worker('2019-09-01'), 'COMPANY_TERMINATION');
    const b = exit(worker('2019-09-01'), 'COMPANY_TERMINATION');
    expect(b).toEqual(a);
    expect(a.explanations.EOSB?.rules.map((r) => r.key)).toContain('LAW:ART84');
    expect(a.explanations.NOTICE_PAY?.rules.find((r) => r.key === 'NOTICE_DAYS_EMPLOYER')).toMatchObject({ value: 60, status: 'VERIFIED_PRIMARY' });
    expect(a.explanations.ART77_RISK?.rules.map((r) => r.key)).toEqual(expect.arrayContaining(['ART77_DAYS_PER_YEAR', 'ART77_MIN_MONTHS']));
    expect(a.rulesUsed.map((r) => r.key)).toEqual(expect.arrayContaining(['NOTICE_DAYS_EMPLOYER', 'LAW:ART84']));
  });
});
