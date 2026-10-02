// P1-FND-SCOPE unit tests: contexts, authz.can and the fail-closed Prisma scope extension.
//
// The extension is tested on a REAL PrismaClient with no database behind it: an inner extension
// ("capture") records what reaches the engine and answers from a small fixture instead of running the
// query. scopedPrisma is applied on top of it, so every assertion below sees exactly the arguments
// the scope layer would send to PostgreSQL. The DB-backed half (and a real route) is iam.it.test.ts.
import { PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALL_COMPANIES,
  MissingScopeContextError,
  ScopeViolationError,
  actorFromSession,
  ambientPrisma,
  authz,
  companyScopedModels,
  crossCompanyContext,
  forEachCompany,
  intersectCompanies,
  isScopeContext,
  recordCrossCompanyOperation,
  runInScope,
  scopeRuleOf,
  scopeWhere,
  scopedContext,
  scopedPrisma,
  selfContext,
  systemContext,
  teamContext,
  INFRA_MODELS,
  type Actor,
  type ScopeContext,
  type ScopeLookup,
} from '@/modules/iam';

type Call = { model?: string; operation: string; args: Record<string, unknown> };

const EMPLOYEES: Record<string, Record<string, unknown>> = {
  eA: { id: 'eA', legalCompanyId: 'A', directManagerId: 'mA', branchId: 'bA', departmentId: 'dA' },
  eB: { id: 'eB', legalCompanyId: 'B', directManagerId: 'mA', branchId: 'bB', departmentId: 'dB' },
  mA: { id: 'mA', legalCompanyId: 'A', directManagerId: null, branchId: 'bA', departmentId: 'dA' },
  eA2: { id: 'eA2', legalCompanyId: 'A', directManagerId: null, branchId: 'bX', departmentId: 'dX' },
};
const BRANCHES: Record<string, Record<string, unknown>> = { bA: { id: 'bA', companyId: 'A' }, bB: { id: 'bB', companyId: 'B' } };

const calls: Call[] = [];
const base = new PrismaClient({ datasourceUrl: 'postgresql://nobody:nothing@127.0.0.1:1/none' });
/**
 * Query extensions run in the order they were applied, so the capture is applied ON TOP of the scoped
 * client: it receives what the scope layer passes on, and answers instead of the engine.
 */
const captureExtension = {
  query: {
    async $allOperations({ model, operation, args }: { model?: string; operation: string; args: unknown }) {
      calls.push({ model, operation, args: (args ?? {}) as Record<string, unknown> });
      if (operation === 'count') return 0;
      if (operation.startsWith('findMany') || operation === 'groupBy' || operation === 'createManyAndReturn') return [];
      if (operation.endsWith('Many')) return { count: 0 };
      return { id: 'x' };
    },
  },
};
/** The write checks' row loader, from the fixture. */
const lookup: ScopeLookup = async (model, ids) => {
  const table = model === 'Employee' ? EMPLOYEES : model === 'Branch' ? BRANCHES : {};
  return ids.map((id) => table[id]).filter(Boolean);
};
type Client = ReturnType<typeof scopedPrisma>;
const mk = (ctx: ScopeContext): Client => scopedPrisma(ctx, base, { lookup }).$extends(captureExtension) as unknown as Client;

/** The last call that reached the engine for `model` (the lookups are other models or ops). */
const last = (model: string, operation?: string) => [...calls].reverse().find((c) => c.model === model && (!operation || c.operation === operation))!;

const user = (over: Partial<{ id: string; role: string; employeeId: string | null }> = {}) => ({
  id: 'u1',
  role: 'HR_MANAGER' as const,
  employeeId: null,
  ...over,
}) as { id: string; role: 'HR_MANAGER'; employeeId: string | null };

const hrA: Actor = actorFromSession(user(), ['A']);
const hrAB: Actor = actorFromSession(user(), ['A', 'B']);
const owner: Actor = actorFromSession(user({ id: 'o1', role: 'SUPER_ADMIN' }) as never, ['A']);

beforeEach(() => {
  calls.length = 0;
});

