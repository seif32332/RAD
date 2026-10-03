// Instance transitions of the approval engine (wfe-to-be.md §11.1, §12.10, §12.11; AUDIT/16 §3.5, §3.6).
// start, pause, resume, closeExternally, recheck, resubmit and restartRound join the calling module's transaction
// (idempotent(tx, …)); cancel opens its own (runTransition). Every write is a CAS on the instance version, after the
// employee lock (ARCH-019.port). The actor is always the context's (never a client value).
import type { WorkflowInstanceStatus } from '@prisma/client';
import { assertScopeContext, companiesAllowed, type ScopeContext } from '@/modules/iam';
import { idempotent, runTransition, type OperationOutcome, type RootClient, type TxClient } from '@/modules/platform';
import { activationBlockers } from '../activation';
import { CANCEL_REQUESTED, CODE_PATTERN, requireAdapter, type ActorView, type Parties, type WfActor } from '../adapters';
import { readStoredDefinition } from '../definition';
import { OPEN_STATUSES, TERMINAL_STATUSES, assertTransition, isTerminal, pushReason } from '../engine';
import { WorkflowError, retryableConflict } from '../errors';
import { WORKFLOW_AUDIT, WORKFLOW_EVENTS } from '../events';
import { ALWAYS_REQUIRED_PORTS, requirePorts } from '../ports';
import { activeDefinitionFor } from '../queries';
import { beneficiaryUserIds, buildManagerChain, eligibleInCompany, maxChainLevels, resolveSpecial } from '../resolve';
import {
  HookFailure,
  actorOfContext,
  applyProgress,
  auditInstance,
  casInstance,
  casLost,
  chainChange,
  closeAllOpen,
  createTasks,
  currentStageCandidates,
  emitAssigned,
  emitBlocked,
  emitDecided,
  emitInstance,
  hookContext,
  lockParties,
  openFrame,
  openTasksOf,
  planNext,
  portsFor,
  resolveEnvOf,
  resultOf,
  roundState,
  runHook,
  sha256,
  sortedIds,
  statusData,
  userIdOf,
  viewOf,
  type Emitter,
  type Frame,
  type InstanceRow,
  type TaskRow,
  type WorkflowResult,
} from './internal/core';
import { chainData, chainDetail, pauseData, recheckInFrame, resumeInFrame } from './internal/flows';

export type { WorkflowResult };

function assertCode(value: string, what: string): void {
  if (typeof value !== 'string' || !CODE_PATTERN.test(value)) throw new WorkflowError('WFE_VALIDATION', `${what} must be a code (${CODE_PATTERN})`);
}

function assertCallerKey(callerKey: string): void {
  if (typeof callerKey !== 'string' || !callerKey.trim() || callerKey.length > 200) throw new WorkflowError('WFE_VALIDATION', 'callerKey is required');
}

function effectFailed(err: unknown): never {
  if (err instanceof HookFailure) throw new WorkflowError('WFE_EFFECT_FAILED', err.message);
  throw err;
}

function checkParties(p: Parties): void {
  if (!p || !Array.isArray(p.beneficiaryEmployeeIds) || !p.beneficiaryEmployeeIds.every((x) => typeof x === 'string' && x)) {
    throw new WorkflowError('WFE_VALIDATION', 'parties().beneficiaryEmployeeIds must be a list of ids');
  }
  if (p.requesterUserId !== null && typeof p.requesterUserId !== 'string') throw new WorkflowError('WFE_VALIDATION', 'parties().requesterUserId must be a string or null');
  if (!p.contextSnapshot || typeof p.contextSnapshot !== 'object' || Array.isArray(p.contextSnapshot)) throw new WorkflowError('WFE_VALIDATION', 'parties().contextSnapshot must be an object');
}

// ---------------------------------------------------------------------------------------------------
// start

/**
 * Starts the approval of one request (§11.1 row "— | start"). Locks the beneficiaries, then the adapter's keys; all
 * beneficiaries in one company inside the context; validateSubmit; the ACTIVE definition (company, then tenant); the
 * manager-chain snapshot; then the walk: tasks (RUNNING / BLOCKED), or the automatic path (APPROVED or
 * AWAITING_REQUIREMENT). Refused while activationBlockers is not empty (phase 2: always).
 */
