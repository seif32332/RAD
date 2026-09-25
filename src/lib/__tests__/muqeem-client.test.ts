import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const companyFindUnique = vi.fn();
vi.mock('@/lib/prisma', () => ({ prisma: { company: { findUnique: (...a: unknown[]) => companyFindUnique(...a) } } }));

import { encryptField } from '@/lib/crypto';
import { HttpError } from '@/lib/http';
import { clearMuqeemCaches, createMuqeemClient, getCachedMuqeemLookup, jwtExpiryMs, type MuqeemFetch } from '@/lib/muqeem/client';
import { MuqeemError } from '@/lib/muqeem/errors';

const BASE = 'http://muqeem.test';
const PASSWORD = 'S3cret-Pass!';
const ENV_KEYS = ['MUQEEM_ENABLED', 'MUQEEM_BASE_URL', 'MUQEEM_APP_ID', 'MUQEEM_APP_KEY', 'MUQEEM_INTEGRATOR_ID', 'MUQEEM_TIMEOUT_MS'] as const;
const savedEnv: Record<string, string | undefined> = {};

let jti = 0;
function jwt(expInSeconds: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS512' })}.${b64({ sub: 'mock-user', jti: ++jti, exp: Math.floor(Date.now() / 1000) + expInSeconds })}.sig`;
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (call: Call, init: RequestInit) => Promise<Response> | Response;

/** Fake fetch routing by path; records every call. */
function fakeFetch(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const fn: MuqeemFetch = async (url, init) => {
    const u = new URL(url);
    const call: Call = {
      url,
      method: String(init.method),
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)),
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const handler = routes[u.pathname];
    if (!handler) return new Response(JSON.stringify({ message: 'no route' }), { status: 404 });
    return handler(call, init);
  };
  return { fn, calls, count: (path: string) => calls.filter((c) => new URL(c.url).pathname === path).length };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const authOk = (expSeconds = 3600) => () => json({ id_token: jwt(expSeconds) });

const ER_RESPONSE = {
  iqamaNumber: '2400000001',
  residentName: 'مقيم',
  translatedResidentName: 'RESIDENT',
  visaDuration: 30,
  visaNumber: '7001234567',
  visaType: 'Single',
};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.MUQEEM_ENABLED = 'true';
  process.env.MUQEEM_BASE_URL = BASE;
  process.env.MUQEEM_APP_ID = 'app-id-123';
  process.env.MUQEEM_APP_KEY = 'app-key-456';
  delete process.env.MUQEEM_INTEGRATOR_ID;
  process.env.MUQEEM_TIMEOUT_MS = '1000';
  clearMuqeemCaches();
  companyFindUnique.mockReset();
  companyFindUnique.mockResolvedValue({
    id: 'c1',
    moiNumber: '7001234567',
    muqeemPlatform: { id: 'p1', username: 'mock-user', password: encryptField(PASSWORD) },
  });
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.useRealTimers();
});

describe('configuration and linking', () => {
  it('throws NOT_CONFIGURED when the integration is disabled', async () => {
    process.env.MUQEEM_ENABLED = 'false';
    await expect(createMuqeemClient({ companyId: 'c1' })).rejects.toMatchObject({ kind: 'NOT_CONFIGURED', status: 503 });
  });

  it('throws NOT_CONFIGURED when a required value is missing', async () => {
    delete process.env.MUQEEM_APP_KEY;
    await expect(createMuqeemClient({ companyId: 'c1' })).rejects.toMatchObject({ kind: 'NOT_CONFIGURED' });
  });

  it('throws NOT_LINKED when the company has no moiNumber or no credentials', async () => {
    companyFindUnique.mockResolvedValueOnce({ id: 'c1', moiNumber: null, muqeemPlatform: { id: 'p1', username: 'u', password: 'x' } });
    await expect(createMuqeemClient({ companyId: 'c1' })).rejects.toMatchObject({ kind: 'NOT_LINKED', status: 409 });
    companyFindUnique.mockResolvedValueOnce({ id: 'c1', moiNumber: '7001234567', muqeemPlatform: null });
    await expect(createMuqeemClient({ companyId: 'c1' })).rejects.toMatchObject({ kind: 'NOT_LINKED' });
  });

  it('404 for an unknown company', async () => {
    companyFindUnique.mockResolvedValueOnce(null);
    await expect(createMuqeemClient({ companyId: 'nope' })).rejects.toBeInstanceOf(HttpError);
  });
});