describe('Actor and contexts', () => {
  it('actorFromSession: owner roles get every company; others keep their scope rows; documents-only is refused', () => {
    expect(owner.isOwner).toBe(true);
    expect(owner.companies).toBe(ALL_COMPANIES);
    expect(hrA.companies).toEqual(['A']);
    expect(() => actorFromSession({ ...user(), documentsOnly: true }, ['A'])).toThrow();
    expect(() => actorFromSession(undefined as never, ['A'])).toThrow(MissingScopeContextError);
  });

  it('scopedContext: the actor companies by default, a narrower list allowed, a wider one refused (403)', () => {
    expect(scopedContext(hrAB).companies).toEqual(['A', 'B']);
    expect(scopedContext(hrAB, ['B']).companies).toEqual(['B']);
    expect(() => scopedContext(hrA, ['B'])).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => scopedContext(hrA, ALL_COMPANIES)).toThrow(expect.objectContaining({ status: 403 }));
    expect(scopedContext(owner, ALL_COMPANIES).companies).toBe(ALL_COMPANIES);
  });

  it('contexts are frozen and only constructor-built contexts are accepted', () => {
    const ctx = scopedContext(hrA);
    expect(isScopeContext(ctx)).toBe(true);
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(isScopeContext({ kind: 'scoped', actor: hrA, companies: ALL_COMPANIES })).toBe(false);
    expect(() => (ctx as { companies: unknown }).companies = ALL_COMPANIES).toThrow();
  });

  it('selfContext: the session employee and his legal company; no linked employee is 403', async () => {
    const me = actorFromSession(user({ role: 'EMPLOYEE' as never, employeeId: 'eB' }), ALL_COMPANIES);
    const ctx = selfContext(me, EMPLOYEES[me.employeeId!] as never);
    expect(ctx).toMatchObject({ kind: 'self', employeeId: 'eB', companies: ['B'] });
    expect(() => selfContext(hrA, null)).toThrow(expect.objectContaining({ status: 403 }));
  });

  it('teamContext: the manager company intersected with his scope; non-managers refused', async () => {
    const mgr = actorFromSession(user({ role: 'BRANCH_MANAGER' as never, employeeId: 'mA' }), ALL_COMPANIES);
    const ctx = teamContext(mgr, EMPLOYEES.mA as never);
    expect(ctx).toMatchObject({ kind: 'team', managerEmployeeId: 'mA', branchId: 'bA', departmentId: null, companies: ['A'] });
    const mgrScopedB = actorFromSession(user({ role: 'BRANCH_MANAGER' as never, employeeId: 'mA' }), ['B']);
    expect((teamContext(mgrScopedB, EMPLOYEES.mA as never)).companies).toEqual([]);
    const emp = actorFromSession(user({ role: 'EMPLOYEE' as never, employeeId: 'eA' }), ALL_COMPANIES);
    expect(() => teamContext(emp, EMPLOYEES.eA as never)).toThrow(expect.objectContaining({ status: 403 }));
  });

  it('crossCompanyContext: owner only (or a named operation), with a reason, and it writes an audit record', async () => {
    const created: unknown[] = [];
    const tx = { auditRecord: { create: vi.fn(async (a: unknown) => (created.push(a), { id: `audit-${created.length}` })) } };
    const root = { $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } as never;

    await expect(crossCompanyContext(root, hrA, { reason: 'تقرير المجموعة' })).rejects.toMatchObject({ status: 403 });
    await expect(crossCompanyContext(root, owner, { reason: '' })).rejects.toMatchObject({ status: 403 });
    await expect(crossCompanyContext(root, hrA, { reason: 'x'.repeat(10), operation: 'unknown-op' })).rejects.toMatchObject({ status: 403 });
    expect(created).toHaveLength(0);

    const ctx = await crossCompanyContext(root, owner, { reason: 'تقرير المجموعة الشهري', ipAddress: '10.0.0.1' });
    expect(ctx).toMatchObject({ kind: 'crossCompany', operation: 'owner', readOnly: false, auditId: 'audit-1', companies: ALL_COMPANIES });
    expect(created[0]).toMatchObject({
      data: { actorType: 'USER', actorId: 'o1', action: 'iam.crossCompany.open', entityType: 'CrossCompanyContext', reason: 'تقرير المجموعة الشهري' },
    });

    const named = await crossCompanyContext(root, hrA, { reason: 'فحص أهلية إعادة التعيين', operation: 'rehire-eligibility' });
    expect(named).toMatchObject({ readOnly: true, operation: 'rehire-eligibility' });

    await recordCrossCompanyOperation(tx as never, ctx, { action: 'org.company.create', entity: { type: 'Company', id: 'C' } });
    expect(created[2]).toMatchObject({ data: { action: 'org.company.create', reason: 'تقرير المجموعة الشهري' } });
  });

  it('systemContext: one company, or every company only for a declared cross-company job; forEachCompany runs per company', async () => {
    expect(systemContext('expiry-digest', 'A').companies).toEqual(['A']);
    expect(() => systemContext('expiry-digest')).toThrow(/not declared cross-company/);
    expect(systemContext('outbox-dispatch').companies).toBe(ALL_COMPANIES);
    expect(() => systemContext('')).toThrow(MissingScopeContextError);
    const seen = await forEachCompany(['A', 'B'], 'expiry-digest', async (ctx) => ctx.companies);
    expect([...seen.entries()]).toEqual([
      ['A', ['A']],
      ['B', ['B']],
    ]);
  });

  it('intersectCompanies', () => {
    expect(intersectCompanies(ALL_COMPANIES, ['A'])).toEqual(['A']);
    expect(intersectCompanies(['A', 'B'], ['B', 'C'])).toEqual(['B']);
    expect(intersectCompanies(ALL_COMPANIES, ALL_COMPANIES)).toBe(ALL_COMPANIES);
  });
});

