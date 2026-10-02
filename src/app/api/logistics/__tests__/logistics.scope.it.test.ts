// P1-SCOPE part C (INV-SCOPE-01, ARCH-016.test): logistics alerts on a real database with REAL
// authentication (src/test/route-harness.ts): allow, deny and other company.
// Opt-in: SCOPE_IT=1 with DATABASE_URL pointing at a THROWAWAY database.
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

describe.skipIf(process.env.SCOPE_IT !== '1')('logistics alerts: company scope (real auth)', { timeout: 120_000 }, async () => {
  // vitest runs the body of a skipped suite while collecting: never touch a database unless opted in.
  if (process.env.SCOPE_IT !== '1') return;
  const h = await createRouteHarness(state);
  const alerts = await import('@/app/api/logistics/alerts/route');

  const soon = new Date(Date.now() + 5 * 86_400_000);
  const v = { A: '', B: '' };
  const claim = { A: '', B: '' };
  for (const k of ['A', 'B'] as const) {
    v[k] = (
      await h.prisma.vehicle.create({
        data: { legalCompanyId: h.co[k], category: '', brand: 'X', modelYear: '', color: '', sequenceNumber: '', plateNumber: `L${k}${h.tag}`, licenseExpDate: soon },
      })
    ).id;
    claim[k] = (await h.prisma.accidentClaim.create({ data: { vehicleId: v[k] } })).id;
  }

  it('deny: no session 401, employee and non-logistics roles 403', async () => {
    await h.as(null);
    expect((await alerts.GET()).status).toBe(401);
    await h.as('empA');
    expect((await alerts.GET()).status).toBe(403);
    await h.as('legalA');
    expect((await alerts.GET()).status).toBe(403);
  });

  it('allow / other company: buyerA gets the vehicle and claim alerts of company A only', async () => {
    await h.as('buyerA');
    const res = await alerts.GET();
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.json());
    expect(text).toContain(v.A);
    expect(text).toContain(claim.A);
    expect(text).not.toContain(v.B);
    expect(text).not.toContain(claim.B);
    await h.as('owner');
    const all = JSON.stringify(await (await alerts.GET()).json());
    for (const id of [v.A, v.B, claim.A, claim.B]) expect(all).toContain(id);
  });
});
