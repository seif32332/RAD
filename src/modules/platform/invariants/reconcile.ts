// The reconcile job (P1-FND-INV; ARCHITECTURE_INVARIANTS §4.3 rule 1).
//
//   1. takeInvariantSnapshot: every measured invariant runs in ONE REPEATABLE READ, READ ONLY
//      transaction (PostgreSQL refuses any write by a check; one consistent snapshot).
//   2. recordInvariantResults: for one company (or the tenant-level pass, companyId null), in a
//      separate write transaction serialised per company: open / update / reopen / auto-close the
//      Discrepancy rows by fingerprint, one InvariantRun row per invariant, audit rows for every status
//      change and the events.
//
// Company by company, as every non cross-company job (DOMAIN_BOUNDARIES §5.4.2). platform sits below
// iam (§5.3) and cannot call iam.forEachCompany; the caller (the job runner of P1-FND-JOBS, or the
// owner dashboard route) does:
//
//   const snap = await takeInvariantSnapshot(prisma, { trigger: 'SCHEDULED' });
//   await forEachCompany(companyIds, 'reconcile', (ctx) => recordInvariantResults(prisma, snap, { companyId: ctx.companies[0] }));
//   await recordInvariantResults(prisma, snap, { companyId: null }); // findings without a company
//
// `reconcile({ companyId })` is the one-company shortcut (snapshot + record).
//
// Idempotent: a repeated run over the same data finds the same fingerprints and changes no row's
// status (lastSeenAt / lastRunId only); `occurrences` counts detections (1 + reopenings), not runs.
import { createHash, randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { findingEntities, type ReconciliationResult } from '@/lib/reconciliation/checks';
import { audit } from '../audit';
import { emitEvent } from '../events';
import { beginReadOnlySnapshot, lockReconcileWrites } from '../sql/invariants';
import type { RootClient, TxClient } from '../tx';
import { blockedOperations, effectiveSeverity, invariantById, measuredInvariants } from './registry';
import type { InvariantDefinition, RunTrigger, Severity } from './types';

/** Key of the tenant-level pass (findings without a company) in locks, events and summaries. */
export const TENANT_LEVEL = '(tenant)';
const RECONCILE_ACTOR = { type: 'SYSTEM' as const, id: 'reconcile' };
/** Statuses reconcile may close when the finding is gone. */
const CLOSABLE: string[] = ['OPEN', 'EXPLAINED', 'WAIVED'];
const IN_CHUNK = 1000;

export interface Finding {
  fingerprint: string;
  ruleId: string;
  checkId: string;
  domain: string;
  companyId: string | null;
  subjectEmployeeId: string | null;
  entityType: string;
  entityId: string;
  period: string | null;
  severity: Severity;
  blocking: boolean;
  blocks: string[];
  /** What was observed: the rule's tag (kind / status) of the row. */
  actualValue: { tag: string | null };
  /**
   * Already explained by a recorded fact (ReconciliationEntity.explained): recorded EXPLAINED at
   * detection. Only for a non-integrity invariant whose finding blocks nothing.
   */
  explained: { category: string; text: string; ref: string; by: string } | null;
}

export interface InvariantOutcome {
  ruleId: string;
  status: 'SUCCEEDED' | 'FAILED';
  error: string | null;
  startedAt: Date;
  finishedAt: Date;
  results: ReconciliationResult[];
  /** Non-INFO findings (INFO results are counted in InvariantRun.results only). */
  findings: Finding[];
}

export interface InvariantSnapshot {
  runId: string;
  trigger: RunTrigger;
  snapshotAt: Date;
  outcomes: InvariantOutcome[];
}

export interface SnapshotOptions {
  trigger?: RunTrigger;
  /** Only these invariants (INV ids); default every measured invariant. */
  invariants?: readonly string[];
  /** UPLOAD_DIR for INV-DOC-01 file hashes (default process.env.UPLOAD_DIR). */
  uploadDir?: string;
  timeoutMs?: number;
}

export interface CompanyReconcileSummary {
  runId: string;
  companyId: string | null;
  found: number;
  opened: number;
  reopened: number;
  autoClosed: number;
  failedInvariants: string[];
}

export function fingerprintOf(parts: { ruleId: string; checkId: string; entityType: string; entityId: string; period: string | null }): string {
  return createHash('sha256').update([parts.ruleId, parts.checkId, parts.entityType, parts.entityId, parts.period ?? ''].join('|')).digest('hex');
}

/** The findings of one invariant's results (pure; also used by resolveDiscrepancy to verify a fix). */
export function findingsOf(def: InvariantDefinition, results: readonly ReconciliationResult[]): Finding[] {
  const out: Finding[] = [];
  for (const r of results) {
    if (r.severity === 'INFO' || r.count === 0) continue;
    const severity = effectiveSeverity(def, r.severity);
    const blocks = blockedOperations(def, severity);
    const entityType = r.entityType ?? 'Unknown';
    for (const e of findingEntities(r)) {
      out.push({
        fingerprint: fingerprintOf({ ruleId: def.id, checkId: r.check, entityType, entityId: e.id, period: e.period }),
        ruleId: def.id,
        checkId: r.check,
        domain: def.owner,
        companyId: e.companyId,
        subjectEmployeeId: e.employeeId,
        entityType,
        entityId: e.id,
        period: e.period,
        severity,
        blocking: blocks.length > 0,
        blocks,
        actualValue: { tag: e.tag },
        explained: e.explained && !def.integrity && blocks.length === 0 ? e.explained : null,
      });
    }
  }
  return out;
}

function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.slice(0, 2000) || 'unknown error';
}