describe('scope model registry', () => {
  it('matches the ARCH-006 definition: every model with a company or employee column (or Employee) outside platform/iam', async () => {
    const { Prisma } = await import('@prisma/client');
    const expected = Prisma.dmmf.datamodel.models
      .filter((m) => !INFRA_MODELS.includes(m.name))
      .filter((m) => m.name === 'Employee' || m.name === 'Company' || m.name === 'Department' || m.fields.some((f) => ['companyId', 'legalCompanyId', 'actualCompanyId', 'employeeId'].includes(f.name)))
      .map((m) => m.name)
      .sort();
    expect(companyScopedModels()).toEqual(expected);
  });

  it('resolves the company column per §5.4.3', () => {
    expect(scopeRuleOf('Company')).toEqual({ kind: 'company' });
    expect(scopeRuleOf('Employee')).toEqual({ kind: 'employee' });
    // 9x_db_constraints made JobRequest.companyId a real FK, so the relation is known and nested
    // writes through it (company: { connect }) are checked too.
    expect(scopeRuleOf('JobRequest')).toEqual({ kind: 'column', column: 'companyId', relation: 'company' });
    expect(scopeRuleOf('OnboardingRequest')).toEqual({ kind: 'column', column: 'companyId', relation: 'company' });
    expect(scopeRuleOf('MuqeemTransaction')).toEqual({ kind: 'column', column: 'companyId', relation: 'company' });
    expect(scopeRuleOf('HeadcountPlan')).toEqual({ kind: 'column', column: 'companyId', relation: 'company' });
    expect(scopeRuleOf('IssuedDocument')).toMatchObject({ kind: 'column', column: 'legalCompanyId' });
    expect(scopeRuleOf('Vehicle')).toMatchObject({ kind: 'column', column: 'legalCompanyId' }); // legal, never actual
    expect(scopeRuleOf('Leave')).toEqual({ kind: 'via-employee', relation: 'employee' });
    expect(scopeRuleOf('EmployeeChangeOrder')).toEqual({ kind: 'employee-column' });
    expect(scopeRuleOf('Department')).toEqual({ kind: 'via-parent', relation: 'branch', parentColumn: 'companyId' });
    expect(scopeRuleOf('User')).toBeUndefined();
    expect(scopeRuleOf('AuditRecord')).toBeUndefined();
  });
});

