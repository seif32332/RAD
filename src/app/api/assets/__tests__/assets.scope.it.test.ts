// P1-SCOPE part C (INV-SCOPE-01, ARCH-016.test): the custody (assets) routes on a real database with
// REAL authentication (src/test/route-harness.ts): allow, deny and other company for list and writes,
// and the Asset.companyId default of migration 9zb (trigger asset_default_company).
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

describe.skipIf(process.env.SCOPE_IT !== '1')('asset routes: company scope (real auth)', { timeout: 120_000 }, async () => {
  // vitest runs the body of a skipped suite while collecting: never touch a database unless opted in.
  if (process.env.SCOPE_IT !== '1') return;
  const h = await createRouteHarness(state);
  const assets = await import('@/app/api/assets/route');
  const asset = await import('@/app/api/assets/[id]/route');

  const holder = { A: '', B: '' };
  const held = { A: '', B: '' };
  const vacant = { A: '', B: '' };
  const sim = { A: '', B: '' };
  for (const k of ['A', 'B'] as const) {
    holder[k] = (await h.employee(k)).id;
    // No companyId: the trigger takes the holder's legal company.
    held[k] = (await h.prisma.asset.create({ data: { employeeId: holder[k], assetType: 'لابتوب', status: 'ACTIVE' } })).id;
    vacant[k] = (await h.prisma.asset.create({ data: { companyId: h.co[k], assetType: 'شاشة', status: 'VACANT' } })).id;
    sim[k] = (await h.prisma.telecomSim.create({ data: { simNumber: `S${k}${h.tag}`, companyId: h.co[k], employeeId: holder[k] } })).id;
  }
  const own = (await h.prisma.asset.create({ data: { employeeId: h.users.empA.employeeId!, assetType: 'جوال', status: 'ACTIVE' } })).id;

  it('migration 9zb: an asset inserted without a company takes its holder\'s legal company', async () => {
    expect(await h.prisma.asset.findUnique({ where: { id: held.A }, select: { companyId: true } })).toEqual({ companyId: h.co.A });
    expect(await h.prisma.asset.findUnique({ where: { id: held.B }, select: { companyId: true } })).toEqual({ companyId: h.co.B });
  });

  it('deny: no session 401, a non-logistics role may not write (403)', async () => {
    await h.as(null);
    expect((await assets.GET(h.req('GET', '/api/assets'))).status).toBe(401);
    await h.as('legalA');
    expect((await assets.POST(h.req('POST', '/x', { assetType: 'x' }))).status).toBe(403);
    expect((await asset.PATCH(h.req('PATCH', '/x', { action: 'clear' }), h.params({ id: held.A }))).status).toBe(403);
  });

  it('list: staff of A see the assets and SIMs of company A (vacant included); an employee his own only', async () => {
    await h.as('hrA');
    const list = ids(await (await assets.GET(h.req('GET', '/api/assets?active=true'))).json());
    expect(list).toEqual(expect.arrayContaining([held.A, sim.A]));
    for (const other of [held.B, sim.B, vacant.B]) expect(list).not.toContain(other);
    expect(ids(await (await assets.GET(h.req('GET', '/api/assets'))).json())).toContain(vacant.A);
    expect(ids(await (await assets.GET(h.req('GET', `/api/assets?employeeId=${holder.B}`))).json())).toEqual([]);

    await h.as('empA');
    expect(ids(await (await assets.GET(h.req('GET', `/api/assets?employeeId=${holder.A}`))).json())).toEqual([own]);

    await h.as('owner');
    expect(ids(await (await assets.GET(h.req('GET', '/api/assets?active=true'))).json())).toEqual(expect.arrayContaining([held.A, held.B, sim.A, sim.B]));
  });

  it('other company: buyerB cannot act on an asset or SIM of A, nor hand custody to an employee of A', async () => {
    await h.as('buyerB');
    expect((await asset.PATCH(h.req('PATCH', '/x', { action: 'edit', assetType: 'x' }), h.params({ id: held.A }))).status).toBe(404);
    expect((await asset.PATCH(h.req('PATCH', '/x', { action: 'clear' }), h.params({ id: sim.A }))).status).toBe(404);
    expect((await asset.PATCH(h.req('PATCH', '/x', { action: 'assign', employeeId: holder.A }), h.params({ id: vacant.B }))).status).toBe(404);
    expect((await assets.POST(h.req('POST', '/x', { assetType: 'x', employeeId: holder.A }))).status).toBe(404);
    expect((await assets.POST(h.req('POST', '/x', { assetType: 'x', companyId: h.co.A }))).status).toBe(403);
    expect(await h.prisma.asset.findUnique({ where: { id: held.A } })).toMatchObject({ assetType: 'لابتوب', employeeId: holder.A });
    expect(await h.prisma.telecomSim.findUnique({ where: { id: sim.A } })).toMatchObject({ employeeId: holder.A });
  });

  it('allow: buyerA creates, assigns and clears assets of company A; a cleared asset stays in his list', async () => {
    await h.as('buyerA');
    const res = await assets.POST(h.req('POST', '/x', { assetType: 'طابعة' }));
    expect(res.status).toBe(201);
    const [created] = ((await res.json()) as { createdAssets: { id: string; companyId: string }[] }).createdAssets;
    expect(created.companyId).toBe(h.co.A);
    expect((await asset.PATCH(h.req('PATCH', '/x', { action: 'assign', employeeId: holder.A }), h.params({ id: created.id }))).status).toBe(200);
    expect((await asset.PATCH(h.req('PATCH', '/x', { action: 'clear' }), h.params({ id: created.id }))).status).toBe(200);
    // Replay of the clear: 409 (guarded transition).
    expect((await asset.PATCH(h.req('PATCH', '/x', { action: 'clear' }), h.params({ id: created.id }))).status).toBe(409);
    expect(ids(await (await assets.GET(h.req('GET', '/api/assets'))).json())).toContain(created.id);
  });
});
