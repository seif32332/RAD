// The employment state machine of LIFECYCLE_MODEL §2.3 / lcy-to-be.md §11 as amended by ARC-LCY-A1..A5.
// Pure: the transition table, the planning of one transition (what it writes), the effective state of
// BR-LCY-013 and the ExitReason dictionary (ARC-OFF-A3). No database access here (unit-tested).
//
//   (none) ─HIRE─► ACTIVE ─NOTICE (T1)─► NOTICE ─NOTICE_END (T2)─► TERMINATED ─REHIRE (T4)─► ACTIVE (new lineage)
//                    │                    │  └─TERMINATE_IN_NOTICE (T3n, two people)─►┘
//                    └─TERMINATE (T3)─────┴──────────────────────────────────────────►┘
//   NOTICE ─CANCEL_EXIT (T1c, two people)─► ACTIVE
//   NOTICE | TERMINATED ─AMEND (D1, two people)─► NOTICE | TERMINATED (date / reason corrected)
//   ACTIVE ─VOID (V1, two people)─► the previous lineage's end, or TERMINATED without a date
import type { EmploymentState } from '@prisma/client';

export type { EmploymentState };
export const EMPLOYMENT_STATES: readonly EmploymentState[] = ['ACTIVE', 'NOTICE', 'TERMINATED'];

/** Stored transitions (EmploymentStateChange.transition, CHECK in 9y). */
export type EmploymentTransition =
  | 'HIRE'
  | 'NOTICE'
  | 'CANCEL_EXIT'
  | 'NOTICE_END'
  | 'TERMINATE'
  | 'TERMINATE_IN_NOTICE'
  | 'REHIRE'
  | 'AMEND'
  | 'VOID';

/**
 * A command: a stored transition, or EXIT = "this employee leaves on `date`", resolved against the
 * current state by the writer mapping of lcy-to-be.md §11 (T1 / T3 / nothing / refused).
 */
export type EmploymentCommand = EmploymentTransition | 'EXIT';

export const TRANSITION_NAMES: Readonly<Record<EmploymentTransition, string>> = {
  HIRE: 'hire',
  NOTICE: 'T1',
  CANCEL_EXIT: 'T1c',
  NOTICE_END: 'T2',
  TERMINATE: 'T3',
  TERMINATE_IN_NOTICE: 'T3n',
  REHIRE: 'T4',
  AMEND: 'D1',
  VOID: 'V1',
};

/** BR-LCY-012: the acts that need a requester and a second person (or the single-operator path). */
export const TWO_PERSON_TRANSITIONS: readonly EmploymentTransition[] = ['CANCEL_EXIT', 'TERMINATE_IN_NOTICE', 'REHIRE', 'AMEND', 'VOID'];

/**
 * NOTICE is released (ADR-0004 #3, flipped by BL-LCY-012): an exit whose last working day is still
 * ahead is NOTICE until then (T2 ends it). Payroll reads the last day through employmentEnd /
 * payrollEligible, not isTerminated, so an employee in NOTICE is prorated in the exit month and has no
 * line after it. The gate stays as a constant (and the noticeReleased input) for the tests of both
 * meanings.
 */
export const NOTICE_STATE_RELEASED = true;

/** The ExitReason dictionary (ARC-OFF-A3: one dictionary, owned by lifecycle). */
export const EXIT_REASON_CODES = [
  'RESIGNATION',
  'EMPLOYER_TERMINATION',
  'CONTRACT_END',
  'MUTUAL_AGREEMENT',
  'ARTICLE_80',
  'PROBATION',
  'RETIREMENT',
  'DEATH',
  'ABSCONDING',
  'OTHER',
] as const;
export type ExitReasonCode = (typeof EXIT_REASON_CODES)[number];

export function isExitReasonCode(v: unknown): v is ExitReasonCode {
  return typeof v === 'string' && (EXIT_REASON_CODES as readonly string[]).includes(v);
}

export class EmploymentTransitionError extends Error {
  /** HTTP-ish class of the refusal: 400 bad input, 409 not allowed from the current state. */
  constructor(
    message: string,
    readonly status: 400 | 409,
    readonly code: string,
  ) {
    super(message);
    this.name = 'EmploymentTransitionError';
  }
}

const refuse = (code: string, message: string) => new EmploymentTransitionError(message, 409, code);
const invalid = (code: string, message: string) => new EmploymentTransitionError(message, 400, code);

/** BR-LCY-013 (until LCY-M2): the state of a row whose projection is still empty. */
export function effectiveState(e: { employmentState?: EmploymentState | null; isTerminated: boolean }): EmploymentState {
  return e.employmentState ?? (e.isTerminated ? 'TERMINATED' : 'ACTIVE');
}

