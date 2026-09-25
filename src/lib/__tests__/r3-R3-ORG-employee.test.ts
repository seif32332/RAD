import { describe, expect, it } from 'vitest';
import {
  EMPLOYEE_LIST_FULL_INCLUDE,
  IMPORT_TEMPLATE,
  PAYROLL_HIDDEN_FIELDS,
  REVIEW_STATE_SELECT,
  allowanceBucket,
  branchFieldsSchema,
  completedReviewFields,
  employeeAccessLevel,
  parseContractTypeLabel,
  parseGenderLabel,
  redactForPayroll,
  resolveBankName,
  resolveImportHeader,
  reviewNoteAfterEdit,
  zNationalityOrDefault,
  zOptNationality,
} from '@/lib/employee';
import {
  DATA_REVIEW_FIELD_LABELS,
  DEFAULT_NATIONALITY,
  dataReviewFieldOfLabel,
  dataReviewFields,
  isSaudiNationalityValue,
  normalizeNationality,
  parseDataReviewNote,
  resolveDataReviewNote,
} from '@/lib/employee-shared';
import { BALANCE_CONSUMING_STATUSES } from '@/lib/leave';
import { bankOptions, findBank, SAUDI_BANKS } from '@/lib/banks';
import { transliterateArabicToEnglish, transliteratePersonName } from '@/lib/transliterate';

describe('normalizeNationality / DEFAULT_NATIONALITY', () => {
  it('maps every Saudi alias to the stored Arabic label', () => {
    expect(DEFAULT_NATIONALITY).toBe('سعودي');
    for (const v of ['SAUDI', 'saudi', ' Saudi Arabia ', 'saudi  arabian', 'KSA', 'sa', 'سعودي', 'سعودى', 'سعودية', 'السعودية']) {
      expect(normalizeNationality(v)).toBe(DEFAULT_NATIONALITY);
    }
  });
  it('keeps other nationalities trimmed (whitespace collapsed)', () => {
    expect(normalizeNationality('  مصري ')).toBe('مصري');
    expect(normalizeNationality('Indian   national')).toBe('Indian national');
    expect(normalizeNationality('غير سعودي')).toBe('غير سعودي');
  });
  it('blank / non-string -> null', () => {
    expect(normalizeNationality('')).toBeNull();
    expect(normalizeNationality('   ')).toBeNull();
    expect(normalizeNationality(null)).toBeNull();
    expect(normalizeNationality(undefined)).toBeNull();
    expect(normalizeNationality(5)).toBeNull();
  });
  it('isSaudiNationalityValue', () => {
    expect(isSaudiNationalityValue('SAUDI')).toBe(true);
    expect(isSaudiNationalityValue('سعودي')).toBe(true);
    expect(isSaudiNationalityValue('مصري')).toBe(false);
    expect(isSaudiNationalityValue(null)).toBe(false);
  });
  it('zod helpers: create defaults to Saudi, update leaves blank unchanged', () => {
    expect(zNationalityOrDefault.parse(undefined)).toBe(DEFAULT_NATIONALITY);
    expect(zNationalityOrDefault.parse('')).toBe(DEFAULT_NATIONALITY);
    expect(zNationalityOrDefault.parse('Saudi')).toBe(DEFAULT_NATIONALITY);
    expect(zNationalityOrDefault.parse('مصري')).toBe('مصري');
    expect(zOptNationality.parse('')).toBeUndefined();
    expect(zOptNationality.parse(null)).toBeUndefined();
    expect(zOptNationality.parse('saudi')).toBe(DEFAULT_NATIONALITY);
    expect(() => zOptNationality.parse('x'.repeat(101))).toThrow();
  });
});

describe('parseGenderLabel', () => {
  it.each([
    ['MALE', 'MALE'], ['male', 'MALE'], ['M', 'MALE'], ['ذكر', 'MALE'], [' رجل ', 'MALE'],
    ['FEMALE', 'FEMALE'], ['f', 'FEMALE'], ['أنثى', 'FEMALE'], ['انثى', 'FEMALE'], ['أنثي', 'FEMALE'], ['امرأة', 'FEMALE'],
  ])('%s -> %s', (input, expected) => {
    expect(parseGenderLabel(input)).toBe(expected);
  });
  it('blank / unknown -> null', () => {
    expect(parseGenderLabel('')).toBeNull();
    expect(parseGenderLabel(null)).toBeNull();
    expect(parseGenderLabel(undefined)).toBeNull();
    expect(parseGenderLabel('other')).toBeNull();
  });
});

