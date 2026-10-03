// Candidate resolution (wfe-to-be.md §12.4, §12.5; AUDIT/16 §3.1 resolve.ts), without the money rules (DEC-PO-139).
//
// DEC-PO-145, guardrails 1-3, are enforced HERE and nowhere else:
//   1. eligibility: the only source of candidates is iam.activeUsersWithRolesInCompany (active, not documents-only,
//      not a vendor account, role, company scope covering the instance company) minus the logins whose employee is
//      TERMINATED (BeneficiaryStatePort). An adapter's `guards` can only remove a candidate, never add one.
//   2. separation of duties: the beneficiaries' logins (G1) and the requester (G1b) are never candidates, and the
//      per-task exclusions (the first rejecter of a REJECT_PAIR, prior approvers of a distinctFromPrior stage, G2b
//      siblings of a parallel ALL, the canceller of a CANCEL_CONFIRM) are applied to the primary AND the cover.
//   3. self-approval at act time: checkActor re-runs every one of these checks on CURRENT data (gatherResolveInputs
//      is called again inside the act transaction, after the locks), so a role, scope, link or exit that changed
//      after the task was opened is seen.
//
// Package C (BL-WFE-003, wfe-to-be.md §12.1, §12.5 step 2; DEC-PO-144):
//   - the single-operator exception: when the strict resolution (stage, then cover) leaves a step with nobody, AND the
//     instance company reads SINGLE_OPERATOR now (platform.resolveOperatorMode, env.controlsMode), the step is resolved again
//     with the two-person exclusions waived (G1, G1b, G2b siblings, distinctFromPrior, the first rejecter, the
//     canceller). Never waived: eligibility (iam: active, not documents-only, not a vendor account, role, scope; not
//     separated) and the adapter's guards. Each such candidate carries the reasons it waives (`waived`); act time
//     re-checks the mode and that the strict resolution is still empty (task.ts), and records the act as
//     SELF_ACT_SINGLE_OPERATOR for the owner digest. ENFORCED (or no mode: fail closed) never waives anything.
//   - the G9 split (RT-WFE-701): on an instance with a pay effect, in ENFORCED, a role pick of a financial approver role
//     (not the direct manager of a MANAGER_CHAIN level) must be a login that counts toward ENFORCED (iam
//     countsTowardEnforced: attested, not a vendor account). Phase 2 has no pay effect (DEC-PO-139: the DB CHECK
//     hasPayEffect = false), so the hook is generic and tested on the pure resolver; it is not tied to money adapters.
//
// Delegation (guardrail 4): package B does not read ApprovalDelegation at all. No candidate is ever added through a
// delegation (via DELEGATE is reserved for package D, which must apply the delegator's and the delegate's exclusions).
import type { WorkflowTaskKind } from '@prisma/client';
import { ALL_ROLES, ROLE_GROUPS, type AppRole } from '@/lib/constants';
import { activeUsersWithRolesInCompany, isFinancialApproverRole } from '@/modules/iam';
import type { OperatorMode, TxClient } from '@/modules/platform';
import type { CandidateGuard, InstanceView, StageView } from './adapters';
import type { DefinitionSettings, WfNode } from './definition';
import type { StageSlot } from './engine';
import { requirePort } from './ports';

export type CandidateVia = 'STAGE' | 'COVER' | 'OWNER_COVER' | 'DELEGATE';

export interface CandidateEntry {
  userId: string;
  via: CandidateVia;
  /** The roles that made the user a candidate (re-checked live at act time). */
  roles: AppRole[];
  reason?: string;
  onBehalfOf?: string;
  /** The single-operator exception (§12.5 step 2): the two-person exclusions this candidate waives. */
  waived?: ExclusionReason[];
}

export type CoverReason = 'APPROVER_UNAVAILABLE' | 'NO_MANAGER' | 'MANAGER_ON_LEAVE' | 'DEADLINE';

