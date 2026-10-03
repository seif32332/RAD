// Definition commands (wfe-to-be.md §12.9, G6 / G7; AUDIT/16 §3.5): DRAFT → ACTIVE → RETIRED. An ACTIVE or RETIRED
// version is immutable (DB trigger); one DRAFT and one ACTIVE per (type, company) (partial uniques).
//
// G7: the editor is an owner-group login (SUPER_ADMIN / COMPANY_ADMIN), never a Radeef vendor account, in a Scoped
// context covering the definition's company; the tenant default (companyId null) needs a context over every company.
// Activation is refused while activationBlockers is not empty (phase 2: always) — so no person can, alone or with
// others, route approvals of any request type through the engine in this phase (INV-IAM-01 regression).
import type { Prisma, WorkflowDefinition } from '@prisma/client';
import { ROLE_GROUPS } from '@/lib/constants';
import { ALL_COMPANIES, assertScopeContext, companiesAllowed, identityOf, type ScopeContext } from '@/modules/iam';
import { audit, runTransition, type OperationOutcome, type RootClient, type TxClient } from '@/modules/platform';
import { activationBlockers } from '../activation';
import { REQUEST_TYPE_PATTERN, requireAdapter } from '../adapters';
import { definitionChecksum, parseDefinition } from '../definition';
import { WorkflowError } from '../errors';
import { WORKFLOW_AUDIT } from '../events';

export interface DefinitionResult {
  id: string;
  requestType: string;
  companyId: string | null;
  version: number;
  status: WorkflowDefinition['status'];
  checksum: string;
}

function resultOf(d: WorkflowDefinition): DefinitionResult {
  return { id: d.id, requestType: d.requestType, companyId: d.companyId, version: d.version, status: d.status, checksum: d.checksum };
}

/** G7 on the context: an owner-group login in a Scoped context covering the company (null = the tenant). */
function editorOf(ctx: ScopeContext, companyId: string | null): string {
  assertScopeContext(ctx, 'workflow definition');
  if (ctx.kind !== 'scoped') throw new WorkflowError('WFE_FORBIDDEN', 'definitions are edited in a staff (Scoped) context');
  if (!(ROLE_GROUPS.OWNER as readonly string[]).includes(ctx.actor.role)) throw new WorkflowError('WFE_FORBIDDEN', 'G7: the owner group or COMPANY_ADMIN edits approval paths');
  if (companyId === null ? ctx.companies !== ALL_COMPANIES : !companiesAllowed(ctx.companies, [companyId])) throw new WorkflowError('WFE_NOT_FOUND');
  return ctx.actor.userId;
}

/** G7 on current data: the login is still active, not documents-only, not a vendor account, and still owner-group. */
async function assertEditorNow(tx: TxClient, userId: string): Promise<void> {
  const u = await identityOf(tx, userId);
  if (!u || !u.isActive || u.documentsOnlyUntil || u.isVendorStaff || !(ROLE_GROUPS.OWNER as readonly string[]).includes(u.role)) {
    throw new WorkflowError('WFE_FORBIDDEN', 'G7: the editor must be an active owner-group account of the customer (not a Radeef account)');
  }
}

async function definitionInScope(tx: TxClient, ctx: ScopeContext, id: string): Promise<WorkflowDefinition> {
  const d = await tx.workflowDefinition.findUnique({ where: { id } });
  if (!d) throw new WorkflowError('WFE_NOT_FOUND');
  editorOf(ctx, d.companyId);
  return d;
}

function snapshot(d: WorkflowDefinition) {
  return { status: d.status, version: d.version, checksum: d.checksum, requestType: d.requestType, companyId: d.companyId };
}

/**
 * Saves the DRAFT of a type for a company (or the tenant): the strict schema and the §12.3 checks against the adapter's
 * catalogs. The one DRAFT is replaced in place; otherwise a new version (max + 1) is created. Idempotent on the checksum.
 */