describe('authentication', () => {
  it('sends app-id / app-key and the decrypted credentials to /api/authenticate', async () => {
    const f = fakeFetch({ '/api/authenticate': authOk(), '/api/lookups/countries': () => json([{ code: '1', nameAr: 'مصر', nameEn: 'Egypt' }]) });
    const client = await createMuqeemClient({ companyId: 'c1', fetch: f.fn });
    const items = await client.getCountries();
    expect(items).toEqual([{ code: '1', nameAr: 'مصر', nameEn: 'Egypt' }]);
    const auth = f.calls[0];
    expect(auth.method).toBe('POST');
    expect(auth.url).toBe(`${BASE}/api/authenticate`);
    expect(auth.headers['app-id']).toBe('app-id-123');
    expect(auth.headers['app-key']).toBe('app-key-456');
    expect(auth.headers.Authorization).toBeUndefined();
    expect(auth.body).toEqual({ username: 'mock-user', password: PASSWORD });
  });

  it('caches the token per company until exp - 60 s', async () => {
    const f = fakeFetch({ '/api/authenticate': authOk(3600), '/api/lookups/cities': () => json([]) });
    const client = await createMuqeemClient({ companyId: 'c1', fetch: f.fn });
    await client.getCities();
    await client.getCities();
    const second = await createMuqeemClient({ companyId: 'c1', fetch: f.fn });
    await second.getCities();
    expect(f.count('/api/authenticate')).toBe(1);
    expect(f.count('/api/lookups/cities')).toBe(3);
  });

  it('re-authenticates when the token expires within the 60 s skew', async () => {
    const f = fakeFetch({ '/api/authenticate': authOk(30), '/api/lookups/cities': () => json([]) });
    const client = await createMuqeemClient({ companyId: 'c1', fetch: f.fn });
    await client.getCities();
    await client.getCities();
    expect(f.count('/api/authenticate')).toBe(2);
  });

  it('re-authenticates once on 401 and replays the call', async () => {
    let first = true;
    const f = fakeFetch({
      '/api/authenticate': authOk(),
      '/api/v1/exit-reentry/issue': () => {
        if (first) {
          first = false;
          return json({ title: 'Unauthorized' }, 401);
        }
        return json(ER_RESPONSE);
      },
    });
    const client = await createMuqeemClient({ companyId: 'c1', fetch: f.fn });
    const res = await client.issueExitReentry({ iqamaNumber: '2400000001', visaType: 1, visaDuration: 30 });
    expect(res.visaNumber).toBe('7001234567');
    expect(f.count('/api/authenticate')).toBe(2);
    expect(f.count('/api/v1/exit-reentry/issue')).toBe(2);
    const [a, b] = f.calls.filter((c) => c.url.endsWith('/issue'));
    expect(a.headers.Authorization).not.toBe(b.headers.Authorization);
  });

  it('AUTH when the call is refused twice with 401', async () => {
    const f = fakeFetch({ '/api/authenticate': authOk(), '/api/lookups/cities': () => json({ title: 'Unauthorized' }, 401) });
    const client = await createMuqeemClient({ companyId: 'c1', fetch: f.fn });
    await expect(client.getCities()).rejects.toMatchObject({ kind: 'AUTH', status: 502 });
    expect(f.count('/api/authenticate')).toBe(2);
  });

  it('AUTH when /api/authenticate refuses the credentials, without leaking the password', async () => {
    const f = fakeFetch({ '/api/authenticate': () => json({ detail: `Bad credentials for ${PASSWORD}` }, 401) });
    const client = await createMuqeemClient({ companyId: 'c1', fetch: f.fn });
    const err = await client.authenticate().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MuqeemError);
    expect((err as MuqeemError).kind).toBe('AUTH');
    expect(JSON.stringify({ m: (err as MuqeemError).message, u: (err as MuqeemError).upstreamMessage, d: (err as MuqeemError).detail })).not.toContain(PASSWORD);
    expect((err as MuqeemError).upstreamMessage).toContain('[REDACTED]');
  });

  it('decodes the JWT exp without verifying it', () => {
    const token = jwt(100);
    const exp = jwtExpiryMs(token);
    expect(exp).not.toBeNull();
    expect(Math.abs((exp as number) - (Date.now() + 100_000))).toBeLessThan(2_000);
    expect(jwtExpiryMs('not-a-jwt')).toBeNull();
  });
});

