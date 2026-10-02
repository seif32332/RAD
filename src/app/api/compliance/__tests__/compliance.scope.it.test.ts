// P1-SCOPE part C (INV-SCOPE-01, ARCH-016.test): compliance violations on a real database with REAL
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

type Payload = { violations: { id: string }[]; metadata: { companies: { id: string }[]; branches: { id: string }[] } };

describe.skipIf(process.env.SCOPE_IT !== '1')('compliance: company scope (real auth)', { timeout: 120_000 }, async () => {
  // vitest runs the body of a skipped suite while collecting: never touch a database unless opted in.
  if (process.env.SCOPE_IT !== '1') return;
  const h = await createRouteHarness(state);
  const route = await import('@/app/api/compliance/route');

  const viol = { A: '', B: '' };
  for (const k of ['A', 'B'] as const) {
    viol[k] = (await h.prisma.complianceViolation.create({ data: { companyId: h.co[k], authority: 'بلدي', amount: 500 } })).id;
  }
  const get = async () => (await (await route.GET()).json()) as Payload;
  const create = (targetType: string, targetId: string) => route.POST(h.req('POST', '/x', { targetType, targetId, authority: 'x', amount: 10 }));

  it('deny: no session 401, employee 403, a role that may read but not write 403', async () => {
    await h.as(null);
    expect((await route.GET()).status).toBe(401);
    await h.as('empA');
    expect((await route.GET()).status).toBe(403);
    await h.as('legalA');
    expect((await route.GET()).status).toBe(200);
    expect((await create('COMPANY', h.co.A)).status).toBe(403);
  });

  it('list: hrA gets the violations, companies and branches of company A only', async () => {
    await h.as('hrA');
    const d = await get();
    expect(d.violations.map((v) => v.id)).toContain(viol.A);
    expect(d.violations.map((v) => v.id)).not.toContain(viol.B);
    expect(d.metadata.companies.map((c) => c.id)).toEqual([h.co.A]);
    expect(d.metadata.branches.map((b) => b.id)).toEqual([h.branch.A]);
    await h.as('owner');
    expect((await get()).violations.map((v) => v.id)).toEqual(expect.arrayContaining([viol.A, viol.B]));
  });

  it('other company: govB cannot settle a violation of A nor register one against A or its branch (404)', async () => {
    await h.as('govB');
    expect((await route.POST(h.req('POST', '/x', { actionType: 'UPDATE_STATUS', payload: { id: viol.A, status: 'PAID' } }))).status).toBe(404);
    expect((await create('COMPANY', h.co.A)).status).toBe(404);
    expect((await create('BRANCH', h.branch.A)).status).toBe(404);
    expect(await h.prisma.complianceViolation.findUnique({ where: { id: viol.A } })).toMatchObject({ status: 'PENDING_PAYMENT' });
  });

  it('allow: govA registers a branch violation (carries the branch company) and settles it once', async () => {
    await h.as('govA');
    const res = await create('BRANCH', h.branch.A);
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: { id: string; companyId: string; branchId: string } };
    expect(data).toMatchObject({ companyId: h.co.A, branchId: h.branch.A });
    const pay = () => route.POST(h.req('POST', '/x', { actionType: 'UPDATE_STATUS', payload: { id: data.id, status: 'PAID' } }));
    expect((await pay()).status).toBe(200);
    expect((await pay()).status).toBe(409);
    await h.as('hrB');
    expect((await get()).violations.map((v) => v.id)).not.toContain(data.id);
  });
});
