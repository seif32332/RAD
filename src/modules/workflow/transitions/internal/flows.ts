// Flows shared by several transitions (pause / resume / recheck / unblock), kept out of transitions/*.ts so that
// every export there is a named, tested transition (ARCH-014). Callers hold the locks (openFrame) before calling.
import type { Prisma, WorkflowInstanceStatus } from '@prisma/client';
import type { ChainEntry } from '../../resolve';
import type { TxClient } from '@/modules/platform';
import { CODE_PATTERN } from '../../adapters';
import { assertTransition, canTransition, popReason, pushReason, slotIndex } from '../../engine';
import { WorkflowError } from '../../errors';
import { WORKFLOW_AUDIT, WORKFLOW_EVENTS } from '../../events';
import { requirePort } from '../../ports';
import {
  auditInstance,
  casInstance,
  casLost,
  chainChange,
  closeAllOpen,
  emitAssigned,
  emitBlocked,
  emitDecided,
  emitInstance,
  hookContext,
  openTasksOf,
  reResolve,
  resolveEnvOf,
  resultOf,
  roundState,
  runHook,
  updateCandidates,
  type Emitter,
  type Frame,
  type InstanceRow,
  type TaskRow,
  type WorkflowResult,
} from './core';

/** The snapshot column for a changed live chain (none when unchanged). */
export function chainData(chain: ChainEntry[] | null): { managerChainSnapshot?: Prisma.InputJsonArray } {
  return chain ? { managerChainSnapshot: chain as unknown as Prisma.InputJsonArray } : {};
}

export function chainDetail(inst: InstanceRow, chain: ChainEntry[] | null): Record<string, unknown> {
  return chain ? { managerChain: { before: inst.managerChainSnapshot, after: chain } } : {};
}

export function pauseData(inst: InstanceRow, reason: string, at: Date) {
  if (inst.status === 'BLOCKED') return { pauseReasons: pushReason(inst.pauseReasons, reason), previousStatus: inst.previousStatus ?? 'RUNNING' };
  if (inst.status === 'PAUSED') return { pauseReasons: pushReason(inst.pauseReasons, reason) };
  return { status: 'PAUSED' as const, previousStatus: inst.status, pausedAt: at, pauseReasons: [reason] };
}

/** The status an instance returns to when it leaves PAUSED / BLOCKED with an empty stack. */
export function leaveData(inst: InstanceRow, target: WorkflowInstanceStatus, at: Date, stash: { requirement: string | null; since: Date | null }) {
  const base = { status: target, previousStatus: null, pausedAt: null, pauseReasons: [] as string[], blockedAt: null, blockedReason: null };
  if (target === 'AWAITING_REQUIREMENT') {
    return { ...base, awaitingRequirement: inst.awaitingRequirement ?? stash.requirement ?? 'REQUIREMENT_PENDING', awaitingSince: inst.awaitingSince ?? stash.since ?? at };
  }
  return { ...base, awaitingRequirement: null, awaitingSince: null };
}

/** The awaiting requirement kept by a CANCEL_CONFIRM opened while AWAITING (BLOCKED cannot hold it, 9zj CHECK). */
export async function awaitingStash(tx: TxClient, inst: InstanceRow): Promise<{ requirement: string | null; since: Date | null }> {
  const t = await tx.workflowTask.findFirst({ where: { instanceId: inst.id, companyId: inst.companyId, kind: 'CANCEL_CONFIRM' }, orderBy: { createdAt: 'desc' }, select: { decisionFieldsJson: true } });
  const c = (t?.decisionFieldsJson as Record<string, unknown>) ?? {};
  return { requirement: typeof c.awaitingRequirement === 'string' ? c.awaitingRequirement : null, since: typeof c.awaitingSince === 'string' ? new Date(c.awaitingSince) : null };
}

