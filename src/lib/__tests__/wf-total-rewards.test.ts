// «بيان المكافآت الشاملة» (src/lib/workforce/total-rewards.ts + GET /api/portal/total-rewards): hand-computed
// statement and the portal's own-statement-only rule. SPEC §9.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_GOSI_RATES } from '@/lib/gosi';
import { computeTotalRewards, type TotalRewardsInput } from '@/lib/workforce/total-rewards';
import { validateAssumptionValue } from '@/app/api/workforce/_lib/views';
import { resolveAssumption } from '@/lib/workforce/assumptions';

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);

function input(over: Partial<TotalRewardsInput> = {}): TotalRewardsInput {
  const row = (month: number, o: Partial<TotalRewardsInput['payrolls'][number]> = {}) => ({
    year: 2026,
    month,
    status: 'PAID',
    basicSalary: 10000,
    totalAllowances: 3500,
    overtimeCost: 0,
    bonusAmount: 0,
    gosiEmployer: 1000,
    ...o,
  });
  return {
    year: 2026,
    asOf: D('2026-09-26'),
    employee: {
      id: 'E1',
      name: 'موظف تجريبي',
      employeeNo: '100',
      nationality: 'سعودي',
      joinDate: D('2020-01-01'),
      basicSalary: 10000,
      allowances: [
        { name: 'بدل سكن', amount: 2500, isMonthly: true, countsTowardGosi: true, allowanceType: 'HOUSING' },
        { name: 'بدل نقل', amount: 1000, isMonthly: true, countsTowardGosi: false, allowanceType: 'TRANSPORT' },
        { name: 'مكافأة أداء', amount: 3000, isMonthly: false, isPaid: true, payrollYear: 2026, payrollMonth: 3 },
        { name: 'مكافأة قديمة', amount: 999, isMonthly: false, isPaid: true, payrollYear: 2025, payrollMonth: 12 },
      ],
      gosiRegime: 'OLD',
      medicalInsuranceClass: 'a',
      dependentsCount: 2,
    },
    payrolls: [
      row(1),
      row(2, { overtimeCost: 500, status: 'APPROVED' }),
      row(3, { totalAllowances: 6500, bonusAmount: 3000, gosiEmployer: 0 }), // GOSI not stored → engine
      row(4, { status: 'DRAFT' }), // not approved: ignored
      { ...row(12), year: 2025 }, // other year: ignored
    ],
    company: { id: 'C1', name: 'شركة تجريبية', costSettings: { overtimeHourlyBasis: 'BASIC', medicalPremiums: { A: 6000, DEPENDENT: 2400 }, iqamaFeeYear: null } },
    rules: [],
    gosiRates: DEFAULT_GOSI_RATES.map((r) => ({ ...r })),
    ...over,
  };
}