export async function saveWorkflowDefinitionDraft(
  prisma: RootClient,
  i: { ctx: ScopeContext; requestType: string; companyId: string | null; definition: unknown; changeNote?: string; basedOnId?: string },
): Promise<OperationOutcome<DefinitionResult>> {
  if (typeof i.requestType !== 'string' || !REQUEST_TYPE_PATTERN.test(i.requestType)) throw new WorkflowError('WFE_VALIDATION', 'bad request type');
  const editor = editorOf(i.ctx, i.companyId);
  const adapter = requireAdapter(i.requestType);
  const doc = parseDefinition(i.definition, adapter);
  const checksum = definitionChecksum(doc);
  const key = `wf:def:draft:${i.requestType}:${i.companyId ?? 'tenant'}:${checksum}`;
  return runTransition(prisma, { key, operation: 'workflow.definition.saveDraft', actorId: editor, companyId: i.companyId }, async (tx) => {
    await assertEditorNow(tx, editor);
    if (i.basedOnId) {
      const base = await tx.workflowDefinition.findUnique({ where: { id: i.basedOnId }, select: { requestType: true, companyId: true } });
      if (!base || base.requestType !== i.requestType || (base.companyId !== null && base.companyId !== i.companyId)) throw new WorkflowError('WFE_VALIDATION', 'basedOnId must be a version of the same type');
    }
    const existing = await tx.workflowDefinition.findFirst({ where: { requestType: i.requestType, companyId: i.companyId, status: 'DRAFT' } });
    let row: WorkflowDefinition;
    if (existing) {
      const { count } = await tx.workflowDefinition.updateMany({
        where: { id: existing.id, status: 'DRAFT' },
        data: { definitionJson: doc as unknown as Prisma.InputJsonObject, checksum, changeNote: i.changeNote ?? null, basedOnId: i.basedOnId ?? existing.basedOnId },
      });
      if (count === 0) throw new WorkflowError('WFE_CONFLICT', 'the draft changed', { retryable: true });
      row = await tx.workflowDefinition.findUniqueOrThrow({ where: { id: existing.id } });
    } else {
      const last = await tx.workflowDefinition.findFirst({ where: { requestType: i.requestType, companyId: i.companyId }, orderBy: { version: 'desc' }, select: { version: true } });
      row = await tx.workflowDefinition.create({
        data: {
          requestType: i.requestType,
          companyId: i.companyId,
          version: (last?.version ?? 0) + 1,
          status: 'DRAFT',
          definitionJson: doc as unknown as Prisma.InputJsonObject,
          checksum,
          basedOnId: i.basedOnId ?? null,
          changeNote: i.changeNote ?? null,
          createdById: editor,
        },
      });
    }
    await audit(tx, {
      actor: { type: 'USER', id: editor },
      action: WORKFLOW_AUDIT.definitionDraftSaved,
      entity: { type: 'WorkflowDefinition', id: row.id, companyId: row.companyId },
      before: existing ? snapshot(existing) : null,
      after: { ...snapshot(row), definition: doc },
      reason: i.changeNote ?? null,
      operationKey: key,
    });
    return resultOf(row);
  });
}

/**
 * DRAFT → ACTIVE, atomically retiring the ACTIVE version of the same (type, company) (§12.9). Refused while
 * activationBlockers(type) is not empty: in phase 2 nothing is ever activated.
 */
