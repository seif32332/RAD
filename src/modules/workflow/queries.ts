// The reads of the engine (SOURCE_OF_TRUTH rows of ADR-0006): instance by request, the inbox, the timeline, the
// active definition (company first, then the tenant default), and the delegation list. Every read takes a scope
// context; rows of another company are invisible.
import type { Prisma, PrismaClient, WorkflowDefinition } from '@prisma/client';
import { assertScopeContext, type ScopeContext } from '@/modules/iam';
import { auditTrailOf, type AuditTrailRow } from '@/modules/platform';
import { WORKFLOW_AGGREGATE } from './events';
import { actorUserIdOf, assertInstanceInScope, companyWhere, delegationWhere, instanceWhere } from './scope';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * The ACTIVE definition of a type for a company: the company's own row wins over the tenant default (ARC-WFE-A7).
 * Explicit OR, because a restricted scopedPrisma never returns the companyId = NULL rows.
 */
export async function activeDefinitionFor(db: Db, requestType: string, companyId: string): Promise<WorkflowDefinition | null> {
  const rows = await db.workflowDefinition.findMany({
    where: { requestType, status: 'ACTIVE', OR: [{ companyId }, { companyId: null }] },
    orderBy: { version: 'desc' },
  });
  return rows.find((r) => r.companyId === companyId) ?? rows.find((r) => r.companyId === null) ?? null;
}

/** The definitions (every version) of a type visible to a context: its companies' rows and the tenant rows. */
export async function definitionsOf(db: Db, ctx: ScopeContext, requestType: string): Promise<WorkflowDefinition[]> {
  assertScopeContext(ctx, 'workflow.definitionsOf');
  const company = companyWhere(ctx);
  return db.workflowDefinition.findMany({
    where: { requestType, ...(company ? { OR: [company, { companyId: null }] } : {}) },
    orderBy: [{ companyId: 'asc' }, { version: 'desc' }],
  });
}

/** The instance of a request, as the context may see it (null when absent or outside the context). */
export async function instanceOf(db: Db, ctx: ScopeContext, requestType: string, requestId: string) {
  assertScopeContext(ctx, 'workflow.instanceOf');
  return db.workflowInstance.findFirst({ where: { AND: [{ requestType, requestId }, instanceWhere(ctx)] } });
}

/** Instances visible to the context (Self: own; Team: own and the ones he acts on; staff: the companies). */
export async function instancesFor(db: Db, ctx: ScopeContext, filter: { status?: Prisma.WorkflowInstanceWhereInput['status']; requestType?: string; take?: number } = {}) {
  assertScopeContext(ctx, 'workflow.instancesFor');
  return db.workflowInstance.findMany({
    where: { AND: [instanceWhere(ctx), ...(filter.status ? [{ status: filter.status }] : []), ...(filter.requestType ? [{ requestType: filter.requestType }] : [])] },
    orderBy: { startedAt: 'desc' },
    take: Math.min(filter.take ?? 100, 500),
  });
}

/** The inbox: OPEN tasks where the context's login is a candidate, in its companies. */
export async function tasksForUser(db: Db, ctx: ScopeContext, take = 200) {
  assertScopeContext(ctx, 'workflow.tasksForUser');
  const me = actorUserIdOf(ctx);
  if (!me) return [];
  return db.workflowTask.findMany({
    where: { AND: [{ status: 'OPEN', candidateUserIds: { has: me } }, companyWhere(ctx) ?? {}] },
    orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }],
    take: Math.min(take, 500),
    include: { instance: { select: { id: true, requestType: true, requestId: true, status: true, version: true, round: true, companyId: true } } },
  });
}

export interface TimelineView {
  instance: Awaited<ReturnType<Db['workflowInstance']['findUniqueOrThrow']>>;
  tasks: Awaited<ReturnType<Db['workflowTask']['findMany']>>;
  audit: AuditTrailRow[];
}

/** Tasks + AuditRecord of one instance (WFE_NOT_FOUND when outside the context). */
export async function timelineOf(db: Db, ctx: ScopeContext, instanceId: string): Promise<TimelineView> {
  assertScopeContext(ctx, 'workflow.timelineOf');
  const instance = await db.workflowInstance.findUnique({ where: { id: instanceId } });
  const tasks = instance ? await db.workflowTask.findMany({ where: { instanceId, companyId: instance.companyId }, orderBy: [{ round: 'asc' }, { createdAt: 'asc' }] }) : [];
  assertInstanceInScope(ctx, instance, tasks.map((t) => t.candidateUserIds));
  const audit = await auditTrailOf(db as Prisma.TransactionClient, { entityType: WORKFLOW_AGGREGATE, entityId: instanceId });
  return { instance: instance!, tasks, audit };
}

/** Delegations visible to the context (companyIds hasSome ctx.companies; Self / Team: their own). */
export async function delegationsFor(db: Db, ctx: ScopeContext) {
  return db.approvalDelegation.findMany({ where: delegationWhere(ctx), orderBy: { startsAt: 'desc' }, take: 200 });
}
