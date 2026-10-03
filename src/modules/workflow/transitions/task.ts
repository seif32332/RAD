// actOnWorkflowTask: a person decides one task (wfe-to-be.md §11.1, §11.2, §12.8, §12.11; AUDIT/16 §3.5).
//
// Order (§12.11): read the task and instance (other company → 404) → load the request → lockEmployees (beneficiaries,
// ascending) → adapter.lockKeys → fresh read → refresh → actor checks on CURRENT data → CAS on the instance → the task
// (updateMany where OPEN) → next steps → hooks → audit → events. A persistent onApproved failure rolls everything back
// (the task stays OPEN) and is recorded by a separate transaction (effectFailedAt + workflow.instance.effectFailed).
//
// Actor checks (DEC-PO-145 guardrails 2, 3): the actor is the context's login. He must be a candidate of the task
// whose candidate entry still holds live (iam role, company scope, active, not documents-only, not a vendor account,
// not separated) and who is not excluded on current data: never a beneficiary's login (G1) nor the requester (G1b),
// never the first rejecter on the REJECT_PAIR, never the canceller on the CANCEL_CONFIRM, never a prior approver on a
// distinctFromPrior stage, never the approver of a parallel-ALL sibling (G2b), and never one an adapter guard excludes.
// The only non-candidate who may act is a holder of rejectAuthority, and only to REJECT, with the same exclusions.
import { assertScopeContext, type ScopeContext } from '@/modules/iam';
import { runTransition, type OperationOutcome, type RootClient } from '@/modules/platform';
import type { Prisma } from '@prisma/client';
import { CANCEL_REQUESTED, type ActorView, type WfActor } from '../adapters';
import { DECISIONS_BY_KIND, isTerminal, slotIndex, type WorkflowDecision } from '../engine';
import { WorkflowError, isWorkflowError, retryableConflict } from '../errors';
import { WORKFLOW_AUDIT, WORKFLOW_EVENTS } from '../events';
import { ALWAYS_REQUIRED_PORTS, requirePorts } from '../ports';
import { checkActor, parseCandidates, resolveSlot, resolveSpecial, type ExclusionReason } from '../resolve';
import {
  HookFailure,
  applyProgress,
  auditInstance,
  casInstance,
  casLost,
  closeAllOpen,
  closeTask,
  createTasks,
  emitAssigned,
  emitBlocked,
  emitDecided,
  emitInstance,
  hookContext,
  openFrame,
  planNext,
  resolveEnvOf,
  resultOf,
  roundState,
  runHook,
  sha256,
  slotExclusions,
  specialExclusions,
  stageViewOf,
  statusData,
  type Emitter,
  type Frame,
  type InstanceRow,
  type TaskRow,
  type WorkflowResult,
} from './internal/core';
import { recheckInFrame, resumeInFrame } from './internal/flows';

export interface ActInput {
  ctx: ScopeContext;
  taskId: string;
  expectedVersion: number;
  decision: WorkflowDecision;
  note?: string;
  decisionFields?: Record<string, unknown>;
  idempotencyKey?: string;
}

function personOf(ctx: ScopeContext): ActorView {
  if (ctx.kind !== 'scoped' && ctx.kind !== 'self' && ctx.kind !== 'team') throw new WorkflowError('WFE_FORBIDDEN', 'a task is decided by a person (Scoped, Self or Team context)');
  return { userId: ctx.actor.userId, role: ctx.actor.role, employeeId: ctx.actor.employeeId };
}

/**
 * A person decides a task. Returns NO_CHANGE ("already processed") when the task is no longer OPEN or the instance is
 * final; a retryable 409 when the version moved under an open task. Idempotent on the operation key.
 */
