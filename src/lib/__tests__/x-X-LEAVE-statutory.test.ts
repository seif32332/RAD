// X-LEAVE (DEC-003): statutory leave types — eligibility, paid/unpaid day counts, settings parsing,
// and the guarantee that none of them consumes the annual leave balance.
import { describe, expect, it } from 'vitest';
import {
  BALANCE_LEAVE_TYPES,
  BLOCKING_LEAVE_ISSUES,
  DEFAULT_STATUTORY_LEAVE_RULES,
  LEAVE_ISSUE_MESSAGES,
  LEAVE_RULE_SETTING_KEYS,
  LEAVE_TYPES,
  LEAVE_TYPE_LABELS,
  STATUTORY_LEAVE_TYPES,
  buildStatutoryNoteMarkers,
  completedServiceYears,
  computeLeaveBalance,
  computeLeaveRequest,
  computeStatutoryLeave,
  describeLeaveIssue,
  leaveTypeLabel,
  normalizeGender,
  parseStatutoryLeaveRules,
  parseStatutoryNoteMarkers,
  recalculateShortenedLeave,
  statutoryEntitlementDays,
  stripStatutoryNoteMarkers,
  type StatutoryLeaveContext,
} from '@/lib/leave';
import { SETTING_DEFS, PROVISIONAL_SETTING_KEYS, settingValueProblem } from '@/app/api/settings/definitions';

const R = DEFAULT_STATUTORY_LEAVE_RULES;
const female: StatutoryLeaveContext = { rules: R, gender: 'FEMALE', serviceYears: 3, priorHajjLeaves: 0 };
const male: StatutoryLeaveContext = { rules: R, gender: 'MALE', serviceYears: 3, priorHajjLeaves: 0 };

describe('labels and types', () => {
  it('has an Arabic label for every leave type (incl. the new statutory types)', () => {
    for (const t of LEAVE_TYPES) expect(LEAVE_TYPE_LABELS[t]).toBeTruthy();
    expect(LEAVE_TYPES).toEqual(expect.arrayContaining(['MATERNITY', 'PATERNITY', 'BEREAVEMENT', 'MARRIAGE', 'HAJJ']));
    expect(leaveTypeLabel('HAJJ')).toBe('حج');
    expect(leaveTypeLabel('UNKNOWN_X')).toBe('UNKNOWN_X');
    expect(leaveTypeLabel(null)).toBe('');
  });

  it('every issue code has a message', () => {
    for (const code of BLOCKING_LEAVE_ISSUES) expect(LEAVE_ISSUE_MESSAGES[code as keyof typeof LEAVE_ISSUE_MESSAGES]).toBeTruthy();
    expect(LEAVE_ISSUE_MESSAGES.STATUTORY_EXTENSION_NOT_ACCEPTED).toBeTruthy();
  });
});

