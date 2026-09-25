import { describe, expect, it } from 'vitest';
import {
  cellDate,
  cellText,
  deletionBlockers,
  directManagerError,
  formatEmployeeCode,
  mapImportRow,
  matchByName,
  maxEmployeeCodeNumberOf,
  monthlyAllowancesToCreate,
  normalizeHeader,
  parseAccommodationLabel,
  parseEmployeeCodeNumber,
  parsePaymentMethodLabel,
  splitFullName,
} from '@/lib/employee';

describe('employee codes', () => {
  it('formats and parses EMP-xxxx codes', () => {
    expect(formatEmployeeCode(1)).toBe('EMP-0001');
    expect(formatEmployeeCode(42)).toBe('EMP-0042');
    expect(formatEmployeeCode(12345)).toBe('EMP-12345');
    expect(formatEmployeeCode(0)).toBe('EMP-0001');
    expect(parseEmployeeCodeNumber('EMP-0042')).toBe(42);
    expect(parseEmployeeCodeNumber(' EMP-7 ')).toBe(7);
    expect(parseEmployeeCodeNumber('EMP-')).toBeNull();
    expect(parseEmployeeCodeNumber('X-0001')).toBeNull();
    expect(parseEmployeeCodeNumber(null)).toBeNull();
  });

  it('finds the highest numeric suffix (numeric, not lexical)', () => {
    expect(maxEmployeeCodeNumberOf(['EMP-0009', 'EMP-0010', 'EMP-0002', null, 'OTHER'])).toBe(10);
    expect(maxEmployeeCodeNumberOf(['EMP-9999', 'EMP-10000'])).toBe(10000);
    expect(maxEmployeeCodeNumberOf([])).toBe(0);
  });
});

describe('directManagerError', () => {
  it('rejects self-management only', () => {
    expect(directManagerError('e1', 'e1')).not.toBeNull();
    expect(directManagerError('e1', 'e2')).toBeNull();
    expect(directManagerError('e1', null)).toBeNull();
    expect(directManagerError(null, 'e2')).toBeNull();
  });
});

describe('monthlyAllowancesToCreate', () => {
  it('skips one-off bonuses, blank names and non-positive amounts', () => {
    expect(
      monthlyAllowancesToCreate(
        [
          { id: 'a1', name: ' بدل سكن ', amount: 2000 },
          { id: 'bonus', name: 'مكافأة', amount: 500 },
          { name: '', amount: 100 },
          { name: 'بدل نقل', amount: 0 },
          { name: 'بدل هاتف', amount: Number.NaN },
          { name: 'بدل طعام', amount: 300 },
        ],
        ['bonus'],
      ),
    ).toEqual([
      { name: 'بدل سكن', amount: 2000 },
      { name: 'بدل طعام', amount: 300 },
    ]);
  });
});

describe('import helpers', () => {
  it('normalizes headers and cells', () => {
    expect(normalizeHeader(' الاسم\n الأول  ')).toBe('الاسم الأول');
    expect(cellText(null)).toBe('');
    expect(cellText('  x ')).toBe('x');
    expect(cellText(12)).toBe('12');
    expect(cellText(new Date('2026-09-23T00:00:00.000Z'))).toBe('2026-09-23');
  });

  it('cellDate rounds exceljs dates to the UTC day and parses text', () => {
    expect(cellDate(new Date('2026-09-22T23:59:59.990Z'))?.toISOString()).toBe('2026-09-23T00:00:00.000Z');
    expect(cellDate('23/09/2026')?.toISOString()).toBe('2026-09-23T00:00:00.000Z');
    expect(cellDate(45000)?.toISOString()).toBe('2023-03-15T00:00:00.000Z');
    expect(cellDate(true)).toBeNull();
    expect(cellDate('')).toBeNull();
  });

  it('exact header matches win over partial ones', () => {
    const row = mapImportRow([
      { header: { field: 'nationality', exact: false }, value: 'partial' },
      { header: { field: 'nationality', exact: true }, value: 'سعودي' },
      { header: null, value: 'ignored' },
    ]);
    expect(row).toEqual({ nationality: 'سعودي' });
  });

  it('label parsers and name helpers', () => {
    expect(parsePaymentMethodLabel('نقداً')).toBe('CASH');
    expect(parsePaymentMethodLabel('wps')).toBe('WPS');
    expect(parsePaymentMethodLabel('تحويل بنكي')).toBe('BANK_TRANSFER');
    expect(parseAccommodationLabel('خارج السكن')).toBe('OUTSIDE_COMPANY');
    expect(parseAccommodationLabel('سكن الشركة')).toBe('INSIDE_COMPANY');
    expect(parseAccommodationLabel('')).toBeNull();
    expect(splitFullName('  محمد  أحمد العمري ')).toEqual({ first: 'محمد', last: 'أحمد العمري' });
    const items = [
      { id: '1', nameArabic: 'فرع الرياض', nameEnglish: 'Riyadh' },
      { id: '2', nameArabic: 'فرع جدة', nameEnglish: 'Jeddah' },
    ];
    expect(matchByName(items, 'Jeddah')?.id).toBe('2');
    expect(matchByName(items, 'الرياض')?.id).toBe('1');
    expect(matchByName(items, ' ')).toBeUndefined();
  });
});

describe('deletionBlockers', () => {
  it('lists non-zero dependents or returns null', () => {
    expect(deletionBlockers('الشركة', [['موظف', 0]])).toBeNull();
    const msg = deletionBlockers('الفرع', [
      ['موظف', 3],
      ['قسم', 0],
      ['سيارة', 1],
    ], false);
    expect(msg).toContain('3 موظف');
    expect(msg).toContain('1 سيارة');
    expect(msg).not.toContain('قسم');
    expect(msg).toContain('لارتباطه');
  });
});
