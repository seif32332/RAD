// rules module (P1-RULE), pure part: the catalogue equals the migration seed, resolution by date,
// override precedence and the legal bound, the per-request reader, and the behaviour parity of every
// call site that used a legal constant before (same outputs with the default values).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  GOSI_FALLBACK_RATES,
  LABOR_LAW_KEYS,
  RULE_CATALOGUE,
  RuleOverrideBoundError,
  UnknownRuleKeyError,
  assertCompanyInScope,
  assertOverrideAllowed,
  catalogueLaborLaw,
  catalogueValueAt,
  createRulesReader,
  overtimeMultiplierOf,
  overrideBoundBreach,
  resolveRule,
  RuleOverrideAckRequiredError,
  RuleScopeError,
  belowLegalOverrideResults,
  belowLegalOwnerAlert,
  ownerAlertRecipient,
  type LegalVersion,
  type OverrideVersion,
  type RulesDb,
} from '@/modules/rules';
import {
  DEFAULT_STATUTORY_LEAVE_RULES,
  SERVICE_YEARS_FOR_HIGHER_ACCRUAL,
  annualEntitlementRates,
  computeLeaveBalance,
  computeLeaveRequest,
  computeSickLeaveTiers,
  parseStatutoryLeaveRules,
  statutoryLeaveRulesFromLaw,
} from '@/lib/leave';
import { DEFAULT_PAYROLL_SETTINGS, GOSI_MAX_CONTRIBUTORY_WAGE, leaveDeductionForMonth, type LeaveLike } from '@/lib/payroll-core';
import { DEFAULT_GOSI_RATES } from '@/lib/gosi';
import { computeSettlement, endOfServiceAward, fullEndOfServiceAward, type TerminationReasonValue } from '@/lib/settlement';
import { suggestedLastWorkingDay } from '@/lib/termination';
import { PROBATION_WARNING_DAYS, probationWarning } from '@/lib/employee-shared';
import { leaveLiabilityMonthly } from '@/lib/workforce/formulas';

const MIGRATIONS = join(__dirname, '../../../../prisma/migrations');