describe('computeTotalRewards', () => {
  const s = computeTotalRewards(input());
  const line = (k: string) => s.lines.find((l) => l.key === k)!;

  it('paid lines come from the approved / paid payrolls of the year only', () => {
    expect(s.available).toBe(true);
    expect(s.coveredMonths).toEqual([1, 2, 3]);
    expect(s.through).toBe('2026-03-31');
    expect(line('BASIC').amount).toBe(30000);
    expect(line('ALLOWANCES').amount).toBe(10500); // 3,500 + 3,500 + 6,500 − 3,000
    expect(line('ALLOWANCES').items).toEqual([
      { label: 'بدل سكن', amount: 2500, note: 'شهرياً حسب ملفك الحالي' },
      { label: 'بدل نقل', amount: 1000, note: 'شهرياً حسب ملفك الحالي' },
    ]);
    expect(line('BONUSES').amount).toBe(3000);
    expect(line('BONUSES').items?.map((i) => i.label)).toEqual(['مكافأة أداء']);
    expect(line('OVERTIME').amount).toBe(500);
    expect(line('BASIC').sourceLabel).toBe('من مسيرات الرواتب');
  });

  it('employer GOSI: stored where > 0, else computed by the engine (11.75% × (10,000 + 2,500))', () => {
    expect(line('GOSI_EMPLOYER').amount).toBe(3468.75); // 1,000 + 1,000 + 1,468.75
    expect(line('GOSI_EMPLOYER').basis).toContain('محسوبة بالمحرك');
    expect(s.notes.some((n) => n.includes('محسوب بالمحرك'))).toBe(true);
  });

  it('medical premium per the company settings for the covered months', () => {
    expect(line('MEDICAL')).toMatchObject({ amount: 1500, source: 'COMPANY_SETTING', sourceLabel: 'حسب إعدادات الشركة', available: true }); // 6,000 × 3 / 12
    expect(line('MEDICAL_DEPENDENTS').amount).toBe(1200); // 2 × 2,400 × 3 / 12
  });

  it('end of service: art. 84 accrual of the year in the total, balance since joining as information', () => {
    // wage 13,500; 31 Dec 2025 = 6 years → 33,750 + 13,500 = 47,250; 31 Mar 2026 = 6.25 years → 33,750 + 16,875 = 50,625
    expect(line('EOSB_ACCRUAL')).toMatchObject({ amount: 3375, kind: 'ACCRUAL', sourceLabel: 'تقديري حسب المادة 84' });
    expect(line('EOSB_ACCRUED_TO_DATE')).toMatchObject({ amount: 50625, kind: 'MEMO' });
    expect(line('ANNUAL_LEAVE_VALUE')).toMatchObject({ amount: 13500, kind: 'MEMO' }); // 30 days × 450 (≥ 5 years)
  });

  it('totals: «كلفة المنشأة عليك» = cash + employer paid + accrued (memo lines excluded); no HRDF line', () => {
    expect(s.totals).toEqual({ cash: 44000, employerPaid: 6168.75, accrued: 3375, total: 53543.75 });
    expect(s.lines.some((l) => /HRDF|هدف/.test(l.key + l.label + l.explanation))).toBe(false);
  });

  it('missing premium → no invented amount; no payroll → not available', () => {
    const m = computeTotalRewards(input({ company: { id: 'C1', name: 'ش', costSettings: { overtimeHourlyBasis: 'BASIC', medicalPremiums: {}, iqamaFeeYear: null } } }));
    expect(m.lines.find((l) => l.key === 'MEDICAL')).toMatchObject({ amount: 0, available: false, source: 'MISSING' });
    expect(m.lines.some((l) => l.key === 'MEDICAL_DEPENDENTS')).toBe(false);
    const none = computeTotalRewards(input({ year: 2024 }));
    expect(none).toMatchObject({ available: false, lines: [], totals: { total: 0 } });
    expect(none.reason).toContain('2024');
  });

  it('EOSB accrual counts only the covered months (payroll from March: not January → the last covered month)', () => {
    // wage 13,500, > 5 years: 13,500 ÷ 12 = 1,125 per month. Covered March + April = 2,250 (not Jan–Apr 4,500).
    const pay = (month: number) => ({ year: 2026, month, status: 'PAID', basicSalary: 10000, totalAllowances: 3500, overtimeCost: 0, bonusAmount: 0, gosiEmployer: 1000 });
    const t = computeTotalRewards(input({ payrolls: [pay(3), pay(4)] }));
    expect(t.coveredMonths).toEqual([3, 4]);
    const l = t.lines.find((x) => x.key === 'EOSB_ACCRUAL')!;
    expect(l.amount).toBe(2250);
    expect(l.label).toContain('الأشهر المشمولة');
    expect(l.basis).toContain('مارس');
    expect(t.lines.find((x) => x.key === 'MEDICAL')!.amount).toBe(1000); // 6,000 × 2 ÷ 12: the same months
    // A gap (January and March): 1,125 + 1,125.
    expect(computeTotalRewards(input({ payrolls: [pay(1), pay(3)] })).lines.find((x) => x.key === 'EOSB_ACCRUAL')!.amount).toBe(2250);
    expect(computeTotalRewards(input({ payrolls: [pay(1), pay(3)] })).totals.accrued).toBe(2250);
  });

  it('employee who left during the year: accrual up to the exit date', () => {
    const t = computeTotalRewards(input({ employee: { ...input().employee, terminationDate: D('2026-03-15') } }));
    expect(t.through).toBe('2026-03-15');
  });
});

