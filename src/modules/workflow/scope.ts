// Company scope of the engine (DOMAIN_BOUNDARIES §5.4.3 row workflow; DEC-PO-145 guardrail 6). Instance and Task
// carry companyId (the beneficiaries' company at start); an instance of a company outside the context is "not found"
// (404, no existence leak). Self and Team contexts see only the instances they are party to: the automatic column
// rule of scopedPrisma would otherwise return the whole company (iam scope.ts filterFor → companyFilter).
// ApprovalDelegation has companyIds[] and is not auto-scoped: it is filtered here.
import type { Prisma } from '@prisma/client';
import { ALL_COMPANIES, assertScopeContext, companiesAllowed, type ScopeContext } from '@/modules/iam';
import { WorkflowError } from './errors';

export interface ScopedInstance {
  id: string;
  companyId: string;
  beneficiaryEmployeeIds: readonly string[];
  requesterUserId: string | null;
}

/** The acting login of a context (null for a SystemContext). */
export function actorUserIdOf(ctx: ScopeContext): string | null {
  return ctx.kind === 'system' ? null : ctx.actor.userId;
}

/** Company filter of a context for the company-keyed workflow tables (null = every company). */
export function companyWhere(ctx: ScopeContext): { companyId: { in: string[] } } | null {
  return ctx.companies === ALL_COMPANIES ? null : { companyId: { in: [...ctx.companies] } };
}

/**
 * Self: the instances where the context's employee is a beneficiary or the actor is the requester.
 * Team: those, plus the instances where the manager is (or was) a candidate or the actor of a task.
 * Scoped / System / CrossCompany: every instance of the companies.
 */
export function instanceWhere(ctx: ScopeContext): Prisma.WorkflowInstanceWhereInput {
  assertScopeContext(ctx, 'workflow.instanceWhere');
  const company = companyWhere(ctx) ?? {};
  if (ctx.kind === 'self') {
    return { AND: [company, { OR: [{ beneficiaryEmployeeIds: { has: ctx.employeeId } }, { requesterUserId: ctx.actor.userId }] }] };
  }
  if (ctx.kind === 'team') {
    const me = ctx.actor.userId;
    return {
      AND: [
        company,
        {
          OR: [
            { beneficiaryEmployeeIds: { has: ctx.managerEmployeeId } },
            { requesterUserId: me },
            { tasks: { some: { OR: [{ candidateUserIds: { has: me } }, { actedByUserId: me }] } } },
          ],
        },
      ],
    };
  }
  return company;
}

/**
 * The instance as the context may see it, or WFE_NOT_FOUND. `taskCandidates` (the candidate lists of its tasks)
 * lets a Self / Team actor who is a candidate see it (the inbox opens the request it points to).
 */
export function assertInstanceInScope(ctx: ScopeContext, inst: ScopedInstance | null, taskCandidates: readonly (readonly string[])[] = []): asserts inst is ScopedInstance {
  assertScopeContext(ctx, 'workflow.assertInstanceInScope');
  if (!inst || !companiesAllowed(ctx.companies, [inst.companyId])) throw new WorkflowError('WFE_NOT_FOUND');
  if (ctx.kind === 'self' || ctx.kind === 'team') {
    const me = ctx.actor.userId;
    const employee = ctx.kind === 'self' ? ctx.employeeId : ctx.managerEmployeeId;
    const party = inst.beneficiaryEmployeeIds.includes(employee) || inst.requesterUserId === me || taskCandidates.some((c) => c.includes(me));
    if (!party) throw new WorkflowError('WFE_NOT_FOUND');
  }
}

/** Only an instance company inside the context (act / cancel: the candidate check decides the rest). */
export function assertCompanyInScope(ctx: ScopeContext, companyId: string | null | undefined): void {
  assertScopeContext(ctx, 'workflow.assertCompanyInScope');
  if (!companyId || !companiesAllowed(ctx.companies, [companyId])) throw new WorkflowError('WFE_NOT_FOUND');
}

/**
 * Delegations visible to a context: those naming at least one of its companies (§3.6). Self and Team contexts see
 * only their own grants (from or to them) and can never write one (package D).
 */
export function delegationWhere(ctx: ScopeContext): Prisma.ApprovalDelegationWhereInput {
  assertScopeContext(ctx, 'workflow.delegationWhere');
  const companies: Prisma.ApprovalDelegationWhereInput = ctx.companies === ALL_COMPANIES ? {} : { companyIds: { hasSome: [...ctx.companies] } };
  if (ctx.kind === 'self' || ctx.kind === 'team') {
    return { AND: [companies, { OR: [{ fromUserId: ctx.actor.userId }, { toUserId: ctx.actor.userId }] }] };
  }
  return companies;
}

export function canWriteDelegations(ctx: ScopeContext): boolean {
  return ctx.kind === 'scoped' || ctx.kind === 'crossCompany';
}
