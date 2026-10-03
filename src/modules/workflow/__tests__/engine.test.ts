// The engine's pure core: the §11.1 state machine as data, the pause set, the walker (AUDIT/16 §4 "engine").
import { describe, expect, it } from 'vitest';
import type { WfNode } from '../definition';
import {
  ALL_STATUSES,
  DECISIONS_BY_KIND,
  TERMINAL_STATUSES,
  TRANSITIONS,
  areAllSiblings,
  assertTransition,
  canTransition,
  evaluate,
  planProgress,
  popReason,
  pushReason,
  slotIndex,
  walk,
  type WfCommand,
} from '../engine';
import { isWorkflowError } from '../errors';

const hr = (id: string): WfNode => ({ type: 'stage', id, approver: { kind: 'ROLE', role: 'HR_MANAGER' } });

describe('the §11.1 state machine', () => {
  // The allowed from-states per command, written out from wfe-to-be.md §11.1 (independently of TRANSITIONS).
  const EXPECTED: Record<WfCommand, string[]> = {
    approve: ['RUNNING'],
    reject: ['RUNNING', 'AWAITING_REQUIREMENT'],
    return: ['RUNNING'],
    requirementRecheck: ['AWAITING_REQUIREMENT'],
    confirmCancel: ['PAUSED', 'BLOCKED'],
    declineCancel: ['PAUSED', 'BLOCKED'],
    resubmit: ['RETURNED'],
    restartRound: ['RUNNING'],
    cancel: ['RUNNING', 'AWAITING_REQUIREMENT', 'RETURNED', 'PAUSED', 'BLOCKED'],
    requestCancel: ['RUNNING', 'AWAITING_REQUIREMENT', 'RETURNED', 'PAUSED', 'BLOCKED'],
    pause: ['RUNNING', 'RETURNED', 'AWAITING_REQUIREMENT', 'PAUSED', 'BLOCKED'],
    resume: ['PAUSED', 'BLOCKED'],
    closeExternally: ['RUNNING', 'AWAITING_REQUIREMENT', 'RETURNED', 'PAUSED', 'BLOCKED'],
    recheck: ['AWAITING_REQUIREMENT', 'RUNNING', 'BLOCKED'],
    effectFailed: ['RUNNING', 'AWAITING_REQUIREMENT', 'RETURNED', 'PAUSED', 'BLOCKED'],
  };

  it('every (command, status) pair: the allowed ones pass, every other one is refused with WFE_INVALID_STATE', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const cmd of Object.keys(EXPECTED) as WfCommand[]) {
      for (const s of ALL_STATUSES) {
        const allowed = EXPECTED[cmd].includes(s);
        expect(canTransition(cmd, s), `${cmd} from ${s}`).toBe(allowed);
        if (allowed) expect(() => assertTransition(cmd, s)).not.toThrow();
        else {
          try {
            assertTransition(cmd, s);
            expect.unreachable(`${cmd} from ${s}`);
          } catch (err) {
            expect(isWorkflowError(err, 'WFE_INVALID_STATE')).toBe(true);
          }
        }
      }
    }
  });

  it('APPROVED, REJECTED and CANCELLED are final: no command leaves them', () => {
    for (const s of TERMINAL_STATUSES) for (const cmd of Object.keys(TRANSITIONS) as WfCommand[]) expect(canTransition(cmd, s)).toBe(false);
  });

  it('the decisions of each task kind (§11.2); DEFERRAL_DECISION has none until BL-WFE-011', () => {
    expect(DECISIONS_BY_KIND).toEqual({
      APPROVE: ['APPROVE', 'REJECT', 'RETURN'],
      REJECT_PAIR: ['CONFIRM', 'DECLINE'],
      CANCEL_CONFIRM: ['CONFIRM', 'DECLINE'],
      REQUIREMENT_CHECK: ['RECHECK', 'REJECT'],
      DEFERRAL_DECISION: [],
    });
  });
});

describe('the pause stack is a set (RT-WFE-703)', () => {
  it('pushing a present reason changes nothing; popping removes only that reason', () => {
    expect(pushReason(['A'], 'A')).toEqual(['A']);
    expect(pushReason(['A'], 'B')).toEqual(['A', 'B']);
    expect(popReason(['A', 'B'], 'A')).toEqual(['B']);
    expect(popReason(['A'], 'C')).toEqual(['A']);
  });
});