export async function activateWorkflowDefinition(prisma: RootClient, i: { ctx: ScopeContext; definitionId: string }): Promise<OperationOutcome<DefinitionResult>> {
  assertScopeContext(i.ctx, 'activateWorkflowDefinition');
  const peek = await prisma.workflowDefinition.findUnique({ where: { id: i.definitionId }, select: { requestType: true, companyId: true } });
  if (!peek) throw new WorkflowError('WFE_NOT_FOUND');
  const editor = editorOf(i.ctx, peek.companyId);
  const blockers = activationBlockers(peek.requestType);
  if (blockers.length) throw new WorkflowError('WFE_NOT_ACTIVATABLE', blockers.join(', '), { blockers });
  // TODO(WFE-003, DEC-PO-146, ADR-0011): two-person activation — require activatedById !== createdById and !== the
  // last editor of the draft (single-operator rule as in package C) BEFORE the FIRST-TYPE blocker is lifted. Not built
  // in package B: activation is gated (activationBlockers) so no path can be activated yet.
  const adapter = requireAdapter(peek.requestType);
  const key = `wf:def:activate:${i.definitionId}`;
  return runTransition(prisma, { key, operation: 'workflow.definition.activate', actorId: editor, companyId: peek.companyId }, async (tx) => {
    await assertEditorNow(tx, editor);
    const d = await definitionInScope(tx, i.ctx, i.definitionId);
    if (d.status === 'ACTIVE') return resultOf(d);
    if (d.status !== 'DRAFT') throw new WorkflowError('WFE_INVALID_STATE', `a ${d.status} definition cannot be activated`);
    // The catalogs may have changed since the draft was saved: check again.
    parseDefinition(d.definitionJson, adapter);
    const at = new Date();
    const current = await tx.workflowDefinition.findFirst({ where: { requestType: d.requestType, companyId: d.companyId, status: 'ACTIVE' } });
    if (current) {
      const { count } = await tx.workflowDefinition.updateMany({ where: { id: current.id, status: 'ACTIVE' }, data: { status: 'RETIRED', retiredAt: at, retiredById: editor } });
      if (count === 0) throw new WorkflowError('WFE_CONFLICT', 'the active version changed', { retryable: true });
    }
    const { count } = await tx.workflowDefinition.updateMany({ where: { id: d.id, status: 'DRAFT' }, data: { status: 'ACTIVE', activatedAt: at, activatedById: editor } });
    if (count === 0) throw new WorkflowError('WFE_CONFLICT', 'the draft changed', { retryable: true });
    const row = await tx.workflowDefinition.findUniqueOrThrow({ where: { id: d.id } });
    await audit(tx, {
      actor: { type: 'USER', id: editor },
      action: WORKFLOW_AUDIT.definitionActivated,
      entity: { type: 'WorkflowDefinition', id: row.id, companyId: row.companyId },
      before: snapshot(d),
      after: { ...snapshot(row), retiredId: current?.id ?? null },
      operationKey: key,
    });
    return resultOf(row);
  });
}

/** ACTIVE → RETIRED (§12.9). Instances already started keep their pinned version (G6). */
export async function retireWorkflowDefinition(prisma: RootClient, i: { ctx: ScopeContext; definitionId: string; reason?: string }): Promise<OperationOutcome<DefinitionResult>> {
  assertScopeContext(i.ctx, 'retireWorkflowDefinition');
  const peek = await prisma.workflowDefinition.findUnique({ where: { id: i.definitionId }, select: { companyId: true } });
  if (!peek) throw new WorkflowError('WFE_NOT_FOUND');
  const editor = editorOf(i.ctx, peek.companyId);
  const key = `wf:def:retire:${i.definitionId}`;
  return runTransition(prisma, { key, operation: 'workflow.definition.retire', actorId: editor, companyId: peek.companyId }, async (tx) => {
    await assertEditorNow(tx, editor);
    const d = await definitionInScope(tx, i.ctx, i.definitionId);
    if (d.status === 'RETIRED') return resultOf(d);
    if (d.status !== 'ACTIVE') throw new WorkflowError('WFE_INVALID_STATE', 'only an ACTIVE definition is retired (a DRAFT is replaced)');
    const at = new Date();
    const { count } = await tx.workflowDefinition.updateMany({ where: { id: d.id, status: 'ACTIVE' }, data: { status: 'RETIRED', retiredAt: at, retiredById: editor } });
    if (count === 0) throw new WorkflowError('WFE_CONFLICT', 'the definition changed', { retryable: true });
    const row = await tx.workflowDefinition.findUniqueOrThrow({ where: { id: d.id } });
    await audit(tx, {
      actor: { type: 'USER', id: editor },
      action: WORKFLOW_AUDIT.definitionRetired,
      entity: { type: 'WorkflowDefinition', id: row.id, companyId: row.companyId },
      before: snapshot(d),
      after: snapshot(row),
      reason: i.reason ?? null,
      operationKey: key,
    });
    return resultOf(row);
  });
}
