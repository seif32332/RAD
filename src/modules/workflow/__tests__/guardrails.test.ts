// Package C guardrails on the pure functions (BL-WFE-003; wfe-to-be.md §12.1, §12.5 step 2, G9; DEC-PO-144 / 146;
// INV-IAM-01 / ADR-0010): the single-operator exception (SINGLE_OPERATOR only, only when nobody else can do the step,
// never past eligibility or a guard), the G9 attestation split (generic: pay effect + ENFORCED + financial role stage),
// the definition relaxations (editor warnings), and the two-person activation rule.
import { describe, expect, it } from 'vitest';
import type { AppRole } from '@/lib/constants';
import type { InstanceView } from '../adapters';
import { definitionRelaxations, minHumanStages, type StageNode, type WfNode, type WorkflowDefinitionDoc } from '../definition';
import { slotsOfStage } from '../engine';
import { activationRefusal, activationSelfActReasons } from '../guardrails';
import {
  attestationRequired,
  checkActor,
  resolveSlot,
  resolveSpecial,
  selfActReasons,
  singleOperatorWaiver,
  unattestedInSingleOperator,
  type ExclusionReason,
  type ResolveEnv,
} from '../resolve';

const instance: InstanceView = { id: 'i', companyId: 'A', requestType: 'tests.x', requestId: 'r', status: 'RUNNING', round: 1, version: 1, beneficiaryEmployeeIds: ['eSolo'], requesterUserId: 'uSolo', contextSnapshot: {} };
const settings = { maxReturns: null, returnExpiryWorkingDays: null, coverRole: null as AppRole | null, rejectRequiresPair: true, rejectAuthority: ['HR_MANAGER', 'COMPANY_ADMIN'] as AppRole[] };

/** A one-person company: the only eligible login is the operator, who is the beneficiary's login AND the requester. */
function solo(over: Partial<ResolveEnv> = {}): ResolveEnv {
  return {
    eligible: new Map<string, AppRole>([['uSolo', 'COMPANY_ADMIN']]),
    exclusions: { beneficiaryUserIds: new Set(['uSolo']), requesterUserId: 'uSolo' },
    guards: [],
    instance,
    settings: { ...settings },
    chain: [{ level: 1, employeeId: 'eMgr', userId: 'uSolo' }],
    unavailableEmployees: new Set(),
    ...over,
  };
}
const ROLE = (role: AppRole, extra: Partial<StageNode> = {}): StageNode => ({ type: 'stage', id: 'st', approver: { kind: 'ROLE', role }, ...extra });
const CHAIN = (levels = 1): StageNode => ({ type: 'stage', id: 'm', approver: { kind: 'MANAGER_CHAIN', levels } });
const slot = (s: StageNode, level = 0) => slotsOfStage(s, [])[level];
const none = new Map<string, ExclusionReason>();
const ids = (r: { candidates: { userId: string }[] }) => r.candidates.map((c) => c.userId).sort();
const st = { nodeId: 'st', kind: 'APPROVE' as const, stageId: 'st' };