describe('scopedPrisma: fail closed', () => {
  it('throws without a context, or with a look-alike object', () => {
    expect(() => scopedPrisma(undefined as never, base)).toThrow(MissingScopeContextError);
    expect(() => scopedPrisma(null as never, base)).toThrow(MissingScopeContextError);
    expect(() => scopedPrisma({ kind: 'scoped', companies: ALL_COMPANIES } as never, base)).toThrow(MissingScopeContextError);
  });

  it('ambient client: a scoped model outside runInScope throws; a non-scoped model passes; inside, the context applies', async () => {
    const db = ambientPrisma(base).$extends(captureExtension) as unknown as Client;
    await expect(db.leave.findMany({})).rejects.toThrow(MissingScopeContextError);
    expect(calls).toHaveLength(0);
    await db.user.findMany({});
    expect(last('User').args).toEqual({});
    await runInScope(scopedContext(hrA), () => db.leave.findMany({}));
    expect(last('Leave').args.where).toEqual({ AND: [{ employee: { is: { legalCompanyId: { in: ['A'] } } } }] });
  });

  it('raw SQL is refused on the scoped client', async () => {
    const db = mk(scopedContext(owner, ALL_COMPANIES));
    await expect(db.$queryRaw`SELECT 1`).rejects.toBeInstanceOf(ScopeViolationError);
    await expect(db.$executeRawUnsafe('DELETE FROM "Leave"')).rejects.toBeInstanceOf(ScopeViolationError);
  });
});

describe('scopedPrisma: filter injection on reads', () => {
  const ctx = () => scopedContext(hrA);
  const A = { in: ['A'] };

  it('findMany / findFirst keep the caller filter and add the company', async () => {
    const db = mk(ctx());
    await db.jobRequest.findMany({ where: { status: 'PENDING' } });
    expect(last('JobRequest').args.where).toEqual({ status: 'PENDING', AND: [{ companyId: A }] });
    await db.jobRequest.findFirst({ where: { AND: [{ status: 'X' }] } });
    expect(last('JobRequest').args.where).toEqual({ AND: [{ status: 'X' }, { companyId: A }] });
  });

  it('findUnique keeps the unique key at the top level', async () => {
    const db = mk(ctx());
    await db.employee.findUnique({ where: { id: 'eB' } });
    expect(last('Employee').args.where).toEqual({ id: 'eB', AND: [{ legalCompanyId: A }] });
  });

  it('count / aggregate / groupBy are filtered too', async () => {
    const db = mk(ctx());
    await db.leave.count({ where: { status: 'APPROVED' } });
    expect(last('Leave', 'count').args.where).toEqual({ status: 'APPROVED', AND: [{ employee: { is: { legalCompanyId: A } } }] });
    await db.payroll.aggregate({ _sum: { netSalary: true } });
    // P1-PAY-A (9zf): a payroll line carries its own company (the payroll scope key, §5.4.3).
    expect(last('Payroll', 'aggregate').args.where).toEqual({ AND: [{ companyId: A }] });
    await db.employee.groupBy({ by: ['legalCompanyId'], _count: true });
    expect(last('Employee', 'groupBy').args.where).toEqual({ AND: [{ legalCompanyId: A }] });
  });

  it('Company by id, Department through its branch, Branch by column', async () => {
    const db = mk(ctx());
    await db.company.findMany({});
    expect(last('Company').args.where).toEqual({ AND: [{ id: A }] });
    await db.department.findMany({});
    expect(last('Department').args.where).toEqual({ AND: [{ branch: { is: { companyId: A } } }] });
    await db.branch.findMany({});
    expect(last('Branch').args.where).toEqual({ AND: [{ companyId: A }] });
  });

  it('an unrestricted context (owner, ALL) adds nothing; non-scoped models are untouched', async () => {
    const db = mk(scopedContext(owner, ALL_COMPANIES));
    await db.leave.findMany({ where: { status: 'PENDING' } });
    expect(last('Leave').args.where).toEqual({ status: 'PENDING' });
    await mk(ctx()).systemSetting.findMany({ where: { key: 'k' } });
    expect(last('SystemSetting').args.where).toEqual({ key: 'k' });
  });

  it('a model with an employee column but no relation is refused under a restricted company context', async () => {
    await expect(mk(ctx()).employeeChangeOrder.findMany({})).rejects.toBeInstanceOf(ScopeViolationError);
  });

  it('scopeWhere gives the same fragment for legacy code inside a root-client transaction', () => {
    expect(scopeWhere(ctx(), 'JobRequest')).toEqual({ companyId: A });
    expect(scopeWhere(ctx(), 'User')).toBeNull();
    expect(() => scopeWhere(undefined as never, 'JobRequest')).toThrow(MissingScopeContextError);
  });
});

