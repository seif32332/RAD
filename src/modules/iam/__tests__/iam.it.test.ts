// P1-FND-SCOPE against a real PostgreSQL (all migrations applied): the scope extension on real queries,
// the audited cross-company context, and GET/POST /api/recruitment end to end.
// Opt-in: SCOPE_IT=1 with DATABASE_URL pointing at a THROWAWAY database (the test creates its own
// companies, users and employees under a random tag and does not clean them up).
//
// Authentication is real: each route call carries a session token signed by src/lib/session.ts for a
// real User row, and requireUser() verifies it against the database. Only `cookies()` is replaced
// (no request scope in vitest).
import { randomUUID } from 'crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { employeeFixture } from '@/test/money-fixtures';
import { scopeFixture } from '@/test/money-fixtures';

const RUN = process.env.SCOPE_IT === '1';

const state = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'radeef_session' && state.token ? { name, value: state.token } : undefined),
  }),
}));

describe.skipIf(!RUN)('company scope (P1-FND-SCOPE) on PostgreSQL', { timeout: 60_000 }, async () => {
  const { prisma } = await import('@/lib/prisma');
  const { signSession } = await import('@/lib/session');
  const iam = await import('@/modules/iam');
  const { resolveSelfContext, resolveTeamContext } = await import('@/lib/employee-scope');
  const recruitment = await import('@/app/api/recruitment/route');
  const { scopedPrisma, scopedContext, resolveActor, crossCompanyContext, runInScope, ambientPrisma, ScopeViolationError, ALL_COMPANIES } = iam;

  const tag = randomUUID().slice(0, 8);
  const digits = tag.replace(/\D/g, '').padEnd(4, '7').slice(0, 4);
  let seq = 0;
  const iqama = () => `2${digits}${String(++seq).padStart(5, '0')}`;

  const co = { A: '', B: '' };
  const branch = { A: '', B: '' };
  const dept = { A: '', B: '' };
  const emp = { eA: '', eB: '', mA: '', reportOnB: '', staffA: '' };
  const jr = { A: '', B: '', none: '' };
  type Who = 'hrA' | 'hrB' | 'owner' | 'mgr' | 'employee';
  const users: Record<Who, { id: string; role: string; employeeId: string | null }> = {
    hrA: { id: '', role: 'HR_MANAGER', employeeId: null },
    hrB: { id: '', role: 'HR_MANAGER', employeeId: null },
    owner: { id: '', role: 'SUPER_ADMIN', employeeId: null },
    mgr: { id: '', role: 'BRANCH_MANAGER', employeeId: null },
    employee: { id: '', role: 'EMPLOYEE', employeeId: null },
  };

  async function as(who: Who) {
    const u = users[who];
    state.token = await signSession({ sub: u.id, role: u.role, passwordHash: 'x', sessionVersion: 0 });
  }
  const actorOf = (who: Who) => resolveActor(prisma, { id: users[who].id, role: users[who].role as 'HR_MANAGER', employeeId: users[who].employeeId });

  async function newEmployee(company: 'A' | 'B', over: Record<string, unknown> = {}) {
    const e = await employeeFixture({
        employeeId: `S-${tag}-${++seq}`,
        firstNameArabic: 'موظف',
        lastNameArabic: company,
        nationality: 'سعودي',
        iqamaOrIdNumber: iqama(),
        iqamaOrIdExp: new Date('2030-01-01'),
        dateOfBirth: new Date('1990-01-01'),
        gender: 'MALE',
        joinDate: new Date('2020-01-01'),
        basicSalary: 5000,
        legalCompanyId: co[company],
        actualCompanyId: co[company],
        branchId: branch[company],
        departmentId: dept[company],
        ...over,
      });
    return e.id;
  }

  const post = (body: unknown) =>
    recruitment.POST(
      new Request('http://localhost/api/recruitment', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-real-ip': '10.0.0.7' },
        body: JSON.stringify(body),
      }),
    );
  type List = { jobRequests: { id: string }[]; metadata: { managers: { id: string }[]; departments: { id: string }[] } };
  const list = async () => {
    const res = await recruitment.GET();
    return { status: res.status, body: res.status === 200 ? ((await res.json()) as List) : null };
  };
  const ids = (b: List | null) => new Set(b?.jobRequests.map((j) => j.id));

  beforeAll(async () => {
    for (const k of ['A', 'B'] as const) {
      const c = await prisma.company.create({
        data: { nameArabic: `شركة ${k} ${tag}`, commercialRegNum: `8${k}${tag}${Date.now()}`.slice(0, 20), commercialRegExp: new Date('2030-01-01') },
      });
      co[k] = c.id;
      branch[k] = (await prisma.branch.create({ data: { companyId: c.id, nameArabic: `فرع ${k} ${tag}` } })).id;
      dept[k] = (await prisma.department.create({ data: { branchId: branch[k], nameArabic: `قسم ${k} ${tag}` } })).id;
    }
    emp.mA = await newEmployee('A');
    emp.eA = await newEmployee('A', { directManagerId: emp.mA });
    emp.eB = await newEmployee('B');
    // Reports to the manager of company A but is registered on company B (phase-0 finding).
    emp.reportOnB = await newEmployee('B', { directManagerId: emp.mA });
    emp.staffA = await newEmployee('A');
    users.mgr.employeeId = emp.mA;
    users.employee.employeeId = emp.eA;
    for (const [key, u] of Object.entries(users)) {
      u.id = (
        await prisma.user.create({
          data: {
            email: `${key}-${tag}@example.test`,
            passwordHash: 'x',
            role: u.role as 'HR_MANAGER',
          },
        })
      ).id;
      // BL-PAY-005: Employee.userId is the identity projection (money.gateway guards it): a link fixture.
      if (u.employeeId) await (await import('@/test/money-fixtures')).linkFixture(u.id, u.employeeId);
    }
    await scopeFixture.createMany({
      data: [
        { userId: users.hrA.id, companyId: co.A },
        { userId: users.hrB.id, companyId: co.B },
      ],
    });
    const request = (companyId: string | null, departmentId: string) =>
      prisma.jobRequest.create({
        data: { requesterId: emp.staffA, companyId, departmentId, jobTitle: `وظيفة ${tag}`, jobType: 'FULL_TIME', nationality: 'غير محدد', description: 'اختبار' },
      });
    jr.A = (await request(co.A, dept.A)).id;
    jr.B = (await request(co.B, dept.B)).id;
    jr.none = (await request(null, dept.A)).id;
    for (const e of [emp.eA, emp.eB]) await prisma.attendance.create({ data: { employeeId: e, date: new Date('2026-09-01') } });
  });

  beforeEach(() => {
    state.token = undefined;
  });

  describe('scopedPrisma on real queries', () => {
    it('reads: findMany / findUnique / findFirst / count / aggregate / groupBy see company A only', async () => {
      const db = scopedPrisma(scopedContext(await actorOf('hrA')));
      const mine = await db.jobRequest.findMany({ where: { id: { in: [jr.A, jr.B, jr.none] } } });
      expect(mine.map((r) => r.id)).toEqual([jr.A]); // company B and the company-less row are invisible
      expect(await db.jobRequest.findUnique({ where: { id: jr.B } })).toBeNull();
      expect(await db.employee.findFirst({ where: { id: emp.eB } })).toBeNull();
      expect(await db.attendance.count({ where: { employeeId: { in: [emp.eA, emp.eB] } } })).toBe(1);
      const agg = await db.attendance.aggregate({ where: { employeeId: { in: [emp.eA, emp.eB] } }, _count: { _all: true } });
      expect(agg._count._all).toBe(1);
      const groups = await db.employee.groupBy({ by: ['legalCompanyId'], where: { id: { in: Object.values(emp) } }, _count: { _all: true } });
      expect(groups.map((g) => g.legalCompanyId)).toEqual([co.A]);
      const depts = await db.department.findMany({ where: { id: { in: [dept.A, dept.B] } }, select: { id: true } });
      expect(depts.map((d) => d.id)).toEqual([dept.A]);
    });

    it('writes: another company is never matched, and never created', async () => {
      const db = scopedPrisma(scopedContext(await actorOf('hrA')));
      await expect(db.jobRequest.update({ where: { id: jr.B }, data: { description: 'hijack' } })).rejects.toMatchObject({ code: 'P2025' });
      expect((await db.jobRequest.updateMany({ where: { id: jr.B }, data: { description: 'hijack' } })).count).toBe(0);
      await expect(db.jobRequest.delete({ where: { id: jr.B } })).rejects.toMatchObject({ code: 'P2025' });
      expect((await prisma.jobRequest.findUniqueOrThrow({ where: { id: jr.B } })).description).toBe('اختبار');
      await expect(
        db.jobRequest.create({ data: { requesterId: emp.staffA, companyId: co.B, jobTitle: `x ${tag}`, jobType: 'FULL_TIME', nationality: 'n', description: 'cross' } }),
      ).rejects.toBeInstanceOf(ScopeViolationError);
      await expect(db.attendance.create({ data: { employeeId: emp.eB, date: new Date('2026-09-02') } })).rejects.toBeInstanceOf(ScopeViolationError);
      expect(await prisma.jobRequest.count({ where: { description: 'cross' } })).toBe(0);
      // own company: allowed
      const ok = await db.attendance.create({ data: { employeeId: emp.eA, date: new Date('2026-09-02') } });
      expect(ok.employeeId).toBe(emp.eA);
    });

    it('the scoped client works inside its own interactive transaction', async () => {
      const db = scopedPrisma(scopedContext(await actorOf('hrA')));
      const seen = await db.$transaction(async (tx) => tx.jobRequest.findMany({ where: { id: { in: [jr.A, jr.B] } }, select: { id: true } }));
      expect(seen.map((r) => r.id)).toEqual([jr.A]);
    });

    it('team: the manager sees his team inside company A; his report registered on B is outside', async () => {
      const ctx = await resolveTeamContext(prisma, await actorOf('mgr'));
      expect(ctx.companies).toEqual([co.A]);
      const team = await scopedPrisma(ctx).employee.findMany({ where: { id: { in: Object.values(emp) } }, select: { id: true } });
      // branch A: mA, eA, staffA; reportOnB reports to mA but is on company B.
      expect(new Set(team.map((e) => e.id))).toEqual(new Set([emp.mA, emp.eA, emp.staffA]));
    });

    it('self: the employee reads his own rows only', async () => {
      const ctx = await resolveSelfContext(prisma, await actorOf('employee'));
      const rows = await scopedPrisma(ctx).attendance.findMany({ where: { employeeId: { in: [emp.eA, emp.eB] } }, select: { employeeId: true } });
      expect(new Set(rows.map((r) => r.employeeId))).toEqual(new Set([emp.eA]));
    });

    it('ambient: without runInScope a scoped model throws; inside, the context applies', async () => {
      const db = ambientPrisma();
      await expect(db.jobRequest.findMany({ where: { id: jr.A } })).rejects.toBeInstanceOf(iam.MissingScopeContextError);
      const ctx = scopedContext(await actorOf('hrB'));
      const rows = await runInScope(ctx, () => db.jobRequest.findMany({ where: { id: { in: [jr.A, jr.B] } }, select: { id: true } }));
      expect(rows.map((r) => r.id)).toEqual([jr.B]);
    });

    it('cross-company: refused to a scoped HR user; an owner opens it and an AuditRecord row holds the reason', async () => {
      await expect(crossCompanyContext(prisma, await actorOf('hrA'), { reason: 'تقرير المجموعة' })).rejects.toMatchObject({ status: 403 });
      const reason = `تقرير المجموعة ${tag}`;
      const ctx = await crossCompanyContext(prisma, await actorOf('owner'), { reason });
      expect(ctx.companies).toBe(ALL_COMPANIES);
      const row = await prisma.auditRecord.findUniqueOrThrow({ where: { id: ctx.auditId } });
      expect(row).toMatchObject({ actorType: 'USER', actorId: users.owner.id, action: 'iam.crossCompany.open', reason, entityId: ctx.contextId });
      const all = await scopedPrisma(ctx).jobRequest.findMany({ where: { id: { in: [jr.A, jr.B, jr.none] } } });
      expect(all).toHaveLength(3);
    });
  });

  describe('GET / POST /api/recruitment through the scope layer (real sessions)', () => {
    it('no session -> 401; a plain employee -> 403', async () => {
      expect((await list()).status).toBe(401);
      await as('employee');
      expect((await list()).status).toBe(403);
    });

    it('allow: HR of company A sees the requests of company A', async () => {
      await as('hrA');
      const { status, body } = await list();
      expect(status).toBe(200);
      expect(ids(body).has(jr.A)).toBe(true);
      expect(body!.metadata.departments.some((d) => d.id === dept.A)).toBe(true);
    });

    it('other company: HR of A never gets a row of company B (requests, employees, departments), nor a company-less one', async () => {
      await as('hrA');
      const { body } = await list();
      expect(ids(body).has(jr.B)).toBe(false);
      expect(ids(body).has(jr.none)).toBe(false);
      expect(body!.metadata.managers.some((m) => m.id === emp.eB)).toBe(false);
      expect(body!.metadata.departments.some((d) => d.id === dept.B)).toBe(false);
      await as('hrB');
      const b = (await list()).body;
      expect(ids(b).has(jr.B)).toBe(true);
      expect(ids(b).has(jr.A)).toBe(false);
    });

    it('owner sees every company', async () => {
      await as('owner');
      const { body } = await list();
      for (const id of [jr.A, jr.B, jr.none]) expect(ids(body).has(id)).toBe(true);
    });

    it('manager: team context inside his company only', async () => {
      await as('mgr');
      const { status, body } = await list();
      expect(status).toBe(200);
      expect(ids(body).has(jr.A)).toBe(true); // his department (dept A)
      expect(ids(body).has(jr.B)).toBe(false);
      expect(body!.metadata.departments.every((d) => d.id !== dept.B)).toBe(true);
    });

    it('deny: HR of B cannot decide a request of A (404, unchanged); HR of A can (allow)', async () => {
      const decide = (id: string) => post({ actionType: 'UPDATE_STATUS', payload: { id, status: 'APPROVED' } });
      await as('hrB');
      expect((await decide(jr.A)).status).toBe(404);
      expect((await prisma.jobRequest.findUniqueOrThrow({ where: { id: jr.A } })).status).toBe('PENDING');
      await as('mgr');
      expect((await decide(jr.A)).status).toBe(403);
      await as('hrA');
      expect((await decide(jr.A)).status).toBe(200);
      expect((await prisma.jobRequest.findUniqueOrThrow({ where: { id: jr.A } })).status).toBe('APPROVED');
      // double call: the second decision is a conflict, not a second transition
      expect((await decide(jr.A)).status).toBe(409);
    });
  });
});
