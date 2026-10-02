// P1-SCOPE part C (INV-SCOPE-01, ARCH-016.test): the renewals queue on a real database with REAL
// authentication (src/test/route-harness.ts): allow, deny and other company for the list and the action.
// Opt-in: SCOPE_IT=1 with DATABASE_URL pointing at a THROWAWAY database.
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

type Item = { entityId: string };

describe.skipIf(process.env.SCOPE_IT !== '1')('renewal routes: company scope (real auth)', { timeout: 120_000 }, async () => {
  // vitest runs the body of a skipped suite while collecting: never touch a database unless opted in.
  if (process.env.SCOPE_IT !== '1') return;
  const h = await createRouteHarness(state);
  const renewals = await import('@/app/api/renewals/route');
  const action = await import('@/app/api/renewals/action/route');

  const exp = new Date(Date.now() + 10 * 86_400_000);
  const emp = { A: '', B: '' };
  const vehicle = { A: '', B: '' };
  for (const k of ['A', 'B'] as const) {
    emp[k] = (await h.employee(k, { iqamaOrIdExp: exp })).id;
    await h.prisma.branch.update({ where: { id: h.branch[k] }, data: { munLicenseExp: exp } });
    vehicle[k] = (
      await h.prisma.vehicle.create({
        data: { legalCompanyId: h.co[k], category: '', brand: 'X', modelYear: '', color: '', sequenceNumber: '', plateNumber: `R${k}${h.tag}`, licenseExpDate: exp },
      })
    ).id;
  }
  const list = async () => ((await (await renewals.GET(h.req('GET', '/api/renewals?early=true'))).json()) as Item[]).map((i) => i.entityId);
  const terminate = (entityType: string, entityId: string, documentType: string) =>
    action.POST(h.req('POST', '/api/renewals/action', { action: 'TERMINATED', entityType, entityId, documentType, oldExpDate: exp.toISOString() }));

  it('deny: no session 401, employee and legal roles 403', async () => {
    await h.as(null);
    expect((await renewals.GET(h.req('GET', '/api/renewals'))).status).toBe(401);
    await h.as('empA');
    expect((await renewals.GET(h.req('GET', '/api/renewals'))).status).toBe(403);
    await h.as('legalA');
    expect((await terminate('EMPLOYEE', emp.A, 'IQAMA')).status).toBe(403);
  });

  it('list: govA gets the documents of company A only (employees, company, branch, vehicle)', async () => {
    await h.as('govA');
    const a = await list();
    expect(a).toEqual(expect.arrayContaining([emp.A, h.co.A, h.branch.A, vehicle.A]));
    for (const other of [emp.B, h.co.B, h.branch.B, vehicle.B]) expect(a).not.toContain(other);
    // ?employeeId= of another company: nothing.
    const one = (await (await renewals.GET(h.req('GET', `/api/renewals?early=true&employeeId=${emp.A}`))).json()) as Item[];
    expect(one.length).toBeGreaterThan(0);
    await h.as('govB');
    expect(await (await renewals.GET(h.req('GET', `/api/renewals?early=true&employeeId=${emp.A}`))).json()).toEqual([]);
    await h.as('owner');
    expect(await list()).toEqual(expect.arrayContaining([emp.A, emp.B, vehicle.A, vehicle.B]));
  });

  it('other company: govB cannot record a renewal decision on an entity of company A (404)', async () => {
    await h.as('govB');
    expect((await terminate('EMPLOYEE', emp.A, 'IQAMA')).status).toBe(404);
    expect((await terminate('COMPANY', h.co.A, 'COMMERCIAL_REG')).status).toBe(404);
    expect((await terminate('BRANCH', h.branch.A, 'MUN_LICENSE')).status).toBe(404);
    expect((await terminate('VEHICLE', vehicle.A, 'VEHICLE_LICENSE')).status).toBe(404);
    expect((await terminate('SOMETHING_ELSE', emp.A, 'IQAMA')).status).toBe(404); // unknown company: fail closed
    expect(await h.prisma.renewalArchive.count({ where: { entityId: { in: [emp.A, h.co.A, h.branch.A, vehicle.A] } } })).toBe(0);
  });

  it('allow: govA dismisses the alert of an employee of company A once (replay 409)', async () => {
    await h.as('govA');
    expect((await terminate('EMPLOYEE', emp.A, 'IQAMA')).status).toBe(200);
    expect((await terminate('EMPLOYEE', emp.A, 'IQAMA')).status).toBe(409);
    expect(await h.prisma.renewalArchive.count({ where: { entityId: emp.A, action: 'TERMINATED' } })).toBe(1);
  });
});