export interface ChainEntry {
  level: number;
  employeeId: string | null;
  userId: string | null;
  reason?: 'NO_MANAGER' | 'LOOP';
  /** The employee the chain starts from (the primary beneficiary at start), kept to rebuild the chain live. */
  anchor?: string | null;
}

export interface Resolution {
  candidates: CandidateEntry[];
  coverReason: CoverReason | null;
  blocked: boolean;
}

/** Exclusions that hold for every task of the instance (G1, G1b). */
export interface InstanceExclusions {
  beneficiaryUserIds: ReadonlySet<string>;
  requesterUserId: string | null;
}

export interface ResolveEnv {
  /** Eligible logins of the instance company, live (iam), not separated: userId → role. */
  eligible: ReadonlyMap<string, AppRole>;
  exclusions: InstanceExclusions;
  guards: readonly CandidateGuard[];
  instance: InstanceView;
  settings: DefinitionSettings;
  chain: readonly ChainEntry[];
  /** Employees unavailable (on leave) today. */
  unavailableEmployees: ReadonlySet<string>;
  /** The controls mode of the instance company, read now (DEC-PO-144). Absent: ENFORCED (fail closed). */
  controlsMode?: OperatorMode;
  /** The instance has a pay effect (phase 2: never, DB CHECK). Turns on the G9 attestation split. */
  payEffect?: boolean;
  /** Logins that count toward ENFORCED (iam countsTowardEnforced); read when payEffect. Absent: nobody counts. */
  counted?: ReadonlySet<string>;
  /** Internal: the §12.5 step-2 pass of the single-operator exception (waivable exclusions admitted). */
  relaxed?: boolean;
}

export const MANAGER_ROLES: readonly AppRole[] = ROLE_GROUPS.MANAGERS;
export const OWNER_ROLES: readonly AppRole[] = ROLE_GROUPS.OWNER;

export type ExclusionReason =
  | 'G1_BENEFICIARY'
  | 'G1B_REQUESTER'
  | 'FIRST_REJECTER'
  | 'PRIOR_APPROVER'
  | 'G2B_SIBLING'
  | 'CANCELLER'
  | 'G9_UNATTESTED'
  | `GUARD:${string}`;

/**
 * The two-person exclusions the single-operator exception may waive (§12.1 G1, G1b, G2b "بنفس الاستثناء"). Not here,
 * so never waived: the adapter's guards and G9 (eligibility, and attestation in ENFORCED).
 */
export const SINGLE_OPERATOR_WAIVABLE: ReadonlySet<ExclusionReason> = new Set<ExclusionReason>(['G1_BENEFICIARY', 'G1B_REQUESTER', 'G2B_SIBLING', 'PRIOR_APPROVER', 'FIRST_REJECTER', 'CANCELLER']);

export function isWaivable(reason: ExclusionReason | 'NOT_ELIGIBLE'): boolean {
  return reason !== 'NOT_ELIGIBLE' && SINGLE_OPERATOR_WAIVABLE.has(reason);
}

function modeOf(env: Pick<ResolveEnv, 'controlsMode'>): OperatorMode {
  return env.controlsMode === 'SINGLE_OPERATOR' ? 'SINGLE_OPERATOR' : 'ENFORCED';
}

/**
 * G9 split (RT-WFE-701): attestation is required of `role` on this pick only on an instance with a pay effect, in
 * ENFORCED, for a financial approver role (HR, PAYROLL, FINANCE or OWNER group), and never for the direct manager of a
 * MANAGER_CHAIN level (RT-WFE-801). `wouldIn` asks the same question for another mode (the SINGLE_OPERATOR record).
 */
export function attestationRequired(env: Pick<ResolveEnv, 'payEffect' | 'controlsMode'>, role: AppRole | undefined, managerLevel: boolean, wouldIn?: OperatorMode): boolean {
  const mode = wouldIn ?? modeOf(env);
  return env.payEffect === true && mode === 'ENFORCED' && !managerLevel && !!role && isFinancialApproverRole(role);
}

