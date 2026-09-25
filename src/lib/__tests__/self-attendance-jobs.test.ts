import { describe, expect, it } from 'vitest';
import { isBiometricName as jobIsBiometricName, JOB_NAMES, parseRetentionDays } from '../../../scripts/jobs.mjs';
import { isBiometricName } from '@/lib/biometric-storage';
import { SELF_ATTENDANCE_SETTING_LIMITS } from '@/lib/self-attendance';

describe('purge-attendance-biometrics job helpers', () => {
  it('is a registered job', () => {
    expect(JOB_NAMES).toContain('purge-attendance-biometrics');
  });

  it('reads the retention setting like the app does (default and range)', () => {
    const { defaultValue, min, max } = SELF_ATTENDANCE_SETTING_LIMITS.selfieRetentionDays;
    expect(parseRetentionDays(undefined)).toBe(defaultValue);
    expect(parseRetentionDays('30')).toBe(30);
    expect(parseRetentionDays('"45"')).toBe(45);
    expect(parseRetentionDays(String(min))).toBe(min);
    expect(parseRetentionDays(String(max))).toBe(max);
    expect(parseRetentionDays(String(max + 1))).toBe(defaultValue);
    expect(parseRetentionDays('0')).toBe(defaultValue);
    expect(parseRetentionDays('abc')).toBe(defaultValue);
  });

  it('accepts exactly the file names written by src/lib/biometric-storage.ts', () => {
    const names = [
      '0a1b2c3d-1111-2222-3333-444455556666.jpg',
      '0a1b2c3d-1111-2222-3333-444455556666.png',
      '0a1b2c3d-1111-2222-3333-444455556666.webp',
      '0a1b2c3d-1111-2222-3333-444455556666.pdf',
      '../0a1b2c3d-1111-2222-3333-444455556666.jpg',
      'selfie.jpg',
      '',
    ];
    for (const n of names) expect(jobIsBiometricName(n)).toBe(isBiometricName(n));
    expect(isBiometricName('0a1b2c3d-1111-2222-3333-444455556666.jpg')).toBe(true);
    expect(isBiometricName('../0a1b2c3d-1111-2222-3333-444455556666.jpg')).toBe(false);
  });
});