/** Every tuple of `INSERT INTO "<table>" (cols) VALUES (…), (…)` in the migrations, as column → raw value. */
function seedRows(table: string): Array<Record<string, string | null>> {
  const out: Array<Record<string, string | null>> = [];
  for (const dir of readdirSync(MIGRATIONS).sort()) {
    let sql: string;
    try {
      sql = readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
    } catch {
      continue;
    }
    const head = `INSERT INTO "${table}" (`;
    let at = sql.indexOf(head);
    while (at >= 0) {
      const colsEnd = sql.indexOf(')', at + head.length);
      const cols = sql.slice(at + head.length, colsEnd).split(',').map((c) => c.trim().replace(/"/g, ''));
      let i = sql.indexOf('VALUES', colsEnd) + 'VALUES'.length;
      // Walk the tuples until the statement ends (';' outside quotes and parentheses).
      let depth = 0;
      let inQ = false;
      let cur = '';
      let vals: Array<string | null> = [];
      for (; i < sql.length; i++) {
        const ch = sql[i];
        if (inQ) {
          if (ch === "'" && sql[i + 1] === "'") {
            cur += "'";
            i++;
          } else if (ch === "'") inQ = false;
          else cur += ch;
          continue;
        }
        if (ch === "'") {
          inQ = true;
          cur += '\u0000'; // marks a quoted value
        } else if (ch === '(') {
          depth++;
          if (depth === 1) {
            cur = '';
            vals = [];
          }
        } else if (ch === ')') {
          depth--;
          if (depth === 0) {
            vals.push(cur);
            out.push(Object.fromEntries(cols.map((c, k) => [c, norm(vals[k])])));
          }
        } else if (ch === ',' && depth === 1) {
          vals.push(cur);
          cur = '';
        } else if (depth === 0 && (ch === ';' || /[A-Za-z]/.test(ch))) break; // end of the VALUES list (';' or ON CONFLICT …)
        else if (depth >= 1) cur += ch;
      }
      at = sql.indexOf(head, i);
    }
  }
  return out;
}

function norm(v: string | null | undefined): string | null {
  if (v === undefined || v === null) return null;
  const t = v.trim();
  if (t === 'NULL') return null;
  return t.replace(/\u0000/g, '');
}

describe('catalogue mirrors the migration seed (ARCH-007 allow list is only a mirror)', () => {
  const rows = seedRows('RuleParameter');

  it('every seeded RuleParameter row is in the catalogue with the same value, date, status and source', () => {
    expect(rows.length).toBeGreaterThan(50);
    for (const r of rows) {
      const def = RULE_CATALOGUE.find((d) => d.key === r.key);
      expect(def, `catalogue has ${r.key}`).toBeDefined();
      const v = def!.versions.find((x) => x.effectiveFrom === r.effectiveFrom);
      expect(v, `${r.key} ${r.effectiveFrom}`).toBeDefined();
      expect(v!.value).toBe(Number(r.value));
      expect(v!.status).toBe(r.status);
      expect(v!.sourceUrl).toBe(r.sourceUrl);
      expect(def!.domain).toBe(r.domain);
      expect(def!.label).toBe(r.label);
    }
  });

  it('every catalogue version is seeded (no value lives only in code)', () => {
    for (const d of RULE_CATALOGUE) {
      for (const v of d.versions) {
        expect(rows.some((r) => r.key === d.key && r.effectiveFrom === v.effectiveFrom), `${d.key} ${v.effectiveFrom} seeded`).toBe(true);
      }
    }
  });

  it('GOSI_FALLBACK_RATES equal the OLD-regime GosiRate seed rows', () => {
    const gosi = seedRows('GosiRate').filter((r) => r.regime === 'OLD');
    expect(gosi).toHaveLength(GOSI_FALLBACK_RATES.length);
    for (const f of GOSI_FALLBACK_RATES) {
      const r = gosi.find((x) => (x.isSaudi === 'TRUE') === f.isSaudi)!;
      expect([Number(r.employeeRate), Number(r.employerRate), Number(r.minWage), Number(r.maxWage), r.effectiveFrom]).toEqual([
        f.employeeRate,
        f.employerRate,
        f.minWage,
        f.maxWage,
        f.effectiveFrom,
      ]);
    }
  });

  it('keys are unique, versions ascending, every LaborLaw key is catalogued', () => {
    const keys = RULE_CATALOGUE.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const d of RULE_CATALOGUE) {
      const froms = d.versions.map((v) => v.effectiveFrom);
      expect([...froms].sort()).toEqual(froms);
    }
    for (const k of LABOR_LAW_KEYS) expect(keys).toContain(k);
  });
});

const V = (effectiveFrom: string, value: number, effectiveTo: string | null = null, id = `rp-${effectiveFrom}`): LegalVersion => ({
  id,
  effectiveFrom,
  effectiveTo,
  value,
  status: 'VERIFIED_PRIMARY',
  sourceUrl: null,
});
const O = (effectiveFrom: string, value: number, effectiveTo: string | null = null, revoked = false): OverrideVersion => ({
  id: `ov-${effectiveFrom}`,
  effectiveFrom,
  effectiveTo,
  value,
  revoked,
});

describe('valueAt resolution (resolveRule)', () => {
  it('picks the registry version in force on the date; a new law applies from its first day only', () => {
    const reg = [V('2005-01-01', 21), V('2030-01-01', 25)];
    expect(resolveRule('ANNUAL_LEAVE_DAYS', '2029-12-31', reg).value).toBe(21);
    expect(resolveRule('ANNUAL_LEAVE_DAYS', '2030-01-01', reg)).toMatchObject({ value: 25, source: 'REGISTRY', legalFrom: '2030-01-01', ruleParameterId: 'rp-2030-01-01' });
  });

  it('falls back to the catalogue when the registry has no row of the key', () => {
    expect(resolveRule('PROBATION_MAX_DAYS', '2026-01-01', [])).toMatchObject({ value: 180, source: 'CATALOGUE', status: 'VERIFIED_PRIMARY' });
  });

  it('a date before the first version applies the earliest one and says so (the pre-P1-RULE behaviour)', () => {
    const r = resolveRule('NOTICE_DAYS_EMPLOYER', '2020-01-01', []);
    expect(r).toMatchObject({ value: 60, beforeFirstVersion: true, legalFrom: '2025-02-19' });
  });

  it('an override in force takes precedence over the legal value; outside its period the law applies', () => {
    const ov = [O('2026-01-01', 25, '2027-01-01')];
    expect(resolveRule('ANNUAL_LEAVE_DAYS', '2026-06-01', [], ov)).toMatchObject({ value: 25, legalValue: 21, source: 'OVERRIDE', overrideId: 'ov-2026-01-01' });
    expect(resolveRule('ANNUAL_LEAVE_DAYS', '2027-01-01', [], ov)).toMatchObject({ value: 21, source: 'CATALOGUE' });
    expect(resolveRule('ANNUAL_LEAVE_DAYS', '2025-12-31', [], ov).value).toBe(21);
  });

  it('a revoked override is ignored', () => {
    expect(resolveRule('ANNUAL_LEAVE_DAYS', '2026-06-01', [], [O('2026-01-01', 25, null, true)]).value).toBe(21);
  });

  it('floor: an override the law has since overtaken is held at the legal minimum (clamped)', () => {
    const reg = [V('2005-01-01', 21, '2030-01-01'), V('2030-01-01', 28)];
    const r = resolveRule('ANNUAL_LEAVE_DAYS', '2031-01-01', reg, [O('2026-01-01', 25)]);
    expect(r).toMatchObject({ value: 28, legalValue: 28, clamped: true, source: 'OVERRIDE' });
  });

  it('ceiling: a MAX key never goes above the law; a FIXED key ignores any override row', () => {
    expect(resolveRule('PROBATION_MAX_DAYS', '2026-01-01', [], [O('2026-01-01', 200)])).toMatchObject({ value: 180, clamped: true });
    expect(resolveRule('PROBATION_MAX_DAYS', '2026-01-01', [], [O('2026-01-01', 90)]).value).toBe(90);
    expect(resolveRule('GOSI_MAX_CONTRIBUTORY_WAGE', '2026-01-01', [], [O('2026-01-01', 1)])).toMatchObject({ value: 45000, source: 'CATALOGUE' });
  });

  it('unknown keys are refused', () => {
    expect(() => resolveRule('NO_SUCH_KEY', '2026-01-01', [])).toThrow(UnknownRuleKeyError);
  });

  it('DEC-PO-126: an acknowledged override outside the bound is used as set and flagged belowLegal (not clamped)', () => {
    const ack = { ...O('2026-01-01', 18), belowLegalAck: true };
    expect(resolveRule('ANNUAL_LEAVE_DAYS', '2026-06-01', [], [ack])).toMatchObject({ value: 18, legalValue: 21, source: 'OVERRIDE', belowLegal: true, clamped: false });
    expect(resolveRule('PROBATION_MAX_DAYS', '2026-06-01', [], [{ ...O('2026-01-01', 200), belowLegalAck: true }])).toMatchObject({ value: 200, belowLegal: true });
    // Within the bound, or without an override, nothing is flagged.
    expect(resolveRule('ANNUAL_LEAVE_DAYS', '2026-06-01', [], [{ ...O('2026-01-01', 25), belowLegalAck: true }])).toMatchObject({ value: 25, belowLegal: false });
    expect(resolveRule('ANNUAL_LEAVE_DAYS', '2026-06-01', []).belowLegal).toBe(false);
    // A FIXED key still ignores any override row.
    expect(resolveRule('GOSI_MAX_CONTRIBUTORY_WAGE', '2026-01-01', [], [{ ...O('2026-01-01', 1), belowLegalAck: true }])).toMatchObject({ value: 45000, belowLegal: false });
  });
});

describe('override bound (assertOverrideAllowed)', () => {
  it('MIN keys accept only values >= the legal minimum, over every overlapping legal version', () => {
    expect(() => assertOverrideAllowed('ANNUAL_LEAVE_DAYS', 25, '2026-01-01', null, [])).not.toThrow();
    expect(() => assertOverrideAllowed('ANNUAL_LEAVE_DAYS', 20, '2026-01-01', null, [])).toThrow(RuleOverrideBoundError);
    const reg = [V('2005-01-01', 21, '2030-01-01'), V('2030-01-01', 28)];
    expect(() => assertOverrideAllowed('ANNUAL_LEAVE_DAYS', 25, '2026-01-01', null, reg)).toThrow(/below the legal minimum 28/);
    expect(() => assertOverrideAllowed('ANNUAL_LEAVE_DAYS', 25, '2026-01-01', '2029-06-01', reg)).not.toThrow();
  });

  it('DEC-PO-126: a breach is acceptable with an acknowledgement (typed error with the legal value), FIXED never', () => {
    expect(overrideBoundBreach('ANNUAL_LEAVE_DAYS', 25, '2026-01-01', null, [])).toBeNull();
    const reg = [V('2005-01-01', 21, '2030-01-01'), V('2030-01-01', 28)];
    expect(overrideBoundBreach('ANNUAL_LEAVE_DAYS', 18, '2026-01-01', null, reg)).toEqual({ bound: 'MIN', legalValue: 28, legalFrom: '2030-01-01' });
    expect(overrideBoundBreach('PROBATION_MAX_DAYS', 200, '2026-01-01', null, [])).toMatchObject({ bound: 'MAX', legalValue: 180 });
    const err = (() => {
      try {
        assertOverrideAllowed('ANNUAL_LEAVE_DAYS', 18, '2026-01-01', null, []);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(RuleOverrideAckRequiredError);
    expect(err).toBeInstanceOf(RuleOverrideBoundError);
    expect(err).toMatchObject({ requiresAcknowledgement: true, code: 'RULE_OVERRIDE_BELOW_LEGAL_ACK_REQUIRED', legalValue: 21, bound: 'MIN' });
    expect((err as RuleOverrideAckRequiredError).messageAr).toMatch(/أقل من الحد النظامي الأدنى 21/);
    expect(() => overrideBoundBreach('EXPAT_LEVY_WITHIN_SAUDI_COUNT', 800, '2026-01-01', null, [])).toThrow(/cannot be overridden/);
    let fixed: unknown;
    try {
      assertOverrideAllowed('EXPAT_LEVY_WITHIN_SAUDI_COUNT', 800, '2026-01-01', null, []);
    } catch (e) {
      fixed = e;
    }
    expect(fixed).not.toBeInstanceOf(RuleOverrideAckRequiredError);
  });

  it('MAX keys accept only values <= the legal maximum; FIXED keys refuse any override', () => {
    expect(() => assertOverrideAllowed('PROBATION_MAX_DAYS', 90, '2026-01-01', null, [])).not.toThrow();
    expect(() => assertOverrideAllowed('PROBATION_MAX_DAYS', 181, '2026-01-01', null, [])).toThrow(/above the legal maximum 180/);
    expect(() => assertOverrideAllowed('EXPAT_LEVY_WITHIN_SAUDI_COUNT', 800, '2026-01-01', null, [])).toThrow(/cannot be overridden/);
    expect(() => assertOverrideAllowed('ANNUAL_LEAVE_DAYS', Number.NaN, '2026-01-01', null, [])).toThrow(RuleOverrideBoundError);
  });

  it('scope: a company outside the caller scope is refused; ALL / null is the explicit cross-company context', () => {
    expect(() => assertCompanyInScope(['c1'], 'c2')).toThrow(RuleScopeError);
    expect(() => assertCompanyInScope(undefined, 'c1')).toThrow(RuleScopeError);
    expect(() => assertCompanyInScope(['c1'], 'c1')).not.toThrow();
    expect(() => assertCompanyInScope('ALL', 'c9')).not.toThrow();
  });
});

function fakeDb(rows: Array<{ key: string; value: number; effectiveFrom: string; effectiveTo?: string | null }>, overrides: Array<{ companyId: string; key: string; value: number; effectiveFrom: string; effectiveTo?: string | null; ack?: boolean }>) {
  const rp = vi.fn(async (args: { where: { key: { in: string[] } } }) =>
    rows
      .filter((r) => args.where.key.in.includes(r.key))
      .map((r, i) => ({ id: `rp${i}`, key: r.key, value: r.value, effectiveFrom: new Date(r.effectiveFrom), effectiveTo: r.effectiveTo ? new Date(r.effectiveTo) : null, status: 'VERIFIED_PRIMARY', sourceUrl: null })),
  );
  const ov = vi.fn(async (args: { where: { companyId: string } }) =>
    overrides
      .filter((o) => o.companyId === args.where.companyId)
      .map((o, i) => ({ id: `ov${i}`, key: o.key, value: o.value, effectiveFrom: new Date(o.effectiveFrom), effectiveTo: o.effectiveTo ? new Date(o.effectiveTo) : null, belowLegalAckAt: o.ack ? new Date() : null })),
  );
  const db = { ruleParameter: { findMany: rp }, companyRuleOverride: { findMany: ov } } as unknown as RulesDb;
  return { db, rp, ov };
}

describe('createRulesReader (per-request cache, override precedence)', () => {
  it('reads each key and each company once per reader', async () => {
    const { db, rp, ov } = fakeDb([{ key: 'ANNUAL_LEAVE_DAYS', value: 21, effectiveFrom: '2005-01-01' }], [{ companyId: 'c1', key: 'ANNUAL_LEAVE_DAYS', value: 26, effectiveFrom: '2026-01-01' }]);
    const r = createRulesReader(db);
    expect(await r.valueAt('ANNUAL_LEAVE_DAYS', 'c1', '2026-05-01')).toBe(26);
    expect(await r.valueAt('ANNUAL_LEAVE_DAYS', 'c1', '2025-05-01')).toBe(21);
    expect(await r.valueAt('ANNUAL_LEAVE_DAYS', 'c2', '2026-05-01')).toBe(21);
    expect(await r.valueAt('ANNUAL_LEAVE_DAYS', null, '2026-05-01')).toBe(21);
    expect(rp).toHaveBeenCalledTimes(1);
    expect(ov).toHaveBeenCalledTimes(2); // c1, c2
  });

  it('DEC-PO-126: belowLegal lists the acknowledged values outside the bound of a company (for the screen warning)', async () => {
    const { db } = fakeDb([], [
      { companyId: 'c1', key: 'ANNUAL_LEAVE_DAYS', value: 18, effectiveFrom: '2026-01-01', ack: true },
      { companyId: 'c1', key: 'NOTICE_DAYS_EMPLOYEE', value: 45, effectiveFrom: '2026-01-01' },
    ]);
    const r = createRulesReader(db);
    const w = await r.belowLegal('c1', '2026-05-01');
    expect(w.map((x) => [x.key, x.value, x.legalValue, x.belowLegal])).toEqual([['ANNUAL_LEAVE_DAYS', 18, 21, true]]);
    expect(await r.belowLegal('c1', '2025-05-01')).toEqual([]);
    expect(await r.belowLegal('c2', '2026-05-01')).toEqual([]);
  });

  it('laborLaw of a company carries its overrides; with an empty registry it equals the catalogue law', async () => {
    const { db } = fakeDb([], [{ companyId: 'c1', key: 'SICK_LEAVE_FULL_PAY_DAYS', value: 45, effectiveFrom: '2026-01-01' }]);
    const r = createRulesReader(db);
    expect(await r.laborLaw(null, '2026-05-01')).toEqual(catalogueLaborLaw('2026-05-01'));
    expect((await r.laborLaw('c1', '2026-05-01')).sickLeave.fullPayDays).toBe(45);
  });
});

describe('catalogue law bundle', () => {
  it('holds the values the code used as constants before P1-RULE', () => {
    const law = catalogueLaborLaw('2026-09-28');
    expect(law.annualLeave).toEqual({ daysBeforeThreshold: 21, daysFromThreshold: 30, thresholdYears: 5 });
    expect(law.sickLeave).toEqual({ fullPayDays: 30, partialPayUntilDay: 90, unpaidUntilDay: 120, partialPayRatio: 0.75 });
    expect(law.eos).toEqual({ firstPeriodYears: 5, firstPeriodMonthsPerYear: 0.5, laterMonthsPerYear: 1, resignationNoneBelowYears: 2, resignationThirdBelowYears: 5, resignationTwoThirdsBelowYears: 10 });
    expect(law.notice).toEqual({ employerDays: 60, employeeDays: 30 });
    expect(law.probation.maxDays).toBe(180);
    expect(overtimeMultiplierOf(law.overtime)).toBe(1.5);
    expect(law.workHours).toEqual({ perDayMax: 8, perWeekMax: 48, ramadanPerDayMax: 6, ramadanPerWeekMax: 36 });
  });
});

// ---------------------------------------------------------------------------
// Behaviour parity: the replaced call sites give the same outputs with the default values
// ---------------------------------------------------------------------------

/** The pre-P1-RULE formulas, copied verbatim (tests are not scanned by ARCH-007). */
const legacy = {
  eos(monthlySalary: number, years: number, reason: TerminationReasonValue | null): number {
    if (!(years > 0) || !(monthlySalary > 0)) return 0;
    if (reason === 'PROBATION' || reason === 'ARTICLE_80') return 0;
    const raw = years <= 5 ? monthlySalary * 0.5 * years : monthlySalary * 0.5 * 5 + monthlySalary * (years - 5);
    const r = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
    if (reason === 'RESIGNATION') {
      if (years < 2) return 0;
      if (years < 5) return r(raw / 3);
      if (years < 10) return r((raw * 2) / 3);
      return r(raw);
    }
    return r(raw);
  },
  sick(past: number, total: number) {
    const t = { past, full: 0, partial: 0, unpaid: 0, beyond: 0 };
    let day = past;
    for (let i = 0; i < total; i++) {
      day++;
      if (day <= 30) t.full++;
      else if (day <= 90) t.partial++;
      else if (day <= 120) t.unpaid++;
      else t.beyond++;
    }
    return t;
  },
};

describe('parity of the replaced call sites (default values)', () => {
  it('leave.ts: annual rates, balance threshold, sick tiers, statutory defaults', () => {
    expect(annualEntitlementRates(null)).toEqual({ under5: 21, from5: 30 });
    expect(annualEntitlementRates(25)).toEqual({ under5: 25, from5: 30 });
    expect(SERVICE_YEARS_FOR_HIGHER_ACCRUAL).toBe(5);
    for (const [past, total] of [[0, 10], [25, 10], [85, 40], [110, 30], [0, 200]]) {
      expect(computeSickLeaveTiers(past, total)).toEqual(legacy.sick(past, total));
    }
    expect(DEFAULT_STATUTORY_LEAVE_RULES).toEqual({
      maternityDays: 84,
      maternityUnpaidExtensionDays: 30,
      paternityDays: 3,
      paternityWindowDays: 7,
      marriageDays: 5,
      bereavementDays: 5,
      bereavementSiblingDays: 3,
      hajjDays: 10,
      hajjMinServiceYears: 2,
    });
    const sick = computeLeaveRequest({ leaveType: 'SICK', totalDays: 40, availableBalance: 0, dailyRate: 100, pastSickDays: 70 });
    expect(sick.totalDeduction).toBe(20 * 100 * 0.25 + 20 * 100); // 20 days at 75%, 20 unpaid
  });

  it('leave.ts: the balance is the same with the default law and with the catalogue law passed explicitly', () => {
    const input = { joinDate: '2019-03-10', asOf: '2026-09-28', leaves: [] };
    const a = computeLeaveBalance(input);
    const b = computeLeaveBalance({ ...input, law: catalogueLaborLaw('2026-09-28').annualLeave });
    expect(a).toEqual(b);
    expect(a.annualEntitlement).toBe(30);
  });

  it('a company law (override) changes the result where the law is passed: balance, sick tiers, statutory rules', () => {
    const law = { ...catalogueLaborLaw().annualLeave, daysBeforeThreshold: 25 };
    expect(computeLeaveBalance({ joinDate: '2025-01-01', asOf: '2026-01-01', leaves: [], law }).accrued).toBe(25);
    expect(computeSickLeaveTiers(0, 40, { ...catalogueLaborLaw().sickLeave, fullPayDays: 40 }).full).toBe(40);
    const rules = statutoryLeaveRulesFromLaw({ ...catalogueLaborLaw().statutoryLeave, marriageDays: 7 });
    expect(parseStatutoryLeaveRules({}, rules).marriageDays).toBe(7);
    expect(parseStatutoryLeaveRules({ leave_marriage_days: '6' }, rules).marriageDays).toBe(6);
  });

  it('settlement.ts: endOfServiceAward equals the pre-P1-RULE formula for every reason and tenure', () => {
    const reasons: Array<TerminationReasonValue | null> = [null, 'RESIGNATION', 'COMPANY_TERMINATION', 'PROBATION', 'ARTICLE_80'];
    for (const reason of reasons) {
      for (const years of [0, 0.5, 1.99, 2, 3.25, 4.999, 5, 5.01, 7.3, 9.99, 10, 12.5, 25]) {
        for (const wage of [0, 3000, 12345.67]) {
          expect(endOfServiceAward(wage, years, reason), `${reason} ${years} ${wage}`).toBe(legacy.eos(wage, years, reason));
        }
      }
    }
    expect(fullEndOfServiceAward(10000, 7)).toBe(10000 * 0.5 * 5 + 10000 * 2);
  });

  it('settlement.ts: computeSettlement is identical with and without the explicit catalogue law', () => {
    const input = {
      type: 'END_OF_SERVICE' as const,
      terminationReason: 'RESIGNATION' as const,
      salaryBasis: 'total' as const,
      employee: { basicSalary: 8000, allowances: [{ name: 'سكن', amount: 2000, isMonthly: true }], joinDate: new Date('2018-02-01'), nationality: 'سعودي' },
      lastWorkingDate: new Date('2026-09-15'),
      asOf: new Date('2026-09-28'),
      leaves: [],
      outstandingLoans: 0,
      overtime: 0,
      manualEntitlements: 0,
      manualDeductions: 0,
    };
    const law = catalogueLaborLaw('2026-09-15');
    expect(computeSettlement({ ...input, law: { eos: law.eos, annualLeave: law.annualLeave } })).toEqual(computeSettlement(input));
  });

  it('payroll-core.ts: default settings, GOSI cap and sick deduction weights', () => {
    expect(DEFAULT_PAYROLL_SETTINGS.overtimeMultiplier).toBe(1.5);
    expect(DEFAULT_PAYROLL_SETTINGS.gosiEmployeePercentage).toBe(9.75);
    expect(GOSI_MAX_CONTRIBUTORY_WAGE).toBe(45000);
    const sick: LeaveLike = { id: 's', leaveType: 'SICK', startDate: new Date('2026-01-01'), endDate: new Date('2026-04-30'), totalDays: 120, totalDeduction: null };
    const months = [1, 2, 3, 4].map((m) => leaveDeductionForMonth(sick, [sick], 100, 2026, m));
    // days 1-30 full pay, 31-90 at 75% (25% deducted), 91-120 unpaid
    expect(months.map((m) => [m.sickReducedDays, m.sickUnpaidDays])).toEqual([[1, 0], [28, 0], [31, 0], [0, 30]]);
    expect(months.map((m) => m.amount)).toEqual([25, 700, 775, 3000]);
  });

  it('gosi.ts: the fallback rates are the documented OLD-regime rows', () => {
    expect(DEFAULT_GOSI_RATES.map((r) => [r.regime, r.isSaudi, r.effectiveFrom.toISOString().slice(0, 10), r.employeeRate, r.employerRate, r.minWage, r.maxWage, r.isProvisional])).toEqual([
      ['OLD', true, '2000-01-01', 9.75, 11.75, 1500, 45000, false],
      ['OLD', false, '2000-01-01', 0, 2, 1500, 45000, false],
    ]);
  });

  it('termination.ts, employee-shared.ts: notice and probation defaults', () => {
    const submitted = new Date('2026-09-01T09:00:00Z');
    expect(suggestedLastWorkingDay(submitted, 'MUTUAL_AGREEMENT', null)).toBe('2026-10-01');
    expect(suggestedLastWorkingDay(submitted, 'MUTUAL_AGREEMENT', null, 45)).toBe('2026-10-16');
    expect(suggestedLastWorkingDay(submitted, 'MUTUAL_AGREEMENT', 10)).toBe('2026-09-11');
    expect(PROBATION_WARNING_DAYS).toBe(180);
    expect(probationWarning(180)).toBeNull();
    expect(probationWarning(181)).toContain('180');
    expect(probationWarning(100, 90)).toContain('90');
  });

  it('workforce formulas: leave liability entitlement 21 / 30 (threshold 5 years)', () => {
    const j = new Date('2020-01-01');
    expect(leaveLiabilityMonthly({ joinDate: j, from: new Date('2024-12-31'), to: new Date('2025-01-31'), dailyWage: 100 }).entitlement).toBe(30);
    expect(leaveLiabilityMonthly({ joinDate: j, from: new Date('2023-12-31'), to: new Date('2024-01-31'), dailyWage: 100 }).entitlement).toBe(21);
    expect(leaveLiabilityMonthly({ joinDate: j, from: new Date('2023-12-31'), to: new Date('2024-01-31'), dailyWage: 100, annualLeaveDaysSetting: 25 }).entitlement).toBe(25);
  });

  it('catalogueValueAt is dated', () => {
    expect(catalogueValueAt('ANNUAL_LEAVE_DAYS', '2010-01-01')).toBe(21);
    expect(catalogueValueAt('RAMADAN_WORK_HOURS_PER_DAY_MAX')).toBe(6);
  });
});

describe('DEC-PO-126 owner alert and INV-RULE-02 check', () => {
  it('the owner alert names the rule and the two values, never a company, a person, an id or the reason', () => {
    const msg = belowLegalOwnerAlert({ payload: { key: 'ANNUAL_LEAVE_DAYS', value: 18, legalValue: 21, bound: 'MIN', effectiveFrom: '2026-01-01' } }, { APP_URL: 'https://hr.example.test' });
    expect(msg?.subject).toContain('أقل من الحد النظامي الأدنى');
    expect(msg?.body).toContain('18');
    expect(msg?.body).toContain('21');
    expect(msg?.body).toContain('https://hr.example.test/login');
    expect(belowLegalOwnerAlert({ payload: { key: 'PROBATION_MAX_DAYS', value: 200, legalValue: 180, bound: 'MAX' } }, {})?.subject).toContain('أعلى من الحد النظامي الأعلى');
    expect(belowLegalOwnerAlert({ payload: {} }, {})).toBeNull();
    expect(ownerAlertRecipient({ OWNER_ALERT_EMAIL: 'owner@example.test' })).toBe('owner@example.test');
    expect(ownerAlertRecipient({ OWNER_ALERT_EMAIL: 'x <a@b.c>' })).toBeNull();
    expect(ownerAlertRecipient({})).toBeNull();
  });

  it('INV-RULE-02 reports each active acknowledged override as a WARNING finding already explained by its acknowledgement', async () => {
    const findMany = vi.fn(async () => [
      { id: 'o1', companyId: 'c1', key: 'ANNUAL_LEAVE_DAYS', value: 18, belowLegalAckById: 'u1', belowLegalReason: 'اتفاق', belowLegalLegalValue: 21 },
      { id: 'o2', companyId: 'c2', key: 'PROBATION_MAX_DAYS', value: 200, belowLegalAckById: null, belowLegalReason: 'سبب', belowLegalLegalValue: 180 },
    ]);
    const [r] = await belowLegalOverrideResults({ companyRuleOverride: { findMany } }, new Date('2026-05-01T10:00:00Z'));
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { belowLegalAckAt: { not: null }, revokedAt: null, OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date('2026-05-01T00:00:00.000Z') } }] } }));
    expect(r).toMatchObject({ invariant: 'INV-RULE-02', severity: 'WARNING', entityType: 'CompanyRuleOverride', count: 2, byCompany: { c1: 1, c2: 1 } });
    expect(r.entities?.[0]).toMatchObject({ id: 'o1', companyId: 'c1', tag: 'ANNUAL_LEAVE_DAYS=18', explained: { category: 'ACKNOWLEDGED_BELOW_LEGAL', ref: 'CompanyRuleOverride:o1', by: 'u1' } });
    expect(r.entities?.[1].explained?.by).toBe('system');
  });
});
