// P0-08 (AUDIT/13_MASTER_PLAN.md, EV-6029): the manager (MSS) scope boundary.
//  - assertCanManageEmployee / managedEmployeesWhere (src/lib/hr-workflows.ts) directly, and
//  - GET /api/employees/[id] end to end with the REAL requireUser (jose-signed cookie, test secret).
// Only the database is replaced, by a small in-memory employee table that evaluates the `where`
// shapes these helpers produce (equality, AND, OR).
import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'p0-08-scope-test-secret-0123456789abcdef';

type Row = { id: string; directManagerId: string | null; branchId: string | null; departmentId: string | null; legalCompanyId: string };

const { db, matches, employeeTable } = vi.hoisted(() => {
  const db = {
    cookie: undefined as string | undefined,
    users: new Map<string, Record<string, unknown>>(),
    employees: [] as Array<Record<string, unknown>>,
  };
  function matches(row: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean {
    if (!where) return true;
    return Object.entries(where).every(([k, v]) => {
      if (k === 'AND') return (v as Record<string, unknown>[]).every((w) => matches(row, w));
      if (k === 'OR') return (v as Record<string, unknown>[]).some((w) => matches(row, w));
      // { in: [...] }: the company filter the iam scoped client adds (P1-SCOPE).
      if (v !== null && typeof v === 'object' && Array.isArray((v as { in?: unknown }).in)) return ((v as { in: unknown[] }).in).includes(row[k]);
      if (v !== null && typeof v === 'object') throw new Error(`test db: unsupported filter on ${k}: ${JSON.stringify(v)}`);
      return row[k] === v;
    });
  }
  function pick(row: Record<string, unknown> | undefined, select?: Record<string, unknown>) {
    if (!row) return null;
    if (!select) return { ...row };
    return Object.fromEntries(Object.keys(select).filter((k) => k in row).map((k) => [k, row[k]]));
  }
  type Args = { where: Record<string, unknown>; select?: Record<string, unknown> };
  const employeeTable = {
    findUnique: async (a: Args) => pick(db.employees.find((e) => matches(e, a.where)), a.select),
    findFirst: async (a: Args) => pick(db.employees.find((e) => matches(e, a.where)), a.select),
    findMany: async (a: { where?: Record<string, unknown> }) => db.employees.filter((e) => matches(e, a.where)).map((e) => ({ ...e })),
  };
  return { db, matches, employeeTable };
});

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && db.cookie ? { name: n, value: db.cookie } : undefined) }),
}));
vi.mock('@/lib/prisma', () => ({
  prisma: {
    user: { findUnique: async (a: { where: { id: string } }) => db.users.get(a.where.id) ?? null },
    employee: employeeTable,
    auditLog: { create: async () => ({}) },
    // No UserCompanyScope rows: every user has every company (the transitional rule of iam).
    userCompanyScope: { findMany: async () => [] },
    // scopedPrisma(ctx) (P1-SCOPE): the iam query hook runs over the same in-memory employee table.
    $extends(ext: { query: { $allOperations: (p: { model: string; operation: string; args: unknown; query: (a: unknown) => unknown }) => unknown } }) {
      const hook = ext.query.$allOperations;
      const table = employeeTable as unknown as Record<string, (a: unknown) => unknown>;
      return {
        employee: Object.fromEntries(
          ['findUnique', 'findFirst', 'findMany'].map((operation) => [
            operation,
            (args: unknown) => hook({ model: 'Employee', operation, args, query: (a) => table[operation](a) }),
          ]),
        ),
      };
    },
  },
}));

import { signSession } from '@/lib/session';
import { assertCanManageEmployee, managedEmployeesWhere } from '@/lib/hr-workflows';
import type { AuthUser } from '@/lib/auth';
import type { Prisma } from '@prisma/client';

// Org chart
//   company C1: branch B1 { dept D1: mgrD1 (DEPT_MANAGER) -> a1, a2 ; dept D2: mgrD2 (DEPT_MANAGER) -> b1 }
//               branch B2 { dept D3: c1 (reports to mgrB2) }
//   brMgr (BRANCH_MANAGER of B1, sits in D1 but is nobody's manager)
//   company C2: other-company employee z1 in branch B9 / dept D9
const EMPLOYEES: Row[] = [
  { id: 'mgrD1', directManagerId: null, branchId: 'B1', departmentId: 'D1', legalCompanyId: 'C1' },
  { id: 'a1', directManagerId: 'mgrD1', branchId: 'B1', departmentId: 'D1', legalCompanyId: 'C1' },
  { id: 'a2', directManagerId: 'someoneElse', branchId: 'B1', departmentId: 'D1', legalCompanyId: 'C1' },
  { id: 'mgrD2', directManagerId: null, branchId: 'B1', departmentId: 'D2', legalCompanyId: 'C1' },
  { id: 'b1', directManagerId: 'mgrD2', branchId: 'B1', departmentId: 'D2', legalCompanyId: 'C1' },
  { id: 'mgrB2', directManagerId: null, branchId: 'B2', departmentId: 'D3', legalCompanyId: 'C1' },
  { id: 'c1', directManagerId: 'mgrB2', branchId: 'B2', departmentId: 'D3', legalCompanyId: 'C1' },
  { id: 'brMgr', directManagerId: null, branchId: 'B1', departmentId: 'D1', legalCompanyId: 'C1' },
  { id: 'crossDept', directManagerId: 'mgrD1', branchId: 'B2', departmentId: 'D3', legalCompanyId: 'C1' },
  { id: 'z1', directManagerId: null, branchId: 'B9', departmentId: 'D9', legalCompanyId: 'C2' },
];

