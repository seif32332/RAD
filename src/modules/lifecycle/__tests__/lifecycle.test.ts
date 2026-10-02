// lifecycle unit tests: the state machine (lcy-to-be.md §11 as amended by ARC-LCY-A1..A5) planned
// without a database, the canonical readers (BR-LCY-010) and the ExitReason dictionary. The database
// behaviour, including the double-call tests of every transition, is lifecycle.it.test.ts.
import { describe, expect, it } from 'vitest';
import { EXIT_REASONS } from '@/app/api/employees/_workforce-fields';
import { EMPLOYEE_EXIT_REASONS } from '@/lib/workforce/reasons';
import {
  EXIT_REASON_CODES,
  EmploymentTransitionError,
  canPunch,
  effectiveState,
  employmentEnd,
  employmentEventKey,
  exitStateFor,
  isEmployedOn,
  planTransition,
  type CurrentEmployment,
  type TransitionPlan,
} from '@/modules/lifecycle';

const TODAY = '2026-10-10';
const base: CurrentEmployment = {
  state: 'ACTIVE',
  terminationDate: null,
  exitReason: null,
  exitVoluntary: null,
  joinDate: '2024-01-01',
  period: { id: 'p1', lineageId: 'l1', validFrom: '2024-01-01', validTo: null },
  latestChangeId: 'c1',
  previousLineageEnd: null,
};
const notice: CurrentEmployment = { ...base, state: 'NOTICE', terminationDate: '2026-10-31', exitReason: 'RESIGNATION', exitVoluntary: true, period: { ...base.period!, validTo: '2026-11-01' } };
const terminated: CurrentEmployment = { ...base, state: 'TERMINATED', terminationDate: '2026-09-30', exitReason: 'RESIGNATION', exitVoluntary: true, period: { ...base.period!, validTo: '2026-10-01' } };

const apply = (cur: CurrentEmployment, req: Parameters<typeof planTransition>[1], released = true) => {
  const r = planTransition(cur, req, TODAY, released);
  if (r.kind !== 'APPLY') throw new Error(`expected APPLY, got ${r.kind}`);
  return r as TransitionPlan;
};
const refused = (cur: CurrentEmployment, req: Parameters<typeof planTransition>[1], code: string, released = true) => {
  try {
    planTransition(cur, req, TODAY, released);
  } catch (e) {
    expect(e).toBeInstanceOf(EmploymentTransitionError);
    expect((e as EmploymentTransitionError).code).toBe(code);
    return;
  }
  throw new Error(`expected refusal ${code}`);
};

