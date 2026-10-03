// Candidate resolution (wfe-to-be.md §12.4, §12.5; AUDIT/16 §4 "resolve") and the DEC-PO-145 guardrails 1-3 on the
// pure resolver: eligibility comes only from the env (iam), exclusions apply to the stage AND the cover, guards only
// narrow, nobody left → BLOCKED.
import { afterEach, describe, expect, it } from 'vitest';
import type { AppRole } from '@/lib/constants';
import type { CandidateGuard, InstanceView } from '../adapters';
import type { StageNode } from '../definition';
import { slotsOfStage } from '../engine';
import { registerWorkflowPort } from '../ports';
import { buildManagerChain, checkActor, cover, resolveSlot, resolveSpecial, type ChainEntry, type ExclusionReason, type ResolveEnv } from '../resolve';
import { resetWorkflowRegistries } from '../testing';

const instance: InstanceView = { id: 'i', companyId: 'A', requestType: 'tests.x', requestId: 'r', status: 'RUNNING', round: 1, version: 1, beneficiaryEmployeeIds: ['eBen'], requesterUserId: 'uReq', contextSnapshot: {} };
const settings = { maxReturns: null, returnExpiryWorkingDays: null, coverRole: null as AppRole | null, rejectRequiresPair: true, rejectAuthority: ['HR_MANAGER', 'COMPANY_ADMIN'] as AppRole[] };

function env(over: Partial<ResolveEnv> = {}): ResolveEnv {
  return {
    eligible: new Map<string, AppRole>([
      ['uHr1', 'HR_MANAGER'],
      ['uHr2', 'HR_MANAGER'],
      ['uOwner', 'COMPANY_ADMIN'],
      ['uSuper', 'SUPER_ADMIN'],
      ['uMgr', 'BRANCH_MANAGER'],
      ['uBen', 'HR_MANAGER'], // the beneficiary's login holds the stage role
      ['uReq', 'HR_MANAGER'], // so does the requester
      ['uEmpMgr', 'EMPLOYEE'],
      ['uLegal', 'LEGAL_ADMIN'],
    ]),
    exclusions: { beneficiaryUserIds: new Set(['uBen']), requesterUserId: 'uReq' },
    guards: [],
    instance,
    settings: { ...settings },
    chain: [{ level: 1, employeeId: 'eMgr', userId: 'uMgr' }],
    unavailableEmployees: new Set(),
    ...over,
  };
}
const ROLE = (role: AppRole): StageNode => ({ type: 'stage', id: 'st', approver: { kind: 'ROLE', role } });
const CHAIN = (levels = 1): StageNode => ({ type: 'stage', id: 'm', approver: { kind: 'MANAGER_CHAIN', levels } });
const slot = (s: StageNode, level = 0) => slotsOfStage(s, [])[level];
const none = new Map<string, ExclusionReason>();
const ids = (r: { candidates: { userId: string }[] }) => r.candidates.map((c) => c.userId).sort();

describe('ROLE stages', () => {
  it('candidates are the eligible logins with the role only (eligibility comes from iam, nothing else)', () => {
    const r = resolveSlot(slot(ROLE('HR_MANAGER')), env(), none);
    expect(ids(r)).toEqual(['uHr1', 'uHr2']);
    expect(r).toMatchObject({ coverReason: null, blocked: false });
    expect(r.candidates.every((c) => c.via === 'STAGE' && c.roles.join() === 'HR_MANAGER')).toBe(true);
    // A login that iam did not return (another company, inactive, vendor, separated) never appears.
    expect(ids(resolveSlot(slot(ROLE('HR_MANAGER')), env({ eligible: new Map([['uHr1', 'HR_MANAGER']]) }), none))).toEqual(['uHr1']);
  });

  it('strict G1 / G1b: the beneficiary\'s login and the requester are excluded from the stage AND from the cover', () => {
    const r = resolveSlot(slot(ROLE('HR_MANAGER')), env({ eligible: new Map([['uBen', 'HR_MANAGER'], ['uReq', 'HR_MANAGER'], ['uSuper', 'SUPER_ADMIN']]) }), none);
    expect(r).toMatchObject({ coverReason: 'APPROVER_UNAVAILABLE', blocked: false });
    expect(ids(r)).toEqual(['uSuper']);
    const ownerIsRequester = resolveSlot(slot(ROLE('LEGAL_ADMIN')), env({ eligible: new Map([['uReq', 'SUPER_ADMIN']]) }), none);
    expect(ownerIsRequester).toMatchObject({ candidates: [], blocked: true });
  });

  it('nobody left after the cover (coverRole, then the owner group): BLOCKED — never a silent skip, never self-approval', () => {
    const r = resolveSlot(slot(ROLE('PURCHASING_AGENT')), env({ eligible: new Map([['uBen', 'SUPER_ADMIN']]) }), none);
    expect(r).toEqual({ candidates: [], coverReason: 'APPROVER_UNAVAILABLE', blocked: true });
  });

  it('cover: coverRole first, then the owner group, both after the exclusions', () => {
    const e = env({ settings: { ...settings, coverRole: 'LEGAL_ADMIN' } });
    const r = resolveSlot(slot(ROLE('PURCHASING_AGENT')), e, none);
    expect(r.candidates).toEqual([{ userId: 'uLegal', via: 'COVER', roles: ['LEGAL_ADMIN'], reason: 'APPROVER_UNAVAILABLE' }]);
    const o = cover(env(), { nodeId: 'x', kind: 'APPROVE', stageId: 'x' }, new Map([['uOwner', 'PRIOR_APPROVER']]), 'DEADLINE');
    expect(o.candidates.map((c) => [c.userId, c.via])).toEqual([['uSuper', 'OWNER_COVER']]);
  });
});