/** Step 1: every measured invariant (or `invariants`) in one READ ONLY snapshot. Writes nothing. */
export async function takeInvariantSnapshot(prisma: RootClient, opts: SnapshotOptions = {}): Promise<InvariantSnapshot> {
  const defs = measuredInvariants().filter((d) => !opts.invariants || opts.invariants.includes(d.id));
  if (opts.invariants) {
    for (const id of opts.invariants) if (!defs.some((d) => d.id === id)) throw new Error(`reconcile: ${id} is not a measured invariant`);
  }
  const runId = randomUUID();
  const checkOpts = { uploadDir: opts.uploadDir ?? process.env.UPLOAD_DIR };
  return prisma.$transaction(
    async (tx) => {
      await beginReadOnlySnapshot(tx);
      const snapshotAt = new Date();
      const shared: Record<string, unknown> = {};
      const outcomes: InvariantOutcome[] = [];
      for (const def of defs) {
        const startedAt = new Date();
        try {
          const results = await def.check!(tx, shared, checkOpts);
          outcomes.push({ ruleId: def.id, status: 'SUCCEEDED', error: null, startedAt, finishedAt: new Date(), results, findings: findingsOf(def, results) });
        } catch (err) {
          outcomes.push({ ruleId: def.id, status: 'FAILED', error: errorText(err), startedAt, finishedAt: new Date(), results: [], findings: [] });
        }
      }
      return { runId, trigger: opts.trigger ?? 'SCHEDULED', snapshotAt, outcomes };
    },
    { maxWait: 60_000, timeout: opts.timeoutMs ?? 30 * 60_000 },
  );
}

type Row = {
  id: string;
  fingerprint: string;
  ruleId: string;
  companyId: string | null;
  status: string;
  version: number;
  actualValue: Prisma.JsonValue;
  occurrences: number;
  blocking: boolean;
  severity: string;
};

const ROW_SELECT = {
  id: true, fingerprint: true, ruleId: true, companyId: true, status: true, version: true,
  actualValue: true, occurrences: true, blocking: true, severity: true,
} as const;

function sameObservation(a: Prisma.JsonValue, b: { tag: string | null }): boolean {
  const tag = a && typeof a === 'object' && !Array.isArray(a) ? (a as { tag?: unknown }).tag ?? null : null;
  return tag === b.tag;
}

/** Fields cleared when a finding is opened again (the old classification stays in the audit trail). */
const CLEARED_ON_REOPEN = {
  pendingAction: null,
  explanation: null, explanationRef: null, explainedById: null, explainedAt: null,
  explanationApprovedById: null, explanationApprovedAt: null,
  waiverReason: null, waivedById: null, waivedAt: null, waiverApprovedById: null, waiverApprovedAt: null,
  selfActSingleOperator: false, ownerConfirmation: null, ownerConfirmationRef: null, ownerConfirmedAt: null,
  resolution: null, resolutionRef: null, resolvedAt: null, resolvedById: null, closedAt: null,
  category: 'UNCLASSIFIED',
};

/** The EXPLAINED classification of a finding explained by a recorded fact, else nothing. */
function explainedFields(f: Finding, now: Date): { status?: 'EXPLAINED'; category?: string; explanation?: string; explanationRef?: string; explainedById?: string; explainedAt?: Date } {
  if (!f.explained) return {};
  return { status: 'EXPLAINED', category: f.explained.category, explanation: f.explained.text, explanationRef: f.explained.ref, explainedById: f.explained.by, explainedAt: now };
}