const authUser = (role: string, employeeId: string | null): AuthUser =>
  ({ id: `u-${employeeId ?? role}`, email: 'x@example.test', role, name: 'x', avatarUrl: null, employeeId, sessionVersion: 0 }) as AuthUser;

// The helpers take a Prisma TransactionClient; the in-memory table stands in for it.
const fakeDb = { employee: employeeTable } as unknown as Prisma.TransactionClient;

async function visibleIds(user: AuthUser): Promise<string[] | 'ALL'> {
  const where = await managedEmployeesWhere(fakeDb, user);
  if (where === null) return 'ALL';
  return db.employees.filter((e) => matches(e, where as Record<string, unknown>)).map((e) => e.id as string).sort();
}
async function canManage(user: AuthUser, id: string) {
  const e = EMPLOYEES.find((x) => x.id === id)!;
  return assertCanManageEmployee(fakeDb, user, e).then(
    () => true,
    (err: { status?: number }) => {
      expect(err.status).toBe(403);
      return false;
    },
  );
}

beforeEach(() => {
  db.employees = EMPLOYEES.map((e) => ({ ...e, employeeId: `EMP-${e.id}`, firstNameArabic: e.id, lastNameArabic: '' }));
  db.users = new Map();
  db.cookie = undefined;
});

describe('managedEmployeesWhere: what a manager can list', () => {
  it('DEPT_MANAGER: self + direct reports + own department only', async () => {
    expect(await visibleIds(authUser('DEPT_MANAGER', 'mgrD1'))).toEqual(['a1', 'a2', 'brMgr', 'crossDept', 'mgrD1']);
  });

  it('DEPT_MANAGER never sees another department (b1, mgrD2 in D2) or another company (z1)', async () => {
    const ids = (await visibleIds(authUser('DEPT_MANAGER', 'mgrD1'))) as string[];
    for (const other of ['b1', 'mgrD2', 'c1', 'mgrB2', 'z1']) expect(ids).not.toContain(other);
  });

  it('BRANCH_MANAGER: self + own branch; not another branch or company', async () => {
    const ids = (await visibleIds(authUser('BRANCH_MANAGER', 'brMgr'))) as string[];
    expect(ids).toEqual(['a1', 'a2', 'b1', 'brMgr', 'mgrD1', 'mgrD2']);
    for (const other of ['c1', 'mgrB2', 'crossDept', 'z1']) expect(ids).not.toContain(other);
  });

  it('a DEPT_MANAGER does not get branch scope (and vice versa)', async () => {
    const dept = (await visibleIds(authUser('DEPT_MANAGER', 'mgrD2'))) as string[];
    expect(dept).toEqual(['b1', 'mgrD2']);
  });

  it('manager with a department-less / branch-less profile: only self + direct reports', async () => {
    db.employees.push({ id: 'floater', directManagerId: null, branchId: null, departmentId: null, legalCompanyId: 'C1' });
    db.employees.push({ id: 'f1', directManagerId: 'floater', branchId: null, departmentId: null, legalCompanyId: 'C1' });
    db.employees.push({ id: 'unassigned', directManagerId: null, branchId: null, departmentId: null, legalCompanyId: 'C1' });
    expect(await visibleIds(authUser('DEPT_MANAGER', 'floater'))).toEqual(['f1', 'floater']);
    expect(await visibleIds(authUser('BRANCH_MANAGER', 'floater'))).toEqual(['f1', 'floater']);
  });

  it('plain EMPLOYEE and non-manager staff: only themselves', async () => {
    expect(await visibleIds(authUser('EMPLOYEE', 'a1'))).toEqual(['a1']);
    expect(await visibleIds(authUser('LEGAL_ADMIN', 'a2'))).toEqual(['a2']);
    // A non-manager role gets no direct-report scope even if people report to him.
    expect(await visibleIds(authUser('EMPLOYEE', 'mgrD1'))).toEqual(['mgrD1']);
  });

  it('account not linked to an employee file: nobody', async () => {
    expect(await visibleIds(authUser('DEPT_MANAGER', null))).toEqual([]);
    expect(await visibleIds(authUser('EMPLOYEE', null))).toEqual([]);
  });

  it('HR group: unrestricted (null filter)', async () => {
    for (const role of ['SUPER_ADMIN', 'COMPANY_ADMIN', 'HR_MANAGER']) expect(await visibleIds(authUser(role, null))).toBe('ALL');
  });
});