/** 'YYYY-MM-DD' + n days. */
export function addDayKey(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** What the transition finds (projection + the lineage it acts on). Dates are 'YYYY-MM-DD'. */
export interface CurrentEmployment {
  /** null = no state fact yet (only HIRE may start from here). */
  state: EmploymentState | null;
  terminationDate: string | null;
  exitReason: string | null;
  exitVoluntary: boolean | null;
  joinDate: string;
  /** The period of the current lineage (null: none could be made for the legacy data). */
  period: { id: string; lineageId: string; validFrom: string; validTo: string | null } | null;
  /** The latest state change (the one a D1 / V1 supersedes). */
  latestChangeId: string | null;
  /** V1: the state the employee returns to (the previous lineage's last change), null = none. */
  previousLineageEnd: { terminationDate: string | null; exitReason: string | null; exitVoluntary: boolean | null } | null;
}

export interface TransitionRequest {
  command: EmploymentCommand;
  /** HIRE / REHIRE: first working day. EXIT / NOTICE / TERMINATE / TERMINATE_IN_NOTICE / AMEND: last working day. */
  date: string | null;
  exitReason?: string | null;
  exitVoluntary?: boolean | null;
  /** EXIT from NOTICE: refused (default, the way is D1) or T3n (absconding / article 80 during the notice). */
  fromNotice?: 'REFUSE' | 'TERMINATE_IN_NOTICE';
  /** AMEND only: true when the caller sends the reason (null clears it); false keeps the recorded one. */
  amendsReason?: boolean;
}

export type PeriodAction =
  | { type: 'OPEN'; validFrom: string }
  | { type: 'END'; validTo: string | null }
  | { type: 'VOID' }
  | { type: 'NONE' };

export interface TransitionPlan {
  kind: 'APPLY';
  transition: EmploymentTransition;
  fromState: EmploymentState | null;
  toState: EmploymentState;
  effectiveDate: string;
  terminationDate: string | null;
  exitReason: string | null;
  exitVoluntary: boolean | null;
  period: PeriodAction;
  /** The state change this one replaces (ADR-0002 #3): D1 and V1. */
  supersedes: boolean;
  twoPerson: boolean;
  /** The login stops (with the grace of src/lib/access.ts): the employee became TERMINATED now. */
  endsLogin: boolean;
  /** D1 back to NOTICE (DEC-PO-043): the login is re-enabled by an explicit audited HR step, not here. */
  loginReenableRequired: boolean;
  events: string[];
}

export type PlanResult = TransitionPlan | { kind: 'NO_CHANGE'; transition: EmploymentTransition | null; reason: string };

function need(date: string | null, what: string): string {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw invalid('DATE_REQUIRED', `${what} مطلوب`);
  return date;
}

function reasonOf(r: TransitionRequest): string | null {
  const v = r.exitReason ?? null;
  if (v !== null && !isExitReasonCode(v)) throw invalid('EXIT_REASON', 'سبب الخروج غير صالح: اختر من القائمة');
  return v;
}

/** The exit state for a last working day: NOTICE while it is still ahead (once released), else TERMINATED (BR-LCY-001). */
export function exitStateFor(lastDay: string, today: string, noticeReleased: boolean): EmploymentState {
  return noticeReleased && lastDay > today ? 'NOTICE' : 'TERMINATED';
}

/**
 * Plans one transition from the current employment (lcy-to-be.md §11, BR-LCY-001..007, ARC-LCY-A3).
 * Throws EmploymentTransitionError for a refused move; returns NO_CHANGE for a repeat (same state and
 * same date; the reason is not compared, BR-LCY-006).
 */
export function planTransition(cur: CurrentEmployment, req: TransitionRequest, today: string, noticeReleased: boolean): PlanResult {
  const s = cur.state;
  const exitEvents = (to: EmploymentState) => [to === 'NOTICE' ? 'employment.noticeStarted' : 'employment.terminated'];

  if (req.command === 'HIRE') {
    if (s !== null) throw refuse('ALREADY_EMPLOYED', 'للموظف سجل توظيف قائم؛ إعادة التعيين هي الطريق بعد انتهاء الخدمة');
    const from = need(req.date, 'تاريخ المباشرة');
    return plan('HIRE', null, 'ACTIVE', from, null, null, null, { type: 'OPEN', validFrom: from }, ['employment.hired']);
  }
  if (s === null) throw refuse('NO_EMPLOYMENT', 'لا يوجد سجل توظيف لهذا الموظف');

  if (req.command === 'EXIT') {
    const lastDay = need(req.date, 'آخر يوم عمل');
    if (s === 'ACTIVE') return planTransition(cur, { ...req, command: exitStateFor(lastDay, today, noticeReleased) === 'NOTICE' ? 'NOTICE' : 'TERMINATE' }, today, noticeReleased);
    if (cur.terminationDate === lastDay) return { kind: 'NO_CHANGE', transition: null, reason: 'SAME_STATE_SAME_DATE' };
    if (s === 'NOTICE' && req.fromNotice === 'TERMINATE_IN_NOTICE') return planTransition(cur, { ...req, command: 'TERMINATE_IN_NOTICE' }, today, noticeReleased);
    throw refuse('USE_AMEND', s === 'NOTICE'
      ? 'الموظف في فترة إنذار بتاريخ خروج آخر؛ تغيير التاريخ أو السبب يتم بطلب تصحيح بشخصين'
      : 'انتهت خدمة الموظف بتاريخ آخر؛ تغيير التاريخ أو السبب يتم بطلب تصحيح بشخصين');
  }

  switch (req.command) {
    case 'NOTICE':
    case 'TERMINATE': {
      if (s !== 'ACTIVE') throw refuse('NOT_ACTIVE', 'الموظف ليس على رأس العمل');
      const lastDay = need(req.date, 'آخر يوم عمل');
      if (lastDay < cur.joinDate) throw invalid('BEFORE_JOIN', 'آخر يوم عمل لا يمكن أن يسبق تاريخ المباشرة');
      if (req.command === 'NOTICE' && !noticeReleased) throw refuse('NOTICE_NOT_RELEASED', 'حالة الإنذار لم تُفعَّل بعد (BL-LCY-012)');
      const to = exitStateFor(lastDay, today, noticeReleased);
      if (req.command === 'NOTICE' && to !== 'NOTICE') throw refuse('NOT_FUTURE', 'فترة الإنذار تتطلب آخر يوم عمل بعد اليوم');
      if (req.command === 'TERMINATE' && to !== 'TERMINATED') throw refuse('FUTURE_DATE', 'آخر يوم عمل بعد اليوم: الانتقال إنذار لا إنهاء');
      const reason = reasonOf(req);
      return plan(req.command, 'ACTIVE', to, lastDay, lastDay, reason, req.exitVoluntary ?? null, { type: 'END', validTo: addDayKey(lastDay, 1) }, exitEvents(to));
    }
    case 'NOTICE_END': {
      if (s !== 'NOTICE') throw refuse('NOT_NOTICE', 'الموظف ليس في فترة إنذار');
      if (!cur.terminationDate || cur.terminationDate >= today) throw refuse('NOT_DUE', 'لم يمض آخر يوم عمل بعد');
      return plan('NOTICE_END', 'NOTICE', 'TERMINATED', cur.terminationDate, cur.terminationDate, cur.exitReason, cur.exitVoluntary, { type: 'NONE' }, ['employment.terminated']);
    }
    case 'TERMINATE_IN_NOTICE': {
      if (s !== 'NOTICE') throw refuse('NOT_NOTICE', 'الموظف ليس في فترة إنذار');
      const lastDay = need(req.date, 'آخر يوم عمل');
      if (lastDay > today) throw refuse('FUTURE_DATE', 'الإنهاء أثناء الإنذار يكون بآخر يوم عمل حتى اليوم؛ تأجيل التاريخ تصحيح');
      if (lastDay < cur.joinDate) throw invalid('BEFORE_JOIN', 'آخر يوم عمل لا يمكن أن يسبق تاريخ المباشرة');
      const reason = reasonOf(req);
      return plan('TERMINATE_IN_NOTICE', 'NOTICE', 'TERMINATED', lastDay, lastDay, reason, req.exitVoluntary ?? null, { type: 'END', validTo: addDayKey(lastDay, 1) }, ['employment.terminated', 'employment.exitAmended']);
    }
    case 'CANCEL_EXIT': {
      if (s !== 'NOTICE') throw refuse(s === 'TERMINATED' ? 'USE_REHIRE' : 'NOT_NOTICE', s === 'TERMINATED'
        ? 'انتهت الخدمة؛ العودة بعد آخر يوم عمل تكون بإعادة التعيين'
        : 'الموظف ليس في فترة إنذار');
      if (cur.terminationDate && cur.terminationDate < today) throw refuse('USE_REHIRE', 'مضى آخر يوم عمل؛ العودة تكون بإعادة التعيين (EX-LCY-007)');
      return plan('CANCEL_EXIT', 'NOTICE', 'ACTIVE', today, null, null, null, { type: 'END', validTo: null }, ['employment.exitCancelled']);
    }
    case 'REHIRE': {
      if (s !== 'TERMINATED') throw refuse(s === 'NOTICE' ? 'IN_NOTICE' : 'NOT_TERMINATED', s === 'NOTICE'
        ? 'الموظف ما زال في فترة إنذار (ARC-LCY-A3): إلغاء الخروج هو الطريق'
        : 'الموظف على رأس العمل');
      const from = need(req.date, 'تاريخ المباشرة');
      const prevEnd = cur.period?.validTo ?? (cur.terminationDate ? addDayKey(cur.terminationDate, 1) : null);
      if (prevEnd && from < prevEnd) throw invalid('REHIRE_OVERLAP', 'تاريخ إعادة التعيين يجب أن يكون بعد آخر يوم عمل في الخدمة السابقة');
      return plan('REHIRE', 'TERMINATED', 'ACTIVE', from, null, null, null, { type: 'OPEN', validFrom: from }, ['employment.rehired']);
    }
    case 'AMEND': {
      if (s !== 'NOTICE' && s !== 'TERMINATED') throw refuse('NOT_EXITING', 'لا يوجد خروج لتصحيحه');
      const lastDay = req.date ? need(req.date, 'آخر يوم عمل') : cur.terminationDate;
      if (!lastDay) throw invalid('DATE_REQUIRED', 'آخر يوم عمل مطلوب');
      if (lastDay < cur.joinDate) throw invalid('BEFORE_JOIN', 'آخر يوم عمل لا يمكن أن يسبق تاريخ المباشرة');
      const reason = req.amendsReason ? reasonOf(req) : cur.exitReason;
      const voluntary = req.amendsReason ? (req.exitVoluntary ?? null) : cur.exitVoluntary;
      const to = exitStateFor(lastDay, today, noticeReleased);
      const dateChanged = lastDay !== cur.terminationDate;
      // Same date, reason and state: nothing to correct. A same-date D1 that changes the state is a real
      // correction: a legacy TERMINATED row with a future last day (NOTICE_CANDIDATE of LCY-J1) becomes
      // NOTICE once NOTICE is released (ADR-0004 #3, BL-LCY-012).
      if (!dateChanged && reason === cur.exitReason && voluntary === cur.exitVoluntary && to === s) {
        return { kind: 'NO_CHANGE', transition: 'AMEND', reason: 'NOTHING_TO_CORRECT' };
      }
      const events = ['employment.exitAmended'];
      if (dateChanged) events.push('employment.lastWorkingDayChanged');
      if (s === 'NOTICE' && to === 'TERMINATED') events.push('employment.terminated');
      const p = plan('AMEND', s, to, lastDay, lastDay, reason, voluntary, dateChanged ? { type: 'END', validTo: addDayKey(lastDay, 1) } : { type: 'NONE' }, events);
      p.supersedes = true;
      p.loginReenableRequired = s === 'TERMINATED' && to === 'NOTICE';
      return p;
    }
    case 'VOID': {
      if (s !== 'ACTIVE') throw refuse('NOT_ACTIVE', 'الإبطال لتوظيف قائم بلا خروج؛ مع خروج قائم استخدم التصحيح');
      if (!cur.period) throw refuse('NO_PERIOD', 'لا توجد فترة توظيف لإبطالها');
      const prev = cur.previousLineageEnd;
      const p = plan('VOID', 'ACTIVE', 'TERMINATED', today, prev?.terminationDate ?? null, prev?.exitReason ?? null, prev?.exitVoluntary ?? null, { type: 'VOID' }, ['employment.voided']);
      p.supersedes = true;
      return p;
    }
    default:
      throw invalid('UNKNOWN_TRANSITION', `unknown employment transition ${String(req.command)}`);
  }

  function plan(
    transition: EmploymentTransition,
    fromState: EmploymentState | null,
    toState: EmploymentState,
    effectiveDate: string,
    terminationDate: string | null,
    exitReason: string | null,
    exitVoluntary: boolean | null,
    period: PeriodAction,
    events: string[],
  ): TransitionPlan {
    return {
      kind: 'APPLY',
      transition,
      fromState,
      toState,
      effectiveDate,
      terminationDate,
      exitReason,
      exitVoluntary,
      period,
      supersedes: false,
      twoPerson: TWO_PERSON_TRANSITIONS.includes(transition),
      endsLogin: toState === 'TERMINATED' && fromState !== 'TERMINATED',
      loginReenableRequired: false,
      events,
    };
  }
}

/** Legacy mirror of the state (employmentStatus, frozen then dropped with BL-LCY-009). */
export function legacyStatusOf(state: EmploymentState): 'ACTIVE' | 'EXCLUDED' {
  return state === 'TERMINATED' ? 'EXCLUDED' : 'ACTIVE';
}