export async function actOnWorkflowTask(prisma: RootClient, i: ActInput): Promise<OperationOutcome<WorkflowResult>> {
  assertScopeContext(i.ctx, 'actOnWorkflowTask');
  const me = personOf(i.ctx);
  if (!Object.values(DECISIONS_BY_KIND).some((d) => d.includes(i.decision))) throw new WorkflowError('WFE_VALIDATION', 'unknown decision');
  if (!Number.isInteger(i.expectedVersion) || i.expectedVersion < 0) throw new WorkflowError('WFE_VALIDATION', 'expectedVersion is required');
  if (typeof i.taskId !== 'string' || !i.taskId) throw new WorkflowError('WFE_VALIDATION', 'taskId is required');
  if (i.decisionFields !== undefined && (typeof i.decisionFields !== 'object' || i.decisionFields === null || Array.isArray(i.decisionFields))) {
    throw new WorkflowError('WFE_VALIDATION', 'decisionFields must be an object');
  }
  requirePorts(ALWAYS_REQUIRED_PORTS);
  const note = typeof i.note === 'string' ? i.note.trim() : '';
  const key = i.idempotencyKey ? `wf:act:${me.userId}:${i.idempotencyKey}` : `wf:act:${i.taskId}:${me.userId}:${i.decision}:v${i.expectedVersion}`;
  const fingerprint = sha256({ taskId: i.taskId, decision: i.decision, note, decisionFields: i.decisionFields ?? null });
  try {
    return await runTransition(prisma, { key, operation: 'workflow.act', actorId: me.userId, fingerprint }, (tx) =>
      actInTx({ tx, ctx: i.ctx, me, input: i, note, key }),
    );
  } catch (err) {
    if (!(err instanceof HookFailure)) throw err;
    await recordEffectFailure(prisma, i.ctx, i.taskId, key, err);
    throw new WorkflowError('WFE_EFFECT_FAILED', err.message);
  }
}

interface ActCall {
  tx: Prisma.TransactionClient;
  ctx: ScopeContext;
  me: ActorView;
  input: ActInput;
  note: string;
  key: string;
}

async function actInTx(c: ActCall): Promise<WorkflowResult> {
  const peek = await c.tx.workflowTask.findUnique({ where: { id: c.input.taskId }, select: { instanceId: true } });
  if (!peek) throw new WorkflowError('WFE_NOT_FOUND');
  const f = await openFrame(c.tx, c.ctx, peek.instanceId); // 404 outside the context; locks
  const task = await c.tx.workflowTask.findUniqueOrThrow({ where: { id: c.input.taskId } });
  if (task.kind === 'DEFERRAL_DECISION') throw new WorkflowError('WFE_KIND_NOT_SUPPORTED', 'DEFERRAL_DECISION until BL-WFE-011');
  if (!(DECISIONS_BY_KIND[task.kind] ?? []).includes(c.input.decision)) throw new WorkflowError('WFE_VALIDATION', `${c.input.decision} is not a decision of a ${task.kind} task`);
  if (isTerminal(f.inst.status) || task.status !== 'OPEN') return resultOf(f.inst, 'NO_CHANGE');
  if (f.inst.version !== c.input.expectedVersion) throw retryableConflict(f.inst.id, f.inst.version);
  assertStatusFor(task, f.inst);
  if (f.adapter.refresh) await f.adapter.refresh(c.tx, f.request);

  const actor: WfActor = { type: 'USER', userId: c.me.userId };
  const e: Emitter = { tx: c.tx, inst: f.inst, opKey: c.key, actor };
  const env = await resolveEnvOf(f);
  const state = await roundState(f);
  const index = slotIndex(f.def.root);
  const stage = stageViewOf(task, index);

  // Who acts, on current data.
  const slot = task.kind === 'APPROVE' ? index.get(task.nodeId) : undefined;
  const extra: Map<string, ExclusionReason> = slot ? slotExclusions(slot, state.approved, index) : specialExclusions(task);
  const entry = task.candidateUserIds.includes(c.me.userId) ? parseCandidates(task.candidatesSnapshotJson).find((x) => x.userId === c.me.userId) : undefined;
  let via: 'CANDIDATE' | 'REJECT_AUTHORITY';
  if (entry) {
    const check = checkActor(c.me.userId, entry.roles, env, stage, extra);
    if (!check.ok) throw refusal(check.reason);
    // MANAGER_CHAIN (review M-2): the level is resolved again on the LIVE chain (env.chain is rebuilt now: the manager in
    // force today and his login now). The actor must be the current manager of that level, or a current cover of it when
    // the level has no usable manager. Being on leave does not stop the manager himself from acting.
    if (slot?.level) {
      const live = resolveSlot(slot, { ...env, unavailableEmployees: new Set() }, extra);
      if (!live.candidates.some((x) => x.userId === c.me.userId)) throw new WorkflowError('WFE_FORBIDDEN', 'no longer the manager (or a cover) of this level');
    }
    via = 'CANDIDATE';
  } else if (c.input.decision === 'REJECT' && env.settings.rejectAuthority.length) {
    const check = checkActor(c.me.userId, env.settings.rejectAuthority, env, stage, extra);
    if (!check.ok) throw check.reason === 'NOT_ELIGIBLE' ? new WorkflowError('WFE_FORBIDDEN', 'not a candidate of this task') : refusal(check.reason);
    via = 'REJECT_AUTHORITY';
  } else {
    throw new WorkflowError('WFE_FORBIDDEN', 'not a candidate of this task');
  }

  switch (task.kind) {
    case 'APPROVE':
      if (c.input.decision === 'APPROVE') return approve(f, e, task, c, state, env);
      if (c.input.decision === 'RETURN') return giveBack(f, e, task, c);
      return reject(f, e, task, c, via);
    case 'REJECT_PAIR':
      return c.input.decision === 'CONFIRM' ? confirmRejection(f, e, task, c) : declineTask(f, e, task, c, 'reject pair declined');
    case 'CANCEL_CONFIRM':
      return c.input.decision === 'CONFIRM' ? confirmCancel(f, e, task, c) : declineCancel(f, e, task, c);
    case 'REQUIREMENT_CHECK':
      if (c.input.decision === 'REJECT') return reject(f, e, task, c, via);
      return recheckInFrame(f, e, task);
    default:
      throw new WorkflowError('WFE_KIND_NOT_SUPPORTED', task.kind);
  }
}