describe('scopedPrisma: writes', () => {
  const ctx = () => scopedContext(hrA);

  it('create: another company, or no company, is refused; own company passes', async () => {
    const db = mk(ctx());
    await expect(db.jobRequest.create({ data: { requesterId: 'r', jobTitle: 't', jobType: 'F', nationality: 'n', description: 'd', companyId: 'B' } })).rejects.toBeInstanceOf(ScopeViolationError);
    await expect(db.jobRequest.create({ data: { requesterId: 'r', jobTitle: 't', jobType: 'F', nationality: 'n', description: 'd' } })).rejects.toBeInstanceOf(ScopeViolationError);
    expect(calls.filter((c) => c.model === 'JobRequest')).toHaveLength(0);
    await db.jobRequest.create({ data: { requesterId: 'r', jobTitle: 't', jobType: 'F', nationality: 'n', description: 'd', companyId: 'A' } });
    expect(last('JobRequest', 'create')).toBeTruthy();
  });

  it('createMany: one row of another company refuses the whole call', async () => {
    const db = mk(ctx());
    await expect(
      db.branch.createMany({ data: [{ companyId: 'A', nameArabic: 'x' }, { companyId: 'B', nameArabic: 'y' }] }),
    ).rejects.toBeInstanceOf(ScopeViolationError);
    expect(calls.filter((c) => c.model === 'Branch')).toHaveLength(0);
  });

  it('create through a relation connect is checked the same way', async () => {
    const db = mk(ctx());
    await expect(db.branch.create({ data: { nameArabic: 'x', company: { connect: { id: 'B' } } } })).rejects.toBeInstanceOf(ScopeViolationError);
    await db.branch.create({ data: { nameArabic: 'x', company: { connect: { id: 'A' } } } });
  });

  it('employee-keyed create: the employee must belong to the context companies', async () => {
    const db = mk(ctx());
    const leave = (employeeId: string) => ({ employeeId, leaveType: 'ANNUAL', startDate: new Date(), endDate: new Date(), totalDays: 1 });
    await expect(db.leave.create({ data: leave('eB') as never })).rejects.toBeInstanceOf(ScopeViolationError);
    await expect(db.leave.create({ data: leave('nobody') as never })).rejects.toBeInstanceOf(ScopeViolationError);
    await db.leave.create({ data: leave('eA') as never });
    expect(last('Leave', 'create')).toBeTruthy();
  });

  it('update / updateMany / delete / deleteMany: the where is filtered, and moving a row to another company is refused', async () => {
    const db = mk(ctx());
    await db.jobRequest.update({ where: { id: 'j1' }, data: { status: 'APPROVED' } });
    expect(last('JobRequest', 'update').args.where).toEqual({ id: 'j1', AND: [{ companyId: { in: ['A'] } }] });
    await db.jobRequest.updateMany({ where: { status: 'PENDING' }, data: { status: 'REJECTED' } });
    expect(last('JobRequest', 'updateMany').args.where).toEqual({ status: 'PENDING', AND: [{ companyId: { in: ['A'] } }] });
    await db.jobRequest.delete({ where: { id: 'j1' } });
    expect(last('JobRequest', 'delete').args.where).toEqual({ id: 'j1', AND: [{ companyId: { in: ['A'] } }] });
    await db.leave.deleteMany({ where: { status: 'CANCELLED' } });
    expect(last('Leave', 'deleteMany').args.where).toEqual({ status: 'CANCELLED', AND: [{ employee: { is: { legalCompanyId: { in: ['A'] } } } }] });
    await expect(db.jobRequest.update({ where: { id: 'j1' }, data: { companyId: 'B' } })).rejects.toBeInstanceOf(ScopeViolationError);
    await expect(db.employee.update({ where: { id: 'eA' }, data: { legalCompanyId: { set: 'B' } } })).rejects.toBeInstanceOf(ScopeViolationError);
  });

  it('upsert: where filtered, create data checked', async () => {
    const db = mk(ctx());
    await expect(
      db.branch.upsert({ where: { id: 'b' }, create: { companyId: 'B', nameArabic: 'x' }, update: { nameArabic: 'y' } }),
    ).rejects.toBeInstanceOf(ScopeViolationError);
    await db.branch.upsert({ where: { id: 'b' }, create: { companyId: 'A', nameArabic: 'x' }, update: { nameArabic: 'y' } });
    expect(last('Branch', 'upsert').args.where).toEqual({ id: 'b', AND: [{ companyId: { in: ['A'] } }] });
  });

  it('Department create is checked through its branch company', async () => {
    const db = mk(ctx());
    await expect(db.department.create({ data: { branchId: 'bB', nameArabic: 'x' } })).rejects.toBeInstanceOf(ScopeViolationError);
    await db.department.create({ data: { branchId: 'bA', nameArabic: 'x' } });
  });

  it('creating a company needs an unrestricted context', async () => {
    const data = { nameArabic: 'x', commercialRegNum: '1', commercialRegExp: new Date() };
    await expect(mk(ctx()).company.create({ data })).rejects.toBeInstanceOf(ScopeViolationError);
    await mk(scopedContext(owner, ALL_COMPANIES)).company.create({ data });
  });

  it('a read-only cross-company context reads everything and writes nothing', async () => {
    const tx = { auditRecord: { create: async () => ({ id: 'a' }) } };
    const root = { $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } as never;
    const cc = await crossCompanyContext(root, hrA, { reason: 'أهلية إعادة التعيين', operation: 'rehire-eligibility' });
    const db = mk(cc);
    await db.employee.findMany({ where: { iqamaOrIdNumber: '1' } });
    expect(last('Employee').args.where).toEqual({ iqamaOrIdNumber: '1' });
    await expect(db.employee.update({ where: { id: 'eB' }, data: { notes: 'x' } as never })).rejects.toBeInstanceOf(ScopeViolationError);
  });
});