describe('resolveImportHeader', () => {
  it('every template header resolves exactly to its own field', () => {
    for (const col of IMPORT_TEMPLATE) {
      expect(resolveImportHeader(col.header)).toEqual({ field: col.field, exact: true });
    }
  });
  it('headers with newlines / extra spaces still match exactly', () => {
    expect(resolveImportHeader('رقم الهوية /\nالإقامة')).toEqual({ field: 'iqamaOrIdNumber', exact: true });
    expect(resolveImportHeader('  الجنسية  ')).toEqual({ field: 'nationality', exact: true });
  });
  it('the gender header is not swallowed by the nationality header', () => {
    expect(resolveImportHeader('الجنس')?.field).toBe('gender');
    expect(resolveImportHeader('الجنسية')?.field).toBe('nationality');
  });
  it('alternate spellings and partial matches', () => {
    expect(resolveImportHeader('IBAN')).toEqual({ field: 'ibanNumber', exact: true });
    expect(resolveImportHeader('الراتب الاساسي')).toEqual({ field: 'basicSalary', exact: true });
    expect(resolveImportHeader('تاريخ مباشرة العمل الفعلي')?.exact).toBe(false);
  });
  it('blank / unknown -> null', () => {
    expect(resolveImportHeader('')).toBeNull();
    expect(resolveImportHeader(null)).toBeNull();
    expect(resolveImportHeader('عمود غير معروف xyz')).toBeNull();
  });
});

describe('parseContractTypeLabel', () => {
  it.each([
    ['دوام كامل', 'FULL_TIME'], ['', 'FULL_TIME'], ['FULL_TIME', 'FULL_TIME'],
    ['دوام جزئي', 'PART_TIME'], ['part time', 'PART_TIME'],
    ['عمل عن بعد', 'FREELANCE'], ['عمل حر', 'FREELANCE'], ['Freelance', 'FREELANCE'], ['remote', 'FREELANCE'],
  ])('%s -> %s', (input, expected) => {
    expect(parseContractTypeLabel(input)).toBe(expected);
  });
});

describe('allowanceBucket', () => {
  it.each([
    ['بدل سكن', 'housing'], ['بدل السكن', 'housing'], ['Housing allowance', 'housing'],
    ['بدل نقل', 'transport'], ['بدل المواصلات', 'transport'], ['transport', 'transport'],
    ['بدلات أخرى', 'other'], ['بدل طعام', 'other'], ['', 'other'],
  ])('%s -> %s', (name, bucket) => {
    expect(allowanceBucket(name)).toBe(bucket);
  });
  it('null / undefined -> other', () => {
    expect(allowanceBucket(null)).toBe('other');
    expect(allowanceBucket(undefined)).toBe('other');
  });
});

describe('resolveBankName / banks', () => {
  it('exact value or label', () => {
    expect(resolveBankName('مصرف الراجحي')).toBe('مصرف الراجحي');
    expect(resolveBankName('البنك السعودي البريطاني (ساب)')).toBe('البنك السعودي البريطاني');
  });
  it('partial name', () => {
    expect(resolveBankName('الراجحي')).toBe('مصرف الراجحي');
    expect(resolveBankName('بنك الرياض - فرع العليا')).toBe('بنك الرياض');
  });
  it('SWIFT code when the name is blank or unknown', () => {
    expect(resolveBankName('', 'RJHISARI')).toBe('مصرف الراجحي');
    expect(resolveBankName(null, 'ncbksajE')).toBe('البنك الأهلي السعودي');
  });
  it('unknown bank kept as typed; blank -> null', () => {
    expect(resolveBankName('Bank X')).toBe('Bank X');
    expect(resolveBankName('', '')).toBeNull();
    expect(resolveBankName(null, null)).toBeNull();
  });
  it('bankOptions / findBank', () => {
    expect(bankOptions()).toHaveLength(SAUDI_BANKS.length);
    expect(bankOptions()[1]).toEqual({ label: 'مصرف الراجحي (RJHI)', value: 'مصرف الراجحي' });
    expect(findBank('بنك الجزيرة')?.code).toBe('BJAZ');
    expect(findBank('')).toBeUndefined();
    expect(findBank('nope')).toBeUndefined();
  });
});

