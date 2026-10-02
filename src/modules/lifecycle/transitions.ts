// lifecycle transitions (P1-LCY; LIFECYCLE_MODEL §2.3, DEC-PO-119, ARC-LCY-A1..A5, BR-LCY-006).
//
// transitionEmploymentState is THE writer of the employment state (ARCH-005): in the caller's
// transaction it
//   1. locks the employee first, inside the caller's companies (people.lockEmployees, ADR-0002 #2);
//   2. opens the employee's state (LCY-J1, lifecycle_open_state of 9y) when it has none yet;
//   3. plans the move from the current FACT (the latest EmploymentStateChange, not the projection) with
//      the pure state machine of ./states (refused moves throw, repeats are NO_CHANGE);
//   4. applies the person rules of ./policy (two people, single operator, last eligible approver);
//   5. writes the EmploymentPeriod through platform/effective (ARCH-012), the EmploymentStateChange
//      fact (append-only; D1 / V1 carry supersedesId, ADR-0002 #3) and the projections
//      Employee.employmentState / isTerminated / terminationDate (+ the legacy employmentStatus mirror),
//      guarded on the state it read (a concurrent writer makes it fail, not overwrite);
//   6. ends the login when the employee becomes TERMINATED (iam, a call down, with the grace of
//      src/lib/access.ts);
//   7. writes the audit row (before / after) and the employment.* events (outbox).
// Side effects (mail, documents, payroll regeneration, the exit-reason projection of offboarding, the
// accrual start of leave) are consumers of the events, never run here (ARCH-017, ARC-LCY-A4).
// Idempotent on operationKey: the same key replays the recorded result (sequentially or concurrently).
import { randomUUID } from 'crypto';
import type { EmploymentStateChange, Prisma } from '@prisma/client';
import { deactivateEmployeeUser } from '@/lib/access';
import { todayKey } from '@/lib/dates';
import { badRequest, conflict, HttpError } from '@/lib/http';
import { employeeForLifecycle, lockEmployees } from '@/modules/people';
import {
  assertTransactionClient,
  audit,
  closePeriod,
  emitEvent,
  idempotent,
  lineageOf,
  openPeriod,
  supersedePeriod,
  toDateOnly,
  type AuditActor,
  type DateOnly,
  type PeriodView,
  type RootClient,
  type TxClient,
} from '@/modules/platform';
import { employmentEventKey, type EmploymentEventPayload } from './events';
import { assertFinancialApproverExit, decideTwoPerson, removesLastEligible, TwoPersonRequiredError } from './policy';
import { latestStateChange } from './queries';
import { callOpenState } from './sql/opening';
import {
  EmploymentTransitionError,
  legacyStatusOf,
  NOTICE_STATE_RELEASED,
  planTransition,
  TRANSITION_NAMES,
  type CurrentEmployment,
  type EmploymentCommand,
  type EmploymentState,
  type EmploymentTransition,
  type TransitionPlan,
} from './states';

/** Who acts: a user (requester), or the system for the scheduled end of a notice (T2). */
export type LifecycleActor = { type: 'USER'; id: string } | { type: 'SYSTEM'; id: string };

export interface TransitionEmploymentStateInput {
  employeeId: string;
  command: EmploymentCommand;
  /** HIRE / REHIRE: first working day. EXIT / NOTICE / TERMINATE / TERMINATE_IN_NOTICE / AMEND: last working day. */
  date?: DateOnly | null;
  /** ExitReason dictionary code (EXIT_REASON_CODES). */
  exitReason?: string | null;
  exitVoluntary?: boolean | null;
  /** AMEND: the reason fields are part of the correction (otherwise the recorded ones are kept). */
  amendsReason?: boolean;
  /** EXIT of an employee in NOTICE: refused (default; the way is D1) or T3n (absconding / article 80). */
  fromNotice?: 'REFUSE' | 'TERMINATE_IN_NOTICE';
  /** The actor's written reason (recorded on the fact and the audit row). */
  reason?: string | null;
  /** The decision behind it: EMPLOYEE_FILE, LEAVE_ABSCOND, SETTLEMENT, ONBOARDING, SYSTEM… (its id is sourceId). */
  source: { type: string; id: string };
  actor: LifecycleActor;
  /** The second person of a two-person act (a user who approved it separately). */
  approvedById?: string | null;
  /** Idempotency key: the HTTP Idempotency-Key, or derived from (user, employee, command, date / version). */
  operationKey: string;
  /** The caller's companies (iam context, lifecycleCompanies(ctx)); 'ALL' for owners and system-wide contexts. No default. */
  companyIds: readonly string[] | 'ALL';
  /** Login end: documentsAccess false = no documents-only window (absconding). */
  access?: { documentsAccess?: boolean; ipAddress?: string | null };
  /** Business "now" (tests and jobs); today is its Riyadh calendar day. */
  now?: Date;
  /** The NOTICE release gate (ADR-0004 #3); defaults to NOTICE_STATE_RELEASED. */
  noticeReleased?: boolean;
}