describe('the single-operator exception (§12.5 step 2, DEC-PO-144)', () => {
  it('ENFORCED (or no mode read: fail closed): the operator never approves his own request; the step is BLOCKED (INV-IAM-01 regression)', () => {
    for (const env of [solo(), solo({ controlsMode: 'ENFORCED' })]) {
      const r = resolveSlot(slot(ROLE('HR_MANAGER')), env, none);
      expect(r).toMatchObject({ candidates: [], blocked: true });
    }
  });

  it('SINGLE_OPERATOR and nobody else: the operator is the candidate, carrying the waived G1 / G1b (recorded at act time)', () => {
    const r = resolveSlot(slot(ROLE('HR_MANAGER')), solo({ controlsMode: 'SINGLE_OPERATOR' }), none);
    expect(r.blocked).toBe(false);
    expect(r.candidates).toEqual([{ userId: 'uSolo', via: 'OWNER_COVER', roles: ['SUPER_ADMIN', 'COMPANY_ADMIN'], reason: 'APPROVER_UNAVAILABLE', waived: ['G1_BENEFICIARY', 'G1B_REQUESTER'] }]);
    expect(selfActReasons(r.candidates[0].waived!)).toEqual(['SELF_BENEFICIARY', 'SAME_PERSON_TWICE']);
  });

  it('SINGLE_OPERATOR but someone else can do the step: strict resolution, no exception (no self-approval while a second person exists)', () => {
    const env = solo({ controlsMode: 'SINGLE_OPERATOR', eligible: new Map<string, AppRole>([['uSolo', 'COMPANY_ADMIN'], ['uHr', 'HR_MANAGER']]) });
    const r = resolveSlot(slot(ROLE('HR_MANAGER')), env, none);
    expect(r.candidates).toEqual([{ userId: 'uHr', via: 'STAGE', roles: ['HR_MANAGER'] }]);
    // Even the cover is used before the exception.
    const viaCover = resolveSlot(slot(ROLE('LEGAL_ADMIN')), solo({ controlsMode: 'SINGLE_OPERATOR', eligible: new Map<string, AppRole>([['uSolo', 'COMPANY_ADMIN'], ['uOther', 'SUPER_ADMIN']]) }), none);
    expect(ids(viaCover)).toEqual(['uOther']);
    expect(viaCover.candidates[0].waived).toBeUndefined();
  });

  it('never past eligibility, a guard or G9: a login iam did not return, or one a guard excludes, stays out even in SINGLE_OPERATOR', () => {
    expect(resolveSlot(slot(ROLE('HR_MANAGER')), solo({ controlsMode: 'SINGLE_OPERATOR', eligible: new Map() }), none)).toMatchObject({ candidates: [], blocked: true });
    const guard = solo({ controlsMode: 'SINGLE_OPERATOR', guards: [() => ({ exclude: true, reason: 'ASSET_HOLDER' })] });
    expect(resolveSlot(slot(ROLE('HR_MANAGER')), guard, none)).toMatchObject({ candidates: [], blocked: true });
  });

  it('G2b and distinctFromPrior "بنفس الاستثناء": the sole operator approves the second step, recorded as ONE_PERSON_TWO_STEPS', () => {
    const env = solo({ controlsMode: 'SINGLE_OPERATOR', exclusions: { beneficiaryUserIds: new Set(), requesterUserId: null } });
    const prior = new Map<string, ExclusionReason>([['uSolo', 'PRIOR_APPROVER']]);
    const r = resolveSlot(slot(ROLE('HR_MANAGER', { distinctFromPrior: true })), env, prior);
    expect(r.candidates.map((c) => [c.userId, c.waived])).toEqual([['uSolo', ['PRIOR_APPROVER']]]);
    expect(selfActReasons(['PRIOR_APPROVER', 'G2B_SIBLING'])).toEqual(['ONE_PERSON_TWO_STEPS']);
    expect(resolveSlot(slot(ROLE('HR_MANAGER')), { ...env, controlsMode: 'ENFORCED' }, prior)).toMatchObject({ blocked: true });
  });

  it('special tasks: REJECT_PAIR with no second rejecter and CANCEL_CONFIRM with no other confirmer take the exception in SINGLE_OPERATOR only', () => {
    const env = solo({ exclusions: { beneficiaryUserIds: new Set(), requesterUserId: null } });
    const first = new Map<string, ExclusionReason>([['uSolo', 'FIRST_REJECTER']]);
    expect(resolveSpecial('REJECT_PAIR', 'REJECT_PAIR#1', env, first)).toMatchObject({ candidates: [], blocked: true });
    expect(resolveSpecial('REJECT_PAIR', 'REJECT_PAIR#1', { ...env, controlsMode: 'SINGLE_OPERATOR' }, first).candidates.map((c) => c.waived)).toEqual([['FIRST_REJECTER']]);
    const stage = [{ userId: 'uSolo', via: 'OWNER_COVER' as const, roles: ['COMPANY_ADMIN' as AppRole] }];
    const canceller = new Map<string, ExclusionReason>([['uSolo', 'CANCELLER']]);
    expect(resolveSpecial('CANCEL_CONFIRM', 'CANCEL_CONFIRM#1', env, canceller, stage)).toMatchObject({ blocked: true });
    expect(resolveSpecial('CANCEL_CONFIRM', 'CANCEL_CONFIRM#1', { ...env, controlsMode: 'SINGLE_OPERATOR' }, canceller, stage).candidates.map((c) => c.waived)).toEqual([['CANCELLER']]);
  });

  it('MANAGER_CHAIN: the manager who is also the requester approves only through the exception', () => {
    const env = solo({ exclusions: { beneficiaryUserIds: new Set(), requesterUserId: 'uSolo' }, eligible: new Map<string, AppRole>([['uSolo', 'BRANCH_MANAGER']]) });
    expect(resolveSlot(slot(CHAIN()), env, none)).toMatchObject({ blocked: true });
    const r = resolveSlot(slot(CHAIN()), { ...env, controlsMode: 'SINGLE_OPERATOR' }, none);
    expect(r.candidates.map((c) => [c.userId, c.via, c.waived])).toEqual([['uSolo', 'STAGE', ['G1B_REQUESTER']]]);
  });

  it('act time: checkActor stays strict; singleOperatorWaiver holds only in SINGLE_OPERATOR read now AND while the live step has nobody else', () => {
    const single = solo({ controlsMode: 'SINGLE_OPERATOR' });
    expect(checkActor('uSolo', ['SUPER_ADMIN', 'COMPANY_ADMIN'], single, st, none)).toEqual({ ok: false, reason: 'G1_BENEFICIARY' });
    const live = resolveSlot(slot(ROLE('HR_MANAGER')), single, none);
    expect(singleOperatorWaiver('uSolo', live, single)).toEqual(['G1_BENEFICIARY', 'G1B_REQUESTER']);
    // The company became ENFORCED since the task was opened: the same snapshot is refused.
    expect(singleOperatorWaiver('uSolo', live, { controlsMode: 'ENFORCED' })).toBeNull();
    expect(singleOperatorWaiver('uSolo', live, {})).toBeNull();
    // A second person appeared since: the live step resolves to him, the operator is refused.
    const now = solo({ controlsMode: 'SINGLE_OPERATOR', eligible: new Map<string, AppRole>([['uSolo', 'COMPANY_ADMIN'], ['uHr', 'HR_MANAGER']]) });
    expect(singleOperatorWaiver('uSolo', resolveSlot(slot(ROLE('HR_MANAGER')), now, none), now)).toBeNull();
    // A forged snapshot entry (waived a guard) is never honoured.
    expect(singleOperatorWaiver('uSolo', { candidates: [{ userId: 'uSolo', via: 'STAGE', roles: [], waived: ['GUARD:x' as ExclusionReason] }], coverReason: null, blocked: false }, single)).toBeNull();
  });
});