/**
 * Every reason `userId` may not act on this step (empty: none), in a fixed order: G1, G1b, the per-step exclusion, the
 * first guard that refuses (anything but exactly { ok: true } excludes, fail closed), G9 attestation.
 */
export function exclusionsOf(userId: string, env: ResolveEnv, stage: StageView, extra: ReadonlyMap<string, ExclusionReason>, managerLevel = false): ExclusionReason[] {
  const out: ExclusionReason[] = [];
  if (env.exclusions.beneficiaryUserIds.has(userId)) out.push('G1_BENEFICIARY');
  if (env.exclusions.requesterUserId && env.exclusions.requesterUserId === userId) out.push('G1B_REQUESTER');
  const x = extra.get(userId);
  if (x) out.push(x);
  for (const g of env.guards) {
    const r = g({ userId, instance: env.instance, stage });
    if (!(r && (r as { ok?: unknown }).ok === true && Object.keys(r).length === 1)) {
      out.push(`GUARD:${(r as { reason?: unknown })?.reason ? String((r as { reason?: unknown }).reason) : 'refused'}`);
      break;
    }
  }
  if (attestationRequired(env, env.eligible.get(userId), managerLevel) && !env.counted?.has(userId)) out.push('G9_UNATTESTED');
  return out;
}

/** Why `userId` may not act on this step (the first reason), or null. */
export function exclusionOf(userId: string, env: ResolveEnv, stage: StageView, extra: ReadonlyMap<string, ExclusionReason>, managerLevel = false): ExclusionReason | null {
  return exclusionsOf(userId, env, stage, extra, managerLevel)[0] ?? null;
}

/** Eligible logins holding one of `roles` (ascending id). */
export function pool(env: ResolveEnv, roles: readonly AppRole[]): string[] {
  return [...env.eligible.entries()].filter(([, r]) => roles.includes(r)).map(([id]) => id).sort();
}

function pick(
  env: ResolveEnv,
  ids: readonly string[],
  via: CandidateVia,
  roles: readonly AppRole[],
  stage: StageView,
  extra: ReadonlyMap<string, ExclusionReason>,
  reason?: string,
  managerLevel = false,
): CandidateEntry[] {
  const out: CandidateEntry[] = [];
  for (const userId of ids) {
    const role = env.eligible.get(userId);
    if (!role || !roles.includes(role)) continue;
    const xs = exclusionsOf(userId, env, stage, extra, managerLevel);
    const entry: CandidateEntry = { userId, via, roles: [...roles], ...(reason ? { reason } : {}) };
    if (!xs.length) out.push(entry);
    else if (env.relaxed && xs.every((x) => SINGLE_OPERATOR_WAIVABLE.has(x))) out.push({ ...entry, waived: xs });
  }
  return out;
}

/**
 * §12.5 step 2: the strict resolution left the step with nobody; in SINGLE_OPERATOR (read now) the step is resolved
 * again with the two-person exclusions waived. ENFORCED, or nobody even then: the strict result (BLOCKED).
 */
function withSingleOperatorException(env: ResolveEnv, run: (e: ResolveEnv) => Resolution): Resolution {
  const strict = run({ ...env, relaxed: false });
  if (!strict.blocked || modeOf(env) !== 'SINGLE_OPERATOR') return strict;
  const relaxed = run({ ...env, relaxed: true });
  return relaxed.candidates.length ? { ...relaxed, blocked: false } : strict;
}

/** §12.5 step 1: coverRole, then the owner group. Still nobody: BLOCKED (the callers apply step 2). */
export function cover(env: ResolveEnv, stage: StageView, extra: ReadonlyMap<string, ExclusionReason>, reason: CoverReason): Resolution {
  if (env.settings.coverRole) {
    const c = pick(env, pool(env, [env.settings.coverRole]), 'COVER', [env.settings.coverRole], stage, extra, reason);
    if (c.length) return { candidates: c, coverReason: reason, blocked: false };
  }
  const o = pick(env, pool(env, OWNER_ROLES), 'OWNER_COVER', OWNER_ROLES, stage, extra, reason);
  return { candidates: o, coverReason: reason, blocked: o.length === 0 };
}

