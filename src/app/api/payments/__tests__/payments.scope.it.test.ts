// P1-SCOPE (INV-SCOPE-01): /api/payments and /api/payments/[id] on a real database with real sessions
// (src/test/route-harness.ts). A payment request follows the company of the record it pays for; a
// free-form request (no linked record) is seen by unrestricted users and its requester only.
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

describe.skipIf(process.env.SCOPE_IT !== '1')('payments routes: company scope (real auth)', { timeout: 60_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // collected but skipped: never touch the database
  const h = await createRouteHarness(state);
  const list = await import('@/app/api/payments/route');
  const item = await import('@/app/api/payments/[id]/route');
  const empA = await h.employee('A');
  const empB = await h.employee('B');
  const payment = (data: Record<string, unknown>) =>
    moneyFixture((tx) => tx.paymentRequest.create({ data: { title: `سداد ${h.tag}`, amount: 100, status: 'PENDING_FINANCE', ...data } }));
  // Approved by the owner (P1-PAY-A: a request with neither a recorded requester nor approver is not paid, BR-PAY-015).
  const linkedA = await payment({ entityType: 'EMPLOYEE', entityId: empA.id, approvedById: h.users.owner.id });
  const linkedB = await payment({ entityType: 'EMPLOYEE', entityId: empB.id });
  const companyB = await payment({ entityType: 'COMPANY', entityId: h.co.B });
  const freeOfFinB = await payment({ requestedById: h.users.finB.id, status: 'PENDING_OWNER' });

  it('GET: 401 / 403, finance of A sees A-linked requests only, not a free-form request of another user; owner all', async () => {
    await h.as(null);
    expect((await list.GET()).status).toBe(401);
    await h.as('empA');
    expect((await list.GET()).status).toBe(403);
    await h.as('finA');
    const a = ids(await (await list.GET()).json());
    expect(a).toContain(linkedA.id);
    expect(a).not.toContain(linkedB.id);
    expect(a).not.toContain(companyB.id);
    expect(a).not.toContain(freeOfFinB.id);
    await h.as('finB');
    expect(ids(await (await list.GET()).json())).toEqual(expect.arrayContaining([linkedB.id, companyB.id, freeOfFinB.id]));
    await h.as('owner');
    expect(ids(await (await list.GET()).json())).toEqual(expect.arrayContaining([linkedA.id, linkedB.id, companyB.id, freeOfFinB.id]));
  });

  it('POST: a free-form request is visible to its requester, not to finance of the other company', async () => {
    await h.as('finA');
    const res = await list.POST(h.req('POST', '/api/payments', { title: `طلب ${h.tag}`, amount: 50 }));
    expect(res.status).toBe(201);
    const { id } = await res.json();
    expect(ids(await (await list.GET()).json())).toContain(id);
    await h.as('finB');
    expect(ids(await (await list.GET()).json())).not.toContain(id);
  });

  it('PUT PAID: another company 404 and untouched; own company once (the same user again replays, another user 409)', async () => {
    const paid = { status: 'PAID', receiptUrl: '/api/files/receipt.pdf' };
    await h.as('govA');
    expect((await item.PUT(h.req('PUT', '/x', paid), h.params({ id: linkedA.id }))).status).toBe(403);
    await h.as('finB');
    expect((await item.PUT(h.req('PUT', '/x', paid), h.params({ id: linkedA.id }))).status).toBe(404);
    expect((await h.prisma.paymentRequest.findUnique({ where: { id: linkedA.id } }))?.status).toBe('PENDING_FINANCE');
    await h.as('finA');
    expect((await item.PUT(h.req('PUT', '/x', paid), h.params({ id: linkedA.id }))).status).toBe(200);
    // Double call by the same user: the operation key replays the first result (LIFECYCLE_MODEL §2.2).
    expect((await item.PUT(h.req('PUT', '/x', paid), h.params({ id: linkedA.id }))).status).toBe(200);
    await h.as('payrollA');
    expect((await item.PUT(h.req('PUT', '/x', paid), h.params({ id: linkedA.id }))).status).toBe(409);
    expect(await h.prisma.auditRecord.count({ where: { entityId: linkedA.id, action: 'finance.paymentRequest.pay' } })).toBe(1);
  });

  it('DELETE: another company 404 (row kept); own request deleted once, then 404', async () => {
    await h.as('finA');
    expect((await item.DELETE(h.req('DELETE', '/x'), h.params({ id: freeOfFinB.id }))).status).toBe(404);
    expect((await item.DELETE(h.req('DELETE', '/x'), h.params({ id: companyB.id }))).status).toBe(404);
    expect(await h.prisma.paymentRequest.count({ where: { id: { in: [freeOfFinB.id, companyB.id] } } })).toBe(2);
    await h.as('finB');
    expect((await item.DELETE(h.req('DELETE', '/x'), h.params({ id: freeOfFinB.id }))).status).toBe(200);
    expect((await item.DELETE(h.req('DELETE', '/x'), h.params({ id: freeOfFinB.id }))).status).toBe(404);
  });
});
