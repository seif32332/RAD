// P1-SCOPE (INV-SCOPE-01): the workforce decision engine's calculation routes on a real database with real
// sessions (src/test/route-harness.ts). DOMAIN_BOUNDARIES §5.4.3 "workforce / reporting": aggregation inside
// the caller's companies only; a company / employee outside them is "not found"; the tenant-wide defaults and
// legal registers are read by everyone and written by an unrestricted caller only.
// Plans and saved calculations: workforce-plans.scope.it.test.ts. Opt-in: SCOPE_IT=1 with DATABASE_URL.
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));


describe.skipIf(process.env.SCOPE_IT !== '1')('workforce engine routes: company scope (real auth)', { timeout: 180_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // vitest runs a skipped suite body while collecting
  const h = await createRouteHarness(state);
  const overview = await import('@/app/api/workforce/overview/route');
  const trueCost = await import('@/app/api/workforce/true-cost/route');
  const exitCost = await import('@/app/api/workforce/exit-cost/route');
  const hire = await import('@/app/api/workforce/hire-scenario/route');
  const saud = await import('@/app/api/workforce/saudization/route');
  const solve = await import('@/app/api/workforce/saudization/solve/route');
  const sens = await import('@/app/api/workforce/sensitivity/route');
  const rewards = await import('@/app/api/workforce/total-rewards/route');
  const options = await import('@/app/api/workforce/options/route');
  const assumptions = await import('@/app/api/workforce/assumptions/route');
  const rules = await import('@/app/api/workforce/rules/route');
  const nitaqat = await import('@/app/api/workforce/nitaqat/route');
  const decisions = await import('@/app/api/workforce/localization-decisions/route');
  const bench = await import('@/app/api/workforce/benchmarks/route');
  const exp = await import('@/app/api/workforce/export/route');
  const report = await import('@/app/api/workforce/report/route');

  const empA = h.users.empA.employeeId!;
  const empB = h.users.empB.employeeId!;
  const exitBody = (employeeId: string) => ({ employeeId, exitReason: 'RESIGNATION', lastWorkingDate: '2026-12-31', noticeServed: true, scenario: 'base' });
  const hireBody = (companyId: string) => ({ companyId, candidates: [{ kind: 'SAUDI', basicSalary: 6000 }] });
  // A company override of an assumption for each company: B's must never reach A's users.
  for (const k of ['A', 'B'] as const) {
    await h.prisma.workforceAssumption.create({ data: { key: 'VACANCY_MONTHS', companyId: h.co[k], value: k === 'A' ? 1 : 2 } });
  }
  afterAll(() => {
    delete process.env.RENDER_SERVICE_URL;
    delete process.env.RENDER_SERVICE_TOKEN;
  });

  it('every handler: 401 without a session, 403 for a role outside the workforce group', async () => {
    const calls: Array<[string, () => Promise<Response>]> = [
      ['overview', () => overview.GET(h.req('GET', '/api/workforce/overview'))],
      ['true-cost', () => trueCost.GET(h.req('GET', '/api/workforce/true-cost'))],
      ['exit-cost', () => exitCost.POST(h.req('POST', '/x', exitBody(empA)))],
      ['hire', () => hire.POST(h.req('POST', '/x', hireBody(h.co.A)))],
      ['saudization', () => saud.GET(h.req('GET', '/api/workforce/saudization'))],
      ['solve', () => solve.POST(h.req('POST', '/x', { companyId: h.co.A, targetBand: 'LOW_GREEN' }))],
      ['sensitivity GET', () => sens.GET(h.req('GET', '/api/workforce/sensitivity?decision=plan&planId=00000000-0000-4000-8000-000000000000'))],
      ['sensitivity POST', () => sens.POST(h.req('POST', '/x', { decision: 'exit', params: exitBody(empA) }))],
      ['total-rewards', () => rewards.GET(h.req('GET', `/api/workforce/total-rewards?employeeId=${empA}`))],
      ['options', () => options.GET()],
      ['assumptions GET', () => assumptions.GET(h.req('GET', '/api/workforce/assumptions'))],
      ['assumptions PUT', () => assumptions.PUT(h.req('PUT', '/x', { companyId: h.co.A, items: [{ key: 'VACANCY_MONTHS', value: 3 }] }))],
      ['rules GET', () => rules.GET()],
      ['rules POST', () => rules.POST(h.req('POST', '/x', {}))],
      ['nitaqat GET', () => nitaqat.GET(h.req('GET', '/api/workforce/nitaqat'))],
      ['nitaqat POST', () => nitaqat.POST(h.req('POST', '/x', {}))],
      ['decisions GET', () => decisions.GET()],
      ['decisions POST', () => decisions.POST(h.req('POST', '/x', {}))],
      ['benchmarks', () => bench.GET(h.req('GET', '/api/workforce/benchmarks'))],
      ['export GET', () => exp.GET(h.req('GET', '/api/workforce/export?kind=overview'))],
      ['export POST', () => exp.POST(h.req('POST', '/api/workforce/export?kind=exit-cost', exitBody(empA)))],
      ['report GET', () => report.GET(h.req('GET', '/api/workforce/report?kind=true-cost'))],
      ['report POST', () => report.POST(h.req('POST', '/api/workforce/report?kind=exit-cost', exitBody(empA)))],
    ];
    for (const [name, call] of calls) {
      await h.as(null);
      expect([name, (await call()).status]).toEqual([name, 401]);
      await h.as('empA');
      expect([name, (await call()).status]).toEqual([name, 403]);
      await h.as('payrollA'); // PAYROLL_ADMIN: staff, but not in the workforce group
      expect([name, (await call()).status]).toEqual([name, 403]);
    }
    // The legal registers are written by the owner (unrestricted) only.
    await h.as('hrA');
    for (const call of [() => rules.POST(h.req('POST', '/x', {})), () => nitaqat.POST(h.req('POST', '/x', {})), () => decisions.POST(h.req('POST', '/x', {}))]) {
      expect((await call()).status).toBe(403);
    }
  });

  it('overview / true cost: the caller\'s legal companies only; a company or employee outside them is 404', async () => {
    await h.as('hrA');
    const ov = await overview.GET(h.req('GET', '/api/workforce/overview'));
    expect(ov.status).toBe(200);
    const companies = (await ov.json()).legalCompanies.map((c: { companyId: string }) => c.companyId);
    expect(companies).toContain(h.co.A);
    expect(companies.every((id: string) => id === h.co.A)).toBe(true);

    const tc = await trueCost.GET(h.req('GET', '/api/workforce/true-cost?take=200'));
    expect(tc.status).toBe(200);
    const ids = (await tc.json()).employees.map((e: { employeeId: string }) => e.employeeId);
    expect(ids).toContain(empA);
    expect(ids).not.toContain(empB);
    expect((await trueCost.GET(h.req('GET', `/api/workforce/true-cost?companyId=${h.co.B}`))).status).toBe(404);
    expect((await trueCost.GET(h.req('GET', `/api/workforce/true-cost?branchId=${h.branch.B}`))).status).toBe(404);
    expect((await trueCost.GET(h.req('GET', `/api/workforce/true-cost?departmentId=${h.department.B}`))).status).toBe(404);
    expect((await trueCost.GET(h.req('GET', `/api/workforce/true-cost?employeeId=${empB}`))).status).toBe(404);
    expect((await trueCost.GET(h.req('GET', `/api/workforce/true-cost?employeeId=${empA}`))).status).toBe(200);

    await h.as('owner');
    const all = (await (await overview.GET(h.req('GET', '/api/workforce/overview'))).json()).legalCompanies.map((c: { companyId: string }) => c.companyId);
    expect(all).toEqual(expect.arrayContaining([h.co.A, h.co.B]));
    expect((await trueCost.GET(h.req('GET', `/api/workforce/true-cost?companyId=${h.co.B}`))).status).toBe(200);
  });

  it('exit cost / hire scenario / Saudization / solver / sensitivity / total rewards: another company is 404', async () => {
    await h.as('finA');
    expect((await exitCost.POST(h.req('POST', '/x', exitBody(empB)))).status).toBe(404);
    const own = await exitCost.POST(h.req('POST', '/x', exitBody(empA)));
    expect(own.status).toBe(200);
    expect((await own.json()).employee.id).toBe(empA);

    expect((await hire.POST(h.req('POST', '/x', hireBody(h.co.B)))).status).toBe(404);
    expect((await hire.POST(h.req('POST', '/x', hireBody(h.co.A)))).status).toBe(200);

    const sz = await saud.GET(h.req('GET', '/api/workforce/saudization'));
    expect(sz.status).toBe(200);
    const szIds = (await sz.json()).companies.map((c: { companyId: string }) => c.companyId);
    expect(szIds).toContain(h.co.A);
    expect(szIds).not.toContain(h.co.B);
    expect((await saud.GET(h.req('GET', `/api/workforce/saudization?companyId=${h.co.B}`))).status).toBe(404);
    expect((await solve.POST(h.req('POST', '/x', { companyId: h.co.B, targetBand: 'LOW_GREEN' }))).status).toBe(404);
    expect((await solve.POST(h.req('POST', '/x', { companyId: h.co.A, targetBand: 'LOW_GREEN' }))).status).not.toBe(404);

    expect((await sens.POST(h.req('POST', '/x', { decision: 'exit', params: exitBody(empB) }))).status).toBe(404);
    expect((await sens.POST(h.req('POST', '/x', { decision: 'hire', params: hireBody(h.co.B) }))).status).toBe(404);
    expect((await sens.POST(h.req('POST', '/x', { decision: 'exit', params: exitBody(empA) }))).status).toBe(200);

    expect((await rewards.GET(h.req('GET', `/api/workforce/total-rewards?employeeId=${empB}`))).status).toBe(404);
    expect((await rewards.GET(h.req('GET', `/api/workforce/total-rewards?employeeId=${empA}`))).status).toBe(200);

    await h.as('owner');
    expect((await exitCost.POST(h.req('POST', '/x', exitBody(empB)))).status).toBe(200);
  });

  it('options / benchmarks / registers: lists and usage counts of the caller\'s companies only', async () => {
    await h.as('hrB');
    const o = await (await options.GET()).json();
    expect(o.companies.map((c: { id: string }) => c.id)).toEqual([h.co.B]);
    expect(o.branches.map((b: { id: string }) => b.id)).toEqual([h.branch.B]);
    expect(o.departments.map((d: { id: string }) => d.id)).toEqual([h.department.B]);
    expect(o.employees.every((e: { companyId: string }) => e.companyId === h.co.B)).toBe(true);
    expect(o.employees.map((e: { id: string }) => e.id)).toContain(empB);

    expect((await bench.GET(h.req('GET', '/api/workforce/benchmarks'))).status).toBe(200);
    expect((await bench.GET(h.req('GET', `/api/workforce/benchmarks?companyId=${h.co.A}`))).status).toBe(404);
    expect((await bench.GET(h.req('GET', `/api/workforce/benchmarks?departmentId=${h.department.A}`))).status).toBe(404);
    expect((await bench.GET(h.req('GET', `/api/workforce/benchmarks?companyId=${h.co.B}`))).status).toBe(200);

    // Tenant-wide legal reference data: every workforce user reads it.
    expect((await rules.GET()).status).toBe(200);
    expect((await nitaqat.GET(h.req('GET', '/api/workforce/nitaqat'))).status).toBe(200);
    expect((await decisions.GET()).status).toBe(200);

    await h.as('owner');
    const all = await (await options.GET()).json();
    expect(all.companies.map((c: { id: string }) => c.id)).toEqual(expect.arrayContaining([h.co.A, h.co.B]));
  });

  it('assumptions: global defaults + own overrides only; editing another company or the global defaults is refused', async () => {
    await h.as('finA');
    const res = await assumptions.GET(h.req('GET', '/api/workforce/assumptions'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.companies.map((c: { id: string }) => c.id)).toEqual([h.co.A]);
    expect(body.companySettings.map((c: { id: string }) => c.id)).toEqual([h.co.A]);
    expect(body.canEditGlobal).toBe(false);
    expect((await assumptions.GET(h.req('GET', `/api/workforce/assumptions?companyId=${h.co.B}`))).status).toBe(400);
    const a = await (await assumptions.GET(h.req('GET', `/api/workforce/assumptions?companyId=${h.co.A}`))).json();
    expect(a.company.VACANCY_MONTHS.value).toBe(1);

    const put = (companyId: string) => h.req('PUT', '/x', { companyId, items: [{ key: 'VACANCY_MONTHS', value: 3 }] });
    expect((await assumptions.PUT(put(h.co.B))).status).toBe(400);
    expect((await assumptions.PUT(put(''))).status).toBe(403);
    expect((await h.prisma.workforceAssumption.findUniqueOrThrow({ where: { key_companyId: { key: 'VACANCY_MONTHS', companyId: h.co.B } } })).value).toBe(2);
    expect((await assumptions.PUT(put(h.co.A))).status).toBe(200);
    expect((await h.prisma.workforceAssumption.findUniqueOrThrow({ where: { key_companyId: { key: 'VACANCY_MONTHS', companyId: h.co.A } } })).value).toBe(3);

    await h.as('hrA'); // reads, may not edit
    expect((await assumptions.PUT(put(h.co.A))).status).toBe(403);
    await h.as('owner');
    const o = await (await assumptions.GET(h.req('GET', `/api/workforce/assumptions?companyId=${h.co.B}`))).json();
    expect(o.company.VACANCY_MONTHS.value).toBe(2);
    expect(o.canEditGlobal).toBe(true);
  });

  it('export / PDF report: the same scope as the screens (another company 404)', async () => {
    await h.as('hrA');
    const x = await exp.GET(h.req('GET', '/api/workforce/export?kind=overview'));
    expect(x.status).toBe(200);
    expect((await exp.GET(h.req('GET', `/api/workforce/export?kind=true-cost&companyId=${h.co.B}`))).status).toBe(404);
    expect((await exp.GET(h.req('GET', `/api/workforce/export?kind=benchmarks&companyId=${h.co.B}`))).status).toBe(404);
    expect((await exp.GET(h.req('GET', `/api/workforce/export?kind=saudization&companyId=${h.co.B}`))).status).toBe(404);
    expect((await exp.POST(h.req('POST', '/api/workforce/export?kind=exit-cost', exitBody(empB)))).status).toBe(404);
    expect((await exp.POST(h.req('POST', '/api/workforce/export?kind=hire-scenario', hireBody(h.co.B)))).status).toBe(404);

    // PDF: 503 before any computation without the report service; with an (unreachable) service the scope
    // checks run before rendering.
    expect((await report.GET(h.req('GET', '/api/workforce/report?kind=true-cost'))).status).toBe(503);
    process.env.RENDER_SERVICE_URL = 'http://127.0.0.1:9';
    process.env.RENDER_SERVICE_TOKEN = 'test';
    expect((await report.GET(h.req('GET', `/api/workforce/report?kind=true-cost&companyId=${h.co.B}`))).status).toBe(404);
    expect((await report.GET(h.req('GET', `/api/workforce/report?kind=true-cost&employeeId=${empB}`))).status).toBe(404);
    expect((await report.GET(h.req('GET', `/api/workforce/report?kind=saudization&companyId=${h.co.B}`))).status).toBe(404);
    expect((await report.GET(h.req('GET', `/api/workforce/report?kind=total-rewards&employeeId=${empB}`))).status).toBe(404);
    expect((await report.POST(h.req('POST', '/api/workforce/report?kind=exit-cost', exitBody(empB)))).status).toBe(404);
    expect((await report.POST(h.req('POST', '/api/workforce/report?kind=hire-scenario', hireBody(h.co.B)))).status).toBe(404);
  });
});
