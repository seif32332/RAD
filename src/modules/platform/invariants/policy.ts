// Classification rules of a discrepancy (ARCHITECTURE_INVARIANTS §4.3 rules 2 and 5, ADR-0002 #1,
// DEC-PO-120 / DEC-PO-122). Pure functions: given the row, its invariant, the actor and the operator
// mode, they return the change to write or throw. The transitions (../transitions/discrepancy.ts) run
// them inside their transaction; these conditions are not company settings.
import type { Prisma, PrismaClient } from '@prisma/client';
import { badRequest, conflict, forbidden } from '@/lib/http';
import type { InvariantDefinition, OperatorMode, OwnerConfirmation, PendingAction } from './types';

type Db = PrismaClient | Prisma.TransactionClient;

export interface DiscrepancyActor {
  userId: string;
  /** Employee linked to the user (from the session): the beneficiary never classifies his own finding. */
  employeeId?: string | null;
}

/** The columns the rules read. */
export interface DiscrepancyState {
  id: string;
  ruleId: string;
  status: string;
  blocking: boolean;
  subjectEmployeeId: string | null;
  pendingAction: string | null;
  explainedById: string | null;
  waivedById: string | null;
  selfActSingleOperator: boolean;
  ownerConfirmation: string | null;
}

export type DiscrepancyPatch = Prisma.DiscrepancyUpdateManyMutationInput;

export interface Decision {
  data: DiscrepancyPatch;
  /** Event types emitted by the transition (after its state change). */
  events: string[];
  /** Status after the change, for the audit row and the result. */
  status: string;
  pendingAction: PendingAction | null;
  ownerConfirmation: OwnerConfirmation | null;
}

/** Setting written by the single-operator detection of P1-PAY-B (DEC-PO-018). Absent = ENFORCED. */
export const OPERATOR_MODE_SETTING = 'platform.operatorMode';

/**
 * The tenant's operator mode, from the server (never from the client). Until P1-PAY-B derives it from
 * the attested approvers (DEC-PO-018), it is a platform SystemSetting; anything but SINGLE_OPERATOR is
 * ENFORCED (fail closed: every two-person condition applies).
 */
export async function resolveOperatorMode(db: Db): Promise<OperatorMode> {
  const row = await db.systemSetting.findUnique({ where: { key: OPERATOR_MODE_SETTING }, select: { value: true } });
  const raw = row?.value?.trim() ?? '';
  let value: unknown = raw;
  try {
    value = JSON.parse(raw);
  } catch {
    /* plain string */
  }
  return value === 'SINGLE_OPERATOR' ? 'SINGLE_OPERATOR' : 'ENFORCED';
}

const MIN_TEXT = 10;

function requireText(value: string | null | undefined, what: string): string {
  const t = value?.trim() ?? '';
  if (t.length < MIN_TEXT) throw badRequest(`${what} مطلوب (${MIN_TEXT} أحرف على الأقل)`);
  return t;
}

function requireRef(value: string | null | undefined, what: string): string {
  const t = value?.trim() ?? '';
  if (!t) throw badRequest(`${what} مطلوب`);
  if (t.length > 500) throw badRequest(`${what} طويل جداً`);
  return t;
}

/** ADR-0002 #1: the beneficiary is never one of the people who classify his own finding. */
export function assertNotBeneficiary(row: DiscrepancyState, actor: DiscrepancyActor): void {
  if (!actor?.userId) throw forbidden();
  if (row.subjectEmployeeId && actor.employeeId && row.subjectEmployeeId === actor.employeeId) {
    throw forbidden('لا يجوز لصاحب الاختلاف أن يشرحه أو يتنازل عنه أو يعتمد ذلك');
  }
}

/** Integrity invariants and blocking findings need a second person to be explained (§4.3 rule 2, 5). */
export function needsSecondPerson(row: DiscrepancyState, def: InvariantDefinition): boolean {
  return row.blocking || def.integrity;
}

function assertOpenAndFree(row: DiscrepancyState): void {
  if (row.status !== 'OPEN') throw conflict('الاختلاف ليس مفتوحاً');
  if (row.pendingAction) throw conflict('على الاختلاف إجراء بانتظار شخص ثانٍ أو تأكيد المالك');
}

const CATEGORY = /^[A-Z][A-Z0-9_]*$/;