export async function startWorkflow(tx: TxClient, i: { ctx: ScopeContext; requestType: string; requestId: string }): Promise<WorkflowResult> {
  assertScopeContext(i.ctx, 'startWorkflow');
  requirePorts(ALWAYS_REQUIRED_PORTS);
  const adapter = requireAdapter(i.requestType);
  const blockers = activationBlockers(i.requestType);
  if (blockers.length) throw new WorkflowError('WFE_NOT_ACTIVATABLE', blockers.join(', '), { blockers });
  if (typeof i.requestId !== 'string' || !i.requestId.trim()) throw new WorkflowError('WFE_VALIDATION', 'requestId is required');
  const key = `wf:start:${i.requestType}:${i.requestId}`;
  const actor = actorOfContext(i.ctx);
  const out = await idempotent(tx, { key, operation: 'workflow.start', actorId: userIdOf(actor) }, async (t) => {
    const request = await adapter.load(t, i.requestId);
    const parties = await adapter.parties(t, request);
    checkParties(parties);
    const ben = sortedIds(parties.beneficiaryEmployeeIds);
    const locked = await lockParties(t, i.ctx, ben, adapter, request);
    let companyId: string;
    if (ben.length) {
      const companies = new Set(locked.map((r) => r.legalCompanyId));
      if (locked.length !== ben.length || companies.size !== 1 || companies.has(null)) throw new WorkflowError('WFE_CROSS_COMPANY');
      companyId = [...companies][0] as string;
    } else {
      if (!parties.companyIdWhenNoBeneficiary) throw new WorkflowError('WFE_VALIDATION', 'a request without beneficiary must name its company');
      companyId = parties.companyIdWhenNoBeneficiary;
    }
    if (!companiesAllowed(i.ctx.companies, [companyId])) throw new WorkflowError('WFE_FORBIDDEN', 'the request company is outside the context');
    await adapter.validateSubmit(t, request);
    const defRow = await activeDefinitionFor(t, i.requestType, companyId);
    if (!defRow) throw new WorkflowError('WFE_NO_ACTIVE_DEFINITION', i.requestType);
    const def = readStoredDefinition(defRow.definitionJson);
    requirePorts(portsFor(def));
    const at = new Date();
    const levels = maxChainLevels(def.root);
    const chain = levels ? await buildManagerChain(t, parties.beneficiaryEmployeeIds[0] ?? null, levels, at) : [];

    const created = await t.workflowInstance.create({
      data: {
        companyId,
        requestType: i.requestType,
        requestId: i.requestId,
        definitionId: defRow.id,
        status: 'RUNNING',
        beneficiaryEmployeeIds: ben,
        requesterUserId: parties.requesterUserId,
        hasPayEffect: false,
        contextSnapshotJson: parties.contextSnapshot as object,
        managerChainSnapshot: chain as unknown as object,
        startedAt: at,
      },
    });
    const f: Frame = { tx: t, ctx: i.ctx, adapter, request, inst: created, def, at };
    const env = await resolveEnvOf(f);
    const state = await roundState(f);
    const plan = await planNext(f, state, env, false);
    const after = await casInstance(t, created, ['RUNNING'], statusData(plan, at, null));
    if (!after) throw retryableConflict(created.id, created.version);
    const e: Emitter = { tx: t, inst: after, opKey: key, actor };
    let opened: TaskRow[];
    try {
      opened = await applyProgress({ ...f, inst: after }, e, created, after, plan, state);
    } catch (err) {
      effectFailed(err);
    }
    await auditInstance(e, WORKFLOW_AUDIT.started, null, after, { detail: { definitionId: defRow.id, definitionVersion: defRow.version, beneficiaryEmployeeIds: ben, openedTaskIds: opened.map((x) => x.id) } });
    if (plan.autoApproved) await auditInstance(e, WORKFLOW_AUDIT.autoApproved, null, after, { detail: { actor: 'system.autoApprove', definitionId: defRow.id, path: plan.path } });
    return resultOf(after, 'APPLIED', opened.map((x) => x.id));
  });
  return out.result;
}

// ---------------------------------------------------------------------------------------------------
// pause / resume

/**
 * pause(reason) (§11.1): RUNNING, RETURNED, AWAITING_REQUIREMENT → PAUSED (previousStatus saved on the first pause
 * only); PAUSED → PAUSED (reason pushed); BLOCKED → BLOCKED (reason pushed, previousStatus RUNNING on the first).
 * The stack is a set: a reason already present changes nothing.
 */
