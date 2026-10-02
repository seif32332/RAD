// The L4 gate (ARCHITECTURE_INVARIANTS §4.3 rule 3): every approval and payment calls
// assertNoBlockingDiscrepancies inside its own transaction, before its state change. It refuses when a
// discrepancy with blocking = true AND status = OPEN exists IN THE SCOPE OF THE OPERATION ONLY:
//   - the operation must be in the finding's `blocks` (a report finding does not stop payroll);
//   - the company of the operation (payroll approval: that company and that month);
//   - with employeeIds (settlement payment: that employee), the company-wide findings of the company
//     plus the findings of those employees, including tenant-level ones (companyId NULL);
//   - with a period, the findings of that month plus the ones without a period.
// A pending explanation or waiver (waiting for the second person, or for the owner's confirmation of
// INV-PAY-03 in SINGLE_OPERATOR) is still OPEN, so it still blocks.
import type { Prisma, PrismaClient } from '@prisma/client';
import { HttpError } from '@/lib/http';
import { GATED_OPERATIONS, type GatedOperation } from './types';

type Db = PrismaClient | Prisma.TransactionClient;

export interface GateScope {
  operation: GatedOperation;
  companyId: string;
  /** The employees the operation touches (a settlement, a payroll subset). */
  employeeIds?: readonly string[];
  /** YYYY-MM of the payroll month the operation works on. */
  period?: string;
}

export interface Blocker {
  id: string;
  ruleId: string;
  checkId: string;
  severity: string;
  companyId: string | null;
  subjectEmployeeId: string | null;
  entityType: string;
  entityId: string;
  period: string | null;
  pendingAction: string | null;
}

/** 409 listing the blockers (at most MAX_LISTED; `total` is the full count). */
export class BlockingDiscrepanciesError extends HttpError {
  readonly operation: GatedOperation;
  readonly blockers: Blocker[];
  readonly total: number;
  constructor(operation: GatedOperation, blockers: Blocker[], total: number) {
    super(409, 'لا يمكن تنفيذ العملية: توجد اختلافات موقِفة مفتوحة في بيانات هذه العملية. راجع لوحة سلامة البيانات.', {
      code: 'BLOCKING_DISCREPANCIES',
      operation,
      total,
      blockers,
    });
    this.name = 'BlockingDiscrepanciesError';
    this.operation = operation;
    this.blockers = blockers;
    this.total = total;
  }
}

export const MAX_LISTED = 50;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

/** The Prisma filter of the gate (exported for the tests and the dashboard). */
export function blockingWhere(scope: GateScope): Prisma.DiscrepancyWhereInput {
  if (!GATED_OPERATIONS.includes(scope.operation)) throw new Error(`L4 gate: unknown operation "${scope.operation}"`);
  if (!scope.companyId?.trim()) throw new Error('L4 gate: companyId is required (the gate is scoped to the operation)');
  if (scope.period !== undefined && !PERIOD.test(scope.period)) throw new Error(`L4 gate: period must be YYYY-MM, got "${scope.period}"`);
  const employeeIds = scope.employeeIds ? [...new Set(scope.employeeIds)] : undefined;
  const and: Prisma.DiscrepancyWhereInput[] = [];
  if (employeeIds) {
    and.push({
      OR: [
        { companyId: scope.companyId, subjectEmployeeId: null },
        ...(employeeIds.length ? [{ subjectEmployeeId: { in: employeeIds } }] : []),
      ],
    });
  } else {
    and.push({ companyId: scope.companyId });
  }
  if (scope.period) and.push({ OR: [{ period: null }, { period: scope.period }] });
  return { status: 'OPEN', blocking: true, blocks: { has: scope.operation }, AND: and };
}

/** The open blockers of an operation (read only; the gate below throws on them). */
export async function listBlockingDiscrepancies(db: Db, scope: GateScope): Promise<{ blockers: Blocker[]; total: number }> {
  const where = blockingWhere(scope);
  const [blockers, total] = await Promise.all([
    db.discrepancy.findMany({
      where,
      orderBy: [{ detectedAt: 'asc' }, { id: 'asc' }],
      take: MAX_LISTED,
      select: { id: true, ruleId: true, checkId: true, severity: true, companyId: true, subjectEmployeeId: true, entityType: true, entityId: true, period: true, pendingAction: true },
    }),
    db.discrepancy.count({ where }),
  ]);
  return { blockers, total };
}

/**
 * The L4 gate. Call it with the transaction of the approval or payment (so the check and the state
 * change see the same data), before the change. Throws BlockingDiscrepanciesError (HTTP 409) listing
 * the blockers; returns nothing when the operation may proceed.
 */
export async function assertNoBlockingDiscrepancies(db: Db, scope: GateScope): Promise<void> {
  const { blockers, total } = await listBlockingDiscrepancies(db, scope);
  if (total > 0) throw new BlockingDiscrepanciesError(scope.operation, blockers, total);
}
