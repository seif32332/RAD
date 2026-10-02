// /api/settings/integrity and /api/settings/integrity/[id] (P1-FND-INV owner dashboard) against a real
// PostgreSQL (migrations applied, including 9w_invariants_discrepancies).
// Opt-in: INV_IT=1 with DATABASE_URL pointing at a THROWAWAY database.
//
// Authentication is real (CLAUDE.md, ARCH-016): each call carries a session token signed by
// src/lib/session.ts for a real User row and requireUser() verifies it against the database. Only
// `cookies()` of next/headers is replaced (no request scope in vitest). Covers allow, deny (no session,
// wrong role, second person, beneficiary) and the other company.
import { randomUUID } from 'crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const RUN = process.env.INV_IT === '1';

const state = vi.hoisted(() => ({ token: undefined as string | undefined }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'radeef_session' && state.token ? { name, value: state.token } : undefined),
  }),
}));

describe.skipIf(!RUN)('integrity dashboard routes: allow, deny, other company (P1-FND-INV)', { timeout: 120_000 }, async () => {
  const { prisma } = await import('@/lib/prisma');
  const { signSession } = await import('@/lib/session');
  const { fingerprintOf, reconcile } = await import('@/modules/platform');
  const list = await import('@/app/api/settings/integrity/route');
  const one = await import('@/app/api/settings/integrity/[id]/route');

  const tag = randomUUID().slice(0, 8);
  const digits = tag.replace(/\D/g, '').padEnd(4, '5').slice(0, 4);
  let seq = 0;
  const iqama = () => `2${digits}${String(++seq).padStart(5, '0')}`;
  const co = { A: '', B: '' };
  const branch = { A: '', B: '' };
  const bad = { A: '', B: '' };
  const users: Record<'payA' | 'hrA' | 'payB' | 'owner' | 'employee', { id: string; role: string }> = {
    payA: { id: '', role: 'PAYROLL_ADMIN' },
    hrA: { id: '', role: 'HR_MANAGER' },
    payB: { id: '', role: 'PAYROLL_ADMIN' },
    owner: { id: '', role: 'SUPER_ADMIN' },
    employee: { id: '', role: 'EMPLOYEE' },
  };

  async function as(who: keyof typeof users | null) {
    if (!who) {
      state.token = undefined;
      return;
    }
    const u = users[who];
    state.token = await signSession({ sub: u.id, role: u.role, passwordHash: 'x', sessionVersion: 0 });
  }

  const get = () => list.GET(new Request('http://localhost/api/settings/integrity'));
  const run = () =>
    list.POST(new Request('http://localhost/api/settings/integrity', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'reconcile' }) }));
  const act = (id: string, body: Record<string, unknown>) =>
    one.POST(
      new Request(`http://localhost/api/settings/integrity/${id}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': '10.0.0.7' }, body: JSON.stringify(body) }),
      { params: Promise.resolve({ id }) },
    );
  const rowOf = (employeeId: string) =>
    prisma.discrepancy.findUniqueOrThrow({
      where: { fingerprint: fingerprintOf({ ruleId: 'INV-ORG-01', checkId: 'branch-not-in-actual-company', entityType: 'Employee', entityId: employeeId, period: null }) },
    });

  beforeAll(async () => {
    for (const k of ['A', 'B'] as const) {
      const c = await prisma.company.create({
        data: { nameArabic: `شركة لوحة ${k} ${tag}`, commercialRegNum: `7${k}${tag}${Date.now()}`.slice(0, 20), commercialRegExp: new Date('2030-01-01') },
      });
      co[k] = c.id;
      branch[k] = (await prisma.branch.create({ data: { companyId: c.id, nameArabic: `فرع ${k}` } })).id;
    }
    // One INV-ORG-01 finding per company: the employee's branch belongs to the other company.
    for (const [k, other] of [['A', 'B'], ['B', 'A']] as const) {
      bad[k] = (
        await prisma.employee.create({
          data: {
            employeeId: `IR-${tag}-${k}`, firstNameArabic: 'موظف', lastNameArabic: 'لوحة', nationality: 'سعودي', iqamaOrIdNumber: iqama(),
            iqamaOrIdExp: new Date('2030-01-01'), dateOfBirth: new Date('1990-01-01'), gender: 'MALE', joinDate: new Date('2020-01-01'),
            basicSalary: 7000, legalCompanyId: co[k], actualCompanyId: co[k], branchId: branch[other],
          },
        })
      ).id;
    }
    for (const [key, u] of Object.entries(users)) {
      u.id = (await prisma.user.create({ data: { email: `inv-${key}-${tag}@example.test`, passwordHash: 'x', role: u.role as 'HR_MANAGER' } })).id;
    }
    await prisma.userCompanyScope.createMany({
      data: [
        { userId: users.payA.id, companyId: co.A },
        { userId: users.hrA.id, companyId: co.A },
        { userId: users.payB.id, companyId: co.B },
      ],
    });
    await reconcile(prisma, { companyId: co.A });
    await reconcile(prisma, { companyId: co.B });
  });

  beforeEach(() => {
    state.token = undefined;
  });

  it('deny: no session -> 401; an employee -> 403 (read and action)', async () => {
    expect((await get()).status).toBe(401);
    await as('employee');
    expect((await get()).status).toBe(403);
    const d = await rowOf(bad.A);
    expect((await act(d.id, { action: 'approve-explanation', expectedVersion: d.version })).status).toBe(403);
  });

  it('allow: payroll of company A sees the findings of A, never those of B nor the tenant-level ones', async () => {
    await as('payA');
    const res = await get();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { discrepancies: { subjectEmployeeId: string | null; companyId: string | null }[]; seesTenantLevel: boolean; companies: { id: string }[] };
    const ids = body.discrepancies.map((d) => d.subjectEmployeeId);
    expect(ids).toContain(bad.A);
    expect(ids).not.toContain(bad.B);
    expect(body.discrepancies.every((d) => d.companyId === co.A)).toBe(true);
    expect(body.seesTenantLevel).toBe(false);
    expect(body.companies.map((c) => c.id)).toEqual([co.A]);
  });

  it('other company: payroll of B cannot act on a finding of A (403) and does not see it', async () => {
    await as('payB');
    const listed = (await (await get()).json()) as { discrepancies: { subjectEmployeeId: string | null }[] };
    expect(listed.discrepancies.map((d) => d.subjectEmployeeId)).not.toContain(bad.A);
    const d = await rowOf(bad.A);
    const res = await act(d.id, { action: 'explain', expectedVersion: d.version, explanation: 'محاولة من شركة أخرى للشرح', reference: 'X-1' });
    expect(res.status).toBe(403);
    expect((await rowOf(bad.A)).status).toBe('OPEN');
  });

  it('allow + second person: A explains, the same person cannot approve, another person of A approves', async () => {
    const d = await rowOf(bad.A);
    await as('payA');
    const explained = await act(d.id, { action: 'explain', expectedVersion: d.version, explanation: 'الفرع مستعار مؤقتاً بقرار إداري موثق', reference: 'DEC-88' });
    expect(explained.status).toBe(200);
    const e = (await explained.json()) as { status: string; pendingAction: string; version: number; replayed: boolean };
    expect(e).toMatchObject({ status: 'OPEN', pendingAction: 'EXPLANATION', replayed: false });
    // A double submit of the same form replays.
    const again = await act(d.id, { action: 'explain', expectedVersion: d.version, explanation: 'الفرع مستعار مؤقتاً بقرار إداري موثق', reference: 'DEC-88' });
    expect(((await again.json()) as { replayed: boolean }).replayed).toBe(true);
    expect((await act(d.id, { action: 'approve-explanation', expectedVersion: e.version })).status).toBe(403);
    await as('hrA');
    const approved = await act(d.id, { action: 'approve-explanation', expectedVersion: e.version });
    expect(approved.status).toBe(200);
    expect(((await approved.json()) as { status: string }).status).toBe('EXPLAINED');
  });

  it('invalid body -> 400; unknown discrepancy -> 404', async () => {
    await as('payA');
    const d = await rowOf(bad.A);
    expect((await act(d.id, { action: 'explain', expectedVersion: d.version })).status).toBe(400);
    expect((await act(randomUUID(), { action: 'reject', expectedVersion: 0 })).status).toBe(404);
  });

  it('run now: a scoped user reconciles his companies only; the owner also runs the tenant-level pass', async () => {
    await as('payB');
    const r1 = await run();
    expect(r1.status).toBe(200);
    const b1 = (await r1.json()) as { summaries: { companyId: string | null }[] };
    expect(b1.summaries.map((s) => s.companyId)).toEqual([co.B]);
    await as('owner');
    const r2 = await run();
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as { summaries: { companyId: string | null }[] };
    const companies = b2.summaries.map((s) => s.companyId);
    expect(companies).toContain(co.A);
    expect(companies).toContain(co.B);
    expect(companies).toContain(null);
    await as('employee');
    expect((await run()).status).toBe(403);
  });
});
