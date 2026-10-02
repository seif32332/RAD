// P1-SCOPE (INV-SCOPE-01): /api/attendance-punches, /[id] and /[id]/photo on a real database with real
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

describe.skipIf(process.env.SCOPE_IT !== '1')('attendance-punches routes: company scope (real auth)', { timeout: 60_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // collected but skipped: never touch the database
  const h = await createRouteHarness(state);
  const list = await import('@/app/api/attendance-punches/route');
  const item = await import('@/app/api/attendance-punches/[id]/route');
  const photo = await import('@/app/api/attendance-punches/[id]/photo/route');

  const empA = await h.employee('A');
  const empB = await h.employee('B');
  const punch = (employeeId: string) =>
    h.prisma.attendancePunch.create({ data: { employeeId, workDate: new Date('2026-09-01'), type: 'IN', result: 'FLAGGED', reasons: [] } });
  const pA = await punch(empA.id);
  const pB = await punch(empB.id);

  it('list: 401 / 403, HR of A sees punches of A only (list and counts), the owner both', async () => {
    await h.as(null);
    expect((await list.GET(h.req('GET', '/api/attendance-punches'))).status).toBe(401);
    await h.as('empA');
    expect((await list.GET(h.req('GET', '/api/attendance-punches'))).status).toBe(403);
    await h.as('hrA');
    const body = await (await list.GET(h.req('GET', '/api/attendance-punches?take=200'))).json();
    expect(ids(body.punches)).toContain(pA.id);
    expect(ids(body.punches)).not.toContain(pB.id);
    const ofB = await (await list.GET(h.req('GET', `/api/attendance-punches?employeeId=${empB.id}`))).json();
    expect(ofB.total).toBe(0);
    await h.as('owner');
    const all = await (await list.GET(h.req('GET', '/api/attendance-punches?take=200'))).json();
    expect(ids(all.punches)).toEqual(expect.arrayContaining([pA.id, pB.id]));
    expect(all.pendingReview).toBeGreaterThanOrEqual(2);
  });

  it('photo: another company 404, wrong role 403', async () => {
    await h.as('finA');
    expect((await photo.GET(h.req('GET', '/x'), h.params({ id: pA.id }))).status).toBe(403);
    await h.as('hrB');
    expect((await photo.GET(h.req('GET', '/x'), h.params({ id: pA.id }))).status).toBe(404);
  });

  it('review: another company 404 and untouched; own company once, the second call 409', async () => {
    await h.as('empA');
    expect((await item.PUT(h.req('PUT', '/x', { action: 'MARK_REVIEWED' }), h.params({ id: pA.id }))).status).toBe(403);
    await h.as('hrB');
    expect((await item.PUT(h.req('PUT', '/x', { action: 'MARK_REVIEWED' }), h.params({ id: pA.id }))).status).toBe(404);
    expect((await h.prisma.attendancePunch.findUnique({ where: { id: pA.id } }))?.reviewedAt).toBeNull();
    await h.as('hrA');
    expect((await item.PUT(h.req('PUT', '/x', { action: 'MARK_REVIEWED' }), h.params({ id: pA.id }))).status).toBe(200);
    expect((await item.PUT(h.req('PUT', '/x', { action: 'MARK_REVIEWED' }), h.params({ id: pA.id }))).status).toBe(409);
  });
});