describe('headers', () => {
  it('sends app-id, app-key and Authorization on API calls, and X-INTEGRATOR-ID only when configured', async () => {
    const f = fakeFetch({ '/api/authenticate': authOk(), '/api/v1/exit-reentry/issue': () => json(ER_RESPONSE) });
    let client = await createMuqeemClient({ companyId: 'c1', fetch: f.fn });
    await client.issueExitReentry({ iqamaNumber: '2400000001', visaType: 1, visaDuration: 30 });
    let call = f.calls.find((c) => c.url.endsWith('/exit-reentry/issue')) as Call;
    expect(call.headers['app-id']).toBe('app-id-123');
    expect(call.headers['app-key']).toBe('app-key-456');
    expect(call.headers.Authorization).toMatch(/^Bearer eyJ/);
    expect(call.headers['Content-Type']).toBe('application/json');
    expect(call.headers['X-INTEGRATOR-ID']).toBeUndefined();
    expect(call.body).toEqual({ iqamaNumber: '2400000001', visaType: 1, visaDuration: 30 });

    process.env.MUQEEM_INTEGRATOR_ID = 'integrator-789';
    clearMuqeemCaches();
    const f2 = fakeFetch({ '/api/authenticate': authOk(), '/api/v1/exit-reentry/issue': () => json(ER_RESPONSE) });
    client = await createMuqeemClient({ companyId: 'c1', fetch: f2.fn });
    await client.issueExitReentry({ iqamaNumber: '2400000001', visaType: 1, visaDuration: 30 });
    call = f2.calls.find((c) => c.url.endsWith('/exit-reentry/issue')) as Call;
    expect(call.headers['X-INTEGRATOR-ID']).toBe('integrator-789');
    expect(f2.calls[0].headers['X-INTEGRATOR-ID']).toBe('integrator-789');
  });

  it('fills moiNumber and pageable for the active residents report', async () => {
    const f = fakeFetch({ '/api/authenticate': authOk(), '/api/v1/report/active-residents-report': () => json({ content: [] }) });
    const client = await createMuqeemClient({ companyId: 'c1', fetch: f.fn });
    await client.getActiveResidentsReport({ withDependents: true, page: 2, size: 50 });
    const call = f.calls[1];
    expect(call.body).toEqual({ moiNumber: '7001234567', withDependents: true });
    expect(new URL(call.url).searchParams.get('page')).toBe('2');
    expect(new URL(call.url).searchParams.get('size')).toBe('50');
  });
});