describe('expressions', () => {
  it('evaluates every operator; a missing field compares false', () => {
    const f = { n: 5, s: 'b', d: '2026-10-01', t: true };
    expect(evaluate({ field: 'n', op: 'gt', value: 4 }, f)).toBe(true);
    expect(evaluate({ field: 'n', op: 'lte', value: 4 }, f)).toBe(false);
    expect(evaluate({ field: 'd', op: 'gte', value: '2026-10-01' }, f)).toBe(true);
    expect(evaluate({ field: 's', op: 'in', value: ['a', 'b'] }, f)).toBe(true);
    expect(evaluate({ field: 't', op: 'eq', value: true }, f)).toBe(true);
    expect(evaluate({ field: 'x', op: 'neq', value: 1 }, f)).toBe(false);
    expect(evaluate({ field: 'x', op: 'exists' }, f)).toBe(false);
    expect(evaluate({ field: 'x', op: 'lt', value: 1 }, f)).toBe(false);
    expect(evaluate({ all: [] }, f)).toBe(true);
    expect(evaluate({ any: [] }, f)).toBe(false);
    expect(evaluate({ not: { field: 'n', op: 'eq', value: 5 } }, f)).toBe(false);
  });
});

describe('the walker', () => {
  it('a sequence opens one step at a time; MANAGER_CHAIN(k) expands into k levels', () => {
    const root: WfNode = { type: 'sequence', id: 'r', children: [{ type: 'stage', id: 'm', approver: { kind: 'MANAGER_CHAIN', levels: 2 } }, hr('hr')] };
    const ids = (a: string[]) => {
      const w = walk(root, new Set(a), {});
      return w.done ? 'done' : w.open.map((s) => s.nodeId);
    };
    expect(ids([])).toEqual(['m.L1']);
    expect(ids(['m.L1'])).toEqual(['m.L2']);
    expect(ids(['m.L1', 'm.L2'])).toEqual(['hr']);
    expect(ids(['m.L1', 'm.L2', 'hr'])).toBe('done');
    expect(walk({ type: 'sequence', id: 'e', children: [] }, new Set(), {}).done).toBe(true);
  });

  it('a condition takes the first matching branch, else otherwise, else nothing; the path records it', () => {
    const root: WfNode = { type: 'condition', id: 'c', branches: [{ when: { field: 'n', op: 'gt', value: 3 }, node: hr('big') }], otherwise: hr('small') };
    const a = walk(root, new Set(), { n: 5 });
    expect(a).toEqual({ done: false, open: [expect.objectContaining({ nodeId: 'big' })], path: [{ nodeId: 'c', branch: 0 }] });
    const b = walk(root, new Set(), { n: 1 });
    expect(b.path).toEqual([{ nodeId: 'c', branch: 'otherwise' }]);
    const none = walk({ type: 'condition', id: 'c', branches: [{ when: { field: 'n', op: 'gt', value: 3 }, node: hr('big') }] }, new Set(), {});
    expect(none).toEqual({ done: true, path: [{ nodeId: 'c', branch: 'none' }] });
  });

  it('parallel ALL needs every branch; ANY is done with the first; the other open branch becomes not required', () => {
    const all: WfNode = { type: 'parallel', id: 'p', join: 'ALL', branches: [hr('a'), hr('b')] };
    const any: WfNode = { type: 'parallel', id: 'p', join: 'ANY', branches: [hr('a'), hr('b')] };
    const w = walk(all, new Set(['a']), {});
    expect(w.done ? [] : w.open.map((s) => s.nodeId)).toEqual(['b']);
    expect(walk(all, new Set(['a', 'b']), {}).done).toBe(true);
    expect(walk(any, new Set(['b']), {}).done).toBe(true);
    expect(planProgress(any, new Set(['a']), {}, ['b'])).toMatchObject({ done: true, toOpen: [], notRequired: ['b'] });
    const idx = slotIndex(all);
    expect(areAllSiblings(idx.get('a')!, idx.get('b')!)).toBe(true);
    const idxAny = slotIndex(any);
    expect(areAllSiblings(idxAny.get('a')!, idxAny.get('b')!)).toBe(false);
  });

  it('planProgress opens the new steps and keeps the ones still wanted', () => {
    const root: WfNode = { type: 'sequence', id: 'r', children: [hr('a'), { type: 'parallel', id: 'p', join: 'ALL', branches: [hr('b'), hr('c')] }] };
    expect(planProgress(root, new Set(['a']), {}, [])).toMatchObject({ done: false, notRequired: [], toOpen: [{ nodeId: 'b' }, { nodeId: 'c' }] });
    expect(planProgress(root, new Set(['a', 'b']), {}, ['c'])).toMatchObject({ done: false, notRequired: [], toOpen: [] });
  });
});
