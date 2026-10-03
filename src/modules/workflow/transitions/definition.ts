// Definition commands (wfe-to-be.md §12.9, G6 / G7; AUDIT/16 §3.5): DRAFT → ACTIVE → RETIRED. An ACTIVE or RETIRED
// version is immutable (DB trigger); one DRAFT and one ACTIVE per (type, company) (partial uniques).
//
// G7: the editor is an owner-group login (SUPER_ADMIN / COMPANY_ADMIN), never a Radeef vendor account, in a Scoped
// context covering the definition's company; the tenant default (companyId null) needs a context over every company.
// Activation is refused while activationBlockers is not empty (phase 2: FIRST-TYPE until the owner chooses the first
// request type).
//
// Package C (BL-WFE-003; DEC-PO-146 / ADR-0011, INV-IAM-01 / ADR-0010), the two-person activation: an approval path
// decides who approves every request of its type, so the person who activates a version is never the one who created
// the draft nor the one who last edited it, and where the company is ENFORCED the activator counts toward ENFORCED
// (iam countsTowardEnforced: attested, not a vendor account). The one exception is the company that reads
// SINGLE_OPERATOR at activation (platform.resolveOperatorMode with the definition's company; the tenant default has
// no company and is always ENFORCED, fail closed): the activation then goes through when nobody else could do it — no
// other eligible editor for an author's own activation — and is recorded as SELF_ACT_SINGLE_OPERATOR (activation audit
// row, after.reasons) for the owner digest, with activationSelfAct set (the 9zn CHECK refuses an author-activated row
// without it). The database CHECK WorkflowDefinition_two_person_activation is the backstop.
//
// §12.1 "ما لا يُعطَّل": every save records the content before and after; a version that loosens a control against the
// version in force (definitionRelaxations) returns warnings on save, needs confirmRelaxations on activation, and its
// activation (or the retirement that falls back to a looser tenant default) writes CONTROL_RELAXED for the digest.
import type { Prisma, WorkflowDefinition } from '@prisma/client';
import { ROLE_GROUPS } from '@/lib/constants';
import { ALL_COMPANIES, activeUsersWithRolesInCompany, assertScopeContext, companiesAllowed, countsTowardEnforced, identityOf, type ScopeContext } from '@/modules/iam';
import { SELF_ACT_ACTION, audit, resolveOperatorMode, runTransition, type OperationOutcome, type RootClient, type TxClient } from '@/modules/platform';
import { activationBlockers } from '../activation';
import { REQUEST_TYPE_PATTERN, requireAdapter } from '../adapters';
import { definitionChecksum, definitionRelaxations, parseDefinition, readStoredDefinition, type DefinitionWarning, type WorkflowDefinitionDoc } from '../definition';
import { WorkflowError } from '../errors';
import { WORKFLOW_AUDIT } from '../events';
import { activationRefusal, activationSelfActReasons, authorshipOf, otherSecondPersons, type ActivationSelfActReason } from '../guardrails';

export interface DefinitionResult {
  id: string;
  requestType: string;
  companyId: string | null;
  version: number;
  status: WorkflowDefinition['status'];
  checksum: string;
  /** Save and activate: what this version loosens against the version in force (§12.1 editor warnings). */
  warnings?: DefinitionWarning[];
  /** Activate / retire: the act was the recorded single-operator exception. */
  selfAct?: boolean;
  /** Retire (DEC-PO-147): the request is recorded and waits for a second person; the version is still ACTIVE. */
  pendingSecondPerson?: boolean;
}

