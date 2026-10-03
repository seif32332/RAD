// The engine's pure core (no database): the §11.1 state machine as data, the expression evaluator and the node
// walker (sequence, condition, parallel ALL / ANY, MANAGER_CHAIN levels). The transitions (transitions/*.ts)
// read and write; everything they decide about "what comes next" is decided here.
import type { WorkflowInstanceStatus } from '@prisma/client';
import type { Expr, StageNode, WfNode } from './definition';
import { WorkflowError } from './errors';

// ---------------------------------------------------------------------------------------------------
// State machine (wfe-to-be.md §11.1)

export const TERMINAL_STATUSES: readonly WorkflowInstanceStatus[] = Object.freeze(['APPROVED', 'REJECTED', 'CANCELLED']);
export const OPEN_STATUSES: readonly WorkflowInstanceStatus[] = Object.freeze(['RUNNING', 'AWAITING_REQUIREMENT', 'RETURNED', 'PAUSED', 'BLOCKED']);
export const ALL_STATUSES: readonly WorkflowInstanceStatus[] = Object.freeze([...OPEN_STATUSES, ...TERMINAL_STATUSES]);

export function isTerminal(s: WorkflowInstanceStatus): boolean {
  return TERMINAL_STATUSES.includes(s);
}

export type WfCommand =
  | 'approve'
  | 'reject'
  | 'return'
  | 'requirementRecheck'
  | 'confirmCancel'
  | 'declineCancel'
  | 'resubmit'
  | 'restartRound'
  | 'cancel'
  | 'requestCancel'
  | 'pause'
  | 'resume'
  | 'closeExternally'
  | 'recheck'
  | 'effectFailed';

/** command → the statuses it may start from and the statuses it may lead to. Every other pair is refused. */
export const TRANSITIONS: Readonly<Record<WfCommand, { from: readonly WorkflowInstanceStatus[]; to: readonly WorkflowInstanceStatus[] }>> = Object.freeze({
  // RUNNING | last node | APPROVED; an intermediate approval stays RUNNING (or BLOCKED when the next stage has nobody)
  approve: { from: ['RUNNING'], to: ['RUNNING', 'APPROVED', 'BLOCKED'] },
  // RUNNING, AWAITING_REQUIREMENT | reject | REJECTED (a rejection that needs a pair stays where it is)
  reject: { from: ['RUNNING', 'AWAITING_REQUIREMENT'], to: ['REJECTED', 'RUNNING', 'AWAITING_REQUIREMENT'] },
  // RUNNING | return | RETURNED
  return: { from: ['RUNNING'], to: ['RETURNED'] },
  // AWAITING_REQUIREMENT | recheck | APPROVED (REQUIREMENT_CHECK "recheck now")
  requirementRecheck: { from: ['AWAITING_REQUIREMENT'], to: ['APPROVED', 'AWAITING_REQUIREMENT'] },
  // CANCEL_CONFIRM: confirm closes, decline resumes (CANCEL_REQUESTED)
  confirmCancel: { from: ['PAUSED', 'BLOCKED'], to: ['CANCELLED'] },
  declineCancel: { from: ['PAUSED', 'BLOCKED'], to: ['PAUSED', 'BLOCKED', 'RUNNING', 'RETURNED', 'AWAITING_REQUIREMENT'] },
  // RETURNED | resubmit | RUNNING (round + 1)
  resubmit: { from: ['RETURNED'], to: ['RUNNING', 'BLOCKED', 'APPROVED', 'AWAITING_REQUIREMENT'] },
  // RUNNING | restartRound | RUNNING (round + 1)
  restartRound: { from: ['RUNNING'], to: ['RUNNING', 'BLOCKED', 'APPROVED', 'AWAITING_REQUIREMENT'] },
  // non-terminal | cancel | CANCELLED
  cancel: { from: OPEN_STATUSES, to: ['CANCELLED'] },
  // non-terminal | cancel with cancelNeedsConfirm | PAUSED(CANCEL_REQUESTED) (BLOCKED stays BLOCKED)
  requestCancel: { from: OPEN_STATUSES, to: ['PAUSED', 'BLOCKED'] },
  // RUNNING, RETURNED, AWAITING_REQUIREMENT, PAUSED | pause | PAUSED; BLOCKED | pause | BLOCKED
  pause: { from: ['RUNNING', 'RETURNED', 'AWAITING_REQUIREMENT', 'PAUSED', 'BLOCKED'], to: ['PAUSED', 'BLOCKED'] },
  // PAUSED | resume | PAUSED or previousStatus; BLOCKED | resume | BLOCKED (or out of it when candidates exist)
  resume: { from: ['PAUSED', 'BLOCKED'], to: ['PAUSED', 'RUNNING', 'RETURNED', 'AWAITING_REQUIREMENT', 'BLOCKED'] },
  // non-terminal | closeExternally | APPROVED, REJECTED or CANCELLED
  closeExternally: { from: OPEN_STATUSES, to: TERMINAL_STATUSES },
  // AWAITING_REQUIREMENT → APPROVED; RUNNING → RUNNING / BLOCKED (re-resolve); BLOCKED → RUNNING / PAUSED / BLOCKED
  recheck: { from: ['AWAITING_REQUIREMENT', 'RUNNING', 'BLOCKED'], to: ['APPROVED', 'AWAITING_REQUIREMENT', 'RUNNING', 'BLOCKED', 'PAUSED'] },
  // a persistent onApproved failure is recorded on the open instance; its status does not change
  effectFailed: { from: OPEN_STATUSES, to: OPEN_STATUSES },
});

