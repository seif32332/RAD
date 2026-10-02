// org transitions. P1-FND-EFF ships the minimal applyAssignment (ARC-SYS-A3, ADR-0002 #8): the sole
// writer of AssignmentPeriod (through platform/effective) and of the Employee assignment projection.
// P3-ORG extends it (position, cost centre, work pattern, scheduled chains, the unified transfer
// decision). No existing route calls it yet; moving the routes is later work.
import {
  activeAt,
  closePeriod,
  openPeriod,
  periodsOf,
  runTransition,
  supersedePeriod,
  toDateOnly,
  type AssignmentAttrs,
  type AuditActor,
  type DateOnly,
  type PeriodView,
  type RootClient,
  type TxClient,
} from '@/modules/platform';
import { todayKey } from '@/lib/dates';
import { workPatternById } from '@/modules/calendar';

export class AssignmentPlacementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssignmentPlacementError';
  }
}

export class AssignmentScopeError extends Error {
  constructor(companyId: string) {
    super(`company ${companyId} is outside the caller's company scope`);
    this.name = 'AssignmentScopeError';
  }
}

export class AssignmentScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssignmentScheduleError';
  }
}

export interface ApplyAssignmentInput {
  employeeId: string;
  /** First day of the new assignment (inclusive). */
  validFrom: DateOnly;
  /** Exclusive end when known (e.g. a temporary assignment); default: the end of the period it replaces, else open. */
  validTo?: DateOnly | null;
  assignment: AssignmentAttrs;
  /** The decision behind it: ONBOARDING, TRANSFER_DECISION, CHANGE_ORDER… (its id is sourceId). */
  source: { type: string; id: string };
  /**
   * The caller's companies (the CompanySet of an iam ScopeContext), or 'ALL' / null for an explicit
   * cross-company context. Moving an employee between two companies needs both in scope
   * (DOMAIN_BOUNDARIES §5.4.3).
   */
  companyIds: readonly string[] | 'ALL' | null;
}

export interface ApplyAssignmentOp {
  /** Idempotency-Key of the request, or derived from (actor, employee, decision, version). */
  key: string;
  actor: AuditActor;
  reason?: string | null;
}

export interface ApplyAssignmentResult {
  period: PeriodView<'ASSIGNMENT'>;
  /** false: the assignment already said exactly this on that day (nothing written). */
  changed: boolean;
  /** CORRECTION (same first day) | SPLIT (the running period ends, the new one starts) | OPENED (no period that day). */
  mode: 'UNCHANGED' | 'CORRECTION' | 'SPLIT' | 'OPENED';
  /** The Employee projection was written (the new period is in force today). */
  projected: boolean;
}

const ATTR_KEYS = ['legalCompanyId', 'actualCompanyId', 'branchId', 'departmentId', 'managerId', 'workPatternId'] as const;

function normalized(a: AssignmentAttrs): Record<(typeof ATTR_KEYS)[number], string | null> {
  return {
    legalCompanyId: a.legalCompanyId,
    actualCompanyId: a.actualCompanyId ?? null,
    branchId: a.branchId ?? null,
    departmentId: a.departmentId ?? null,
    managerId: a.managerId ?? null,
    workPatternId: a.workPatternId ?? null,
  };
}

function sameAssignment(view: PeriodView<'ASSIGNMENT'>, a: AssignmentAttrs): boolean {
  const n = normalized(a);
  return ATTR_KEYS.every((k) => (view.attrs[k] ?? null) === n[k]);
}

/** INV-ORG-01 at the gateway: the department is in the branch, the branch in the (actual, else legal) company. */
async function assertPlacement(tx: TxClient, a: AssignmentAttrs): Promise<void> {
  if (a.departmentId && !a.branchId) throw new AssignmentPlacementError('a department needs its branch');
  if (a.branchId) {
    const branch = await tx.branch.findUnique({ where: { id: a.branchId }, select: { companyId: true } });
    if (!branch) throw new AssignmentPlacementError(`branch ${a.branchId} not found`);
    const company = a.actualCompanyId ?? a.legalCompanyId;
    if (branch.companyId !== company) throw new AssignmentPlacementError(`branch ${a.branchId} does not belong to company ${company} (INV-ORG-01)`);
  }
  if (a.departmentId) {
    const dept = await tx.department.findUnique({ where: { id: a.departmentId }, select: { branchId: true } });
    if (!dept) throw new AssignmentPlacementError(`department ${a.departmentId} not found`);
    if (dept.branchId !== a.branchId) throw new AssignmentPlacementError(`department ${a.departmentId} does not belong to branch ${a.branchId} (INV-ORG-01)`);
  }
  if (a.workPatternId) {
    // P1-CAL: the work pattern is one of the branch's patterns (calendar owns WorkPattern).
    const pattern = await workPatternById(tx, a.workPatternId);
    if (!pattern) throw new AssignmentPlacementError(`work pattern ${a.workPatternId} not found`);
    if (!a.branchId || pattern.branchId !== a.branchId) throw new AssignmentPlacementError(`work pattern ${a.workPatternId} does not belong to branch ${a.branchId}`);
    if (pattern.archivedAt) throw new AssignmentPlacementError(`work pattern ${a.workPatternId} is archived`);
  }
}