/** Recomputes dueAt of the OPEN APPROVE tasks from `at` (leaving PAUSED: the deadlines start again, §3.6). */
export async function restartDeadlines(f: Frame, inst: InstanceRow): Promise<void> {
  const index = slotIndex(f.def.root);
  for (const t of await openTasksOf(f.tx, inst)) {
    if (t.kind !== 'APPROVE') continue;
    const slot = index.get(t.nodeId);
    if (!slot?.stage.deadline) continue;
    const due = await requirePort('WorkingDays').addWorkingDays(f.tx, inst.companyId, f.at, slot.stage.deadline.workingDays);
    await f.tx.workflowTask.updateMany({ where: { id: t.id, status: 'OPEN' }, data: { dueAt: due, overdueAt: null } });
  }
}

/**
 * Re-resolves every OPEN task on current data. Returns the instance data (BLOCKED, or out of BLOCKED) and the tasks
 * whose candidates changed. Reads only; the caller writes after the CAS.
 */
export async function reResolveOpen(f: Frame): Promise<{ changes: { task: TaskRow; res: ReturnType<typeof reResolve> }[]; anyEmpty: boolean; chain: ChainEntry[] | null }> {
  const env = await resolveEnvOf(f);
  const state = await roundState(f);
  const index = slotIndex(f.def.root);
  const open = state.open;
  const changes = open.map((task) => ({ task, res: reResolve(task, env, state, index, open) }));
  // The live manager chain replaces the snapshot when it changed (persisted with the CAS, before / after in the audit).
  return { changes, anyEmpty: changes.some((c) => c.res.candidates.length === 0 && c.task.kind !== 'REQUIREMENT_CHECK'), chain: chainChange(f, env) };
}

export async function unblockTarget(f: Frame, inst: InstanceRow) {
  if (inst.pauseReasons.length) {
    return { status: 'PAUSED' as const, previousStatus: inst.previousStatus ?? 'RUNNING', pausedAt: f.at, blockedAt: null, blockedReason: null };
  }
  return leaveData(inst, inst.previousStatus ?? 'RUNNING', f.at, await awaitingStash(f.tx, inst));
}

/** Writes re-resolved candidates after the CAS; emits assigned for the tasks that changed (and have someone). */
export async function writeReResolved(f: Frame, e: Emitter, changes: { task: TaskRow; res: ReturnType<typeof reResolve> }[]): Promise<TaskRow[]> {
  const changed: TaskRow[] = [];
  for (const c of changes) {
    if (await updateCandidates(f.tx, c.task, c.res)) changed.push({ ...c.task, candidateUserIds: c.res.candidates.map((x) => x.userId) });
  }
  await emitAssigned(e, changed);
  return changed;
}

/** The resume logic, shared with the CANCEL_CONFIRM decline (resume(CANCEL_REQUESTED)). Writes; the caller locked. */
export async function resumeInFrame(f: Frame, e: Emitter, reason: string): Promise<{ after: InstanceRow; opened: string[] } | null> {
  const inst = f.inst;
  assertTransition('resume', inst.status);
  const stack = popReason(inst.pauseReasons, reason);
  if (inst.status === 'PAUSED') {
    const data = stack.length ? { pauseReasons: stack } : leaveData(inst, inst.previousStatus ?? 'RUNNING', f.at, await awaitingStash(f.tx, inst));
    const after = await casInstance(f.tx, inst, ['PAUSED'], data);
    if (!after) return null;
    if (after.status === 'RUNNING') await restartDeadlines(f, after);
    await auditInstance({ ...e, inst: after }, WORKFLOW_AUDIT.resumed, inst, after, { reason });
    return { after, opened: [] };
  }
  // BLOCKED: the reason leaves the stack, the instance stays BLOCKED; then the candidates are resolved again (RT-WFE-1305).
  const { changes, anyEmpty, chain } = await reResolveOpen({ ...f, inst: { ...inst, pauseReasons: stack } });
  const data = anyEmpty ? { pauseReasons: stack } : await unblockTarget(f, { ...inst, pauseReasons: stack });
  const after = await casInstance(f.tx, inst, ['BLOCKED'], { ...data, ...chainData(chain) });
  if (!after) return null;
  await writeReResolved({ ...f, inst: after }, { ...e, inst: after }, changes);
  if (after.status === 'RUNNING') await restartDeadlines(f, after);
  await auditInstance({ ...e, inst: after }, WORKFLOW_AUDIT.resumed, inst, after, { reason, detail: { unblocked: after.status !== 'BLOCKED', ...chainDetail(inst, chain) } });
  return { after, opened: [] };
}

