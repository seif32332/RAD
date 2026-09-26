import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  ALLOWANCE_TYPES,
  EXIT_REASONS,
  EXIT_REASON_LABELS,
  allowanceTypeFromName,
  defaultExitVoluntary,
  employeeExitFieldsSchema,
  employeeWorkforceFieldsSchema,
  redactWorkforceForPayroll,
  resolveWorkforceFields,
  zAllowanceType,
  type WorkforceFieldsCurrent,
} from '@/app/api/employees/_workforce-fields';

const NOW = new Date('2026-09-26T09:00:00.000Z');
const utc = (s: string) => new Date(`${s}T00:00:00.000Z`);

const current = (over: Partial<WorkforceFieldsCurrent> = {}): WorkforceFieldsCurrent => ({
  contractType: 'FULL_TIME',
  isTerminated: false,
  isDisabled: false,
  muawamaCertExpiry: null,
  partTimeWeeklyHours: null,
  qiwaContractDocumented: false,
  qiwaContractDocumentedAt: null,
  exitReason: null,
  exitVoluntary: null,
  ...over,
});

const isArabic = (m: string) => /[؀-ۿ]/.test(m);
function issues(schema: { safeParse: (v: unknown) => { success: boolean; error?: ZodError } }, v: unknown): string[] {
  const r = schema.safeParse(v);
  return r.success ? [] : (r.error as ZodError).issues.map((i) => i.message);
}