describe('G9 split (RT-WFE-701): attestation only on pay-effect instances, in ENFORCED, on financial role stages', () => {
  it('attestationRequired: the matrix', () => {
    expect(attestationRequired({ payEffect: true, controlsMode: 'ENFORCED' }, 'HR_MANAGER', false)).toBe(true);
    expect(attestationRequired({ payEffect: true }, 'FINANCE_MANAGER', false)).toBe(true); // no mode read: ENFORCED
    expect(attestationRequired({ payEffect: true, controlsMode: 'SINGLE_OPERATOR' }, 'HR_MANAGER', false)).toBe(false);
    expect(attestationRequired({ payEffect: false, controlsMode: 'ENFORCED' }, 'HR_MANAGER', false)).toBe(false);
    expect(attestationRequired({ payEffect: true, controlsMode: 'ENFORCED' }, 'HR_MANAGER', true)).toBe(false); // the direct manager (RT-WFE-801)
    expect(attestationRequired({ payEffect: true, controlsMode: 'ENFORCED' }, 'LEGAL_ADMIN', false)).toBe(false); // not a financial role
    expect(attestationRequired({ payEffect: true, controlsMode: 'SINGLE_OPERATOR' }, 'HR_MANAGER', false, 'ENFORCED')).toBe(true);
  });

  it('ENFORCED + pay effect: an unattested HR is no candidate of a role stage (an attested one is); the direct manager needs no attestation', () => {
    const env: ResolveEnv = {
      ...solo(),
      eligible: new Map<string, AppRole>([['uHrA', 'HR_MANAGER'], ['uHrU', 'HR_MANAGER'], ['uMgr', 'BRANCH_MANAGER']]),
      exclusions: { beneficiaryUserIds: new Set(), requesterUserId: null },
      chain: [{ level: 1, employeeId: 'eMgr', userId: 'uMgr' }],
      controlsMode: 'ENFORCED',
      payEffect: true,
      counted: new Set(['uHrA']),
    };
    expect(ids(resolveSlot(slot(ROLE('HR_MANAGER')), env, none))).toEqual(['uHrA']);
    expect(checkActor('uHrU', ['HR_MANAGER'], env, st, none)).toEqual({ ok: false, reason: 'G9_UNATTESTED' });
    expect(ids(resolveSlot(slot(CHAIN()), env, none))).toEqual(['uMgr']);
    // Nobody attested: BLOCKED, and G9 is never waived (not even in a later SINGLE_OPERATOR pass of ENFORCED).
    expect(resolveSlot(slot(ROLE('HR_MANAGER')), { ...env, counted: new Set(), eligible: new Map<string, AppRole>([['uHrU', 'HR_MANAGER']]) }, none)).toMatchObject({ blocked: true });
    // Without a pay effect (phase 2): nothing changes.
    expect(ids(resolveSlot(slot(ROLE('HR_MANAGER')), { ...env, payEffect: false }, none))).toEqual(['uHrA', 'uHrU']);
  });

  it('SINGLE_OPERATOR + pay effect: no refusal, but the act is recorded (UNATTESTED_APPROVER)', () => {
    const env: ResolveEnv = { ...solo(), eligible: new Map<string, AppRole>([['uHrU', 'HR_MANAGER']]), exclusions: { beneficiaryUserIds: new Set(), requesterUserId: null }, controlsMode: 'SINGLE_OPERATOR', payEffect: true, counted: new Set() };
    expect(ids(resolveSlot(slot(ROLE('HR_MANAGER')), env, none))).toEqual(['uHrU']);
    expect(unattestedInSingleOperator('uHrU', env, false)).toBe(true);
    expect(unattestedInSingleOperator('uHrU', env, true)).toBe(false);
    expect(unattestedInSingleOperator('uHrU', { ...env, payEffect: false }, false)).toBe(false);
    expect(selfActReasons(['G9_UNATTESTED'])).toEqual(['UNATTESTED_APPROVER']);
  });
});