/** Shared with the REQUIREMENT_CHECK "recheck now" decision (task.ts). `taskToClose`: that task, closed NOT_REQUIRED. */
export async function recheckInFrame(f: Frame, e: Emitter, taskToClose: TaskRow | null): Promise<WorkflowResult> {
  const inst = f.inst;
  if (!canTransition('recheck', inst.status)) return resultOf(inst, 'NO_CHANGE');
  if (inst.status === 'AWAITING_REQUIREMENT') {
    if (f.adapter.refresh) await f.adapter.refresh(f.tx, f.request);
    const final = await f.adapter.validateFinal(f.tx, f.request);
    if ('ok' in final && final.ok === true) {
      const after = await casInstance(f.tx, inst, ['AWAITING_REQUIREMENT'], { status: 'APPROVED', closedAt: f.at, closeKind: 'AUTO_APPROVED', awaitingRequirement: null, awaitingSince: null });
      if (!after) return casLost(f.tx, inst.id);
      const ee = { ...e, inst: after };
      await closeAllOpen({ ...f, inst: after }, ee);
      await runHook('onApproved', f, hookContext(f, after, e.actor, e.opKey));
      await auditInstance(ee, WORKFLOW_AUDIT.requirementMet, inst, after, { detail: { requirement: inst.awaitingRequirement, actor: 'system.autoApprove' } });
      await emitDecided(ee, after);
      return resultOf(after, 'APPLIED');
    }
    if ('awaitable' in final && final.awaitable === true && final.requirement !== inst.awaitingRequirement && CODE_PATTERN.test(String(final.requirement))) {
      const after = await casInstance(f.tx, inst, ['AWAITING_REQUIREMENT'], { awaitingRequirement: String(final.requirement) });
      if (!after) return casLost(f.tx, inst.id);
      await auditInstance({ ...e, inst: after }, WORKFLOW_AUDIT.rechecked, inst, after);
      await emitInstance({ ...e, inst: after }, WORKFLOW_EVENTS.instanceAwaitingRequirement, { requirement: after.awaitingRequirement });
      return resultOf(after, 'APPLIED');
    }
    if (taskToClose) throw new WorkflowError('WFE_VALIDATION', 'error' in final ? String(final.error) : String((final as { requirement?: unknown }).requirement ?? 'requirement not met'));
    return resultOf(inst, 'NO_CHANGE');
  }
  // RUNNING / BLOCKED: resolve the open steps again.
  const { changes, anyEmpty, chain } = await reResolveOpen(f);
  const changedTasks = changes.filter((c) => c.res.candidates.map((x) => x.userId).join(',') !== c.task.candidateUserIds.join(',') || (c.res.coverReason ?? null) !== (c.task.coverReason ?? null));
  let data: Record<string, unknown> | null = null;
  if (inst.status === 'RUNNING' && anyEmpty) data = { status: 'BLOCKED', blockedAt: f.at, blockedReason: 'NO_CANDIDATE' };
  else if (inst.status === 'BLOCKED' && !anyEmpty) data = await unblockTarget(f, inst);
  if (!data && !changedTasks.length && !chain) return resultOf(inst, 'NO_CHANGE');
  const after = await casInstance(f.tx, inst, [inst.status], { ...(data ?? {}), ...chainData(chain) });
  if (!after) return casLost(f.tx, inst.id);
  const ee = { ...e, inst: after };
  const changed = await writeReResolved({ ...f, inst: after }, ee, changedTasks);
  if (after.status === 'BLOCKED' && inst.status !== 'BLOCKED') await emitBlocked(ee, after, changes.map((c) => ({ nodeId: c.task.nodeId, candidateUserIds: c.res.candidates.map((x) => x.userId) })));
  if (inst.status === 'BLOCKED' && after.status === 'RUNNING') await restartDeadlines(f, after);
  await auditInstance(ee, WORKFLOW_AUDIT.rechecked, inst, after, { detail: { changedTaskIds: changed.map((t) => t.id), ...chainDetail(inst, chain) } });
  return resultOf(after, 'APPLIED');
}