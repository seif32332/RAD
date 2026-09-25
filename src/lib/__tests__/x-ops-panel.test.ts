import { describe, expect, it } from 'vitest';
import license from '../../../radeef-manage/lib/license.js';
import commercial from '../../../radeef-manage/lib/commercial.js';
import { lastMonths, parseArgs, readEnvValue, singleConnectionUrl } from '../../../scripts/tenant-stats.mjs';

// radeef-manage (tenant control panel) + scripts/tenant-stats.mjs pure helpers (DEC-004/007/009).

describe('license decisions (DEC-009)', () => {
  const { licenseAction, renewFromEndDate, normalizeReminderDays } = license;

  it('suspends only AFTER the end date: the end date itself is the last paid day', () => {
    expect(licenseAction(-1)).toBe('suspend');
    expect(licenseAction(-30)).toBe('suspend');
    expect(licenseAction(0)).toBe('remind');
  });

  it('reminds while 0 <= days <= 14 by default, nothing before', () => {
    expect(licenseAction(14)).toBe('remind');
    expect(licenseAction(7)).toBe('remind');
    expect(licenseAction(15)).toBeNull();
    expect(licenseAction(20, 30)).toBe('remind');
    expect(licenseAction(null)).toBeNull();
    expect(licenseAction(Number.NaN)).toBeNull();
  });

  it('reminder window is clamped', () => {
    expect(normalizeReminderDays('abc')).toBe(14);
    expect(normalizeReminderDays(-1)).toBe(14);
    expect(normalizeReminderDays(500)).toBe(60);
  });

  it('a renewal on the last paid day extends from the end date', () => {
    expect(renewFromEndDate(0, false)).toBe(true);
    expect(renewFromEndDate(10, false)).toBe(true);
    expect(renewFromEndDate(-1, false)).toBe(false);
    expect(renewFromEndDate(10, true)).toBe(false);
    expect(renewFromEndDate(null, false)).toBe(false);
  });
});

describe('commercial fields (DEC-007)', () => {
  const { validateCommercial, commercialView } = commercial;

  it('everything is empty (null) by default', () => {
    expect(validateCommercial({})).toEqual({ price: null, currency: null, billing_cycle: null, paid_until: null, vat_rate: null, price_includes_vat: null });
    expect(validateCommercial({ price: '', currency: ' ', vat_rate: null, price_includes_vat: '' }).price).toBeNull();
  });

  it('normalizes valid values', () => {
    expect(validateCommercial({ price: '4800', currency: 'sar', billing_cycle: 'Annual', paid_until: '2027-01-31', vat_rate: '15', price_includes_vat: 'false' })).toEqual({
      price: 4800,
      currency: 'SAR',
      billing_cycle: 'annual',
      paid_until: '2027-01-31',
      vat_rate: 15,
      price_includes_vat: false,
    });
  });

  it('rejects invalid values', () => {
    expect(() => validateCommercial({ price: -1 })).toThrow();
    expect(() => validateCommercial({ currency: 'riyal' })).toThrow();
    expect(() => validateCommercial({ billing_cycle: 'weekly' })).toThrow();
    expect(() => validateCommercial({ paid_until: '2027-02-30' })).toThrow();
    expect(() => validateCommercial({ vat_rate: 101 })).toThrow();
    expect(() => validateCommercial({ price_includes_vat: 'maybe' })).toThrow();
  });

  it('maps SQLite 0/1/NULL to a tri-state boolean', () => {
    expect(commercialView({ price_includes_vat: 1 })?.price_includes_vat).toBe(true);
    expect(commercialView({ price_includes_vat: 0 })?.price_includes_vat).toBe(false);
    expect(commercialView({ price_includes_vat: null })?.price_includes_vat).toBeNull();
  });
});

describe('tenant-stats helpers', () => {
  it('reads DATABASE_URL from a dotenv file without executing it', () => {
    const text = '# c\nPORT=1\nDATABASE_URL="postgresql://a:b@h/d?x=1"\nexport OTHER=$(rm -rf /)\n';
    expect(readEnvValue(text, 'DATABASE_URL')).toBe('postgresql://a:b@h/d?x=1');
    expect(readEnvValue(text, 'MISSING')).toBeNull();
  });

  it('forces a single pooled connection', () => {
    expect(singleConnectionUrl('postgresql://u:p@h/d?schema=public&connection_limit=5&pool_timeout=20')).toBe(
      'postgresql://u:p@h/d?schema=public&connection_limit=1&pool_timeout=30',
    );
  });

  it('last three months in the Riyadh calendar, across a year boundary', () => {
    expect(lastMonths(3, new Date('2026-01-31T22:00:00Z'))).toEqual([
      { year: 2026, month: 2 },
      { year: 2026, month: 1 },
      { year: 2025, month: 12 },
    ]);
  });

  it('parses arguments', () => {
    expect(parseArgs(['--env-dir', '/etc/radeef', '--tenant', 'dar'])).toEqual({ envDir: '/etc/radeef', tenants: ['dar'] });
    expect(() => parseArgs(['--bogus'])).toThrow();
  });
});
