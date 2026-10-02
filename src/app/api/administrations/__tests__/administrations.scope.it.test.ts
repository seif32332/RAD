// P1-SCOPE (INV-SCOPE-01): /api/administrations and /api/administrations/[id] on a real database with
// real sessions (src/test/route-harness.ts). Opt-in: SCOPE_IT=1 with DATABASE_URL on a throwaway database.
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe.skipIf(process.env.SCOPE_IT !== '1')('administrations routes: company scope (real auth)', { timeout: 60_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // skipped: build nothing (the harness writes to the database)
  const h = await createRouteHarness(state);
  const list = await import('@/app/api/administrations/route');
  const item = await import('@/app/api/administrations/[id]/route');
  const adminA = await h.prisma.administration.create({ data: { companyId: h.co.A, nameArabic: `إدارة أ ${h.tag}` } });
  const adminB = await h.prisma.administration.create({ data: { companyId: h.co.B, nameArabic: `إدارة ب ${h.tag}` } });

  it('list: 401 / 403; HR of B sees B only; the owner both', async () => {
    await h.as(null);
    expect((await list.GET(h.req('GET', '/api/administrations'))).status).toBe(401);
    await h.as('empB');
    expect((await list.GET(h.req('GET', '/api/administrations'))).status).toBe(403);
    await h.as('hrB');
    const b = ids(await (await list.GET(h.req('GET', '/api/administrations'))).json());
    expect(b).toContain(adminB.id);
    expect(b).not.toContain(adminA.id);
    await h.as('owner');
    expect(ids(await (await list.GET(h.req('GET', '/api/administrations'))).json())).toEqual(expect.arrayContaining([adminA.id, adminB.id]));
  });

  it('detail / update / delete of another company: 404, row unchanged; own company 200; moving to B 403', async () => {
    const p = h.params({ id: adminA.id });
    await h.as('hrB');
    expect((await item.GET(h.req('GET', '/x'), p)).status).toBe(404);
    expect((await item.PUT(h.req('PUT', '/x', { nameArabic: 'مخترق' }), p)).status).toBe(404);
    expect((await item.DELETE(h.req('DELETE', '/x'), p)).status).toBe(404);
    await h.as('hrA');
    expect((await item.GET(h.req('GET', '/x'), p)).status).toBe(200);
    expect((await item.PUT(h.req('PUT', '/x', { companyId: h.co.B }), p)).status).toBe(403);
    expect((await item.PUT(h.req('PUT', '/x', { nameEnglish: 'Admin A' }), p)).status).toBe(200);
    const row = await h.prisma.administration.findUnique({ where: { id: adminA.id } });
    expect(row?.companyId).toBe(h.co.A);
    expect(row?.nameArabic).toBe(`إدارة أ ${h.tag}`);
  });

  it('create: own company 201, another company 403, wrong role 403', async () => {
    await h.as('branchMgrA');
    expect((await list.POST(h.req('POST', '/api/administrations', { companyId: h.co.A, nameArabic: 'x' }))).status).toBe(403);
    await h.as('hrA');
    expect((await list.POST(h.req('POST', '/api/administrations', { companyId: h.co.B, nameArabic: 'x' }))).status).toBe(403);
    const res = await list.POST(h.req('POST', '/api/administrations', { companyId: h.co.A, nameArabic: `إدارة جديدة ${h.tag}` }));
    expect(res.status).toBe(201);
    const { administration } = await res.json();
    expect((await item.DELETE(h.req('DELETE', '/x'), h.params({ id: administration.id }))).status).toBe(200);
  });
});