function refusal(reason: ExclusionReason | 'NOT_ELIGIBLE'): WorkflowError {
  if (reason === 'NOT_ELIGIBLE') return new WorkflowError('WFE_FORBIDDEN', 'no longer eligible for this task (role, company scope or account changed)');
  if (reason.startsWith('GUARD:')) return new WorkflowError('WFE_FORBIDDEN', reason);
  return new WorkflowError('WFE_SELF_ACTION', reason);
}

function assertStatusFor(task: TaskRow, inst: InstanceRow): void {
  const ok =
    task.kind === 'APPROVE'
      ? inst.status === 'RUNNING'
      : task.kind === 'REJECT_PAIR'
        ? inst.status === 'RUNNING' || inst.status === 'AWAITING_REQUIREMENT'
      : task.kind === 'REQUIREMENT_CHECK'
        ? inst.status === 'AWAITING_REQUIREMENT'
        : task.kind === 'CANCEL_CONFIRM'
          ? (inst.status === 'PAUSED' || inst.status === 'BLOCKED') && inst.pauseReasons.includes(CANCEL_REQUESTED)
          : false;
  // PAUSED, BLOCKED, RETURNED…: the task cannot be decided now (409, not retryable until the instance moves).
  if (!ok) throw new WorkflowError('WFE_INVALID_STATE', `a ${task.kind} task cannot be decided while the request is ${inst.status}`, { status: inst.status });
}

function checkDecisionFields(f: Frame, task: TaskRow, fields: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!fields || !Object.keys(fields).length) return {};
  const slot = slotIndex(f.def.root).get(task.nodeId);
  const allowed = new Set(slot?.stage.decisionFields ?? []);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    const spec = f.adapter.decisionFieldCatalog[k];
    if (!allowed.has(k) || !spec) throw new WorkflowError('WFE_VALIDATION', `decision field ${k} is not collected at this stage`);
    const ok =
      v === null ||
      (spec.type === 'number' && typeof v === 'number' && Number.isFinite(v)) ||
      (spec.type === 'boolean' && typeof v === 'boolean') ||
      (spec.type === 'string' && typeof v === 'string' && v.length <= 2000) ||
      (spec.type === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) ||
      (spec.type === 'enum' && typeof v === 'string' && (spec.values ?? []).includes(v));
    if (!ok) throw new WorkflowError('WFE_VALIDATION', `decision field ${k} must be a ${spec.type}`);
    out[k] = v;
  }
  return out;
}

