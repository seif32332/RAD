import { describe, expect, it } from 'vitest';
import { ID_TYPE_LABELS, ID_TYPES, idNumberWarning, nationalityIdMismatch, normalizeIdNumber, parseIdType } from '@/lib/identity';

// Synthetic numbers only (they follow the format, they do not belong to anyone).
const NID = '1000000001';
const IQAMA = '2000000002';

describe('parseIdType', () => {
  it('accepts enum values and Arabic / English spellings', () => {
    expect(parseIdType('NATIONAL_ID')).toBe('NATIONAL_ID');
    expect(parseIdType('iqama')).toBe('IQAMA');
    expect(parseIdType('هوية وطنية')).toBe('NATIONAL_ID');
    expect(parseIdType('إقامة')).toBe('IQAMA');
    expect(parseIdType('اقامة')).toBe('IQAMA');
    expect(parseIdType('رقم حدود')).toBe('BORDER_NUMBER');
    expect(parseIdType('جواز سفر')).toBe('PASSPORT');
    expect(parseIdType('passport')).toBe('PASSPORT');
  });
  it('blank / unknown -> null', () => {
    expect(parseIdType('')).toBeNull();
    expect(parseIdType(null)).toBeNull();
    expect(parseIdType('رخصة قيادة')).toBeNull();
  });
  it('every type has an Arabic label', () => {
    for (const t of ID_TYPES) expect(ID_TYPE_LABELS[t]).toMatch(/[؀-ۿ]/);
  });
});

describe('normalizeIdNumber', () => {
  it('trims and converts Arabic-Indic digits', () => {
    expect(normalizeIdNumber(' ١٠٠٠٠٠٠٠٠١ ')).toBe(NID);
    expect(normalizeIdNumber(1000000001)).toBe(NID);
    expect(normalizeIdNumber(undefined)).toBe('');
  });
});

describe('idNumberWarning', () => {
  it('NATIONAL_ID: 10 digits starting with 1', () => {
    expect(idNumberWarning(NID, 'NATIONAL_ID')).toBeNull();
    expect(idNumberWarning(IQAMA, 'NATIONAL_ID')).toMatch(/يبدأ/);
    expect(idNumberWarning('100000001', 'NATIONAL_ID')).toMatch(/10/);
    expect(idNumberWarning('10000000A1', 'NATIONAL_ID')).toMatch(/10/);
  });
  it('IQAMA: 10 digits starting with 2', () => {
    expect(idNumberWarning(IQAMA, 'IQAMA')).toBeNull();
    expect(idNumberWarning(NID, 'IQAMA')).toMatch(/يبدأ/);
    expect(idNumberWarning('20000000021', 'IQAMA')).toMatch(/10/);
  });
  it('border number / passport / unknown type are lenient', () => {
    expect(idNumberWarning('3123456789', 'BORDER_NUMBER')).toBeNull();
    expect(idNumberWarning('A1234567', 'PASSPORT')).toBeNull();
    expect(idNumberWarning('X-99', null)).toBeNull();
    expect(idNumberWarning('abc$%', 'PASSPORT')).toMatch(/رموز/);
  });
  it('blank numbers are not judged (required rule lives elsewhere)', () => {
    expect(idNumberWarning('', 'NATIONAL_ID')).toBeNull();
  });
});

describe('nationalityIdMismatch (heuristic)', () => {
  it('flags a Saudi with a non-1 ID and a non-Saudi with a 1-ID', () => {
    expect(nationalityIdMismatch(true, IQAMA)).toMatch(/سعودية/);
    expect(nationalityIdMismatch(false, NID)).toMatch(/غير سعودية/);
  });
  it('consistent pairs, unknown nationality and non 10-digit numbers -> null', () => {
    expect(nationalityIdMismatch(true, NID)).toBeNull();
    expect(nationalityIdMismatch(false, IQAMA)).toBeNull();
    expect(nationalityIdMismatch(null, IQAMA)).toBeNull();
    expect(nationalityIdMismatch(true, 'A1234567')).toBeNull();
  });
});