function resultOf(d: WorkflowDefinition, extra: Pick<DefinitionResult, 'warnings' | 'selfAct' | 'pendingSecondPerson'> = {}): DefinitionResult {
  return { id: d.id, requestType: d.requestType, companyId: d.companyId, version: d.version, status: d.status, checksum: d.checksum, ...extra };
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
async function assertEditorNow(tx: TxClient, userId: string) {
  const u = await identityOf(tx, userId);
  if (!u || !u.isActive || u.documentsOnlyUntil || u.isVendorStaff || !(ROLE_GROUPS.OWNER as readonly string[]).includes(u.role)) {
    throw new WorkflowError('WFE_FORBIDDEN', 'G7: the editor must be an active owner-group account of the customer (not a Radeef account)');
  }
  return u;
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

/** The ACTIVE version that governs (type, company) now: the company's own, else the tenant default (null: none). */
async function versionInForce(tx: TxClient, requestType: string, companyId: string | null, exceptId?: string): Promise<WorkflowDefinition | null> {
  const where = (c: string | null) => ({ requestType, companyId: c, status: 'ACTIVE' as const, ...(exceptId ? { id: { not: exceptId } } : {}) });
  if (companyId !== null) {
    const own = await tx.workflowDefinition.findFirst({ where: where(companyId) });
    if (own) return own;
  }
  return tx.workflowDefinition.findFirst({ where: where(null) });
}

function docOf(row: WorkflowDefinition | null): WorkflowDefinitionDoc | null {
  return row ? readStoredDefinition(row.definitionJson) : null;
}

/**
 * Saves the DRAFT of a type for a company (or the tenant): the strict schema and the §12.3 checks against the adapter's
 * catalogs. The one DRAFT is replaced in place; otherwise a new version (max + 1) is created. The saver becomes the
 * draft's last editor (DEC-PO-146). Returns the §12.1 warnings against the version in force.
 *
 * Idempotent per (editor, the draft it replaces, the content): the key names the current draft's id and checksum
 * (BL-WFE-014), so a save over a different draft is a new operation (C saves X, A saves Y, C saves X again: X, last
 * edited by C), while a repeated call over the draft it produced is a no-op (same content, no write, no audit).
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
  const current = await prisma.workflowDefinition.findFirst({ where: { requestType: i.requestType, companyId: i.companyId, status: 'DRAFT' }, select: { id: true, checksum: true } });
  const over = current ? `${current.id}:${current.checksum}` : 'new';
  const key = `wf:def:draft:${i.requestType}:${i.companyId ?? 'tenant'}:${editor}:${over}:${checksum}`;
  return runTransition(prisma, { key, operation: 'workflow.definition.saveDraft', actorId: editor, companyId: i.companyId }, async (tx) => {
    await assertEditorNow(tx, editor);
    if (i.basedOnId) {
      const base = await tx.workflowDefinition.findUnique({ where: { id: i.basedOnId }, select: { requestType: true, companyId: true } });
      if (!base || base.requestType !== i.requestType || (base.companyId !== null && base.companyId !== i.companyId)) throw new WorkflowError('WFE_VALIDATION', 'basedOnId must be a version of the same type');
    }
    const existing = await tx.workflowDefinition.findFirst({ where: { requestType: i.requestType, companyId: i.companyId, status: 'DRAFT' } });
    // The draft the key names must still be the draft (another save or an activation landed: the caller retries).
    if ((existing ? `${existing.id}:${existing.checksum}` : 'new') !== over) throw new WorkflowError('WFE_CONFLICT', 'the draft changed', { retryable: true });
    const warnings = definitionRelaxations(docOf(await versionInForce(tx, i.requestType, i.companyId)), doc);
    // Same content: nothing to save (the last editor stays the one who wrote it).
    if (existing && existing.checksum === checksum) return resultOf(existing, { warnings });
    let row: WorkflowDefinition;
    if (existing) {
      const { count } = await tx.workflowDefinition.updateMany({
        where: { id: existing.id, status: 'DRAFT', checksum: existing.checksum },
        data: { definitionJson: doc as unknown as Prisma.InputJsonObject, checksum, changeNote: i.changeNote ?? null, basedOnId: i.basedOnId ?? existing.basedOnId, lastEditedById: editor },
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
          lastEditedById: editor,
        },
      });
    }
    await audit(tx, {
      actor: { type: 'USER', id: editor },
      action: WORKFLOW_AUDIT.definitionDraftSaved,
      entity: { type: 'WorkflowDefinition', id: row.id, companyId: row.companyId },
      // §12.1: who changed it, when, and from which content to which.
      before: existing ? { ...snapshot(existing), definition: existing.definitionJson, lastEditedById: existing.lastEditedById ?? existing.createdById } : null,
      after: { ...snapshot(row), definition: doc, lastEditedById: editor, warnings: warnings.map((w) => w.code) },
      reason: i.changeNote ?? null,
      operationKey: key,
    });
    return resultOf(row, { warnings });
  });
}

/**
 * DEC-PO-146 / DEC-PO-147: is `actor` a second person for a change written by `authors`, in the company's mode read
 * now? Throws WFE_TWO_PERSON_REQUIRED when not; returns the self-act reasons (empty: a real second person).
 */
async function secondPerson(tx: TxClient, companyId: string | null, authors: readonly string[], actor: string, actorCounts: boolean) {
  const mode = await resolveOperatorMode(tx, companyId);
  const sides = new Map<string, Set<string>>();
  const who = await authorshipOf(tx, authors, actor, sides);
  const reasons: string[] = activationSelfActReasons({ createdById: authors[0], lastEditedById: authors[1] ?? null }, actor, actorCounts, who.tied || who.unattestedAuthor);
  let others = 0;
  if (who.tied && mode === 'SINGLE_OPERATOR' && companyId) {
    const editors = (await activeUsersWithRolesInCompany(tx, ROLE_GROUPS.OWNER, companyId)).map((u) => u.id);
    others = await otherSecondPersons(tx, editors, authors, actor, sides);
  }
  const refusal = activationRefusal(reasons as ActivationSelfActReason[], mode, others);
  if (refusal) throw new WorkflowError('WFE_TWO_PERSON_REQUIRED', refusal, { reasons, mode });
  return { mode, reasons };
}

/**
 * DRAFT → ACTIVE, atomically retiring the ACTIVE version of the same (type, company) (§12.9). Refused while
 * activationBlockers(type) is not empty (FIRST-TYPE), refused to the draft's own authors and their side (DEC-PO-147),
 * and in ENFORCED to a non-counted activator or for unattested authorship (DEC-PO-146), and refused without
 * confirmRelaxations when the version loosens a control.
 */
export async function activateWorkflowDefinition(
  prisma: RootClient,
  i: { ctx: ScopeContext; definitionId: string; confirmRelaxations?: boolean },
): Promise<OperationOutcome<DefinitionResult>> {
  assertScopeContext(i.ctx, 'activateWorkflowDefinition');
  const peek = await prisma.workflowDefinition.findUnique({ where: { id: i.definitionId }, select: { requestType: true, companyId: true } });
  if (!peek) throw new WorkflowError('WFE_NOT_FOUND');
  const editor = editorOf(i.ctx, peek.companyId);
  const blockers = activationBlockers(peek.requestType);
  if (blockers.length) throw new WorkflowError('WFE_NOT_ACTIVATABLE', blockers.join(', '), { blockers });
  const adapter = requireAdapter(peek.requestType);
  const key = `wf:def:activate:${i.definitionId}`;
  return runTransition(prisma, { key, operation: 'workflow.definition.activate', actorId: editor, companyId: peek.companyId }, async (tx) => {
    const me = await assertEditorNow(tx, editor);
    const d = await definitionInScope(tx, i.ctx, i.definitionId);
    if (d.status === 'ACTIVE') return resultOf(d, { selfAct: d.activationSelfAct });
    if (d.status !== 'DRAFT') throw new WorkflowError('WFE_INVALID_STATE', `a ${d.status} definition cannot be activated`);
    // The catalogs may have changed since the draft was saved: check again.
    const doc = parseDefinition(d.definitionJson, adapter);

    // DEC-PO-146 / 147: a second person, read now (the mode of THE DEFINITION'S company; the tenant default reads ENFORCED).
    const { mode, reasons } = await secondPerson(tx, d.companyId, [d.createdById, d.lastEditedById ?? d.createdById], editor, countsTowardEnforced(me));
    const selfAct = reasons.length > 0;

    // §12.1: the editor's warnings, confirmed.
    const current = await tx.workflowDefinition.findFirst({ where: { requestType: d.requestType, companyId: d.companyId, status: 'ACTIVE' } });
    const inForce = current ?? (await versionInForce(tx, d.requestType, d.companyId));
    const warnings = definitionRelaxations(docOf(inForce), doc);
    if (warnings.length && i.confirmRelaxations !== true) throw new WorkflowError('WFE_CONFIRMATION_REQUIRED', warnings.map((w) => w.code).join(', '), { warnings });

    const at = new Date();
    if (current) {
      const { count } = await tx.workflowDefinition.updateMany({
        where: { id: current.id, status: 'ACTIVE' },
        // A pending request to retire the replaced version is moot: the activation (itself two-person) retires it.
        data: { status: 'RETIRED', retiredAt: at, retiredById: editor, retireRequestedById: null, retireRequestedAt: null },
      });
      if (count === 0) throw new WorkflowError('WFE_CONFLICT', 'the active version changed', { retryable: true });
    }
    // CAS on the content AND its last editor: a save that lands between the read and this write is never activated by
    // a decision taken on the previous content.
    const { count } = await tx.workflowDefinition.updateMany({
      where: { id: d.id, status: 'DRAFT', checksum: d.checksum, lastEditedById: d.lastEditedById },
      data: { status: 'ACTIVE', activatedAt: at, activatedById: editor, activationSelfAct: selfAct },
    });
    if (count === 0) throw new WorkflowError('WFE_CONFLICT', 'the draft changed', { retryable: true });
    const row = await tx.workflowDefinition.findUniqueOrThrow({ where: { id: d.id } });
    // A new tenant default changes what every company version would fall back to: their pending retire requests go.
    const clearedRequests = d.companyId === null ? await clearRequestsFallingBackTo(tx, d.requestType, editor, key) : [];
    await audit(tx, {
      actor: { type: 'USER', id: editor },
      action: WORKFLOW_AUDIT.definitionActivated,
      entity: { type: 'WorkflowDefinition', id: row.id, companyId: row.companyId },
      before: snapshot(d),
      after: {
        ...snapshot(row),
        retiredId: current?.id ?? null,
        createdById: d.createdById,
        lastEditedById: d.lastEditedById ?? d.createdById,
        mode,
        relaxations: warnings.map((w) => w.code),
        clearedRequests,
        ...(selfAct ? { reasons } : {}),
      },
      reason: selfAct ? `${SELF_ACT_ACTION}: ${reasons.join(',')}` : null,
      operationKey: key,
    });
    if (warnings.length) {
      await audit(tx, {
        actor: { type: 'USER', id: editor },
        action: WORKFLOW_AUDIT.controlRelaxed,
        entity: { type: 'WorkflowDefinition', id: row.id, companyId: row.companyId },
        before: inForce ? { id: inForce.id, version: inForce.version, companyId: inForce.companyId } : null,
        after: { relaxations: warnings.map((w) => w.code), subject: `${row.requestType} v${row.version}`, confirmedBy: editor, selfActivated: selfAct },
        operationKey: key,
      });
    }
    return resultOf(row, { warnings, selfAct });
  });
}

/** The owner-digest reason names of a retirement done alone (the author of a retirement is the one who asked for it). */
function retireReasons(reasons: readonly string[]): string[] {
  return reasons.map((r) => (r === 'AUTHOR_ACTIVATED' ? 'AUTHOR_RETIRED' : r));
}

/** The pending retire request the confirmation was going to complete no longer has the effect its requester reviewed. */
class StaleRetireRequest extends Error {
  constructor(readonly definitionId: string, readonly requestedAt: Date, readonly detail: Record<string, unknown>) {
    super('the effect of the retirement changed since it was requested');
    this.name = 'StaleRetireRequest';
  }
}

/**
 * Clears the pending retire request of `d` (CAS on the request itself), with its audit. Returns false when there was
 * none (or another one by now). `why`: a code (WITHDRAWN, EFFECT_CHANGED, FALLBACK_CHANGED).
 */
async function clearPendingRetire(tx: TxClient, d: WorkflowDefinition, actor: string, key: string, why: string, detail: Record<string, unknown> = {}): Promise<boolean> {
  if (!d.retireRequestedById || !d.retireRequestedAt) return false;
  const { count } = await tx.workflowDefinition.updateMany({
    where: { id: d.id, status: 'ACTIVE', retireRequestedById: d.retireRequestedById, retireRequestedAt: d.retireRequestedAt },
    data: { retireRequestedById: null, retireRequestedAt: null, retireFallbackId: null, retireRelaxations: [] },
  });
  if (count === 0) return false;
  await audit(tx, {
    actor: { type: 'USER', id: actor },
    action: WORKFLOW_AUDIT.definitionRetireRequestCleared,
    entity: { type: 'WorkflowDefinition', id: d.id, companyId: d.companyId },
    before: { retireRequestedById: d.retireRequestedById, retireRequestedAt: d.retireRequestedAt, retireFallbackId: d.retireFallbackId, retireRelaxations: d.retireRelaxations },
    after: { retireRequestedById: null, ...detail },
    reason: why,
    operationKey: key,
  });
  return true;
}

/**
 * Clears the pending retire requests of the company versions of `requestType` (their fallback, the tenant default, has
 * just changed): a stale request never lingers to be confirmed against an effect nobody reviewed.
 */
async function clearRequestsFallingBackTo(tx: TxClient, requestType: string, actor: string, key: string): Promise<string[]> {
  const pending = await tx.workflowDefinition.findMany({ where: { requestType, companyId: { not: null }, status: 'ACTIVE', retireRequestedById: { not: null } }, orderBy: { id: 'asc' } });
  const cleared: string[] = [];
  for (const p of pending) if (await clearPendingRetire(tx, p, actor, key, 'FALLBACK_CHANGED')) cleared.push(p.id);
  return cleared;
}

/** The key of the clearing of one pending request (one per request, whoever clears it). */
function clearKey(definitionId: string, requestedAt: Date): string {
  return `wf:def:retireClear:${definitionId}:${requestedAt.toISOString()}`;
}

/**
 * Withdraws the pending request to retire a version (DEC-PO-147): an editor of the definition's company (G7), the
 * requester or another. Idempotent: one clearing per request; no request (or a newer one) is NO_CHANGE.
 */
export async function clearWorkflowRetireRequest(prisma: RootClient, i: { ctx: ScopeContext; definitionId: string; reason?: string }): Promise<OperationOutcome<DefinitionResult & { cleared: boolean }>> {
  assertScopeContext(i.ctx, 'clearWorkflowRetireRequest');
  const peek = await prisma.workflowDefinition.findUnique({ where: { id: i.definitionId }, select: { companyId: true, retireRequestedAt: true } });
  if (!peek) throw new WorkflowError('WFE_NOT_FOUND');
  const editor = editorOf(i.ctx, peek.companyId);
  const key = peek.retireRequestedAt ? clearKey(i.definitionId, peek.retireRequestedAt) : `wf:def:retireClear:${i.definitionId}:none:${editor}`;
  // actorId null: the clearing of a request is one operation whoever does it (a second clearer replays it).
  return runTransition(prisma, { key, operation: 'workflow.definition.retireRequestClear', actorId: null, companyId: peek.companyId }, async (tx) => {
    await assertEditorNow(tx, editor);
    const d = await definitionInScope(tx, i.ctx, i.definitionId);
    const at = peek.retireRequestedAt;
    const cleared = !!at && d.retireRequestedAt?.getTime() === at.getTime() && (await clearPendingRetire(tx, d, editor, key, i.reason?.trim() ? `WITHDRAWN: ${i.reason.trim()}` : 'WITHDRAWN'));
    const row = await tx.workflowDefinition.findUniqueOrThrow({ where: { id: d.id } });
    return { ...resultOf(row), cleared };
  });
}

/** The sorted relaxation codes of a retirement's effect. */
function codesOf(warnings: readonly { code: string }[]): string[] {
  return [...new Set(warnings.map((w) => w.code))].sort();
}

/**
 * ACTIVE → RETIRED (§12.9). Instances already started keep their pinned version (G6).
 *
 * DEC-PO-147: retiring a company version makes the tenant default govern that company again. When that loosens a control
 * (definitionRelaxations against the fallback), the retirement needs confirmRelaxations AND two people: the first call
 * records the request with what it reviewed (retireRequestedById, retireFallbackId, retireRelaxations; audit
 * workflow.definition.retireRequest; the result says pendingSecondPerson) and leaves the version ACTIVE; a second person
 * (under the activation rules: not the requester nor on his side, counted where the company is ENFORCED) confirms it
 * and retires. The confirmation recomputes the effect from the current state: when the fallback is another version or
 * the effect grew beyond what was reviewed (the BL-PAY-031 principle), it is refused (WFE_CONFLICT, retryable) and the
 * request is cleared, so a fresh request must be made. In SINGLE_OPERATOR, when no other eligible editor exists, the
 * requester's own call retires at once, recorded as SELF_ACT (retireSelfAct). Either way CONTROL_RELAXED is written for
 * the digest. A retirement that loosens nothing stays one person. Retiring the tenant default clears the pending
 * requests of the company versions that fall back to it.
 */
export async function retireWorkflowDefinition(
  prisma: RootClient,
  i: { ctx: ScopeContext; definitionId: string; reason?: string; confirmRelaxations?: boolean },
): Promise<OperationOutcome<DefinitionResult>> {
  assertScopeContext(i.ctx, 'retireWorkflowDefinition');
  const peek = await prisma.workflowDefinition.findUnique({ where: { id: i.definitionId }, select: { companyId: true, retireRequestedAt: true, updatedAt: true } });
  if (!peek) throw new WorkflowError('WFE_NOT_FOUND');
  const editor = editorOf(i.ctx, peek.companyId);
  // Per person and per request: the request and its confirmation are two operations of two people, and a request made
  // after an earlier one was cleared is a new operation (the key names the request in force, else the row's last change).
  const key = `wf:def:retire:${i.definitionId}:${editor}:${peek.retireRequestedAt ? peek.retireRequestedAt.toISOString() : `none:${peek.updatedAt.toISOString()}`}`;
  try {
    return await runTransition(prisma, { key, operation: 'workflow.definition.retire', actorId: editor, companyId: peek.companyId }, async (tx) => {
      const me = await assertEditorNow(tx, editor);
      const d = await definitionInScope(tx, i.ctx, i.definitionId);
      if (d.status === 'RETIRED') return resultOf(d);
      if (d.status !== 'ACTIVE') throw new WorkflowError('WFE_INVALID_STATE', 'only an ACTIVE definition is retired (a DRAFT is replaced)');
      const fallback = d.companyId !== null ? await versionInForce(tx, d.requestType, d.companyId, d.id) : null;
      const warnings = fallback ? definitionRelaxations(readStoredDefinition(d.definitionJson), readStoredDefinition(fallback.definitionJson)) : [];
      const codes = codesOf(warnings);
      if (warnings.length && i.confirmRelaxations !== true) throw new WorkflowError('WFE_CONFIRMATION_REQUIRED', codes.join(', '), { warnings });

      // A pending request is confirmed only against the effect its requester reviewed (fallback and relaxations).
      if (warnings.length && d.retireRequestedById && d.retireRequestedAt) {
        const grew = codes.filter((c) => !d.retireRelaxations.includes(c));
        if (d.retireFallbackId !== fallback?.id || grew.length) {
          throw new StaleRetireRequest(d.id, d.retireRequestedAt, { reviewedFallbackId: d.retireFallbackId, fallbackId: fallback?.id ?? null, reviewed: d.retireRelaxations, now: codes, grew });
        }
      }

      const at = new Date();
      let requestedBy: string | null = null;
      let reasons: string[] = [];
      if (warnings.length) {
        const requester = d.retireRequestedById;
        if (!requester || requester === editor) {
          // The first person: alone only as the single-operator exception (no other eligible editor), else a request.
          let alone: { reasons: string[] } | null = null;
          try {
            alone = await secondPerson(tx, d.companyId, [editor], editor, countsTowardEnforced(me));
          } catch (err) {
            if (!(err instanceof WorkflowError) || err.code !== 'WFE_TWO_PERSON_REQUIRED') throw err;
          }
          if (!alone) {
            if (!requester) {
              const { count } = await tx.workflowDefinition.updateMany({
                where: { id: d.id, status: 'ACTIVE', retireRequestedById: null },
                data: { retireRequestedById: editor, retireRequestedAt: at, retireFallbackId: fallback!.id, retireRelaxations: codes },
              });
              if (count === 0) throw new WorkflowError('WFE_CONFLICT', 'the definition changed', { retryable: true });
              await audit(tx, {
                actor: { type: 'USER', id: editor },
                action: WORKFLOW_AUDIT.definitionRetireRequested,
                entity: { type: 'WorkflowDefinition', id: d.id, companyId: d.companyId },
                before: snapshot(d),
                after: { ...snapshot(d), retireRequestedById: editor, fallbackId: fallback!.id, relaxations: codes },
                reason: i.reason ?? null,
                operationKey: key,
              });
            }
            return resultOf(d, { warnings, pendingSecondPerson: true });
          }
          requestedBy = editor;
          reasons = retireReasons(alone.reasons);
        } else {
          // The second person confirms the request of `requester`.
          reasons = retireReasons((await secondPerson(tx, d.companyId, [requester], editor, countsTowardEnforced(me))).reasons);
          requestedBy = requester;
        }
      }
      const selfAct = reasons.length > 0;
      const { count } = await tx.workflowDefinition.updateMany({
        where: { id: d.id, status: 'ACTIVE', retireRequestedById: d.retireRequestedById, retireRequestedAt: d.retireRequestedAt },
        data: {
          status: 'RETIRED',
          retiredAt: at,
          retiredById: editor,
          retireRequestedById: requestedBy,
          retireRequestedAt: requestedBy ? (d.retireRequestedAt ?? at) : null,
          retireFallbackId: requestedBy ? fallback!.id : null,
          retireRelaxations: requestedBy ? codes : [],
          retireSelfAct: selfAct,
        },
      });
      if (count === 0) throw new WorkflowError('WFE_CONFLICT', 'the definition changed', { retryable: true });
      const row = await tx.workflowDefinition.findUniqueOrThrow({ where: { id: d.id } });
      // The tenant default is gone: the company versions that would fall back to it have nothing left to fall back to.
      const clearedRequests = d.companyId === null ? await clearRequestsFallingBackTo(tx, d.requestType, editor, key) : [];
      await audit(tx, {
        actor: { type: 'USER', id: editor },
        action: WORKFLOW_AUDIT.definitionRetired,
        entity: { type: 'WorkflowDefinition', id: row.id, companyId: row.companyId },
        before: snapshot(d),
        after: { ...snapshot(row), fallbackId: fallback?.id ?? null, relaxations: codes, requestedById: requestedBy, clearedRequests, ...(selfAct ? { reasons } : {}) },
        reason: selfAct ? `${SELF_ACT_ACTION}: ${reasons.join(',')}${i.reason ? ` — ${i.reason}` : ''}` : (i.reason ?? null),
        operationKey: key,
      });
      if (warnings.length) {
        await audit(tx, {
          actor: { type: 'USER', id: editor },
          action: WORKFLOW_AUDIT.controlRelaxed,
          entity: { type: 'WorkflowDefinition', id: row.id, companyId: row.companyId },
          before: { id: d.id, version: d.version, companyId: d.companyId },
          after: {
            relaxations: codes,
            subject: `${row.requestType} v${row.version} retired: the tenant default v${fallback?.version} governs`,
            requestedBy,
            confirmedBy: editor,
            selfActivated: selfAct,
          },
          operationKey: key,
        });
      }
      return resultOf(row, warnings.length ? { warnings, selfAct } : {});
    });
  } catch (err) {
    if (!(err instanceof StaleRetireRequest)) throw err;
    // The confirmation is refused (its transaction rolled back); the stale request is cleared in a transaction of its
    // own, audited, so the next call starts a fresh request against the current effect.
    const ck = clearKey(err.definitionId, err.requestedAt);
    await runTransition(prisma, { key: ck, operation: 'workflow.definition.retireRequestClear', actorId: null, companyId: peek.companyId }, async (tx) => {
      const d = await tx.workflowDefinition.findUnique({ where: { id: err.definitionId } });
      const done = !!d && d.retireRequestedAt?.getTime() === err.requestedAt.getTime() && (await clearPendingRetire(tx, d, editor, ck, 'EFFECT_CHANGED', err.detail));
      return { cleared: done };
    });
    throw new WorkflowError('WFE_CONFLICT', 'the effect of this retirement changed since it was requested (another fallback version, or more controls loosened): the request was cleared; request it again to review the new effect', { retryable: true, ...err.detail });
  }
}
