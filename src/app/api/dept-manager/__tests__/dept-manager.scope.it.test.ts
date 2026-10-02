// P1-SCOPE (INV-SCOPE-01): /api/dept-manager on a real database with real sessions
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

describe.skipIf(process.env.SCOPE_IT !== '1')('dept-manager route: company scope (real auth)', { timeout: 60_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // skipped: build nothing (the harness writes to the database)
  const h = await createRouteHarness(state);
  const route = await import('@/app/api/dept-manager/route');
  const a = await h.employee('A');
  const stray = await h.employee('B', { branchId: h.branch.A, departmentId: h.department.A });
  const day = new Date('2026-12-01');
  const leave = await h.prisma.leave.create({ data: { employeeId: a.id, startDate: day, endDate: day, totalDays: 1, status: 'PENDING' } });
  const correction = await h.prisma.attendanceCorrection.create({ data: { employeeId: a.id, date: day, reason: 'نسيت البصمة', status: 'PENDING' } });
  const get = (q = '') => route.GET(h.req('GET', `/api/dept-manager${q}`));
  const post = (body: Record<string, unknown>) => route.POST(h.req('POST', '/api/dept-manager', body));

  it('GET: 401 / 403; each manager and HR lists departments of his company; a department of another company is 404', async () => {
    await h.as(null);
    expect((await get()).status).toBe(401);
    await h.as('empA');
    expect((await get()).status).toBe(403);
    for (const who of ['hrA', 'deptMgrA', 'branchMgrA'] as const) {
      await h.as(who);
      const deps = ids((await (await get()).json()).departments);
      expect(deps).toContain(h.department.A);
      expect(deps).not.toContain(h.department.B);
    }
    for (const who of ['hrB', 'deptMgrB'] as const) {
      await h.as(who);
      expect(ids((await (await get()).json()).departments)).not.toContain(h.department.A);
      expect((await get(`?departmentId=${h.department.A}`)).status).toBe(404);
    }
    await h.as('deptMgrA');
    const detail = await (await get(`?departmentId=${h.department.A}`)).json();
    expect(ids(detail.department.employees)).toContain(a.id);
    expect(ids(detail.department.employees)).not.toContain(stray.id); // registered on company B
    expect(ids(detail.corrections)).toContain(correction.id);
  });

  it('POST: a manager or HR of another company cannot decide (404, unchanged); the department manager can', async () => {
    for (const who of ['deptMgrB', 'hrB'] as const) {
      await h.as(who);
      expect((await post({ action: 'REJECT_LEAVE', leaveId: leave.id, reason: 'لا' })).status).toBe(404);
      expect((await post({ action: 'REJECT_CORRECTION', correctionId: correction.id, reason: 'لا' })).status).toBe(404);
    }
    expect((await h.prisma.leave.findUnique({ where: { id: leave.id } }))?.status).toBe('PENDING');
    expect((await h.prisma.attendanceCorrection.findUnique({ where: { id: correction.id } }))?.status).toBe('PENDING');
    await h.as('deptMgrA');
    expect((await post({ action: 'REJECT_LEAVE', leaveId: leave.id, reason: 'ضغط العمل' })).status).toBe(200);
    expect((await post({ action: 'REJECT_CORRECTION', correctionId: correction.id, reason: 'لا يوجد دليل' })).status).toBe(200);
  });
});
