// P1-SCOPE (INV-SCOPE-01): /api/manager-portal on a real database with real sessions
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

describe.skipIf(process.env.SCOPE_IT !== '1')('manager portal route: company scope (real auth)', { timeout: 60_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // skipped: build nothing (the harness writes to the database)
  const h = await createRouteHarness(state);
  const route = await import('@/app/api/manager-portal/route');
  const a = await h.employee('A');
  const b = await h.employee('B');
  const stray = await h.employee('B', { branchId: h.branch.A, departmentId: h.department.A });
  const empA = await h.prisma.employee.findFirstOrThrow({ where: { userId: h.users.empA.id } });
  const day = new Date('2026-11-01');
  const leaveA = await h.prisma.leave.create({ data: { employeeId: a.id, startDate: day, endDate: day, totalDays: 1, status: 'APPROVED' } });
  const otB = await h.prisma.overtimeRequest.create({ data: { employeeId: b.id, date: day, hours: 2, status: 'PENDING' } });
  const get = (action: string) => route.GET(h.req('GET', `/api/manager-portal?action=${action}`));
  const post = (body: Record<string, unknown>) => route.POST(h.req('POST', '/api/manager-portal', body));
  const overtime = (employeeId: string) => post({ actionType: 'ASSIGN_OVERTIME', employeeId, date: '2026-11-02', hours: 2 });

  it('GET: 401 / 403; logistics, HR and managers of A never list or see the history of B', async () => {
    await h.as(null);
    expect((await get('get_employees')).status).toBe(401);
    await h.as('empA');
    expect((await get('get_employees')).status).toBe(403);
    for (const who of ['buyerA', 'hrA', 'branchMgrA'] as const) {
      await h.as(who);
      const emps = ids(await (await get('get_employees')).json());
      expect(emps).toContain(a.id);
      expect(emps).not.toContain(b.id);
      expect(emps).not.toContain(stray.id);
    }
    await h.as('hrA');
    expect(JSON.stringify(await (await get('get_history')).json())).not.toContain(otB.id);
    await h.as('hrB');
    expect(ids(await (await get('get_leaves')).json())).not.toContain(leaveA.id);
    expect(JSON.stringify(await (await get('get_history')).json())).toContain(otB.id);
  });

  it('POST: requests for an employee of another company are 404 and write nothing; own team allowed', async () => {
    for (const who of ['hrB', 'branchMgrB'] as const) {
      await h.as(who);
      expect((await overtime(a.id)).status).toBe(404);
    }
    await h.as('branchMgrA');
    expect((await overtime(stray.id)).status).toBe(404);
    expect(await h.prisma.overtimeRequest.count({ where: { employeeId: { in: [a.id, stray.id] } } })).toBe(0);
    expect((await overtime(a.id)).status).toBe(200);
    await h.as('hrB');
    expect((await post({ actionType: 'RETURN_FROM_LEAVE', leaveId: leaveA.id, actualReturnDate: '2026-11-02' })).status).toBe(404);
    expect((await h.prisma.leave.findUnique({ where: { id: leaveA.id } }))?.actualReturnDate).toBeNull();
  });

  it('asset and onboarding requests: another company refused; an employee only for himself', async () => {
    const asset = (employeeId: string) => post({ actionType: 'REQUEST_ASSET', employeeId, assetType: 'LAPTOP' });
    await h.as('buyerB');
    expect((await asset(a.id)).status).toBe(404);
    await h.as('empA');
    expect((await asset(a.id)).status).toBe(403);
    expect((await asset(empA.id)).status).toBe(200);
    await h.as('branchMgrA');
    const onboarding = (branchId: string) =>
      post({ actionType: 'SUBMIT_ONBOARDING', fullNameArabic: 'مرشح', iqamaOrIdNumber: `ON${h.tag}${h.next()}`, mobileNumber: '0550000000', branchId });
    expect((await onboarding(h.branch.B)).status).toBe(403);
    expect((await onboarding(h.branch.A)).status).toBe(200);
  });
});
