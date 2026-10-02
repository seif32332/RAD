// P1-SCOPE (INV-SCOPE-01): /api/transfers on a real database with real sessions
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

describe.skipIf(process.env.SCOPE_IT !== '1')('transfers route: company scope (real auth)', { timeout: 60_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // skipped: build nothing (the harness writes to the database)
  const h = await createRouteHarness(state);
  const route = await import('@/app/api/transfers/route');
  const a = await h.employee('A');
  const b = await h.employee('B');
  const stray = await h.employee('B', { branchId: h.branch.A, departmentId: h.department.A });
  const branchA2 = await h.prisma.branch.create({ data: { companyId: h.co.A, nameArabic: `فرع أ2 ${h.tag}` } });
  const branchB2 = await h.prisma.branch.create({ data: { companyId: h.co.B, nameArabic: `فرع ب2 ${h.tag}` } });
  const tA = await h.prisma.transferRequest.create({ data: { employeeId: a.id, fromBranchId: h.branch.A, toBranchId: branchA2.id } });
  const tB = await h.prisma.transferRequest.create({ data: { employeeId: b.id, fromBranchId: h.branch.B, toBranchId: branchB2.id } });

  it('GET: 401 / 403; HR and managers see their company only (transfers, employees, branches)', async () => {
    await h.as(null);
    expect((await route.GET()).status).toBe(401);
    await h.as('empA');
    expect((await route.GET()).status).toBe(403);
    for (const who of ['hrA', 'branchMgrA'] as const) {
      await h.as(who);
      const body = await (await route.GET()).json();
      expect(ids(body.transfers)).toContain(tA.id);
      expect(ids(body.transfers)).not.toContain(tB.id);
      expect(ids(body.metadata.employees)).not.toContain(b.id);
      expect(ids(body.metadata.employees)).not.toContain(stray.id);
      expect(ids(body.metadata.branches)).not.toContain(h.branch.B);
    }
    await h.as('branchMgrB');
    expect(ids((await (await route.GET()).json()).transfers)).not.toContain(tA.id);
    await h.as('owner');
    expect(ids((await (await route.GET()).json()).transfers)).toEqual(expect.arrayContaining([tA.id, tB.id]));
  });

  it('decide: HR of B cannot approve a transfer of A (404, unchanged); a manager 403; HR of A rejects it', async () => {
    const decide = (status: string) => route.POST(h.req('POST', '/api/transfers', { actionType: 'UPDATE_STATUS', payload: { id: tA.id, status } }));
    await h.as('branchMgrA');
    expect((await decide('APPROVED')).status).toBe(403);
    await h.as('hrB');
    expect((await decide('APPROVED')).status).toBe(404);
    expect((await h.prisma.transferRequest.findUnique({ where: { id: tA.id } }))?.status).toBe('PENDING');
    await h.as('hrA');
    expect((await decide('REJECTED')).status).toBe(200);
  });

  it('create: another company employee 404, a branch of another company 400, a manager for his team 201', async () => {
    const create = (employeeId: string, toBranchId: string) => route.POST(h.req('POST', '/api/transfers', { employeeId, toBranchId }));
    await h.as('hrA');
    expect((await create(b.id, branchA2.id)).status).toBe(404);
    expect((await create(a.id, branchB2.id)).status).toBe(400);
    await h.as('branchMgrA');
    expect((await create(stray.id, branchA2.id)).status).toBe(404);
    const res = await create(a.id, branchA2.id);
    expect(res.status).toBe(201);
    expect(await h.prisma.transferRequest.count({ where: { employeeId: b.id } })).toBe(1);
  });
});
