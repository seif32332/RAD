import { describe, expect, it } from 'vitest';
import { indexRules, removedAssumptionMessage, resolveAssumption, resolveCompanyAssumptions, resolveRules, resolveRulesForMonth, ruleOf, ruleValue, weakestStatus, type RuleRow } from '@/lib/workforce';
import { assume, d, SEED_RULES } from './wf-fixtures';

const row = (value: number, from: string, to: string | null = null, status = 'VERIFIED_PRIMARY'): RuleRow => ({
  key: 'X',
  label: 'X',
  value,
  effectiveFrom: d(from),
  effectiveTo: to ? d(to) : null,
  status,
});

describe('resolveRules', () => {
  it('picks the latest version with effectiveFrom <= date and effectiveTo null or > date', () => {
    const rows = [row(1, '2020-01-01', '2025-01-01'), row(2, '2025-01-01'), row(3, '2027-01-01')];
    expect(resolveRules(rows, d('2024-12-31'), []).X.value).toBe(1);
    expect(resolveRules(rows, d('2025-01-01'), []).X.value).toBe(2);
    expect(resolveRules(rows, d('2026-12-31'), []).X.value).toBe(2);
    expect(resolveRules(rows, d('2027-01-01'), []).X.value).toBe(3);
    expect(resolveRules(rows, d('2019-12-31'), []).X).toBeUndefined();
  });

  it('an expired version without successor resolves to MISSING', () => {
    const rules = resolveRules([row(1, '2020-01-01', '2021-01-01')], d('2022-01-01'), ['X']);
    expect(rules.X.status).toBe('MISSING');
    expect(rules.X.value).toBeNull();
    expect(ruleValue(rules, 'X')).toBeNull();
  });

  it('flags missing expected keys instead of inventing values', () => {
    const rules = resolveRules([], d('2026-01-01'));
    expect(rules.EXPAT_LEVY_ABOVE_SAUDI_COUNT.status).toBe('MISSING');
    expect(ruleOf(rules, 'UNKNOWN_KEY').status).toBe('MISSING');
  });

  it('every seeded key resolves in 2026-09', () => {
    const rules = resolveRules(SEED_RULES, d('2026-09-01'));
    for (const r of Object.values(rules)) expect(r.status).not.toBe('MISSING');
    expect(rules.IQAMA_FEE_YEAR.status).toBe('PROVISIONAL');
    expect(rules.EXIT_REENTRY_SINGLE_BASE.status).toBe('CORROBORATED_SECONDARY');
  });

  it('month resolution: first-day version; a key first starting mid-month applies to that month', () => {
    const idx = indexRules(SEED_RULES);
    expect(resolveRulesForMonth(idx, 2025, 11).INDUSTRIAL_LEVY_CANCELLED.status).toBe('MISSING');
    expect(resolveRulesForMonth(idx, 2025, 12).INDUSTRIAL_LEVY_CANCELLED.value).toBe(1);
    expect(resolveRulesForMonth(idx, 2026, 7).HRDF_BASE_PCT.status).toBe('MISSING');
    expect(resolveRulesForMonth(idx, 2026, 8).HRDF_BASE_PCT.value).toBe(30);
    // A replacement version starting mid-month applies from the next month.
    const idx2 = indexRules([row(700, '2020-01-01'), row(750, '2027-03-15')]);
    expect(resolveRulesForMonth(idx2, 2027, 3, []).X.value).toBe(700);
    expect(resolveRulesForMonth(idx2, 2027, 4, []).X.value).toBe(750);
  });

  it('weakestStatus', () => {
    expect(weakestStatus(['VERIFIED_PRIMARY', 'USER_INPUT'])).toBe('USER_INPUT');
    expect(weakestStatus(['VERIFIED_PRIMARY', 'PROVISIONAL', 'CORROBORATED_SECONDARY'])).toBe('PROVISIONAL');
    expect(weakestStatus(['MISSING', 'CONFLICTING'])).toBe('MISSING');
    expect(weakestStatus([])).toBe('DERIVED');
  });
});