describe('failure classification', () => {
  it('422 with a business message -> REJECTED keeping the Arabic message', async () => {
    const f = fakeFetch({ '/api/authenticate': authOk(), '/api/v1/exit-reentry/issue': () => json({ message: 'الإقامة غير مؤهلة للخدمة' }, 422) });
    const client = await createMuqeemClient({ companyId: 'c1', fetch: f.fn });
    const err = (await client.issueExitReentry({ iqamaNumber: '2400000000', visaType: 1, visaDuration: 30 }).catch((e: unknown) => e)) as MuqeemError;
    expect(err.kind).toBe('REJECTED');
    expect(err.status).toBe(422);
    expect(err.upstreamStatus).toBe(422);
    expect(err.upstreamMessage).toBe('الإقامة غير مؤهلة للخدمة');
    expect(err.message).toContain('الإقامة غير مؤهلة للخدمة');
    expect(err.toHttpError().status).toBe(422);
  });

  it('timeout after sending a mutation -> UNKNOWN_OUTCOME (never a plain failure)', async () => {
    const hang: Handler = (_call, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
      });
    const f = fakeFetch({ '/api/authenticate': authOk(), '/api/v1/iqama/renew': hang });
    const client = await createMuqeemClient({ companyId: 'c1', fetch: f.fn });
    const err = (await client.renewIqama({ iqamaNumber: '2400009999', iqamaDuration: '12' }).catch((e: unknown) => e)) as MuqeemError;
    expect(err).toBeInstanceOf(MuqeemError);
    expect(err.kind).toBe('UNKNOWN_OUTCOME');
    expect(err.status).toBe(504);
    expect(err.outcomeUnknown).toBe(true);
    expect(client.mutationsSent).toBe(1);
  });

  it('timeout on a read-only call -> UNAVAILABLE', async () => {
    const hang: Handler = (_call, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const f = fakeFetch({ '/api/authenticate': authOk(), '/api/lookups/cities': hang });
    const client = await createMuqeemClient({ companyId: 'c1', fetch: f.fn });
    await expect(client.getCities()).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
  });

  it('connection refused on a mutation -> UNAVAILABLE (nothing was sent)', async () => {
    const refused: Handler = () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    };
    const f = fakeFetch({ '/api/authenticate': authOk(), '/api/v1/final-exit/issue': refused });
    const client = await createMuqeemClient({ companyId: 'c1', fetch: f.fn });
    await expect(client.issueFinalExit({ iqamaNumber: '2400000001' })).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
  });

  it('connection reset on a mutation -> UNKNOWN_OUTCOME', async () => {
    const reset: Handler = () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) });
    };
    const f = fakeFetch({ '/api/authenticate': authOk(), '/api/v1/final-exit/issue': reset });
    const client = await createMuqeemClient({ companyId: 'c1', fetch: f.fn });
    await expect(client.issueFinalExit({ iqamaNumber: '2400000001' })).rejects.toMatchObject({ kind: 'UNKNOWN_OUTCOME' });
  });

  it('5xx: 503 -> UNAVAILABLE, 500/504 on a mutation -> UNKNOWN_OUTCOME, 500 on a read -> UNAVAILABLE', async () => {
    let status = 503;
    const f = fakeFetch({
      '/api/authenticate': authOk(),
      '/api/v1/exit-reentry/cancel': () => json({ message: 'down' }, status),
      '/api/lookups/cities': () => json({ message: 'boom' }, 500),
    });
    const client = await createMuqeemClient({ companyId: 'c1', fetch: f.fn });
    const cancel = () => client.cancelExitReentry({ iqamaNumber: '2400000001', erVisaNumber: '123' });
    await expect(cancel()).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
    status = 500;
    await expect(cancel()).rejects.toMatchObject({ kind: 'UNKNOWN_OUTCOME' });
    status = 504;
    await expect(cancel()).rejects.toMatchObject({ kind: 'UNKNOWN_OUTCOME' });
    await expect(client.getCities()).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
  });

  it('update-information answering false -> REJECTED; true -> resolves', async () => {
    let answer = false;
    const f = fakeFetch({ '/api/authenticate': authOk(), '/api/v1/update-information/extend': () => json(answer) });
    const client = await createMuqeemClient({ companyId: 'c1', fetch: f.fn });
    const req = { iqamaNumber: '2400000001', passportNumber: 'AB123', newPassportExpiryDate: '2030-01-01' };
    await expect(client.extendPassportValidity(req)).rejects.toMatchObject({ kind: 'REJECTED' });
    answer = true;
    await expect(client.extendPassportValidity(req)).resolves.toBe(true);
  });

  it('rejects invalid input before sending anything', async () => {
    const f = fakeFetch({ '/api/authenticate': authOk() });
    const client = await createMuqeemClient({ companyId: 'c1', fetch: f.fn });
    await expect(client.issueExitReentry({ iqamaNumber: '1234', visaType: 1, visaDuration: 30 })).rejects.toBeInstanceOf(HttpError);
    await expect(client.issueExitReentry({ iqamaNumber: '2400000001', visaType: 1, visaDuration: 3 })).rejects.toBeInstanceOf(HttpError);
    await expect(client.issueExitReentry({ iqamaNumber: '2400000001', visaType: 1, returnBefore: '2026-01-01' })).rejects.toBeInstanceOf(HttpError);
    expect(f.calls).toHaveLength(0);
    expect(client.mutationsSent).toBe(0);
  });
});

describe('lookup cache', () => {
  it('caches lookups for 12 h across companies', async () => {
    const f = fakeFetch({ '/api/authenticate': authOk(), '/api/lookups/countries': () => json([{ code: '1' }]) });
    const a = await getCachedMuqeemLookup('countries', 'c1', { fetch: f.fn });
    const b = await getCachedMuqeemLookup('countries', 'c1', { fetch: f.fn });
    expect(a.fromCache).toBe(false);
    expect(b.fromCache).toBe(true);
    expect(b.items).toEqual([{ code: '1' }]);
    expect(f.count('/api/lookups/countries')).toBe(1);
  });
});