describe('assertCanManageEmployee: approve / reject boundary', () => {
  it('DEPT_MANAGER: own department and direct reports yes; other department no', async () => {
    const u = authUser('DEPT_MANAGER', 'mgrD1');
    expect(await canManage(u, 'a1')).toBe(true);
    expect(await canManage(u, 'a2')).toBe(true);
    expect(await canManage(u, 'crossDept')).toBe(true); // direct report in another department
    expect(await canManage(u, 'b1')).toBe(false);
    expect(await canManage(u, 'mgrD2')).toBe(false);
    expect(await canManage(u, 'c1')).toBe(false);
    expect(await canManage(u, 'z1')).toBe(false);
  });

  it('BRANCH_MANAGER: own branch yes; another branch no', async () => {
    const u = authUser('BRANCH_MANAGER', 'brMgr');
    expect(await canManage(u, 'b1')).toBe(true);
    expect(await canManage(u, 'c1')).toBe(false);
    expect(await canManage(u, 'z1')).toBe(false);
  });

  it('nobody approves his own request (except the owner group)', async () => {
    expect(await canManage(authUser('DEPT_MANAGER', 'mgrD1'), 'mgrD1')).toBe(false);
    expect(await canManage(authUser('HR_MANAGER', 'a1'), 'a1')).toBe(false);
    expect(await canManage(authUser('COMPANY_ADMIN', 'a1'), 'a1')).toBe(true);
  });

  it('non-manager roles and unlinked managers are denied', async () => {
    expect(await canManage(authUser('EMPLOYEE', 'mgrD1'), 'a1')).toBe(false);
    expect(await canManage(authUser('FINANCE_MANAGER', 'x'), 'a1')).toBe(false);
    expect(await canManage(authUser('DEPT_MANAGER', null), 'a1')).toBe(false);
  });

  it('HR group manages anyone else', async () => {
    expect(await canManage(authUser('HR_MANAGER', 'mgrD1'), 'z1')).toBe(true);
  });
});

describe('GET /api/employees/[id] with a real session: a manager reads only his scope', { timeout: 30_000 }, () => {
  async function loginAs(role: string, employeeId: string | null) {
    const id = `user-${employeeId ?? role}`;
    db.users.set(id, {
      id,
      email: `${id}@example.test`,
      role,
      name: id,
      avatarUrl: null,
      isActive: true,
      passwordHash: 'hash',
      sessionVersion: 0,
      documentsOnlyUntil: null,
      employeeProfile: employeeId ? { id: employeeId, firstNameArabic: null, lastNameArabic: null } : null,
    });
    db.cookie = await signSession({ sub: id, role, passwordHash: 'hash', sessionVersion: 0 });
  }
  async function get(id: string) {
    vi.resetModules();
    const { GET } = await import('@/app/api/employees/[id]/route');
    return GET(new Request(`http://x.test/api/employees/${id}`), { params: Promise.resolve({ id }) });
  }

  it('allow: DEPT_MANAGER reads an employee of his own department', async () => {
    await loginAs('DEPT_MANAGER', 'mgrD1');
    const res = await get('a2');
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe('a2');
  });

  it('deny: DEPT_MANAGER reading an employee of another department gets 403', async () => {
    await loginAs('DEPT_MANAGER', 'mgrD1');
    expect((await get('b1')).status).toBe(403);
  });

  it('other company: DEPT_MANAGER reading an employee of another company gets 403', async () => {
    await loginAs('DEPT_MANAGER', 'mgrD1');
    expect((await get('z1')).status).toBe(403);
  });

  it('unknown id: 404 (the scope check does not turn it into a 200)', async () => {
    await loginAs('DEPT_MANAGER', 'mgrD1');
    expect((await get('nope')).status).toBe(404);
  });

  it('no session: 401; EMPLOYEE (not staff): 403', async () => {
    expect((await get('a1')).status).toBe(401);
    await loginAs('EMPLOYEE', 'a1');
    expect((await get('a1')).status).toBe(403);
  });

  it('a token claiming HR_MANAGER for a DEPT_MANAGER account is still scoped (role comes from the database)', async () => {
    await loginAs('DEPT_MANAGER', 'mgrD1');
    db.cookie = await signSession({ sub: 'user-mgrD1', role: 'HR_MANAGER', passwordHash: 'hash', sessionVersion: 0 });
    expect((await get('b1')).status).toBe(403);
  });
});