export async function pauseWorkflow(tx: TxClient, i: { ctx: ScopeContext; instanceId: string; reason: string; callerKey: string }): Promise<WorkflowResult> {
  assertScopeContext(i.ctx, 'pauseWorkflow');
  assertCode(i.reason, 'reason');
  assertCallerKey(i.callerKey);
  requirePorts(ALWAYS_REQUIRED_PORTS);
  const key = `wf:pause:${i.instanceId}:${i.reason}:${i.callerKey}`;
  const actor = actorOfContext(i.ctx);
  const out = await idempotent(tx, { key, operation: 'workflow.pause', actorId: userIdOf(actor) }, async (t) => {
    const f = await openFrame(t, i.ctx, i.instanceId);
    if (!f.adapter.pauseReasons.includes(i.reason)) throw new WorkflowError('WFE_VALIDATION', `pause reason ${i.reason} is not declared by the ${f.inst.requestType} adapter`);
    if (isTerminal(f.inst.status) || f.inst.pauseReasons.includes(i.reason)) return resultOf(f.inst, 'NO_CHANGE');
    assertTransition('pause', f.inst.status);
    const after = await casInstance(t, f.inst, [f.inst.status], pauseData(f.inst, i.reason, f.at));
    if (!after) return casLost(t, f.inst.id);
    await auditInstance({ tx: t, inst: after, opKey: key, actor }, WORKFLOW_AUDIT.paused, f.inst, after, { reason: i.reason });
    return resultOf(after, 'APPLIED');
  });
  return out.result;
}

/**
 * resume(reason) (§11.1): PAUSED → PAUSED while a reason remains, else previousStatus (the deadlines start again);
 * BLOCKED → BLOCKED with the reason removed, then the candidates are resolved again (out of BLOCKED when every step
 * has someone). A reason not on the stack changes nothing.
 */
export async function resumeWorkflow(tx: TxClient, i: { ctx: ScopeContext; instanceId: string; reason: string; callerKey: string }): Promise<WorkflowResult> {
  assertScopeContext(i.ctx, 'resumeWorkflow');
  assertCode(i.reason, 'reason');
  assertCallerKey(i.callerKey);
  requirePorts(ALWAYS_REQUIRED_PORTS);
  const key = `wf:resume:${i.instanceId}:${i.reason}:${i.callerKey}`;
  const actor = actorOfContext(i.ctx);
  const out = await idempotent(tx, { key, operation: 'workflow.resume', actorId: userIdOf(actor) }, async (t) => {
    const f = await openFrame(t, i.ctx, i.instanceId);
    if (i.reason === CANCEL_REQUESTED) throw new WorkflowError('WFE_VALIDATION', 'CANCEL_REQUESTED is resumed by the CANCEL_CONFIRM decision only');
    if (isTerminal(f.inst.status) || !f.inst.pauseReasons.includes(i.reason)) return resultOf(f.inst, 'NO_CHANGE');
    const r = await resumeInFrame(f, { tx: t, inst: f.inst, opKey: key, actor }, i.reason);
    if (!r) return casLost(t, f.inst.id);
    return resultOf(r.after, 'APPLIED');
  });
  return out.result;
}

// ---------------------------------------------------------------------------------------------------
// closeExternally

/**
 * closeExternally(outcome, source, actor) (§12.10): a module operation decided the request (OFF deferral decision,
 * deemed acceptance, withdrawal, exit policy). One close per instance. A USER actor must be the context's own login
 * and passes strict G1 / G1b and the general eligibility (G9) on current data. APPROVED runs no onApproved;
 * REJECTED runs onRejected; CANCELLED runs onCancelled.
 */