describe('scopedPrisma: Self and Team', () => {
  it('self: own rows only; writing for someone else is refused', async () => {
    const me = actorFromSession(user({ role: 'EMPLOYEE' as never, employeeId: 'eA' }), ALL_COMPANIES);
    const ctx = selfContext(me, EMPLOYEES[me.employeeId!] as never);
    const db = mk(ctx);
    await db.leave.findMany({});
    expect(last('Leave').args.where).toEqual({ AND: [{ employeeId: 'eA' }] });
    await db.employee.findFirst({ where: { employeeId: 'E-1' } });
    expect(last('Employee').args.where).toEqual({ employeeId: 'E-1', AND: [{ id: 'eA' }] });
    await db.employeeChangeOrder.findMany({});
    expect(last('EmployeeChangeOrder').args.where).toEqual({ AND: [{ employeeId: 'eA' }] });
    await db.brandProfile.findMany({});
    expect(last('BrandProfile').args.where).toEqual({ AND: [{ companyId: { in: ['A'] } }] });
    await expect(db.leave.create({ data: { employeeId: 'eA2', leaveType: 'ANNUAL' } as never })).rejects.toBeInstanceOf(ScopeViolationError);
    await db.leave.create({ data: { employeeId: 'eA', leaveType: 'ANNUAL' } as never });
    await expect(db.employee.update({ where: { id: 'eA' }, data: { legalCompanyId: 'B' } })).rejects.toBeInstanceOf(ScopeViolationError);
  });

  it('team: the team inside the manager company; a report of another company is outside', async () => {
    const mgr = actorFromSession(user({ role: 'BRANCH_MANAGER' as never, employeeId: 'mA' }), ALL_COMPANIES);
    const ctx = teamContext(mgr, EMPLOYEES.mA as never);
    const db = mk(ctx);
    const team = { AND: [{ OR: [{ id: 'mA' }, { directManagerId: 'mA' }, { branchId: 'bA' }] }, { legalCompanyId: { in: ['A'] } }] };
    await db.employee.findMany({});
    expect(last('Employee').args.where).toEqual({ AND: [team] });
    await db.leave.findMany({});
    expect(last('Leave').args.where).toEqual({ AND: [{ employee: { is: team } }] });
    // eB reports to mA but is registered on company B: outside the team (phase-0 finding).
    await expect(db.leave.create({ data: { employeeId: 'eB', leaveType: 'ANNUAL' } as never })).rejects.toBeInstanceOf(ScopeViolationError);
    await expect(db.leave.create({ data: { employeeId: 'eA2', leaveType: 'ANNUAL' } as never })).rejects.toBeInstanceOf(ScopeViolationError);
    await db.leave.create({ data: { employeeId: 'eA', leaveType: 'ANNUAL' } as never });
    await expect(db.employeeChangeOrder.findMany({})).rejects.toBeInstanceOf(ScopeViolationError);
  });
});

