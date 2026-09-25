import { describe, expect, it } from 'vitest';
import { hijriToGregorian, isHijriDateString, parseMuqeemGregorian, toHijriDateString, toMuqeemGregorian } from '@/lib/muqeem/hijri';
import { MuqeemError, parseMuqeemErrorBody, redactSecrets, toApiError, MUQEEM_ERROR_HTTP_STATUS } from '@/lib/muqeem/errors';
import { activeResidentsTotal, normalizeActiveResidents } from '@/lib/muqeem/types';
import { muqeemConfig, readMuqeemSettings } from '@/lib/muqeem/config';
import { HttpError } from '@/lib/http';

const utc = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe('hijri', () => {
  // Pairs verified with Intl 'en-u-ca-islamic-umalqura-nu-latn' (Umm al-Qura).
  const PAIRS: [string, string][] = [
    ['2026-09-26', '1448-04-15'],
    ['2023-07-19', '1445-01-01'], // 1 Muharram 1445
    ['2025-03-01', '1446-09-01'], // 1 Ramadan 1446
    ['2024-01-01', '1445-06-19'],
    ['2026-01-01', '1447-07-12'],
    ['2000-01-01', '1420-09-24'],
    ['2030-12-31', '1452-09-06'],
  ];

  it.each(PAIRS)('%s -> %s', (g, h) => {
    expect(toHijriDateString(utc(g))).toBe(h);
    expect(toHijriDateString(g)).toBe(h);
  });

  it.each(PAIRS)('hijriToGregorian round trip %s <- %s', (g, h) => {
    expect(hijriToGregorian(h)?.toISOString()).toBe(utc(g).toISOString());
  });

  it('uses the UTC calendar day (storage convention), whatever the time of day', () => {
    expect(toHijriDateString(new Date('2026-09-26T23:30:00Z'))).toBe('1448-04-15');
    expect(toHijriDateString(new Date('2026-09-26T00:00:00Z'))).toBe('1448-04-15');
  });

  it('rejects invalid input', () => {
    expect(() => toHijriDateString(new Date('x'))).toThrow(RangeError);
    expect(hijriToGregorian('2026-09-26')).toBeNull(); // Gregorian year
    expect(hijriToGregorian('1448-13-01')).toBeNull();
    expect(hijriToGregorian('')).toBeNull();
    expect(hijriToGregorian('1448/4/15')?.toISOString()).toBe(utc('2026-09-26').toISOString());
    expect(isHijriDateString('1448-04-15')).toBe(true);
    expect(isHijriDateString('1448-4-15')).toBe(false);
  });

  it('parseMuqeemGregorian accepts the known spellings', () => {
    const want = utc('2026-09-26').toISOString();
    for (const v of ['2026-09-26', '26-09-2026', '26/09/2026', '2026/09/26', '2026-09-26T00:00:00', '2026-09-26T00:00:00+03:00', '2026-09-26T10:15:00.000Z']) {
      expect(parseMuqeemGregorian(v)?.toISOString()).toBe(want);
    }
    expect(parseMuqeemGregorian('1448-04-15')).toBeNull();
    expect(parseMuqeemGregorian('31/02/2026')).toBeNull();
    expect(parseMuqeemGregorian('')).toBeNull();
    expect(parseMuqeemGregorian(null)).toBeNull();
    expect(parseMuqeemGregorian('garbage')).toBeNull();
    expect(toMuqeemGregorian(utc('2026-09-26'))).toBe('2026-09-26');
  });
});

describe('errors', () => {
  it('parses Muqeem error bodies defensively and prefers Arabic', () => {
    expect(parseMuqeemErrorBody('{"message":"الإقامة غير مؤهلة للخدمة"}')).toBe('الإقامة غير مؤهلة للخدمة');
    expect(parseMuqeemErrorBody('{"title":"Bad Request","detail":"رقم الإقامة غير صحيح"}')).toBe('رقم الإقامة غير صحيح');
    expect(parseMuqeemErrorBody('{"message":"error.validation","errors":[{"field":"iqamaNumber","message":"must match"}]}')).toBe('iqamaNumber: must match');
    expect(parseMuqeemErrorBody('{"errors":{"visaDuration":["must be >= 7"]}}')).toBe('must be >= 7');
    expect(parseMuqeemErrorBody('Service temporarily unavailable')).toBe('Service temporarily unavailable');
    expect(parseMuqeemErrorBody('<html><body>502</body></html>')).toBeNull();
    expect(parseMuqeemErrorBody('')).toBeNull();
    expect(parseMuqeemErrorBody('"plain json string"')).toBe('plain json string');
  });

  it('redacts secrets, bearer tokens and JWTs', () => {
    const out = redactSecrets('pw=S3cret! key=app-key-456 auth=Bearer abc.def.ghi jwt=eyJhbGciOi.eyJzdWIiOi.sig', ['S3cret!', 'app-key-456']);
    expect(out).not.toContain('S3cret!');
    expect(out).not.toContain('app-key-456');
    expect(out).not.toContain('abc.def.ghi');
    expect(out).not.toContain('eyJhbGciOi');
  });

  it('maps kinds to our HTTP statuses (never 401)', () => {
    expect(MUQEEM_ERROR_HTTP_STATUS).toMatchObject({ REJECTED: 422, NOT_CONFIGURED: 503, UNKNOWN_OUTCOME: 504, UNAVAILABLE: 503 });
    expect(Object.values(MUQEEM_ERROR_HTTP_STATUS)).not.toContain(401);
    const e = new MuqeemError('REJECTED', { upstreamMessage: 'الإقامة منتهية' });
    expect(e.message).toContain('الإقامة منتهية');
    const http = toApiError(e);
    expect(http).toBeInstanceOf(HttpError);
    expect((http as HttpError).status).toBe(422);
    expect((http as HttpError).details).toMatchObject({ muqeemKind: 'REJECTED' });
    const other = new Error('x');
    expect(toApiError(other)).toBe(other);
  });
});

