// Read-only reconciliation checks (master plan P0-10), for application code.
//
// The rules are defined once, in scripts/lib/reconciliation-checks.mjs: the CLI report
// (scripts/reconcile-report.mjs) runs with plain node from a release that ships scripts/ but not
// src/, and plain node cannot import TypeScript. This facade is the import path for src/ (the
// future reconcile job and gate of P1-FND-INV), so nothing is re-implemented here.
export {
  CHECKS,
  CHECK_ENTITY_TYPES,
  NO_COMPANY,
  SAMPLE_SIZE,
  SEVERITY,
  checkDoc01,
  checkLcy01,
  checkOrg01,
  checkPay01,
  checkPay02,
  deductionBreakdown,
  formatSummary,
  halalas,
  payrollLineProblems,
  readAll,
  runReconciliation,
  runReconciliationReadOnly,
} from '../../../scripts/lib/reconciliation-checks.mjs';
import { findingEntities as ruleFileEntities } from '../../../scripts/lib/reconciliation-checks.mjs';

/**
 * The violating rows of a result: the ones a check of the rules file recorded, or `result.entities`
 * for a check an owning module registers itself (registerInvariantCheck, e.g. rules' INV-RULE-02).
 */
export function findingEntities(result: ReconciliationResult): ReconciliationEntity[] {
  return result.entities ?? (ruleFileEntities(result) as ReconciliationEntity[]);
}

export type ReconciliationSeverity = 'BLOCKING' | 'HIGH' | 'WARNING' | 'INFO';

export interface ReconciliationResult {
  invariant: string;
  check: string;
  severity: ReconciliationSeverity;
  labelAr: string;
  labelEn: string;
  /** Table of the reported rows (CHECK_ENTITY_TYPES). */
  entityType: string | null;
  count: number;
  sampleIds: string[];
  byCompany: Record<string, number>;
  detail: Record<string, number>;
  note: string;
  approximation: string | null;
  /** The violating rows, for a check that is not in the rules file (see findingEntities). */
  entities?: ReconciliationEntity[];
}

/** One violating row of a result (findingEntities). */
export interface ReconciliationEntity {
  id: string;
  companyId: string | null;
  tag: string | null;
  employeeId: string | null;
  /** YYYY-MM when the row belongs to a payroll month. */
  period: string | null;
  /**
   * The finding is already explained by a recorded fact (e.g. DEC-PO-126: the company's acknowledgement
   * of an override outside the legal bound). Reconcile records it EXPLAINED at detection, for a
   * non-integrity, non-blocking invariant only.
   */
  explained?: { category: string; text: string; ref: string; by: string };
}

export interface ReconciliationReport {
  generatedAt: string;
  readOnlyTransaction: boolean;
  results: ReconciliationResult[];
}