describe('authz.can (skeleton, deny by default)', () => {
  const tx = { auditRecord: { create: async () => ({ id: 'a' }) } };
  const root = { $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } as never;

  it('unknown actions, forged contexts and wrong context kinds are denied', () => {
    const ctx = scopedContext(hrA);
    expect(authz.can(ctx, 'payroll.everything')).toBe(false);
    expect(authz.can(ctx, 'toString')).toBe(false);
    expect(authz.can({ kind: 'scoped', actor: hrA, companies: ALL_COMPANIES } as never, 'employee.read')).toBe(false);
    expect(authz.can(ctx, 'attendance.punch')).toBe(false); // self only
    expect(authz.can(systemContext('expiry-digest', 'A') as ScopeContext, 'employee.read')).toBe(false);
  });

  it('roles and companies', () => {
    const ctx = scopedContext(hrA);
    expect(authz.can(ctx, 'recruitment.jobRequest.decide', { companyId: 'A' })).toBe(true);
    expect(authz.can(ctx, 'recruitment.jobRequest.decide', { companyId: 'B' })).toBe(false);
    expect(authz.can(ctx, 'recruitment.jobRequest.decide', { companyId: null })).toBe(false);
    const fin = scopedContext(actorFromSession(user({ role: 'FINANCE_MANAGER' as never }), ['A']));
    expect(authz.can(fin, 'recruitment.jobRequest.decide', { companyId: 'A' })).toBe(false);
    expect(() => authz.assert(fin, 'recruitment.jobRequest.decide')).toThrow(expect.objectContaining({ status: 403 }));
  });

  it('self: own record only; team: members only; no decision on one\'s own record', async () => {
    const me = actorFromSession(user({ role: 'EMPLOYEE' as never, employeeId: 'eA' }), ALL_COMPANIES);
    const self = selfContext(me, EMPLOYEES[me.employeeId!] as never);
    expect(authz.can(self, 'attendance.punch', { employeeId: 'eA' })).toBe(true);
    expect(authz.can(self, 'attendance.punch', { employeeId: 'eA2' })).toBe(false);

    const mgr = actorFromSession(user({ role: 'BRANCH_MANAGER' as never, employeeId: 'mA' }), ALL_COMPANIES);
    const team = teamContext(mgr, EMPLOYEES.mA as never);
    expect(authz.can(team, 'leave.request.decide', { ...EMPLOYEES.eA, employeeId: 'eA', companyId: 'A' })).toBe(true);
    expect(authz.can(team, 'leave.request.decide', { ...EMPLOYEES.eB, employeeId: 'eB', companyId: 'B' })).toBe(false);
    expect(authz.can(team, 'leave.request.decide', { employeeId: 'mA', companyId: 'A' })).toBe(false); // own request
  });

  it('cross-company: company.create for owners only; read-only contexts cannot act', async () => {
    const cc = await crossCompanyContext(root, owner, { reason: 'إنشاء شركة جديدة' });
    expect(authz.can(cc, 'company.create')).toBe(true);
    expect(authz.can(scopedContext(owner), 'company.create')).toBe(false);
    const ro = await crossCompanyContext(root, hrA, { reason: 'أهلية إعادة التعيين', operation: 'rehire-eligibility' });
    expect(authz.can(ro, 'recruitment.jobRequest.read')).toBe(true);
    expect(authz.can(ro, 'recruitment.jobRequest.decide', { companyId: 'B' })).toBe(false);
  });
});
