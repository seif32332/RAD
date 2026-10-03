// Shared fixture for API route tests against a real PostgreSQL with REAL authentication (CLAUDE.md:
// every changed route needs an allow, a deny and an other-company test with unmocked auth).
//
// Each test file still declares its own vi.mock blocks for the Next.js request plumbing (vi.mock is
// hoisted per file), then passes the `state` object to this harness:
//
//   const state = vi.hoisted(() => ({ token: undefined as string | undefined, scheduled: [] as unknown[] }));
//   vi.mock('next/headers', () => ({
//     cookies: async () => ({ get: (n: string) => (n === 'radeef_session' && state.token ? { name: n, value: state.token } : undefined) }),
//     headers: async () => new Headers({ 'x-real-ip': '10.0.0.7' }),
//   }));
//   vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: (fn: unknown) => { state.scheduled.push(fn); } }));
//
//   describe.skipIf(process.env.SCOPE_IT !== '1')('...', async () => {
//     if (process.env.SCOPE_IT !== '1') return;          // REQUIRED: vitest runs a skipped suite body while collecting
//     const h = await createRouteHarness(state);   // companies A and B, one user per role and company
//     await h.as('hrA'); const res = await route.GET(h.req('GET', '/api/x')); ...
//
// Users: `<role>A` / `<role>B` are scoped to one company through UserCompanyScope (so "no scope rows =
// every company" does not hide a missing check); `owner` is SUPER_ADMIN with no scope rows. Rows are
// never cleaned up: use a THROWAWAY database.
import { randomUUID } from 'crypto';
import type { Role } from '@prisma/client';

export type HarnessState = { token: string | undefined; scheduled: unknown[] };

const SCOPED_ROLES = {
  hr: 'HR_MANAGER',
  fin: 'FINANCE_MANAGER',
  payroll: 'PAYROLL_ADMIN',
  gov: 'GOV_RELATIONS',
  legal: 'LEGAL_ADMIN',
  branchMgr: 'BRANCH_MANAGER',
  deptMgr: 'DEPT_MANAGER',
  buyer: 'PURCHASING_AGENT',
  admin: 'COMPANY_ADMIN',
} as const satisfies Record<string, Role>;

type Scoped = `${keyof typeof SCOPED_ROLES}${'A' | 'B'}`;
export type HarnessUser = Scoped | 'owner' | 'empA' | 'empB';

export async function createRouteHarness(state: HarnessState) {
  const { prisma } = await import('@/lib/prisma');
  const { signSession } = await import('@/lib/session');
  const { employeeFixture, linkFixture } = await import('@/test/money-fixtures');

  const tag = randomUUID().replace(/-/g, '').slice(0, 8);
  let seq = 0;
  const next = () => (seq += 1);

  const co = { A: '', B: '' };
  const branch = { A: '', B: '' };
  const department = { A: '', B: '' };
  for (const k of ['A', 'B'] as const) {
    co[k] = (await prisma.company.create({ data: { nameArabic: `شركة ${k} ${tag}`, commercialRegNum: `RH${k}${tag}`, commercialRegExp: new Date('2030-01-01') } })).id;
    branch[k] = (await prisma.branch.create({ data: { nameArabic: `فرع ${k} ${tag}`, companyId: co[k] } })).id;
    department[k] = (await prisma.department.create({ data: { nameArabic: `قسم ${k} ${tag}`, branchId: branch[k] } })).id;
  }

  // An employee with pay (P1-PAY-B: created inside the money fixture, with the legacy openings of a migrated employee).
  async function employee(company: 'A' | 'B', over: Record<string, unknown> = {}) {
    const n = next();
    return employeeFixture({
      employeeId: `RH-${tag}-${n}`, firstNameArabic: 'موظف', lastNameArabic: `${n}`, nationality: 'SA', iqamaOrIdNumber: `RH${tag}${n}`,
      iqamaOrIdExp: new Date('2030-01-01'), dateOfBirth: new Date('1990-01-01'), gender: 'MALE', joinDate: new Date('2024-01-01'),
      basicSalary: 6000, legalCompanyId: co[company], actualCompanyId: co[company], branchId: branch[company], departmentId: department[company],
      ...over,
    });
  }

  const users = {} as Record<HarnessUser, { id: string; role: Role; employeeId?: string }>;
  async function user(key: HarnessUser, role: Role, company: 'A' | 'B' | null, employeeId?: string) {
    const u = await prisma.user.create({
      data: { email: `rh-${key.toLowerCase()}-${tag}@example.test`, passwordHash: 'x', role },
    });
    // Employee.userId links the login (BL-PAY-005: an identity column, written here as a fixture with its link row).
    if (employeeId) await linkFixture(u.id, employeeId);
    if (company) await prisma.userCompanyScope.create({ data: { userId: u.id, companyId: co[company] } });
    users[key] = { id: u.id, role, employeeId };
  }
  await user('owner', 'SUPER_ADMIN', null);
  for (const k of ['A', 'B'] as const) {
    for (const [name, role] of Object.entries(SCOPED_ROLES)) {
      // Managers are real employees of their company (branch / department scope needs a placement).
      const needsEmployee = role === 'BRANCH_MANAGER' || role === 'DEPT_MANAGER';
      const e = needsEmployee ? await employee(k) : undefined;
      await user(`${name}${k}` as HarnessUser, role, k, e?.id);
    }
    const self = await employee(k);
    await user(`emp${k}` as HarnessUser, 'EMPLOYEE', k, self.id);
  }

  /** Sign in as a harness user (null = no session). Real token, verified by requireUser against the DB. */
  async function as(who: HarnessUser | null) {
    state.token = who ? await signSession({ sub: users[who].id, role: users[who].role, passwordHash: 'x', sessionVersion: 0 }) : undefined;
  }

  const req = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
    new Request(`http://localhost${url}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-real-ip': '10.0.0.7', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

  return { prisma, tag, next, co, branch, department, users, employee, as, req, params, state };
}

export type RouteHarness = Awaited<ReturnType<typeof createRouteHarness>>;
