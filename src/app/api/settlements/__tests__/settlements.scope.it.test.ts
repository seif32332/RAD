// P1-SCOPE (INV-SCOPE-01): /api/settlements (GET, POST, PUT) and /[id]/muqeem on a real database with
// real sessions (src/test/route-harness.ts). A settlement follows its employee's company.
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

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe.skipIf(process.env.SCOPE_IT !== '1')('settlements routes: company scope (real auth)', { timeout: 60_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // collected but skipped: never touch the database
  const h = await createRouteHarness(state);
  const route = await import('@/app/api/settlements/route');
  const muqeem = await import('@/app/api/settlements/[id]/muqeem/route');
  const empA = await h.employee('A');
  const empB = await h.employee('B');
  const settle = (employeeId: string) => moneyFixture((tx) => tx.settlement.create({ data: { employeeId, type: 'LEAVE_SETTLEMENT', status: 'PENDING_APPROVAL' } }));
  const sA = await settle(empA.id);
  const sB = await settle(empB.id);

  it('GET: 401 / 403, HR of A sees A only, finance of B sees B only, the owner both', async () => {
    await h.as(null);
    expect((await route.GET()).status).toBe(401);
    await h.as('empA');
    expect((await route.GET()).status).toBe(403);
    await h.as('hrA');
    const a = ids(await (await route.GET()).json());
    expect(a).toContain(sA.id);
    expect(a).not.toContain(sB.id);
    await h.as('finB');
    const b = ids(await (await route.GET()).json());
    expect(b).toContain(sB.id);
    expect(b).not.toContain(sA.id);
    await h.as('owner');
    expect(ids(await (await route.GET()).json())).toEqual(expect.arrayContaining([sA.id, sB.id]));
  });

  it('POST: finance 403, HR of another company 404 (preview and save), own company once then 409', async () => {
    const fresh = await h.employee('A');
    const body = { employeeId: fresh.id, type: 'LEAVE_SETTLEMENT', salaryBasis: 'basic' };
    await h.as('finA');
    expect((await route.POST(h.req('POST', '/x', body))).status).toBe(403);
    await h.as('hrB');
    expect((await route.POST(h.req('POST', '/x', { ...body, preview: true }))).status).toBe(404);
    expect((await route.POST(h.req('POST', '/x', body))).status).toBe(404);
    expect(await h.prisma.settlement.count({ where: { employeeId: fresh.id } })).toBe(0);
    await h.as('hrA');
    expect((await route.POST(h.req('POST', '/x', { ...body, preview: true }))).status).toBe(200);
    expect((await route.POST(h.req('POST', '/x', body))).status).toBe(201);
    expect((await route.POST(h.req('POST', '/x', body))).status).toBe(409);
    expect(await h.prisma.settlement.count({ where: { employeeId: fresh.id } })).toBe(1);
    // BL-PAY-027: the leave days paid are stored with the settlement (payroll excludes exactly them).
    const saved = await h.prisma.settlement.findFirstOrThrow({ where: { employeeId: fresh.id } });
    expect(saved.leavePaidDays).not.toBeNull();
    expect(saved.leavePaidDays).toBeGreaterThan(0);
    expect((saved.leaveCompensation ?? 0) / (saved.leavePaidDays ?? 1)).toBeCloseTo(6000 / 30, 0); // basic 6000: 200 a day
  });

  it('PUT: HR 403, finance of another company 404 (untouched), own company allowed; a decision once, then 409', async () => {
    await h.as('hrA');
    expect((await route.PUT(h.req('PUT', '/x', { id: sA.id, transferReceiptUrl: '/api/files/r.pdf' }))).status).toBe(403);
    await h.as('finB');
    expect((await route.PUT(h.req('PUT', '/x', { id: sA.id, transferReceiptUrl: '/api/files/r.pdf' }))).status).toBe(404);
    expect((await h.prisma.settlement.findUnique({ where: { id: sA.id } }))?.transferReceiptUrl ?? null).toBeNull();
    await h.as('finA');
    expect((await route.PUT(h.req('PUT', '/x', { id: sA.id, transferReceiptUrl: '/api/files/r.pdf' }))).status).toBe(200);
    await h.as('owner');
    expect((await route.PUT(h.req('PUT', '/x', { id: sA.id, status: 'REJECTED', ownerNotes: 'مرفوضة' }))).status).toBe(200);
    expect((await route.PUT(h.req('PUT', '/x', { id: sA.id, status: 'REJECTED', ownerNotes: 'مرفوضة' }))).status).toBe(409);
  });

  it('muqeem: employee 403, another company 404 (read and operate), own company reads', async () => {
    await h.as('empA');
    expect((await muqeem.GET(h.req('GET', '/x'), h.params({ id: sA.id }))).status).toBe(403);
    await h.as('hrB');
    expect((await muqeem.GET(h.req('GET', '/x'), h.params({ id: sA.id }))).status).toBe(404);
    await h.as('govB');
    expect((await muqeem.POST(h.req('POST', '/x', { action: 'SYNC_VISA_RECORD' }), h.params({ id: sA.id }))).status).toBe(404);
    await h.as('hrA');
    expect((await muqeem.GET(h.req('GET', '/x'), h.params({ id: sA.id }))).status).toBe(200);
    await h.as('govA');
    expect((await muqeem.POST(h.req('POST', '/x', { action: 'SYNC_VISA_RECORD' }), h.params({ id: sA.id }))).status).toBe(409);
  });
});
