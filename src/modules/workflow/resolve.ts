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
// Strict G1 / G1b everywhere: the single-operator exception is package C (WFE-003), not here.
//
// Delegation (guardrail 4): package B does not read ApprovalDelegation at all. No candidate is ever added through a
// delegation (via DELEGATE is reserved for package D, which must apply the delegator's and the delegate's exclusions).
import type { WorkflowTaskKind } from '@prisma/client';
import { ALL_ROLES, ROLE_GROUPS, type AppRole } from '@/lib/constants';
import { activeUsersWithRolesInCompany } from '@/modules/iam';
import type { TxClient } from '@/modules/platform';
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
}

export const MANAGER_ROLES: readonly AppRole[] = ROLE_GROUPS.MANAGERS;
export const OWNER_ROLES: readonly AppRole[] = ROLE_GROUPS.OWNER;

export type ExclusionReason = 'G1_BENEFICIARY' | 'G1B_REQUESTER' | 'FIRST_REJECTER' | 'PRIOR_APPROVER' | 'G2B_SIBLING' | 'CANCELLER' | `GUARD:${string}`;

/** Why `userId` may not act on this step, or null. Guards: anything but exactly { ok: true } excludes (fail closed). */
export function exclusionOf(userId: string, env: ResolveEnv, stage: StageView, extra: ReadonlyMap<string, ExclusionReason>): ExclusionReason | null {
  if (env.exclusions.beneficiaryUserIds.has(userId)) return 'G1_BENEFICIARY';
  if (env.exclusions.requesterUserId && env.exclusions.requesterUserId === userId) return 'G1B_REQUESTER';
  const x = extra.get(userId);
  if (x) return x;
  for (const g of env.guards) {
    const r = g({ userId, instance: env.instance, stage });
    if (!(r && (r as { ok?: unknown }).ok === true && Object.keys(r).length === 1)) {
      return `GUARD:${(r as { reason?: unknown })?.reason ? String((r as { reason?: unknown }).reason) : 'refused'}`;
    }
  }
  return null;
}

/** Eligible logins holding one of `roles` (ascending id). */
export function pool(env: ResolveEnv, roles: readonly AppRole[]): string[] {
  return [...env.eligible.entries()].filter(([, r]) => roles.includes(r)).map(([id]) => id).sort();
}

function pick(env: ResolveEnv, ids: readonly string[], via: CandidateVia, roles: readonly AppRole[], stage: StageView, extra: ReadonlyMap<string, ExclusionReason>, reason?: string): CandidateEntry[] {
  return ids
    .filter((id) => {
      const role = env.eligible.get(id);
      return !!role && roles.includes(role) && !exclusionOf(id, env, stage, extra);
    })
    .map((userId) => ({ userId, via, roles: [...roles], ...(reason ? { reason } : {}) }));
}

/** §12.5 step 1: coverRole, then the owner group. Still nobody: BLOCKED (no G1 exception in package B). */
export function cover(env: ResolveEnv, stage: StageView, extra: ReadonlyMap<string, ExclusionReason>, reason: CoverReason): Resolution {
  if (env.settings.coverRole) {
    const c = pick(env, pool(env, [env.settings.coverRole]), 'COVER', [env.settings.coverRole], stage, extra, reason);
    if (c.length) return { candidates: c, coverReason: reason, blocked: false };
  }
  const o = pick(env, pool(env, OWNER_ROLES), 'OWNER_COVER', OWNER_ROLES, stage, extra, reason);
  return { candidates: o, coverReason: reason, blocked: o.length === 0 };
}

/** An APPROVE slot (a ROLE stage, or one MANAGER_CHAIN level). */
export function resolveSlot(slot: StageSlot, env: ResolveEnv, extra: ReadonlyMap<string, ExclusionReason>): Resolution {
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
  const c = pick(env, [entry.userId], 'STAGE', MANAGER_ROLES, stage, extra);
  return c.length ? { candidates: c, coverReason: null, blocked: false } : cover(env, stage, extra, 'APPROVER_UNAVAILABLE');
}

/** A special task: REJECT_PAIR and REQUIREMENT_CHECK from rejectAuthority, CANCEL_CONFIRM from the current stage(s). */
export function resolveSpecial(
  kind: Exclude<WorkflowTaskKind, 'APPROVE'>,
  nodeId: string,
  env: ResolveEnv,
  extra: ReadonlyMap<string, ExclusionReason>,
  stageCandidates: readonly CandidateEntry[] = [],
): Resolution {
  const stage: StageView = { nodeId, kind, stageId: null };
  if (kind === 'CANCEL_CONFIRM') {
    const seen = new Set<string>();
    const out: CandidateEntry[] = [];
    for (const e of stageCandidates) {
      if (seen.has(e.userId)) continue;
      seen.add(e.userId);
      out.push(...pick(env, [e.userId], e.via, e.roles, stage, extra));
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
export function checkActor(userId: string, entryRoles: readonly AppRole[], env: ResolveEnv, stage: StageView, extra: ReadonlyMap<string, ExclusionReason>): { ok: true } | { ok: false; reason: ExclusionReason | 'NOT_ELIGIBLE' } {
  const role = env.eligible.get(userId);
  if (!role || !entryRoles.includes(role)) return { ok: false, reason: 'NOT_ELIGIBLE' };
  const x = exclusionOf(userId, env, stage, extra);
  return x ? { ok: false, reason: x } : { ok: true };
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
