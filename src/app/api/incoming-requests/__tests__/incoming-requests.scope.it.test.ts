// P1-SCOPE (INV-SCOPE-01): /api/incoming-requests (GET, POST) and /archive on a real database with real
// sessions (src/test/route-harness.ts). Every request follows its employee's company.
// Opt-in: SCOPE_IT=1 with DATABASE_URL on a throwaway database.
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';
import { moneyFixture } from '@/test/money-fixtures';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

type Hub = Record<string, Array<{ dbId?: string; id: string }> | unknown>;
const dbIds = (hub: Hub) =>
  ['employeeRequests', 'managerRequests', 'deptManagerRequests', 'ownerRequests'].flatMap((k) =>
    ((hub[k] as Array<{ dbId?: string }>) ?? []).map((r) => r.dbId),
  );

describe.skipIf(process.env.SCOPE_IT !== '1')('incoming-requests routes: company scope (real auth)', { timeout: 60_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // collected but skipped: never touch the database
  const h = await createRouteHarness(state);
  const hub = await import('@/app/api/incoming-requests/route');
  const archive = await import('@/app/api/incoming-requests/archive/route');
  const empA = await h.employee('A');
  const empB = await h.employee('B');
  const leave = (employeeId: string, status: 'PENDING' | 'REJECTED' = 'PENDING') =>
    h.prisma.leave.create({
      data: { employeeId, leaveType: 'ANNUAL', startDate: new Date('2026-11-10'), endDate: new Date('2026-11-11'), totalDays: 2, status, isManagerApproved: true },
    });
  const lA = await leave(empA.id);
  const lB = await leave(empB.id);
  const doneB = await leave(empB.id, 'REJECTED');
  const loanA = await moneyFixture((tx) => tx.loan.create({ data: { employeeId: empA.id, amount: 1000, monthlyInstallment: 100, remainingAmount: 1000, status: 'PENDING' } }));
  const assetA = await h.prisma.assetRequest.create({ data: { requesterId: empA.id, requestedForId: empA.id, assetType: 'LAPTOP', status: 'PENDING_PURCHASING' } });

  it('GET: 401 / 403, HR of A sees the requests of A only, payroll of B no loan of A, the owner all', async () => {
    await h.as(null);
    expect((await hub.GET()).status).toBe(401);
    await h.as('empA');
    expect((await hub.GET()).status).toBe(403);
    await h.as('hrA');
    const a = dbIds(await (await hub.GET()).json());
    expect(a).toEqual(expect.arrayContaining([lA.id, loanA.id]));
    expect(a).not.toContain(lB.id);
    await h.as('payrollB');
    expect(dbIds(await (await hub.GET()).json())).not.toContain(loanA.id);
    await h.as('buyerB');
    expect(dbIds(await (await hub.GET()).json())).not.toContain(assetA.id);
    await h.as('buyerA');
    expect(dbIds(await (await hub.GET()).json())).toContain(assetA.id);
    await h.as('owner');
    expect(dbIds(await (await hub.GET()).json())).toEqual(expect.arrayContaining([lA.id, lB.id, loanA.id]));
  });

  it('archive: HR of A never sees a decided request of B; the owner does', async () => {
    await h.as('empA');
    expect((await archive.GET()).status).toBe(403);
    await h.as('hrA');
    const a = (await (await archive.GET()).json()).archive.map((r: { id: string }) => r.id);
    expect(a).not.toContain(`leave-${doneB.id}`);
    await h.as('owner');
    expect((await (await archive.GET()).json()).archive.map((r: { id: string }) => r.id)).toContain(`leave-${doneB.id}`);
  });

  it('POST: another company 404 and untouched (leave, loan, asset); own company once, the second call refused', async () => {
    const rejectLeave = { actionType: 'REJECT', type: 'LEAVE', dbId: lA.id, reason: 'ضغط عمل' };
    await h.as('hrB');
    expect((await hub.POST(h.req('POST', '/x', rejectLeave))).status).toBe(404);
    await h.as('payrollB');
    expect((await hub.POST(h.req('POST', '/x', { actionType: 'REJECT', type: 'LOAN', dbId: loanA.id, reason: 'لا' }))).status).toBe(404);
    await h.as('buyerB');
    expect((await hub.POST(h.req('POST', '/x', { actionType: 'APPROVE', type: 'ASSET_REQUEST', dbId: assetA.id }))).status).toBe(404);
    expect((await h.prisma.leave.findUnique({ where: { id: lA.id } }))?.status).toBe('PENDING');
    expect((await h.prisma.loan.findUnique({ where: { id: loanA.id } }))?.status).toBe('PENDING');
    expect((await h.prisma.assetRequest.findUnique({ where: { id: assetA.id } }))?.status).toBe('PENDING_PURCHASING');
    await h.as('hrA');
    expect((await hub.POST(h.req('POST', '/x', rejectLeave))).status).toBe(200);
    expect((await hub.POST(h.req('POST', '/x', rejectLeave))).status).toBe(409);
    expect((await h.prisma.leave.findUnique({ where: { id: lA.id } }))?.status).toBe('REJECTED');
  });
});