describe('planTransition: the employment state machine', () => {
  it('HIRE opens ACTIVE from nothing, and only from nothing', () => {
    const p = apply({ ...base, state: null, period: null, latestChangeId: null }, { command: 'HIRE', date: '2026-11-01' });
    expect(p).toMatchObject({ transition: 'HIRE', fromState: null, toState: 'ACTIVE', period: { type: 'OPEN', validFrom: '2026-11-01' }, events: ['employment.hired'] });
    refused(base, { command: 'HIRE', date: '2026-11-01' }, 'ALREADY_EMPLOYED');
  });

  it('EXIT from ACTIVE: T1 (NOTICE) for a later last day, T3 for today or earlier (BR-LCY-001)', () => {
    expect(apply(base, { command: 'EXIT', date: '2026-10-31', exitReason: 'RESIGNATION' })).toMatchObject({
      transition: 'NOTICE', toState: 'NOTICE', terminationDate: '2026-10-31', period: { type: 'END', validTo: '2026-11-01' }, endsLogin: false, events: ['employment.noticeStarted'],
    });
    expect(apply(base, { command: 'EXIT', date: TODAY })).toMatchObject({ transition: 'TERMINATE', toState: 'TERMINATED', endsLogin: true, events: ['employment.terminated'] });
  });

  it('NOTICE is not released yet: a future last day keeps today\'s TERMINATED meaning (ADR-0004 #3)', () => {
    expect(exitStateFor('2026-10-31', TODAY, false)).toBe('TERMINATED');
    expect(apply(base, { command: 'EXIT', date: '2026-10-31' }, false)).toMatchObject({ transition: 'TERMINATE', toState: 'TERMINATED', terminationDate: '2026-10-31' });
    refused(base, { command: 'NOTICE', date: '2026-10-31' }, 'NOTICE_NOT_RELEASED', false);
  });

  it('EXIT repeat: same state and same date is nothing (the reason is not compared); another date is refused (D1)', () => {
    expect(planTransition(terminated, { command: 'EXIT', date: '2026-09-30', exitReason: 'OTHER' }, TODAY, true)).toMatchObject({ kind: 'NO_CHANGE' });
    expect(planTransition(notice, { command: 'EXIT', date: '2026-10-31' }, TODAY, true)).toMatchObject({ kind: 'NO_CHANGE' });
    refused(terminated, { command: 'EXIT', date: '2026-09-15' }, 'USE_AMEND');
    refused(notice, { command: 'EXIT', date: '2026-10-05' }, 'USE_AMEND');
  });

  it('EXIT from NOTICE by absconding is T3n (two people), last day up to today', () => {
    const p = apply(notice, { command: 'EXIT', date: '2026-10-05', fromNotice: 'TERMINATE_IN_NOTICE', exitReason: 'ABSCONDING' });
    expect(p).toMatchObject({ transition: 'TERMINATE_IN_NOTICE', toState: 'TERMINATED', twoPerson: true, exitReason: 'ABSCONDING', endsLogin: true });
    refused(notice, { command: 'TERMINATE_IN_NOTICE', date: '2026-10-20' }, 'FUTURE_DATE');
  });

  it('T2 ends a notice whose last day has passed, not before (BR-LCY-003, "NOTICE" literally)', () => {
    refused(notice, { command: 'NOTICE_END', date: null }, 'NOT_DUE');
    const due = { ...notice, terminationDate: '2026-10-09' };
    expect(apply(due, { command: 'NOTICE_END', date: null })).toMatchObject({ transition: 'NOTICE_END', toState: 'TERMINATED', period: { type: 'NONE' }, twoPerson: false });
    refused(base, { command: 'NOTICE_END', date: null }, 'NOT_NOTICE');
  });

  it('T1c cancels a notice before the last day (two people, reopens the period); after it the way is T4', () => {
    expect(apply(notice, { command: 'CANCEL_EXIT', date: null })).toMatchObject({
      transition: 'CANCEL_EXIT', toState: 'ACTIVE', terminationDate: null, exitReason: null, period: { type: 'END', validTo: null }, twoPerson: true,
    });
    refused({ ...notice, terminationDate: '2026-10-01' }, { command: 'CANCEL_EXIT', date: null }, 'USE_REHIRE');
    refused(terminated, { command: 'CANCEL_EXIT', date: null }, 'USE_REHIRE');
  });

  it('T4 rehires a TERMINATED employee in a new lineage after the old end; refused in NOTICE (ARC-LCY-A3)', () => {
    expect(apply(terminated, { command: 'REHIRE', date: '2026-10-01' })).toMatchObject({ transition: 'REHIRE', toState: 'ACTIVE', period: { type: 'OPEN', validFrom: '2026-10-01' }, twoPerson: true });
    refused(terminated, { command: 'REHIRE', date: '2026-09-30' }, 'REHIRE_OVERLAP');
    refused(notice, { command: 'REHIRE', date: '2026-12-01' }, 'IN_NOTICE');
  });

  it('D1 corrects the date or the reason (two people, supersedes the fact), moving NOTICE <-> TERMINATED by the date', () => {
    const early = apply(notice, { command: 'AMEND', date: '2026-10-08' });
    expect(early).toMatchObject({ toState: 'TERMINATED', supersedes: true, twoPerson: true, endsLogin: true });
    expect(early.events).toEqual(['employment.exitAmended', 'employment.lastWorkingDayChanged', 'employment.terminated']);
    const later = apply(terminated, { command: 'AMEND', date: '2026-11-15' });
    expect(later).toMatchObject({ fromState: 'TERMINATED', toState: 'NOTICE', loginReenableRequired: true, period: { type: 'END', validTo: '2026-11-16' } });
    const reasonOnly = apply(terminated, { command: 'AMEND', date: null, amendsReason: true, exitReason: 'ARTICLE_80', exitVoluntary: false });
    expect(reasonOnly).toMatchObject({ toState: 'TERMINATED', exitReason: 'ARTICLE_80', period: { type: 'NONE' }, events: ['employment.exitAmended'] });
    expect(planTransition(terminated, { command: 'AMEND', date: '2026-09-30' }, TODAY, true)).toMatchObject({ kind: 'NO_CHANGE' });
    refused(base, { command: 'AMEND', date: '2026-10-01' }, 'NOT_EXITING');
    expect(() => planTransition(terminated, { command: 'AMEND', date: null, amendsReason: true, exitReason: 'NOPE' }, TODAY, true)).toThrow(/سبب الخروج/);
  });

  it('V1 voids an ACTIVE lineage back to the previous end (or TERMINATED without a date)', () => {
    expect(apply(base, { command: 'VOID', date: null })).toMatchObject({ transition: 'VOID', toState: 'TERMINATED', terminationDate: null, period: { type: 'VOID' }, supersedes: true, twoPerson: true });
    const rehired = { ...base, previousLineageEnd: { terminationDate: '2025-12-31', exitReason: 'RESIGNATION', exitVoluntary: true } };
    expect(apply(rehired, { command: 'VOID', date: null })).toMatchObject({ terminationDate: '2025-12-31', exitReason: 'RESIGNATION' });
    refused(notice, { command: 'VOID', date: null }, 'NOT_ACTIVE');
  });

  it('input errors are 400: a last day before the join date, an unknown reason, a missing date', () => {
    const e = (() => { try { planTransition(base, { command: 'EXIT', date: '2023-01-01' }, TODAY, true); } catch (x) { return x as EmploymentTransitionError; } })();
    expect(e?.status).toBe(400);
    expect(() => planTransition(base, { command: 'EXIT', date: null }, TODAY, true)).toThrow(EmploymentTransitionError);
    expect(() => planTransition(base, { command: 'EXIT', date: TODAY, exitReason: 'X' }, TODAY, true)).toThrow(/سبب الخروج/);
  });
});