/** An APPROVE slot (a ROLE stage, or one MANAGER_CHAIN level), with the single-operator exception (§12.5 step 2). */
export function resolveSlot(slot: StageSlot, env: ResolveEnv, extra: ReadonlyMap<string, ExclusionReason>): Resolution {
  return withSingleOperatorException(env, (e) => resolveSlotOnce(slot, e, extra));
}

function resolveSlotOnce(slot: StageSlot, env: ResolveEnv, extra: ReadonlyMap<string, ExclusionReason>): Resolution {
  const stage: StageView = { nodeId: slot.nodeId, kind: 'APPROVE', stageId: slot.stage.id };
  const a = slot.stage.approver;
  if (a.kind === 'ROLE') {
    const c = pick(env, pool(env, [a.role]), 'STAGE', [a.role], stage, extra);
    return c.length ? { candidates: c, coverReason: null, blocked: false } : cover(env, stage, extra, 'APPROVER_UNAVAILABLE');
  }
  const entry = env.chain.find((e) => e.level === slot.level);
  if (!entry || !entry.employeeId) return cover(env, stage, extra, 'NO_MANAGER');
  if (!entry.userId) return cover(env, stage, extra, 'APPROVER_UNAVAILABLE');
  if (env.unavailableEmployees.has(entry.employeeId)) return cover(env, stage, extra, 'MANAGER_ON_LEAVE');
  const c = pick(env, [entry.userId], 'STAGE', MANAGER_ROLES, stage, extra, undefined, true);
  return c.length ? { candidates: c, coverReason: null, blocked: false } : cover(env, stage, extra, 'APPROVER_UNAVAILABLE');
}

/**
 * A special task: REJECT_PAIR and REQUIREMENT_CHECK from rejectAuthority, CANCEL_CONFIRM from the current stage(s);
 * with the single-operator exception (§12.5 step 2; §12.8 "REJECT_PAIR بلا مرشح: استثناء G1"). REQUIREMENT_CHECK is
 * never BLOCKED, so it never takes the exception.
 */
export function resolveSpecial(
  kind: Exclude<WorkflowTaskKind, 'APPROVE'>,
  nodeId: string,
  env: ResolveEnv,
  extra: ReadonlyMap<string, ExclusionReason>,
  stageCandidates: readonly CandidateEntry[] = [],
): Resolution {
  return withSingleOperatorException(env, (e) => resolveSpecialOnce(kind, nodeId, e, extra, stageCandidates));
}

function resolveSpecialOnce(
  kind: Exclude<WorkflowTaskKind, 'APPROVE'>,
  nodeId: string,
  env: ResolveEnv,
  extra: ReadonlyMap<string, ExclusionReason>,
  stageCandidates: readonly CandidateEntry[],
): Resolution {
  const stage: StageView = { nodeId, kind, stageId: null };
  if (kind === 'CANCEL_CONFIRM') {
    const seen = new Set<string>();
    const out: CandidateEntry[] = [];
    for (const e of stageCandidates) {
      if (seen.has(e.userId)) continue;
      seen.add(e.userId);
      // A direct manager carried over from a MANAGER_CHAIN level keeps his G9 standing (no attestation, RT-WFE-801).
      out.push(...pick(env, [e.userId], e.via, e.roles, stage, extra, undefined, e.via === 'STAGE' && e.roles.join() === MANAGER_ROLES.join()));
    }
    return out.length ? { candidates: out, coverReason: null, blocked: false } : cover(env, stage, extra, 'APPROVER_UNAVAILABLE');
  }
  const roles = env.settings.rejectAuthority;
  const c = roles.length ? pick(env, pool(env, roles), 'STAGE', roles, stage, extra) : [];
  if (kind === 'REQUIREMENT_CHECK') return { candidates: c, coverReason: null, blocked: false };
  return c.length ? { candidates: c, coverReason: null, blocked: false } : cover(env, stage, extra, 'APPROVER_UNAVAILABLE');
}