async function approve(f: Frame, e: Emitter, task: TaskRow, c: ActCall, state: Awaited<ReturnType<typeof roundState>>, env: Awaited<ReturnType<typeof resolveEnvOf>>): Promise<WorkflowResult> {
  const fields = checkDecisionFields(f, task, c.input.decisionFields);
  // The state after this approval, then what comes next (reads only: resolution and validateFinal).
  const approvedTask: TaskRow = { ...task, status: 'APPROVED', actedByUserId: c.me.userId, decisionFieldsJson: fields as Prisma.JsonObject };
  const next = { ...state, approved: [...state.approved, approvedTask], approvedNodes: new Set([...state.approvedNodes, task.nodeId]), open: state.open.filter((t) => t.id !== task.id) };
  next.collectedFields = { ...state.collectedFields, ...fields };
  next.fields = { ...state.fields, ...fields };
  const plan = await planNext(f, next, env, true);
  const after = await casInstance(f.tx, f.inst, ['RUNNING'], statusData(plan, f.at, c.me.userId));
  if (!after) return casLost(f.tx, f.inst.id, task.id);
  const ee = { ...e, inst: after };
  await closeTask(f.tx, task, { status: 'APPROVED', actedByUserId: c.me.userId, decisionFieldsJson: fields as Prisma.InputJsonObject, note: c.note || null }, f.at);
  const index = slotIndex(f.def.root);
  await runHook('onStageApproved', f, hookContext(f, after, e.actor, e.opKey, { stage: stageViewOf(task, index), decisionFields: fields, collectedFields: next.collectedFields }));
  const opened = await applyProgress({ ...f, inst: after }, ee, f.inst, after, plan, next);
  await auditInstance(ee, WORKFLOW_AUDIT.acted, f.inst, after, { reason: c.note || null, detail: { taskId: task.id, nodeId: task.nodeId, decision: 'APPROVE', openedTaskIds: opened.map((t) => t.id) } });
  return resultOf(after, 'APPLIED', opened.map((t) => t.id));
}

async function giveBack(f: Frame, e: Emitter, task: TaskRow, c: ActCall): Promise<WorkflowResult> {
  if (!c.note) throw new WorkflowError('WFE_VALIDATION', 'a return needs a note');
  if (!f.adapter.canReturn(c.me, f.request)) throw new WorkflowError('WFE_FORBIDDEN', 'canReturn refused');
  const max = f.def.settings.maxReturns;
  if (max !== null && f.inst.returns >= max) throw new WorkflowError('WFE_VALIDATION', `the request was already returned ${f.inst.returns} time(s) (maxReturns ${max})`);
  const after = await casInstance(f.tx, f.inst, ['RUNNING'], { status: 'RETURNED', returns: f.inst.returns + 1 });
  if (!after) return casLost(f.tx, f.inst.id, task.id);
  const ee = { ...e, inst: after };
  await closeTask(f.tx, task, { status: 'RETURNED', actedByUserId: c.me.userId, note: c.note }, f.at);
  await closeAllOpen({ ...f, inst: after }, ee, [task.id]);
  await runHook('onReturned', f, hookContext(f, after, e.actor, e.opKey, { note: c.note }));
  await auditInstance(ee, WORKFLOW_AUDIT.acted, f.inst, after, { reason: c.note, detail: { taskId: task.id, decision: 'RETURN' } });
  await emitInstance(ee, WORKFLOW_EVENTS.instanceReturned, { round: after.round, requesterUserId: after.requesterUserId });
  return resultOf(after, 'APPLIED');
}

/**
 * REJECT (§12.8): a reason is required. A candidate needs canReject; a rejectAuthority holder does not. With
 * rejectRequiresPair, the first rejection opens ONE REJECT_PAIR task for the other rejectAuthority holders (never the
 * first rejecter) and the request stays where it is; otherwise the request is REJECTED.
 */
async function reject(f: Frame, e: Emitter, task: TaskRow, c: ActCall, via: 'CANDIDATE' | 'REJECT_AUTHORITY'): Promise<WorkflowResult> {
  if (!c.note) throw new WorkflowError('WFE_VALIDATION', 'a rejection needs a reason');
  if (via === 'CANDIDATE' && !f.adapter.canReject(c.me, f.request)) throw new WorkflowError('WFE_FORBIDDEN', 'canReject refused');
  if (f.def.settings.rejectRequiresPair) return openRejectPair(f, e, task, c);
  return finishRejection(f, e, task, c, { status: 'REJECTED', actedByUserId: c.me.userId, note: c.note });
}

