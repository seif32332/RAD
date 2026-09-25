import { describe, expect, it } from 'vitest';
import {
  accessExpired,
  alertCutoffDate as jobCutoff,
  buildDigest,
  CATEGORY_LABELS,
  classifyForDigest,
  classifySendError,
  daysUntil as jobDaysUntil,
  DIGEST_THRESHOLDS,
  digestIdempotencyKey,
  digestThresholds,
  outboxSendConfig,
  parseDigestRoles,
  parseGraceDays,
  riyadhTodayKey,
  withConnectionLimit,
} from '../../../scripts/jobs.mjs';
import { ALERT_THRESHOLD_SETTINGS, alertCutoffDate, classifyExpiry, parseAlertThresholds } from '@/lib/alerts';
import { daysUntil, todayKey } from '@/lib/dates';

// scripts/jobs.mjs re-implements a minimal copy of the date math and thresholds of
// src/lib/dates.ts + src/lib/alerts.ts (it runs with plain node). These tests keep them identical.

const NOW_CASES = [
  new Date('2026-09-24T09:00:00Z'),
  new Date('2026-09-24T20:59:59Z'), // 23:59:59 Riyadh
  new Date('2026-09-24T21:00:00Z'), // 00:00 Riyadh next day
  new Date('2026-12-31T22:30:00Z'),
  new Date('2028-02-28T23:00:00Z'),
];

describe('jobs.mjs date math matches src/lib/dates.ts', () => {
  it('riyadhTodayKey == todayKey', () => {
    for (const now of NOW_CASES) expect(riyadhTodayKey(now)).toBe(todayKey(now));
  });

  it('daysUntil == dates.daysUntil for stored date-only values', () => {
    for (const now of NOW_CASES) {
      for (const d of ['2026-09-23', '2026-09-24', '2026-09-25', '2027-01-01', '2028-02-29', '2025-01-01']) {
        const stored = new Date(`${d}T00:00:00.000Z`);
        expect(jobDaysUntil(stored, now)).toBe(daysUntil(stored, now));
      }
    }
    expect(jobDaysUntil(null)).toBeNull();
    expect(jobDaysUntil('not a date')).toBeNull();
  });
});

describe('jobs.mjs thresholds and classification match src/lib/alerts.ts', () => {
  it('every digest threshold has the same SystemSetting key and default as ALERT_THRESHOLD_SETTINGS', () => {
    for (const [name, t] of Object.entries(DIGEST_THRESHOLDS)) {
      expect(ALERT_THRESHOLD_SETTINGS[name as keyof typeof ALERT_THRESHOLD_SETTINGS]).toEqual(t);
    }
  });

  it('covers the three branch service contracts (waste, safety, cameras) with the alerts.ts keys', () => {
    for (const name of ['wasteContract', 'safetyContract', 'cameraContract'] as const) {
      expect(DIGEST_THRESHOLDS).toHaveProperty(name);
      expect((DIGEST_THRESHOLDS as Record<string, unknown>)[name]).toEqual(ALERT_THRESHOLD_SETTINGS[name]);
    }
  });

  it('every digest category has an Arabic label, and the commercial register is an annual confirmation', () => {
    for (const name of Object.keys(DIGEST_THRESHOLDS)) {
      const label = (CATEGORY_LABELS as Record<string, string>)[name];
      expect(label, name).toBeTruthy();
      expect(label).toMatch(/[؀-ۿ]/);
    }
    expect(CATEGORY_LABELS.commercialReg).toContain('التأكيد السنوي');
    expect(CATEGORY_LABELS.safetyContract).toContain('السلامة');
  });

  it('SystemSetting overrides parse the same way', () => {
    const rows = [
      { key: 'alert_iqama_days', value: '45' },
      { key: 'alert_passport_days', value: '-3' },
      { key: 'alert_agency_days', value: 'abc' },
      { key: 'alert_trademark_days', value: '99999' },
      { key: 'alert_safety_contract_days', value: '14' },
    ];
    const ours = digestThresholds(rows);
    const theirs = parseAlertThresholds(rows);
    for (const name of Object.keys(DIGEST_THRESHOLDS)) expect(ours[name]).toBe(theirs[name as keyof typeof theirs]);
    expect(ours.iqama).toBe(45);
    expect(ours.passport).toBe(120);
    expect(ours.safetyContract).toBe(14);
    expect(ours.cameraContract).toBe(30);
  });

  it('expired / expiring agree with classifyExpiry (critical + warning = expiring)', () => {
    const now = new Date('2026-09-24T09:00:00Z');
    for (let offset = -40; offset <= 140; offset++) {
      const date = new Date(Date.parse('2026-09-24T00:00:00Z') + offset * 86400000);
      for (const threshold of [0, 7, 30, 60, 120]) {
        const ref = classifyExpiry(date, threshold, now);
        const expected = !ref || ref.level === 'ok' ? null : ref.level === 'expired' ? 'expired' : 'expiring';
        expect(classifyForDigest(date, threshold, now)).toBe(expected);
      }
    }
  });

  it('alertCutoffDate is identical', () => {
    for (const now of NOW_CASES) for (const d of [0, 7, 30, 120]) expect(jobCutoff(d, now).toISOString()).toBe(alertCutoffDate(d, now).toISOString());
  });
});