describe('assumptions', () => {
  it('defaults: not entered = null, neutral defaults where safe', () => {
    const a = resolveCompanyAssumptions([], 'c1');
    expect(a.recruitmentCostSaudi.value).toBeNull();
    expect(a.recruitmentCostSaudi.origin).toBe('DEFAULT');
    expect(a.dependentsFeePaidByDefault.value).toBe('EMPLOYEE');
    expect(a.exitReentryVisasPerYear.value).toBe(0);
    expect(a.annualRaisePct.value).toBe(0);
    expect(a.includeHrdf.value).toBe(true);
    expect(a.companyIsSme.value).toBeNull();
    expect(a.ownerFullTime.value).toBeNull();
    expect(a.annualTicketCost.value).toBeNull();
  });

  it('company rows override global rows', () => {
    const rows = [assume('ANNUAL_TICKET_COST', 2000), assume('ANNUAL_TICKET_COST', 3000, null, 'c2')];
    expect(resolveAssumption(rows, 'ANNUAL_TICKET_COST', 'c1').value).toBe(2000);
    expect(resolveAssumption(rows, 'ANNUAL_TICKET_COST', 'c1').origin).toBe('GLOBAL');
    expect(resolveAssumption(rows, 'ANNUAL_TICKET_COST', 'c2').value).toBe(3000);
    expect(resolveAssumption(rows, 'ANNUAL_TICKET_COST', 'c2').origin).toBe('COMPANY');
  });

  it('sensitivity {low, base, high}', () => {
    const rows = [assume('ANNUAL_TICKET_COST', null, '{"low":3000,"base":6000,"high":12000}')];
    expect(resolveAssumption(rows, 'ANNUAL_TICKET_COST', null, 'low').value).toBe(3000);
    expect(resolveAssumption(rows, 'ANNUAL_TICKET_COST', null, 'base').value).toBe(6000);
    expect(resolveAssumption(rows, 'ANNUAL_TICKET_COST', null, 'high').value).toBe(12000);
    expect(resolveAssumption(rows, 'ANNUAL_TICKET_COST', null).range).toEqual({ low: 3000, base: 6000, high: 12000 });
    // Missing bound falls back to base.
    const partial = [assume('VACANCY_MONTHS', null, '{"base":2,"high":4}')];
    expect(resolveAssumption(partial, 'VACANCY_MONTHS', null, 'low').value).toBe(2);
  });

  it('enum and boolean parsing; rows of the moved keys (company settings) are ignored', () => {
    const rows = [
      assume('DEPENDENTS_FEE_PAID_BY_DEFAULT', null, '"COMPANY"'),
      assume('OVERTIME_HOURLY_BASIS', null, 'TOTAL_PLUS_HALF_BASIC'),
      assume('COMPANY_IS_SME', 1),
      assume('OWNER_FULL_TIME', null, 'false'),
      assume('MEDICAL_PREMIUM_BY_CLASS', null, '{"vip": 12000}'),
      assume('INCLUDE_HRDF', 0),
    ];
    const a = resolveCompanyAssumptions(rows, 'c1', 'high');
    expect(a.dependentsFeePaidByDefault.value).toBe('COMPANY');
    expect(a.companyIsSme.value).toBe(true);
    expect(a.ownerFullTime.value).toBe(false);
    expect(a.includeHrdf.value).toBe(false);
    expect(Object.keys(a)).not.toContain('overtimeHourlyBasis');
    expect(Object.keys(a)).not.toContain('medicalPremiumByClass');
    // Invalid enum value -> default.
    expect(resolveAssumption([assume('DEPENDENTS_FEE_PAID_BY_DEFAULT', null, '"WHATEVER"')], 'DEPENDENTS_FEE_PAID_BY_DEFAULT', null).value).toBe('EMPLOYEE');
    expect(removedAssumptionMessage('MEDICAL_PREMIUM_BY_CLASS')).toContain('إعدادات الشركة');
  });
});
