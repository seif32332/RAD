// P1-SCOPE (INV-SCOPE-01): /api/departments and /api/departments/[id] on a real database with real
// sessions (src/test/route-harness.ts). Opt-in: SCOPE_IT=1 with DATABASE_URL on a throwaway database.
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe.skipIf(process.env.SCOPE_IT !== '1')('departments routes: company scope (real auth)', { timeout: 60_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // skipped: build nothing (the harness writes to the database)
  const h = await createRouteHarness(state);
  const list = await import('@/app/api/departments/route');
  const item = await import('@/app/api/departments/[id]/route');

  it('list: 401 without a session, 403 for an employee; HR of A sees A only, the owner both', async () => {
    await h.as(null);
    expect((await list.GET(h.req('GET', '/api/departments'))).status).toBe(401);
    await h.as('empA');
    expect((await list.GET(h.req('GET', '/api/departments'))).status).toBe(403);
    await h.as('hrA');
    const a = ids(await (await list.GET(h.req('GET', '/api/departments'))).json());
    expect(a).toContain(h.department.A);
    expect(a).not.toContain(h.department.B);
    // Asking for the other company's branch explicitly returns nothing.
    expect(await (await list.GET(h.req('GET', `/api/departments?branchId=${h.branch.B}`))).json()).toEqual([]);
    await h.as('owner');
    const all = ids(await (await list.GET(h.req('GET', '/api/departments'))).json());
    expect(all).toEqual(expect.arrayContaining([h.department.A, h.department.B]));
  });

  it('detail / update / delete: a department of another company is 404 and stays unchanged', async () => {
    const p = h.params({ id: h.department.A });
    await h.as(null);
    expect((await item.GET(h.req('GET', '/x'), p)).status).toBe(401);
    await h.as('hrB');
    expect((await item.GET(h.req('GET', '/x'), p)).status).toBe(404);
    expect((await item.PUT(h.req('PUT', '/x', { nameArabic: 'مخترق' }), p)).status).toBe(404);
    expect((await item.DELETE(h.req('DELETE', '/x'), p)).status).toBe(404);
    expect((await h.prisma.department.findUnique({ where: { id: h.department.A } }))?.nameArabic).not.toBe('مخترق');
    await h.as('finA');
    expect((await item.PUT(h.req('PUT', '/x', { nameArabic: 'x' }), p)).status).toBe(403);
    await h.as('hrA');
    expect((await item.GET(h.req('GET', '/x'), p)).status).toBe(200);
    expect((await item.PUT(h.req('PUT', '/x', { nameArabic: `قسم أ ${h.tag}` }), p)).status).toBe(200);
    // Moving it under a branch of another company: that branch is "not found".
    expect((await item.PUT(h.req('PUT', '/x', { branchId: h.branch.B }), p)).status).toBe(400);
    expect((await h.prisma.department.findUnique({ where: { id: h.department.A } }))?.branchId).toBe(h.branch.A);
  });

  it('create: HR of A under its branch 201; under a branch of B 400; wrong role 403; delete of its own 200', async () => {
    await h.as('finA');
    expect((await list.POST(h.req('POST', '/api/departments', { branchId: h.branch.A, nameArabic: 'x' }))).status).toBe(403);
    await h.as('hrA');
    expect((await list.POST(h.req('POST', '/api/departments', { branchId: h.branch.B, nameArabic: 'x' }))).status).toBe(400);
    const res = await list.POST(h.req('POST', '/api/departments', { branchId: h.branch.A, nameArabic: `جديد ${h.tag}` }));
    expect(res.status).toBe(201);
    const { department } = await res.json();
    await h.as('hrB');
    expect((await item.DELETE(h.req('DELETE', '/x'), h.params({ id: department.id }))).status).toBe(404);
    await h.as('hrA');
    expect((await item.DELETE(h.req('DELETE', '/x'), h.params({ id: department.id }))).status).toBe(200);
  });
});
