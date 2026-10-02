import { describe, expect, it } from 'vitest';
import { JOB_NAMES } from '@/jobs/registry';
import { SELF_ATTENDANCE_SETTING_LIMITS } from '@/lib/self-attendance';
import { ORPHAN_MIN_AGE_MS, orphanBiometricNames, selfieRetentionDays } from '@/lib/self-attendance-retention';

describe('purge-attendance-biometrics job helpers', () => {
  it('is a registered job', () => {
    expect(JOB_NAMES).toContain('purge-attendance-biometrics');
  });

  it('reads the retention setting like the app does (default and range)', () => {
    const { defaultValue, min, max } = SELF_ATTENDANCE_SETTING_LIMITS.selfieRetentionDays;
    expect(selfieRetentionDays(undefined)).toBe(defaultValue);
    expect(selfieRetentionDays('30')).toBe(30);
    expect(selfieRetentionDays('"45"')).toBe(45);
    expect(selfieRetentionDays(String(min))).toBe(min);
    expect(selfieRetentionDays(String(max))).toBe(max);
    expect(selfieRetentionDays(String(max + 1))).toBe(defaultValue);
    expect(selfieRetentionDays('0')).toBe(defaultValue);
    expect(selfieRetentionDays('abc')).toBe(defaultValue);
  });

  it('sweeps only unreferenced biometric files older than a day', () => {
    const now = new Date('2026-09-26T04:50:00Z');
    const old = now.getTime() - ORPHAN_MIN_AGE_MS - 1;
    const fresh = now.getTime() - 60_000;
    const a = '0a1b2c3d-1111-2222-3333-444455556666.jpg';
    const b = '0a1b2c3d-1111-2222-3333-444455556667.jpg';
    const c = '0a1b2c3d-1111-2222-3333-444455556668.png';
    const files = [
      { name: a, mtimeMs: old }, // referenced: kept
      { name: b, mtimeMs: old }, // orphan: deleted
      { name: c, mtimeMs: fresh }, // orphan but maybe still being committed: kept
      { name: 'notes.txt', mtimeMs: old }, // not ours: kept
      { name: '../0a1b2c3d-1111-2222-3333-444455556669.jpg', mtimeMs: old }, // never outside the folder
    ];
    expect(orphanBiometricNames(files, new Set([a]), now)).toEqual([b]);
  });
});
