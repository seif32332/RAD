// Discrepancy transitions (P1-FND-INV; ARCHITECTURE_INVARIANTS §4.3, ADR-0002 #1). Each one is a
// runTransition: operation key + guarded state change (version) + audit row + events in ONE
// transaction; a repeated call with the same key returns the recorded result (ARCH-014 double-call
// tests: src/modules/platform/__tests__/invariants.it.test.ts). No side effect runs here: the owner
// alert of a waiver and the owner confirmation request are events for their consumers.
//
// Reopen-on-recurrence is not a person's transition: reconcile does it (../invariants/reconcile.ts).
import { conflict, notFound } from '@/lib/http';
import { audit } from '../audit';
import { emitEvent } from '../events';
import { runTransition, type OperationOutcome } from '../operations';
import type { RootClient, TxClient } from '../tx';
import {
  decideApproveExplanation,
  decideApproveWaiver,
  decideExplain,
  decideOwnerConfirmation,
  decideRejectPending,
  decideResolve,
  decideWaiver,
  type Decision,
  type DiscrepancyActor,
  type DiscrepancyState,
} from '../invariants/policy';
import { findingsOf, requireInvariant } from '../invariants/reconcile';
import type { OperatorMode } from '../invariants/types';

const STATE_SELECT = {
  id: true, ruleId: true, status: true, blocking: true, subjectEmployeeId: true, pendingAction: true,
  explainedById: true, waivedById: true, selfActSingleOperator: true, ownerConfirmation: true,
  companyId: true, version: true, fingerprint: true, severity: true, checkId: true,
} as const;

type StateRow = DiscrepancyState & { companyId: string | null; version: number; fingerprint: string; severity: string; checkId: string };

export interface DiscrepancyTransitionResult {
  id: string;
  status: string;
  pendingAction: string | null;
  ownerConfirmation: string | null;
  version: number;
}

interface Common {
  discrepancyId: string;
  /**
   * The version the actor saw (optimistic concurrency). With it, the derived operation key is stable:
   * the same person submitting the same action on the same version twice gets the recorded result.
   */
  expectedVersion?: number;
  /** Idempotency-Key of the request; default derived from (transition, discrepancy, version, actor). */
  key?: string;
  ipAddress?: string | null;
}

async function currentVersion(prisma: RootClient, id: string): Promise<number> {
  const row = await prisma.discrepancy.findUnique({ where: { id }, select: { version: true } });
  if (!row) throw notFound('الاختلاف غير موجود');
  return row.version;
}

/**
 * The shared shape of every discrepancy transition: key, then in one transaction read the row, decide
 * (pure policy), write the guarded change, audit it and emit its events.
 */
async function apply(
  prisma: RootClient,
  name: string,
  common: Common,
  actor: { type: 'USER'; id: string } | { type: 'SYSTEM'; id: string },
  decide: (row: StateRow, tx: TxClient, now: Date) => Promise<Decision> | Decision,
): Promise<OperationOutcome<DiscrepancyTransitionResult>> {
  const expected = common.expectedVersion ?? (await currentVersion(prisma, common.discrepancyId));
  if (!Number.isInteger(expected) || expected < 0) throw conflict('نسخة الاختلاف غير صالحة');
  // A client key is namespaced by the transition and the actor: two people never share a key.
  const key = common.key?.trim() ? `${name}:${actor.id}:${common.key.trim()}` : `${name}:${common.discrepancyId}:v${expected}:${actor.id}`;
  return runTransition(prisma, { key, operation: name, actorId: actor.type === 'USER' ? actor.id : null }, async (tx) => {
    const row = (await tx.discrepancy.findUnique({ where: { id: common.discrepancyId }, select: STATE_SELECT })) as StateRow | null;
    if (!row) throw notFound('الاختلاف غير موجود');
    if (row.version !== expected) throw conflict('تغيّر الاختلاف منذ تحميله، أعد التحميل ثم حاول مرة أخرى');
    const now = new Date();
    const d = await decide(row, tx, now);
    const { count } = await tx.discrepancy.updateMany({ where: { id: row.id, version: row.version }, data: { ...d.data, version: { increment: 1 } } });
    if (!count) throw conflict('تغيّر الاختلاف منذ تحميله، أعد التحميل ثم حاول مرة أخرى');
    const after = { status: d.status, pendingAction: d.pendingAction, ownerConfirmation: d.ownerConfirmation };
    await audit(tx, {
      actor,
      action: name,
      entity: { type: 'Discrepancy', id: row.id, companyId: row.companyId },
      before: { status: row.status, pendingAction: row.pendingAction, ownerConfirmation: row.ownerConfirmation },
      after: { ...after, change: d.data },
      operationKey: key,
      ipAddress: common.ipAddress ?? null,
    });
    for (const type of d.events) {
      await emitEvent(tx, {
        type,
        aggregateType: 'Discrepancy',
        aggregateId: row.id,
        idempotencyKey: `${key}:${type}`,
        companyId: row.companyId,
        actorId: actor.type === 'USER' ? actor.id : null,
        occurredAt: now,
        payload: {
          ruleId: row.ruleId, checkId: row.checkId, severity: row.severity, blocking: row.blocking, ...after,
          // The waiver alerts the owner (§4.3 rule 2, 5); the single-operator path asks for his confirmation.
          ownerAlert: type === 'platform.discrepancy.waived' || type === 'platform.discrepancy.ownerConfirmationRequested' || type === 'platform.discrepancy.ownerRejected',
        },
      });
    }
    return { id: row.id, ...after, version: row.version + 1 };
  });
}