describe('config', () => {
  it('is usable only when enabled and complete', () => {
    const full = { MUQEEM_ENABLED: 'true', MUQEEM_BASE_URL: 'https://muqeem.example/', MUQEEM_APP_ID: 'a', MUQEEM_APP_KEY: 'k' };
    expect(muqeemConfig(full)).toEqual({ enabled: true, configured: true, usable: true, missing: [] });
    expect(muqeemConfig({ ...full, MUQEEM_ENABLED: 'false' })).toMatchObject({ enabled: false, configured: true, usable: false });
    expect(muqeemConfig({ MUQEEM_ENABLED: 'true', MUQEEM_BASE_URL: 'not a url' }).missing).toEqual(['MUQEEM_BASE_URL', 'MUQEEM_APP_ID', 'MUQEEM_APP_KEY']);
    const s = readMuqeemSettings({ ...full, MUQEEM_TIMEOUT_MS: '8000', MUQEEM_INTEGRATOR_ID: ' ' });
    expect(s).toEqual({ baseUrl: 'https://muqeem.example', appId: 'a', appKey: 'k', integratorId: null, timeoutMs: 8000 });
    expect(readMuqeemSettings(full).timeoutMs).toBe(20000);
    expect(() => readMuqeemSettings({})).toThrow(MuqeemError);
  });
});

describe('normalizeActiveResidents', () => {
  it('reads the mock / Spring Page shape (content[])', () => {
    const raw = {
      content: [
        {
          iqamaNumber: '2400000001',
          residentName: 'محمد',
          translatedResidentName: 'MOHAMMED',
          nationality: 'باكستان',
          occupation: 'محاسب',
          iqamaExpiryDateG: '2027-03-15',
          passportNumber: 'AB1234567',
          passportExpiryDateG: '2029-01-10',
          dependents: [{}, {}],
        },
      ],
      totalElements: 1,
    };
    const [r] = normalizeActiveResidents(raw);
    expect(r).toMatchObject({
      iqamaNumber: '2400000001',
      name: 'محمد',
      translatedName: 'MOHAMMED',
      nationality: 'باكستان',
      occupation: 'محاسب',
      passportNumber: 'AB1234567',
      dependentsCount: 2,
    });
    expect(r.iqamaExpiry?.toISOString()).toBe(utc('2027-03-15').toISOString());
    expect(r.passportExpiry?.toISOString()).toBe(utc('2029-01-10').toISOString());
    expect(r.raw).toBe(raw.content[0]);
    expect(activeResidentsTotal(raw)).toBe(1);
  });

  it('tolerates other containers and field names (LookupVM, snake_case, Hijri-only, dd/MM/yyyy)', () => {
    const rows = [
      { iqama_number: '2400000002', name: 'راجيش', nationality: { ar: 'الهند', en: 'India', code: '401' }, occupation: { en: 'Electrician' }, iqamaExpiryDateH: '1448-04-15', passport_number: 'Z1', passportExpiryDate: '30/06/2027' },
      { residentIqamaNumber: 2400000003, residentName: 'أحمد', iqamaExpiryDate: '2026-10-20' },
      { residentName: 'بدون إقامة' },
    ];
    for (const raw of [rows, { data: rows }, { residents: rows }, { items: rows }, { result: { content: rows } }]) {
      const out = normalizeActiveResidents(raw);
      expect(out.map((r) => r.iqamaNumber)).toEqual(['2400000002', '2400000003']);
      expect(out[0].nationality).toBe('الهند');
      expect(out[0].occupation).toBe('Electrician');
      expect(out[0].iqamaExpiry?.toISOString()).toBe(utc('2026-09-26').toISOString());
      expect(out[0].passportExpiry?.toISOString()).toBe(utc('2027-06-30').toISOString());
      expect(out[1].iqamaExpiry?.toISOString()).toBe(utc('2026-10-20').toISOString());
      expect(out[1].passportNumber).toBeNull();
    }
    expect(normalizeActiveResidents(null)).toEqual([]);
    expect(normalizeActiveResidents('x')).toEqual([]);
    expect(normalizeActiveResidents({ message: 'no rows' })).toEqual([]);
  });
});