export interface TransitionEmploymentStateResult {
  employeeId: string;
  /** false: nothing was written (a repeat: same state and same date, or nothing to correct). */
  changed: boolean;
  noChangeReason: string | null;
  stateChangeId: string | null;
  transition: EmploymentTransition | null;
  fromState: EmploymentState | null;
  toState: EmploymentState;
  terminationDate: string | null;
  exitReason: string | null;
  exitVoluntary: boolean | null;
  employmentLineageId: string | null;
  periodId: string | null;
  approvedById: string | null;
  singleOperator: boolean;
  eligibleApproverRemoved: boolean;
  /** D1 back to NOTICE: HR re-enables the login (and face enrolment) by an explicit audited step. */
  loginReenableRequired: boolean;
  access: { hasUser: boolean; deactivated: boolean; graceDays: number } | null;
  events: string[];
  /** The state was opened (LCY-J1) inside this call. */
  opened: boolean;
}

export type TransitionOutcome = TransitionEmploymentStateResult & { replayed: boolean };

const dayKey = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);

function validate(input: TransitionEmploymentStateInput): void {
  if (!input?.employeeId?.trim()) throw badRequest('employeeId is required');
  if (!input.operationKey?.trim()) throw badRequest('operationKey is required');
  if (!input.source || !/^[A-Z][A-Z0-9_]*$/.test(input.source.type ?? '') || !input.source.id?.trim()) {
    throw badRequest('source {type (UPPER_SNAKE), id} is required');
  }
  if (input.source.type === 'LEGACY_OPENING') throw badRequest('LEGACY_OPENING is written by the opening only (LCY-J1)');
  if (input.companyIds !== 'ALL' && !Array.isArray(input.companyIds)) throw badRequest('companyIds (the caller scope) is required');
  if (input.actor?.type !== 'USER' && input.actor?.type !== 'SYSTEM') throw badRequest('actor is required');
  if (!input.actor.id?.trim()) throw badRequest('actor.id is required');
  if (input.actor.type === 'SYSTEM' && input.command !== 'NOTICE_END') {
    throw badRequest('only the end of a notice (T2) is a system act; every other transition has a user');
  }
}

async function currentOf(tx: TxClient, employeeId: string, joinDate: Date, latest: EmploymentStateChange | null): Promise<CurrentEmployment> {
  let period: CurrentEmployment['period'] = null;
  if (latest?.employmentLineageId) {
    const active = (await lineageOf(tx, 'EMPLOYMENT', latest.employmentLineageId)).find((p) => !p.supersededAt);
    if (active) period = { id: active.id, lineageId: active.lineageId, validFrom: active.validFrom, validTo: active.validTo };
  }
  let previousLineageEnd: CurrentEmployment['previousLineageEnd'] = null;
  if (latest) {
    const prev = await tx.employmentStateChange.findFirst({
      where: { employeeId, NOT: { employmentLineageId: latest.employmentLineageId } },
      orderBy: { seq: 'desc' },
    });
    if (prev) previousLineageEnd = { terminationDate: dayKey(prev.terminationDate), exitReason: prev.exitReason, exitVoluntary: prev.exitVoluntary };
  }
  return {
    state: latest ? latest.toState : null,
    terminationDate: dayKey(latest?.terminationDate),
    exitReason: latest?.exitReason ?? null,
    exitVoluntary: latest?.exitVoluntary ?? null,
    joinDate: dayKey(joinDate) as string,
    period,
    latestChangeId: latest?.id ?? null,
    previousLineageEnd,
  };
}

