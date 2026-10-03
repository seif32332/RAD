// The money guards (pay-to-be.md BR-PAY-001, BR-PAY-002, BR-PAY-020, §18 reverseMoney; DEC-PO-002,
// 005, 006, 015, 018; ADR-0002 #1). Pure functions: the gateway feeds them the actor (from the
// session, never from the client), the beneficiaries and approvers its operation resolves, and the
// tenant's operator mode. NO role or setting is an exception (BR-PAY-001 "NO EXCEPTION"): SUPER_ADMIN
// and the former allow_self_approval setting are refused like anyone else. SINGLE_OPERATOR does not
// refuse: it records the act (SELF_ACT_SINGLE_OPERATOR) for the owner's review (BR-PAY-020).
import type { OperatorMode } from '../invariants/types';

/**
 * The acts of BR-PAY-001 / 002 (plus the non-money-effect acts the gateway also names).
 * REQUEST: filing a pending request for oneself is allowed (DEC-PO-006).
 */
export const MONEY_ACTS = [
  'REQUEST',
  'CREATE_EFFECTIVE',
  'APPROVE',
  'REJECT',
  'TRANSFER',
  'PAY',
  'EXPORT',
  'WAIVE',
  'FORGIVE',
  'SUSPEND',
  'APPLY_CHANGE',
  'ATTEST',
  'REVERSE',
  'GENERATE',
  'RELEASE',
  'SETTLE',
] as const;
export type MoneyAct = (typeof MONEY_ACTS)[number];

/** BR-PAY-001 WHEN: the acts whose actor may not be a beneficiary. */
export const BENEFICIARY_ACTS: readonly MoneyAct[] = ['CREATE_EFFECTIVE', 'APPROVE', 'TRANSFER', 'PAY', 'WAIVE', 'FORGIVE', 'SUSPEND', 'APPLY_CHANGE', 'ATTEST', 'REVERSE'];
/** BR-PAY-002 WHEN: the acts whose actor may not be an approver of the subject. */
export const PAYER_ACTS: readonly MoneyAct[] = ['PAY', 'TRANSFER', 'EXPORT'];

export interface GuardActor {
  userId: string;
  /** Employee linked to the user (session), null when none. */
  employeeId: string | null;
}

export type GuardReason =
  | 'SELF_BENEFICIARY'
  | 'PAYER_IS_APPROVER'
  | 'SAME_PERSON_TWICE'
  | 'UNKNOWN_APPROVER'
  // BL-PAY-005 (BR-PAY-005): the second person of an identity act is not the account's creator, and is real (attested).
  | 'CREATOR_IS_SECOND_PERSON'
  | 'UNATTESTED_SECOND_PERSON';

export interface GuardDecision {
  /** true: proceed (possibly as a recorded self-act). */
  ok: boolean;
  /** The rules the act breaks (empty when clean). */
  reasons: GuardReason[];
  /** SINGLE_OPERATOR let a breaking act through: record SELF_ACT_SINGLE_OPERATOR. */
  selfAct: boolean;
}

/** Arabic reason shown on the refused button (pay-to-be §8). */
export const GUARD_MESSAGES: Readonly<Record<GuardReason, string>> = Object.freeze({
  SELF_BENEFICIARY: 'لا يجوز لك تنفيذ هذا الإجراء المالي لأنك المستفيد منه',
  PAYER_IS_APPROVER: 'لا يجوز أن يصرف أو يحوّل المال من اعتمده (فصل الصلاحيات)',
  SAME_PERSON_TWICE: 'يلزم شخص ثانٍ غير من طلب الإجراء',
  UNKNOWN_APPROVER: 'لا يوجد معتمد مسجَّل لهذا المال؛ يلزم إقرار شخص ثانٍ قبل الصرف',
  CREATOR_IS_SECOND_PERSON: 'لا يكون الشخص الثاني من أنشأ الحساب نفسه',
  UNATTESTED_SECOND_PERSON: 'الشخص الثاني يجب أن يكون مستخدماً مُقرّاً بهويته (من سلسلة الجذر)',
});

/**
 * The decision of the rules an act breaks, in a controls mode (BR-PAY-020): none broken → proceed; broken in
 * SINGLE_OPERATOR → proceed as a recorded self-act; broken in ENFORCED → refuse. Anything but SINGLE_OPERATOR
 * is ENFORCED (fail closed).
 */