describe('MANAGER_CHAIN', () => {
  it('the manager from the snapshot; a missing manager or a loop → cover NO_MANAGER; on leave → MANAGER_ON_LEAVE; not a MANAGERS role → APPROVER_UNAVAILABLE', () => {
    expect(resolveSlot(slot(CHAIN()), env(), none).candidates).toEqual([{ userId: 'uMgr', via: 'STAGE', roles: expect.arrayContaining(['BRANCH_MANAGER']) }]);
    expect(resolveSlot(slot(CHAIN()), env({ chain: [{ level: 1, employeeId: null, userId: null, reason: 'NO_MANAGER' }] }), none).coverReason).toBe('NO_MANAGER');
    expect(resolveSlot(slot(CHAIN()), env({ chain: [{ level: 1, employeeId: null, userId: null, reason: 'LOOP' }] }), none).coverReason).toBe('NO_MANAGER');
    expect(resolveSlot(slot(CHAIN()), env({ unavailableEmployees: new Set(['eMgr']) }), none).coverReason).toBe('MANAGER_ON_LEAVE');
    expect(resolveSlot(slot(CHAIN()), env({ chain: [{ level: 1, employeeId: 'eX', userId: 'uEmpMgr' }] }), none).coverReason).toBe('APPROVER_UNAVAILABLE');
    expect(resolveSlot(slot(CHAIN()), env({ chain: [{ level: 1, employeeId: 'eX', userId: null }] }), none).coverReason).toBe('APPROVER_UNAVAILABLE');
    // The manager who is also the requester is excluded (G1b) → cover.
    const r = resolveSlot(slot(CHAIN()), env({ chain: [{ level: 1, employeeId: 'eX', userId: 'uReq' }] }), none);
    expect(r.coverReason).toBe('APPROVER_UNAVAILABLE');
    expect(ids(r)).not.toContain('uReq');
  });

  it('buildManagerChain: up to k levels, a loop or a missing manager ends the chain, a TERMINATED manager has no login', async () => {
    resetWorkflowRegistries();
    const managers: Record<string, string | null> = { e0: 'e1', e1: 'e2', e2: 'e0', x0: 'x1', x1: null };
    registerWorkflowPort('ManagerChain', { managerOf: async (_tx, id) => managers[id] ?? null });
    registerWorkflowPort('BeneficiaryState', {
      employees: async (_tx, list) =>
        list.map((employeeId) => ({ employeeId, userId: `u-${employeeId}`, companyId: 'A', employmentState: employeeId === 'e2' ? ('TERMINATED' as const) : ('ACTIVE' as const), lastWorkingDay: null })),
      employeesOfUsers: async () => [],
    });
    const tx = {} as never;
    const loop: ChainEntry[] = await buildManagerChain(tx, 'e0', 4, new Date());
    expect(loop).toEqual([
      { level: 1, employeeId: 'e1', userId: 'u-e1', anchor: 'e0' },
      { level: 2, employeeId: 'e2', userId: null, anchor: 'e0' },
      { level: 3, employeeId: null, userId: null, reason: 'LOOP', anchor: 'e0' },
      { level: 4, employeeId: null, userId: null, reason: 'LOOP', anchor: 'e0' },
    ]); // the anchor is kept so the chain can be rebuilt live (review M-2)
    const missing = await buildManagerChain(tx, 'x0', 3, new Date());
    expect(missing.map((e) => e.reason ?? e.employeeId)).toEqual(['x1', 'NO_MANAGER', 'NO_MANAGER']);
    expect((await buildManagerChain(tx, null, 2, new Date())).every((e) => e.reason === 'NO_MANAGER')).toBe(true);
  });
  afterEach(() => resetWorkflowRegistries());
});

