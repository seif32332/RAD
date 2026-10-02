// P1-SCOPE part C (INV-SCOPE-01, ARCH-016.test): the visa routes on a real database with REAL
// authentication (src/test/route-harness.ts): allow, deny and other company for list and writes.
// Opt-in: SCOPE_IT=1 with DATABASE_URL pointing at a THROWAWAY database.
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

const ids = (rows: unknown) => (rows as { id: string }[]).map((r) => r.id);

describe.skipIf(process.env.SCOPE_IT !== '1')('visa routes: company scope (real auth)', { timeout: 120_000 }, async () => {
  // vitest runs the body of a skipped suite while collecting: never touch a database unless opted in.
  if (process.env.SCOPE_IT !== '1') return;
  const h = await createRouteHarness(state);
  const visas = await import('@/app/api/visas/route');
  const action = await import('@/app/api/visas/action/route');
  const muqeem = await import('@/app/api/visas/muqeem/route');

  const visa = { A: '', B: '' };
  for (const k of ['A', 'B'] as const) {
    const e = await h.employee(k, { nationality: 'EG' });
    visa[k] = (await h.prisma.visa.create({ data: { employeeId: e.id, visaType: 'خروج وعودة' } })).id;
  }
  const ticket = { airline: 'SV', bookingRef: 'REF1' };

  it('deny: no session 401, employee and legal roles 403', async () => {
    await h.as(null);
    expect((await visas.GET()).status).toBe(401);
    await h.as('empA');
    expect((await visas.GET()).status).toBe(403);
    await h.as('legalA');
    expect((await action.POST(h.req('POST', '/x', { visaId: visa.A, action: 'BOOK_TICKET', ...ticket }))).status).toBe(403);
    await h.as('hrA'); // HR_MANAGER is in ROLE_GROUPS.GOV: allowed to operate (SYNC never calls Muqeem)
    expect((await muqeem.POST(h.req('POST', '/x', { action: 'SYNC', visaId: visa.A }))).status).toBe(200);
    await h.as('buyerA');
    expect((await muqeem.POST(h.req('POST', '/x', { action: 'SYNC', visaId: visa.A }))).status).toBe(403);
  });

  it('list: govA and hrA see company A only; the owner sees both', async () => {
    for (const who of ['govA', 'hrA'] as const) {
      await h.as(who);
      const list = ids(await (await visas.GET()).json());
      expect(list, who).toContain(visa.A);
      expect(list, who).not.toContain(visa.B);
    }
    await h.as('owner');
    expect(ids(await (await visas.GET()).json())).toEqual(expect.arrayContaining([visa.A, visa.B]));
  });

  it('other company: govB cannot book, pay, issue or sync a visa of company A (404)', async () => {
    await h.as('govB');
    expect((await action.POST(h.req('POST', '/x', { visaId: visa.A, action: 'BOOK_TICKET', ...ticket }))).status).toBe(404);
    expect((await action.POST(h.req('POST', '/x', { visaId: visa.A, newStatus: 'PAID' }))).status).toBe(404);
    expect((await muqeem.POST(h.req('POST', '/x', { action: 'SYNC', visaId: visa.A }))).status).toBe(404);
    expect((await muqeem.POST(h.req('POST', '/x', { action: 'CANCEL', visaId: visa.A, confirm: true }))).status).toBe(404);
    expect(await h.prisma.visa.findUnique({ where: { id: visa.A } })).toMatchObject({ status: 'PENDING_PAYMENT', ticketStatus: null });
  });

  it('allow: govA books the ticket and records the payment of a visa of company A', async () => {
    await h.as('govA');
    expect((await action.POST(h.req('POST', '/x', { visaId: visa.A, action: 'BOOK_TICKET', ...ticket }))).status).toBe(200);
    expect((await action.POST(h.req('POST', '/x', { visaId: visa.A, newStatus: 'PAID' }))).status).toBe(200);
    // Replay of the same transition: 409, not a second write.
    expect((await action.POST(h.req('POST', '/x', { visaId: visa.A, newStatus: 'PAID' }))).status).toBe(409);
    expect(await h.prisma.visa.findUnique({ where: { id: visa.A } })).toMatchObject({ status: 'PAID', ticketStatus: 'BOOKED' });
  });
});
