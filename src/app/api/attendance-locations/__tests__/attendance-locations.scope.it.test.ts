// P1-SCOPE (INV-SCOPE-01): /api/attendance-locations and /[id] on a real database with real sessions
// (src/test/route-harness.ts). A location follows its branch's company. Opt-in: SCOPE_IT=1.
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe.skipIf(process.env.SCOPE_IT !== '1')('attendance-locations routes: company scope (real auth)', { timeout: 60_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // collected but skipped: never touch the database
  const h = await createRouteHarness(state);
  const list = await import('@/app/api/attendance-locations/route');
  const item = await import('@/app/api/attendance-locations/[id]/route');
  const locB = await h.prisma.attendanceLocation.create({ data: { branchId: h.branch.B, name: 'B', latitude: 24.7, longitude: 46.7, radiusM: 150 } });
  const body = (branchId: string) => ({ branchId, name: `موقع ${h.tag}`, latitude: 24.71, longitude: 46.67, radiusM: 200 });

  it('list: 401 / 403, a branch of another company lists nothing, the owner sees it', async () => {
    await h.as(null);
    expect((await list.GET(h.req('GET', `/api/attendance-locations?branchId=${h.branch.B}`))).status).toBe(401);
    await h.as('empA');
    expect((await list.GET(h.req('GET', `/api/attendance-locations?branchId=${h.branch.B}`))).status).toBe(403);
    await h.as('finA');
    expect((await (await list.GET(h.req('GET', `/api/attendance-locations?branchId=${h.branch.B}`))).json()).locations).toEqual([]);
    await h.as('finB');
    expect(ids((await (await list.GET(h.req('GET', `/api/attendance-locations?branchId=${h.branch.B}`))).json()).locations)).toContain(locB.id);
    await h.as('owner');
    expect(ids((await (await list.GET(h.req('GET', `/api/attendance-locations?branchId=${h.branch.B}`))).json()).locations)).toContain(locB.id);
  });

  it('create: wrong role 403, a branch of another company 404, own branch 201', async () => {
    await h.as('finA');
    expect((await list.POST(h.req('POST', '/api/attendance-locations', body(h.branch.A)))).status).toBe(403);
    await h.as('hrA');
    expect((await list.POST(h.req('POST', '/api/attendance-locations', body(h.branch.B)))).status).toBe(404);
    expect((await list.POST(h.req('POST', '/api/attendance-locations', body(h.branch.A)))).status).toBe(201);
  });

  it('update / delete: another company 404 and untouched; own company allowed', async () => {
    await h.as('hrA');
    expect((await item.PUT(h.req('PUT', '/x', { radiusM: 300 }), h.params({ id: locB.id }))).status).toBe(404);
    expect((await item.DELETE(h.req('DELETE', '/x'), h.params({ id: locB.id }))).status).toBe(404);
    expect((await h.prisma.attendanceLocation.findUnique({ where: { id: locB.id } }))?.radiusM).toBe(150);
    await h.as('hrB');
    expect((await item.PUT(h.req('PUT', '/x', { radiusM: 300 }), h.params({ id: locB.id }))).status).toBe(200);
    expect((await item.DELETE(h.req('DELETE', '/x'), h.params({ id: locB.id }))).status).toBe(200);
    expect((await item.DELETE(h.req('DELETE', '/x'), h.params({ id: locB.id }))).status).toBe(404);
  });
});