describe('definition relaxations (§12.1 editor warnings)', () => {
  const s = (over: Partial<WorkflowDefinitionDoc['settings']> = {}) => ({ ...settings, rejectRequiresPair: false, rejectAuthority: ['HR_MANAGER'] as AppRole[], ...over });
  const hr = (id: string, extra: Partial<StageNode> = {}): WfNode => ({ type: 'stage', id, approver: { kind: 'ROLE', role: 'HR_MANAGER' }, ...extra });
  const doc = (root: WfNode, over: Partial<WorkflowDefinitionDoc['settings']> = {}): WorkflowDefinitionDoc => ({ schemaVersion: 1, settings: s(over), root });
  const codes = (prev: WorkflowDefinitionDoc | null, next: WorkflowDefinitionDoc) => definitionRelaxations(prev, next).map((w) => w.code);
  const two = doc({ type: 'sequence', id: 'r', children: [hr('a'), hr('b', { distinctFromPrior: true })] }, { rejectRequiresPair: true });

  it('minHumanStages: sequence sums, condition takes the lightest branch (no otherwise: 0), parallel ALL sums and ANY takes the lightest', () => {
    expect(minHumanStages(two.root)).toBe(2);
    expect(minHumanStages({ type: 'condition', id: 'c', branches: [{ when: { field: 'x', op: 'exists' }, node: hr('a') }] })).toBe(0);
    expect(minHumanStages({ type: 'parallel', id: 'p', join: 'ANY', branches: [hr('a'), { type: 'sequence', id: 's', children: [hr('b'), hr('c')] }] })).toBe(1);
    expect(minHumanStages({ type: 'parallel', id: 'p', join: 'ALL', branches: [hr('a'), { type: 'stage', id: 'm', approver: { kind: 'MANAGER_CHAIN', levels: 3 } }] })).toBe(4);
  });

  it('every loosened control is named; the same or a stricter version has no warning', () => {
    expect(codes(two, two)).toEqual([]);
    expect(codes(null, two)).toEqual([]);
    expect(codes(null, doc({ type: 'sequence', id: 'r', children: [] }))).toEqual(['AUTO_APPROVE_PATH']);
    expect(codes(two, doc({ type: 'sequence', id: 'r', children: [hr('a')] }, { rejectRequiresPair: true }))).toEqual(['FEWER_HUMAN_STAGES', 'DISTINCT_FROM_PRIOR_REMOVED']);
    expect(codes(two, doc(two.root, { rejectRequiresPair: false }))).toEqual(['REJECT_PAIR_REMOVED']);
    expect(codes(two, doc(two.root, { rejectRequiresPair: true, rejectAuthority: ['HR_MANAGER', 'EMPLOYEE'] }))).toEqual(['REJECT_AUTHORITY_WIDENED']);
    expect(codes(two, doc(two.root, { rejectRequiresPair: true, coverRole: 'LEGAL_ADMIN' }))).toEqual(['COVER_ROLE_CHANGED']);
    const all = doc({ type: 'parallel', id: 'p', join: 'ALL', branches: [hr('a'), hr('b')] });
    expect(codes(all, doc({ type: 'parallel', id: 'p', join: 'ANY', branches: [hr('a'), hr('b')] }))).toEqual(['FEWER_HUMAN_STAGES', 'PARALLEL_ALL_REMOVED']);
    expect(codes(two, doc({ type: 'condition', id: 'c', branches: [{ when: { field: 'x', op: 'exists' }, node: two.root }] }, { rejectRequiresPair: true }))).toEqual(['AUTO_APPROVE_PATH']);
    // Stricter: more stages, a pair added, fewer reject roles.
    expect(codes(doc(hr('a')), two)).toEqual([]);
    expect(definitionRelaxations(null, doc({ type: 'sequence', id: 'r', children: [] }))[0].message).toMatch(/آلياً/);
  });
});

