// The computed controlsMode, PER LEGAL COMPANY (BL-PAY-021; pay-to-be.md BR-PAY-020 "حساب الوضع", DEC-PO-018 /
// 021; RT-PAY-710, RT-PAY-1206 / 1303; ADR-0009 and DEC-PO-144). It is never set: it is read from the identity
// facts every time it is needed.
//
//   not ready        a company Radeef has not marked ready (ControlsReadiness, vendor only) is ENFORCED whatever
//                    its count (the owner's rollout "after each company is ready"); every company starts so.
//   ENFORCED         a ready company with at least two counted approvers who can act in it;
//   SINGLE_OPERATOR  a ready company with fewer.
//
// A counted approver (countsTowardEnforced: active, not a vendor account, not in the documents-only window of an
// exit, ATTESTED or the acting TENANT_ROOT; the root counts, RT-PAY-710) can act in a company when his company
// scope includes it: an owner role, or no UserCompanyScope row, is every company (iam actorCompanies).
//
// The resolver reads only protected identity columns, the scope rows and the readiness mark (all iam, all written
// through iam's gateway operations), so no tenant user can move it except by the two-person identity acts
// (DEC-PO-021) and the two-person exit of a counted approver (lifecycle assertFinancialApproverExit, which reads
// approverExitEffect below). No company setting overrides it.
//
// A change of a company's mode is OBSERVED and recorded by recordControlsMode (an audit row and the event
// iam.controls.modeChanged, aggregate ControlsMode/<companyId>), after every identity transaction (run.ts) and by
// the daily owner-digest job. Nothing reads that record to decide anything.
import type { Prisma, PrismaClient } from '@prisma/client';
import { ROLE_GROUPS, roleIn } from '@/lib/constants';
import { audit, emitEvent, latestEventOf, registerOperatorModeResolver, type OperatorMode, type RootClient } from '@/modules/platform';
import { FINANCIAL_APPROVER_ROLES, IDENTITY_SELECT, countsTowardEnforced, identityOf, type IdentityUser } from './identity';

type Db = PrismaClient | Prisma.TransactionClient;

export const CONTROLS_MODE_CHANGED_EVENT = 'iam.controls.modeChanged';
/** The aggregate type of the mode record; the aggregate id is the company. */
export const CONTROLS_AGGREGATE_TYPE = 'ControlsMode';
/** Two counted approvers make ENFORCED (BR-PAY-020). Architecture of the control, not a setting. */
export const ENFORCED_MIN_APPROVERS = 2;
export const READINESS_BASES = ['ATTESTED', 'ONE_PERSON'] as const;
export type ReadinessBasis = (typeof READINESS_BASES)[number];

/** The mode of a ready company with this number of counted approvers (pure). */
export function controlsModeFor(countedApprovers: number): OperatorMode {
  return Number.isInteger(countedApprovers) && countedApprovers >= ENFORCED_MIN_APPROVERS ? 'ENFORCED' : 'SINGLE_OPERATOR';
}

