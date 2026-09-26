import { describe, expect, it } from 'vitest';
import {
  NATIONALITY_RECLASSIFIED,
  gccCountryCode,
  isGccNational,
  isGccNonSaudi,
  isSaudiNational,
  mentionsSaudiAmbiguously,
  nationalityClass,
  normalizeNationalityKey,
} from '@/lib/nationality';
import { isSaudiForGosi } from '@/lib/gosi';
import { isSaudiNationality } from '@/lib/leave';
import { isSaudiNational as payrollIsSaudi } from '@/lib/payroll-core';

// Every EXACT value accepted as Saudi by either old detector (gosi.ts isSaudiForGosi / leave.ts
// isSaudiNationality), and the GOSI substring matches whose other words are Saudi companions, must still be
// Saudi. Substring-only matches of the old GOSI rule ('بسعودي', 'مصري سعودي المولد') are rejected on purpose
// (see src/lib/nationality.ts header and NATIONALITY_RECLASSIFIED).
const OLD_GOSI_SAUDI = ['سعودي', 'سعودية', 'السعودية', 'SAUDI', 'Saudi', ' Saudi Arabia ', 'sa', 'KSA', 'سعودي الجنسية', 'مواطن سعودي', 'سعوديه', 'المملكة العربية السعودية'];
const OLD_LEAVE_SAUDI = ['سعودي', 'سعودية', 'السعودية', 'saudi', 'saudi arabia', 'sa', 'ksa', ' Saudi '];

describe('nationality: canonical Saudi rule', () => {
  it.each([...OLD_GOSI_SAUDI, ...OLD_LEAVE_SAUDI])('keeps %s as Saudi', (v) => {
    expect(isSaudiNational(v)).toBe(true);
  });

  it.each(['سعودى', 'Saudi Arabian', 'Saudi national', 'سُعُودِي', 'سعـودي', 'KSA - Saudi', 'Kingdom of Saudi Arabia'])('now accepts the variant %s', (v) => {
    expect(isSaudiNational(v)).toBe(true);
  });

  it.each(['غير سعودي', 'غير سعودية', 'Non-Saudi', 'non saudi', 'NON SAUDI', 'Not Saudi', 'مصري', 'يمني', 'أردني', 'Pakistani', 'USA', 'sudanese', '', '   ', null, undefined, 42])('rejects %s', (v) => {
    expect(isSaudiNational(v as string)).toBe(false);
  });

  it.each([
    'Saudi-born Egyptian',
    'Egyptian Saudi',
    'مصري سعودي المولد',
    'سعودي مصري',
    'سعودي الأصل',
    'مولود سعودي',
    'بسعودي',
    'غير سعودي',
    'غير سعوديه',
    'ليس سعودي',
    'Saudi resident',
    'سعودي كويتي',
    'العربية',
    'Arabia',
  ])('rejects %s (another nationality, birth / origin / negation word, or not a nationality form)', (v) => {
    expect(isSaudiNational(v)).toBe(false);
    expect(isSaudiForGosi(v)).toBe(false);
  });

  it.each(['سعودي/ة', 'Saudi (KSA)', 'KSA', 'saudi citizen', 'مواطنة سعودية', 'المملكة العربية السعودية', 'Kingdom of Saudi Arabia', 'السعودي'])('accepts the Saudi form %s', (v) => {
    expect(isSaudiNational(v)).toBe(true);
  });

  it('mentionsSaudiAmbiguously: Saudi mentioned but not classified Saudi, excluding plain negations', () => {
    for (const v of ['بسعودي', 'Saudi-born Egyptian', 'مصري سعودي المولد', 'سعودي الأصل', 'سعودي كويتي']) expect(mentionsSaudiAmbiguously(v)).toBe(true);
    for (const v of ['سعودي', 'Saudi Arabia', 'غير سعودي', 'Non-Saudi', 'not saudi', 'مصري', '', null]) expect(mentionsSaudiAmbiguously(v)).toBe(false);
  });

  it('the old entry points are thin wrappers of the same rule', () => {
    const all = [...OLD_GOSI_SAUDI, ...OLD_LEAVE_SAUDI, 'سعودى', 'Saudi Arabian', 'غير سعودي', 'Non-Saudi', 'مصري', '', null];
    for (const v of all) {
      const expected = isSaudiNational(v);
      expect(isSaudiForGosi(v)).toBe(expected);
      expect(isSaudiNationality(v)).toBe(expected);
      expect(payrollIsSaudi(v)).toBe(expected);
    }
  });

  it('documents every reclassified value correctly', () => {
    for (const row of NATIONALITY_RECLASSIFIED) expect(isSaudiNational(row.value)).toBe(row.now);
  });

  it('normalizes alef / ya / ta marbuta / diacritics / tatweel', () => {
    expect(normalizeNationalityKey(' أُرْدُنِيّة ')).toBe('اردنيه');
    expect(normalizeNationalityKey('سعـودى')).toBe('سعودي');
    expect(normalizeNationalityKey('Non-Saudi')).toBe('non saudi');
  });
});

describe('nationality: GCC', () => {
  it.each([
    ['كويتي', 'KW'],
    ['Kuwaiti', 'KW'],
    ['إماراتي', 'AE'],
    ['Emirati', 'AE'],
    ['UAE', 'AE'],
    ['بحريني', 'BH'],
    ['Bahraini', 'BH'],
    ['قطري', 'QA'],
    ['Qatari', 'QA'],
    ['عُماني', 'OM'],
    ['Omani', 'OM'],
    ['سعودي', 'SA'],
  ])('%s -> %s', (v, code) => {
    expect(gccCountryCode(v)).toBe(code);
  });

  it('isGccNonSaudi / isGccNational / nationalityClass', () => {
    expect(isGccNonSaudi('كويتي')).toBe(true);
    expect(isGccNonSaudi('خليجي')).toBe(true);
    expect(isGccNonSaudi('سعودي')).toBe(false);
    expect(isGccNational('سعودي')).toBe(true);
    expect(isGccNational('قطري')).toBe(true);
    expect(isGccNational('مصري')).toBe(false);
    expect(isGccNonSaudi('غير خليجي')).toBe(false);
    expect(nationalityClass('Saudi')).toBe('SAUDI');
    expect(nationalityClass('Omani')).toBe('GCC');
    expect(nationalityClass('هندي')).toBe('EXPAT');
    expect(nationalityClass(null)).toBe('EXPAT');
    expect(isGccNonSaudi('GCC national')).toBe(true);
    expect(gccCountryCode('Kingdom of Bahrain')).toBe('BH');
    expect(gccCountryCode('سلطنة عمان')).toBe('OM');
    expect(gccCountryCode('دولة الكويت')).toBe('KW');
    expect(gccCountryCode('الإمارات العربية المتحدة')).toBe('AE');
    expect(gccCountryCode('Kuwaiti-born Indian')).toBeNull();
    expect(nationalityClass('Qatari born Egyptian')).toBe('EXPAT');
  });
});