describe('TOTAL_REWARDS_ENABLED assumption (owner toggle)', () => {
  it('stored as value 1 / 0 resolves to the boolean', () => {
    expect(resolveAssumption([{ key: 'TOTAL_REWARDS_ENABLED', companyId: '', value: 1, valueJson: null }], 'TOTAL_REWARDS_ENABLED', null).value).toBe(true);
    expect(resolveAssumption([{ key: 'TOTAL_REWARDS_ENABLED', companyId: '', value: 0, valueJson: null }], 'TOTAL_REWARDS_ENABLED', null).value).toBe(false);
    expect(resolveAssumption([], 'TOTAL_REWARDS_ENABLED', null).value).toBe(false);
    expect(validateAssumptionValue('TOTAL_REWARDS_ENABLED', true).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/portal/total-rewards: the employee's OWN statement only, hidden when disabled
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  user: { id: 'U1', role: 'EMPLOYEE', employeeId: 'E1' as string | null },
  enabled: true,
  load: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  requireUser: vi.fn(async () => mocks.user),
  requireEmployeeId: vi.fn(async (u: { employeeId: string | null }) => {
    if (!u.employeeId) throw Object.assign(new Error('x'), { status: 403 });
    return u.employeeId;
  }),
  getClientIp: () => '127.0.0.1',
}));
vi.mock('@/app/api/workforce/_lib/server', () => ({ limitOrThrow: vi.fn() }));
vi.mock('@/app/api/workforce/total-rewards/_load', async () => {
  const { z } = await import('zod');
  return {
    zStatementYear: z.preprocess((v) => (v === undefined || v === '' ? undefined : Number(v)), z.number().int().min(2000).max(2100).optional()),
    totalRewardsEnabled: vi.fn(async () => mocks.enabled),
    loadTotalRewards: mocks.load,
  };
});

describe('GET /api/portal/total-rewards', () => {
  beforeEach(() => {
    mocks.enabled = true;
    mocks.load.mockReset();
    mocks.load.mockImplementation(async (employeeId: string, year: number | null) => ({
      statement: { employee: { id: employeeId }, year: year ?? 2026 },
      years: { first: 2020, last: 2026 },
      payrollYears: [2026],
    }));
  });

  it('loads the statement of the session employee', async () => {
    const { GET } = await import('@/app/api/portal/total-rewards/route');
    const res = await GET(new Request('http://t/api/portal/total-rewards?year=2025'));
    expect(res.status).toBe(200);
    expect(mocks.load).toHaveBeenCalledWith('E1', 2025);
    expect((await res.json()).statement.employee.id).toBe('E1');
  });

  it('refuses a request for another employee (employeeId in the query) and never loads it', async () => {
    const { GET } = await import('@/app/api/portal/total-rewards/route');
    const res = await GET(new Request('http://t/api/portal/total-rewards?employeeId=E2&year=2026'));
    expect(res.status).toBe(400);
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it('hidden when the owner has not enabled it', async () => {
    mocks.enabled = false;
    const { GET } = await import('@/app/api/portal/total-rewards/route');
    const res = await GET(new Request('http://t/api/portal/total-rewards'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: false });
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it('a year outside the service is refused', async () => {
    const { GET } = await import('@/app/api/portal/total-rewards/route');
    const res = await GET(new Request('http://t/api/portal/total-rewards?year=2019'));
    expect(res.status).toBe(400);
  });
});