describe('employeeWorkforceFieldsSchema (validation, Arabic messages)', () => {
  it('parses form strings: numbers, booleans, dates, blanks', () => {
    const v = employeeWorkforceFieldsSchema.parse({
      occupationName: '  محاسب   عام ',
      occupationCode: '٢٤١١٠١',
      dependentsCount: '3',
      dependentsFeePaidBy: 'COMPANY',
      isDisabled: 'true',
      muawamaCertExpiry: '2027-01-31',
      isStudent: false,
      partTimeWeeklyHours: '20',
      qiwaContractDocumented: true,
      qiwaContractDocumentedAt: '',
      medicalInsuranceClass: 'vip',
    });
    expect(v).toEqual({
      occupationName: 'محاسب عام',
      occupationCode: '241101',
      dependentsCount: 3,
      dependentsFeePaidBy: 'COMPANY',
      isDisabled: true,
      muawamaCertExpiry: utc('2027-01-31'),
      isStudent: false,
      partTimeWeeklyHours: 20,
      qiwaContractDocumented: true,
      qiwaContractDocumentedAt: null,
      medicalInsuranceClass: 'VIP',
    });
  });

  it('missing keys stay undefined (partial update); blanks clear nullable fields; blank flags are left unchanged', () => {
    expect(employeeWorkforceFieldsSchema.parse({})).toEqual({});
    const v = employeeWorkforceFieldsSchema.parse({ occupationName: '', dependentsCount: '', dependentsFeePaidBy: '', medicalInsuranceClass: '', isStudent: '' });
    expect(v).toEqual({ occupationName: null, dependentsCount: null, dependentsFeePaidBy: null, medicalInsuranceClass: null });
  });

  it('dependentsCount 0..30, whole numbers only', () => {
    expect(employeeWorkforceFieldsSchema.parse({ dependentsCount: 0 }).dependentsCount).toBe(0);
    expect(employeeWorkforceFieldsSchema.parse({ dependentsCount: 30 }).dependentsCount).toBe(30);
    for (const bad of [-1, 31, 2.5, 'abc']) {
      const msgs = issues(employeeWorkforceFieldsSchema, { dependentsCount: bad });
      expect(msgs.length, String(bad)).toBeGreaterThan(0);
      expect(msgs.every(isArabic)).toBe(true);
      expect(msgs.join(' ')).toContain('المرافقين');
    }
  });

  it('partTimeWeeklyHours 1..48', () => {
    expect(employeeWorkforceFieldsSchema.parse({ partTimeWeeklyHours: 48 }).partTimeWeeklyHours).toBe(48);
    expect(employeeWorkforceFieldsSchema.parse({ partTimeWeeklyHours: '12.5' }).partTimeWeeklyHours).toBe(12.5);
    for (const bad of [0, 49, 'x']) {
      const msgs = issues(employeeWorkforceFieldsSchema, { partTimeWeeklyHours: bad });
      expect(msgs.length, String(bad)).toBeGreaterThan(0);
      expect(msgs.every(isArabic)).toBe(true);
    }
  });

  it('rejects unknown enum values and bad dates with Arabic messages', () => {
    const cases: Array<[string, unknown]> = [
      ['dependentsFeePaidBy', 'BOSS'],
      ['medicalInsuranceClass', 'Z'],
      ['muawamaCertExpiry', 'not-a-date'],
      ['qiwaContractDocumentedAt', 'yesterday'],
      ['occupationCode', 'ABC'],
      ['isDisabled', 'maybe'],
    ];
    for (const [field, value] of cases) {
      const msgs = issues(employeeWorkforceFieldsSchema, { [field]: value });
      expect(msgs.length, field).toBeGreaterThan(0);
      expect(msgs.every(isArabic), `${field}: ${msgs.join(' | ')}`).toBe(true);
    }
  });

  it('exit fields: fixed list + voluntary flag', () => {
    expect(employeeExitFieldsSchema.parse({ exitReason: 'ARTICLE_80', exitVoluntary: 'false' })).toEqual({ exitReason: 'ARTICLE_80', exitVoluntary: false });
    expect(employeeExitFieldsSchema.parse({ exitReason: '', exitVoluntary: '' })).toEqual({ exitReason: null, exitVoluntary: null });
    const msgs = issues(employeeExitFieldsSchema, { exitReason: 'FIRED' });
    expect(msgs).toHaveLength(1);
    expect(isArabic(msgs[0])).toBe(true);
  });

  it('exit reasons: the ten fixed values, each with an Arabic label', () => {
    expect([...EXIT_REASONS]).toEqual([
      'RESIGNATION', 'EMPLOYER_TERMINATION', 'CONTRACT_END', 'MUTUAL_AGREEMENT', 'ARTICLE_80',
      'PROBATION', 'RETIREMENT', 'DEATH', 'ABSCONDING', 'OTHER',
    ]);
    for (const r of EXIT_REASONS) expect(isArabic(EXIT_REASON_LABELS[r])).toBe(true);
  });

  it('allowance type', () => {
    expect([...ALLOWANCE_TYPES]).toEqual(['HOUSING', 'TRANSPORT', 'FOOD', 'OTHER']);
    expect(zAllowanceType.parse('FOOD')).toBe('FOOD');
    expect(zAllowanceType.parse('')).toBeNull();
    expect(zAllowanceType.parse(undefined)).toBeUndefined();
    expect(zAllowanceType.safeParse('RENT').success).toBe(false);
    expect(allowanceTypeFromName('بدل سكن')).toBe('HOUSING');
    expect(allowanceTypeFromName('بدل نقل')).toBe('TRANSPORT');
    expect(allowanceTypeFromName('بدل طعام')).toBe('FOOD');
    expect(allowanceTypeFromName('بدلات أخرى')).toBe('');
  });
});

describe('defaultExitVoluntary', () => {
  it('only unambiguous reasons get a default', () => {
    expect(defaultExitVoluntary('RESIGNATION')).toBe(true);
    expect(defaultExitVoluntary('RETIREMENT')).toBe(true);
    expect(defaultExitVoluntary('ABSCONDING')).toBe(true);
    expect(defaultExitVoluntary('EMPLOYER_TERMINATION')).toBe(false);
    expect(defaultExitVoluntary('ARTICLE_80')).toBe(false);
    expect(defaultExitVoluntary('DEATH')).toBe(false);
    for (const r of ['CONTRACT_END', 'MUTUAL_AGREEMENT', 'PROBATION', 'OTHER'] as const) expect(defaultExitVoluntary(r)).toBeNull();
    expect(defaultExitVoluntary(null)).toBeNull();
  });
});