/**
 * Act-time check (guardrail 3): may `userId` act on a step for which he was resolved as `entry`? His login must still be
 * eligible with one of the entry's roles (live iam), not separated, and not excluded on current data.
 */
export function checkActor(
  userId: string,
  entryRoles: readonly AppRole[],
  env: ResolveEnv,
  stage: StageView,
  extra: ReadonlyMap<string, ExclusionReason>,
  managerLevel = false,
): { ok: true } | { ok: false; reason: ExclusionReason | 'NOT_ELIGIBLE' } {
  const role = env.eligible.get(userId);
  if (!role || !entryRoles.includes(role)) return { ok: false, reason: 'NOT_ELIGIBLE' };
  const x = exclusionOf(userId, env, stage, extra, managerLevel);
  return x ? { ok: false, reason: x } : { ok: true };
}

/**
 * Act time, after a strict refusal for a waivable reason: the reasons the single-operator exception waives for
 * `userId`, or null (refuse). `live` is the step resolved again on CURRENT data (resolveSlot / resolveSpecial take the
 * exception only when the strict resolution is empty), so the waiver holds only while the company reads
 * SINGLE_OPERATOR now AND nobody else can do the step now.
 */
export function singleOperatorWaiver(userId: string, live: Resolution, env: Pick<ResolveEnv, 'controlsMode'>): ExclusionReason[] | null {
  if (modeOf(env) !== 'SINGLE_OPERATOR') return null;
  const e = live.candidates.find((c) => c.userId === userId);
  return e?.waived?.length && e.waived.every((w) => SINGLE_OPERATOR_WAIVABLE.has(w)) ? [...e.waived] : null;
}

/**
 * The owner-digest reasons of a decision taken alone (platform SELF_ACT reasons; the money gateway's names where one
 * fits): G1 → SELF_BENEFICIARY, G1b → SAME_PERSON_TWICE (the requester approves), the other two-person exclusions →
 * ONE_PERSON_TWO_STEPS, G9 in SINGLE_OPERATOR → UNATTESTED_APPROVER.
 */
export function selfActReasons(waived: readonly ExclusionReason[]): string[] {
  const out = new Set<string>();
  for (const w of waived) {
    if (w === 'G1_BENEFICIARY') out.add('SELF_BENEFICIARY');
    else if (w === 'G1B_REQUESTER') out.add('SAME_PERSON_TWICE');
    else if (w === 'G9_UNATTESTED') out.add('UNATTESTED_APPROVER');
    else out.add('ONE_PERSON_TWO_STEPS');
  }
  return [...out];
}

/**
 * G9 in SINGLE_OPERATOR (RT-WFE-701): attestation is not required, but an act that ENFORCED would refuse for it is
 * recorded (G9_UNATTESTED joins the SELF_ACT record). Pay-effect instances only (phase 2: never).
 */
export function unattestedInSingleOperator(userId: string, env: ResolveEnv, managerLevel: boolean): boolean {
  return modeOf(env) === 'SINGLE_OPERATOR' && attestationRequired(env, env.eligible.get(userId), managerLevel, 'ENFORCED') && !env.counted?.has(userId);
}

// ---------------------------------------------------------------------------------------------------
// Reads (ports and iam), inside the caller's transaction

/** Live eligibility of the instance company: iam (G9 general) minus the logins whose employee is TERMINATED. */
export async function eligibleInCompany(tx: TxClient, companyId: string, asOf: Date): Promise<Map<string, AppRole>> {
  const users = await activeUsersWithRolesInCompany(tx, ALL_ROLES, companyId);
  if (!users.length) return new Map();
  const states = await requirePort('BeneficiaryState').employeesOfUsers(
    tx,
    users.map((u) => u.id),
    asOf,
  );
  const separated = new Set(states.filter((s) => s.employmentState === 'TERMINATED' && s.userId).map((s) => s.userId as string));
  return new Map(users.filter((u) => !separated.has(u.id)).map((u) => [u.id, u.role]));
}