export function decideByMode(reasons: readonly GuardReason[], mode: OperatorMode): GuardDecision {
  const list = [...reasons];
  if (!list.length) return { ok: true, reasons: list, selfAct: false };
  if (mode === 'SINGLE_OPERATOR') return { ok: true, reasons: list, selfAct: true };
  return { ok: false, reasons: list, selfAct: false };
}

const decide = decideByMode;

/** BR-PAY-001: the actor is not one of the beneficiaries (employee ids). */
export function isBeneficiary(actor: GuardActor, beneficiaries: readonly (string | null | undefined)[]): boolean {
  return !!actor.employeeId && beneficiaries.includes(actor.employeeId);
}

/** BR-PAY-002: the actor is not one of the approvers (user ids) of the subject and its inputs. */
export function isApprover(actor: GuardActor, approvers: readonly (string | null | undefined)[]): boolean {
  return approvers.includes(actor.userId);
}

/**
 * The self-dealing decision of one act (BR-PAY-001 + BR-PAY-002), in the given operator mode.
 * `notBeneficiary` / `notApprover` default from the act; an operation may turn off the beneficiary
 * rule only where the owner decided so (DEC-PO-015: exporting / marking payroll lines paid).
 */
export function decideSelfDealing(input: {
  act: MoneyAct;
  actor: GuardActor;
  beneficiaries?: readonly (string | null | undefined)[];
  approvers?: readonly (string | null | undefined)[];
  notBeneficiary?: boolean;
  notApprover?: boolean;
  mode: OperatorMode;
}): GuardDecision {
  const notBeneficiary = input.notBeneficiary ?? BENEFICIARY_ACTS.includes(input.act);
  const notApprover = input.notApprover ?? PAYER_ACTS.includes(input.act);
  const reasons: GuardReason[] = [];
  if (notBeneficiary && isBeneficiary(input.actor, input.beneficiaries ?? [])) reasons.push('SELF_BENEFICIARY');
  if (notApprover && isApprover(input.actor, input.approvers ?? [])) reasons.push('PAYER_IS_APPROVER');
  return decide(reasons, input.mode);
}

/**
 * The maker-checker of a request (BR-PAY-002 as it applies to a payment request, DEC-PO-005, and
 * "the creator is not the approver", pay-to-be §11): the approver is not the requester; the payer is
 * neither the requester nor an approver. A row without any recorded requester or approver cannot be
 * paid until a second person attests it (BR-PAY-015); the blanket UNKNOWN_REQUESTER pass is gone
 * (BL-PAY-008).
 */
export function decideMakerChecker(input: {
  step: 'APPROVE' | 'PAY';
  actor: GuardActor;
  requestedById: string | null | undefined;
  approvedById?: string | null;
  mode: OperatorMode;
}): GuardDecision {
  const reasons: GuardReason[] = [];
  const requester = input.requestedById ?? null;
  if (input.step === 'APPROVE') {
    if (requester && requester === input.actor.userId) reasons.push('SAME_PERSON_TWICE');
  } else {
    const approver = input.approvedById ?? null;
    if (!requester && !approver) reasons.push('UNKNOWN_APPROVER');
    if ((requester && requester === input.actor.userId) || (approver && approver === input.actor.userId)) reasons.push('PAYER_IS_APPROVER');
  }
  return decide(reasons, input.mode);
}

/**
 * The reverseMoney core (§18, BR-PAY-015 "الإلغاء الحقيقي"): a REVERSE act needs two people, the one
 * who asked and the one who approves, and neither is a beneficiary. Its users are BL-PAY-009 and
 * BL-LCY-015; this is the rule they share.
 */
export function decideReversal(input: {
  requestedBy: GuardActor;
  approver: GuardActor;
  beneficiaries: readonly (string | null | undefined)[];
  mode: OperatorMode;
}): GuardDecision {
  const reasons: GuardReason[] = [];
  if (input.requestedBy.userId === input.approver.userId) reasons.push('SAME_PERSON_TWICE');
  if (isBeneficiary(input.requestedBy, input.beneficiaries) || isBeneficiary(input.approver, input.beneficiaries)) reasons.push('SELF_BENEFICIARY');
  return decide(reasons, input.mode);
}