describe('transliterate', () => {
  it('organization names use the dictionary and the Al prefix', () => {
    expect(transliterateArabicToEnglish('شركة البيان للتقنية')).toBe('Company AlBayan For Tech');
    expect(transliterateArabicToEnglish('قسم المالية')).toBe('Department Finance');
    expect(transliterateArabicToEnglish('فرع الرياض')).toBe('Branch Alryad');
  });
  it('person names', () => {
    expect(transliteratePersonName('عبدالله العمري')).toBe('Abdullah Alamry');
    expect(transliteratePersonName('محمد أحمد')).toBe('Mohammed Ahmed');
    expect(transliteratePersonName('عبدالكريم')).toBe('Abdulkrym');
  });
  it('drops diacritics / tatweel, keeps latin and digits, collapses spaces', () => {
    expect(transliteratePersonName('مُحَمَّد')).toBe('Mohammed');
    expect(transliterateArabicToEnglish('فرع  2  B')).toBe('Branch 2 B');
    expect(transliterateArabicToEnglish('')).toBe('');
    expect(transliteratePersonName('   ')).toBe('');
  });
});

describe('dataReviewNote helpers', () => {
  const NOTE = 'بيانات ناقصة من طلب مباشرة العمل (عُبئت مؤقتاً عند الاعتماد) يجب استكمالها: تاريخ الميلاد، تاريخ انتهاء الهوية / الإقامة، تاريخ المباشرة، الجنسية';
  it('parses the onboarding note', () => {
    const p = parseDataReviewNote(NOTE);
    expect(p?.labels).toEqual(['تاريخ الميلاد', 'تاريخ انتهاء الهوية / الإقامة', 'تاريخ المباشرة', 'الجنسية']);
    expect(p?.prefix.endsWith('يجب استكمالها')).toBe(true);
    expect(dataReviewFields(NOTE)).toEqual(['dateOfBirth', 'iqamaOrIdExp', 'joinDate', 'nationality']);
  });
  it('label aliases / spelling variants', () => {
    expect(dataReviewFieldOfLabel('تاريخ انتهاء الهوية/الاقامة')).toBe('iqamaOrIdExp');
    expect(dataReviewFieldOfLabel('رقم الهوية')).toBe('iqamaOrIdNumber');
    expect(dataReviewFieldOfLabel('تاريخ مباشرة العمل')).toBe('joinDate');
    expect(dataReviewFieldOfLabel('شيء آخر')).toBeNull();
    for (const [field, label] of Object.entries(DATA_REVIEW_FIELD_LABELS)) expect(dataReviewFieldOfLabel(label)).toBe(field);
  });
  it('blank note -> null; note without ":" has no labels', () => {
    expect(parseDataReviewNote('')).toBeNull();
    expect(parseDataReviewNote(null)).toBeNull();
    expect(parseDataReviewNote('راجع البيانات')).toEqual({ prefix: 'راجع البيانات', labels: [] });
  });
  it('resolveDataReviewNote removes completed labels, clears when all done, keeps unknown notes', () => {
    expect(resolveDataReviewNote(NOTE, ['dateOfBirth'])).toBe(
      'بيانات ناقصة من طلب مباشرة العمل (عُبئت مؤقتاً عند الاعتماد) يجب استكمالها: تاريخ انتهاء الهوية / الإقامة، تاريخ المباشرة، الجنسية',
    );
    expect(resolveDataReviewNote(NOTE, ['dateOfBirth', 'iqamaOrIdExp', 'joinDate', 'nationality'])).toBeNull();
    expect(resolveDataReviewNote(NOTE, [])).toBe(NOTE);
    expect(resolveDataReviewNote(NOTE, ['basicSalary'])).toBe(NOTE);
    expect(resolveDataReviewNote('ملاحظة حرة', ['dateOfBirth'])).toBe('ملاحظة حرة');
    expect(resolveDataReviewNote('X: تاريخ الميلاد، شيء غير معروف', ['dateOfBirth'])).toBe('X: شيء غير معروف');
    expect(resolveDataReviewNote(null, ['dateOfBirth'])).toBeNull();
  });
  it('completedReviewFields: only new non-empty values that differ from the stored ones', () => {
    const current = { dateOfBirth: new Date('2026-09-01'), nationality: 'غير سعودي', joinDate: new Date('2026-09-01') };
    expect(completedReviewFields(current, { dateOfBirth: new Date('2026-09-01'), nationality: 'غير سعودي' })).toEqual([]);
    expect(completedReviewFields(current, { dateOfBirth: new Date('1990-01-01'), nationality: 'مصري', joinDate: undefined })).toEqual(['dateOfBirth', 'nationality']);
    expect(completedReviewFields(current, { nationality: '', joinDate: null })).toEqual([]);
    expect(completedReviewFields({ passportNumber: null }, { passportNumber: 'A1' })).toEqual(['passportNumber']);
  });
  it('reviewNoteAfterEdit: undefined when unchanged, new note / null otherwise', () => {
    const current = { dataReviewNote: NOTE, dateOfBirth: new Date('2026-09-01'), iqamaOrIdExp: new Date('2026-09-01'), joinDate: new Date('2026-09-01'), nationality: 'غير سعودي' };
    expect(reviewNoteAfterEdit(current, { dateOfBirth: new Date('2026-09-01') })).toBeUndefined();
    expect(reviewNoteAfterEdit(current, { basicSalary: 5000 })).toBeUndefined();
    expect(reviewNoteAfterEdit(current, { joinDate: new Date('2024-01-01') })).toContain('تاريخ الميلاد، تاريخ انتهاء الهوية / الإقامة، الجنسية');
    expect(
      reviewNoteAfterEdit(current, { dateOfBirth: new Date('1990-01-01'), iqamaOrIdExp: new Date('2030-01-01'), joinDate: new Date('2024-01-01'), nationality: 'مصري' }),
    ).toBeNull();
    expect(reviewNoteAfterEdit({ ...current, dataReviewNote: null }, { dateOfBirth: new Date('1990-01-01') })).toBeUndefined();
  });
  it('REVIEW_STATE_SELECT covers every reviewable field', () => {
    for (const f of Object.keys(DATA_REVIEW_FIELD_LABELS)) expect((REVIEW_STATE_SELECT as Record<string, unknown>)[f]).toBe(true);
  });
});

