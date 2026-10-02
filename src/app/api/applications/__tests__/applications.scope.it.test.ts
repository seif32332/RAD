// P1-SCOPE (INV-SCOPE-01): /api/applications on a real database with real sessions (src/test/route-harness.ts).
// A JobApplication belongs to its vacancy's company (JobRequest.companyId). Opt-in: SCOPE_IT=1 with DATABASE_URL.
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

describe.skipIf(process.env.SCOPE_IT !== '1')('applications route: company scope (real auth)', { timeout: 60_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // vitest runs a skipped suite body while collecting
  const h = await createRouteHarness(state);
  const route = await import('@/app/api/applications/route');
  const { JOB_REQUEST_OPEN_STATUS } = await import('@/app/api/recruitment/shared');

  const job = async (k: 'A' | 'B') =>
    h.prisma.jobRequest.create({
      data: { companyId: h.co[k], departmentId: h.department[k], requesterId: h.users[k === 'A' ? 'empA' : 'empB'].employeeId!, jobTitle: `وظيفة ${k}`, jobType: 'FULL_TIME', nationality: 'SA', description: 'x', status: JOB_REQUEST_OPEN_STATUS },
    });
  const jobA = await job('A');
  const jobB = await job('B');
  const app = async (jobRequestId: string) => h.prisma.jobApplication.create({ data: { jobRequestId, candidateName: `مرشح ${h.next()}`, candidatePhone: '0500000000' } });
  const appA = await app(jobA.id);
  const appB = await app(jobB.id);

  it('GET: 401 / 403; HR sees the applications and vacancies of its companies only; the owner every company', async () => {
    await h.as(null);
    expect((await route.GET()).status).toBe(401);
    await h.as('finA');
    expect((await route.GET()).status).toBe(403);
    await h.as('hrA');
    const res = await route.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    const appIds = body.applications.map((a: { id: string }) => a.id);
    expect(appIds).toContain(appA.id);
    expect(appIds).not.toContain(appB.id);
    const jobIds = body.activeJobs.map((j: { id: string }) => j.id);
    expect(jobIds).toContain(jobA.id);
    expect(jobIds).not.toContain(jobB.id);
    await h.as('owner');
    const all = (await (await route.GET()).json()).applications.map((a: { id: string }) => a.id);
    expect(all).toEqual(expect.arrayContaining([appA.id, appB.id]));
  });

  it('POST UPDATE_STATUS: another company\'s application is "not found" and unchanged; own company allowed', async () => {
    const move = (id: string) => h.req('POST', '/api/applications', { actionType: 'UPDATE_STATUS', payload: { id, status: 'REJECTED', notes: 'x' } });
    await h.as('empA');
    expect((await route.POST(move(appA.id))).status).toBe(403);
    await h.as('hrA');
    expect((await route.POST(move(appB.id))).status).toBe(404);
    expect((await h.prisma.jobApplication.findUniqueOrThrow({ where: { id: appB.id } })).status).toBe('APPLIED');
    expect((await route.POST(move(appA.id))).status).toBe(200);
    expect((await h.prisma.jobApplication.findUniqueOrThrow({ where: { id: appA.id } })).status).toBe('REJECTED');
  });

  it('POST create: a vacancy of another company is refused (the route\'s "vacancy not found"); own company allowed', async () => {
    const add = (jobRequestId: string) => h.req('POST', '/api/applications', { jobRequestId, candidateName: 'مرشح جديد', candidatePhone: '0500000001' });
    await h.as('hrB');
    expect((await route.POST(add(jobA.id))).status).toBe(400);
    expect(await h.prisma.jobApplication.count({ where: { jobRequestId: jobA.id } })).toBe(1);
    await h.as('hrA');
    expect((await route.POST(add(jobA.id))).status).toBe(200);
    expect(await h.prisma.jobApplication.count({ where: { jobRequestId: jobA.id } })).toBe(2);
  });
});
