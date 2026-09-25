import { describe, expect, it } from 'vitest';
import { formatMoney, roundMoney, sumMoney, toNumber } from '@/lib/money';

describe('roundMoney', () => {
  it('rounds floating point noise to halalas', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
    expect(roundMoney(1.005)).toBe(1.01);
    expect(roundMoney(1234.5678)).toBe(1234.57);
    expect(roundMoney(-10.126)).toBe(-10.13);
    expect(roundMoney(100)).toBe(100);
  });

  it('returns 0 for non-finite input', () => {
    expect(roundMoney(Number.NaN)).toBe(0);
    expect(roundMoney(Infinity)).toBe(0);
    expect(roundMoney(-Infinity)).toBe(0);
  });
});

describe('toNumber', () => {
  it('parses plain and comma-grouped numbers', () => {
    expect(toNumber('1,234.50')).toBe(1234.5);
    expect(toNumber(' 12 ')).toBe(12);
    expect(toNumber('1 500')).toBe(1500);
    expect(toNumber(42)).toBe(42);
    expect(toNumber('-5.5')).toBe(-5.5);
  });

  it('parses Arabic-Indic and Persian digits with Arabic separators', () => {
    expect(toNumber('٥٠٠')).toBe(500);
    expect(toNumber('١٬٢٣٤٫٥٠')).toBe(1234.5);
    expect(toNumber('١,٢٣٤.٥')).toBe(1234.5);
    expect(toNumber('۱۲۳')).toBe(123);
  });

  it('returns the fallback for empty or invalid input', () => {
    expect(toNumber('')).toBe(0);
    expect(toNumber('', 7)).toBe(7);
    expect(toNumber(null, 3)).toBe(3);
    expect(toNumber(undefined)).toBe(0);
    expect(toNumber('abc', -1)).toBe(-1);
    expect(toNumber(Number.NaN, 9)).toBe(9);
    expect(toNumber(Infinity, 9)).toBe(9);
    expect(Number.isNaN(toNumber('x', Number.NaN))).toBe(true);
  });
});

describe('sumMoney / formatMoney', () => {
  it('sums in halalas without float drift', () => {
    expect(sumMoney([0.1, 0.2])).toBe(0.3);
    expect(sumMoney([100.1, 200.2, 300.3])).toBe(600.6);
    expect(sumMoney([null, undefined, 5])).toBe(5);
    expect(sumMoney([])).toBe(0);
  });

  it('formats with grouping and at most 2 decimals', () => {
    expect(formatMoney(1234.5)).toBe('1,234.5');
    expect(formatMoney(1000)).toBe('1,000');
    expect(formatMoney(0.126)).toBe('0.13');
    expect(formatMoney(null)).toBe('0');
    expect(formatMoney(Number.NaN)).toBe('0');
  });
});