export async function closeWorkflowExternally(
  tx: TxClient,
  i: { ctx: ScopeContext; instanceId: string; outcome: 'APPROVED' | 'REJECTED' | 'CANCELLED'; source: string; actor: WfActor; note?: string },
): Promise<WorkflowResult> {
  assertScopeContext(i.ctx, 'closeWorkflowExternally');
  if (!TERMINAL_STATUSES.includes(i.outcome)) throw new WorkflowError('WFE_VALIDATION', 'outcome must be APPROVED, REJECTED or CANCELLED');
  assertCode(i.source, 'source');
  if (i.actor?.type === 'USER') {
    if (i.ctx.kind === 'system' || i.ctx.actor.userId !== i.actor.userId) throw new WorkflowError('WFE_FORBIDDEN', 'the actor must be the context user');
  } else if (i.actor?.type !== 'SYSTEM' || !i.actor.job?.trim()) {
    throw new WorkflowError('WFE_VALIDATION', 'actor must be USER or SYSTEM');
  } else if (i.ctx.kind !== 'system' || i.ctx.job !== i.actor.job) {
    // Review H-1: a person's context may not close as a job (that would skip G1 / G1b / G9). A SYSTEM close is the
    // job of the SystemContext itself, never a value chosen by the caller.
    throw new WorkflowError('WFE_FORBIDDEN', 'a SYSTEM close needs the SystemContext of that job');
  }
  requirePorts(ALWAYS_REQUIRED_PORTS);
  const key = `wf:close:${i.instanceId}`;
  const out = await idempotent(tx, { key, operation: 'workflow.closeExternally', actorId: userIdOf(i.actor), fingerprint: sha256({ outcome: i.outcome, source: i.source, actor: i.actor }) }, async (t) => {
    const f = await openFrame(t, i.ctx, i.instanceId);
    if (!f.adapter.closeSources.includes(i.source)) throw new WorkflowError('WFE_VALIDATION', `close source ${i.source} is not declared by the ${f.inst.requestType} adapter`);
    if (isTerminal(f.inst.status)) return resultOf(f.inst, 'NO_CHANGE');
    assertTransition('closeExternally', f.inst.status);
    if (i.actor.type === 'USER') await assertHumanCloser(f, i.actor.userId);
    const after = await casInstance(t, f.inst, OPEN_STATUSES, {
      status: i.outcome,
      closedAt: f.at,
      closeKind: 'EXTERNAL',
      closeSource: i.source,
      closedByUserId: userIdOf(i.actor),
      previousStatus: null,
      pauseReasons: [],
      pausedAt: null,
      blockedAt: null,
      blockedReason: null,
      awaitingRequirement: null,
      awaitingSince: null,
    });
    if (!after) return casLost(t, f.inst.id);
    const e: Emitter = { tx: t, inst: after, opKey: key, actor: i.actor };
    await closeAllOpen({ ...f, inst: after }, e);
    const hc = hookContext(f, after, i.actor, key, { note: i.note ?? null, closeSource: i.source });
    if (i.outcome === 'REJECTED') await runHook('onRejected', f, hc);
    if (i.outcome === 'CANCELLED') await runHook('onCancelled', f, hc);
    await auditInstance(e, WORKFLOW_AUDIT.closedExternally, f.inst, after, { reason: i.note ?? null });
    await emitDecided(e, after);
    return resultOf(after, 'APPLIED');
  });
  return out.result;
}

/** G1 / G1b / G9 (general) for a human behind closeExternally, on current data. */
async function assertHumanCloser(f: Frame, userId: string): Promise<void> {
  const ben = await beneficiaryUserIds(f.tx, f.inst.beneficiaryEmployeeIds, f.at);
  if (ben.has(userId) || f.inst.requesterUserId === userId) throw new WorkflowError('WFE_SELF_ACTION');
  const eligible = await eligibleInCompany(f.tx, f.inst.companyId, f.at);
  if (!eligible.has(userId)) throw new WorkflowError('WFE_FORBIDDEN', 'the actor is not an eligible user of the instance company');
}

// ---------------------------------------------------------------------------------------------------
// recheck

/**
 * recheck (§11.1, §12.11 3b): AWAITING_REQUIREMENT → APPROVED when validateFinal is ok (REQUIREMENT_MET);
 * RUNNING → the candidates of the OPEN tasks resolved again (BLOCKED when a step has nobody); BLOCKED → the same, and
 * out of BLOCKED when every step has someone. Any other status: NO_CHANGE. Jobs pass their JobRun id as callerKey.
 */
export async function recheckWorkflow(tx: TxClient, i: { ctx: ScopeContext; instanceId: string; callerKey: string }): Promise<WorkflowResult> {
  assertScopeContext(i.ctx, 'recheckWorkflow');
  assertCallerKey(i.callerKey);
  requirePorts(ALWAYS_REQUIRED_PORTS);
  const key = `wf:recheck:${i.instanceId}:${i.callerKey}`;
  const actor = actorOfContext(i.ctx);
  const out = await idempotent(tx, { key, operation: 'workflow.recheck', actorId: userIdOf(actor) }, async (t) => {
    const f = await openFrame(t, i.ctx, i.instanceId);
    try {
      return await recheckInFrame(f, { tx: t, inst: f.inst, opKey: key, actor }, null);
    } catch (err) {
      effectFailed(err);
    }
  });
  return out.result;
}

