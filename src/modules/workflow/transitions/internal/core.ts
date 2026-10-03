// Shared machinery of the engine's transitions (transitions/*.ts are the only callers; this folder is part of the
// sole writer of the workflow tables, ARCH-002). Every command runs in one transaction in this order (§12.11):
//   1. EmployeeLockPort.lockEmployees(beneficiaries ascending, ctx.companies)  — the FIRST lock (ADR-0002 #2)
//   2. adapter.lockKeys
//   3. fresh reads, then the CAS write on the instance (updateMany where id, version, status), then the tasks
//   4. hooks (the adapter's own module transitions), AuditRecord, DomainEvents
// The instance row is never locked FOR UPDATE: CAS alone protects it.
import type { Prisma, WorkflowInstance, WorkflowInstanceStatus, WorkflowTask, WorkflowTaskKind } from '@prisma/client';
import { createHash } from 'crypto';
import { controlsApprovers, type ScopeContext } from '@/modules/iam';
import { today } from '@/lib/dates';
import { audit, emitEvent, resolveOperatorMode, type TxClient } from '@/modules/platform';
import { requireAdapter, type HookContext, type InstanceView, type StageView, type WfActor, type WorkflowAdapter } from '../../adapters';
import { hasDeadline, readStoredDefinition, usesManagerChain, type WorkflowDefinitionDoc } from '../../definition';
import { areAllSiblings, isTerminal, planProgress, slotIndex, type PathStep, type StageSlot } from '../../engine';
import { WorkflowError, retryableConflict } from '../../errors';
import { WORKFLOW_AGGREGATE, WORKFLOW_EVENTS, instanceEventKey, taskEventKey, type WorkflowEventType } from '../../events';
import { ALWAYS_REQUIRED_PORTS, requirePort, requirePorts, type WorkflowPortName } from '../../ports';
import {
  beneficiaryUserIds,
  buildManagerChain,
  eligibleInCompany,
  maxChainLevels,
  parseCandidates,
  parseChain,
  resolveSlot,
  resolveSpecial,
  type CandidateEntry,
  type ChainEntry,
  type ExclusionReason,
  type Resolution,
  type ResolveEnv,
} from '../../resolve';
import { assertCompanyInScope } from '../../scope';

export type InstanceRow = WorkflowInstance;
export type TaskRow = WorkflowTask;

export interface WorkflowResult {
  instanceId: string;
  status: WorkflowInstanceStatus;
  version: number;
  round: number;
  outcome: 'APPLIED' | 'NO_CHANGE';
  openedTaskIds: string[];
}

export function resultOf(inst: Pick<InstanceRow, 'id' | 'status' | 'version' | 'round'>, outcome: WorkflowResult['outcome'], openedTaskIds: string[] = []): WorkflowResult {
  return { instanceId: inst.id, status: inst.status, version: inst.version, round: inst.round, outcome, openedTaskIds };
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}

export function auditActorOf(actor: WfActor): { type: 'USER'; id: string } | { type: 'SYSTEM'; id: string } {
  return actor.type === 'USER' ? { type: 'USER', id: actor.userId } : { type: 'SYSTEM', id: actor.job };
}

/** The actor of a context: its login, or the job of a SystemContext. */
export function actorOfContext(ctx: ScopeContext): WfActor {
  return ctx.kind === 'system' ? { type: 'SYSTEM', job: ctx.job } : { type: 'USER', userId: ctx.actor.userId };
}

export function userIdOf(actor: WfActor): string | null {
  return actor.type === 'USER' ? actor.userId : null;
}

export function viewOf(inst: InstanceRow): InstanceView {
  return Object.freeze({
    id: inst.id,
    companyId: inst.companyId,
    requestType: inst.requestType,
    requestId: inst.requestId,
    status: inst.status,
    round: inst.round,
    version: inst.version,
    beneficiaryEmployeeIds: Object.freeze([...inst.beneficiaryEmployeeIds]),
    requesterUserId: inst.requesterUserId,
    contextSnapshot: Object.freeze({ ...((inst.contextSnapshotJson as Record<string, unknown>) ?? {}) }),
  });
}

export function sortedIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((x) => typeof x === 'string' && x.trim()))].sort();
}

// ---------------------------------------------------------------------------------------------------
// Ports and locks

