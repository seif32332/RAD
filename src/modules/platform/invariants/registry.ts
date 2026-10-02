// Invariant registry (P1-FND-INV; ARCHITECTURE_INVARIANTS §4.2): id, severity, blocking scope, owner
// and, when measured, the check.
//
// Where the rules live. The check functions are the phase-0 rules of scripts/lib/reconciliation-checks.mjs,
// imported through the typed facade src/lib/reconciliation/checks.ts, not re-implemented here:
//   - one definition: the read-only CLI report (scripts/reconcile-report.mjs) and this engine run the
//     same code, so the report and the Discrepancy table cannot disagree;
//   - the Docker runtime image ships scripts/ but not src/ (Dockerfile), and plain node cannot import
//     TypeScript, so the CLI needs the rules in .mjs;
//   - platform must not read other modules' tables itself (ARCH-001); the rules file takes the database
//     client as a parameter. When an owning module ships its read interface (payroll, lifecycle, org,
//     documents), its invariant's `check` moves behind that interface and the .mjs rule is retired.
// This file holds what the rules file does not: severity policy, blocking scope, integrity (DEC-PO-120).
import { INV_DOC_01 } from './inv-doc-01';
import { INV_LCY_01 } from './inv-lcy-01';
import { INV_ORG_01 } from './inv-org-01';
import { INV_PAY_01 } from './inv-pay-01';
import { INV_PAY_02 } from './inv-pay-02';
import { INV_RULE_02 } from './inv-rule-02';
import { PLANNED_INVARIANTS } from './planned';
import { SEVERITIES, type GatedOperation, type InvariantCheck, type InvariantDefinition, type Severity } from './types';

/** Every invariant of §4.2.1, measured ones first. Frozen: integrity invariants are not settings. */
export const INVARIANTS: readonly InvariantDefinition[] = Object.freeze(
  [INV_LCY_01, INV_ORG_01, INV_PAY_01, INV_PAY_02, INV_DOC_01, INV_RULE_02, ...PLANNED_INVARIANTS].map((d) => Object.freeze({ ...d, blocks: Object.freeze([...d.blocks]) })),
);

const BY_ID = new Map(INVARIANTS.map((d) => [d.id, d]));

/**
 * Checks registered by the owning module of an invariant (its read interface, ARCH-001): platform sits
 * below every module (§5.3) and cannot import them, so a module above hands its check down, like an
 * event consumer. The composition roots (src/jobs, the integrity route) register them at start-up.
 */
const REGISTERED_CHECKS = new Map<string, InvariantCheck>();

/**
 * Registers the check of a defined invariant that has none in this file. Idempotent for the same
 * function; a second, different check for the same id, an unknown id or an invariant that already has
 * a check throws.
 */
export function registerInvariantCheck(id: string, check: InvariantCheck): void {
  const def = BY_ID.get(id);
  if (!def) throw new Error(`registerInvariantCheck: unknown invariant ${id}`);
  if (def.check) throw new Error(`registerInvariantCheck: ${id} already has its check in the registry`);
  const existing = REGISTERED_CHECKS.get(id);
  if (existing && existing !== check) throw new Error(`registerInvariantCheck: ${id} already has a registered check`);
  REGISTERED_CHECKS.set(id, check);
}

function withRegisteredCheck(d: InvariantDefinition): InvariantDefinition {
  const check = REGISTERED_CHECKS.get(d.id);
  return check && !d.check ? { ...d, check } : d;
}

export function invariantById(id: string): InvariantDefinition | undefined {
  const d = BY_ID.get(id);
  return d && withRegisteredCheck(d);
}

/** The invariants with a check (the ones reconcile runs today), including the registered ones. */
export function measuredInvariants(): InvariantDefinition[] {
  return INVARIANTS.map(withRegisteredCheck).filter((d) => typeof d.check === 'function');
}

export function severityRank(s: Severity): number {
  return SEVERITIES.indexOf(s);
}

export class IntegrityInvariantPolicyError extends Error {
  constructor(id: string) {
    super(`${id} is an integrity invariant (DEC-PO-120): a company cannot disable it or lower its severity`);
    this.name = 'IntegrityInvariantPolicyError';
  }
}

/**
 * Severity of a finding: the sub-check's own severity (the rules file sets it). A company override
 * (DEC-PO-116; no override store exists yet, CompanyRuleOverride is P1-RULE) replaces the invariant's
 * default for the sub-checks at or above that default. It may lower a policy invariant, never an
 * integrity invariant (DEC-PO-120): lowering one throws.
 */
export function effectiveSeverity(def: InvariantDefinition, checkSeverity: Severity, companyOverride?: Severity | null): Severity {
  if (!companyOverride) return checkSeverity;
  if (def.integrity && severityRank(companyOverride) < severityRank(def.severity)) throw new IntegrityInvariantPolicyError(def.id);
  // The override replaces the invariant's default; sub-checks below the default stay where they are.
  if (severityRank(checkSeverity) < severityRank(def.severity)) return checkSeverity;
  return companyOverride;
}

/** §4.3: `blocking` is computed from the severity and the rule's blocking scope, and stored at detection. */
export function isBlocking(def: InvariantDefinition, severity: Severity): boolean {
  return def.blocks.length > 0 && severityRank(severity) >= severityRank('HIGH');
}

/** The operations a finding blocks (empty when it does not block). */
export function blockedOperations(def: InvariantDefinition, severity: Severity): GatedOperation[] {
  return isBlocking(def, severity) ? [...def.blocks] : [];
}