const user = (a: DiscrepancyActor) => ({ type: 'USER' as const, id: a.userId });

/** Explain (EXPLAINED, or a proposal waiting for the second person / the owner's confirmation). */
export function explainDiscrepancy(
  prisma: RootClient,
  input: Common & { explanation: string; reference: string; category?: string | null },
  actor: DiscrepancyActor,
  opts: { operatorMode: OperatorMode },
) {
  return apply(prisma, 'platform.discrepancy.explain', input, user(actor), (row, _tx, now) =>
    decideExplain(row, requireInvariant(row.ruleId), actor, opts.operatorMode, input, now),
  );
}

/** The second person approves a pending explanation (lifts the block). */
export function approveDiscrepancyExplanation(prisma: RootClient, input: Common, actor: DiscrepancyActor) {
  return apply(prisma, 'platform.discrepancy.approveExplanation', input, user(actor), (row, _tx, now) => decideApproveExplanation(row, actor, now));
}

/** Request a waiver (two people, or the single-operator path). */
export function requestDiscrepancyWaiver(
  prisma: RootClient,
  input: Common & { reason: string },
  actor: DiscrepancyActor,
  opts: { operatorMode: OperatorMode },
) {
  return apply(prisma, 'platform.discrepancy.requestWaiver', input, user(actor), (row, _tx, now) =>
    decideWaiver(row, requireInvariant(row.ruleId), actor, opts.operatorMode, input, now),
  );
}

/** The second person approves a pending waiver: WAIVED, and the owner is alerted (event). */
export function approveDiscrepancyWaiver(prisma: RootClient, input: Common, actor: DiscrepancyActor) {
  return apply(prisma, 'platform.discrepancy.approveWaiver', input, user(actor), (row, _tx, now) => decideApproveWaiver(row, actor, now));
}

/** The second person refuses the pending explanation or waiver. */
export function rejectDiscrepancyAction(prisma: RootClient, input: Common, actor: DiscrepancyActor) {
  return apply(prisma, 'platform.discrepancy.rejectAction', input, user(actor), (row) => decideRejectPending(row, actor));
}

/**
 * RESOLVED: corrected by an operation in the system. Verified, not declared: the invariant's check is
 * run again (read only, in the transaction) and the finding must be gone, so a resolve cannot be used
 * to lift a block on data that is still wrong.
 */
export function resolveDiscrepancy(
  prisma: RootClient,
  input: Common & { resolution: string; resolutionRef: string; uploadDir?: string },
  actor: DiscrepancyActor,
) {
  return apply(prisma, 'platform.discrepancy.resolve', input, user(actor), async (row, tx, now) => {
    const decision = decideResolve(row, actor, input, now);
    const def = requireInvariant(row.ruleId);
    if (!def.check) throw conflict('هذا الثابت لا يُقاس بعد؛ لا يمكن التحقق من المعالجة');
    const results = await def.check(tx, {}, { uploadDir: input.uploadDir ?? process.env.UPLOAD_DIR });
    if (findingsOf(def, results).some((f) => f.fingerprint === row.fingerprint)) throw conflict('الاختلاف ما زال قائماً في البيانات؛ صحّح البيانات أولاً');
    return decision;
  });
}

/**
 * The owner's answer to a SELF_ACT_SINGLE_OPERATOR classification, received over the DEC-PO-022
 * channel (outside the tenant). Called by that channel's handler as a SYSTEM actor; `channelRef`
 * identifies the confirmation message.
 */
export function confirmSingleOperatorAct(
  prisma: RootClient,
  input: Common & { decision: 'CONFIRMED' | 'REJECTED'; channelRef: string },
) {
  return apply(prisma, 'platform.discrepancy.ownerConfirmation', input, { type: 'SYSTEM', id: 'owner-channel' }, (row, _tx, now) =>
    decideOwnerConfirmation(row, input.decision, input.channelRef, now),
  );
}
