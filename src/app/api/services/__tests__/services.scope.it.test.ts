// P1-SCOPE (INV-SCOPE-01): /api/services/telecom (+ [id]) and /api/services/utilities (+ [id]) on a real
// database with real sessions (src/test/route-harness.ts). TelecomSim is keyed by companyId,
// UtilityMeter by legalCompanyId. Opt-in: SCOPE_IT=1 with DATABASE_URL on a throwaway database.
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe.skipIf(process.env.SCOPE_IT !== '1')('services routes (telecom, utilities): company scope (real auth)', { timeout: 60_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // collected but skipped: never touch the database
  const h = await createRouteHarness(state);
  const telecom = await import('@/app/api/services/telecom/route');
  const sim = await import('@/app/api/services/telecom/[id]/route');
  const utilities = await import('@/app/api/services/utilities/route');
  const meter = await import('@/app/api/services/utilities/[id]/route');
  const empA = await h.employee('A');
  const simB = await h.prisma.telecomSim.create({ data: { simNumber: `05${h.tag}B`, companyId: h.co.B } });
  const meterB = await h.prisma.utilityMeter.create({ data: { meterNumber: `M${h.tag}B`, legalCompanyId: h.co.B } });

  it('lists and details: 401 / 403, another company hidden (404), the owner sees it', async () => {
    await h.as(null);
    expect((await telecom.GET(h.req('GET', '/x'))).status).toBe(401);
    expect((await utilities.GET()).status).toBe(401);
    await h.as('empA');
    expect((await telecom.GET(h.req('GET', '/x'))).status).toBe(403);
    expect((await utilities.GET()).status).toBe(403);
    await h.as('hrA');
    expect(ids(await (await telecom.GET(h.req('GET', '/x'))).json())).not.toContain(simB.id);
    expect(ids(await (await utilities.GET()).json())).not.toContain(meterB.id);
    expect((await sim.GET(h.req('GET', '/x'), h.params({ id: simB.id }))).status).toBe(404);
    expect((await meter.GET(h.req('GET', '/x'), h.params({ id: meterB.id }))).status).toBe(404);
    await h.as('owner');
    expect(ids(await (await telecom.GET(h.req('GET', '/x'))).json())).toContain(simB.id);
    expect(ids(await (await utilities.GET()).json())).toContain(meterB.id);
  });

  it('create: finance 403; another company (or an employee of it) refused; own company 201; no company 400 for a scoped user', async () => {
    await h.as('finA');
    expect((await telecom.POST(h.req('POST', '/x', { simNumber: `05${h.tag}X`, companyId: h.co.A }))).status).toBe(403);
    await h.as('buyerB');
    expect((await telecom.POST(h.req('POST', '/x', { simNumber: `05${h.tag}Y`, companyId: h.co.A }))).status).toBe(400);
    expect((await telecom.POST(h.req('POST', '/x', { simNumber: `05${h.tag}Y`, companyId: h.co.B, employeeId: empA.id }))).status).toBe(400);
    expect((await telecom.POST(h.req('POST', '/x', { simNumber: `05${h.tag}Y` }))).status).toBe(400);
    expect((await utilities.POST(h.req('POST', '/x', { meterNumber: `M${h.tag}Y`, legalCompanyId: h.co.A }))).status).toBe(400);
    expect(await h.prisma.telecomSim.count({ where: { simNumber: `05${h.tag}Y` } })).toBe(0);
    expect((await telecom.POST(h.req('POST', '/x', { simNumber: `05${h.tag}Y`, companyId: h.co.B }))).status).toBe(201);
    expect((await telecom.POST(h.req('POST', '/x', { simNumber: `05${h.tag}Y`, companyId: h.co.B }))).status).toBe(409);
    expect((await utilities.POST(h.req('POST', '/x', { meterNumber: `M${h.tag}Y`, legalCompanyId: h.co.B }))).status).toBe(201);
  });

  it('update / delete: another company 404 and untouched; own company allowed, moving to another company refused', async () => {
    await h.as('buyerA');
    expect((await sim.PUT(h.req('PUT', '/x', { provider: 'X' }), h.params({ id: simB.id }))).status).toBe(404);
    expect((await sim.DELETE(h.req('DELETE', '/x'), h.params({ id: simB.id }))).status).toBe(404);
    expect((await meter.PUT(h.req('PUT', '/x', { accountNumber: 'X' }), h.params({ id: meterB.id }))).status).toBe(404);
    expect((await meter.DELETE(h.req('DELETE', '/x'), h.params({ id: meterB.id }))).status).toBe(404);
    expect(await h.prisma.telecomSim.count({ where: { id: simB.id, provider: null } })).toBe(1);
    expect(await h.prisma.utilityMeter.count({ where: { id: meterB.id } })).toBe(1);
    await h.as('buyerB');
    expect((await sim.PUT(h.req('PUT', '/x', { companyId: h.co.A }), h.params({ id: simB.id }))).status).toBe(400);
    expect((await sim.PUT(h.req('PUT', '/x', { provider: 'STC' }), h.params({ id: simB.id }))).status).toBe(200);
    expect((await meter.PUT(h.req('PUT', '/x', { accountNumber: '123' }), h.params({ id: meterB.id }))).status).toBe(200);
    expect((await sim.DELETE(h.req('DELETE', '/x'), h.params({ id: simB.id }))).status).toBe(200);
    expect((await sim.DELETE(h.req('DELETE', '/x'), h.params({ id: simB.id }))).status).toBe(404);
    expect((await meter.DELETE(h.req('DELETE', '/x'), h.params({ id: meterB.id }))).status).toBe(200);
  });
});