describe('expiry digest content', () => {
  const zero = { expired: 0, expiring: 0 };

  it('returns null on a quiet day (nothing is enqueued)', () => {
    expect(buildDigest({ iqama: zero, passport: zero }, { dayKey: '2026-09-24', loginUrl: 'https://x/login' })).toBeNull();
  });

  it('contains counts, category labels and the login link only', () => {
    const d = buildDigest({ iqama: { expired: 6, expiring: 4 }, passport: zero, agency: { expired: 1, expiring: 0 } }, { dayKey: '2026-09-24', loginUrl: 'https://t.example/login' });
    expect(d).not.toBeNull();
    expect(d!.subject).toContain('7');
    expect(d!.subject).toContain('4');
    expect(d!.body).toContain('الإقامات / الهويات: منتهية 6، تنتهي قريباً 4');
    expect(d!.body).toContain('الوكالات الشرعية: منتهية 1، تنتهي قريباً 0');
    expect(d!.body).not.toContain('جوازات السفر');
    expect(d!.body).toContain('https://t.example/login');
  });

  it('lists branch service contracts under their own labels', () => {
    const d = buildDigest(
      { safetyContract: { expired: 2, expiring: 0 }, cameraContract: { expired: 0, expiring: 1 }, wasteContract: zero },
      { dayKey: '2026-09-24', loginUrl: 'https://t.example/login' },
    );
    expect(d!.body).toContain('عقود صيانة السلامة للفروع: منتهية 2، تنتهي قريباً 0');
    expect(d!.body).toContain('عقود صيانة الكاميرات للفروع: منتهية 0، تنتهي قريباً 1');
    expect(d!.body).not.toContain('عقود النفايات');
  });

  it('idempotency key is per user per day', () => {
    expect(digestIdempotencyKey('u1', '2026-09-24')).toBe('expiry-digest:u1:2026-09-24');
  });

  it('digest roles default to owners/admins and never include EMPLOYEE', () => {
    expect(parseDigestRoles(undefined)).toEqual(['SUPER_ADMIN', 'COMPANY_ADMIN']);
    expect(parseDigestRoles('hr_manager, EMPLOYEE ,nonsense')).toEqual(['HR_MANAGER']);
    expect(parseDigestRoles('EMPLOYEE')).toEqual(['SUPER_ADMIN', 'COMPANY_ADMIN']);
  });
});

describe('deactivate-terminated rule', () => {
  it('parses terminated_access_days like src/lib/access.ts', () => {
    expect(parseGraceDays(undefined)).toBe(0);
    expect(parseGraceDays('abc')).toBe(0);
    expect(parseGraceDays('-2')).toBe(0);
    expect(parseGraceDays('3.9')).toBe(3);
    expect(parseGraceDays('500')).toBe(90);
  });

  it('grace 0 = immediately; grace N = from termination day + N (Riyadh calendar)', () => {
    const now = new Date('2026-09-24T09:00:00Z');
    const on = (d: string) => new Date(`${d}T00:00:00.000Z`);
    expect(accessExpired(on('2026-09-24'), 0, now)).toBe(true);
    expect(accessExpired(on('2026-09-30'), 0, now)).toBe(true);
    expect(accessExpired(on('2026-09-22'), 3, now)).toBe(false);
    expect(accessExpired(on('2026-09-21'), 3, now)).toBe(true);
    expect(accessExpired(null, 3, now)).toBe(true);
  });
});

describe('outbox dispatch', () => {
  it('is a dry run unless OUTBOX_SEND=true and SMTP is configured', () => {
    expect(outboxSendConfig({}).live).toBe(false);
    expect(outboxSendConfig({ OUTBOX_SEND: 'true' }).reason).toMatch(/SMTP not configured/);
    expect(outboxSendConfig({ SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'f' }).live).toBe(false);
    const live = outboxSendConfig({ OUTBOX_SEND: 'true', SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_FROM: 'f', OUTBOX_BATCH: '9999' });
    expect(live.live).toBe(true);
    expect(live.batch).toBe(200);
    expect(live.leaseSeconds).toBe(300);
  });

  it('timeouts are UNKNOWN (never retried); definite rejections are FAILED', () => {
    expect(classifySendError({ code: 'ETIMEDOUT', message: 'Timeout' })).toBe('UNKNOWN');
    expect(classifySendError({ code: 'ESOCKET', message: 'socket closed', command: 'DATA' })).toBe('UNKNOWN');
    expect(classifySendError({ code: 'EENVELOPE', responseCode: 550, message: 'no such user' })).toBe('FAILED');
    expect(classifySendError({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' })).toBe('FAILED');
    expect(classifySendError({ code: 'EAUTH', message: 'Invalid login' })).toBe('FAILED');
    expect(classifySendError(new Error('something odd'))).toBe('UNKNOWN');
  });

  it('jobs use a 2-connection pool', () => {
    expect(withConnectionLimit('postgresql://u:p@h/d?schema=public&connection_limit=10&pool_timeout=20')).toBe(
      'postgresql://u:p@h/d?schema=public&pool_timeout=20&connection_limit=2',
    );
    expect(withConnectionLimit('postgresql://u:p@h/d')).toBe('postgresql://u:p@h/d?connection_limit=2');
  });
});
