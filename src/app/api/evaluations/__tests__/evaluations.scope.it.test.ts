// P1-SCOPE (INV-SCOPE-01): /api/evaluations on a real database with real sessions
// (src/test/route-harness.ts). Templates and cycles have no company; evaluations follow their employee.
// Opt-in: SCOPE_IT=1 with DATABASE_URL on a throwaway database.
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe.skipIf(process.env.SCOPE_IT !== '1')('evaluations route: company scope (real auth)', { timeout: 60_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // skipped: build nothing (the harness writes to the database)
  const h = await createRouteHarness(state);
  const route = await import('@/app/api/evaluations/route');
  const empA = await h.prisma.employee.findFirstOrThrow({ where: { userId: h.users.empA.id } });
  const b = await h.employee('B');
  const template = await h.prisma.evaluationTemplate.create({ data: { name: `نموذج ${h.tag}` } });
  const cycle = await h.prisma.evaluationCycle.create({
    data: { title: `دورة ${h.tag}`, templateId: template.id, startDate: new Date('2026-01-01'), endDate: new Date('2026-03-31') },
  });
  const evA = await h.prisma.employeeEvaluation.create({ data: { cycleId: cycle.id, employeeId: empA.id, status: 'PENDING_APPROVAL' } });
  const evB = await h.prisma.employeeEvaluation.create({ data: { cycleId: cycle.id, employeeId: b.id, status: 'PENDING_APPROVAL' } });
  const get = (q: string) => route.GET(h.req('GET', `/api/evaluations?${q}`));
  const post = (body: Record<string, unknown>) => route.POST(h.req('POST', '/api/evaluations', body));

  it('reads: 401 / 403; cycles and cycle detail carry the evaluations of the user companies only; details of another company 404', async () => {
    await h.as(null);
    expect((await get('view=cycles')).status).toBe(401);
    await h.as('empA');
    expect((await get('view=cycles')).status).toBe(403);
    expect((await get(`view=evaluation&evalId=${evA.id}`)).status).toBe(200); // his own
    expect((await get(`view=evaluation&evalId=${evB.id}`)).status).toBe(404);
    await h.as('hrA');
    const cycles = (await (await get('view=cycles')).json()) as Array<{ id: string; evaluations: Array<{ id: string }> }>;
    expect(ids(cycles.find((c) => c.id === cycle.id)!.evaluations)).toEqual([evA.id]);
    expect(ids((await (await get(`view=cycle-detail&cycleId=${cycle.id}`)).json()).evaluations)).toEqual([evA.id]);
    expect((await get(`view=evaluation&evalId=${evB.id}`)).status).toBe(404);
    expect((await get(`view=attendance-record&evalId=${evB.id}`)).status).toBe(404);
    expect((await get(`view=employee-pending&employeeId=${b.id}`)).status).toBe(200);
    expect(await (await get(`view=employee-pending&employeeId=${b.id}`)).json()).toEqual([]);
    const dash = await (await get('view=dashboard')).json();
    expect(dash.pendingApproval).toBe(await h.prisma.employeeEvaluation.count({ where: { status: 'PENDING_APPROVAL', employee: { legalCompanyId: h.co.A } } }));
    await h.as('owner');
    const all = (await (await get('view=cycles')).json()) as Array<{ id: string; evaluations: Array<{ id: string }> }>;
    expect(ids(all.find((c) => c.id === cycle.id)!.evaluations).sort()).toEqual([evA.id, evB.id].sort());
  });

  it('writes: approving or scoring another company evaluation 404 (unchanged); closing a mixed cycle 403 for a scoped HR', async () => {
    await h.as('hrB');
    expect((await post({ action: 'APPROVE_EVALUATION', evaluationId: evA.id })).status).toBe(404);
    expect((await post({ action: 'SAVE_SCORES', evaluationId: evA.id })).status).toBe(404);
    expect((await h.prisma.employeeEvaluation.findUnique({ where: { id: evA.id } }))?.status).toBe('PENDING_APPROVAL');
    expect((await post({ action: 'APPROVE_EVALUATION', evaluationId: evB.id })).status).toBe(200);
    await h.as('hrA');
    expect((await post({ action: 'CLOSE_CYCLE', cycleId: cycle.id })).status).toBe(403);
    await h.as('empA');
    expect((await post({ action: 'CLOSE_CYCLE', cycleId: cycle.id })).status).toBe(403);
    await h.as('owner');
    expect((await post({ action: 'CLOSE_CYCLE', cycleId: cycle.id })).status).toBe(200);
  });

  it('create cycle: a scoped HR user only enrolls employees of his companies', async () => {
    await h.as('hrA');
    const res = await post({ action: 'CREATE_CYCLE', title: `دورة 2 ${h.tag}`, templateId: template.id, startDate: '2026-04-01', endDate: '2026-06-30', targetEmployeeIds: [empA.id, b.id] });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    const enrolled = await h.prisma.employeeEvaluation.findMany({ where: { cycleId: data.id }, select: { employeeId: true } });
    expect(enrolled.map((e) => e.employeeId)).toEqual([empA.id]);
  });
});