describe('defaults (provisional) and settings', () => {
  it('uses the 2025 amended values as defaults', () => {
    expect(R).toEqual({
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
  });

  it('registers every rule key in the settings definitions, marked provisional, with its default', () => {
    for (const [field, key] of Object.entries(LEAVE_RULE_SETTING_KEYS)) {
      expect(SETTING_DEFS[key]).toBeDefined();
      expect(SETTING_DEFS[key].defaultValue).toBe(String(R[field as keyof typeof R]));
      expect(SETTING_DEFS[key].integer).toBe(true);
      expect(PROVISIONAL_SETTING_KEYS).toContain(key);
    }
    expect(settingValueProblem('leave_hajj_days', '15')).toBeNull();
    expect(settingValueProblem('leave_hajj_days', '2.5')).not.toBeNull();
    expect(settingValueProblem('leave_maternity_days', '0')).not.toBeNull();
  });

  it('parses stored values and falls back to defaults for missing / invalid ones', () => {
    const rules = parseStatutoryLeaveRules(
      new Map([
        ['leave_hajj_days', '15'],
        ['leave_marriage_days', '"7"'],
        ['leave_paternity_days', 'abc'],
        ['leave_bereavement_days', '-1'],
        ['leave_maternity_days', ''],
      ]),
    );
    expect(rules.hajjDays).toBe(15);
    expect(rules.marriageDays).toBe(7);
    expect(rules.paternityDays).toBe(3);
    expect(rules.bereavementDays).toBe(5);
    expect(rules.maternityDays).toBe(84);
    expect(parseStatutoryLeaveRules({ leave_hajj_min_service_years: '0' }).hajjMinServiceYears).toBe(0);
  });
});

describe('normalizeGender / completedServiceYears', () => {
  it.each([
    ['MALE', 'MALE'],
    ['ذكر', 'MALE'],
    ['FEMALE', 'FEMALE'],
    ['female', 'FEMALE'],
    ['أنثى', 'FEMALE'],
    ['', null],
    [null, null],
    ['other', null],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeGender(input)).toBe(expected);
  });

  it('counts completed anniversary years', () => {
    expect(completedServiceYears('2024-03-10', '2026-03-09')).toBe(1);
    expect(completedServiceYears('2024-03-10', '2026-03-10')).toBe(2);
    expect(completedServiceYears('2026-03-10', '2025-01-01')).toBe(0);
  });
});

describe('MATERNITY', () => {
  it('is for female employees only', () => {
    expect(computeStatutoryLeave('MATERNITY', 30, male).issue).toBe('MATERNITY_FEMALE_ONLY');
    expect(computeStatutoryLeave('MATERNITY', 30, { ...female, gender: null }).issue).toBe('MATERNITY_FEMALE_ONLY');
    expect(computeStatutoryLeave('MATERNITY', 30, { ...female, gender: 'أنثى' }).issue).toBeNull();
  });

  it('pays up to 84 days in full', () => {
    expect(computeStatutoryLeave('MATERNITY', 84, female)).toEqual({ paidDays: 84, unpaidDays: 0, entitlementDays: 84, issue: null });
  });

  it('accepts the unpaid extension only when confirmed, and never beyond it', () => {
    expect(computeStatutoryLeave('MATERNITY', 100, female).issue).toBe('STATUTORY_EXTENSION_NOT_ACCEPTED');
    expect(computeStatutoryLeave('MATERNITY', 100, female, true)).toEqual({ paidDays: 84, unpaidDays: 16, entitlementDays: 84, issue: null });
    expect(computeStatutoryLeave('MATERNITY', 115, female, true).issue).toBe('STATUTORY_MAX_EXCEEDED');
  });

  it('deducts only the unpaid extension days and ignores the annual balance', () => {
    const r = computeLeaveRequest({ leaveType: 'MATERNITY', totalDays: 94, availableBalance: 0, dailyRate: 100, acceptUnpaidExtraDays: true, statutory: female });
    expect(r).toMatchObject({ paidDays: 84, unpaidDays: 10, totalDeduction: 1000, issue: null, entitlementDays: 84 });
    const withBalance = computeLeaveRequest({ leaveType: 'MATERNITY', totalDays: 60, availableBalance: 25, dailyRate: 100, statutory: female });
    expect(withBalance).toMatchObject({ paidDays: 60, unpaidDays: 0, totalDeduction: 0, issue: null });
  });

  it('follows a configured value', () => {
    const rules = { ...R, maternityDays: 70 };
    expect(computeStatutoryLeave('MATERNITY', 84, { ...female, rules }, true)).toMatchObject({ paidDays: 70, unpaidDays: 14 });
  });
});

describe('PATERNITY', () => {
  it('is for male employees, 3 paid days', () => {
    expect(computeStatutoryLeave('PATERNITY', 3, female).issue).toBe('PATERNITY_MALE_ONLY');
    expect(computeStatutoryLeave('PATERNITY', 3, male)).toEqual({ paidDays: 3, unpaidDays: 0, entitlementDays: 3, issue: null });
    expect(computeStatutoryLeave('PATERNITY', 4, male).issue).toBe('STATUTORY_MAX_EXCEEDED');
  });

  it('must be taken within 7 days of the birth when the birth date is known', () => {
    expect(computeStatutoryLeave('PATERNITY', 3, { ...male, daysFromEvent: 0 }).issue).toBeNull();
    expect(computeStatutoryLeave('PATERNITY', 3, { ...male, daysFromEvent: 4 }).issue).toBeNull(); // days 4..6
    expect(computeStatutoryLeave('PATERNITY', 3, { ...male, daysFromEvent: 5 }).issue).toBe('EVENT_WINDOW_INVALID');
    expect(computeStatutoryLeave('PATERNITY', 1, { ...male, daysFromEvent: 10 }).issue).toBe('EVENT_WINDOW_INVALID');
    expect(computeStatutoryLeave('PATERNITY', 1, { ...male, daysFromEvent: -1 }).issue).toBe('EVENT_WINDOW_INVALID');
  });
});

describe('MARRIAGE / BEREAVEMENT', () => {
  it('gives 5 days for marriage and first-degree bereavement, 3 for a sibling', () => {
    expect(statutoryEntitlementDays('MARRIAGE', R)).toBe(5);
    expect(statutoryEntitlementDays('BEREAVEMENT', R)).toBe(5);
    expect(statutoryEntitlementDays('BEREAVEMENT', R, 'FIRST_DEGREE')).toBe(5);
    expect(statutoryEntitlementDays('BEREAVEMENT', R, 'SIBLING')).toBe(3);
    expect(computeStatutoryLeave('MARRIAGE', 5, female).issue).toBeNull();
    expect(computeStatutoryLeave('MARRIAGE', 6, male).issue).toBe('STATUTORY_MAX_EXCEEDED');
    expect(computeStatutoryLeave('BEREAVEMENT', 4, { ...male, bereavementRelation: 'SIBLING' }).issue).toBe('STATUTORY_MAX_EXCEEDED');
    expect(computeStatutoryLeave('BEREAVEMENT', 3, { ...female, bereavementRelation: 'SIBLING' })).toEqual({ paidDays: 3, unpaidDays: 0, entitlementDays: 3, issue: null });
  });

  it('counts the entitlement from the date of the event', () => {
    // Death 2 days before the leave start: 3 of the 5 days remain.
    expect(computeStatutoryLeave('BEREAVEMENT', 3, { ...male, daysFromEvent: 2 })).toEqual({ paidDays: 3, unpaidDays: 0, entitlementDays: 3, issue: null });
    expect(computeStatutoryLeave('BEREAVEMENT', 4, { ...male, daysFromEvent: 2 }).issue).toBe('STATUTORY_MAX_EXCEEDED');
    expect(computeStatutoryLeave('MARRIAGE', 1, { ...male, daysFromEvent: 5 }).issue).toBe('EVENT_WINDOW_INVALID');
    expect(computeStatutoryLeave('MARRIAGE', 1, { ...male, daysFromEvent: -3 }).issue).toBe('EVENT_WINDOW_INVALID');
  });

  it('is allowed for both genders', () => {
    expect(computeStatutoryLeave('MARRIAGE', 5, { ...male, gender: null }).issue).toBeNull();
    expect(computeStatutoryLeave('BEREAVEMENT', 5, { ...female, gender: '' }).issue).toBeNull();
  });
});

describe('HAJJ', () => {
  it('requires the minimum completed years of service', () => {
    expect(computeStatutoryLeave('HAJJ', 10, { ...male, serviceYears: 1 }).issue).toBe('HAJJ_SERVICE_TOO_SHORT');
    expect(computeStatutoryLeave('HAJJ', 10, { ...male, serviceYears: 2 }).issue).toBeNull();
    expect(computeStatutoryLeave('HAJJ', 10, { ...male, serviceYears: 0, rules: { ...R, hajjMinServiceYears: 0 } }).issue).toBeNull();
  });

  it('is granted once per service', () => {
    expect(computeStatutoryLeave('HAJJ', 10, { ...female, priorHajjLeaves: 1 }).issue).toBe('HAJJ_ALREADY_TAKEN');
    expect(computeStatutoryLeave('HAJJ', 10, { ...female, priorHajjLeaves: 0 })).toEqual({ paidDays: 10, unpaidDays: 0, entitlementDays: 10, issue: null });
  });

  it('caps the days at the configured value (10 by default, up to 15 by company policy)', () => {
    expect(computeStatutoryLeave('HAJJ', 12, male).issue).toBe('STATUTORY_MAX_EXCEEDED');
    expect(computeStatutoryLeave('HAJJ', 12, { ...male, rules: { ...R, hajjDays: 15 } }).issue).toBeNull();
  });

  it('describes the service issue with the configured years', () => {
    expect(describeLeaveIssue('HAJJ_SERVICE_TOO_SHORT', { rules: { ...R, hajjMinServiceYears: 3 } })).toContain('3');
  });
});

describe('annual balance is never consumed by statutory leaves', () => {
  it('excludes every statutory type from BALANCE_LEAVE_TYPES', () => {
    for (const t of STATUTORY_LEAVE_TYPES) expect(BALANCE_LEAVE_TYPES).not.toContain(t);
  });

  it('keeps the balance unchanged after approved statutory leaves', () => {
    const base = { joinDate: '2020-01-01', asOf: '2026-01-01' };
    const without = computeLeaveBalance({ ...base, leaves: [] });
    const withStatutory = computeLeaveBalance({
      ...base,
      leaves: STATUTORY_LEAVE_TYPES.map((t, i) => ({
        id: `s${i}`,
        leaveType: t,
        status: 'APPROVED',
        paidDays: 5,
        startDate: `2025-0${i + 1}-01`,
        endDate: `2025-0${i + 1}-05`,
        createdAt: `2025-0${i + 1}-01`,
      })),
    });
    expect(withStatutory.taken).toBe(0);
    expect(withStatutory.available).toBe(without.available);
  });

  it('computeLeaveRequest uses default rules when no context is given', () => {
    const r = computeLeaveRequest({ leaveType: 'MARRIAGE', totalDays: 5, availableBalance: 0, dailyRate: 100, statutory: { rules: R } });
    expect(r).toMatchObject({ paidDays: 5, unpaidDays: 0, totalDeduction: 0, issue: null });
  });

  it('shortening a statutory leave keeps it fully paid', () => {
    expect(recalculateShortenedLeave({ leaveType: 'MATERNITY', paidDays: 84, unpaidDays: 10, totalDeduction: 1000, dailyDeductionRate: 100, newTotalDays: 60 })).toEqual({
      totalDays: 60,
      paidDays: 60,
      unpaidDays: 0,
      totalDeduction: 0,
    });
  });
});

describe('notes markers', () => {
  it('round-trips the event date and relation, and strips them for display', () => {
    const m = buildStatutoryNoteMarkers({ eventDate: '2026-05-01', bereavementRelation: 'SIBLING' });
    expect(m).toBe('[event:2026-05-01] [relation:SIBLING]');
    const notes = `وفاة الأخ ${m}`;
    expect(parseStatutoryNoteMarkers(notes)).toEqual({ eventDate: '2026-05-01', bereavementRelation: 'SIBLING' });
    expect(stripStatutoryNoteMarkers(notes)).toBe('وفاة الأخ');
    expect(parseStatutoryNoteMarkers('[event:2026-13-40] [relation:COUSIN]')).toEqual({ eventDate: null, bereavementRelation: null });
    expect(parseStatutoryNoteMarkers(null)).toEqual({ eventDate: null, bereavementRelation: null });
  });
});
