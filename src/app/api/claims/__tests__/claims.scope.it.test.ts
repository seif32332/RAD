// P1-SCOPE (INV-SCOPE-01): /api/claims and /api/claims/[id] on a real database with real sessions
// (src/test/route-harness.ts). A claim follows its vehicle's legal company. Opt-in: SCOPE_IT=1.
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe.skipIf(process.env.SCOPE_IT !== '1')('claims routes: company scope (real auth)', { timeout: 60_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // collected but skipped: never touch the database
  const h = await createRouteHarness(state);
  const list = await import('@/app/api/claims/route');
  const item = await import('@/app/api/claims/[id]/route');
  const vehicle = (co: 'A' | 'B') =>
    h.prisma.vehicle.create({
      data: { category: 'خصوصي', brand: 'كيا', modelYear: '2024', color: 'أبيض', sequenceNumber: `S${h.tag}${co}`, plateNumber: `P${h.tag}${co}`, legalCompanyId: h.co[co] },
    });
  const vA = await vehicle('A');
  const vB = await vehicle('B');
  const cB = await h.prisma.accidentClaim.create({ data: { vehicleId: vB.id, claimAmount: 1000 } });

  it('list and detail: 401 / 403, another company hidden (404), own company and owner see it', async () => {
    await h.as(null);
    expect((await list.GET()).status).toBe(401);
    await h.as('empA');
    expect((await list.GET()).status).toBe(403);
    await h.as('hrA');
    expect(ids(await (await list.GET()).json())).not.toContain(cB.id);
    expect((await item.GET(h.req('GET', '/x'), h.params({ id: cB.id }))).status).toBe(404);
    await h.as('hrB');
    expect(ids(await (await list.GET()).json())).toContain(cB.id);
    expect((await item.GET(h.req('GET', '/x'), h.params({ id: cB.id }))).status).toBe(200);
    await h.as('owner');
    expect(ids(await (await list.GET()).json())).toContain(cB.id);
  });

  it('create: finance 403, a vehicle of another company 400, own vehicle 201', async () => {
    await h.as('finA');
    expect((await list.POST(h.req('POST', '/x', { vehicleId: vA.id }))).status).toBe(403);
    await h.as('buyerA');
    expect((await list.POST(h.req('POST', '/x', { vehicleId: vB.id }))).status).toBe(400);
    expect((await list.POST(h.req('POST', '/x', { vehicleId: vA.id }))).status).toBe(201);
  });

  it('update / delete: another company 404 and untouched; moving a claim to another company refused; own allowed', async () => {
    await h.as('buyerA');
    expect((await item.PUT(h.req('PUT', '/x', { claimAmount: 1 }), h.params({ id: cB.id }))).status).toBe(404);
    expect((await item.DELETE(h.req('DELETE', '/x'), h.params({ id: cB.id }))).status).toBe(404);
    expect((await h.prisma.accidentClaim.findUnique({ where: { id: cB.id } }))?.claimAmount).toBe(1000);
    await h.as('buyerB');
    expect((await item.PUT(h.req('PUT', '/x', { vehicleId: vA.id }), h.params({ id: cB.id }))).status).toBe(400);
    expect((await item.PUT(h.req('PUT', '/x', { claimAmount: 1500 }), h.params({ id: cB.id }))).status).toBe(200);
    expect((await item.DELETE(h.req('DELETE', '/x'), h.params({ id: cB.id }))).status).toBe(200);
    expect((await item.DELETE(h.req('DELETE', '/x'), h.params({ id: cB.id }))).status).toBe(404);
  });
});
