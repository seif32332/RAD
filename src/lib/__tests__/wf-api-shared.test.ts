// Workforce API/UI shared helpers (src/app/api/workforce/_lib/shared.ts): «لماذا؟» evidence picking,
// CSV export, labels. Pure, no database.
import { describe, expect, it } from 'vitest';
import type { RuleEvidence } from '@/lib/workforce';
import { FLAG_FIX, FLAG_TITLES, STATUS_LABELS, evidenceForLine, formatRuleValue, isHorizon, toCsv, windowField } from '@/app/api/workforce/_lib/shared';

const ev = (key: string, effectiveFrom: string | null, value: number | null = 1, status: RuleEvidence['status'] = 'VERIFIED_PRIMARY'): RuleEvidence => ({
  key,
  label: key,
  value,
  unit: null,
  status,
  sourceUrl: null,
  sourceQuote: null,
  effectiveFrom,
});

describe('evidenceForLine', () => {
  const explanation = {
    rules: [ev('HRDF_CAP_SAR', '2026-08-01', 3000), ev('HRDF_CAP_SAR', '2027-01-01', 3500), ev('GOSI_RATE:NEW:SA:2026-07-01', '2026-07-01', 12.75), ev('LAW:ART84', null, null)],
  };

  it('keeps only the rules of the line, with the version in force in that month', () => {
    const line = { ruleKeys: ['HRDF_CAP_SAR'] };
    expect(evidenceForLine(line, '2026-09', explanation).map((e) => e.value)).toEqual([3000]);
    expect(evidenceForLine(line, '2027-01', explanation).map((e) => e.value)).toEqual([3500]);
    expect(evidenceForLine(line, '2028-05', explanation).map((e) => e.value)).toEqual([3500]);
  });

  it('a version starting later than the month falls back to the earliest one (engine applies it to the whole month)', () => {
    expect(evidenceForLine({ ruleKeys: ['HRDF_CAP_SAR'] }, '2026-07', explanation).map((e) => e.effectiveFrom)).toEqual(['2026-08-01']);
  });

  it('GOSI pseudo keys and law references match exactly; order follows the line', () => {
    const out = evidenceForLine({ ruleKeys: ['LAW:ART84', 'GOSI_RATE:NEW:SA:2026-07-01'] }, '2026-10', explanation);
    expect(out.map((e) => e.key)).toEqual(['LAW:ART84', 'GOSI_RATE:NEW:SA:2026-07-01']);
  });

  it('ASSUMPTION keys come from the assumption evidence; unknown keys are shown as MISSING', () => {
    const a = { 'ASSUMPTION:ANNUAL_TICKET_COST': { ...ev('ASSUMPTION:ANNUAL_TICKET_COST', null, 2000), status: 'USER_INPUT' as const } };
    const out = evidenceForLine({ ruleKeys: ['ASSUMPTION:ANNUAL_TICKET_COST', 'ASSUMPTION:VACANCY_MONTHS', 'NOT_IN_EXPLANATION'] }, '2026-10', explanation, a);
    expect(out.map((e) => [e.key, e.status])).toEqual([
      ['ASSUMPTION:ANNUAL_TICKET_COST', 'USER_INPUT'],
      ['ASSUMPTION:VACANCY_MONTHS', 'MISSING'],
      ['NOT_IN_EXPLANATION', 'MISSING'],
    ]);
  });

  it('duplicate keys are listed once; a line without keys has no evidence', () => {
    expect(evidenceForLine({ ruleKeys: ['LAW:ART84', 'LAW:ART84'] }, '2026-10', explanation)).toHaveLength(1);
    expect(evidenceForLine({ ruleKeys: [] }, '2026-10', explanation)).toEqual([]);
  });
});

describe('toCsv', () => {
  it('starts with a BOM, uses CRLF, quotes commas / quotes / new lines', () => {
    const csv = toCsv([
      ['a', 'b,c', 'say "hi"'],
      [1.5, null, 'x\ny'],
    ]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.slice(1)).toBe('a,"b,c","say ""hi"""\r\n1.5,,"x\ny"');
  });

  it('neutralises spreadsheet formulas in text cells but not negative numbers', () => {
    const csv = toCsv([['=SUM(A1)', '+1', '@x', -250]]);
    expect(csv.slice(1)).toBe("'=SUM(A1),'+1,'@x,-250");
  });
});

describe('labels and formatting', () => {
  it('every status and flag has an Arabic label and a fix target', () => {
    for (const s of ['VERIFIED_PRIMARY', 'CORROBORATED_SECONDARY', 'PROVISIONAL', 'CONFLICTING', 'USER_INPUT', 'MISSING', 'DERIVED'] as const) expect(STATUS_LABELS[s]).toMatch(/[؀-ۿ]/);
    expect(STATUS_LABELS.VERIFIED_PRIMARY).toBe('موثّق من المصدر الرسمي');
    expect(Object.keys(FLAG_TITLES).sort()).toEqual(Object.keys(FLAG_FIX).sort());
    expect(FLAG_FIX.MISSING_GOSI_REGIME).toBe('EMPLOYEE');
    expect(FLAG_FIX.MISSING_MEDICAL_PREMIUM).toBe('COMPANY'); // fixed in the company «إعدادات الكلفة»
    expect(FLAG_FIX.PROVISIONAL_RULE).toBe('RULES');
  });

  it('formatRuleValue uses Latin digits and units', () => {
    expect(formatRuleValue(45000, 'SAR_MONTH')).toBe('45,000 ريال شهرياً');
    expect(formatRuleValue(12.75, 'PERCENT')).toBe('12.75%');
    expect(formatRuleValue(1, 'FLAG')).toBe('مفعّل');
    expect(formatRuleValue(null, 'SAR')).toBe('—');
    expect(formatRuleValue(7, 'UNKNOWN_UNIT')).toBe('7 UNKNOWN_UNIT');
  });

  it('horizon helpers', () => {
    expect(windowField(12)).toBe('next12');
    expect(windowField(24)).toBe('next24');
    expect(windowField(36)).toBe('next36');
    expect(isHorizon(24)).toBe(true);
    expect(isHorizon(6)).toBe(false);
  });
});