// ---------------------------------------------------------------------------------------------------
// resubmit / restartRound (a new round)

async function refreshParties(f: Frame): Promise<Parties> {
  const p = await f.adapter.parties(f.tx, f.request);
  checkParties(p);
  if (sortedIds(p.beneficiaryEmployeeIds).join(',') !== f.inst.beneficiaryEmployeeIds.join(',') || p.requesterUserId !== f.inst.requesterUserId) {
    throw new WorkflowError('WFE_VALIDATION', 'the beneficiaries or the requester of a request cannot change; cancel it and submit a new one');
  }
  return p;
}

/** A new round: the walk from the start of the definition, with the refreshed context; old open tasks NOT_REQUIRED. */
async function newRound(f: Frame, e: Emitter, from: WorkflowInstanceStatus, action: string, reason: string | null): Promise<WorkflowResult> {
  const parties = await refreshParties(f);
  await f.adapter.validateSubmit(f.tx, f.request);
  const nextInst: InstanceRow = { ...f.inst, round: f.inst.round + 1, contextSnapshotJson: parties.contextSnapshot as object };
  const nf: Frame = { ...f, inst: nextInst };
  const oldOpen = (await openTasksOf(f.tx, f.inst)) as TaskRow[];
  const env = await resolveEnvOf(nf);
  const state = await roundState(nf);
  const plan = await planNext(nf, { ...state, open: [] }, env, false);
  const chain = chainChange(nf, env);
  const after = await casInstance(f.tx, f.inst, [from], {
    ...chainData(chain),
    ...statusData(plan, f.at, null),
    round: f.inst.round + 1,
    contextSnapshotJson: parties.contextSnapshot as object,
  });
  if (!after) return casLost(f.tx, f.inst.id);
  const ee = { ...e, inst: after };
  await closeAllOpen({ ...f, inst: after }, ee);
  const opened = await createTasks(f.tx, after, plan.toOpen);
  await emitAssigned(ee, opened);
  if (after.status === 'BLOCKED') await emitBlocked(ee, after, opened);
  if (after.status === 'AWAITING_REQUIREMENT') await emitInstance(ee, WORKFLOW_EVENTS.instanceAwaitingRequirement, { requirement: after.awaitingRequirement });
  if (after.status === 'APPROVED') {
    await runHook('onApproved', nf, hookContext(nf, after, e.actor, e.opKey));
    await emitDecided(ee, after);
  }
  await auditInstance(ee, action, f.inst, after, { reason, detail: { closedTaskIds: oldOpen.map((t) => t.id), openedTaskIds: opened.map((t) => t.id), ...chainDetail(f.inst, chain) } });
  if (plan.autoApproved) await auditInstance(ee, WORKFLOW_AUDIT.autoApproved, null, after, { detail: { actor: 'system.autoApprove', path: plan.path } });
  return resultOf(after, 'APPLIED', opened.map((t) => t.id));
}

/** resubmit (§11.1 RETURNED → RUNNING, round + 1): the requester's module resubmits after a return. */
export async function resubmitWorkflow(tx: TxClient, i: { ctx: ScopeContext; instanceId: string }): Promise<WorkflowResult> {
  assertScopeContext(i.ctx, 'resubmitWorkflow');
  requirePorts(ALWAYS_REQUIRED_PORTS);
  const peek = await tx.workflowInstance.findUnique({ where: { id: i.instanceId }, select: { companyId: true, round: true, status: true } });
  if (!peek || !companiesAllowed(i.ctx.companies, [peek.companyId])) throw new WorkflowError('WFE_NOT_FOUND');
  // The key names the round that was returned (§3.6 `r${round}`): once resubmitted the instance is in round + 1, so a
  // repeated call (which then reads round + 1) still finds the recorded operation and replays it.
  const returnedRound = peek.status === 'RETURNED' ? peek.round : peek.round - 1;
  const key = `wf:resubmit:${i.instanceId}:r${returnedRound}`;
  const actor = actorOfContext(i.ctx);
  const out = await idempotent(tx, { key, operation: 'workflow.resubmit', actorId: userIdOf(actor), fingerprint: sha256({ actor }) }, async (t) => {
    const f = await openFrame(t, i.ctx, i.instanceId);
    if (isTerminal(f.inst.status) || f.inst.round !== returnedRound) return resultOf(f.inst, 'NO_CHANGE');
    assertTransition('resubmit', f.inst.status);
    try {
      return await newRound(f, { tx: t, inst: f.inst, opKey: key, actor }, 'RETURNED', WORKFLOW_AUDIT.resubmitted, null);
    } catch (err) {
      effectFailed(err);
    }
  });
  return out.result;
}

