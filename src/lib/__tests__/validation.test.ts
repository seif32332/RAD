import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  zBool,
  zDate,
  zEmail,
  zInt,
  zMoney,
  zMonth,
  zNumber,
  zOptDate,
  zOptMoney,
  zOptText,
  zPagination,
  zPassword,
  zText,
  zYear,
} from '@/lib/validation';

describe('zDate / zOptDate', () => {
  it('accepts ISO and day-first dates as UTC midnight', () => {
    expect(zDate.parse('2026-09-23').toISOString()).toBe('2026-09-23T00:00:00.000Z');
    expect(zDate.parse('23/09/2026').toISOString()).toBe('2026-09-23T00:00:00.000Z');
    expect(zDate.parse(45000).toISOString()).toBe('2023-03-15T00:00:00.000Z');
  });

  it('rejects invalid or missing dates', () => {
    expect(zDate.safeParse('31/02/2026').success).toBe(false);
    expect(zDate.safeParse('garbage').success).toBe(false);
    expect(zDate.safeParse('').success).toBe(false);
    expect(zDate.safeParse(undefined).success).toBe(false);
    expect(zDate.safeParse(null).success).toBe(false);
  });

  it('zOptDate maps blank values to null and keeps undefined', () => {
    const schema = z.object({ d: zOptDate });
    expect(schema.parse({ d: '' }).d).toBeNull();
    expect(schema.parse({ d: null }).d).toBeNull();
    expect(schema.parse({}).d).toBeUndefined();
    expect(schema.parse({ d: '2026-01-02' }).d?.toISOString()).toBe('2026-01-02T00:00:00.000Z');
    expect(schema.safeParse({ d: 'nope' }).success).toBe(false);
  });
});

describe('zMoney / zOptMoney / zNumber', () => {
  it('parses numeric strings including grouping and Arabic digits', () => {
    expect(zMoney.parse('1,500.75')).toBe(1500.75);
    expect(zMoney.parse('٥٠٠')).toBe(500);
    expect(zMoney.parse(0)).toBe(0);
    expect(zMoney.parse(99.5)).toBe(99.5);
  });

  it('rejects negative, blank and non-numeric amounts', () => {
    expect(zMoney.safeParse(-1).success).toBe(false);
    expect(zMoney.safeParse('-5').success).toBe(false);
    expect(zMoney.safeParse('abc').success).toBe(false);
    expect(zMoney.safeParse('').success).toBe(false);
    expect(zMoney.safeParse(Infinity).success).toBe(false);
    expect(zMoney.safeParse(Number.NaN).success).toBe(false);
  });

  it('zOptMoney treats blank as undefined', () => {
    expect(zOptMoney.parse('')).toBeUndefined();
    expect(zOptMoney.parse(null)).toBeUndefined();
    expect(zOptMoney.parse(undefined)).toBeUndefined();
    expect(zOptMoney.parse('12.5')).toBe(12.5);
    expect(zOptMoney.safeParse('-3').success).toBe(false);
  });

  it('zNumber allows negatives but not garbage', () => {
    expect(zNumber.parse('-3.5')).toBe(-3.5);
    expect(zNumber.safeParse('x').success).toBe(false);
  });
});

describe('text helpers', () => {
  it('zOptText maps empty strings to null and trims', () => {
    const schema = z.object({ t: zOptText(10) });
    expect(schema.parse({ t: '' }).t).toBeNull();
    expect(schema.parse({ t: null }).t).toBeNull();
    expect(schema.parse({}).t).toBeUndefined();
    expect(schema.parse({ t: '  hi  ' }).t).toBe('hi');
    expect(schema.safeParse({ t: 'x'.repeat(11) }).success).toBe(false);
  });

  it('zText requires non-blank text', () => {
    expect(zText().safeParse('   ').success).toBe(false);
    expect(zText().parse('  محمد ')).toBe('محمد');
    expect(zText(3).safeParse('abcd').success).toBe(false);
  });

  it('zEmail lowercases and trims', () => {
    expect(zEmail.parse('  Ali@Example.COM ')).toBe('ali@example.com');
    expect(zEmail.safeParse('not-an-email').success).toBe(false);
  });

  it('zPassword enforces length, a letter and a digit', () => {
    expect(zPassword.safeParse('abcdefg1').success).toBe(true);
    expect(zPassword.safeParse('abcdefgh').success).toBe(false);
    expect(zPassword.safeParse('12345678').success).toBe(false);
    expect(zPassword.safeParse('ab1').success).toBe(false);
  });
});

describe('numeric helpers', () => {
  it('zInt / zBool / zMonth / zYear', () => {
    expect(zInt.parse('12')).toBe(12);
    expect(zInt.safeParse('1.5').success).toBe(false);
    expect(zBool.parse('true')).toBe(true);
    expect(zBool.parse('false')).toBe(false);
    expect(zBool.safeParse('yes').success).toBe(false);
    expect(zMonth.parse('12')).toBe(12);
    expect(zMonth.safeParse('13').success).toBe(false);
    expect(zMonth.safeParse(0).success).toBe(false);
    expect(zYear.parse('2026')).toBe(2026);
    expect(zYear.safeParse(1999).success).toBe(false);
  });

  it('zPagination caps take at 500', () => {
    expect(zPagination.parse({ take: '50', skip: '0' })).toEqual({ take: 50, skip: 0 });
    expect(zPagination.parse({})).toEqual({ take: undefined, skip: undefined });
    expect(zPagination.safeParse({ take: '501' }).success).toBe(false);
    expect(zPagination.safeParse({ skip: '-1' }).success).toBe(false);
  });
});
