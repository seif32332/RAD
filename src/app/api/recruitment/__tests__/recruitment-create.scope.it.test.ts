// P1-SCOPE (INV-SCOPE-01): the create path of POST /api/recruitment (ScopedContext for HR, TeamContext
// for the other managers) on a real database with real sessions (src/test/route-harness.ts).
// Opt-in: SCOPE_IT=1 with DATABASE_URL on a throwaway database.
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

describe.skipIf(process.env.SCOPE_IT !== '1')('recruitment create: company scope (real auth)', { timeout: 60_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // skipped: build nothing (the harness writes to the database)
  const h = await createRouteHarness(state);
  const route = await import('@/app/api/recruitment/route');
  const a = await h.employee('A');
  const b = await h.employee('B');
  const create = (departmentId: string, requesterId?: string) =>
    route.POST(h.req('POST', '/api/recruitment', { departmentId, requesterId, jobTitle: `وظيفة ${h.tag}`, jobType: 'FULL_TIME', nationality: 'سعودي', description: 'وصف' }));

  it('401 / 403; a department or requester of another company is refused (nothing written); own company created', async () => {
    await h.as(null);
    expect((await create(h.department.A, a.id)).status).toBe(401);
    await h.as('empA');
    expect((await create(h.department.A, a.id)).status).toBe(403);
    await h.as('hrA');
    expect((await create(h.department.B, a.id)).status).toBe(400);
    expect((await create(h.department.A, b.id)).status).toBe(400);
    await h.as('deptMgrB');
    expect((await create(h.department.A)).status).toBe(400);
    expect(await h.prisma.jobRequest.count({ where: { companyId: h.co.A, jobTitle: `وظيفة ${h.tag}` } })).toBe(0);
    await h.as('hrA');
    expect((await create(h.department.A, a.id)).status).toBe(200);
    await h.as('deptMgrA');
    expect((await create(h.department.A)).status).toBe(200);
    expect(await h.prisma.jobRequest.count({ where: { companyId: h.co.A, jobTitle: `وظيفة ${h.tag}` } })).toBe(2);
  });
});