async function loadRows(tx: TxClient, companyId: string | null, fingerprints: string[], ruleIds: string[]): Promise<Map<string, Row>> {
  const byFp = new Map<string, Row>();
  for (let i = 0; i < fingerprints.length; i += IN_CHUNK) {
    const rows = await tx.discrepancy.findMany({ where: { fingerprint: { in: fingerprints.slice(i, i + IN_CHUNK) } }, select: ROW_SELECT });
    for (const r of rows) byFp.set(r.fingerprint, r);
  }
  if (ruleIds.length) {
    const active = await tx.discrepancy.findMany({ where: { companyId, ruleId: { in: ruleIds }, status: { in: CLOSABLE } }, select: ROW_SELECT });
    for (const r of active) byFp.set(r.fingerprint, r);
  }
  return byFp;
}

/**
 * Step 2: records one company's findings of a snapshot (`companyId: null` = the tenant-level pass,
 * findings without a company). Discrepancies of invariants whose check FAILED are left untouched.
 */
export async function recordInvariantResults(
  prisma: RootClient,
  snapshot: InvariantSnapshot,
  args: { companyId: string | null; timeoutMs?: number },
): Promise<CompanyReconcileSummary> {
  const companyId = args.companyId ?? null;
  if (companyId !== null && !companyId.trim()) throw new Error('recordInvariantResults: companyId must be a company id or null');
  const companyKey = companyId ?? TENANT_LEVEL;
  const succeeded = snapshot.outcomes.filter((o) => o.status === 'SUCCEEDED');
  // Every fingerprint seen anywhere in the snapshot: a finding that moved to another company is not
  // "gone"; the other company's pass takes it over.
  const seenAnywhere = new Set(succeeded.flatMap((o) => o.findings.map((f) => f.fingerprint)));
  // Rows are written in fingerprint order: two passes that touch the same rows (a finding that moved
  // between companies) take their row locks in the same order. No Employee row is locked or written:
  // subjectEmployeeId is a reference, so the employee lock order of ARCH-019 does not apply.
  const byFingerprint = (a: { fingerprint: string }, b: { fingerprint: string }) => (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0);
  const mine = succeeded.flatMap((o) => o.findings.filter((f) => f.companyId === companyId)).sort(byFingerprint);

  return prisma.$transaction(
    async (tx) => {
      await lockReconcileWrites(tx, companyKey);
      const now = new Date();
      const rows = await loadRows(tx, companyId, mine.map((f) => f.fingerprint), succeeded.map((o) => o.ruleId));
      const perRule = new Map<string, { found: number; opened: number; reopened: number; autoClosed: number }>();
      const stat = (ruleId: string) => {
        let s = perRule.get(ruleId);
        if (!s) perRule.set(ruleId, (s = { found: 0, opened: 0, reopened: 0, autoClosed: 0 }));
        return s;
      };
      const eventKey = (fp: string, what: string) => `reconcile:${snapshot.runId}:${fp}:${what}`;

      for (const f of mine) {
        const s = stat(f.ruleId);
        s.found += 1;
        const row = rows.get(f.fingerprint);
        const facts = {
          ruleId: f.ruleId, checkId: f.checkId, domain: f.domain, companyId: f.companyId, subjectEmployeeId: f.subjectEmployeeId,
          entityType: f.entityType, entityId: f.entityId, period: f.period, severity: f.severity, blocking: f.blocking, blocks: f.blocks,
        };
        const explained = explainedFields(f, now);
        if (!row) {
          const created = await tx.discrepancy.create({
            data: { fingerprint: f.fingerprint, ...facts, ...explained, actualValue: f.actualValue, detectedAt: now, lastSeenAt: now, lastRunId: snapshot.runId },
            select: { id: true },
          });
          s.opened += 1;
          await audit(tx, { actor: RECONCILE_ACTOR, action: 'platform.discrepancy.opened', entity: { type: 'Discrepancy', id: created.id, companyId }, after: { ...facts, status: explained.status ?? 'OPEN', category: explained.category, actualValue: f.actualValue, runId: snapshot.runId } });
          if (f.blocking) {
            await emitEvent(tx, {
              type: 'platform.discrepancy.opened', aggregateType: 'Discrepancy', aggregateId: created.id, idempotencyKey: eventKey(f.fingerprint, 'opened'),
              companyId, payload: { ruleId: f.ruleId, checkId: f.checkId, severity: f.severity, blocks: f.blocks, entityType: f.entityType, entityId: f.entityId, period: f.period },
            });
          }
          continue;
        }
        const closed = row.status === 'RESOLVED' || row.status === 'AUTO_CLOSED';
        const classifiedButChanged = (row.status === 'EXPLAINED' || row.status === 'WAIVED') && !sameObservation(row.actualValue, f.actualValue);
        if (closed || classifiedButChanged) {
          // Reopen on recurrence (§4.3 rule 1): a closed finding is back, or the classified one changed.
          const { count } = await tx.discrepancy.updateMany({
            where: { id: row.id, version: row.version },
            data: { ...facts, ...CLEARED_ON_REOPEN, status: 'OPEN', ...explained, actualValue: f.actualValue, lastSeenAt: now, lastRunId: snapshot.runId, occurrences: { increment: 1 }, version: { increment: 1 } },
          });
          if (!count) continue; // changed by a person meanwhile: the next run looks again
          s.reopened += 1;
          await audit(tx, {
            actor: RECONCILE_ACTOR, action: 'platform.discrepancy.reopened', entity: { type: 'Discrepancy', id: row.id, companyId },
            before: { status: row.status, actualValue: row.actualValue }, after: { status: explained.status ?? 'OPEN', actualValue: f.actualValue, runId: snapshot.runId },
          });
          if (f.blocking) {
            await emitEvent(tx, {
              type: 'platform.discrepancy.reopened', aggregateType: 'Discrepancy', aggregateId: row.id, idempotencyKey: eventKey(f.fingerprint, 'reopened'),
              companyId, payload: { ruleId: f.ruleId, checkId: f.checkId, severity: f.severity, blocks: f.blocks, previousStatus: row.status },
            });
          }
          continue;
        }
        // Still there, same observation: refresh what the rule computes, keep the classification.
        await tx.discrepancy.updateMany({
          where: { id: row.id, version: row.version },
          data: { ...facts, actualValue: f.actualValue, lastSeenAt: now, lastRunId: snapshot.runId },
        });
      }

      // Gone from the snapshot: AUTO_CLOSED with its audit row.
      const ranRules = new Set(succeeded.map((o) => o.ruleId));
      for (const row of [...rows.values()].sort(byFingerprint)) {
        if (row.companyId !== companyId || !ranRules.has(row.ruleId) || !CLOSABLE.includes(row.status) || seenAnywhere.has(row.fingerprint)) continue;
        const { count } = await tx.discrepancy.updateMany({
          where: { id: row.id, version: row.version },
          data: { status: 'AUTO_CLOSED', pendingAction: null, closedAt: now, lastRunId: snapshot.runId, version: { increment: 1 } },
        });
        if (!count) continue;
        stat(row.ruleId).autoClosed += 1;
        await audit(tx, {
          actor: RECONCILE_ACTOR, action: 'platform.discrepancy.autoClosed', entity: { type: 'Discrepancy', id: row.id, companyId },
          before: { status: row.status }, after: { status: 'AUTO_CLOSED', runId: snapshot.runId },
        });
      }

      const totals = { found: 0, opened: 0, reopened: 0, autoClosed: 0 };
      for (const o of snapshot.outcomes) {
        const s = perRule.get(o.ruleId) ?? { found: 0, opened: 0, reopened: 0, autoClosed: 0 };
        for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += s[k];
        await tx.invariantRun.create({
          data: {
            runId: snapshot.runId, ruleId: o.ruleId, companyId, trigger: snapshot.trigger, status: o.status,
            snapshotAt: snapshot.snapshotAt, startedAt: o.startedAt, finishedAt: o.finishedAt, ...s, error: o.error,
            results: o.results.map((r) => ({ check: r.check, severity: r.severity, count: r.byCompany[companyId ?? '(none)'] ?? 0, approximation: r.approximation ? true : undefined })),
          },
        });
      }
      const failedInvariants = snapshot.outcomes.filter((o) => o.status === 'FAILED').map((o) => o.ruleId);
      await emitEvent(tx, {
        type: 'platform.invariantRun.completed', aggregateType: 'InvariantRun', aggregateId: `${snapshot.runId}:${companyKey}`,
        idempotencyKey: `reconcile:${snapshot.runId}:${companyKey}:completed`, companyId,
        payload: { runId: snapshot.runId, trigger: snapshot.trigger, ...totals, failedInvariants },
      });
      return { runId: snapshot.runId, companyId, ...totals, failedInvariants };
    },
    { maxWait: 60_000, timeout: args.timeoutMs ?? 10 * 60_000 },
  );
}

/** One company (or `null`: the tenant-level findings): snapshot + record. */
export async function reconcile(
  prisma: RootClient,
  args: { companyId: string | null } & SnapshotOptions,
): Promise<CompanyReconcileSummary> {
  const snapshot = await takeInvariantSnapshot(prisma, args);
  return recordInvariantResults(prisma, snapshot, { companyId: args.companyId });
}

/** For callers that hold a definition id only. */
export function requireInvariant(id: string): InvariantDefinition {
  const def = invariantById(id);
  if (!def) throw new Error(`unknown invariant ${id}`);
  return def;
}
