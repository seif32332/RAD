// Company scope of the workforce API (P1-SCOPE, DOMAIN_BOUNDARIES §5.4.3 "workforce / reporting": the
// allowed companies; aggregation inside the scope only; group reports for the owner).
//
// Every workforce route builds a WfScope at the edge (ScopedContext over the actor's UserCompanyScope,
// authz.assert on the action) and passes it to the runners and loaders, which take the companies as a
// parameter (src/lib/workforce/load.ts `companyIds`). The engine itself stays pure.
//
// Rules:
//   - companyIds null = every company (owner role, or a staff user without UserCompanyScope rows).
//   - An employee counts in the scope by his LEGAL company (as every workforce screen); an employee
//     without a legal company is outside every restricted scope (fail closed).
//   - A company / branch / department / employee / plan / snapshot outside the scope is "not found" (404).
//   - Tenant-wide rows (assumption defaults companyId '', plans of every company companyId null, the legal
//     registers) are READ by everyone as shared reference inputs where the engine applies them to the
//     caller's companies (assumption defaults), and are WRITTEN by an unrestricted actor only (403).
//     Plans of every company (companyId null) aggregate every company: unrestricted actors only.
import 'server-only';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { forbidden, notFound } from '@/lib/http';
import type { AuthUser } from '@/lib/auth';
import { ALL_COMPANIES, authz, resolveActor, scopeWhere, scopedContext, scopedPrisma, type ScopedContext } from '@/modules/iam';

export interface WfScope {
  readonly ctx: ScopedContext;
  /** The companies the caller may see; null = every company. */
  readonly companyIds: readonly string[] | null;
}

/** ScopedContext of the caller over his companies + authz on `action` (403 when refused). */
export async function workforceScope(user: AuthUser, action = 'workforce.read'): Promise<WfScope> {
  const ctx = scopedContext(await resolveActor(prisma, user));
  authz.assert(ctx, action);
  return { ctx, companyIds: ctx.companies === ALL_COMPANIES ? null : [...ctx.companies] };
}

export function isRestricted(s: WfScope): boolean {
  return s.companyIds !== null;
}

export function companyVisible(s: WfScope, companyId: string | null | undefined): boolean {
  if (!s.companyIds) return true;
  return !!companyId && s.companyIds.includes(companyId);
}

/**
 * The companies a loader reads: the caller's scope, narrowed to one named company when the request names
 * one (a company outside the scope is a 404). null = every company.
 */
export function scopeCompanies(s: WfScope, companyId?: string | null): string[] | null {
  if (companyId) {
    assertCompanyVisible(s, companyId);
    return [companyId];
  }
  return s.companyIds ? [...s.companyIds] : null;
}

/** A company named by the request: outside the scope = 404 (never a hint that it exists). */
export function assertCompanyVisible(s: WfScope, companyId: string | null | undefined, message = 'الشركة غير موجودة'): void {
  if (companyId && !companyVisible(s, companyId)) throw notFound(message);
}

/** Tenant-wide data (every company): an unrestricted actor only. */
export function assertTenantWide(s: WfScope, message = 'هذا الإجراء يخص كل الشركات، وهو خارج نطاق صلاحياتك: اختر شركة من شركاتك'): void {
  if (s.companyIds) throw forbidden(message);
}

/** The employee must exist inside the scope (legal company); 404 otherwise. */
export async function assertEmployeeVisible(s: WfScope, employeeId: string, message = 'الموظف غير موجود'): Promise<void> {
  if (!s.companyIds) return;
  const e = await scopedPrisma(s.ctx).employee.findFirst({ where: { id: employeeId }, select: { id: true } });
  if (!e) throw notFound(message);
}

export async function assertBranchVisible(s: WfScope, branchId: string | null | undefined, message = 'الفرع غير موجود'): Promise<void> {
  if (!branchId || !s.companyIds) return;
  const b = await scopedPrisma(s.ctx).branch.findFirst({ where: { id: branchId }, select: { id: true } });
  if (!b) throw notFound(message);
}

export async function assertDepartmentVisible(s: WfScope, departmentId: string | null | undefined, message = 'الإدارة غير موجودة'): Promise<void> {
  if (!departmentId || !s.companyIds) return;
  const d = await scopedPrisma(s.ctx).department.findFirst({ where: { id: departmentId }, select: { id: true } });
  if (!d) throw notFound(message);
}

/** Company / branch / department filters of a request (true-cost, benchmarks…): each must be in scope. */
export async function assertUnitsVisible(s: WfScope, p: { companyId?: string | null; branchId?: string | null; departmentId?: string | null; employeeId?: string | null }): Promise<void> {
  assertCompanyVisible(s, p.companyId);
  await assertBranchVisible(s, p.branchId);
  await assertDepartmentVisible(s, p.departmentId);
  if (p.employeeId) await assertEmployeeVisible(s, p.employeeId, 'الموظف غير موجود أو لا يعمل خلال فترة التوقع');
}

/** Filter of the visible plans (a plan of every company, companyId null, only for an unrestricted actor). */
export function planScopeWhere(s: WfScope): Prisma.HeadcountPlanWhereInput {
  return (scopeWhere(s.ctx, 'HeadcountPlan') ?? {}) as Prisma.HeadcountPlanWhereInput;
}

/** Filter of the visible companies / branches / departments (for name lists). */
export function companyScopeWhere(s: WfScope): Prisma.CompanyWhereInput {
  return (scopeWhere(s.ctx, 'Company') ?? {}) as Prisma.CompanyWhereInput;
}
export function branchScopeWhere(s: WfScope): Prisma.BranchWhereInput {
  return (scopeWhere(s.ctx, 'Branch') ?? {}) as Prisma.BranchWhereInput;
}
export function departmentScopeWhere(s: WfScope): Prisma.DepartmentWhereInput {
  return (scopeWhere(s.ctx, 'Department') ?? {}) as Prisma.DepartmentWhereInput;
}

/**
 * Saved calculations (WorkforceCalculation has no company column): visible to a restricted actor when the
 * subject is inside his scope: a COMPANY of his, an EMPLOYEE of his companies, a PLAN of his companies, a
 * BRANCH / DEPARTMENT of his companies. ALL (every company) = unrestricted actors only. null = no filter.
 */
export async function calculationScopeWhere(s: WfScope): Promise<Prisma.WorkforceCalculationWhereInput | null> {
  if (!s.companyIds) return null;
  const db = scopedPrisma(s.ctx);
  const [employees, plans, branches, departments] = await Promise.all([
    db.employee.findMany({ select: { id: true } }),
    prisma.headcountPlan.findMany({ where: planScopeWhere(s), select: { id: true } }),
    db.branch.findMany({ select: { id: true } }),
    db.department.findMany({ select: { id: true } }),
  ]);
  return {
    OR: [
      { subjectType: 'COMPANY', subjectId: { in: [...s.companyIds] } },
      { subjectType: 'EMPLOYEE', subjectId: { in: employees.map((e) => e.id) } },
      { subjectType: 'PLAN', subjectId: { in: plans.map((p) => p.id) } },
      { subjectType: 'BRANCH', subjectId: { in: branches.map((b) => b.id) } },
      { subjectType: 'DEPARTMENT', subjectId: { in: departments.map((d) => d.id) } },
    ],
  };
}