describe('resolveWorkforceFields (cross-field rules)', () => {
  it('copies plain fields; nothing sent -> nothing written', () => {
    expect(resolveWorkforceFields({}, current(), 'FULL_TIME', NOW)).toEqual({ data: {}, errors: [] });
    const r = resolveWorkforceFields({ occupationName: 'فني', dependentsCount: 2, dependentsFeePaidBy: 'EMPLOYEE', medicalInsuranceClass: 'B', isStudent: true }, null, 'FULL_TIME', NOW);
    expect(r.errors).toEqual([]);
    expect(r.data).toEqual({ occupationName: 'فني', dependentsCount: 2, dependentsFeePaidBy: 'EMPLOYEE', medicalInsuranceClass: 'B', isStudent: true });
  });

  it('part-time hours only for PART_TIME; cleared when the contract stops being part-time', () => {
    expect(resolveWorkforceFields({ partTimeWeeklyHours: 20 }, null, 'PART_TIME', NOW)).toEqual({ data: { partTimeWeeklyHours: 20 }, errors: [] });
    const bad = resolveWorkforceFields({ partTimeWeeklyHours: 20 }, current(), 'FULL_TIME', NOW);
    expect(bad.errors).toEqual(['ساعات الدوام الجزئي تُسجَّل فقط لعقد «دوام جزئي»']);
    expect(resolveWorkforceFields({ partTimeWeeklyHours: null }, current(), 'FULL_TIME', NOW).errors).toEqual([]);
    const switched = resolveWorkforceFields({}, current({ contractType: 'PART_TIME', partTimeWeeklyHours: 24 }), 'FULL_TIME', NOW);
    expect(switched.data).toEqual({ partTimeWeeklyHours: null });
    // Still part-time: kept.
    expect(resolveWorkforceFields({}, current({ contractType: 'PART_TIME', partTimeWeeklyHours: 24 }), 'PART_TIME', NOW).data).toEqual({});
  });

  it('Muawama certificate only for a disabled employee; cleared when the flag is switched off', () => {
    expect(resolveWorkforceFields({ isDisabled: true, muawamaCertExpiry: utc('2027-01-01') }, null, 'FULL_TIME', NOW).data).toEqual({
      isDisabled: true,
      muawamaCertExpiry: utc('2027-01-01'),
    });
    expect(resolveWorkforceFields({ muawamaCertExpiry: utc('2027-01-01') }, current(), 'FULL_TIME', NOW).errors).toEqual([
      'تاريخ انتهاء شهادة مواءمة يُسجَّل فقط للموظف ذي الإعاقة',
    ]);
    // Already disabled: a new date alone is accepted.
    expect(resolveWorkforceFields({ muawamaCertExpiry: utc('2028-01-01') }, current({ isDisabled: true }), 'FULL_TIME', NOW).errors).toEqual([]);
    expect(resolveWorkforceFields({ isDisabled: false }, current({ isDisabled: true, muawamaCertExpiry: utc('2027-01-01') }), 'FULL_TIME', NOW).data).toEqual({
      isDisabled: false,
      muawamaCertExpiry: null,
    });
  });

  it('Qiwa: date auto-set to now when the flag flips to true, unless provided', () => {
    expect(resolveWorkforceFields({ qiwaContractDocumented: true }, current(), 'FULL_TIME', NOW).data).toEqual({
      qiwaContractDocumented: true,
      qiwaContractDocumentedAt: NOW,
    });
    expect(resolveWorkforceFields({ qiwaContractDocumented: true, qiwaContractDocumentedAt: null }, null, 'FULL_TIME', NOW).data.qiwaContractDocumentedAt).toEqual(NOW);
    expect(resolveWorkforceFields({ qiwaContractDocumented: true, qiwaContractDocumentedAt: utc('2026-05-01') }, current(), 'FULL_TIME', NOW).data).toEqual({
      qiwaContractDocumented: true,
      qiwaContractDocumentedAt: utc('2026-05-01'),
    });
  });

  it('Qiwa: stored date kept while documented; cleared when switched off; never in the future', () => {
    const documented = current({ qiwaContractDocumented: true, qiwaContractDocumentedAt: utc('2026-01-10') });
    expect(resolveWorkforceFields({ qiwaContractDocumented: true, qiwaContractDocumentedAt: null }, documented, 'FULL_TIME', NOW).data).toEqual({ qiwaContractDocumented: true });
    expect(resolveWorkforceFields({}, documented, 'FULL_TIME', NOW).data).toEqual({});
    expect(resolveWorkforceFields({ qiwaContractDocumented: false }, documented, 'FULL_TIME', NOW).data).toEqual({
      qiwaContractDocumented: false,
      qiwaContractDocumentedAt: null,
    });
    expect(resolveWorkforceFields({ qiwaContractDocumentedAt: utc('2026-01-01') }, current(), 'FULL_TIME', NOW).errors).toEqual([
      'تاريخ توثيق العقد في قوى يتطلب تفعيل «العقد موثّق في قوى»',
    ]);
    expect(resolveWorkforceFields({ qiwaContractDocumented: true, qiwaContractDocumentedAt: utc('2026-09-27') }, current(), 'FULL_TIME', NOW).errors).toEqual([
      'تاريخ توثيق العقد في قوى لا يمكن أن يكون في المستقبل',
    ]);
    // Today (Riyadh) is accepted.
    expect(resolveWorkforceFields({ qiwaContractDocumented: true, qiwaContractDocumentedAt: utc('2026-09-26') }, current(), 'FULL_TIME', NOW).errors).toEqual([]);
  });

  it('exit reason only for a terminated employee; voluntary defaults from the reason', () => {
    expect(resolveWorkforceFields({ exitReason: 'RESIGNATION' }, current(), 'FULL_TIME', NOW).errors).toEqual(['سبب الخروج يُسجَّل فقط لموظف منتهية خدماته']);
    expect(resolveWorkforceFields({ exitReason: 'RESIGNATION' }, current({ isTerminated: true }), 'FULL_TIME', NOW).data).toEqual({
      exitReason: 'RESIGNATION',
      exitVoluntary: true,
    });
    expect(resolveWorkforceFields({ exitReason: 'CONTRACT_END', exitVoluntary: false }, current({ isTerminated: true }), 'FULL_TIME', NOW).data).toEqual({
      exitReason: 'CONTRACT_END',
      exitVoluntary: false,
    });
    expect(resolveWorkforceFields({ exitVoluntary: true }, current({ isTerminated: true }), 'FULL_TIME', NOW).errors).toEqual(['حدد سبب الخروج قبل تحديد هل الخروج طوعي']);
    // Clearing is always allowed.
    expect(resolveWorkforceFields({ exitReason: null, exitVoluntary: null }, current(), 'FULL_TIME', NOW)).toEqual({
      data: { exitReason: null, exitVoluntary: null },
      errors: [],
    });
  });
});

describe('redactWorkforceForPayroll', () => {
  it('removes the disability data only', () => {
    const row = { id: 'e1', basicSalary: 5000, isDisabled: true, muawamaCertExpiry: utc('2027-01-01'), medicalInsuranceClass: 'A', dependentsCount: 2 };
    expect(redactWorkforceForPayroll(row)).toEqual({ id: 'e1', basicSalary: 5000, medicalInsuranceClass: 'A', dependentsCount: 2 });
    expect(row.isDisabled).toBe(true); // not mutated
  });
});
