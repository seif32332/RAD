// P1-SCOPE (INV-SCOPE-01): /api/payroll-hub (GET, POST), /generate, /summary and /export on a real
// database with real sessions (src/test/route-harness.ts). Month-level generation, approval and payment
// cover the user's companies only. Opt-in: SCOPE_IT=1 with DATABASE_URL on a throwaway database.
import { describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { createRouteHarness } from '@/test/route-harness';
import { moneyFixture, payrollLineFixture } from '@/test/money-fixtures';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe.skipIf(process.env.SCOPE_IT !== '1')('payroll-hub routes: company scope (real auth)', { timeout: 120_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // collected but skipped: never touch the database
  const h = await createRouteHarness(state);
  const hub = await import('@/app/api/payroll-hub/route');
  const generate = await import('@/app/api/payroll-hub/generate/route');
  const summary = await import('@/app/api/payroll-hub/summary/route');
  const exporter = await import('@/app/api/payroll-hub/export/route');
  const empA = await h.employee('A');
  const empB = await h.employee('B');
  const dA = await moneyFixture((tx) => tx.deduction.create({ data: { employeeId: empA.id, date: new Date('2026-09-01'), amount: 50, reason: 'تأخير', status: 'PENDING_AMOUNT_APPROVAL' } }));
  const dB = await moneyFixture((tx) => tx.deduction.create({ data: { employeeId: empB.id, date: new Date('2026-09-01'), amount: 50, reason: 'تأخير', status: 'PENDING_AMOUNT_APPROVAL' } }));
  const otA = await h.prisma.overtimeRequest.create({ data: { employeeId: empA.id, date: new Date('2026-09-02'), hours: 2 } }); // PENDING (default)
  // A month no other test uses; generation of company A must never touch company B.
  const year = 2040 + (parseInt(h.tag.slice(0, 4), 16) % 50);
  const month = 1 + (parseInt(h.tag.slice(4, 6), 16) % 12);
  const payB = await moneyFixture((tx) => payrollLineFixture(tx, { employeeId: empB.id, month, year, basicSalary: 6000, netSalary: 6000, status: 'DRAFT' }));
  const employeesOf = async (co: string) => (await h.prisma.employee.findMany({ where: { legalCompanyId: co }, select: { id: true } })).map((e) => e.id);

  it('GET: 401 / 403, payroll of A sees A only, the manager of A his team only, the owner both', async () => {
    await h.as(null);
    expect((await hub.GET(h.req('GET', '/api/payroll-hub'))).status).toBe(401);
    await h.as('empA');
    expect((await hub.GET(h.req('GET', '/api/payroll-hub'))).status).toBe(403);
    await h.as('payrollA');
    const a = await (await hub.GET(h.req('GET', '/api/payroll-hub?sections=deductions,payrolls,overtimes&take=500&skip=0'))).json();
    expect(ids(a.deductions)).toContain(dA.id);
    expect(ids(a.deductions)).not.toContain(dB.id);
    expect(ids(a.payrolls)).not.toContain(payB.id);
    expect(ids(a.overtimes)).toContain(otA.id);
    await h.as('branchMgrA');
    const m = await (await hub.GET(h.req('GET', '/api/payroll-hub'))).json();
    expect(ids(m.deductions)).toContain(dA.id);
    expect(ids(m.deductions)).not.toContain(dB.id);
    await h.as('owner');
    expect(ids((await (await hub.GET(h.req('GET', '/api/payroll-hub?sections=deductions'))).json()).deductions)).toEqual(expect.arrayContaining([dA.id, dB.id]));
  });

  it('POST on a row: another company 404 and untouched; own company once (same user again replays, another user 409)', async () => {
    await h.as('payrollB');
    const ot = { actionType: 'UPDATE_OVERTIME_STATUS', payload: { id: otA.id, status: 'APPROVED' } };
    expect((await hub.POST(h.req('POST', '/x', ot))).status).toBe(404);
    expect((await hub.POST(h.req('POST', '/x', { actionType: 'WAIVE_DEDUCTION', payload: { id: dA.id } }))).status).toBe(404);
    const key = { 'idempotency-key': `k-${h.tag}-other` };
    expect(
      (await hub.POST(h.req('POST', '/x', { actionType: 'CREATE_DEDUCTION', payload: { employeeId: empA.id, date: '2026-09-05', amount: 10, reason: 'x' } }, key))).status,
    ).toBe(404);
    expect((await hub.POST(h.req('POST', '/x', { actionType: 'CREATE_LOAN', payload: { employeeId: empA.id, amount: 1000, monthlyInstallment: 100 } }, key))).status).toBe(404);
    expect((await h.prisma.overtimeRequest.findUnique({ where: { id: otA.id } }))?.status).toBe('PENDING');
    expect(await h.prisma.loan.count({ where: { employeeId: empA.id } })).toBe(0);
    await h.as('branchMgrB');
    expect((await hub.POST(h.req('POST', '/x', { actionType: 'REQUEST_WAIVE_DEDUCTION', payload: { id: dA.id } }))).status).toBe(404);
    await h.as('empB');
    expect((await hub.POST(h.req('POST', '/x', { actionType: 'SUBMIT_OBJECTION', payload: { id: dA.id, objectionText: 'ليست مخالفتي' } }))).status).toBe(404);
    await h.as('payrollA');
    expect((await hub.POST(h.req('POST', '/x', ot))).status).toBe(200);
    expect((await hub.POST(h.req('POST', '/x', ot))).status).toBe(200); // the operation key replays (LIFECYCLE_MODEL §2.2)
    await h.as('hrA');
    expect((await hub.POST(h.req('POST', '/x', ot))).status).toBe(409);
  });

  it('creations need a per-form Idempotency-Key (BL-PAY-027): none → 400 and nothing written; the same key twice → one row; another company 404', async () => {
    const e = await h.employee('A');
    const bodies = {
      CREATE_OVERTIME_ASSIGNMENT: { employeeId: e.id, date: '2031-03-04', type: 'HOURS', hours: 2 },
      CREATE_DEDUCTION: { employeeId: e.id, date: '2031-03-04', amount: 10, reason: 'تأخير' },
      CREATE_LOAN: { employeeId: e.id, amount: 1000, monthlyInstallment: 100 },
      CREATE_BONUS: { employeeId: e.id, name: 'مكافأة', amount: 250, payrollMonth: 3, payrollYear: 2031 },
    } as const;
    const counts = async () => [
      await h.prisma.overtimeRequest.count({ where: { employeeId: e.id } }),
      await h.prisma.deduction.count({ where: { employeeId: e.id } }),
      await h.prisma.loan.count({ where: { employeeId: e.id } }),
      await h.prisma.allowance.count({ where: { employeeId: e.id, isMonthly: false } }),
    ];
    await h.as('payrollA');
    for (const [actionType, payload] of Object.entries(bodies)) {
      const res = await hub.POST(h.req('POST', '/x', { actionType, payload }));
      expect(res.status, actionType).toBe(400);
      const body = await res.json();
      expect(body.details, actionType).toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
      expect(body.error, actionType).toContain('مفتاح العملية');
    }
    expect(await counts()).toEqual([0, 0, 0, 0]);
    for (const [actionType, payload] of Object.entries(bodies)) {
      const key = { 'idempotency-key': `form-${actionType}-${h.tag}` };
      const first = await hub.POST(h.req('POST', '/x', { actionType, payload }, key));
      expect(first.status, actionType).toBe(200);
      const again = await hub.POST(h.req('POST', '/x', { actionType, payload }, key)); // double click / retry
      expect(again.status, actionType).toBe(200);
      expect((await again.json()).data.id, actionType).toBe((await first.json()).data.id);
    }
    expect(await counts()).toEqual([1, 1, 1, 1]);
    // A new form (new key) is a new row.
    expect((await hub.POST(h.req('POST', '/x', { actionType: 'CREATE_LOAN', payload: bodies.CREATE_LOAN }, { 'idempotency-key': `form-2-${h.tag}` }))).status).toBe(200);
    expect((await counts())[2]).toBe(2);
    await h.as('payrollB');
    expect((await hub.POST(h.req('POST', '/x', { actionType: 'CREATE_BONUS', payload: bodies.CREATE_BONUS }, { 'idempotency-key': `form-b-${h.tag}` }))).status).toBe(404);
    expect((await counts())[3]).toBe(1);
  });

  it('generate: 403 for a manager; payroll of A generates the drafts of A only (twice = still one draft each)', async () => {
    await h.as('branchMgrA');
    expect((await generate.POST(h.req('POST', '/x', { month, year }))).status).toBe(403);
    await h.as('payrollA');
    expect((await generate.POST(h.req('POST', '/x', { month, year }))).status).toBe(200);
    expect((await generate.POST(h.req('POST', '/x', { month, year }))).status).toBe(200);
    const aIds = await employeesOf(h.co.A);
    // This harness's two companies only: other test files may hold lines of the same month (shared database).
    const drafts = await h.prisma.payroll.findMany({ where: { month, year, companyId: { in: [h.co.A, h.co.B] } }, select: { employeeId: true, id: true } });
    const ofA = drafts.filter((d) => aIds.includes(d.employeeId));
    expect(ofA.length).toBe(aIds.length);
    expect(new Set(ofA.map((d) => d.employeeId)).size).toBe(ofA.length);
    expect(drafts.filter((d) => !aIds.includes(d.employeeId)).map((d) => d.id)).toEqual([payB.id]); // B untouched
  });

  it('summary and export: the month of another company is empty; own company has the rows', async () => {
    await h.as('payrollB');
    const sB = await (await summary.GET(h.req('GET', `/api/payroll-hub/summary?month=${month}&year=${year}`))).json();
    expect(sB.summary.count).toBe(1); // B's own draft only
    await h.as('payrollA');
    const sA = await (await summary.GET(h.req('GET', `/api/payroll-hub/summary?month=${month}&year=${year}`))).json();
    expect(sA.summary.count).toBe((await employeesOf(h.co.A)).length);
    const rowsOf = async () => {
      const res = await exporter.GET(h.req('GET', `/api/payroll-hub/export?month=${month}&year=${year}`));
      expect(res.status).toBe(200);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as unknown as ArrayBuffer);
      const codes: string[] = [];
      wb.worksheets[0].eachRow((r) => codes.push(String(r.getCell(1).value ?? '')));
      return codes;
    };
    const codesA = await rowsOf();
    expect(codesA).toContain(empA.employeeId);
    expect(codesA).not.toContain(empB.employeeId);
    await h.as('payrollB');
    const codesB = await rowsOf();
    expect(codesB).toContain(empB.employeeId);
    expect(codesB).not.toContain(empA.employeeId);
  });

  it('month approval / payment: company B cannot approve or pay A; A approves and pays once (second call 409)', async () => {
    const approve = { actionType: 'APPROVE_DRAFTS', payload: { month, year } };
    const pay = { actionType: 'MARK_PAYROLL_PAID', payload: { month, year } };
    await h.as('payrollA');
    expect((await hub.POST(h.req('POST', '/x', approve))).status).toBe(200);
    expect((await hub.POST(h.req('POST', '/x', approve))).status).toBe(409);
    expect((await h.prisma.payroll.findUnique({ where: { id: payB.id } }))?.status).toBe('DRAFT');
    await h.as('finB');
    expect((await hub.POST(h.req('POST', '/x', pay))).status).toBe(409); // nothing approved in B
    const aIds = await employeesOf(h.co.A);
    expect(await h.prisma.payroll.count({ where: { month, year, employeeId: { in: aIds }, status: 'PAID' } })).toBe(0);
    await h.as('finA');
    expect((await hub.POST(h.req('POST', '/x', pay))).status).toBe(200);
    expect((await hub.POST(h.req('POST', '/x', pay))).status).toBe(409);
    expect(await h.prisma.payroll.count({ where: { month, year, employeeId: { in: aIds }, status: { not: 'PAID' } } })).toBe(0);
    expect((await h.prisma.payroll.findUnique({ where: { id: payB.id } }))?.status).toBe('DRAFT');
  });
});