/** Every account that counts toward ENFORCED somewhere (oldest first). */
export async function controlsApprovers(db: Db): Promise<IdentityUser[]> {
  const rows = await db.user.findMany({
    where: {
      isActive: true,
      isVendorStaff: false,
      role: { in: [...FINANCIAL_APPROVER_ROLES] },
      OR: [{ identityStatus: 'ATTESTED' }, { tenantRoot: true, rootSuspendedAt: null }],
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: IDENTITY_SELECT,
  });
  // The query narrows; the rule itself is countsTowardEnforced (the same function every identity check uses).
  return rows.filter(countsTowardEnforced);
}

/** 'ALL' or the companies a user can act in (an owner role or no scope row: every company, iam actorCompanies). */
export type ApproverScope = 'ALL' | ReadonlySet<string>;

export async function approverScopes(db: Db, users: readonly Pick<IdentityUser, 'id' | 'role'>[]): Promise<Map<string, ApproverScope>> {
  const out = new Map<string, ApproverScope>();
  if (!users.length) return out;
  const rows = await db.userCompanyScope.findMany({ where: { userId: { in: users.map((u) => u.id) } }, select: { userId: true, companyId: true } });
  for (const u of users) {
    const mine = rows.filter((r) => r.userId === u.id).map((r) => r.companyId);
    out.set(u.id, roleIn(u.role, ROLE_GROUPS.OWNER) || !mine.length ? 'ALL' : new Set(mine));
  }
  return out;
}

export function actsIn(scope: ApproverScope | undefined, companyId: string): boolean {
  return scope === 'ALL' || (!!scope && scope.has(companyId));
}

/** The counted approvers who can act in `companyId`. */
export async function countedApproversIn(db: Db, companyId: string): Promise<IdentityUser[]> {
  const approvers = await controlsApprovers(db);
  const scopes = await approverScopes(db, approvers);
  return approvers.filter((u) => actsIn(scopes.get(u.id), companyId));
}

export interface Readiness {
  id: string;
  companyId: string;
  basis: string;
  requestRef: string;
  markedBy: string;
  markedAt: Date;
}

const READINESS_SELECT = { id: true, companyId: true, basis: true, requestRef: true, markedBy: true, markedAt: true } as const;

/** Radeef's open readiness mark of a company (null: not ready, ENFORCED). */
export async function readinessOf(db: Db, companyId: string): Promise<Readiness | null> {
  return db.controlsReadiness.findFirst({ where: { companyId, revokedAt: null }, select: READINESS_SELECT });
}

/** Every company Radeef has marked ready (open marks). */
export async function readyCompanies(db: Db): Promise<Readiness[]> {
  return db.controlsReadiness.findMany({ where: { revokedAt: null }, orderBy: [{ markedAt: 'asc' }, { id: 'asc' }], select: READINESS_SELECT });
}

/** THE controls mode of a company (registered as platform's resolver; read in the caller's transaction). */
export async function readControlsMode(db: Db, companyId: string): Promise<OperatorMode> {
  if (!companyId) return 'ENFORCED';
  if (!(await readinessOf(db, companyId))) return 'ENFORCED';
  return controlsModeFor((await countedApproversIn(db, companyId)).length);
}

export interface CompanyControls {
  companyId: string;
  ready: boolean;
  basis: string | null;
  approvers: number;
  mode: OperatorMode;
}

/** The mode of each of these companies (one read of the approvers and scopes for all). */
export async function controlsOfCompanies(db: Db, companyIds: readonly string[]): Promise<CompanyControls[]> {
  const ids = [...new Set(companyIds.filter(Boolean))];
  if (!ids.length) return [];
  const [approvers, marks] = await Promise.all([controlsApprovers(db), db.controlsReadiness.findMany({ where: { companyId: { in: ids }, revokedAt: null }, select: { companyId: true, basis: true } })]);
  const scopes = await approverScopes(db, approvers);
  return ids.map((companyId) => {
    const mark = marks.find((m) => m.companyId === companyId);
    const n = approvers.filter((u) => actsIn(scopes.get(u.id), companyId)).length;
    return { companyId, ready: !!mark, basis: mark?.basis ?? null, approvers: n, mode: mark ? controlsModeFor(n) : 'ENFORCED' };
  });
}

let registeredHere = false;
/** Registers readControlsMode as platform's controls-mode resolver (idempotent; iam's index calls it on load). */
export function registerControlsModeResolver(): void {
  if (registeredHere) return;
  registerOperatorModeResolver('iam', readControlsMode);
  registeredHere = true;
}

// ---------------------------------------------------------------------------------------------------
// The exit of a counted approver (DEC-PO-021 / 039; the read port of lifecycle's assertFinancialApproverExit)
// ---------------------------------------------------------------------------------------------------

export interface ApproverExitEffect {
  /** The subject's login counts toward ENFORCED. */
  counts: boolean;
  /** The companies (of `companyIds`) the subject acts in where fewer than two counted approvers would remain. */
  companiesBelowTwo: string[];
}

/**
 * What ending `subjectUserId`'s login does to the count of each company in `companyIds` (the caller lists the
 * tenant's companies; iam does not read Company). Readiness is ignored on purpose (fail closed: a company marked
 * ready later must not find its second approver already gone without a second person).
 */
export async function approverExitEffect(db: Db, subjectUserId: string | null | undefined, companyIds: readonly string[]): Promise<ApproverExitEffect> {
  if (!subjectUserId) return { counts: false, companiesBelowTwo: [] };
  const approvers = await controlsApprovers(db);
  const subject = approvers.find((u) => u.id === subjectUserId);
  if (!subject) return { counts: false, companiesBelowTwo: [] };
  const scopes = await approverScopes(db, approvers);
  const below = [...new Set(companyIds)].filter((c) => {
    if (!actsIn(scopes.get(subject.id), c)) return false;
    const others = approvers.filter((u) => u.id !== subject.id && actsIn(scopes.get(u.id), c));
    return others.length < ENFORCED_MIN_APPROVERS;
  });
  return { counts: true, companiesBelowTwo: below };
}

/** The account counts toward ENFORCED (a second person for a counted approver's exit must). */
export async function isCountedApprover(db: Db, userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const u = await identityOf(db, userId);
  return !!u && countsTowardEnforced(u);
}

// ---------------------------------------------------------------------------------------------------
// The record of mode changes
// ---------------------------------------------------------------------------------------------------

export interface ControlsModeChange {
  companyId: string;
  mode: OperatorMode;
  approvers: number;
  /** The mode last recorded for the company before this call (null: never recorded). */
  previous: OperatorMode | null;
  /** This call recorded the change (audit row + event). */
  changed: boolean;
}

export interface ControlsModeRecord {
  /** One entry per company checked (every company with a readiness mark, open or revoked). */
  companies: ControlsModeChange[];
  /** The companies whose change this call recorded. */
  changed: string[];
}

function modeOfPayload(payload: Prisma.JsonValue | undefined): OperatorMode | null {
  const to = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>).to : null;
  return to === 'ENFORCED' || to === 'SINGLE_OPERATOR' ? to : null;
}