async function openRejectPair(f: Frame, e: Emitter, task: TaskRow, c: ActCall): Promise<WorkflowResult> {
  const open = await f.tx.workflowTask.findFirst({ where: { instanceId: f.inst.id, companyId: f.inst.companyId, kind: 'REJECT_PAIR', status: 'OPEN' } });
  if (open) throw new WorkflowError('WFE_INVALID_STATE', 'a rejection is already waiting for its second person');
  const env = await resolveEnvOf(f);
  const n = (await f.tx.workflowTask.count({ where: { instanceId: f.inst.id, companyId: f.inst.companyId, round: f.inst.round, kind: 'REJECT_PAIR' } })) + 1;
  const nodeId = `REJECT_PAIR#${n}`;
  const res = resolveSpecial('REJECT_PAIR', nodeId, env, new Map([[c.me.userId, 'FIRST_REJECTER' as const]]));
  const data = res.blocked && f.inst.status === 'RUNNING' ? { blockedAt: f.at, blockedReason: 'NO_CANDIDATE', status: 'BLOCKED' as const } : {};
  const after = await casInstance(f.tx, f.inst, [f.inst.status], data);
  if (!after) return casLost(f.tx, f.inst.id, task.id);
  const ee = { ...e, inst: after };
  const [pair] = await createTasks(f.tx, after, [
    { nodeId, kind: 'REJECT_PAIR', res, dueAt: null, context: { firstRejecterUserId: c.me.userId, sourceTaskId: task.id, note: c.note } },
  ]);
  await emitAssigned(ee, [pair]);
  if (after.status === 'BLOCKED' && f.inst.status !== 'BLOCKED') await emitBlocked(ee, after, [pair]);
  await auditInstance(ee, WORKFLOW_AUDIT.acted, f.inst, after, { reason: c.note, detail: { taskId: task.id, decision: 'REJECT', rejectPairTaskId: pair.id } });
  return resultOf(after, 'APPLIED', [pair.id]);
}

/** CONFIRM on a REJECT_PAIR: canReject is asked again (RT-WFE-310); refused → the pair task closes, nothing rejected. */
async function confirmRejection(f: Frame, e: Emitter, task: TaskRow, c: ActCall): Promise<WorkflowResult> {
  if (!c.note) throw new WorkflowError('WFE_VALIDATION', 'a rejection needs a reason');
  if (!f.adapter.canReject(c.me, f.request)) return declineTask(f, e, task, c, 'canReject no longer holds');
  return finishRejection(f, e, task, c, { status: 'APPROVED', actedByUserId: c.me.userId, note: c.note });
}

async function finishRejection(f: Frame, e: Emitter, task: TaskRow, c: ActCall, taskData: { status: 'REJECTED' | 'APPROVED'; actedByUserId: string; note: string }): Promise<WorkflowResult> {
  const after = await casInstance(f.tx, f.inst, ['RUNNING', 'AWAITING_REQUIREMENT', 'BLOCKED'], {
    status: 'REJECTED',
    closedAt: f.at,
    closeKind: 'DECIDED',
    closedByUserId: c.me.userId,
    previousStatus: null,
    pauseReasons: [],
    pausedAt: null,
    blockedAt: null,
    blockedReason: null,
    awaitingRequirement: null,
    awaitingSince: null,
  });
  if (!after) return casLost(f.tx, f.inst.id, task.id);
  const ee = { ...e, inst: after };
  await closeTask(f.tx, task, taskData, f.at);
  await closeAllOpen({ ...f, inst: after }, ee, [task.id]);
  await runHook('onRejected', f, hookContext(f, after, e.actor, e.opKey, { note: c.note }));
  await auditInstance(ee, WORKFLOW_AUDIT.acted, f.inst, after, { reason: c.note, detail: { taskId: task.id, kind: task.kind, decision: c.input.decision } });
  await emitDecided(ee, after);
  return resultOf(after, 'APPLIED');
}

/** DECLINE on a REJECT_PAIR (or a refused CONFIRM): the task closes with its reason, the request goes on. */
async function declineTask(f: Frame, e: Emitter, task: TaskRow, c: ActCall, why: string): Promise<WorkflowResult> {
  const note = c.note || why;
  const after = await casInstance(f.tx, f.inst, [f.inst.status], {});
  if (!after) return casLost(f.tx, f.inst.id, task.id);
  const ee = { ...e, inst: after };
  await closeTask(f.tx, task, { status: 'REJECTED', actedByUserId: c.me.userId, note }, f.at);
  await auditInstance(ee, WORKFLOW_AUDIT.acted, f.inst, after, { reason: note, detail: { taskId: task.id, kind: task.kind, decision: 'DECLINE' } });
  return resultOf(after, 'APPLIED');
}

