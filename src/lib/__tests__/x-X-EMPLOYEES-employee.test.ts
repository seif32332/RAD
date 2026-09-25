import { describe, expect, it } from 'vitest';
import {
  NATIONALITY_REQUIRED_MESSAGE,
  SAUDI_NATIONALITY,
  employeeDataWarnings,
  parseGosiRegime,
  probationWarning,
  PROBATION_WARNING_DAYS,
} from '@/lib/employee-shared';
import {
  IMPORT_TEMPLATE,
  defaultCountsTowardGosi,
  employeeGosiFieldsSchema,
  gosiRegimeSourceError,
  monthlyAllowanceRows,
  monthlyAllowancesToCreate,
  zRequiredNationality,
} from '@/lib/employee';
import { ibanCheckDigits } from '@/lib/iban';

const bban = '80000000000000004321'; // synthetic
const VALID_IBAN = `SA${ibanCheckDigits('SA', bban)}${bban}`;

describe('zRequiredNationality (DEC-002/003: no default)', () => {
  it('rejects blank / missing with the Arabic message', () => {
    for (const v of [undefined, null, '', '   ']) {
      const r = zRequiredNationality.safeParse(v);
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues[0].message).toBe(NATIONALITY_REQUIRED_MESSAGE);
    }
  });
  it('normalizes legacy Saudi spellings and keeps others', () => {
    expect(zRequiredNationality.parse('SAUDI')).toBe(SAUDI_NATIONALITY);
    expect(zRequiredNationality.parse(' مصري ')).toBe('مصري');
  });
  it('the import template example is not used as a default', () => {
    const col = IMPORT_TEMPLATE.find((c) => c.field === 'nationality');
    expect(col?.example).toBe(SAUDI_NATIONALITY);
  });
});

describe('parseGosiRegime', () => {
  it('enum values and Arabic words', () => {
    expect(parseGosiRegime('old')).toBe('OLD');
    expect(parseGosiRegime('NEW')).toBe('NEW');
    expect(parseGosiRegime('النظام القديم')).toBe('OLD');
    expect(parseGosiRegime('جديد')).toBe('NEW');
    expect(parseGosiRegime('UNKNOWN')).toBe('UNKNOWN');
    expect(parseGosiRegime('')).toBeNull();
    expect(parseGosiRegime('x')).toBeNull();
  });
});

describe('gosiRegimeSourceError', () => {
  it('OLD / NEW need a source (body or stored); UNKNOWN does not', () => {
    expect(gosiRegimeSourceError('OLD', '')).toMatch(/مصدر/);
    expect(gosiRegimeSourceError('NEW', undefined, null)).toMatch(/مصدر/);
    expect(gosiRegimeSourceError('NEW', undefined, 'شهادة اشتراك')).toBeNull();
    expect(gosiRegimeSourceError('OLD', 'قائمة GOSI')).toBeNull();
    expect(gosiRegimeSourceError('UNKNOWN', '')).toBeNull();
    expect(gosiRegimeSourceError(undefined, undefined)).toBeNull();
  });
});

describe('employeeGosiFieldsSchema', () => {
  it('parses labels, blanks and rejects unknown values', () => {
    expect(employeeGosiFieldsSchema.parse({ gosiRegime: 'قديم', idType: 'إقامة', gosiNumber: '' })).toEqual({
      gosiRegime: 'OLD',
      idType: 'IQAMA',
      gosiNumber: null,
    });
    expect(employeeGosiFieldsSchema.parse({ idType: '' })).toEqual({ idType: null });
    expect(employeeGosiFieldsSchema.parse({})).toEqual({});
    expect(employeeGosiFieldsSchema.safeParse({ gosiRegime: 'MAYBE' }).success).toBe(false);
    expect(employeeGosiFieldsSchema.safeParse({ idType: 'DRIVER' }).success).toBe(false);
  });
});

describe('probationWarning', () => {
  it(`warns only above ${PROBATION_WARNING_DAYS} days`, () => {
    expect(probationWarning(90)).toBeNull();
    expect(probationWarning(180)).toBeNull();
    expect(probationWarning(181)).toMatch(/181/);
    expect(probationWarning(null)).toBeNull();
    expect(probationWarning(Number.NaN)).toBeNull();
  });
});

describe('employeeDataWarnings', () => {
  it('no warnings for consistent data', () => {
    expect(
      employeeDataWarnings({ ibanNumber: VALID_IBAN, iqamaOrIdNumber: '1000000001', idType: 'NATIONAL_ID', nationality: 'سعودي', probationDays: 90, basicSalary: 5000 }),
    ).toEqual([]);
  });
  it('reports each field once', () => {
    const w = employeeDataWarnings({ ibanNumber: 'SA00123', iqamaOrIdNumber: '1000000001', idType: 'IQAMA', nationality: 'مصري', probationDays: 200, basicSalary: 0 });
    expect(w.map((x) => x.field).sort()).toEqual(['basicSalary', 'ibanNumber', 'iqamaOrIdNumber', 'probationDays']);
  });
  it('nationality / ID mismatch without an ID type', () => {
    const w = employeeDataWarnings({ iqamaOrIdNumber: '2000000002', nationality: 'SAUDI' });
    expect(w).toHaveLength(1);
    expect(w[0].field).toBe('nationality');
  });
  it('blank IBAN is not a warning', () => {
    expect(employeeDataWarnings({ ibanNumber: '' })).toEqual([]);
  });
});

describe('allowances and the GOSI base flag', () => {
  it('housing defaults to counting toward GOSI', () => {
    expect(defaultCountsTowardGosi('بدل سكن')).toBe(true);
    expect(defaultCountsTowardGosi('Housing allowance')).toBe(true);
    expect(defaultCountsTowardGosi('بدل نقل')).toBe(false);
  });
  it('monthlyAllowanceRows keeps an explicit flag, defaults otherwise; the legacy helper drops it', () => {
    const submitted = [
      { name: 'بدل سكن', amount: 1000 },
      { name: 'بدل نقل', amount: 300, countsTowardGosi: true },
      { name: 'بدل سكن', amount: 200, countsTowardGosi: false },
      { id: 'bonus', name: 'مكافأة', amount: 50 },
    ];
    expect(monthlyAllowanceRows(submitted, ['bonus'])).toEqual([
      { name: 'بدل سكن', amount: 1000, countsTowardGosi: true },
      { name: 'بدل نقل', amount: 300, countsTowardGosi: true },
      { name: 'بدل سكن', amount: 200, countsTowardGosi: false },
    ]);
    expect(monthlyAllowancesToCreate(submitted, ['bonus'])[0]).toEqual({ name: 'بدل سكن', amount: 1000 });
  });
});