export function portsFor(def: WorkflowDefinitionDoc): WorkflowPortName[] {
  const out: WorkflowPortName[] = [...ALWAYS_REQUIRED_PORTS];
  if (usesManagerChain(def.root)) out.push('ManagerChain', 'Availability');
  if (hasDeadline(def.root)) out.push('WorkingDays');
  return out;
}

/** Step 1 and 2 of §12.11: the employee lock (always called, even with no beneficiary), then the adapter's keys. */
export async function lockParties(tx: TxClient, ctx: ScopeContext, beneficiaryIds: readonly string[], adapter: WorkflowAdapter<unknown>, request: unknown) {
  const rows = await requirePort('EmployeeLock').lockEmployees(tx, sortedIds(beneficiaryIds), ctx.companies);
  if (adapter.lockKeys) await adapter.lockKeys(tx, request);
  return rows;
}

export interface Frame {
  tx: TxClient;
  ctx: ScopeContext;
  adapter: WorkflowAdapter<unknown>;
  request: unknown;
  inst: InstanceRow;
  def: WorkflowDefinitionDoc;
  at: Date;
}

/**
 * Reads the instance (WFE_NOT_FOUND outside the context), loads the request, takes the locks, then reads the instance
 * again: everything decided afterwards sees the state as of the locks.
 */
export async function openFrame(tx: TxClient, ctx: ScopeContext, instanceId: string): Promise<Frame> {
  requirePorts(ALWAYS_REQUIRED_PORTS);
  const first = await tx.workflowInstance.findUnique({ where: { id: instanceId } });
  assertCompanyInScope(ctx, first?.companyId);
  const adapter = requireAdapter(first!.requestType);
  const request = await adapter.load(tx, first!.requestId);
  await lockParties(tx, ctx, first!.beneficiaryEmployeeIds, adapter, request);
  const inst = await tx.workflowInstance.findUniqueOrThrow({ where: { id: instanceId } });
  const defRow = await tx.workflowDefinition.findUniqueOrThrow({ where: { id: inst.definitionId }, select: { definitionJson: true } });
  const def = readStoredDefinition(defRow.definitionJson);
  requirePorts(portsFor(def));
  if (inst.hasPayEffect) throw new WorkflowError('WFE_PAY_EFFECT_UNSUPPORTED', inst.requestType);
  return { tx, ctx, adapter, request, inst, def, at: new Date() };
}

// ---------------------------------------------------------------------------------------------------
// CAS

/**
 * The CAS write: updateMany where { id, version: V, status in allowedFrom } with version V + 1. Returns the updated
 * row, or null when the CAS lost (the caller decides NO_CHANGE or a retryable 409 with casLost()).
 */
export async function casInstance(
  tx: TxClient,
  inst: InstanceRow,
  allowedFrom: readonly WorkflowInstanceStatus[],
  data: Prisma.WorkflowInstanceUncheckedUpdateManyInput,
): Promise<InstanceRow | null> {
  const { count } = await tx.workflowInstance.updateMany({
    where: { id: inst.id, version: inst.version, status: { in: [...allowedFrom] } },
    data: { ...data, version: inst.version + 1 },
  });
  if (count === 0) return null;
  return tx.workflowInstance.findUniqueOrThrow({ where: { id: inst.id } });
}

/** After a lost CAS: terminal (or the task no longer OPEN) → NO_CHANGE; otherwise a retryable 409. */
export async function casLost(tx: TxClient, instanceId: string, taskId?: string): Promise<WorkflowResult> {
  const now = await tx.workflowInstance.findUniqueOrThrow({ where: { id: instanceId } });
  if (isTerminal(now.status)) return resultOf(now, 'NO_CHANGE');
  if (taskId) {
    const t = await tx.workflowTask.findUnique({ where: { id: taskId }, select: { status: true } });
    if (!t || t.status !== 'OPEN') return resultOf(now, 'NO_CHANGE');
  }
  throw retryableConflict(now.id, now.version);
}

// ---------------------------------------------------------------------------------------------------
// Tasks