/** CONFIRM on a CANCEL_CONFIRM: the request is CANCELLED (closedBy = the person who asked), onCancelled. */
async function confirmCancel(f: Frame, e: Emitter, task: TaskRow, c: ActCall): Promise<WorkflowResult> {
  const ctx = (task.decisionFieldsJson as Record<string, unknown>) ?? {};
  const requestedBy = typeof ctx.requestedByUserId === 'string' ? ctx.requestedByUserId : c.me.userId;
  const after = await casInstance(f.tx, f.inst, ['PAUSED', 'BLOCKED'], {
    status: 'CANCELLED',
    closedAt: f.at,
    closeKind: 'CANCELLED_BY_ACTOR',
    closedByUserId: requestedBy,
    previousStatus: null,
    pauseReasons: [],
    pausedAt: null,
    blockedAt: null,
    blockedReason: null,
    awaitingRequirement: null,
    awaitingSince: null,
  });
  if (!after) return casLost(f.tx, f.inst.id, task.id);
  const ee = { ...e, inst: after };
  await closeTask(f.tx, task, { status: 'APPROVED', actedByUserId: c.me.userId, note: c.note || null }, f.at);
  await closeAllOpen({ ...f, inst: after }, ee, [task.id]);
  await runHook('onCancelled', f, hookContext(f, after, e.actor, e.opKey, { note: typeof ctx.reason === 'string' ? ctx.reason : null }));
  await auditInstance(ee, WORKFLOW_AUDIT.acted, f.inst, after, { reason: c.note || null, detail: { taskId: task.id, kind: 'CANCEL_CONFIRM', decision: 'CONFIRM', requestedBy } });
  await emitDecided(ee, after);
  return resultOf(after, 'APPLIED');
}

/** DECLINE on a CANCEL_CONFIRM: resume(CANCEL_REQUESTED); the task closes with its reason. */
async function declineCancel(f: Frame, e: Emitter, task: TaskRow, c: ActCall): Promise<WorkflowResult> {
  if (!c.note) throw new WorkflowError('WFE_VALIDATION', 'declining a cancellation needs a reason');
  const r = await resumeInFrame(f, e, CANCEL_REQUESTED);
  if (!r) return casLost(f.tx, f.inst.id, task.id);
  await closeTask(f.tx, task, { status: 'REJECTED', actedByUserId: c.me.userId, note: c.note }, f.at);
  await auditInstance({ ...e, inst: r.after }, WORKFLOW_AUDIT.acted, f.inst, r.after, { reason: c.note, detail: { taskId: task.id, kind: 'CANCEL_CONFIRM', decision: 'DECLINE' } });
  return resultOf(r.after, 'APPLIED');
}

/**
 * §12.11 "فشل onApproved الثابت": a separate transaction (after the locks) records effectFailedAt / lastEffectError
 * under CAS and emits workflow.instance.effectFailed once per act operation key.
 */
async function recordEffectFailure(prisma: RootClient, ctx: ScopeContext, taskId: string, actKey: string, err: HookFailure): Promise<void> {
  const message = err.message.slice(0, 500);
  try {
    await runTransition(prisma, { key: `${actKey}:effectFailed`, operation: 'workflow.effectFailed', fingerprint: sha256({ taskId }) }, async (tx) => {
      const t = await tx.workflowTask.findUnique({ where: { id: taskId }, select: { instanceId: true } });
      if (!t) return null;
      const first = await tx.workflowInstance.findUnique({ where: { id: t.instanceId } });
      if (!first) return null;
      const f = await openFrame(tx, ctx, first.id);
      if (isTerminal(f.inst.status)) return null;
      const after = await casInstance(tx, f.inst, [f.inst.status], { effectFailedAt: f.at, lastEffectError: message });
      if (!after) return null;
      const actor: WfActor = ctx.kind === 'system' ? { type: 'SYSTEM', job: ctx.job } : { type: 'USER', userId: ctx.actor.userId };
      const e: Emitter = { tx, inst: after, opKey: actKey, actor };
      await auditInstance(e, WORKFLOW_AUDIT.effectFailed, f.inst, after, { reason: message, detail: { taskId, hook: err.hook } });
      await emitInstance(e, WORKFLOW_EVENTS.instanceEffectFailed, { errorCode: 'HOOK_FAILED', hook: err.hook, taskId });
      return { instanceId: after.id };
    });
  } catch (recordErr) {
    // The decision is already refused; a lost CAS here (someone else moved the instance) is not an error to report.
    if (!isWorkflowError(recordErr, 'WFE_CONFLICT')) throw recordErr;
  }
}