/** The projection guard: the row still has the state the plan was made from (BR-LCY-013 for an empty one). */
function stateGuard(from: EmploymentState | null): Prisma.EmployeeWhereInput {
  if (from === null) return { employmentState: null };
  if (from === 'ACTIVE') return { OR: [{ employmentState: 'ACTIVE' }, { employmentState: null, isTerminated: false }] };
  if (from === 'TERMINATED') return { OR: [{ employmentState: 'TERMINATED' }, { employmentState: null, isTerminated: true }] };
  return { employmentState: 'NOTICE' };
}

async function applyPeriod(
  tx: TxClient,
  plan: TransitionPlan,
  cur: CurrentEmployment,
  input: TransitionEmploymentStateInput,
  op: { key: string; actor: AuditActor; companyId: string | null; reason: string | null },
): Promise<PeriodView<'EMPLOYMENT'> | null> {
  const a = plan.period;
  if (a.type === 'NONE') return null;
  if (a.type === 'OPEN') {
    return (await openPeriod(tx, 'EMPLOYMENT', { employeeId: input.employeeId, validFrom: a.validFrom, validTo: null, source: input.source, attrs: {} }, op)).period;
  }
  if (a.type === 'VOID') {
    if (!cur.period) throw conflict('لا توجد فترة توظيف لإبطالها');
    return (await supersedePeriod(tx, 'EMPLOYMENT', cur.period.id, { reason: 'VOID', source: input.source }, op)).superseded;
  }
  // END: the in-place end of ADR-0001 #9 (null reopens, DEC-PO-043). A legacy lineage without a period
  // (terminated without a date) gets one from the join date when a date is finally given.
  if (!cur.period) {
    if (!a.validTo) return null;
    return (await openPeriod(tx, 'EMPLOYMENT', { employeeId: input.employeeId, validFrom: cur.joinDate, validTo: a.validTo, source: input.source, attrs: {} }, op)).period;
  }
  return (await closePeriod(tx, 'EMPLOYMENT', cur.period.id, { validTo: a.validTo, source: input.source }, op)).period;
}