/** EXPLAINED (§4.3 rule 5): text, reference and actor; a second person when needsSecondPerson. */
export function decideExplain(
  row: DiscrepancyState,
  def: InvariantDefinition,
  actor: DiscrepancyActor,
  mode: OperatorMode,
  input: { explanation: string; reference: string; category?: string | null },
  now: Date,
): Decision {
  assertOpenAndFree(row);
  assertNotBeneficiary(row, actor);
  const explanation = requireText(input.explanation, 'نص الشرح');
  const explanationRef = requireRef(input.reference, 'مرجع الشرح');
  const category = input.category?.trim() || null;
  if (category && !CATEGORY.test(category)) throw badRequest('فئة الاختلاف غير صالحة');
  const base: DiscrepancyPatch = {
    explanation, explanationRef, explainedById: actor.userId, explainedAt: now,
    explanationApprovedById: null, explanationApprovedAt: null,
    ...(category ? { category } : {}),
  };
  if (!needsSecondPerson(row, def)) {
    return { data: { ...base, status: 'EXPLAINED', pendingAction: null, selfActSingleOperator: false, ownerConfirmation: null }, events: ['platform.discrepancy.explained'], status: 'EXPLAINED', pendingAction: null, ownerConfirmation: null };
  }
  if (mode === 'SINGLE_OPERATOR') return singleOperator(base, def, 'EXPLANATION');
  return { data: { ...base, pendingAction: 'EXPLANATION', selfActSingleOperator: false, ownerConfirmation: null }, events: ['platform.discrepancy.explanationProposed'], status: 'OPEN', pendingAction: 'EXPLANATION', ownerConfirmation: null };
}

/** WAIVED: always two people (§4.3 rule 2, 5) plus an owner alert, or the single-operator path. */
export function decideWaiver(
  row: DiscrepancyState,
  def: InvariantDefinition,
  actor: DiscrepancyActor,
  mode: OperatorMode,
  input: { reason: string },
  now: Date,
): Decision {
  assertOpenAndFree(row);
  assertNotBeneficiary(row, actor);
  const waiverReason = requireText(input.reason, 'سبب التنازل');
  const base: DiscrepancyPatch = { waiverReason, waivedById: actor.userId, waivedAt: now, waiverApprovedById: null, waiverApprovedAt: null };
  if (mode === 'SINGLE_OPERATOR') return singleOperator(base, def, 'WAIVER');
  return { data: { ...base, pendingAction: 'WAIVER', selfActSingleOperator: false, ownerConfirmation: null }, events: ['platform.discrepancy.waiverRequested'], status: 'OPEN', pendingAction: 'WAIVER', ownerConfirmation: null };
}

/**
 * ADR-0002 #1: the sole operator acts alone, recorded as SELF_ACT_SINGLE_OPERATOR, and the owner is
 * asked to confirm over the DEC-PO-022 channel. For INV-PAY-03 the confirmation blocks (the finding
 * stays OPEN, pending, until the owner confirms); otherwise the classification applies now and the
 * confirmation follows.
 */
function singleOperator(base: DiscrepancyPatch, def: InvariantDefinition, action: PendingAction): Decision {
  const self = { ...base, selfActSingleOperator: true, ownerConfirmation: 'PENDING' as const, ownerConfirmationRef: null, ownerConfirmedAt: null };
  const requested = 'platform.discrepancy.ownerConfirmationRequested';
  if (def.ownerConfirmationBlocks) {
    return { data: { ...self, pendingAction: action }, events: [requested], status: 'OPEN', pendingAction: action, ownerConfirmation: 'PENDING' };
  }
  const status = action === 'EXPLANATION' ? 'EXPLAINED' : 'WAIVED';
  const done = action === 'EXPLANATION' ? 'platform.discrepancy.explained' : 'platform.discrepancy.waived';
  return { data: { ...self, status, pendingAction: null }, events: [done, requested], status, pendingAction: null, ownerConfirmation: 'PENDING' };
}

function assertSecondPerson(row: DiscrepancyState, actor: DiscrepancyActor, action: PendingAction): void {
  if (row.status !== 'OPEN' || row.pendingAction !== action) throw conflict(action === 'EXPLANATION' ? 'لا يوجد شرح بانتظار الاعتماد' : 'لا يوجد تنازل بانتظار الاعتماد');
  if (row.ownerConfirmation === 'PENDING') throw conflict('الإجراء بانتظار تأكيد المالك عبر قناته');
  assertNotBeneficiary(row, actor);
  const first = action === 'EXPLANATION' ? row.explainedById : row.waivedById;
  if (first === actor.userId) throw forbidden('يجب أن يعتمد الإجراء شخص ثانٍ غير من طلبه');
}

