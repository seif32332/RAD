import { describe, expect, it } from 'vitest';
import { HttpError } from '@/lib/http';
import {
  assertCompanyCostChange,
  assertCompanyWorkforceChange,
  companyCostChanges,
  zIqamaFeeYear,
  zIsIndustrialLicensed,
  zMedicalPremiums,
  zNitaqatActivity,
  zOvertimeHourlyBasis,
} from '@/app/api/companies/_workforce';

const admin = { role: 'COMPANY_ADMIN' as const };
const hr = { role: 'HR_MANAGER' as const };

function statusOf(fn: () => void): number | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof HttpError ? err.status : -1;
  }
}

describe('company workforce fields', () => {
  it('parses the activity text and the licence flag', () => {
    expect(zNitaqatActivity.parse('  تجارة   الجملة ')).toBe('تجارة الجملة');
    expect(zNitaqatActivity.parse('')).toBeNull();
    expect(zNitaqatActivity.parse(undefined)).toBeUndefined();
    expect(zNitaqatActivity.safeParse('x'.repeat(301)).success).toBe(false);
    expect(zIsIndustrialLicensed.parse('true')).toBe(true);
    expect(zIsIndustrialLicensed.parse(false)).toBe(false);
    expect(zIsIndustrialLicensed.parse('')).toBeUndefined();
    const bad = zIsIndustrialLicensed.safeParse('maybe');
    expect(bad.success).toBe(false);
    expect(bad.success ? '' : bad.error.issues[0].message).toMatch(/[؀-ۿ]/);
  });

  it('SUPER_ADMIN / COMPANY_ADMIN may change them', () => {
    expect(statusOf(() => assertCompanyWorkforceChange(admin, { nitaqatActivity: 'صناعة', isIndustrialLicensed: true }, null))).toBeNull();
    expect(statusOf(() => assertCompanyWorkforceChange({ role: 'SUPER_ADMIN' }, { isIndustrialLicensed: false }, { nitaqatActivity: null, isIndustrialLicensed: true }))).toBeNull();
  });

  it('other writers get 403 on a change, but may re-send the stored values', () => {
    const stored = { nitaqatActivity: 'صناعة', isIndustrialLicensed: true };
    expect(statusOf(() => assertCompanyWorkforceChange(hr, { nitaqatActivity: 'صناعة', isIndustrialLicensed: true }, stored))).toBeNull();
    expect(statusOf(() => assertCompanyWorkforceChange(hr, {}, stored))).toBeNull();
    expect(statusOf(() => assertCompanyWorkforceChange(hr, { isIndustrialLicensed: false }, stored))).toBe(403);
    expect(statusOf(() => assertCompanyWorkforceChange(hr, { nitaqatActivity: null }, stored))).toBe(403);
    // Create: the defaults (null / false) are allowed, anything else is not.
    expect(statusOf(() => assertCompanyWorkforceChange(hr, { nitaqatActivity: null, isIndustrialLicensed: false }, null))).toBeNull();
    expect(statusOf(() => assertCompanyWorkforceChange(hr, { isIndustrialLicensed: true }, null))).toBe(403);
  });
});

describe('company cost settings («إعدادات الكلفة»)', () => {
  it('parses the overtime basis, the iqama fee and the premiums (Arabic messages)', () => {
    expect(zOvertimeHourlyBasis.parse('total_plus_half_basic')).toBe('TOTAL_PLUS_HALF_BASIC');
    expect(zOvertimeHourlyBasis.parse('')).toBeUndefined();
    const badBasis = zOvertimeHourlyBasis.safeParse('HALF');
    expect(badBasis.success ? '' : badBasis.error.issues[0].message).toMatch(/[؀-ۿ]/);
    expect(zIqamaFeeYear.parse('650')).toBe(650);
    expect(zIqamaFeeYear.parse('')).toBeNull();
    expect(zIqamaFeeYear.parse(undefined)).toBeUndefined();
    const neg = zIqamaFeeYear.safeParse(-1);
    expect(neg.success ? '' : neg.error.issues[0].message).toContain('رسوم الإقامة');
    expect(zIqamaFeeYear.safeParse('abc').success).toBe(false);
    expect(zMedicalPremiums.parse({ VIP: '12000', 'A+': '', A: 6000, DEPENDENT: '900' })).toBe('{"VIP":12000,"A":6000,"DEPENDENT":900}');
    expect(zMedicalPremiums.parse({ VIP: '', A: null })).toBeNull();
    expect(zMedicalPremiums.parse(undefined)).toBeUndefined();
    const badClass = zMedicalPremiums.safeParse({ Gold: 1 });
    expect(badClass.success ? '' : badClass.error.issues[0].message).toContain('Gold');
    const negPremium = zMedicalPremiums.safeParse({ B: -5 });
    expect(negPremium.success ? '' : negPremium.error.issues[0].message).toContain('سالبة');
  });

  it('SUPER_ADMIN / COMPANY_ADMIN may change them; others get 403 on a change but may re-send the stored values', () => {
    const stored = { overtimeHourlyBasis: 'BASIC', medicalPremiumsJson: '{"A":6000}', iqamaFeeYear: null };
    expect(assertCompanyCostChange(admin, { overtimeHourlyBasis: 'TOTAL_PLUS_HALF_BASIC' }, stored)).toEqual(['overtimeHourlyBasis']);
    expect(statusOf(() => assertCompanyCostChange(hr, { overtimeHourlyBasis: 'BASIC', medicalPremiumsJson: '{"A":6000}', iqamaFeeYear: null }, stored))).toBeNull();
    expect(statusOf(() => assertCompanyCostChange(hr, { overtimeHourlyBasis: 'TOTAL_PLUS_HALF_BASIC' }, stored))).toBe(403);
    expect(statusOf(() => assertCompanyCostChange(hr, { medicalPremiumsJson: '{"A":6500}' }, stored))).toBe(403);
    expect(statusOf(() => assertCompanyCostChange(hr, { iqamaFeeYear: 650 }, stored))).toBe(403);
    expect(statusOf(() => assertCompanyCostChange({ role: 'FINANCE_MANAGER' }, { iqamaFeeYear: 650 }, stored))).toBe(403);
    // Create: the defaults are not a change.
    expect(companyCostChanges({ overtimeHourlyBasis: 'BASIC', medicalPremiumsJson: null, iqamaFeeYear: null }, null)).toEqual([]);
    expect(companyCostChanges({ medicalPremiumsJson: '{"B":1}' }, null)).toEqual(['medicalPremiumsJson']);
  });
});
