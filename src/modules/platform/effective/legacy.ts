// Legacy opening (ARC-SYS-A3). The ONE writer of LEGACY_OPENING periods is the SQL function
// effective_open_legacy_period() of migration 9u; this file only calls it (and the backfill that
// the migration already ran once), so the rule has a single definition. Legacy openings emit no
// DomainEvent (a data migration is not a business event; J1 of ARC-LCY-A2 does the same) but every
// opened row gets its audit record.
import { audit, type AuditActor } from '../audit';
import { callBackfillLegacyOpenings, callOpenLegacyPeriod, type BackfillRow } from '../sql/effective';
import { assertTransactionClient, type TxClient } from '../tx';
import { kindSpec, type PeriodAttrsByKind, type PeriodKind } from './kinds';
import { assertRange, attrsToData, dayKey, toDateOnly, type DateOnly } from './shape';

export interface OpenLegacyInput<K extends PeriodKind> {
  employeeId: string;
  validFrom: DateOnly;
  validTo?: DateOnly | null;
  attrs: PeriodAttrsByKind[K];
}

export interface OpenLegacyResult {
  periodId: string | null;
  outcome: 'OPENED' | 'ALREADY_OPENED' | 'SKIPPED_HAS_PERIODS';
}

/**
 * Opens the LEGACY_OPENING period of one employee and kind, at most once ever (a partial unique
 * index backs this): a repeat returns ALREADY_OPENED, and a kind that already has periods for the
 * employee is not opened under them (SKIPPED_HAS_PERIODS). For the migrations of later period
 * tables and for tenants restored from a pre-9u backup.
 */
export async function openLegacyPeriod<K extends PeriodKind>(tx: TxClient, kind: K, input: OpenLegacyInput<K>, actor: AuditActor): Promise<OpenLegacyResult> {
  assertTransactionClient(tx, 'openLegacyPeriod');
  const spec = kindSpec(kind);
  const validFrom = toDateOnly(input.validFrom, 'validFrom');
  const validTo = input.validTo === undefined || input.validTo === null ? null : toDateOnly(input.validTo, 'validTo');
  assertRange(validFrom, validTo);
  const attrs = attrsToData(kind, input.employeeId, input.attrs);
  const createdById = actor.type === 'USER' ? actor.id : null;
  const row = await callOpenLegacyPeriod(tx, {
    kind,
    employeeId: input.employeeId,
    validFrom: dayKey(validFrom),
    validTo: validTo ? dayKey(validTo) : null,
    attrs,
    createdById,
  });
  const outcome = row.outcome as OpenLegacyResult['outcome'];
  if (outcome === 'OPENED') {
    await audit(tx, {
      actor,
      action: `${spec.eventDomain}.period.legacyOpen`,
      entity: { type: spec.model, id: row.periodId, companyId: kind === 'ASSIGNMENT' ? String(attrs.legalCompanyId) : null },
      before: null,
      after: { employeeId: input.employeeId, validFrom: dayKey(validFrom), validTo: validTo ? dayKey(validTo) : null, attrs },
      reason: 'LEGACY_OPENING (ARC-SYS-A3)',
    });
  }
  return { periodId: row.periodId, outcome };
}

/**
 * The P1-FND-EFF backfill (already run once by migration 9u for every employee). Idempotent: a
 * repeat reports ALREADY_OPENED. Employees whose data cannot make a valid period are SKIPPED with a
 * reason and listed. `companyIds` null = every company (named cross-company data migration).
 */
export async function backfillLegacyOpenings(tx: TxClient, companyIds: readonly string[] | null, actor: string): Promise<BackfillRow[]> {
  assertTransactionClient(tx, 'backfillLegacyOpenings');
  if (companyIds !== null && !Array.isArray(companyIds)) throw new Error('companyIds must be an array or null');
  return callBackfillLegacyOpenings(tx, companyIds, actor);
}

export type { BackfillRow };