export function decideApproveExplanation(row: DiscrepancyState, actor: DiscrepancyActor, now: Date): Decision {
  assertSecondPerson(row, actor, 'EXPLANATION');
  return { data: { status: 'EXPLAINED', pendingAction: null, explanationApprovedById: actor.userId, explanationApprovedAt: now }, events: ['platform.discrepancy.explained'], status: 'EXPLAINED', pendingAction: null, ownerConfirmation: null };
}

export function decideApproveWaiver(row: DiscrepancyState, actor: DiscrepancyActor, now: Date): Decision {
  assertSecondPerson(row, actor, 'WAIVER');
  return { data: { status: 'WAIVED', pendingAction: null, waiverApprovedById: actor.userId, waiverApprovedAt: now }, events: ['platform.discrepancy.waived'], status: 'WAIVED', pendingAction: null, ownerConfirmation: null };
}

/** The second person refuses the pending explanation or waiver: back to OPEN without a proposal. */
export function decideRejectPending(row: DiscrepancyState, actor: DiscrepancyActor): Decision {
  const action = row.pendingAction as PendingAction | null;
  if (row.status !== 'OPEN' || !action) throw conflict('لا يوجد إجراء بانتظار الاعتماد');
  assertSecondPerson(row, actor, action);
  const cleared: DiscrepancyPatch =
    action === 'EXPLANATION'
      ? { explanation: null, explanationRef: null, explainedById: null, explainedAt: null }
      : { waiverReason: null, waivedById: null, waivedAt: null };
  return { data: { ...cleared, pendingAction: null }, events: ['platform.discrepancy.actionRejected'], status: 'OPEN', pendingAction: null, ownerConfirmation: null };
}

/** The owner's answer over the DEC-PO-022 channel to a SELF_ACT_SINGLE_OPERATOR classification. */
export function decideOwnerConfirmation(row: DiscrepancyState, decision: 'CONFIRMED' | 'REJECTED', channelRef: string, now: Date): Decision {
  if (!row.selfActSingleOperator || row.ownerConfirmation !== 'PENDING') throw conflict('لا يوجد إجراء بانتظار تأكيد المالك');
  const ref = requireRef(channelRef, 'مرجع قناة التأكيد');
  const stamp = { ownerConfirmation: decision, ownerConfirmationRef: ref, ownerConfirmedAt: now };
  if (decision === 'CONFIRMED') {
    if (row.pendingAction) {
      const status = row.pendingAction === 'EXPLANATION' ? 'EXPLAINED' : 'WAIVED';
      const event = status === 'EXPLAINED' ? 'platform.discrepancy.explained' : 'platform.discrepancy.waived';
      return { data: { ...stamp, status, pendingAction: null }, events: [event, 'platform.discrepancy.ownerConfirmed'], status, pendingAction: null, ownerConfirmation: 'CONFIRMED' };
    }
    return { data: stamp, events: ['platform.discrepancy.ownerConfirmed'], status: row.status, pendingAction: null, ownerConfirmation: 'CONFIRMED' };
  }
  // Rejected: the classification is void and the finding is OPEN again (and blocks again).
  return { data: { ...stamp, status: 'OPEN', pendingAction: null }, events: ['platform.discrepancy.ownerRejected'], status: 'OPEN', pendingAction: null, ownerConfirmation: 'REJECTED' };
}

/** RESOLVED: corrected by an operation in the system; the caller has verified the finding is gone. */
export function decideResolve(row: DiscrepancyState, actor: DiscrepancyActor, input: { resolution: string; resolutionRef: string }, now: Date): Decision {
  if (!['OPEN', 'EXPLAINED', 'WAIVED'].includes(row.status)) throw conflict('الاختلاف مغلق مسبقاً');
  if (!actor?.userId) throw forbidden();
  const resolution = requireText(input.resolution, 'وصف المعالجة');
  const resolutionRef = requireRef(input.resolutionRef, 'مرجع المعالجة');
  return {
    data: { status: 'RESOLVED', pendingAction: null, resolution, resolutionRef, resolvedById: actor.userId, resolvedAt: now, closedAt: now },
    events: ['platform.discrepancy.resolved'],
    status: 'RESOLVED',
    pendingAction: null,
    ownerConfirmation: null,
  };
}
