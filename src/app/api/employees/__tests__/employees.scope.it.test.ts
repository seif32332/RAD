// P1-SCOPE (INV-SCOPE-01): /api/employees, /api/employees/[id], /api/employees/gosi-review and the
// export /api/employees/import/template on a real database with real sessions (src/test/route-harness.ts).
// Opt-in: SCOPE_IT=1 with DATABASE_URL on a throwaway database.
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';
import { DEFAULT_NATIONALITY } from '@/lib/employee';
import { moneyFixture } from '@/test/money-fixtures';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe.skipIf(process.env.SCOPE_IT !== '1')('employees routes: company scope (real auth)', { timeout: 60_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // skipped: build nothing (the harness writes to the database)
  const h = await createRouteHarness(state);
  const list = await import('@/app/api/employees/route');
  const item = await import('@/app/api/employees/[id]/route');
  const gosi = await import('@/app/api/employees/gosi-review/route');
  const template = await import('@/app/api/employees/import/template/route');

  const a = await h.employee('A');
  const b = await h.employee('B');
  // Registered on company B but working in A's branch: outside every context of company A.
  const stray = await h.employee('B', { branchId: h.branch.A, departmentId: h.department.A });

  it('list: 401 / 403; HR and finance of A see A only; a branch manager only his team inside his company; the owner all', async () => {
    const get = (q = '') => list.GET(h.req('GET', `/api/employees${q}`));
    await h.as(null);
    expect((await get()).status).toBe(401);
    await h.as('empA');
    expect((await get()).status).toBe(403);
    for (const who of ['hrA', 'finA'] as const) {
      await h.as(who);
      for (const q of ['', '?fields=basic']) {
        const rows = ids(await (await get(q)).json());
        expect(rows).toContain(a.id);
        expect(rows).not.toContain(b.id);
        expect(rows).not.toContain(stray.id);
      }
    }
    await h.as('branchMgrA');
    const team = ids(await (await get()).json());
    expect(team).toContain(a.id);
    expect(team).not.toContain(stray.id); // same branch, other legal company
    await h.as('owner');
    expect(ids(await (await get()).json())).toEqual(expect.arrayContaining([a.id, b.id, stray.id]));
  });

  it('detail: another company 404 (full, payroll and team levels); a non-team employee of his company 403', async () => {
    const off = await h.employee('A', { branchId: null, departmentId: null });
    await h.as(null);
    expect((await item.GET(h.req('GET', '/x'), h.params({ id: a.id }))).status).toBe(401);
    for (const who of ['hrB', 'finB', 'branchMgrB'] as const) {
      await h.as(who);
      expect((await item.GET(h.req('GET', '/x'), h.params({ id: a.id }))).status).toBe(404);
    }
    await h.as('branchMgrA');
    expect((await item.GET(h.req('GET', '/x'), h.params({ id: a.id }))).status).toBe(200);
    expect((await item.GET(h.req('GET', '/x'), h.params({ id: stray.id }))).status).toBe(404);
    expect((await item.GET(h.req('GET', '/x'), h.params({ id: off.id }))).status).toBe(403);
    await h.as('hrA');
    expect((await item.GET(h.req('GET', '/x'), h.params({ id: a.id }))).status).toBe(200);
  });

  it('update: another company 403 and unchanged; moving an employee to another company 403', async () => {
    await h.as('hrB');
    expect((await item.PUT(h.req('PUT', '/x', { jobTitle: 'مخترق' }), h.params({ id: a.id }))).status).toBe(403);
    await h.as('hrA');
    expect((await item.PUT(h.req('PUT', '/x', { legalCompanyId: h.co.B }), h.params({ id: a.id }))).status).toBe(403);
    expect((await item.PUT(h.req('PUT', '/x', { jobTitle: `محاسب ${h.tag}` }), h.params({ id: a.id }))).status).toBe(200);
    const row = await h.prisma.employee.findUnique({ where: { id: a.id } });
    expect(row?.legalCompanyId).toBe(h.co.A);
    expect(row?.jobTitle).toBe(`محاسب ${h.tag}`);
  });

  it('create: own company 201; another company or no company 403; finance 403; a shared IBAN never names an employee of another company', async () => {
    const iban = `SA03800000006080${h.tag.slice(0, 8)}`.slice(0, 24);
    await moneyFixture((tx) => tx.employee.update({ where: { id: b.id }, data: { ibanNumber: iban } })); // a pay column: fixture of money.gateway
    const body = (over: Record<string, unknown>) => ({
      firstNameArabic: 'جديد', lastNameArabic: h.tag, dateOfBirth: '1990-01-01', nationality: DEFAULT_NATIONALITY, gender: 'MALE',
      iqamaOrIdNumber: `N${h.tag}${h.next()}`, iqamaOrIdExp: '2030-01-01', joinDate: '2024-01-01', basicSalary: 5000, ...over,
    });
    await h.as('finA');
    expect((await list.POST(h.req('POST', '/api/employees', body({ legalCompanyId: h.co.A })))).status).toBe(403);
    await h.as('hrA');
    expect((await list.POST(h.req('POST', '/api/employees', body({ legalCompanyId: h.co.B })))).status).toBe(403);
    expect((await list.POST(h.req('POST', '/api/employees', body({})))).status).toBe(403);
    expect((await list.POST(h.req('POST', '/api/employees', body({ legalCompanyId: h.co.A, actualCompanyId: h.co.B })))).status).toBe(403);
    const res = await list.POST(h.req('POST', '/api/employees', body({ legalCompanyId: h.co.A, actualCompanyId: h.co.A, ibanNumber: iban })));
    expect(res.status).toBe(201);
    expect(JSON.stringify((await res.json()).warnings)).not.toContain(b.employeeId);
    await h.as('owner');
    expect((await list.POST(h.req('POST', '/api/employees', body({})))).status).toBe(201); // unrestricted: no company is allowed
  });

  it('gosi-review: lists and confirms only employees of the user companies', async () => {
    const ua = await h.employee('A', { nationality: DEFAULT_NATIONALITY, gosiRegime: 'UNKNOWN' });
    const ub = await h.employee('B', { nationality: DEFAULT_NATIONALITY, gosiRegime: 'UNKNOWN' });
    await h.as(null);
    expect((await gosi.GET(h.req('GET', '/api/employees/gosi-review'))).status).toBe(401);
    await h.as('empA');
    expect((await gosi.GET(h.req('GET', '/api/employees/gosi-review'))).status).toBe(403);
    await h.as('payrollA');
    const listed = ids((await (await gosi.GET(h.req('GET', '/api/employees/gosi-review'))).json()).employees);
    expect(listed).toContain(ua.id);
    expect(listed).not.toContain(ub.id);
    const confirm = (id: string) => gosi.POST(h.req('POST', '/api/employees/gosi-review', { items: [{ employeeId: id, regime: 'NEW', source: 'شهادة اشتراك' }] }));
    expect((await confirm(ub.id)).status).toBe(400);
    expect((await h.prisma.employee.findUnique({ where: { id: ub.id } }))?.gosiRegime).toBe('UNKNOWN');
    expect((await confirm(ua.id)).status).toBe(200);
    expect((await h.prisma.employee.findUnique({ where: { id: ua.id } }))?.gosiRegime).toBe('NEW');
  });

  it('export template: HR only; the filled export holds the employees of the user companies only', async () => {
    const url = '/api/employees/import/template?withEmployees=1';
    await h.as(null);
    expect((await template.GET(h.req('GET', url))).status).toBe(401);
    await h.as('finA');
    expect((await template.GET(h.req('GET', url))).status).toBe(403);
    for (const k of ['A', 'B'] as const) {
      await h.as(k === 'A' ? 'hrA' : 'hrB');
      const res = await template.GET(h.req('GET', url));
      expect(res.status).toBe(200);
      const expected = await h.prisma.employee.count({ where: { legalCompanyId: h.co[k], isTerminated: false } });
      expect(Number(res.headers.get('X-Row-Count'))).toBe(expected);
    }
  });
});