/** restartRound (§11.1 RUNNING → RUNNING, round + 1): the module changed the request (e.g. LEV editPending). */
export async function restartWorkflowRound(tx: TxClient, i: { ctx: ScopeContext; instanceId: string; reason: string; callerKey: string }): Promise<WorkflowResult> {
  assertScopeContext(i.ctx, 'restartWorkflowRound');
  assertCode(i.reason, 'reason');
  assertCallerKey(i.callerKey);
  requirePorts(ALWAYS_REQUIRED_PORTS);
  const peek = await tx.workflowInstance.findUnique({ where: { id: i.instanceId }, select: { companyId: true } });
  if (!peek || !companiesAllowed(i.ctx.companies, [peek.companyId])) throw new WorkflowError('WFE_NOT_FOUND');
  // Deviation from AUDIT/16 §3.6 (`…:r${round}:${callerKey}`): the round moves with the restart itself, so a key that
  // contains it could never be replayed. The caller's key (its own operation id) is unique per restart.
  const key = `wf:restart:${i.instanceId}:${i.callerKey}`;
  const actor = actorOfContext(i.ctx);
  const out = await idempotent(tx, { key, operation: 'workflow.restartRound', actorId: userIdOf(actor) }, async (t) => {
    const f = await openFrame(t, i.ctx, i.instanceId);
    if (isTerminal(f.inst.status)) return resultOf(f.inst, 'NO_CHANGE');
    assertTransition('restartRound', f.inst.status);
    try {
      return await newRound(f, { tx: t, inst: f.inst, opKey: key, actor }, 'RUNNING', WORKFLOW_AUDIT.roundRestarted, i.reason);
    } catch (err) {
      effectFailed(err);
    }
  });
  return out.result;
}

// ---------------------------------------------------------------------------------------------------
// cancel

function actorViewOf(ctx: ScopeContext): ActorView {
  if (ctx.kind === 'system') throw new WorkflowError('WFE_FORBIDDEN', 'a person cancels');
  return { userId: ctx.actor.userId, role: ctx.actor.role, employeeId: ctx.actor.employeeId };
}

/**
 * cancel (§11.1 non-terminal → CANCELLED; §12.10 CANCEL_CONFIRM): adapter.canCancel(actor) decides who may. When
 * cancelNeedsConfirm, the request is PAUSED(CANCEL_REQUESTED) and ONE CANCEL_CONFIRM task is opened for the current
 * stage's candidates (not the canceller, not the beneficiary, not the requester); a second request is refused.
 */
