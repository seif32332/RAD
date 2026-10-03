// Person rules of the employment transitions (BR-LCY-012, DEC-PO-035 / DEC-PO-037; lcy-to-be.md §13).
//
//   * TERMINATE_ROLES: who may exit an employee (T1 / T3) and who may request or approve the
//     two-person acts (T1c, T3n, T4, D1, V1).
//   * Eligible second person (DEC-PO-037): an active account with a TERMINATE_ROLES role, not the
//     requester, not the employee the act is about, whose own employee (if any) is not NOTICE or
//     TERMINATED. Computed for every act ("is there one now?"), not from the financial controls mode.
//   * ENFORCED: when an eligible second person exists, the act needs an approver who is one; the
//     requester never acts on his own file. SINGLE_OPERATOR (no eligible second person): the act is
//     done alone, recorded SELF_ACT_SINGLE_OPERATOR and sent to the owner (N-LCY-005).
//   * Removing the last eligible second person (CG-LCY-003): exiting an employee whose account is
//     eligible, when fewer than two eligible accounts remain after it, is itself a two-person act
//     (or single operator), flagged for the owner (N-LCY-006).
//
// The financial approver's exit (DEC-PO-021 / 039; BL-PAY-021 security review): assertFinancialApproverExit below
// refuses a one-person exit of a login that counts toward ENFORCED when it would leave a company it acts in with
// fewer than two counted approvers (iam.approverExitEffect, the read port; lifecycle does not read iam's tables).
// Still open for BL-LCY-010: DEC-PO-039 (the owner's confirmation over Radeef when the approver is absent or
// refuses), DEC-PO-042 (root suspension) and DEC-PO-052.
import { ROLE_GROUPS } from '@/lib/constants';
import { forbidden } from '@/lib/http';
import { activeUsersWithRoles, approverExitEffect, isCountedApprover } from '@/modules/iam';
import { listCompanyIds } from '@/modules/org';
import { employeesOfUsers } from '@/modules/people';
import type { TxClient } from '@/modules/platform';
import { effectiveState } from './states';

export const TERMINATE_ROLES: readonly string[] = Object.freeze([...ROLE_GROUPS.HR, 'LEGAL_ADMIN']);

export class TwoPersonRequiredError extends Error {
  readonly status = 409;
  readonly code = 'TWO_PERSON_REQUIRED';
  constructor(message = 'هذا الإجراء يتطلب اعتماد شخص ثانٍ مؤهل من الموارد البشرية أو الإدارة القانونية (BR-LCY-012)') {
    super(message);
    this.name = 'TwoPersonRequiredError';
  }
}

/** Accounts that count as an eligible second person now, except `excludeUserIds` and the employee `excludeEmployeeId`. */
export async function eligibleSecondPersons(tx: TxClient, exclude: { userIds: readonly string[]; employeeId?: string | null }): Promise<string[]> {
  const users = await activeUsersWithRoles(tx, TERMINATE_ROLES);
  const linked = new Map((await employeesOfUsers(tx, users.map((u) => u.id))).map((e) => [e.userId, e]));
  return users
    .filter((u) => !exclude.userIds.includes(u.id))
    .filter((u) => {
      const e = linked.get(u.id);
      if (!e) return true; // an account without an employee file (e.g. the owner's)
      if (exclude.employeeId && e.id === exclude.employeeId) return false;
      return effectiveState(e) === 'ACTIVE';
    })
    .map((u) => u.id);
}

export interface PersonDecision {
  approvedById: string | null;
  singleOperator: boolean;
}

/**
 * BR-LCY-012 for one act about `subjectEmployeeId`, requested by `requesterId` and approved by
 * `approvedById` (a person who confirmed it separately, e.g. through the pending request).
 */
export async function decideTwoPerson(
  tx: TxClient,
  input: { requesterId: string; approvedById?: string | null; subjectEmployeeId: string },
): Promise<PersonDecision> {
  const staff = await activeUsersWithRoles(tx, TERMINATE_ROLES);
  if (!staff.some((u) => u.id === input.requesterId)) throw forbidden('طلب هذا الإجراء لمستخدم نشط من الموارد البشرية أو الإدارة القانونية');
  const [requesterEmployee] = await employeesOfUsers(tx, [input.requesterId]);
  const eligible = await eligibleSecondPersons(tx, { userIds: [input.requesterId], employeeId: input.subjectEmployeeId });
  const selfAct = requesterEmployee?.id === input.subjectEmployeeId;
  if (!eligible.length) return { approvedById: null, singleOperator: true }; // DEC-PO-035
  if (selfAct) throw forbidden('لا يجوز تنفيذ هذا الإجراء على ملفك الوظيفي (EX-LCY-011)');
  if (!input.approvedById) throw new TwoPersonRequiredError();
  if (input.approvedById === input.requesterId) throw forbidden('يجب أن يعتمد الإجراء شخص ثانٍ غير من طلبه');
  if (!eligible.includes(input.approvedById)) throw forbidden('المعتمد ليس شخصاً ثانياً مؤهلاً لهذا الإجراء (DEC-PO-037)');
  return { approvedById: input.approvedById, singleOperator: false };
}

/**
 * CG-LCY-003: does exiting this employee remove an eligible second person and leave fewer than two?
 * `userId` is the account linked to the subject employee.
 */
export async function removesLastEligible(tx: TxClient, subject: { employeeId: string; userId: string | null }): Promise<boolean> {
  if (!subject.userId) return false;
  const all = await eligibleSecondPersons(tx, { userIds: [] });
  if (!all.includes(subject.userId)) return false;
  return all.length - 1 < 2;
}

export const FINANCIAL_APPROVER_EXIT_MESSAGE =
  'إنهاء خدمة هذا الموظف يُسقط عدد المعتمدين الماليين المُقرّ بهم في شركته إلى أقل من اثنين، فيحتاج اعتماد معتمد مالي آخر مُقرّ به (غير منفّذ الإجراء؛ ويجوز أن يكون الموظف المغادر نفسه) قبل التنفيذ (DEC-PO-021)';

/**
 * The exit (T1 / T3, ACTIVE → NOTICE or TERMINATED) of an employee whose login counts toward ENFORCED (DEC-PO-021,
 * BL-PAY-021 security review). Ending that login can drop a company to SINGLE_OPERATOR, after which one person
 * approves and pays alone; so when the exit would leave ANY company the login acts in with fewer than two counted
 * approvers (readiness ignored: fail closed), it needs the approval of a counted approver other than the actor
 * (`approvedById`, recorded through the pending request): DEC-PO-021 literally, so the leaver's own consent counts
 * (actor and leaver are two real people; there is no one-person path). Otherwise TwoPersonRequiredError
 * (409 TWO_PERSON_REQUIRED) and nothing is written. Returns whether such an approver is being removed (the
 * eligibleApproverRemoved flag of the event, N-LCY-006).
 */
export async function assertFinancialApproverExit(
  tx: TxClient,
  subject: { employeeId: string; userId: string | null },
  act: { actorId: string | null; approvedById: string | null } = { actorId: null, approvedById: null },
): Promise<{ approverRemoved: boolean }> {
  if (!subject.userId) return { approverRemoved: false };
  const effect = await approverExitEffect(tx, subject.userId, await listCompanyIds(tx));
  if (!effect.counts || !effect.companiesBelowTwo.length) return { approverRemoved: false };
  const second = act.approvedById;
  const valid = !!second && second !== act.actorId && (await isCountedApprover(tx, second));
  if (!valid) throw new TwoPersonRequiredError(FINANCIAL_APPROVER_EXIT_MESSAGE);
  return { approverRemoved: true };
}
