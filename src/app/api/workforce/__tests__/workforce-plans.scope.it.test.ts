// P1-SCOPE (INV-SCOPE-01): workforce plans (+ positions, raises, transitions, compare, plan vs actual,
// sensitivity and export of a plan) and saved calculations on a real database with real sessions
// (src/test/route-harness.ts). A plan of another company is "not found"; a plan of every company
// (companyId null) belongs to unrestricted callers only. Opt-in: SCOPE_IT=1 with DATABASE_URL.
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

describe.skipIf(process.env.SCOPE_IT !== '1')('workforce plans and calculations: company scope (real auth)', { timeout: 180_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // vitest runs a skipped suite body while collecting
  const h = await createRouteHarness(state);
  const plans = await import('@/app/api/workforce/plans/route');
  const compare = await import('@/app/api/workforce/plans/compare/route');
  const plan = await import('@/app/api/workforce/plans/[id]/route');
  const actual = await import('@/app/api/workforce/plans/[id]/actual/route');
  const submit = await import('@/app/api/workforce/plans/[id]/submit/route');
  const approve = await import('@/app/api/workforce/plans/[id]/approve/route');
  const reject = await import('@/app/api/workforce/plans/[id]/reject/route');
  const archive = await import('@/app/api/workforce/plans/[id]/archive/route');
  const copy = await import('@/app/api/workforce/plans/[id]/copy/route');
  const positions = await import('@/app/api/workforce/plans/[id]/positions/route');
  const position = await import('@/app/api/workforce/plans/[id]/positions/[positionId]/route');
  const raises = await import('@/app/api/workforce/plans/[id]/raises/route');
  const raise = await import('@/app/api/workforce/plans/[id]/raises/[raiseId]/route');
  const calcs = await import('@/app/api/workforce/calculations/route');
  const calc = await import('@/app/api/workforce/calculations/[id]/route');
  const sens = await import('@/app/api/workforce/sensitivity/route');
  const exp = await import('@/app/api/workforce/export/route');

  const empA = h.users.empA.employeeId!;
  const empB = h.users.empB.employeeId!;
  const fromMonth = new Date(Date.UTC(new Date().getUTCFullYear() + 1, 0, 1));
  const monthKey = fromMonth.toISOString().slice(0, 7);
  const newPlan = (companyId: string | null, name: string) =>
    h.prisma.headcountPlan.create({ data: { name: `${name} ${h.tag}`, companyId, fromMonth, months: 12, status: 'DRAFT', createdById: h.users.owner.id } });
  const planA = await newPlan(h.co.A, 'خطة أ');
  const planB = await newPlan(h.co.B, 'خطة ب');
  const planAll = await newPlan(null, 'خطة الكل');
  const posB = await h.prisma.plannedPosition.create({ data: { planId: planB.id, kind: 'NEW_HIRE', title: 'وظيفة', companyId: h.co.B, nationalityClass: 'SAUDI', basicSalary: 5000, startMonth: fromMonth } });
  const raiseB = await h.prisma.planRaise.create({ data: { planId: planB.id, scope: 'ALL', pct: 5, effectiveMonth: fromMonth } });
  const snapshot = (subjectType: string, subjectId: string | null) =>
    h.prisma.workforceCalculation.create({ data: { kind: 'TRUE_COST', subjectType, subjectId, title: `لقطة ${subjectType}`, engineVersion: 't', ruleVersions: '[]', inputs: '{}', outputs: '{}' } });
  const calcA = await snapshot('COMPANY', h.co.A);
  const calcB = await snapshot('COMPANY', h.co.B);
  const calcEmpB = await snapshot('EMPLOYEE', empB);
  const calcPlanA = await snapshot('PLAN', planA.id);
  const calcAll = await snapshot('ALL', null);

  const p = (id: string) => h.params({ id });
  const body = (b: unknown = {}) => h.req('POST', '/x', b);

  it('every handler: 401 without a session, 403 for a role outside the workforce group', async () => {
    const calls: Array<[string, () => Promise<Response>]> = [
      ['plans GET', () => plans.GET(h.req('GET', '/api/workforce/plans'))],
      ['plans POST', () => plans.POST(body({ name: 'x', companyId: h.co.A, fromMonth: monthKey, months: 12 }))],
      ['compare', () => compare.GET(h.req('GET', `/api/workforce/plans/compare?ids=${planA.id},${planB.id}`))],
      ['plan GET', () => plan.GET(h.req('GET', '/x'), p(planA.id))],
      ['plan PATCH', () => plan.PATCH(h.req('PATCH', '/x', { name: 'y' }), p(planA.id))],
      ['actual', () => actual.GET(h.req('GET', '/x'), p(planA.id))],
      ['submit', () => submit.POST(body(), p(planA.id))],
      ['approve', () => approve.POST(body(), p(planA.id))],
      ['reject', () => reject.POST(body({ note: 'x' }), p(planA.id))],
      ['archive', () => archive.POST(body(), p(planA.id))],
      ['copy', () => copy.POST(body(), p(planA.id))],
      ['positions POST', () => positions.POST(body({}), p(planA.id))],
      ['position PATCH', () => position.PATCH(h.req('PATCH', '/x', { title: 'x' }), h.params({ id: planB.id, positionId: posB.id }))],
      ['position DELETE', () => position.DELETE(h.req('DELETE', '/x'), h.params({ id: planB.id, positionId: posB.id }))],
      ['raises POST', () => raises.POST(body({}), p(planA.id))],
      ['raise PATCH', () => raise.PATCH(h.req('PATCH', '/x', { pct: 3 }), h.params({ id: planB.id, raiseId: raiseB.id }))],
      ['raise DELETE', () => raise.DELETE(h.req('DELETE', '/x'), h.params({ id: planB.id, raiseId: raiseB.id }))],
      ['calculations GET', () => calcs.GET(h.req('GET', '/api/workforce/calculations'))],
      ['calculations POST', () => calcs.POST(body({ kind: 'OVERVIEW', params: {} }))],
      ['calculation GET', () => calc.GET(h.req('GET', '/x'), p(calcA.id))],
    ];
    for (const [name, call] of calls) {
      await h.as(null);
      expect([name, (await call()).status]).toEqual([name, 401]);
      await h.as('empA');
      expect([name, (await call()).status]).toEqual([name, 403]);
      await h.as('payrollA');
      expect([name, (await call()).status]).toEqual([name, 403]);
    }
  });

  it('list / summary / create: the caller\'s companies only; a plan of every company is the owner\'s', async () => {
    await h.as('hrA');
    const list = await (await plans.GET(h.req('GET', '/api/workforce/plans?take=200'))).json();
    const ids = list.items.map((r: { id: string }) => r.id);
    expect(ids).toContain(planA.id);
    expect(ids).not.toContain(planB.id);
    expect(ids).not.toContain(planAll.id);
    expect(list.items.every((r: { companyId: string }) => r.companyId === h.co.A)).toBe(true);
    expect((await (await plans.GET(h.req('GET', `/api/workforce/plans?companyId=${h.co.B}`))).json()).items).toEqual([]);
    expect((await plans.GET(h.req('GET', '/api/workforce/plans?summary=1'))).status).toBe(200);

    expect((await plans.POST(body({ name: 'خطة مخترقة', companyId: h.co.B, fromMonth: monthKey, months: 12 }))).status).toBe(404);
    expect((await plans.POST(body({ name: 'خطة الكل', fromMonth: monthKey, months: 12 }))).status).toBe(403);
    const created = await plans.POST(body({ name: 'خطة جديدة', companyId: h.co.A, fromMonth: monthKey, months: 12 }));
    expect(created.status).toBe(201);

    await h.as('owner');
    const all = (await (await plans.GET(h.req('GET', '/api/workforce/plans?take=200'))).json()).items.map((r: { id: string }) => r.id);
    expect(all).toEqual(expect.arrayContaining([planA.id, planB.id, planAll.id]));
  });

  it('detail / actual / compare / sensitivity / export: another company\'s plan (or the plan of every company) is 404', async () => {
    await h.as('finA');
    for (const id of [planB.id, planAll.id]) {
      expect((await plan.GET(h.req('GET', '/x'), p(id))).status).toBe(404);
      expect((await actual.GET(h.req('GET', '/x'), p(id))).status).toBe(404);
      expect((await sens.GET(h.req('GET', `/api/workforce/sensitivity?decision=plan&planId=${id}`))).status).toBe(404);
      expect((await exp.GET(h.req('GET', `/api/workforce/export?kind=plan&planId=${id}`))).status).toBe(404);
    }
    expect((await compare.GET(h.req('GET', `/api/workforce/plans/compare?ids=${planA.id},${planB.id}`))).status).toBe(404);
    const own = await plan.GET(h.req('GET', '/x'), p(planA.id));
    expect(own.status).toBe(200);
    const detail = await own.json();
    expect(Object.keys(detail.names.companies)).toEqual([h.co.A]);
    expect(Object.keys(detail.names.branches)).not.toContain(h.branch.B);
    expect((await actual.GET(h.req('GET', '/x'), p(planA.id))).status).toBe(200);
    expect((await sens.GET(h.req('GET', `/api/workforce/sensitivity?decision=plan&planId=${planA.id}`))).status).toBe(200);
    await h.as('owner');
    expect((await plan.GET(h.req('GET', '/x'), p(planAll.id))).status).toBe(200);
    expect((await compare.GET(h.req('GET', `/api/workforce/plans/compare?ids=${planA.id},${planB.id}`))).status).toBe(200);
  });

  it('edit / positions / raises: another company\'s plan or data is 404 and unchanged; own plan allowed', async () => {
    await h.as('hrA');
    expect((await plan.PATCH(h.req('PATCH', '/x', { name: 'مخترق' }), p(planB.id))).status).toBe(404);
    expect((await plan.PATCH(h.req('PATCH', '/x', { companyId: h.co.B }), p(planA.id))).status).toBe(404);
    expect((await plan.PATCH(h.req('PATCH', '/x', { companyId: null }), p(planA.id))).status).toBe(403);
    expect((await plan.PATCH(h.req('PATCH', '/x', { notes: 'ملاحظة' }), p(planA.id))).status).toBe(200);

    const hireB = { kind: 'NEW_HIRE', title: 'وظيفة', nationalityClass: 'SAUDI', basicSalary: 5000, startMonth: monthKey };
    expect((await positions.POST(body(hireB), p(planB.id))).status).toBe(404);
    expect((await positions.POST(body({ ...hireB, departmentId: h.department.B }), p(planA.id))).status).toBe(404);
    expect((await positions.POST(body({ ...hireB, branchId: h.branch.B }), p(planA.id))).status).toBe(404);
    expect((await positions.POST(body({ kind: 'EXIT', title: 'خروج', exitEmployeeId: empB, exitMonth: monthKey, exitReason: 'RESIGNATION' }), p(planA.id))).status).toBe(404);
    const pos = await positions.POST(body({ ...hireB, departmentId: h.department.A }), p(planA.id));
    expect(pos.status).toBe(201);
    const posId = (await pos.json()).id;
    expect((await position.PATCH(h.req('PATCH', '/x', { title: 'مخترق' }), h.params({ id: planB.id, positionId: posB.id }))).status).toBe(404);
    expect((await position.DELETE(h.req('DELETE', '/x'), h.params({ id: planB.id, positionId: posB.id }))).status).toBe(404);
    expect((await position.PATCH(h.req('PATCH', '/x', { departmentId: h.department.B }), h.params({ id: planA.id, positionId: posId }))).status).toBe(404);
    expect((await position.PATCH(h.req('PATCH', '/x', { title: 'وظيفة معدلة' }), h.params({ id: planA.id, positionId: posId }))).status).toBe(200);
    expect((await h.prisma.plannedPosition.findUniqueOrThrow({ where: { id: posB.id } })).title).toBe('وظيفة');

    expect((await raises.POST(body({ scope: 'ALL', pct: 3, effectiveMonth: monthKey }), p(planB.id))).status).toBe(404);
    expect((await raises.POST(body({ scope: 'EMPLOYEE', scopeId: empB, pct: 3, effectiveMonth: monthKey }), p(planA.id))).status).toBe(404);
    expect((await raises.POST(body({ scope: 'DEPARTMENT', scopeId: h.department.B, pct: 3, effectiveMonth: monthKey }), p(planA.id))).status).toBe(404);
    expect((await raises.POST(body({ scope: 'COMPANY', scopeId: h.co.B, pct: 3, effectiveMonth: monthKey }), p(planA.id))).status).toBe(404);
    expect((await raises.POST(body({ scope: 'EMPLOYEE', scopeId: empA, pct: 3, effectiveMonth: monthKey }), p(planA.id))).status).toBe(201);
    expect((await raise.PATCH(h.req('PATCH', '/x', { pct: 9 }), h.params({ id: planB.id, raiseId: raiseB.id }))).status).toBe(404);
    expect((await raise.DELETE(h.req('DELETE', '/x'), h.params({ id: planB.id, raiseId: raiseB.id }))).status).toBe(404);
    expect((await h.prisma.planRaise.findUniqueOrThrow({ where: { id: raiseB.id } })).pct).toBe(5);
    expect(await h.prisma.plannedPosition.count({ where: { id: posB.id } })).toBe(1);
  });

  it('transitions and copy: another company\'s plan is 404 and keeps its status; own plan allowed', async () => {
    await h.as('hrA');
    expect((await submit.POST(body(), p(planB.id))).status).toBe(404);
    expect((await reject.POST(body({ note: 'x' }), p(planB.id))).status).toBe(404);
    expect((await archive.POST(body(), p(planB.id))).status).toBe(404);
    expect((await copy.POST(body(), p(planB.id))).status).toBe(404);
    expect((await copy.POST(body(), p(planAll.id))).status).toBe(404);
    expect((await h.prisma.headcountPlan.findUniqueOrThrow({ where: { id: planB.id } })).status).toBe('DRAFT');
    expect((await copy.POST(body(), p(planA.id))).status).toBe(201);
    expect((await submit.POST(body(), p(planA.id))).status).toBe(200);
    await h.as('hrB');
    expect((await approve.POST(body(), p(planA.id))).status).toBe(404);
    await h.as('adminA'); // decides: an owner role (COMPANY_ADMIN) who is neither the creator nor the submitter
    expect((await approve.POST(body(), p(planA.id))).status).toBe(200);
  });

  it('saved calculations: subjects of the caller\'s companies only; saving for every company is the owner\'s', async () => {
    await h.as('hrA');
    const list = (await (await calcs.GET(h.req('GET', '/api/workforce/calculations?take=100'))).json()).items.map((r: { id: string }) => r.id);
    expect(list).toEqual(expect.arrayContaining([calcA.id, calcPlanA.id]));
    for (const id of [calcB.id, calcEmpB.id, calcAll.id]) expect(list).not.toContain(id);
    for (const id of [calcB.id, calcEmpB.id, calcAll.id]) {
      expect((await calc.GET(h.req('GET', '/x'), p(id))).status).toBe(404);
      expect((await exp.GET(h.req('GET', `/api/workforce/export?kind=calculation&id=${id}`))).status).toBe(404);
    }
    expect((await calc.GET(h.req('GET', '/x'), p(calcA.id))).status).toBe(200);

    expect((await calcs.POST(body({ kind: 'OVERVIEW', params: { months: 12, scenario: 'base' } }))).status).toBe(403);
    expect((await calcs.POST(body({ kind: 'TRUE_COST', params: {} }))).status).toBe(403);
    expect((await calcs.POST(body({ kind: 'TRUE_COST', params: { companyId: h.co.B } }))).status).toBe(404);
    expect((await calcs.POST(body({ kind: 'EXIT_COST', params: { employeeId: empB, exitReason: 'RESIGNATION', lastWorkingDate: '2026-12-31', noticeServed: true } }))).status).toBe(404);
    expect((await calcs.POST(body({ kind: 'WORKFORCE_PLAN', params: { planId: planB.id } }))).status).toBe(404);
    const saved = await calcs.POST(body({ kind: 'TRUE_COST', params: { companyId: h.co.A } }));
    expect(saved.status).toBe(201);
    const savedId = (await saved.json()).id;
    const snap = await (await calc.GET(h.req('GET', '/x'), p(savedId))).json();
    expect(snap.inputs.companies.map((c: { id: string }) => c.id)).toEqual([h.co.A]);

    await h.as('owner');
    const all = (await (await calcs.GET(h.req('GET', '/api/workforce/calculations?take=100'))).json()).items.map((r: { id: string }) => r.id);
    expect(all).toEqual(expect.arrayContaining([calcA.id, calcB.id, calcEmpB.id, calcAll.id]));
  });
});