describe('two-person activation (DEC-PO-146 / ADR-0011, INV-IAM-01)', () => {
  const draft = { createdById: 'uA', lastEditedById: 'uB' };

  it('the reasons: the creator and the last editor are authors (null last editor: the creator); a non-counted activator is no second person', () => {
    expect(activationSelfActReasons(draft, 'uC', true)).toEqual([]);
    expect(activationSelfActReasons(draft, 'uA', true)).toEqual(['AUTHOR_ACTIVATED']);
    expect(activationSelfActReasons(draft, 'uB', true)).toEqual(['AUTHOR_ACTIVATED']);
    expect(activationSelfActReasons({ createdById: 'uA', lastEditedById: null }, 'uA', true)).toEqual(['AUTHOR_ACTIVATED']);
    expect(activationSelfActReasons(draft, 'uC', false)).toEqual(['UNATTESTED_SECOND_PERSON']);
    expect(activationSelfActReasons(draft, 'uA', false)).toEqual(['AUTHOR_ACTIVATED', 'UNATTESTED_SECOND_PERSON']);
    // DEC-PO-147: an author on the activator's side (an account he created, or his attester), or an unattested
    // author, makes the activation the author's own even with distinct ids.
    expect(activationSelfActReasons(draft, 'uC', true, true)).toEqual(['AUTHOR_ACTIVATED']);
  });

  it('ENFORCED refuses any reason; SINGLE_OPERATOR accepts (recorded) unless another eligible editor could activate an author\'s draft', () => {
    expect(activationRefusal([], 'ENFORCED', 0)).toBeNull();
    expect(activationRefusal(['AUTHOR_ACTIVATED'], 'ENFORCED', 0)).toMatch(/ENFORCED/);
    expect(activationRefusal(['UNATTESTED_SECOND_PERSON'], 'ENFORCED', 0)).toMatch(/ENFORCED/);
    expect(activationRefusal(['AUTHOR_ACTIVATED', 'UNATTESTED_SECOND_PERSON'], 'SINGLE_OPERATOR', 0)).toBeNull();
    expect(activationRefusal(['AUTHOR_ACTIVATED'], 'SINGLE_OPERATOR', 1)).toMatch(/another eligible editor/);
    expect(activationRefusal(['UNATTESTED_SECOND_PERSON'], 'SINGLE_OPERATOR', 3)).toBeNull();
  });
});
