import { describe, expect, it } from 'vitest';
import { accessExpired, parseDigestRoles } from '@/lib/access';
import { buildDigest, DIGEST_CATEGORIES, DIGEST_CATEGORY_LABELS, digestIdempotencyKey, digestLevel, loginUrl } from '@/lib/alerts-digest';
import { ALERT_THRESHOLD_SETTINGS, classifyExpiry } from '@/lib/alerts';
import { classifySendError, outboxSendConfig } from '@/modules/platform';
import { withConnectionLimit } from '@/jobs/cli';

// Behaviour of the background jobs' rules. Since P1-FND-JOBS (DEC-PO-121) the jobs run the modules'
// own TypeScript (src/jobs/registry.ts), so there is no second copy of the thresholds or the date math
// to keep in sync any more: the parity tests that guarded scripts/jobs.mjs are gone.

describe('expiry digest', () => {
  const zero = { expired: 0, expiring: 0 };

  it('every digest category is an alert window of alerts.ts and has an Arabic label', () => {
    for (const name of DIGEST_CATEGORIES) {
      expect(ALERT_THRESHOLD_SETTINGS).toHaveProperty(name);
      expect(DIGEST_CATEGORY_LABELS[name]).toMatch(/[؀-ۿ]/);
    }
    for (const name of ['wasteContract', 'safetyContract', 'cameraContract'] as const) expect(DIGEST_CATEGORIES).toContain(name);
    expect(DIGEST_CATEGORY_LABELS.commercialReg).toContain('التأكيد السنوي');
    expect(DIGEST_CATEGORY_LABELS.safetyContract).toContain('السلامة');
  });

  it('expired / expiring are classifyExpiry folded (critical + warning = expiring)', () => {
    const now = new Date('2026-09-24T09:00:00Z');
    const day = (offset: number) => new Date(Date.parse('2026-09-24T00:00:00Z') + offset * 86400000);
    expect(digestLevel(day(-1), 30, now)).toBe('expired');
    expect(digestLevel(day(0), 30, now)).toBe('expiring');
    expect(digestLevel(day(30), 30, now)).toBe('expiring');
    expect(digestLevel(day(31), 30, now)).toBeNull();
    expect(digestLevel(null, 30, now)).toBeNull();
    expect(classifyExpiry(day(3), 30, now)?.level).toBe('critical');
    expect(digestLevel(day(3), 30, now)).toBe('expiring');
  });

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

  it('idempotency key is per user per day; the login link only from a valid APP_URL', () => {
    expect(digestIdempotencyKey('u1', '2026-09-24')).toBe('expiry-digest:u1:2026-09-24');
    expect(loginUrl({ APP_URL: 'https://t.example/' })).toBe('https://t.example/login');
    expect(loginUrl({ APP_URL: 'javascript:alert(1)' })).toBeNull();
    expect(loginUrl({})).toBeNull();
  });

  it('digest roles default to owners/admins and never include EMPLOYEE', () => {
    expect(parseDigestRoles(undefined)).toEqual(['SUPER_ADMIN', 'COMPANY_ADMIN']);
    expect(parseDigestRoles('hr_manager, EMPLOYEE ,nonsense')).toEqual(['HR_MANAGER']);
    expect(parseDigestRoles('EMPLOYEE')).toEqual(['SUPER_ADMIN', 'COMPANY_ADMIN']);
  });
});

describe('deactivate-terminated rule', () => {
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
