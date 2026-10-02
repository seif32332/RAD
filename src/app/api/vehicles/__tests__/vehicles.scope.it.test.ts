// P1-SCOPE part C (INV-SCOPE-01, ARCH-016.test): the vehicle routes on a real database with REAL
// authentication (src/test/route-harness.ts): allow, deny and other company for list, detail and writes.
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

describe.skipIf(process.env.SCOPE_IT !== '1')('vehicle routes: company scope (real auth)', { timeout: 120_000 }, async () => {
  // vitest runs the body of a skipped suite while collecting: never touch a database unless opted in.
  if (process.env.SCOPE_IT !== '1') return;
  const h = await createRouteHarness(state);
  const vehicles = await import('@/app/api/vehicles/route');
  const vehicle = await import('@/app/api/vehicles/[id]/route');

  const v = { A: '', B: '' };
  const plate = { A: `VA${h.tag}`, B: `VB${h.tag}` };
  const driver = { A: '', B: '' };
  for (const k of ['A', 'B'] as const) {
    driver[k] = (await h.employee(k)).id;
    v[k] = (await h.prisma.vehicle.create({ data: { legalCompanyId: h.co[k], category: '', brand: 'X', modelYear: '', color: '', sequenceNumber: '', plateNumber: plate[k] } })).id;
  }

  it('deny: no session 401, employee 403, a non-logistics role may read but not write (403)', async () => {
    await h.as(null);
    expect((await vehicles.GET()).status).toBe(401);
    await h.as('empA');
    expect((await vehicles.GET()).status).toBe(403);
    await h.as('legalA');
    expect((await vehicles.GET()).status).toBe(200);
    expect((await vehicles.POST(h.req('POST', '/x', { brand: 'Y', plateNumber: `N1${h.tag}` }))).status).toBe(403);
    expect((await vehicle.PATCH(h.req('PATCH', '/x', { isArchived: true }), h.params({ id: v.A }))).status).toBe(403);
  });

  it('list and detail: buyerA sees company A only; the owner sees both', async () => {
    await h.as('buyerA');
    const list = ids(await (await vehicles.GET()).json());
    expect(list).toContain(v.A);
    expect(list).not.toContain(v.B);
    expect((await vehicle.GET(h.req('GET', '/x'), h.params({ id: v.A }))).status).toBe(200);
    expect((await vehicle.GET(h.req('GET', '/x'), h.params({ id: v.B }))).status).toBe(404);
    await h.as('owner');
    expect(ids(await (await vehicles.GET()).json())).toEqual(expect.arrayContaining([v.A, v.B]));
  });

  it('other company: buyerB cannot edit, archive or delete a vehicle of A, nor create one for A (404 / 403)', async () => {
    await h.as('buyerB');
    const p = h.params({ id: v.A });
    expect((await vehicle.PUT(h.req('PUT', '/x', { brand: 'Hacked' }), p)).status).toBe(404);
    expect((await vehicle.PATCH(h.req('PATCH', '/x', { isArchived: true }), p)).status).toBe(404);
    expect((await vehicle.DELETE(h.req('DELETE', '/x'), p)).status).toBe(404);
    expect((await vehicles.POST(h.req('POST', '/x', { brand: 'Y', plateNumber: `N2${h.tag}`, legalCompanyId: h.co.A }))).status).toBe(403);
    expect((await vehicles.POST(h.req('POST', '/x', { brand: 'Y', plateNumber: `N3${h.tag}`, driverId: driver.A }))).status).toBe(404);
    // Moving his own vehicle to company A is refused too.
    expect((await vehicle.PUT(h.req('PUT', '/x', { legalCompanyId: h.co.A }), h.params({ id: v.B }))).status).toBe(403);
    // A duplicate plate of another company is refused without describing that vehicle.
    const dup = await vehicles.POST(h.req('POST', '/x', { brand: 'Y', plateNumber: plate.A }));
    expect(dup.status).toBe(409);
    expect(JSON.stringify(await dup.json())).not.toContain(plate.A);
    expect(await h.prisma.vehicle.findUnique({ where: { id: v.A } })).toMatchObject({ brand: 'X', isArchived: false });
  });

  it('allow: buyerA creates (company A by default), edits and archives vehicles of company A', async () => {
    await h.as('buyerA');
    const res = await vehicles.POST(h.req('POST', '/x', { brand: 'Y', plateNumber: `N4${h.tag}`, driverId: driver.A }));
    expect(res.status).toBe(201);
    const { vehicle: created } = (await res.json()) as { vehicle: { id: string; legalCompanyId: string } };
    expect(created.legalCompanyId).toBe(h.co.A);
    expect((await vehicle.PUT(h.req('PUT', '/x', { brand: 'Z' }), h.params({ id: v.A }))).status).toBe(200);
    expect((await vehicle.PATCH(h.req('PATCH', '/x', { isArchived: true }), h.params({ id: v.A }))).status).toBe(200);
    expect((await vehicle.DELETE(h.req('DELETE', '/x'), h.params({ id: created.id }))).status).toBe(200);
  });
});
