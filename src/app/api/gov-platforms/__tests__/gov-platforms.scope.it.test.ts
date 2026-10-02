// P1-SCOPE part C (INV-SCOPE-01, ARCH-016.test): the government-platform credentials vault on a real
// database with REAL authentication (src/test/route-harness.ts): allow, deny and other company for
// list, reveal and writes (GovPlatform.companyId, migration 9zb).
// Opt-in: SCOPE_IT=1 with DATABASE_URL pointing at a THROWAWAY database.
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

const ids = (rows: unknown) => (rows as { id: string }[]).map((r) => r.id);

describe.skipIf(process.env.SCOPE_IT !== '1')('gov-platforms: company scope (real auth)', { timeout: 120_000 }, async () => {
  // vitest runs the body of a skipped suite while collecting: never touch a database unless opted in.
  if (process.env.SCOPE_IT !== '1') return;
  const h = await createRouteHarness(state);
  const route = await import('@/app/api/gov-platforms/route');

  const p = { A: '', B: '' };
  for (const k of ['A', 'B'] as const) {
    p[k] = (await h.prisma.govPlatform.create({ data: { companyId: h.co[k], platformName: `قوى ${k}`, username: `u${k}`, password: 'plain' } })).id;
  }

  it('deny: no session 401, roles outside the vault (HR, employee) 403', async () => {
    await h.as(null);
    expect((await route.GET(h.req('GET', '/api/gov-platforms'))).status).toBe(401);
    for (const who of ['hrA', 'empA'] as const) {
      await h.as(who);
      expect((await route.GET(h.req('GET', '/api/gov-platforms'))).status, who).toBe(403);
    }
  });

  it('list and reveal: govA gets the platforms of company A only; the owner sees both', async () => {
    await h.as('govA');
    const list = ids(await (await route.GET(h.req('GET', '/api/gov-platforms'))).json());
    expect(list).toContain(p.A);
    expect(list).not.toContain(p.B);
    expect((await route.GET(h.req('GET', `/api/gov-platforms?reveal=${p.A}`))).status).toBe(200);
    expect((await route.GET(h.req('GET', `/api/gov-platforms?reveal=${p.B}`))).status).toBe(404);
    expect((await route.POST(h.req('POST', '/x', { action: 'reveal', id: p.B }))).status).toBe(404);
    await h.as('owner');
    expect(ids(await (await route.GET(h.req('GET', '/api/gov-platforms'))).json())).toEqual(expect.arrayContaining([p.A, p.B]));
  });

  it('other company: govB cannot update, delete or create credentials of company A', async () => {
    await h.as('govB');
    expect((await route.PUT(h.req('PUT', '/x', { id: p.A, username: 'hacked' }))).status).toBe(404);
    expect((await route.DELETE(h.req('DELETE', `/api/gov-platforms?id=${p.A}`))).status).toBe(404);
    expect((await route.POST(h.req('POST', '/x', { platformName: 'x', username: 'y', password: 'z', companyId: h.co.A }))).status).toBe(403);
    // Nor move his own credentials to company A.
    expect((await route.PUT(h.req('PUT', '/x', { id: p.B, companyId: h.co.A }))).status).toBe(403);
    expect(await h.prisma.govPlatform.findUnique({ where: { id: p.A } })).toMatchObject({ username: 'uA', companyId: h.co.A });
  });

  it('allow: govA creates (company A by default) and updates credentials of company A', async () => {
    await h.as('govA');
    const res = await route.POST(h.req('POST', '/x', { platformName: 'أبشر', username: 'n', password: 'secret' }));
    expect(res.status).toBe(201);
    const { platform } = (await res.json()) as { platform: { id: string; companyId: string; password: string } };
    expect(platform.companyId).toBe(h.co.A);
    expect(platform.password).not.toBe('secret');
    expect((await route.PUT(h.req('PUT', '/x', { id: p.A, notes: 'ok' }))).status).toBe(200);
    expect((await route.DELETE(h.req('DELETE', `/api/gov-platforms?id=${platform.id}`))).status).toBe(200);
  });
});