describe('special tasks and exclusions', () => {
  it('REJECT_PAIR: the rejectAuthority holders minus the first rejecter, minus G1 / G1b; nobody → cover → BLOCKED', () => {
    const r = resolveSpecial('REJECT_PAIR', 'REJECT_PAIR#1', env(), new Map([['uHr1', 'FIRST_REJECTER']]));
    expect(ids(r)).toEqual(['uHr2', 'uOwner']);
    const only = env({ eligible: new Map([['uHr1', 'HR_MANAGER'], ['uBen', 'COMPANY_ADMIN']]) });
    expect(resolveSpecial('REJECT_PAIR', 'REJECT_PAIR#1', only, new Map([['uHr1', 'FIRST_REJECTER']]))).toMatchObject({ candidates: [], blocked: true });
  });

  it('CANCEL_CONFIRM: the current stage candidates still eligible, minus the canceller; REQUIREMENT_CHECK never blocks', () => {
    const stage = [
      { userId: 'uHr1', via: 'STAGE' as const, roles: ['HR_MANAGER' as AppRole] },
      { userId: 'uHr2', via: 'STAGE' as const, roles: ['HR_MANAGER' as AppRole] },
      { userId: 'uGone', via: 'STAGE' as const, roles: ['HR_MANAGER' as AppRole] },
    ];
    expect(ids(resolveSpecial('CANCEL_CONFIRM', 'CANCEL_CONFIRM#1', env(), new Map([['uHr1', 'CANCELLER']]), stage))).toEqual(['uHr2']);
    expect(resolveSpecial('REQUIREMENT_CHECK', 'REQUIREMENT_CHECK#1', env({ settings: { ...settings, rejectAuthority: [] } }), none)).toEqual({ candidates: [], coverReason: null, blocked: false });
  });

  it('guards only narrow: an exclusion removes; anything but exactly { ok: true } excludes (fail closed); no guard can add a login', () => {
    const guards: CandidateGuard[] = [({ userId }) => (userId === 'uHr1' ? { exclude: true, reason: 'ASSET_HOLDER' } : { ok: true })];
    expect(ids(resolveSlot(slot(ROLE('HR_MANAGER')), env({ guards }), none))).toEqual(['uHr2']);
    const sloppy = [(() => ({ ok: true, alsoAdd: 'uOutsider' })) as unknown as CandidateGuard];
    expect(resolveSlot(slot(ROLE('HR_MANAGER')), env({ guards: sloppy }), none)).toMatchObject({ candidates: [], blocked: true });
    const allowAll: CandidateGuard[] = [() => ({ ok: true })];
    expect(ids(resolveSlot(slot(ROLE('HR_MANAGER')), env({ guards: allowAll }), none))).toEqual(['uHr1', 'uHr2']);
  });

  it('checkActor (act time): the role must still be held, and every exclusion is applied on the current data', () => {
    const st = { nodeId: 'st', kind: 'APPROVE' as const, stageId: 'st' };
    expect(checkActor('uHr1', ['HR_MANAGER'], env(), st, none)).toEqual({ ok: true });
    expect(checkActor('uHr1', ['HR_MANAGER'], env({ eligible: new Map([['uHr1', 'EMPLOYEE']]) }), st, none)).toEqual({ ok: false, reason: 'NOT_ELIGIBLE' });
    expect(checkActor('uHr1', ['HR_MANAGER'], env({ eligible: new Map() }), st, none)).toEqual({ ok: false, reason: 'NOT_ELIGIBLE' });
    expect(checkActor('uBen', ['HR_MANAGER'], env(), st, none)).toEqual({ ok: false, reason: 'G1_BENEFICIARY' });
    expect(checkActor('uReq', ['HR_MANAGER'], env(), st, none)).toEqual({ ok: false, reason: 'G1B_REQUESTER' });
    expect(checkActor('uHr2', ['HR_MANAGER'], env(), st, new Map([['uHr2', 'G2B_SIBLING']]))).toEqual({ ok: false, reason: 'G2B_SIBLING' });
  });
});