export async function cancelWorkflow(
  prisma: RootClient,
  i: { ctx: ScopeContext; instanceId: string; expectedVersion: number; reason: string; idempotencyKey?: string },
): Promise<OperationOutcome<WorkflowResult>> {
  assertScopeContext(i.ctx, 'cancelWorkflow');
  const me = actorViewOf(i.ctx);
  const reason = typeof i.reason === 'string' ? i.reason.trim() : '';
  if (!reason) throw new WorkflowError('WFE_VALIDATION', 'a reason is required');
  if (!Number.isInteger(i.expectedVersion) || i.expectedVersion < 0) throw new WorkflowError('WFE_VALIDATION', 'expectedVersion is required');
  requirePorts(ALWAYS_REQUIRED_PORTS);
  const key = i.idempotencyKey ? `wf:cancel:${me.userId}:${i.idempotencyKey}` : `wf:cancel:${i.instanceId}:${me.userId}:v${i.expectedVersion}`;
  const actor: WfActor = { type: 'USER', userId: me.userId };
  return runTransition(prisma, { key, operation: 'workflow.cancel', actorId: me.userId, fingerprint: sha256({ reason }) }, async (t) => {
    const f = await openFrame(t, i.ctx, i.instanceId);
    if (isTerminal(f.inst.status)) return resultOf(f.inst, 'NO_CHANGE');
    if (f.inst.version !== i.expectedVersion) throw retryableConflict(f.inst.id, f.inst.version);
    if (f.adapter.refresh) await f.adapter.refresh(t, f.request);
    if (!f.adapter.canCancel(me, f.request)) throw new WorkflowError('WFE_FORBIDDEN', 'canCancel refused');
    const e: Emitter = { tx: t, inst: f.inst, opKey: key, actor };
    if (f.adapter.cancelNeedsConfirm(viewOf(f.inst), f.request)) return requestCancel(f, e, me.userId, reason);
    assertTransition('cancel', f.inst.status);
    const after = await casInstance(t, f.inst, OPEN_STATUSES, {
      status: 'CANCELLED',
      closedAt: f.at,
      closeKind: 'CANCELLED_BY_ACTOR',
      closedByUserId: me.userId,
      previousStatus: null,
      pauseReasons: [],
      pausedAt: null,
      blockedAt: null,
      blockedReason: null,
      awaitingRequirement: null,
      awaitingSince: null,
    });
    if (!after) return casLost(t, f.inst.id);
    const ee = { ...e, inst: after };
    await closeAllOpen({ ...f, inst: after }, ee);
    await runHook('onCancelled', f, hookContext(f, after, actor, key, { note: reason }));
    await auditInstance(ee, WORKFLOW_AUDIT.cancelled, f.inst, after, { reason });
    await emitDecided(ee, after);
    return resultOf(after, 'APPLIED');
  });
}

async function requestCancel(f: Frame, e: Emitter, cancellerId: string, reason: string): Promise<WorkflowResult> {
  assertTransition('requestCancel', f.inst.status);
  const open = (await openTasksOf(f.tx, f.inst)) as TaskRow[];
  if (open.some((t) => t.kind === 'CANCEL_CONFIRM')) throw new WorkflowError('WFE_INVALID_STATE', 'a cancellation is already waiting for confirmation');
  const env = await resolveEnvOf(f);
  const context: Record<string, unknown> = { requestedByUserId: cancellerId, reason };
  const fromStatus = f.inst.status === 'PAUSED' ? f.inst.previousStatus : f.inst.status;
  if (fromStatus === 'AWAITING_REQUIREMENT') Object.assign(context, { awaitingRequirement: f.inst.awaitingRequirement, awaitingSince: f.inst.awaitingSince?.toISOString() ?? null });
  const n = (await f.tx.workflowTask.count({ where: { instanceId: f.inst.id, companyId: f.inst.companyId, round: f.inst.round, kind: 'CANCEL_CONFIRM' } })) + 1;
  const nodeId = `CANCEL_CONFIRM#${n}`;
  const res = resolveSpecial('CANCEL_CONFIRM', nodeId, env, new Map([[cancellerId, 'CANCELLER' as const]]), currentStageCandidates(open));
  // Nobody can confirm: BLOCKED (§12.5, RT-WFE-1006), keeping the stack and where the instance came from. BLOCKED
  // cannot hold the awaiting requirement (9zj CHECK): the CANCEL_CONFIRM context keeps it for the way back.
  let data: Record<string, unknown> = pauseData(f.inst, CANCEL_REQUESTED, f.at);
  if (res.blocked && f.inst.status !== 'BLOCKED') {
    data = {
      status: 'BLOCKED',
      pauseReasons: pushReason(f.inst.pauseReasons, CANCEL_REQUESTED),
      previousStatus: fromStatus ?? 'RUNNING',
      pausedAt: null,
      blockedAt: f.at,
      blockedReason: 'NO_CANDIDATE',
      awaitingRequirement: null,
      awaitingSince: null,
    };
  }
  const after = await casInstance(f.tx, f.inst, OPEN_STATUSES, data);
  if (!after) return casLost(f.tx, f.inst.id);
  const ee = { ...e, inst: after };
  const [task] = await createTasks(f.tx, after, [{ nodeId, kind: 'CANCEL_CONFIRM', res, dueAt: null, context }]);
  await emitAssigned(ee, [task]);
  if (after.status === 'BLOCKED' && f.inst.status !== 'BLOCKED') await emitBlocked(ee, after, [task]);
  await auditInstance(ee, WORKFLOW_AUDIT.cancelRequested, f.inst, after, { reason, detail: { taskId: task.id } });
  return resultOf(after, 'APPLIED', [task.id]);
}