describe('canonical readers (BR-LCY-010, BR-LCY-013)', () => {
  const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
  it('effectiveState falls back to isTerminated only while the projection is empty', () => {
    expect(effectiveState({ employmentState: null, isTerminated: true })).toBe('TERMINATED');
    expect(effectiveState({ employmentState: null, isTerminated: false })).toBe('ACTIVE');
    expect(effectiveState({ employmentState: 'NOTICE', isTerminated: false })).toBe('NOTICE');
  });
  it('employmentEnd / isEmployedOn / canPunch read the date in NOTICE and TERMINATED only', () => {
    const n = { employmentState: 'NOTICE' as const, isTerminated: false, terminationDate: d('2026-10-31'), joinDate: d('2024-01-01') };
    expect(employmentEnd(n)?.toISOString().slice(0, 10)).toBe('2026-10-31');
    expect(isEmployedOn(n, '2026-10-31')).toBe(true);
    expect(isEmployedOn(n, '2026-11-01')).toBe(false);
    expect(canPunch(n, '2026-10-20')).toBe(true);
    const a = { employmentState: 'ACTIVE' as const, isTerminated: false, terminationDate: d('2020-01-01'), joinDate: d('2024-01-01') };
    expect(employmentEnd(a)).toBeNull();
    expect(isEmployedOn(a, '2023-12-31')).toBe(false);
    const t = { employmentState: 'TERMINATED' as const, isTerminated: true, terminationDate: null, joinDate: d('2024-01-01') };
    expect(isEmployedOn(t, '2025-01-01')).toBe(false);
    expect(canPunch({ ...t, terminationDate: d('2030-01-01') }, '2026-10-10')).toBe(false);
  });
  it('event keys: employment:{stateChangeId} for the first event of a change (ARC-LCY-A5)', () => {
    expect(employmentEventKey('abc', 'employment.terminated', 0)).toBe('employment:abc');
    expect(employmentEventKey('abc', 'employment.exitAmended', 1)).toBe('employment:abc:employment.exitAmended');
  });
});

describe('ExitReason dictionary (ARC-OFF-A3)', () => {
  it('the lifecycle dictionary equals the employee-form and workforce copies', () => {
    expect([...EXIT_REASON_CODES]).toEqual([...EXIT_REASONS]);
    expect([...EXIT_REASON_CODES]).toEqual([...EMPLOYEE_EXIT_REASONS]);
  });
});