export async function roundTasks(tx: TxClient, inst: InstanceRow): Promise<TaskRow[]> {
  return tx.workflowTask.findMany({ where: { instanceId: inst.id, companyId: inst.companyId, round: inst.round }, orderBy: [{ decidedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] });
}

export async function openTasksOf(tx: TxClient, inst: InstanceRow): Promise<TaskRow[]> {
  return tx.workflowTask.findMany({ where: { instanceId: inst.id, companyId: inst.companyId, status: 'OPEN' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
}

/** Closes an OPEN task; a count of 0 throws, which aborts the transaction (§3.6). */
export async function closeTask(tx: TxClient, task: TaskRow, data: Prisma.WorkflowTaskUncheckedUpdateManyInput & { status: Exclude<TaskRow['status'], 'OPEN'> }, at: Date): Promise<void> {
  const { count } = await tx.workflowTask.updateMany({ where: { id: task.id, status: 'OPEN' }, data: { ...data, decidedAt: at } });
  if (count === 0) throw retryableConflict(task.instanceId, -1);
}

export interface NewTask {
  nodeId: string;
  kind: WorkflowTaskKind;
  res: Resolution;
  dueAt: Date | null;
  /** Context of a special task (REJECT_PAIR: the first rejection; CANCEL_CONFIRM: who asked and why). */
  context?: Record<string, unknown>;
}

export async function createTasks(tx: TxClient, inst: InstanceRow, tasks: readonly NewTask[]): Promise<TaskRow[]> {
  const out: TaskRow[] = [];
  for (const t of tasks) {
    out.push(
      await tx.workflowTask.create({
        data: {
          instanceId: inst.id,
          companyId: inst.companyId,
          round: inst.round,
          nodeId: t.nodeId,
          kind: t.kind,
          candidateUserIds: t.res.candidates.map((c) => c.userId),
          candidatesSnapshotJson: t.res.candidates as unknown as Prisma.InputJsonArray,
          coverReason: t.res.coverReason,
          dueAt: t.dueAt,
          ...(t.context ? { decisionFieldsJson: t.context as Prisma.InputJsonObject } : {}),
        },
      }),
    );
  }
  return out;
}

/** Re-resolved candidates on an OPEN task (recheck, unblock). Returns false when nothing changed. */
export async function updateCandidates(tx: TxClient, task: TaskRow, res: Resolution): Promise<boolean> {
  const ids = res.candidates.map((c) => c.userId);
  if (ids.join(',') === task.candidateUserIds.join(',') && (res.coverReason ?? null) === (task.coverReason ?? null)) return false;
  const { count } = await tx.workflowTask.updateMany({
    where: { id: task.id, status: 'OPEN' },
    data: { candidateUserIds: ids, candidatesSnapshotJson: res.candidates as unknown as Prisma.InputJsonArray, coverReason: res.coverReason },
  });
  if (count === 0) throw retryableConflict(task.instanceId, -1);
  return true;
}

// ---------------------------------------------------------------------------------------------------
// Round state, resolution environment

export interface RoundState {
  tasks: TaskRow[];
  approved: TaskRow[];
  approvedNodes: Set<string>;
  open: TaskRow[];
  collectedFields: Record<string, unknown>;
  fields: Record<string, unknown>;
}

export async function roundState(f: Frame): Promise<RoundState> {
  const tasks = await roundTasks(f.tx, f.inst);
  const approved = tasks.filter((t) => t.kind === 'APPROVE' && t.status === 'APPROVED');
  const collectedFields: Record<string, unknown> = {};
  for (const t of approved) Object.assign(collectedFields, (t.decisionFieldsJson as Record<string, unknown>) ?? {});
  const fields = { ...((f.inst.contextSnapshotJson as Record<string, unknown>) ?? {}), ...(f.def.settings.autoDefaults ?? {}), ...collectedFields };
  const open = (await openTasksOf(f.tx, f.inst)) as TaskRow[];
  return { tasks, approved, approvedNodes: new Set(approved.map((t) => t.nodeId)), open, collectedFields, fields };
}

/** The manager chain as of now, from the same anchor (the primary beneficiary at start) and depth as the snapshot. */
export async function liveManagerChain(f: Frame): Promise<ChainEntry[]> {
  const levels = maxChainLevels(f.def.root);
  if (!levels) return [];
  const snap = parseChain(f.inst.managerChainSnapshot);
  const anchor = snap.find((e) => e.anchor !== undefined)?.anchor ?? f.inst.beneficiaryEmployeeIds[0] ?? null;
  return buildManagerChain(f.tx, anchor, levels, f.at);
}

/** The new snapshot when the live chain differs from the stored one (persisted, and audited, by the caller), else null. */
export function chainChange(f: Frame, env: ResolveEnv): ChainEntry[] | null {
  const key = (c: readonly ChainEntry[]) => JSON.stringify(c.map((e) => [e.level, e.employeeId, e.userId, e.reason ?? null]));
  return key(env.chain) === key(parseChain(f.inst.managerChainSnapshot)) ? null : [...env.chain];
}

/** Live resolution environment (re-read in every transaction: guardrail 3). */
export async function resolveEnvOf(f: Frame): Promise<ResolveEnv> {
  const eligible = await eligibleInCompany(f.tx, f.inst.companyId, f.at);
  const ben = await beneficiaryUserIds(f.tx, f.inst.beneficiaryEmployeeIds, f.at);
  // MANAGER_CHAIN is read LIVE (the manager in force today, and that manager's login now), never trusted from the
  // start-time snapshot: a replaced manager, or a login relinked to another employee, no longer approves (review M-2).
  const chain = await liveManagerChain(f);
  const chainEmployees = chain.map((e) => e.employeeId).filter((x): x is string => !!x);
  const unavailable = chainEmployees.length && usesManagerChain(f.def.root) ? await requirePort('Availability').unavailable(f.tx, chainEmployees, today(f.at)) : new Set<string>();
  // Package C: the controls mode of THE INSTANCE'S company, read now in this transaction (DEC-PO-144; fail closed:
  // ENFORCED when unknown), and the counted approvers when the G9 attestation split can apply (a pay effect).
  const controlsMode = await resolveOperatorMode(f.tx, f.inst.companyId);
  const payEffect = f.inst.hasPayEffect === true;
  const counted = payEffect ? new Set((await controlsApprovers(f.tx)).map((u) => u.id)) : undefined;
  return {
    controlsMode,
    payEffect,
    ...(counted ? { counted } : {}),
    eligible,
    exclusions: { beneficiaryUserIds: ben, requesterUserId: f.inst.requesterUserId },
    guards: f.adapter.guards ?? [],
    instance: viewOf(f.inst),
    settings: f.def.settings,
    chain,
    unavailableEmployees: unavailable,
  };
}

/** The per-step exclusions of an APPROVE slot: prior approvers (distinctFromPrior) and G2b siblings of a parallel ALL. */
export function slotExclusions(slot: StageSlot, approved: readonly TaskRow[], index: ReadonlyMap<string, StageSlot>): Map<string, ExclusionReason> {
  const m = new Map<string, ExclusionReason>();
  for (const t of approved) {
    if (!t.actedByUserId) continue;
    if (slot.stage.distinctFromPrior) m.set(t.actedByUserId, 'PRIOR_APPROVER');
    const s = index.get(t.nodeId);
    if (s && areAllSiblings(s, slot)) m.set(t.actedByUserId, 'G2B_SIBLING');
    // A user never approves two levels of the same MANAGER_CHAIN stage, nor the same stage twice.
    if (s && s.stage.id === slot.stage.id && s.nodeId !== slot.nodeId) m.set(t.actedByUserId, 'PRIOR_APPROVER');
  }
  return m;
}

/** The per-task exclusions of a special task, from its stored context. */
export function specialExclusions(task: Pick<TaskRow, 'kind' | 'decisionFieldsJson'>): Map<string, ExclusionReason> {
  const m = new Map<string, ExclusionReason>();
  const c = (task.decisionFieldsJson as Record<string, unknown>) ?? {};
  if (task.kind === 'REJECT_PAIR' && typeof c.firstRejecterUserId === 'string') m.set(c.firstRejecterUserId, 'FIRST_REJECTER');
  if (task.kind === 'CANCEL_CONFIRM' && typeof c.requestedByUserId === 'string') m.set(c.requestedByUserId, 'CANCELLER');
  return m;
}

export async function dueAtFor(f: Frame, slot: StageSlot): Promise<Date | null> {
  if (!slot.stage.deadline) return null;
  return requirePort('WorkingDays').addWorkingDays(f.tx, f.inst.companyId, f.at, slot.stage.deadline.workingDays);
}

/** The candidates of the open APPROVE tasks (CANCEL_CONFIRM: "the current stage's candidates"). */
export function currentStageCandidates(open: readonly TaskRow[]): CandidateEntry[] {
  return open.filter((t) => t.kind === 'APPROVE').flatMap((t) => parseCandidates(t.candidatesSnapshotJson));
}

/** Re-resolves one OPEN task on current data (recheck, unblock). */
export function reResolve(task: TaskRow, env: ResolveEnv, state: RoundState, index: ReadonlyMap<string, StageSlot>, open: readonly TaskRow[]): Resolution {
  if (task.kind === 'APPROVE') {
    const slot = index.get(task.nodeId);
    if (!slot) return { candidates: [], coverReason: null, blocked: true };
    return resolveSlot(slot, env, slotExclusions(slot, state.approved, index));
  }
  if (task.kind === 'DEFERRAL_DECISION') return { candidates: parseCandidates(task.candidatesSnapshotJson), coverReason: task.coverReason as Resolution['coverReason'], blocked: false };
  return resolveSpecial(task.kind, task.nodeId, env, specialExclusions(task), currentStageCandidates(open.filter((t) => t.id !== task.id)));
}

// ---------------------------------------------------------------------------------------------------
// Progress (approve, start, resubmit, restartRound)

export interface ProgressPlan {
  status: 'RUNNING' | 'BLOCKED' | 'APPROVED' | 'AWAITING_REQUIREMENT';
  toOpen: NewTask[];
  notRequired: TaskRow[];
  path: PathStep[];
  autoApproved: boolean;
  requirement: string | null;
}

/**
 * What comes next after the approvals of this round. Reads only (resolution and validateFinal); the caller writes.
 * `humanActed`: an approval by a person happened in this round (the path is then not an automatic one).
 */
export async function planNext(f: Frame, state: RoundState, env: ResolveEnv, humanActed: boolean): Promise<ProgressPlan> {
  const index = slotIndex(f.def.root);
  const openApprove = state.open.filter((t) => t.kind === 'APPROVE' && t.round === f.inst.round);
  const p = planProgress(f.def.root, state.approvedNodes, state.fields, openApprove.map((t) => t.nodeId));
  const notRequired = openApprove.filter((t) => p.notRequired.includes(t.nodeId));
  if (p.done) {
    if (f.adapter.refresh) await f.adapter.refresh(f.tx, f.request);
    const final = await f.adapter.validateFinal(f.tx, f.request);
    if ('ok' in final && final.ok === true) return { status: 'APPROVED', toOpen: [], notRequired: state.open, path: p.path, autoApproved: !humanActed, requirement: null };
    if ('awaitable' in final && final.awaitable === true) {
      // AWAITING_REQUIREMENT on automatic paths only (RT-WFE-302); on a human path the task stays OPEN with the message.
      if (humanActed) throw new WorkflowError('WFE_VALIDATION', final.requirement);
      const requirement = String(final.requirement);
      if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(requirement)) throw new WorkflowError('WFE_VALIDATION', 'requirement must be a code');
      const res = resolveSpecial('REQUIREMENT_CHECK', 'REQUIREMENT_CHECK#1', env, new Map());
      return {
        status: 'AWAITING_REQUIREMENT',
        toOpen: [{ nodeId: 'REQUIREMENT_CHECK#1', kind: 'REQUIREMENT_CHECK', res, dueAt: null }],
        notRequired: state.open,
        path: p.path,
        autoApproved: false,
        requirement,
      };
    }
    throw new WorkflowError('WFE_VALIDATION', 'error' in final ? String(final.error) : 'validateFinal refused');
  }
  const toOpen: NewTask[] = [];
  for (const slot of p.toOpen) {
    const res = resolveSlot(slot, env, slotExclusions(slot, state.approved, index));
    toOpen.push({ nodeId: slot.nodeId, kind: 'APPROVE', res, dueAt: await dueAtFor(f, slot) });
  }
  const stillOpen = openApprove.filter((t) => !p.notRequired.includes(t.nodeId));
  const blocked = toOpen.some((t) => t.res.blocked) || stillOpen.some((t) => t.candidateUserIds.length === 0);
  return { status: blocked ? 'BLOCKED' : 'RUNNING', toOpen, notRequired, path: p.path, autoApproved: false, requirement: null };
}

/** The instance columns of a plan's status (the CHECKs of 9zj: closed iff terminal, blocked, awaiting). */
export function statusData(plan: ProgressPlan, at: Date, closedByUserId: string | null): Prisma.WorkflowInstanceUncheckedUpdateManyInput {
  const base: Prisma.WorkflowInstanceUncheckedUpdateManyInput = {
    status: plan.status,
    pathTaken: plan.path as unknown as Prisma.InputJsonArray,
    blockedAt: null,
    blockedReason: null,
    awaitingRequirement: null,
    awaitingSince: null,
    previousStatus: null,
    pauseReasons: [],
    pausedAt: null,
  };
  if (plan.status === 'BLOCKED') return { ...base, blockedAt: at, blockedReason: 'NO_CANDIDATE' };
  if (plan.status === 'AWAITING_REQUIREMENT') return { ...base, awaitingRequirement: plan.requirement, awaitingSince: at };
  if (plan.status === 'APPROVED') return { ...base, closedAt: at, closeKind: plan.autoApproved ? 'AUTO_APPROVED' : 'DECIDED', closedByUserId };
  return base;
}

// ---------------------------------------------------------------------------------------------------
// Events and audit

export interface Emitter {
  tx: TxClient;
  inst: InstanceRow;
  opKey: string;
  actor: WfActor;
}

export async function emitInstance(e: Emitter, type: WorkflowEventType, payload: Record<string, unknown>): Promise<void> {
  await emitEvent(e.tx, {
    type,
    aggregateType: WORKFLOW_AGGREGATE,
    aggregateId: e.inst.id,
    idempotencyKey: instanceEventKey(e.opKey, type),
    payload: { instanceId: e.inst.id, companyId: e.inst.companyId, actorId: userIdOf(e.actor), ...payload },
    companyId: e.inst.companyId,
    actorId: userIdOf(e.actor),
  });
}

export async function emitTask(e: Emitter, type: WorkflowEventType, task: Pick<TaskRow, 'id'>, payload: Record<string, unknown>): Promise<void> {
  await emitEvent(e.tx, {
    type,
    aggregateType: WORKFLOW_AGGREGATE,
    aggregateId: e.inst.id,
    idempotencyKey: taskEventKey(e.opKey, type, task.id),
    payload: { instanceId: e.inst.id, taskId: task.id, companyId: e.inst.companyId, actorId: userIdOf(e.actor), ...payload },
    companyId: e.inst.companyId,
    actorId: userIdOf(e.actor),
  });
}

export async function emitAssigned(e: Emitter, tasks: readonly TaskRow[]): Promise<void> {
  for (const t of tasks) {
    if (!t.candidateUserIds.length) continue;
    await emitTask(e, WORKFLOW_EVENTS.taskAssigned, t, {
      kind: t.kind,
      round: t.round,
      nodeId: t.nodeId,
      candidateUserIds: t.candidateUserIds,
      dueAt: t.dueAt,
      requestType: e.inst.requestType,
      requestId: e.inst.requestId,
    });
  }
}

/** Closes tasks as NOT_REQUIRED (with their event: N-WFE-011 tells the candidates the step is gone). */
export async function closeNotRequired(e: Emitter, tasks: readonly TaskRow[], priorApproverUserIds: readonly string[], at: Date): Promise<void> {
  for (const t of tasks) {
    await closeTask(e.tx, t, { status: 'NOT_REQUIRED' }, at);
    await emitTask(e, WORKFLOW_EVENTS.taskNotRequired, t, { candidateUserIds: t.candidateUserIds, priorApproverUserIds: [...new Set(priorApproverUserIds)] });
  }
}

export async function emitBlocked(e: Emitter, inst: InstanceRow, tasks: readonly Pick<TaskRow, 'nodeId' | 'candidateUserIds'>[]): Promise<void> {
  const node = tasks.find((t) => t.candidateUserIds.length === 0)?.nodeId ?? null;
  await emitInstance(e, WORKFLOW_EVENTS.instanceBlocked, { blockedReason: inst.blockedReason, nodeId: node });
}

export async function emitDecided(e: Emitter, inst: InstanceRow): Promise<void> {
  await emitInstance(e, WORKFLOW_EVENTS.instanceDecided, {
    outcome: inst.status,
    closeKind: inst.closeKind,
    closeSource: inst.closeSource,
    requesterUserId: inst.requesterUserId,
    requestType: inst.requestType,
    requestId: inst.requestId,
  });
}

export function snapshot(inst: InstanceRow): Record<string, unknown> {
  return {
    status: inst.status,
    version: inst.version,
    round: inst.round,
    returns: inst.returns,
    previousStatus: inst.previousStatus,
    pauseReasons: inst.pauseReasons,
    blockedReason: inst.blockedReason,
    awaitingRequirement: inst.awaitingRequirement,
    closeKind: inst.closeKind,
    closeSource: inst.closeSource,
  };
}

export async function auditInstance(e: Emitter, action: string, before: InstanceRow | null, after: InstanceRow, extra: { reason?: string | null; detail?: Record<string, unknown> } = {}): Promise<void> {
  await audit(e.tx, {
    actor: auditActorOf(e.actor),
    action,
    entity: { type: WORKFLOW_AGGREGATE, id: after.id, companyId: after.companyId },
    before: before ? snapshot(before) : null,
    after: { ...snapshot(after), ...(extra.detail ?? {}) },
    reason: extra.reason ?? null,
    operationKey: e.opKey,
  });
}

// ---------------------------------------------------------------------------------------------------
// Hooks

/** A hook that failed (the main transaction is rolled back; act records it in a separate one, §12.11). */
export class HookFailure extends Error {
  constructor(
    readonly hook: string,
    readonly cause: unknown,
  ) {
    super(`${hook} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'HookFailure';
  }
}

export async function runHook(name: 'onApproved' | 'onRejected' | 'onCancelled' | 'onReturned' | 'onStageApproved', f: Frame, ctx: HookContext): Promise<void> {
  const fn = f.adapter[name];
  if (!fn) return;
  try {
    await fn.call(f.adapter, f.tx, ctx);
  } catch (err) {
    if (name === 'onApproved') throw new HookFailure(name, err);
    throw err;
  }
}

export function hookContext(f: Frame, inst: InstanceRow, actor: WfActor, opKey: string, extra: Partial<HookContext> = {}): HookContext {
  return { instance: viewOf(inst), actor, operationKey: opKey, ...extra };
}

export function stageViewOf(task: Pick<TaskRow, 'nodeId' | 'kind'>, index: ReadonlyMap<string, StageSlot>): StageView {
  return { nodeId: task.nodeId, kind: task.kind, stageId: task.kind === 'APPROVE' ? (index.get(task.nodeId)?.stage.id ?? null) : null };
}

/**
 * Writes a progress plan after a successful CAS: new tasks, NOT_REQUIRED tasks, and on APPROVED every other open task
 * closed plus onApproved; the events of each. Returns the opened tasks.
 */
export async function applyProgress(f: Frame, e: Emitter, before: InstanceRow, after: InstanceRow, plan: ProgressPlan, state: RoundState): Promise<TaskRow[]> {
  const prior = state.approved.map((t) => t.actedByUserId).filter((x): x is string => !!x);
  await closeNotRequired(e, plan.notRequired, prior, f.at);
  const opened = await createTasks(f.tx, after, plan.toOpen);
  await emitAssigned(e, opened);
  if (after.status === 'BLOCKED' && before.status !== 'BLOCKED') {
    const stillOpen = (await openTasksOf(f.tx, after)) as TaskRow[];
    await emitBlocked(e, after, stillOpen);
  }
  if (after.status === 'AWAITING_REQUIREMENT') await emitInstance(e, WORKFLOW_EVENTS.instanceAwaitingRequirement, { requirement: after.awaitingRequirement });
  if (after.status === 'APPROVED') {
    await runHook('onApproved', f, hookContext(f, after, e.actor, e.opKey, { collectedFields: state.collectedFields }));
    await emitDecided(e, after);
  }
  return opened;
}

/** Closes every OPEN task (terminal state, §11.1: REJECT_PAIR included) with its NOT_REQUIRED event. */
export async function closeAllOpen(f: Frame, e: Emitter, except: readonly string[] = []): Promise<void> {
  const open = (await openTasksOf(f.tx, f.inst)).filter((t) => !except.includes(t.id)) as TaskRow[];
  const approved = await f.tx.workflowTask.findMany({ where: { instanceId: f.inst.id, companyId: f.inst.companyId, status: 'APPROVED' }, select: { actedByUserId: true } });
  await closeNotRequired(e, open, approved.map((a) => a.actedByUserId).filter((x): x is string => !!x), f.at);
}
