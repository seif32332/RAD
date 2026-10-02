// P1-PAY-B (BL-PAY-004): the financial change routes and the changed pay writers on a real database with
// real sessions (src/test/route-harness.ts): allow, deny and other-company for
//   /api/financial-changes (GET, POST bulk), /api/financial-changes/:id (GET, POST),
//   /api/portal/financial-changes (GET, POST), and the changed writers: employee create / edit (pay as a
//   request), the portal data update (IBAN as the employee's own request), attendance-corrections (no IBAN).
// Opt-in: SCOPE_IT=1 with DATABASE_URL on a throwaway database.
import { randomUUID } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import { createRouteHarness } from '@/test/route-harness';
import { moneyFixture } from '@/test/money-fixtures';

const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
  headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
}));
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));

describe.skipIf(process.env.SCOPE_IT !== '1')('financial change routes: company scope, second person (real auth)', { timeout: 180_000 }, async () => {
  if (process.env.SCOPE_IT !== '1') return; // collected but skipped: never touch the database
  const h = await createRouteHarness(state);
  const list = await import('@/app/api/financial-changes/route');
  const one = await import('@/app/api/financial-changes/[id]/route');
  const portal = await import('@/app/api/portal/financial-changes/route');
  const correction = await import('@/app/api/portal/correction/route');
  const corrections = await import('@/app/api/attendance-corrections/route');
  const employees = await import('@/app/api/employees/route');
  const employeeOne = await import('@/app/api/employees/[id]/route');
  const comp = await import('@/modules/compensation');
  const { ibanCheckDigits } = await import('@/lib/iban');
  const iban = (seed: number) => {
    const bban = `80${String(seed).padStart(18, '0')}`;
    return `SA${ibanCheckDigits('SA', bban)}${bban}`;
  };
  const actor = (who: 'hrA' | 'hrB') => ({ id: h.users[who].id, role: 'HR_MANAGER', employeeId: null });
  const file = (who: 'hrA' | 'hrB', employeeId: string, basicSalary: number, batchKey?: string) =>
    comp.runCompensationTransaction(h.prisma, (tx) =>
      comp.requestFinancialChange(tx, { actor: actor(who), employeeId, source: 'EDIT', compensation: { basicSalary, allowances: [] }, batchKey, operationKey: `it:${randomUUID()}` }),
    );
  const empA = await h.employee('A');
  const empB = await h.employee('B');
  const reqA = (await file('hrA', empA.id, 6100)).changes[0];
  const reqB = (await file('hrB', empB.id, 6200)).changes[0];
  const ids = (body: { changes: Array<{ id: string }> }) => body.changes.map((c) => c.id);

  it('GET list: 401 / 403, payroll of A sees A only, the owner both; never the IBAN', async () => {
    await h.as(null);
    expect((await list.GET(h.req('GET', '/api/financial-changes'))).status).toBe(401);
    for (const who of ['empA', 'branchMgrA', 'govA'] as const) {
      await h.as(who);
      expect((await list.GET(h.req('GET', '/api/financial-changes'))).status).toBe(403);
    }
    await h.as('payrollA');
    const a = await (await list.GET(h.req('GET', '/api/financial-changes'))).json();
    expect(ids(a)).toContain(reqA.id);
    expect(ids(a)).not.toContain(reqB.id);
    expect(a.changes.find((c: { id: string }) => c.id === reqA.id).employee.code).toBe(empA.employeeId);
    await h.as('owner');
    expect(ids(await (await list.GET(h.req('GET', '/api/financial-changes'))).json())).toEqual(expect.arrayContaining([reqA.id, reqB.id]));
  });

  it('GET one: another company is 404, own company 200', async () => {
    await h.as('payrollA');
    expect((await one.GET(h.req('GET', '/x'), h.params({ id: reqB.id }))).status).toBe(404);
    expect((await one.GET(h.req('GET', '/x'), h.params({ id: reqA.id }))).status).toBe(200);
    await h.as('empA');
    expect((await one.GET(h.req('GET', '/x'), h.params({ id: reqA.id }))).status).toBe(403);
  });

  it('POST decide: another company 404 and untouched; the requester 403 (second person); the second person applies once (double call replays); a third 409', async () => {
    await h.as('payrollB');
    expect((await one.POST(h.req('POST', '/x', { action: 'APPROVE' }), h.params({ id: reqA.id }))).status).toBe(404);
    expect((await h.prisma.employeeFinancialChange.findUniqueOrThrow({ where: { id: reqA.id } })).status).toBe('PENDING');
    await h.as('hrA');
    const self = await one.POST(h.req('POST', '/x', { action: 'APPROVE' }), h.params({ id: reqA.id }));
    expect(self.status).toBe(403);
    expect((await self.json()).details).toMatchObject({ code: 'MONEY_GUARD_BLOCKED', reasons: ['SAME_PERSON_TWICE'] });
    await h.as('payrollA');
    const ok = await one.POST(h.req('POST', '/x', { action: 'APPROVE' }), h.params({ id: reqA.id }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).change.status).toBe('APPLIED');
    const again = await one.POST(h.req('POST', '/x', { action: 'APPROVE' }), h.params({ id: reqA.id }));
    expect([again.status, (await again.json()).replayed]).toEqual([200, true]);
    expect((await h.prisma.employee.findUniqueOrThrow({ where: { id: empA.id } })).basicSalary).toBe(6100);
    await h.as('finA');
    expect((await one.POST(h.req('POST', '/x', { action: 'APPROVE' }), h.params({ id: reqA.id }))).status).toBe(409);
  });

  it('POST bulk by import batch: the other company decides nothing; the second person decides each row', async () => {
    const batchKey = `it:batch:${randomUUID()}`;
    const e1 = await h.employee('A');
    const e2 = await h.employee('A');
    await file('hrA', e1.id, 7000, batchKey);
    await file('hrA', e2.id, 7100, batchKey);
    await h.as('payrollB');
    expect((await (await list.POST(h.req('POST', '/x', { decision: 'APPROVE', batchKey }))).json()).results).toEqual([]);
    await h.as('hrA');
    const mine = await (await list.POST(h.req('POST', '/x', { decision: 'APPROVE', batchKey }))).json();
    expect(mine.results.map((r: { ok: boolean }) => r.ok)).toEqual([false, false]);
    await h.as('finA');
    const done = await (await list.POST(h.req('POST', '/x', { decision: 'APPROVE', batchKey }))).json();
    expect(done.results.map((r: { ok: boolean; status: string }) => [r.ok, r.status])).toEqual([[true, 'APPLIED'], [true, 'APPLIED']]);
    await h.as('empA');
    expect((await list.POST(h.req('POST', '/x', { decision: 'APPROVE', batchKey }))).status).toBe(403);
  });

  it('portal: the employee sees and confirms his own (legacy) IBAN request only', async () => {
    const legacy = await moneyFixture((t) =>
      t.employeeFinancialChange.create({
        data: {
          employeeId: h.users.empA.employeeId!, companyId: h.co.A, field: 'BANK_IDENTITY', source: 'PORTAL', status: 'LEGACY_UNVERIFIED', effectiveDate: new Date(),
          ibanEncrypted: iban(5), ibanFingerprint: comp.ibanFingerprint(iban(5)), ibanLast4: iban(5).slice(-4), paymentMethod: 'BANK_TRANSFER', operationKey: `legacy-iban:${randomUUID()}`,
        },
      }),
    );
    await h.as(null);
    expect((await portal.GET()).status).toBe(401);
    await h.as('empB');
    expect((await portal.GET()).status).toBe(200);
    expect(ids(await (await portal.GET()).json())).not.toContain(legacy.id);
    expect((await portal.POST(h.req('POST', '/x', { id: legacy.id, action: 'CONFIRM' }))).status).toBe(404);
    await h.as('empA');
    const mine = await (await portal.GET()).json();
    expect(mine.changes.find((c: { id: string }) => c.id === legacy.id).ibanToConfirm).toBe(iban(5));
    const ok = await portal.POST(h.req('POST', '/x', { id: legacy.id, action: 'CONFIRM' }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).change).toMatchObject({ status: 'PENDING', requestedById: h.users.empA.id });
  });

  it('portal data update: the IBAN becomes the employee\'s own financial change (masked in the request text); attendance-corrections refuses an IBAN line', async () => {
    const reason = `[طلب: تحديث بيانات]\nالجوال: 0500000000\nالآيبان: ${iban(6)}\nاسم البنك: بنك`;
    await h.as('empB');
    const res = await correction.POST(h.req('POST', '/x', { date: '2026-10-01', reason, correctionType: 'GENERAL' }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.financialChange).toMatchObject({ field: 'BANK_IDENTITY', source: 'PORTAL', status: 'PENDING', employeeId: h.users.empB.employeeId });
    expect(body.request.reason).not.toContain(iban(6));
    expect(body.request.reason).toContain(iban(6).slice(-4));
    await h.as('hrA');
    expect((await corrections.POST(h.req('POST', '/x', { employeeId: h.users.empA.employeeId, date: '2026-10-01', reason }))).status).toBe(403);
  });

  it('employee create / edit: the pay is a request (nothing in force); another company 403; an IBAN replacement from the file 403', async () => {
    const n = randomUUID().slice(0, 6);
    const payload = {
      firstNameArabic: 'جديد', lastNameArabic: n, dateOfBirth: '1990-01-01', nationality: 'SA', gender: 'MALE', iqamaOrIdNumber: `1${Date.now()}`.slice(0, 10),
      iqamaOrIdExp: '2031-01-01', joinDate: '2026-09-01', basicSalary: 8000, salaryPaymentMethod: 'BANK_TRANSFER', ibanNumber: iban(7), bankName: 'بنك',
      legalCompanyId: h.co.A, actualCompanyId: h.co.A, branchId: h.branch.A,
    };
    await h.as('hrB');
    expect((await employees.POST(h.req('POST', '/x', payload))).status).toBe(403);
    await h.as('hrA');
    const created = await employees.POST(h.req('POST', '/x', payload));
    expect(created.status).toBe(201);
    const body = await created.json();
    expect([body.employee.basicSalary, body.employee.payrollReady, body.employee.ibanNumber]).toEqual([0, false, null]);
    expect(body.financialChanges.map((c: { field: string }) => c.field).sort()).toEqual(['BANK_IDENTITY', 'COMPENSATION']);

    // Edit: a salary change is a request; the IBAN on file is the employee's own (portal) request.
    const edit = await employeeOne.PUT(h.req('PUT', '/x', { basicSalary: 6600 }), h.params({ id: empB.id }));
    expect(edit.status).toBe(403);
    expect(await h.prisma.employeeFinancialChange.count({ where: { employeeId: empB.id, status: 'PENDING', requestedById: h.users.hrA.id } })).toBe(0);
    const e = await h.employee('A', { ibanNumber: iban(8), bankName: 'بنك' });
    const changed = await employeeOne.PUT(h.req('PUT', '/x', { basicSalary: 6600 }), h.params({ id: e.id }));
    expect(changed.status).toBe(200);
    const cb = await changed.json();
    expect([cb.employee.basicSalary, cb.financialChanges[0].status]).toEqual([6000, 'PENDING']);
    const replaced = await employeeOne.PUT(h.req('PUT', '/x', { ibanNumber: iban(9) }), h.params({ id: e.id }));
    expect(replaced.status).toBe(403);
    expect((await replaced.json()).details).toMatchObject({ code: 'IBAN_SELF_SERVICE_ONLY' });
  });
});