function assertScope(companyIds: readonly string[] | 'ALL' | null, companies: (string | null | undefined)[]): void {
  if (companyIds === null || companyIds === 'ALL') return;
  for (const c of companies) if (c && !companyIds.includes(c)) throw new AssignmentScopeError(c);
}

function inForceToday(p: PeriodView<'ASSIGNMENT'>): boolean {
  const today = todayKey();
  return p.validFrom <= today && (p.validTo === null || p.validTo > today);
}

/**
 * Applies an assignment from `validFrom`: the sole writer of AssignmentPeriod (via platform/effective)
 * and of Employee.legalCompanyId / actualCompanyId / branchId / departmentId / directManagerId /
 * workPatternId (P1-CAL).
 * Idempotent on op.key: a repeat, sequential or concurrent, returns the first result.
 */
export async function applyAssignment(prisma: RootClient, input: ApplyAssignmentInput, op: ApplyAssignmentOp) {
  if (!input?.employeeId?.trim()) throw new AssignmentPlacementError('employeeId is required');
  if (!input.assignment?.legalCompanyId?.trim()) throw new AssignmentPlacementError('legalCompanyId is required');
  if (!('companyIds' in input)) throw new AssignmentScopeError('(no scope given)');
  const validFrom = toDateOnly(input.validFrom, 'validFrom');
  const from = validFrom.toISOString().slice(0, 10);

  return runTransition<ApplyAssignmentResult>(
    prisma,
    { key: op.key, operation: 'org.assignment.apply', actorId: op.actor.type === 'USER' ? op.actor.id : null, companyId: input.assignment.legalCompanyId },
    async (tx) => {
      await assertPlacement(tx, input.assignment);
      const current = await activeAt(tx, 'ASSIGNMENT', input.employeeId, validFrom);
      assertScope(input.companyIds, [input.assignment.legalCompanyId, current?.attrs.legalCompanyId as string | undefined]);

      const later = (await periodsOf(tx, 'ASSIGNMENT', input.employeeId)).filter((p) => p.validFrom > from);
      if (later.length) {
        throw new AssignmentScheduleError(`employee ${input.employeeId} has an assignment starting after ${from} (${later[0].validFrom}); scheduled chains are P3-ORG`);
      }

      const periodOp = { key: op.key, actor: op.actor, companyId: input.assignment.legalCompanyId, reason: op.reason ?? null };
      const explicitTo = input.validTo === undefined ? undefined : input.validTo === null ? null : toDateOnly(input.validTo, 'validTo');
      let period: PeriodView<'ASSIGNMENT'>;
      let mode: ApplyAssignmentResult['mode'];

      if (current && sameAssignment(current, input.assignment) && explicitTo === undefined) {
        return { period: current, changed: false, mode: 'UNCHANGED', projected: false };
      }
      if (current && current.validFrom === from) {
        const r = await supersedePeriod(tx, 'ASSIGNMENT', current.id, {
          reason: 'CORRECTION',
          source: input.source,
          successor: { validTo: explicitTo === undefined ? undefined : explicitTo, attrs: normalized(input.assignment) as AssignmentAttrs },
        }, periodOp);
        period = r.successor as PeriodView<'ASSIGNMENT'>;
        mode = 'CORRECTION';
      } else if (current) {
        await closePeriod(tx, 'ASSIGNMENT', current.id, { validTo: validFrom, source: input.source }, periodOp);
        const r = await openPeriod(tx, 'ASSIGNMENT', {
          employeeId: input.employeeId,
          validFrom,
          validTo: explicitTo === undefined ? current.validTo : explicitTo,
          source: input.source,
          attrs: input.assignment,
        }, periodOp);
        period = r.period;
        mode = 'SPLIT';
      } else {
        const r = await openPeriod(tx, 'ASSIGNMENT', {
          employeeId: input.employeeId,
          validFrom,
          validTo: explicitTo ?? null,
          source: input.source,
          attrs: input.assignment,
        }, periodOp);
        period = r.period;
        mode = 'OPENED';
      }

      // Projection (SOURCE_OF_TRUTH §3.1): written by its projector in the fact's transaction, when
      // the new period is in force today. A future-dated period is projected when it starts (P3-ORG job).
      let projected = false;
      if (inForceToday(period)) {
        const n = normalized(input.assignment);
        await tx.employee.update({
          where: { id: input.employeeId },
          data: {
            legalCompanyId: n.legalCompanyId,
            actualCompanyId: n.actualCompanyId,
            branchId: n.branchId,
            departmentId: n.departmentId,
            directManagerId: n.managerId,
            workPatternId: n.workPatternId,
          },
        });
        projected = true;
      }
      return { period, changed: true, mode, projected };
    },
  );
}