async function apply(tx: TxClient, input: TransitionEmploymentStateInput): Promise<TransitionEmploymentStateResult> {
  const [locked] = await lockEmployees(tx, [input.employeeId], input.companyIds);
  const companyId = locked.legalCompanyId;
  const auditActor: AuditActor = input.actor.type === 'USER' ? { type: 'USER', id: input.actor.id } : { type: 'SYSTEM', id: input.actor.id };
  const actorId = input.actor.type === 'USER' ? input.actor.id : null;

  let latest = await latestStateChange(tx, input.employeeId);
  let opened = false;
  if (!latest && input.command !== 'HIRE') {
    const row = await callOpenState(tx, input.employeeId, input.actor.type === 'USER' ? `user:${input.actor.id}` : input.actor.id);
    if (row.outcome === 'OPENED') {
      opened = true;
      await audit(tx, {
        actor: auditActor,
        action: 'employment.state.legacyOpen',
        entity: { type: 'EmploymentStateChange', id: row.changeId, companyId },
        after: { employeeId: input.employeeId, review: row.review ?? [] },
        reason: 'LCY-J1 opening before the first transition (ARC-LCY-A2)',
        operationKey: input.operationKey,
      });
    }
    latest = await latestStateChange(tx, input.employeeId);
  }
  const emp = await employeeForLifecycle(tx, input.employeeId);
  if (!emp) throw conflict('الموظف غير موجود');
  const cur = await currentOf(tx, input.employeeId, emp.joinDate, latest);

  const today = todayKey(input.now ?? new Date());
  const date = input.date === undefined || input.date === null ? null : dayKey(toDateOnly(input.date, 'date'));
  const planned = planTransition(
    cur,
    { command: input.command, date, exitReason: input.exitReason, exitVoluntary: input.exitVoluntary, fromNotice: input.fromNotice, amendsReason: input.amendsReason },
    today,
    input.noticeReleased ?? NOTICE_STATE_RELEASED,
  );

  const unchanged = (reason: string, transition: EmploymentTransition | null): TransitionEmploymentStateResult => ({
    employeeId: input.employeeId,
    changed: false,
    noChangeReason: reason,
    stateChangeId: latest?.id ?? null,
    transition,
    fromState: cur.state,
    toState: (cur.state ?? 'ACTIVE') as EmploymentState,
    terminationDate: cur.terminationDate,
    exitReason: cur.exitReason,
    exitVoluntary: cur.exitVoluntary,
    employmentLineageId: cur.period?.lineageId ?? latest?.employmentLineageId ?? null,
    periodId: cur.period?.id ?? null,
    approvedById: null,
    singleOperator: false,
    eligibleApproverRemoved: false,
    loginReenableRequired: false,
    access: null,
    events: [],
    opened,
  });
  if (planned.kind === 'NO_CHANGE') return unchanged(planned.reason, planned.transition);
  const plan = planned;

  // Person rules (BR-LCY-012, CG-LCY-003).
  let approvedById: string | null = null;
  let singleOperator = false;
  let eligibleApproverRemoved = false;
  const exitsNow = plan.fromState === 'ACTIVE' && (plan.toState === 'NOTICE' || plan.toState === 'TERMINATED');
  const leavesEligibility = exitsNow || plan.transition === 'NOTICE_END' || plan.transition === 'TERMINATE_IN_NOTICE';
  if (leavesEligibility && plan.transition !== 'VOID') {
    eligibleApproverRemoved = await removesLastEligible(tx, { employeeId: input.employeeId, userId: emp.userId });
  }
  if (plan.twoPerson || (eligibleApproverRemoved && input.actor.type === 'USER')) {
    if (input.actor.type !== 'USER') throw new TwoPersonRequiredError();
    const d = await decideTwoPerson(tx, { requesterId: input.actor.id, approvedById: input.approvedById ?? null, subjectEmployeeId: input.employeeId });
    approvedById = d.approvedById;
    singleOperator = d.singleOperator;
  }
  if (exitsNow) await assertFinancialApproverExit(tx, { employeeId: input.employeeId, userId: emp.userId });

  const reason = input.reason?.trim() ? input.reason.trim().slice(0, 2000) : null;
  const periodOp = { key: input.operationKey, actor: auditActor, companyId, reason };
  const touched = await applyPeriod(tx, plan, cur, input, periodOp);
  const lineageId = touched?.lineageId ?? cur.period?.lineageId ?? latest?.employmentLineageId ?? null;
  const periodId = touched?.id ?? cur.period?.id ?? null;

  const stateChangeId = randomUUID();
  await tx.employmentStateChange.create({
    data: {
      id: stateChangeId,
      employeeId: input.employeeId,
      employmentLineageId: lineageId,
      periodId,
      transition: plan.transition,
      fromState: plan.fromState,
      toState: plan.toState,
      effectiveDate: toDateOnly(plan.effectiveDate, 'effectiveDate'),
      terminationDate: plan.terminationDate ? toDateOnly(plan.terminationDate, 'terminationDate') : null,
      exitReason: plan.exitReason,
      exitVoluntary: plan.exitVoluntary,
      reason,
      sourceType: input.source.type,
      sourceId: input.source.id,
      companyId,
      actorId,
      approvedById,
      singleOperator,
      operationKey: input.operationKey,
      supersedesId: plan.supersedes ? cur.latestChangeId : null,
    },
  });

  // The projections (SOURCE_OF_TRUTH §3.1), guarded on the state the plan was made from.
  const projected = await tx.employee.updateMany({
    where: { AND: [{ id: input.employeeId }, stateGuard(plan.fromState)] },
    data: {
      employmentState: plan.toState,
      isTerminated: plan.toState === 'TERMINATED',
      terminationDate: plan.terminationDate ? toDateOnly(plan.terminationDate, 'terminationDate') : null,
      employmentStatus: legacyStatusOf(plan.toState),
    },
  });
  if (projected.count !== 1) throw conflict('تغيّرت حالة الموظف أثناء التنفيذ؛ أعد المحاولة');

  let access: TransitionEmploymentStateResult['access'] = null;
  if (plan.endsLogin) {
    const r = await deactivateEmployeeUser(tx, input.employeeId, {
      reason: `employment.${TRANSITION_NAMES[plan.transition]} (${input.source.type} ${input.source.id})`,
      actorId,
      ipAddress: input.access?.ipAddress ?? null,
      documentsAccess: input.access?.documentsAccess,
    });
    access = { hasUser: r.hasUser, deactivated: r.deactivated, graceDays: r.graceDays };
  }

  const before = { state: cur.state, terminationDate: cur.terminationDate, exitReason: cur.exitReason, exitVoluntary: cur.exitVoluntary };
  const after = {
    state: plan.toState,
    terminationDate: plan.terminationDate,
    exitReason: plan.exitReason,
    exitVoluntary: plan.exitVoluntary,
    transition: plan.transition,
    stateChangeId,
    periodId,
    employmentLineageId: lineageId,
    approvedById,
    selfActSingleOperator: singleOperator,
    eligibleApproverRemoved,
    access,
  };
  await audit(tx, {
    actor: auditActor,
    action: `employment.state.${TRANSITION_NAMES[plan.transition]}`,
    entity: { type: 'Employee', id: input.employeeId, companyId },
    before,
    after,
    reason: singleOperator ? `SELF_ACT_SINGLE_OPERATOR${reason ? ` — ${reason}` : ''}` : reason,
    operationKey: input.operationKey,
    ipAddress: input.access?.ipAddress ?? null,
  });

  // The first day the change affects (BL-LCY-012): a D1 moving the last day later also changes the
  // month of the old day; a V1 undoes the period from its first day.
  let affectsFrom = plan.effectiveDate;
  if (plan.transition === 'AMEND' && cur.terminationDate && cur.terminationDate < affectsFrom) affectsFrom = cur.terminationDate;
  if (plan.transition === 'VOID' && cur.period && cur.period.validFrom < affectsFrom) affectsFrom = cur.period.validFrom;

  const payload: EmploymentEventPayload = {
    stateChangeId,
    employeeId: input.employeeId,
    employmentLineageId: lineageId,
    periodId,
    transition: plan.transition,
    fromState: plan.fromState,
    toState: plan.toState,
    effectiveDate: plan.effectiveDate,
    terminationDate: plan.terminationDate,
    affectsFrom,
    exitReason: plan.exitReason,
    exitVoluntary: plan.exitVoluntary,
    singleOperator,
    eligibleApproverRemoved,
  };
  for (const [i, type] of plan.events.entries()) {
    await emitEvent(tx, {
      type,
      aggregateType: 'Employee',
      aggregateId: input.employeeId,
      idempotencyKey: employmentEventKey(stateChangeId, type, i),
      payload: payload as unknown as Record<string, unknown>,
      companyId,
      actorId,
      effectiveDate: toDateOnly(affectsFrom, 'affectsFrom'),
    });
  }

  return {
    employeeId: input.employeeId,
    changed: true,
    noChangeReason: null,
    stateChangeId,
    transition: plan.transition,
    fromState: plan.fromState,
    toState: plan.toState,
    terminationDate: plan.terminationDate,
    exitReason: plan.exitReason,
    exitVoluntary: plan.exitVoluntary,
    employmentLineageId: lineageId,
    periodId,
    approvedById,
    singleOperator,
    eligibleApproverRemoved,
    loginReenableRequired: plan.loginReenableRequired,
    access,
    events: plan.events,
    opened,
  };
}

