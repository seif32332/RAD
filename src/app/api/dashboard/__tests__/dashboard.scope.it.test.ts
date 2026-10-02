// P1-SCOPE (INV-SCOPE-01): /api/dashboard aggregates on a real database with real sessions
// (src/test/route-harness.ts). Opt-in: SCOPE_IT=1 with DATABASE_URL on a throwaway database.
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

describe.skipIf(process.env.SCOPE_IT !== '1')('dashboard route: company scope (real auth)', { timeout: 60_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // skipped: build nothing (the harness writes to the database)
  const h = await createRouteHarness(state);
  const route = await import('@/app/api/dashboard/route');
  await h.employee('A');
  await h.employee('B');
  await h.employee('B');
  const stray = await h.employee('B', { branchId: h.branch.A, departmentId: h.department.A });

  it('401 / 403; the counts of a scoped user cover his company only', async () => {
    await h.as(null);
    expect((await route.GET()).status).toBe(401);
    await h.as('empA');
    expect((await route.GET()).status).toBe(403);
    for (const k of ['A', 'B'] as const) {
      await h.as(k === 'A' ? 'hrA' : 'hrB');
      const body = await (await route.GET()).json();
      expect(body.scope).toBe('ALL');
      expect(body.kpis.totalEmployees).toBe(await h.prisma.employee.count({ where: { legalCompanyId: h.co[k], isTerminated: false } }));
      expect(body.structure.totalCompanies).toBe(1);
      expect(body.structure.totalBranches).toBe(await h.prisma.branch.count({ where: { companyId: h.co[k] } }));
    }
  });

  it('a pending accident claim of a vehicle of B counts for B only (the claim has no company of its own)', async () => {
    const count = async (who: 'hrA' | 'hrB') => {
      await h.as(who);
      return (await (await route.GET()).json()).alerts.logisticsAlertCount as number;
    };
    const [a0, b0] = [await count('hrA'), await count('hrB')];
    const vehicle = await h.prisma.vehicle.create({
      data: { category: 'خصوصي', brand: 'كيا', modelYear: '2024', color: 'أبيض', sequenceNumber: `S${h.tag}`, plateNumber: `P${h.tag}`, legalCompanyId: h.co.B },
    });
    await h.prisma.accidentClaim.create({ data: { vehicleId: vehicle.id, status: 'PENDING_SUBMISSION' } });
    expect(await count('hrA')).toBe(a0);
    expect(await count('hrB')).toBeGreaterThan(b0);
  });

  it('a branch manager gets team numbers inside his own company (an employee of B in his branch is not counted)', async () => {
    await h.as('branchMgrA');
    const body = await (await route.GET()).json();
    expect(body.scope).toBe('TEAM');
    const team = await h.prisma.employee.count({ where: { legalCompanyId: h.co.A, branchId: h.branch.A, isTerminated: false } });
    expect(body.kpis.totalEmployees).toBe(team);
    expect(stray.legalCompanyId).toBe(h.co.B);
  });
});
