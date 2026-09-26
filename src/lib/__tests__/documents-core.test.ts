import { describe, expect, it } from 'vitest';
import {
  canonicalJson, formatDocumentNumber, hashVerifyToken, newVerifyToken, riyadhDate, riyadhYear, sha256Hex,
  stripArabicMarks, sumAmounts, toAmountString, TOKEN_RE,
} from '@/lib/documents/core';
import { formatAmount, formatGregorian, formatHijri, toHijri } from '@/lib/documents/format';

describe('canonicalJson (snapshot hash input)', () => {
  it('sorts keys at every level and drops undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: null, y: 'x' }], c: true }, u: undefined })).toBe('{"a":{"c":true,"d":[3,{"y":"x","z":null}]},"b":1}');
  });
  it('is independent of insertion order, so the hash is stable', () => {
    const a = canonicalJson({ x: 'محمد', y: { p: '1.00', q: '2.00' } });
    const b = canonicalJson({ y: { q: '2.00', p: '1.00' }, x: 'محمد' });
    expect(a).toBe(b);
    expect(sha256Hex(a)).toBe(sha256Hex(b));
  });
  it('refuses floats and non-JSON values (amounts must be decimal strings)', () => {
    expect(() => canonicalJson({ amount: 15000.5 })).toThrow(/safe integers/);
    expect(() => canonicalJson({ f: () => 1 })).toThrow();
    expect(() => canonicalJson(new Date())).not.toThrow(); // plain object with no own keys
  });
});

describe('document numbers (DOC-02)', () => {
  it('formats <prefix>-<TYPE>-<YYYY>-<000000>', () => {
    expect(formatDocumentNumber('ACM', 'SAL', 2026, 184)).toBe('ACM-SAL-2026-000184');
  });
  it('rejects bad prefixes, codes and sequences', () => {
    expect(() => formatDocumentNumber('acm', 'SAL', 2026, 1)).toThrow();
    expect(() => formatDocumentNumber('ACM', 'SALARY', 2026, 1)).toThrow();
    expect(() => formatDocumentNumber('ACM', 'SAL', 2026, 0)).toThrow();
    expect(() => formatDocumentNumber('ACM', 'SAL', 2026, 1_000_000)).toThrow();
  });
  it('uses the Riyadh calendar year (UTC 21:30 on 31 Dec is already the next year)', () => {
    expect(riyadhYear(new Date('2026-12-31T21:30:00Z'))).toBe(2027);
    expect(riyadhYear(new Date('2026-12-31T20:59:59Z'))).toBe(2026);
    expect(riyadhDate(new Date('2026-09-25T22:00:00Z'))).toBe('2026-09-26');
  });
});

describe('verification tokens (DOC-06)', () => {
  it('are 26 base32 characters, unique, and stored only as a hash', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => newVerifyToken()));
    expect(tokens.size).toBe(500);
    for (const t of tokens) expect(t).toMatch(TOKEN_RE);
    const t = [...tokens][0];
    expect(hashVerifyToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashVerifyToken(t)).not.toContain(t.toLowerCase());
  });
});

describe('text and amounts', () => {
  it('strips harakat and tanween, keeps letters, hamza and shadda-free text', () => {
    expect(stripArabicMarks({ a: 'مُحَمَّد', b: ['اعتباراً', 'إلى'], c: 1 })).toEqual({ a: 'محمد', b: ['اعتبارا', 'إلى'], c: 1 });
  });
  it('amount strings are exact to the halala', () => {
    expect(toAmountString(15000)).toBe('15000.00');
    expect(toAmountString(0.1 + 0.2)).toBe('0.30');
    expect(sumAmounts(['9500.00', '2375.00', '950.00', '675.50'])).toBe('13500.50');
  });
});

describe('display formatting (render model)', () => {
  it('Gregorian in Arabic / English, Latin or Arabic-Indic digits', () => {
    expect(formatGregorian('2026-09-26', 'ar')).toBe('26 سبتمبر 2026');
    expect(formatGregorian('2026-09-26', 'ar', 'arab')).toBe('٢٦ سبتمبر ٢٠٢٦');
    expect(formatGregorian('2026-09-26', 'en')).toBe('26 September 2026');
  });
  it('Umm al-Qura Hijri dates match known days', () => {
    expect(toHijri('2026-06-16')).toEqual({ y: 1448, m: 1, d: 1 }); // 1 Muharram 1448
    expect(toHijri('2025-03-01')).toEqual({ y: 1446, m: 9, d: 1 }); // 1 Ramadan 1446
    expect(formatHijri('2026-09-26', 'ar')).toBe('15 ربيع الآخر 1448 هـ');
    expect(formatHijri('2026-09-26', 'en')).toBe("15 Rabi' al-Thani 1448 AH");
    expect(formatHijri('2026-09-26', 'ar', 'arab')).toBe('١٥ ربيع الآخر ١٤٤٨ هـ');
  });
  it('amounts with grouping; Arabic separators U+066C / U+066B', () => {
    expect(formatAmount('13500.50')).toBe('13,500.50');
    expect(formatAmount('950.00')).toBe('950.00');
    expect(formatAmount('1234567.89')).toBe('1,234,567.89');
    expect(formatAmount('13500.50', 'arab')).toBe('١٣٬٥٠٠٫٥٠');
    expect(() => formatAmount('13500.5')).toThrow();
  });
});
