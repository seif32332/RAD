// P1-SCOPE (INV-SCOPE-01): /api/leaves, /balance, /preview and /[id]/action on a real database with
// real sessions (src/test/route-harness.ts): HR / payroll in their companies, a manager in his team
// (own company), an employee on his own leaves. Opt-in: SCOPE_IT=1.
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe.skipIf(process.env.SCOPE_IT !== '1')('leaves routes: company scope (real auth)', { timeout: 60_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // collected but skipped: never touch the database
  const h = await createRouteHarness(state);
  const list = await import('@/app/api/leaves/route');
  const balance = await import('@/app/api/leaves/balance/route');
  const preview = await import('@/app/api/leaves/preview/route');
  const action = await import('@/app/api/leaves/[id]/action/route');
  const empA = await h.employee('A');
  const empB = await h.employee('B');
  const leave = (employeeId: string) =>
    h.prisma.leave.create({
      data: { employeeId, leaveType: 'ANNUAL', startDate: new Date('2026-11-01'), endDate: new Date('2026-11-03'), totalDays: 3, status: 'PENDING' },
    });
  const lA = await leave(empA.id);
  const lB = await leave(empB.id);

  it('list: 401, HR of A sees A only, payroll of B sees B only, the manager of A his team, the owner all', async () => {
    await h.as(null);
    expect((await list.GET(h.req('GET', '/api/leaves'))).status).toBe(401);
    await h.as('hrA');
    const hrA = ids(await (await list.GET(h.req('GET', '/api/leaves'))).json());
    expect(hrA).toContain(lA.id);
    expect(hrA).not.toContain(lB.id);
    expect(await (await list.GET(h.req('GET', `/api/leaves?employeeId=${empB.id}`))).json()).toEqual([]);
    await h.as('payrollB');
    const pB = ids(await (await list.GET(h.req('GET', '/api/leaves'))).json());
    expect(pB).toContain(lB.id);
    expect(pB).not.toContain(lA.id);
    await h.as('branchMgrA');
    const mgr = ids(await (await list.GET(h.req('GET', '/api/leaves'))).json());
    expect(mgr).toContain(lA.id);
    expect(mgr).not.toContain(lB.id);
    await h.as('owner');
    expect(ids(await (await list.GET(h.req('GET', '/api/leaves'))).json())).toEqual(expect.arrayContaining([lA.id, lB.id]));
  });

  it('create: HR for an employee of another company 404, an employee for someone else 403, own company 201 then 409', async () => {
    const fresh = await h.employee('A'); // no open leave yet
    const body = (employeeId: string) => ({ employeeId, leaveType: 'ANNUAL', startDate: '2026-12-06', endDate: '2026-12-07' });
    await h.as('hrB');
    expect((await list.POST(h.req('POST', '/api/leaves', body(fresh.id)))).status).toBe(404);
    await h.as('empB');
    expect((await list.POST(h.req('POST', '/api/leaves', body(fresh.id)))).status).toBe(403);
    expect(await h.prisma.leave.count({ where: { employeeId: fresh.id } })).toBe(0);
    await h.as('hrA');
    expect((await list.POST(h.req('POST', '/api/leaves', body(fresh.id)))).status).toBe(201);
    expect((await list.POST(h.req('POST', '/api/leaves', body(fresh.id)))).status).toBe(409);
    expect(await h.prisma.leave.count({ where: { employeeId: fresh.id } })).toBe(1);
  });

  it('balance and preview: another company 404 (HR) / 403 (manager); own company 200', async () => {
    await h.as('hrB');
    expect((await balance.GET(h.req('GET', `/api/leaves/balance?employeeId=${empA.id}`))).status).toBe(404);
    expect((await preview.GET(h.req('GET', `/api/leaves/preview?employeeId=${empA.id}&startDate=2026-12-20&endDate=2026-12-21`))).status).toBe(404);
    await h.as('branchMgrB');
    expect((await balance.GET(h.req('GET', `/api/leaves/balance?employeeId=${empA.id}`))).status).toBe(403);
    await h.as('hrA');
    expect((await balance.GET(h.req('GET', `/api/leaves/balance?employeeId=${empA.id}`))).status).toBe(200);
    expect((await preview.GET(h.req('GET', `/api/leaves/preview?employeeId=${empA.id}&startDate=2026-12-20&endDate=2026-12-21`))).status).toBe(200);
  });

  it('action: another company 404 (HR, manager, employee) and untouched; own company once, then refused', async () => {
    const reject = { action: 'REJECT', reason: 'ضغط عمل في الفترة' };
    for (const who of ['hrB', 'branchMgrB', 'empB'] as const) {
      await h.as(who);
      expect((await action.POST(h.req('POST', '/x', reject), h.params({ id: lA.id }))).status).toBe(404);
    }
    expect((await h.prisma.leave.findUnique({ where: { id: lA.id } }))?.status).toBe('PENDING');
    await h.as('hrA');
    expect((await action.POST(h.req('POST', '/x', reject), h.params({ id: lA.id }))).status).toBe(200);
    expect((await action.POST(h.req('POST', '/x', reject), h.params({ id: lA.id }))).status).toBe(409);
    expect((await h.prisma.leave.findUnique({ where: { id: lA.id } }))?.status).toBe('REJECTED');
  });
});
