// P1-SCOPE (INV-SCOPE-01): /api/attendance-corrections and /[id]/action on a real database with real
// sessions (src/test/route-harness.ts): HR in its companies, a manager in his team (own company), an
// employee on his own records. Opt-in: SCOPE_IT=1.
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe.skipIf(process.env.SCOPE_IT !== '1')('attendance-corrections routes: company scope (real auth)', { timeout: 60_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // collected but skipped: never touch the database
  const h = await createRouteHarness(state);
  const list = await import('@/app/api/attendance-corrections/route');
  const action = await import('@/app/api/attendance-corrections/[id]/action/route');
  const empA = await h.employee('A');
  const empB = await h.employee('B');
  const correction = (employeeId: string) =>
    h.prisma.attendanceCorrection.create({ data: { employeeId, date: new Date('2026-09-01'), reason: `نسيت البصمة ${h.tag}`, status: 'PENDING' } });
  const cA = await correction(empA.id);
  const cB = await correction(empB.id);

  it('list: 401, HR of A sees A only, the manager of A his team only, an employee his own, the owner all', async () => {
    await h.as(null);
    expect((await list.GET()).status).toBe(401);
    await h.as('hrA');
    const hrA = ids(await (await list.GET()).json());
    expect(hrA).toContain(cA.id);
    expect(hrA).not.toContain(cB.id);
    await h.as('branchMgrA');
    const mgr = ids(await (await list.GET()).json());
    expect(mgr).toContain(cA.id);
    expect(mgr).not.toContain(cB.id);
    await h.as('empB');
    expect(ids(await (await list.GET()).json())).not.toContain(cB.id); // empB is another employee of B
    await h.as('owner');
    expect(ids(await (await list.GET()).json())).toEqual(expect.arrayContaining([cA.id, cB.id]));
  });

  it('create: for an employee of another company 404; own company 201; an employee only for himself', async () => {
    const payload = (employeeId: string) => ({ employeeId, date: '2026-09-02', reason: `طلب تصحيح ${h.tag}` });
    await h.as('hrB');
    expect((await list.POST(h.req('POST', '/x', payload(empA.id)))).status).toBe(404);
    await h.as('branchMgrB');
    expect((await list.POST(h.req('POST', '/x', payload(empA.id)))).status).toBe(404);
    await h.as('empA');
    expect((await list.POST(h.req('POST', '/x', payload(empA.id)))).status).toBe(403);
    await h.as('hrA');
    expect((await list.POST(h.req('POST', '/x', payload(empA.id)))).status).toBe(201);
    expect((await list.POST(h.req('POST', '/x', payload(empA.id)))).status).toBe(409); // duplicate pending request
  });

  it('decide: employee 403, another company 404 (untouched), own company once then refused', async () => {
    const reject = { action: 'REJECT', reason: 'لا يوجد ما يثبت الحضور' };
    await h.as('empA');
    expect((await action.POST(h.req('POST', '/x', reject), h.params({ id: cA.id }))).status).toBe(403);
    await h.as('hrB');
    expect((await action.POST(h.req('POST', '/x', reject), h.params({ id: cA.id }))).status).toBe(404);
    await h.as('branchMgrB');
    expect((await action.POST(h.req('POST', '/x', reject), h.params({ id: cA.id }))).status).toBe(404);
    expect((await h.prisma.attendanceCorrection.findUnique({ where: { id: cA.id } }))?.status).toBe('PENDING');
    await h.as('hrA');
    expect((await action.POST(h.req('POST', '/x', reject), h.params({ id: cA.id }))).status).toBe(200);
    expect((await action.POST(h.req('POST', '/x', reject), h.params({ id: cA.id }))).status).toBe(409);
    expect((await h.prisma.attendanceCorrection.findUnique({ where: { id: cA.id } }))?.status).toBe('REJECTED');
  });
});
