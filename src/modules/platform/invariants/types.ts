// Invariant engine types (P1-FND-INV; ARCHITECTURE_INVARIANTS §4.2, §4.3).
import type { ReconciliationResult } from '@/lib/reconciliation/checks';

export const SEVERITIES = ['INFO', 'WARNING', 'HIGH', 'BLOCKING'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const DISCREPANCY_STATUSES = ['OPEN', 'EXPLAINED', 'RESOLVED', 'WAIVED', 'AUTO_CLOSED'] as const;
export type DiscrepancyStatus = (typeof DISCREPANCY_STATUSES)[number];

/** Waiting for the second person (or, for INV-PAY-03 in SINGLE_OPERATOR, the owner confirmation). */
export type PendingAction = 'EXPLANATION' | 'WAIVER';
export type OwnerConfirmation = 'PENDING' | 'CONFIRMED' | 'REJECTED';

export type RunTrigger = 'SCHEDULED' | 'MANUAL' | 'PRE_OPERATION';

/**
 * Operations the L4 gate guards (§4.3 rule 3: blocking is scoped to the operation). Each approval and
 * payment names its operation when it calls assertNoBlockingDiscrepancies.
 */
export const GATED_OPERATIONS = [
  'payroll.approve',
  'payroll.export',
  'payroll.pay',
  'payroll.close',
  'settlement.approve',
  'settlement.pay',
  'document.issue',
] as const;
export type GatedOperation = (typeof GATED_OPERATIONS)[number];

/**
 * Tenant operator mode (DEC-PO-018). ENFORCED: every two-person condition applies. SINGLE_OPERATOR:
 * the sole operator may explain or waive alone with a SELF_ACT_SINGLE_OPERATOR record and the
 * owner's confirmation over the DEC-PO-022 channel (ADR-0002 #1).
 */
export type OperatorMode = 'ENFORCED' | 'SINGLE_OPERATOR';

/** The owning module of an invariant (DOMAIN_BOUNDARIES §5.2 names). */
export type InvariantOwner =
  | 'platform'
  | 'iam'
  | 'rules'
  | 'org'
  | 'lifecycle'
  | 'compensation'
  | 'time'
  | 'leave'
  | 'payroll'
  | 'offboarding'
  | 'documents'
  | 'workflow'
  | 'reporting';

/** Runs the invariant's sub-checks on a database client (read only) and returns their results. */
export type InvariantCheck = (db: unknown, ctx: Record<string, unknown>, opts: Record<string, unknown>) => Promise<ReconciliationResult[]>;

export interface InvariantDefinition {
  /** INV-… id of ARCHITECTURE_INVARIANTS §4.2.1. */
  id: string;
  titleAr: string;
  owner: InvariantOwner;
  /** Default severity of the invariant (§4.2.1). Sub-checks carry their own severity (≤ this one). */
  severity: Severity;
  /**
   * Integrity invariant (DEC-PO-120, amended by DEC-PO-122): fixed, not a company setting. A company
   * cannot disable it or lower its severity; its findings are only EXPLAINED (second person) or
   * WAIVED (two people + owner alert), or, in SINGLE_OPERATOR, by the sole operator with the owner's
   * confirmation.
   */
  integrity: boolean;
  /** Operations an OPEN blocking finding of this invariant blocks (empty = never blocks). */
  blocks: readonly GatedOperation[];
  /**
   * ADR-0002 #1 / DEC-PO-014: in SINGLE_OPERATOR the owner confirmation itself blocks (the WPS file is
   * not sent before it). Only INV-PAY-03.
   */
  ownerConfirmationBlocks?: boolean;
  /** EXPECTED categories of the invariant (§4.0); closed automatically when their condition is proven. */
  expectedCategories?: readonly string[];
  /** The check, when the invariant is measured today; absent = defined but not measured yet. */
  check?: InvariantCheck;
  /** What the check measures instead of the exact wording, while the target tables do not exist. */
  note?: string;
}