/** The mode last recorded for a company (null: never). */
export async function lastRecordedControlsMode(db: Db, companyId: string): Promise<{ mode: OperatorMode | null; seq: bigint | null; at: Date | null }> {
  const last = await latestEventOf(db, { aggregateType: CONTROLS_AGGREGATE_TYPE, aggregateId: companyId, type: CONTROLS_MODE_CHANGED_EVENT });
  return { mode: modeOfPayload(last?.payload), seq: last?.seq ?? null, at: last?.occurredAt ?? null };
}

/**
 * Records, for every company Radeef ever marked (open or revoked), its current mode when it differs from the last
 * recorded one: AuditRecord `iam.controls.modeChanged` and the event of the same name ({ companyId, from, to,
 * approvers, trigger }), in one transaction. A company never marked is ENFORCED and has nothing to record.
 * Idempotent and safe under concurrency: the event key is chained on the company's previous record
 * (`…:<companyId>:after:<seq>`), so two concurrent recorders of the same change write one event and one audit row.
 * `trigger` names what prompted the check; it carries no personal data.
 */
export async function recordControlsMode(prisma: RootClient, trigger: string): Promise<ControlsModeRecord> {
  const why = String(trigger ?? '').slice(0, 120) || 'unknown';
  return prisma.$transaction(async (tx) => {
    const marked = await tx.controlsReadiness.findMany({ distinct: ['companyId'], select: { companyId: true }, orderBy: { companyId: 'asc' } });
    const states = await controlsOfCompanies(tx, marked.map((m) => m.companyId));
    const companies: ControlsModeChange[] = [];
    for (const st of states) {
      const last = await lastRecordedControlsMode(tx, st.companyId);
      if (last.mode === st.mode || (last.mode === null && st.mode === 'ENFORCED' && !st.ready)) {
        companies.push({ companyId: st.companyId, mode: st.mode, approvers: st.approvers, previous: last.mode, changed: false });
        continue;
      }
      const key = `${CONTROLS_MODE_CHANGED_EVENT}:${st.companyId}:after:${last.seq ?? 0}`;
      const { created } = await emitEvent(tx, {
        type: CONTROLS_MODE_CHANGED_EVENT,
        aggregateType: CONTROLS_AGGREGATE_TYPE,
        aggregateId: st.companyId,
        idempotencyKey: key,
        companyId: st.companyId,
        payload: { companyId: st.companyId, from: last.mode, to: st.mode, approvers: st.approvers, ready: st.ready, trigger: why },
      });
      if (created) {
        await audit(tx, {
          actor: { type: 'SYSTEM', id: 'iam.controls' },
          action: CONTROLS_MODE_CHANGED_EVENT,
          entity: { type: CONTROLS_AGGREGATE_TYPE, id: st.companyId, companyId: st.companyId },
          before: { mode: last.mode },
          after: { mode: st.mode, approvers: st.approvers, ready: st.ready },
          reason: why,
          operationKey: key,
        });
      }
      companies.push({ companyId: st.companyId, mode: st.mode, approvers: st.approvers, previous: last.mode, changed: created });
    }
    return { companies, changed: companies.filter((c) => c.changed).map((c) => c.companyId) };
  });
}

/** recordControlsMode after a committed identity transaction: an observation, so a failure is logged, never thrown. */
export async function recordControlsModeQuietly(prisma: RootClient, trigger: string): Promise<ControlsModeRecord | null> {
  try {
    return await recordControlsMode(prisma, trigger);
  } catch (err) {
    console.error('iam.controls: could not record the controls mode (the owner-digest job records it again)', (err as Error)?.name ?? err);
    return null;
  }
}
