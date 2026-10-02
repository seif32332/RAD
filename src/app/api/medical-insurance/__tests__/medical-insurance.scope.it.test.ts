// P1-SCOPE (INV-SCOPE-01): /api/medical-insurance and /[id] on a real database with real sessions
// (src/test/route-harness.ts). A policy is keyed by its companyId. Opt-in: SCOPE_IT=1.
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe.skipIf(process.env.SCOPE_IT !== '1')('medical-insurance routes: company scope (real auth)', { timeout: 60_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // collected but skipped: never touch the database
  const h = await createRouteHarness(state);
  const list = await import('@/app/api/medical-insurance/route');
  const item = await import('@/app/api/medical-insurance/[id]/route');
  const policy = (co: 'A' | 'B') =>
    h.prisma.medicalInsurance.create({ data: { companyId: h.co[co], insuranceIssuer: 'بوبا', policyNumber: `POL-${h.tag}-${co}`, policyCost: 1000, expiryDate: new Date('2027-01-01') } });
  const pB = await policy('B');
  const body = (companyId: string) => ({ companyId, insuranceIssuer: 'التعاونية', policyNumber: `N-${h.tag}`, policyCost: 500, expiryDate: '2027-06-01' });

  it('list and detail: 401 / 403, another company hidden (404), own company and owner see it', async () => {
    await h.as(null);
    expect((await list.GET(h.req('GET', '/x'))).status).toBe(401);
    await h.as('finA');
    expect((await list.GET(h.req('GET', '/x'))).status).toBe(403);
    await h.as('hrA');
    expect(ids(await (await list.GET(h.req('GET', '/x'))).json())).not.toContain(pB.id);
    expect(await (await list.GET(h.req('GET', `/x?companyId=${h.co.B}`))).json()).toEqual([]);
    expect((await item.GET(h.req('GET', '/x'), h.params({ id: pB.id }))).status).toBe(404);
    await h.as('govB');
    expect(ids(await (await list.GET(h.req('GET', '/x'))).json())).toContain(pB.id);
    await h.as('owner');
    expect(ids(await (await list.GET(h.req('GET', '/x'))).json())).toContain(pB.id);
  });

  it('create: another company 403, own company 201', async () => {
    await h.as('hrA');
    expect((await list.POST(h.req('POST', '/x', body(h.co.B)))).status).toBe(403);
    expect((await list.POST(h.req('POST', '/x', body(h.co.A)))).status).toBe(201);
  });

  it('update / delete: another company 404 and untouched; moving to another company refused; own allowed once', async () => {
    await h.as('hrA');
    expect((await item.PUT(h.req('PUT', '/x', { policyCost: 1 }), h.params({ id: pB.id }))).status).toBe(404);
    expect((await item.DELETE(h.req('DELETE', '/x'), h.params({ id: pB.id }))).status).toBe(404);
    expect((await h.prisma.medicalInsurance.findUnique({ where: { id: pB.id } }))?.policyCost).toBe(1000);
    await h.as('hrB');
    expect((await item.PUT(h.req('PUT', '/x', { companyId: h.co.A }), h.params({ id: pB.id }))).status).toBe(404);
    expect((await item.PUT(h.req('PUT', '/x', { policyCost: 1200 }), h.params({ id: pB.id }))).status).toBe(200);
    expect((await item.DELETE(h.req('DELETE', '/x'), h.params({ id: pB.id }))).status).toBe(200);
    expect((await item.DELETE(h.req('DELETE', '/x'), h.params({ id: pB.id }))).status).toBe(404);
  });
});