describe('employee access levels', () => {
  it.each([
    ['SUPER_ADMIN', 'full'], ['COMPANY_ADMIN', 'full'], ['HR_MANAGER', 'full'],
    ['FINANCE_MANAGER', 'payroll'], ['PAYROLL_ADMIN', 'payroll'],
    ['BRANCH_MANAGER', 'team'], ['DEPT_MANAGER', 'team'],
    ['GOV_RELATIONS', 'basic'], ['LEGAL_ADMIN', 'basic'], ['PURCHASING_AGENT', 'basic'], [null, 'basic'],
  ])('%s -> %s', (role, level) => {
    expect(employeeAccessLevel(role)).toBe(level);
  });
  it('redactForPayroll drops identity data and keeps salary / bank', () => {
    const row = { id: '1', basicSalary: 5000, ibanNumber: 'SA1', joinDate: 'x', iqamaOrIdNumber: '1', passportNumber: 'P', dateOfBirth: 'd', iqamaCopyUrl: 'u', passportCopyUrl: 'u' };
    const out = redactForPayroll(row);
    for (const f of PAYROLL_HIDDEN_FIELDS) expect(f in out).toBe(false);
    expect(out).toEqual({ id: '1', basicSalary: 5000, ibanNumber: 'SA1', joinDate: 'x' });
    expect(row.iqamaOrIdNumber).toBe('1'); // input untouched
  });
});

describe('list include / branch schema', () => {
  it('employee list leaves = balance-consuming statuses (APPROVED + COMPLETED)', () => {
    expect(EMPLOYEE_LIST_FULL_INCLUDE.leaves.where.status.in).toEqual(['APPROVED', 'COMPLETED']);
    expect(BALANCE_CONSUMING_STATUSES).toEqual(['APPROVED', 'COMPLETED']);
  });
  it('branch attachments are accepted (munLicenseUrl / civilDefenseUrl)', () => {
    const b = branchFieldsSchema.parse({ munLicenseUrl: ' /api/files/a.pdf ', civilDefenseUrl: '', unknown: 1 });
    expect(b.munLicenseUrl).toBe('/api/files/a.pdf');
    expect(b.civilDefenseUrl).toBeNull();
    expect('unknown' in b).toBe(false);
    expect(branchFieldsSchema.parse({}).munLicenseUrl).toBeUndefined();
    expect(() => branchFieldsSchema.parse({ civilDefenseUrl: 'x'.repeat(2001) })).toThrow();
  });
});