/** The logins of the beneficiaries (G1), read now (a login linked after the task was opened counts). */
export async function beneficiaryUserIds(tx: TxClient, beneficiaryEmployeeIds: readonly string[], asOf: Date): Promise<Set<string>> {
  if (!beneficiaryEmployeeIds.length) return new Set();
  const rows = await requirePort('BeneficiaryState').employees(tx, beneficiaryEmployeeIds, asOf);
  return new Set(rows.map((r) => r.userId).filter((x): x is string => !!x));
}

/** MANAGER_CHAIN snapshot (up to `levels`): a missing manager or a loop ends the chain (X-WFE-004 → NO_MANAGER). */
export async function buildManagerChain(tx: TxClient, anchorEmployeeId: string | null, levels: number, asOf: Date): Promise<ChainEntry[]> {
  const out: ChainEntry[] = [];
  if (levels <= 0) return out;
  const port = requirePort('ManagerChain');
  const seen = new Set<string>(anchorEmployeeId ? [anchorEmployeeId] : []);
  let cur = anchorEmployeeId;
  let ended: 'NO_MANAGER' | 'LOOP' | null = anchorEmployeeId ? null : 'NO_MANAGER';
  for (let level = 1; level <= levels; level++) {
    if (ended || !cur) {
      out.push({ level, employeeId: null, userId: null, reason: ended ?? 'NO_MANAGER' });
      ended = ended ?? 'NO_MANAGER';
      continue;
    }
    const m = await port.managerOf(tx, cur, asOf);
    if (!m) {
      ended = 'NO_MANAGER';
      out.push({ level, employeeId: null, userId: null, reason: 'NO_MANAGER' });
      continue;
    }
    if (seen.has(m)) {
      ended = 'LOOP';
      out.push({ level, employeeId: null, userId: null, reason: 'LOOP' });
      continue;
    }
    seen.add(m);
    out.push({ level, employeeId: m, userId: null });
    cur = m;
  }
  const ids = out.map((e) => e.employeeId).filter((x): x is string => !!x);
  if (ids.length) {
    const rows = await requirePort('BeneficiaryState').employees(tx, ids, asOf);
    const byId = new Map(rows.map((r) => [r.employeeId, r]));
    for (const e of out) {
      if (!e.employeeId) continue;
      const r = byId.get(e.employeeId);
      // A TERMINATED manager is no approver: the level goes to cover as APPROVER_UNAVAILABLE.
      e.userId = r && r.employmentState !== 'TERMINATED' ? r.userId : null;
    }
  }
  for (const e of out) e.anchor = anchorEmployeeId;
  return out;
}

export function maxChainLevels(n: WfNode): number {
  switch (n.type) {
    case 'stage':
      return n.approver.kind === 'MANAGER_CHAIN' ? n.approver.levels : 0;
    case 'sequence':
      return Math.max(0, ...n.children.map(maxChainLevels));
    case 'condition':
      return Math.max(0, ...n.branches.map((b) => maxChainLevels(b.node)), n.otherwise ? maxChainLevels(n.otherwise) : 0);
    case 'parallel':
      return Math.max(0, ...n.branches.map(maxChainLevels));
  }
}

export function parseChain(json: unknown): ChainEntry[] {
  return Array.isArray(json) ? (json as ChainEntry[]).filter((e) => e && typeof e.level === 'number') : [];
}

export function parseCandidates(json: unknown): CandidateEntry[] {
  return Array.isArray(json) ? (json as CandidateEntry[]).filter((e) => e && typeof e.userId === 'string' && Array.isArray(e.roles)) : [];
}
