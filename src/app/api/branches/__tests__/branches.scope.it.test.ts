// P1-SCOPE (INV-SCOPE-01): /api/branches and /api/branches/[id] on a real database with real sessions
// (src/test/route-harness.ts). Opt-in: SCOPE_IT=1 with DATABASE_URL on a throwaway database.
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe.skipIf(process.env.SCOPE_IT !== '1')('branches routes: company scope (real auth)', { timeout: 60_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // skipped: build nothing (the harness writes to the database)
  const h = await createRouteHarness(state);
  const list = await import('@/app/api/branches/route');
  const item = await import('@/app/api/branches/[id]/route');

  it('list: 401 / 403, a scoped user sees his companies only, the owner every company', async () => {
    await h.as(null);
    expect((await list.GET(h.req('GET', '/api/branches'))).status).toBe(401);
    await h.as('empA');
    expect((await list.GET(h.req('GET', '/api/branches'))).status).toBe(403);
    await h.as('finB');
    const b = ids(await (await list.GET(h.req('GET', '/api/branches'))).json());
    expect(b).toContain(h.branch.B);
    expect(b).not.toContain(h.branch.A);
    expect(await (await list.GET(h.req('GET', `/api/branches?companyId=${h.co.A}`))).json()).toEqual([]);
    await h.as('owner');
    expect(ids(await (await list.GET(h.req('GET', '/api/branches'))).json())).toEqual(expect.arrayContaining([h.branch.A, h.branch.B]));
  });

  it('detail: another company 404; the branch employees list leaves out employees of another company', async () => {
    const stray = await h.employee('B', { branchId: h.branch.A, departmentId: h.department.A }); // registered on B, works in A's branch
    await h.as('hrB');
    expect((await item.GET(h.req('GET', '/x'), h.params({ id: h.branch.A }))).status).toBe(404);
    await h.as('hrA');
    const res = await item.GET(h.req('GET', '/x'), h.params({ id: h.branch.A }));
    expect(res.status).toBe(200);
    expect(ids((await res.json()).employees)).not.toContain(stray.id);
    await h.as('owner');
    expect(ids((await (await item.GET(h.req('GET', '/x'), h.params({ id: h.branch.A }))).json()).employees)).toContain(stray.id);
  });

  it('create / update / delete: own company allowed, another company 403 (create, move) or 404 (existing row)', async () => {
    await h.as('finA');
    expect((await list.POST(h.req('POST', '/api/branches', { companyId: h.co.A, nameArabic: 'x' }))).status).toBe(403);
    await h.as('hrA');
    expect((await list.POST(h.req('POST', '/api/branches', { companyId: h.co.B, nameArabic: 'x' }))).status).toBe(403);
    const created = await list.POST(h.req('POST', '/api/branches', { companyId: h.co.A, nameArabic: `فرع جديد ${h.tag}` }));
    expect(created.status).toBe(201);
    const { id } = await created.json();
    const p = h.params({ id });
    expect((await item.PUT(h.req('PUT', '/x', { companyId: h.co.B }), p)).status).toBe(403);
    expect((await item.PUT(h.req('PUT', '/x', { nameArabic: `فرع معدل ${h.tag}` }), p)).status).toBe(200);
    await h.as('hrB');
    expect((await item.PUT(h.req('PUT', '/x', { nameArabic: 'مخترق' }), p)).status).toBe(404);
    expect((await item.DELETE(h.req('DELETE', '/x'), p)).status).toBe(404);
    const row = await h.prisma.branch.findUnique({ where: { id } });
    expect(row?.companyId).toBe(h.co.A);
    expect(row?.nameArabic).toBe(`فرع معدل ${h.tag}`);
    await h.as('hrA');
    expect((await item.DELETE(h.req('DELETE', '/x'), p)).status).toBe(200);
  });
});