/** Maps the refusals of the state machine and the person rules to HTTP errors for the routes. */
function asHttp(err: unknown): unknown {
  if (err instanceof EmploymentTransitionError) return new HttpError(err.status, err.message, { code: err.code });
  if (err instanceof TwoPersonRequiredError) return new HttpError(409, err.message, { code: err.code });
  return err;
}

/**
 * THE writer of the employment state (BR-LCY-006, ARCH-005), in the caller's transaction. See the
 * header of this file. Throws HttpError (400 input, 403 scope / person rules, 404 unknown employee,
 * 409 refused move or two-person approval missing).
 */
export async function transitionEmploymentState(tx: TxClient, input: TransitionEmploymentStateInput): Promise<TransitionOutcome> {
  assertTransactionClient(tx, 'transitionEmploymentState');
  validate(input);
  try {
    const outcome = await idempotent(
      tx,
      { key: input.operationKey, operation: `lifecycle.employment.${input.command}`, actorId: input.actor.type === 'USER' ? input.actor.id : null },
      (t) => apply(t, input),
      { ref: (r) => r.stateChangeId },
    );
    return { ...outcome.result, replayed: outcome.replayed };
  } catch (err) {
    throw asHttp(err);
  }
}

function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002';
}

/**
 * transitionEmploymentState in its own transaction (for callers without one: jobs, services). A
 * concurrent call with the same operation key loses on the unique key and is replayed: both get the
 * same result.
 */
export async function runEmploymentTransition(prisma: RootClient, input: TransitionEmploymentStateInput): Promise<TransitionOutcome> {
  const run = () => prisma.$transaction((tx) => transitionEmploymentState(tx, input), { timeout: 20_000, maxWait: 10_000 });
  try {
    return await run();
  } catch (err) {
    if (isUniqueViolation(err)) return run();
    throw err;
  }
}