export function canTransition(cmd: WfCommand, from: WorkflowInstanceStatus): boolean {
  return TRANSITIONS[cmd].from.includes(from);
}

export function canLeadTo(cmd: WfCommand, to: WorkflowInstanceStatus): boolean {
  return TRANSITIONS[cmd].to.includes(to);
}

/** WFE_INVALID_STATE (409) unless `cmd` may start from `from`. */
export function assertTransition(cmd: WfCommand, from: WorkflowInstanceStatus): void {
  if (!canTransition(cmd, from)) throw new WorkflowError('WFE_INVALID_STATE', `${cmd} is not allowed from ${from}`, { command: cmd, status: from });
}

// ---------------------------------------------------------------------------------------------------
// Pause stack (a set)

export function pushReason(stack: readonly string[], reason: string): string[] {
  return stack.includes(reason) ? [...stack] : [...stack, reason];
}

export function popReason(stack: readonly string[], reason: string): string[] {
  return stack.filter((r) => r !== reason);
}

// ---------------------------------------------------------------------------------------------------
// Expressions

export type Fields = Readonly<Record<string, unknown>>;

function cmp(a: unknown, b: unknown): number | null {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0; // dates as YYYY-MM-DD
  return null;
}

export function evaluate(e: Expr, fields: Fields): boolean {
  if ('all' in e) return e.all.every((x) => evaluate(x, fields));
  if ('any' in e) return e.any.some((x) => evaluate(x, fields));
  if ('not' in e) return !evaluate(e.not, fields);
  const v = fields[e.field];
  switch (e.op) {
    case 'exists':
      return v !== undefined && v !== null;
    case 'eq':
      return v === e.value;
    case 'neq':
      return v !== undefined && v !== null && v !== e.value;
    case 'in':
      return Array.isArray(e.value) && e.value.some((x) => x === v);
    default: {
      const c = cmp(v, e.value);
      if (c === null) return false;
      return e.op === 'gt' ? c > 0 : e.op === 'gte' ? c >= 0 : e.op === 'lt' ? c < 0 : c <= 0;
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// Stage slots and the walker

/** One approval step: a ROLE stage, or one level of a MANAGER_CHAIN stage (`<id>.L<n>`). */
export interface StageSlot {
  /** The task nodeId. */
  nodeId: string;
  stage: StageNode;
  /** MANAGER_CHAIN level (1-based); null for a ROLE stage. */
  level: number | null;
  /** Ids of the enclosing parallel ALL nodes (G2b: siblings need distinct people). */
  parallelAll: string[];
}

export interface PathStep {
  nodeId: string;
  /** Branch index taken, 'otherwise', or 'none' (no branch matched and no otherwise). */
  branch: number | 'otherwise' | 'none';
}

export type WalkResult = { done: true; path: PathStep[] } | { done: false; open: StageSlot[]; path: PathStep[] };

export function slotsOfStage(stage: StageNode, parallelAll: string[]): StageSlot[] {
  if (stage.approver.kind === 'ROLE') return [{ nodeId: stage.id, stage, level: null, parallelAll }];
  return Array.from({ length: stage.approver.levels }, (_, i) => ({ nodeId: `${stage.id}.L${i + 1}`, stage, level: i + 1, parallelAll }));
}

/**
 * Where the instance is: given the nodeIds approved in the current round and the fields (context snapshot plus the
 * decision fields collected so far), either the tree is done, or `open` lists the slots that must be OPEN now.
 * Conditions are evaluated when the walk reaches them; a parallel ANY is done as soon as one branch is.
 */
export function walk(root: WfNode, approved: ReadonlySet<string>, fields: Fields): WalkResult {
  const path: PathStep[] = [];
  const visit = (n: WfNode, parallelAll: string[]): { done: true } | { done: false; open: StageSlot[] } => {
    switch (n.type) {
      case 'stage': {
        for (const s of slotsOfStage(n, parallelAll)) if (!approved.has(s.nodeId)) return { done: false, open: [s] };
        return { done: true };
      }
      case 'sequence': {
        for (const c of n.children) {
          const r = visit(c, parallelAll);
          if (!r.done) return r;
        }
        return { done: true };
      }
      case 'condition': {
        const i = n.branches.findIndex((b) => evaluate(b.when, fields));
        if (i >= 0) {
          path.push({ nodeId: n.id, branch: i });
          return visit(n.branches[i].node, parallelAll);
        }
        if (n.otherwise) {
          path.push({ nodeId: n.id, branch: 'otherwise' });
          return visit(n.otherwise, parallelAll);
        }
        path.push({ nodeId: n.id, branch: 'none' });
        return { done: true };
      }
      case 'parallel': {
        const inner = n.join === 'ALL' ? [...parallelAll, n.id] : parallelAll;
        const results = n.branches.map((b) => visit(b, inner));
        if (n.join === 'ANY' && results.some((r) => r.done)) return { done: true };
        if (n.join === 'ALL' && results.every((r) => r.done)) return { done: true };
        return { done: false, open: results.flatMap((r) => (r.done ? [] : r.open)) };
      }
    }
  };
  const r = visit(root, []);
  return r.done ? { done: true, path } : { done: false, open: r.open, path };
}

/** Every slot of the tree by nodeId (for a task's stage, distinctFromPrior and the G2b siblings). */
export function slotIndex(root: WfNode): Map<string, StageSlot> {
  const out = new Map<string, StageSlot>();
  const visit = (n: WfNode, parallelAll: string[]) => {
    switch (n.type) {
      case 'stage':
        for (const s of slotsOfStage(n, parallelAll)) out.set(s.nodeId, s);
        return;
      case 'sequence':
        return n.children.forEach((c) => visit(c, parallelAll));
      case 'condition':
        n.branches.forEach((b) => visit(b.node, parallelAll));
        if (n.otherwise) visit(n.otherwise, parallelAll);
        return;
      case 'parallel': {
        const inner = n.join === 'ALL' ? [...parallelAll, n.id] : parallelAll;
        return n.branches.forEach((b) => visit(b, inner));
      }
    }
  };
  visit(root, []);
  return out;
}

/** Two slots that share a parallel ALL ancestor: G2b siblings (distinct people). */
export function areAllSiblings(a: StageSlot, b: StageSlot): boolean {
  return a.nodeId !== b.nodeId && a.parallelAll.some((p) => b.parallelAll.includes(p));
}

/**
 * The progress plan after the approvals of this round: which OPEN APPROVE tasks are no longer needed (a parallel ANY
 * completed elsewhere, a condition changed), which slots need a new task, and whether the tree is done.
 */
export function planProgress(
  root: WfNode,
  approved: ReadonlySet<string>,
  fields: Fields,
  openTaskNodeIds: readonly string[],
): { done: boolean; toOpen: StageSlot[]; notRequired: string[]; path: PathStep[] } {
  const w = walk(root, approved, fields);
  if (w.done) return { done: true, toOpen: [], notRequired: [...openTaskNodeIds], path: w.path };
  const wanted = new Set(w.open.map((s) => s.nodeId));
  return {
    done: false,
    toOpen: w.open.filter((s) => !openTaskNodeIds.includes(s.nodeId)),
    notRequired: openTaskNodeIds.filter((id) => !wanted.has(id)),
    path: w.path,
  };
}

// ---------------------------------------------------------------------------------------------------
// Task decisions

export type WorkflowDecision = 'APPROVE' | 'REJECT' | 'RETURN' | 'CONFIRM' | 'DECLINE' | 'RECHECK';

/** The decisions each task kind accepts (§11.2). DEFERRAL_DECISION: none until BL-WFE-011. */
export const DECISIONS_BY_KIND: Readonly<Record<string, readonly WorkflowDecision[]>> = Object.freeze({
  APPROVE: ['APPROVE', 'REJECT', 'RETURN'],
  REJECT_PAIR: ['CONFIRM', 'DECLINE'],
  CANCEL_CONFIRM: ['CONFIRM', 'DECLINE'],
  REQUIREMENT_CHECK: ['RECHECK', 'REJECT'],
  DEFERRAL_DECISION: [],
});

