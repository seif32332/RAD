// The effective-period primitive (P1-FND-EFF; DOMAIN_MODEL §1.3, ADR-0001 #9, ADR-0002 #3/#12/#13).
//
//   openPeriod       a new period (new lineage) for [validFrom, validTo)
//   supersedePeriod  replace a period: CORRECTION with a successor of the same lineage, or VOID
//                    (superseded without a successor, ADR-0002 #3). The old row stays, marked.
//   closePeriod      end a period at validTo: in place for EMPLOYMENT (the one named exception,
//                    ADR-0001 #9), a shortened successor of the same lineage for every other kind
//   activeAt         the period active on a day: zero or one row (rule 3), now or as recorded at T
//
// Writes take the transaction client only (the owning module's transition, its facts, the audit row
// and the event commit together, LIFECYCLE_MODEL §2.1) and are idempotent per operation key: the
// same key replays the recorded result instead of writing twice (§2.2). The database is the last
// line: EXCLUDE refuses overlapping active periods (INV-EFF-01) and a trigger refuses any rewrite.
import { randomUUID } from 'crypto';
import { audit, type AuditActor } from '../audit';
import { emitEvent } from '../events';
import { idempotent } from '../operations';
import { assertTransactionClient, type TxClient } from '../tx';
import { kindSpec, type PeriodAttrsByKind, type PeriodKind, type PeriodReader, type PeriodRow } from './kinds';
import {
  assertRange,
  assertSource,
  attrsOfRow,
  attrsToData,
  dayKey,
  EffectivePeriodInputError,
  rangesOverlap,
  toDateOnly,
  toView,
  type DateOnly,
  type PeriodView,
} from './shape';

export class PeriodOverlapError extends Error {
  constructor(kind: PeriodKind, employeeId: string, detail: string) {
    super(`${kind} period of employee ${employeeId} overlaps an active period (INV-EFF-01): ${detail}`);
    this.name = 'PeriodOverlapError';
  }
}

export class PeriodNotFoundError extends Error {
  constructor(kind: PeriodKind, id: string) {
    super(`${kind} period ${id} not found`);
    this.name = 'PeriodNotFoundError';
  }
}

export class PeriodAlreadySupersededError extends Error {
  constructor(kind: PeriodKind, id: string) {
    super(`${kind} period ${id} is already superseded; act on the active row of its lineage`);
    this.name = 'PeriodAlreadySupersededError';
  }
}

export class PeriodInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PeriodInvariantError';
  }
}

/** The operation a primitive call belongs to (the owning transition's key and actor). */
export interface PeriodOp {
  /** The transition's operation key. Each primitive call derives its own key from it (`step` tells two calls of one kind apart). */
  key: string;
  actor: AuditActor;
  /** Company for the audit row and the event (ASSIGNMENT uses its legalCompanyId when this is absent). */
  companyId?: string | null;
  reason?: string | null;
  step?: string;
}

export interface OpenPeriodInput<K extends PeriodKind> {
  employeeId: string;
  validFrom: DateOnly;
  validTo?: DateOnly | null;
  /** The decision or request that produced the period (ChangeOrder, FinancialChange, ONBOARDING…). */
  source: { type: string; id: string };
  attrs: PeriodAttrsByKind[K];
}

export interface PeriodResult<K extends PeriodKind> {
  period: PeriodView<K>;
  replayed: boolean;
}

function derivedKey(op: PeriodOp, kind: PeriodKind, action: string, subject?: string): string {
  if (!op?.key?.trim()) throw new EffectivePeriodInputError('op.key (the operation key) is required');
  return `${op.key}/effective:${kind}:${action}${subject ? `:${subject}` : ''}${op.step ? `:${op.step}` : ''}`;
}

function actorId(actor: AuditActor): string | null {
  return actor?.type === 'USER' ? actor.id : null;
}

function companyOf(kind: PeriodKind, op: PeriodOp, data: Record<string, unknown>): string | null {
  if (op.companyId) return op.companyId;
  if (kind === 'ASSIGNMENT' && typeof data.legalCompanyId === 'string') return data.legalCompanyId;
  return null;
}

/** Postgres exclusion violation (EXCLUDE ... no_overlap), as Prisma surfaces it. */
function isOverlapViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /23P01|exclusion constraint|_no_overlap/.test(msg);
}

async function activeOverlaps(tx: TxClient, kind: PeriodKind, employeeId: string, from: Date, to: Date | null, exceptId?: string): Promise<PeriodRow[]> {
  const rows = await kindSpec(kind)
    .delegate(tx)
    .findMany({
      where: {
        employeeId,
        supersededAt: null,
        ...(to ? { validFrom: { lt: to } } : {}),
        OR: [{ validTo: null }, { validTo: { gt: from } }],
      },
      orderBy: { validFrom: 'asc' },
    });
  return rows.filter((r) => r.id !== exceptId && rangesOverlap(from, to, r.validFrom, r.validTo));
}

async function insertRow(tx: TxClient, kind: PeriodKind, data: Record<string, unknown>): Promise<PeriodRow> {
  try {
    return await kindSpec(kind).delegate(tx).create({ data });
  } catch (err) {
    if (isOverlapViolation(err)) throw new PeriodOverlapError(kind, String(data.employeeId), 'refused by the database');
    throw err;
  }
}

/**
 * Opens a new period (a new lineage). Refuses an overlap with an active period of the same employee
 * and kind: to change a running period, supersede or close it first, in the same transaction.
 */
export async function openPeriod<K extends PeriodKind>(tx: TxClient, kind: K, input: OpenPeriodInput<K>, op: PeriodOp): Promise<PeriodResult<K>> {
  assertTransactionClient(tx, 'openPeriod');
  const spec = kindSpec(kind);
  const key = derivedKey(op, kind, 'open');
  const outcome = await idempotent(tx, { key, operation: `effective.${spec.eventDomain}.open`, actorId: actorId(op.actor), companyId: op.companyId ?? null }, async (t) => {
    if (!input?.employeeId?.trim()) throw new EffectivePeriodInputError('employeeId is required');
    const validFrom = toDateOnly(input.validFrom, 'validFrom');
    const validTo = input.validTo === undefined || input.validTo === null ? null : toDateOnly(input.validTo, 'validTo');
    assertRange(validFrom, validTo);
    const source = assertSource(input.source);
    const attrs = attrsToData(kind, input.employeeId, input.attrs);

    const clash = await activeOverlaps(t, kind, input.employeeId, validFrom, validTo);
    if (clash.length) {
      throw new PeriodOverlapError(kind, input.employeeId, clash.map((r) => `${r.id} [${dayKey(r.validFrom)}, ${r.validTo ? dayKey(r.validTo) : 'open'})`).join(', '));
    }
    const at = new Date();
    const row = await insertRow(t, kind, {
      id: randomUUID(),
      employeeId: input.employeeId,
      validFrom,
      validTo,
      lineageId: randomUUID(),
      sourceType: source.type,
      sourceId: source.id,
      recordedAt: at,
      createdById: actorId(op.actor),
      ...attrs,
    });
    const view = toView(kind, row);
    const companyId = companyOf(kind, op, attrs);
    await audit(t, {
      actor: op.actor,
      action: `${spec.eventDomain}.period.open`,
      entity: { type: spec.model, id: row.id, companyId },
      before: null,
      after: view,
      reason: op.reason ?? null,
      operationKey: op.key,
    });
    await emitEvent(t, {
      type: `${spec.eventDomain}.periodOpened`,
      aggregateType: spec.model,
      aggregateId: row.lineageId,
      idempotencyKey: `${key}:${spec.eventDomain}.periodOpened`,
      payload: { periodId: row.id, lineageId: row.lineageId, employeeId: row.employeeId, validFrom: view.validFrom, validTo: view.validTo, source: view.source },
      companyId,
      actorId: actorId(op.actor),
      effectiveDate: validFrom,
    });
    return view;
  });
  return { period: outcome.result as PeriodView<K>, replayed: outcome.replayed };
}

export interface SupersedeInput<K extends PeriodKind> {
  /** CORRECTION: a successor replaces the row. VOID: the row is withdrawn, no successor (ADR-0002 #3). */
  reason: 'CORRECTION' | 'VOID';
  /** The decision behind the supersede (recorded on the successor, the audit row and the event). */
  source: { type: string; id: string };
  /** CORRECTION only: what changes; everything else is copied from the superseded row. */
  successor?: { validFrom?: DateOnly; validTo?: DateOnly | null; attrs?: Partial<PeriodAttrsByKind[K]> } | null;
}

export interface SupersedeResult<K extends PeriodKind> {
  superseded: PeriodView<K>;
  successor: PeriodView<K> | null;
  replayed: boolean;
}

/** Marks the row superseded (guarded: once, from NULL) and inserts the successor, if any, in the same lineage. */
async function supersedeRow<K extends PeriodKind>(
  t: TxClient,
  kind: K,
  row: PeriodRow,
  reason: 'CORRECTION' | 'CLOSE' | 'VOID',
  successor: { validFrom: Date; validTo: Date | null; data: Record<string, unknown> } | null,
  source: { type: string; id: string },
  op: PeriodOp,
  at: Date,
): Promise<{ old: PeriodRow; next: PeriodRow | null }> {
  const spec = kindSpec(kind);
  const d = spec.delegate(t);
  const { count } = await d.updateMany({ where: { id: row.id, supersededAt: null }, data: { supersededAt: at, supersedeReason: reason } });
  if (count !== 1) throw new PeriodAlreadySupersededError(kind, row.id);
  let next: PeriodRow | null = null;
  if (successor) {
    assertRange(successor.validFrom, successor.validTo);
    const clash = await activeOverlaps(t, kind, row.employeeId, successor.validFrom, successor.validTo);
    if (clash.length) throw new PeriodOverlapError(kind, row.employeeId, clash.map((r) => r.id).join(', '));
    next = await insertRow(t, kind, {
      id: randomUUID(),
      employeeId: row.employeeId,
      validFrom: successor.validFrom,
      validTo: successor.validTo,
      lineageId: row.lineageId, // ADR-0002 #12: the successor inherits the lineage
      supersedesId: row.id,
      sourceType: source.type,
      sourceId: source.id,
      recordedAt: at, // same instant as supersededAt: an as-recorded read sees exactly one of the two
      createdById: actorId(op.actor),
      ...successor.data,
    });
  }
  const old = (await d.findUnique({ where: { id: row.id } })) as PeriodRow;
  return { old, next };
}

async function loadActive(t: TxClient, kind: PeriodKind, periodId: string): Promise<PeriodRow> {
  const row = await kindSpec(kind).delegate(t).findUnique({ where: { id: periodId } });
  if (!row) throw new PeriodNotFoundError(kind, periodId);
  if (row.supersededAt) throw new PeriodAlreadySupersededError(kind, periodId);
  return row;
}

/**
 * Replaces a period. The old row is never changed beyond its supersede mark; the successor (if any)
 * keeps the lineage, so references to the lineage survive the correction (ADR-0002 #12).
 */
export async function supersedePeriod<K extends PeriodKind>(tx: TxClient, kind: K, periodId: string, input: SupersedeInput<K>, op: PeriodOp): Promise<SupersedeResult<K>> {
  assertTransactionClient(tx, 'supersedePeriod');
  const spec = kindSpec(kind);
  const key = derivedKey(op, kind, 'supersede', periodId);
  const outcome = await idempotent(tx, { key, operation: `effective.${spec.eventDomain}.supersede`, actorId: actorId(op.actor), companyId: op.companyId ?? null }, async (t) => {
    if (input?.reason !== 'CORRECTION' && input?.reason !== 'VOID') throw new EffectivePeriodInputError('reason must be CORRECTION or VOID');
    if (input.reason === 'VOID' && input.successor) throw new EffectivePeriodInputError('a VOID supersede has no successor (ADR-0002 #3)');
    if (input.reason === 'CORRECTION' && !input.successor) throw new EffectivePeriodInputError('a CORRECTION needs a successor; to withdraw the period use VOID');
    const source = assertSource(input.source);
    const row = await loadActive(t, kind, periodId);

    let successor: { validFrom: Date; validTo: Date | null; data: Record<string, unknown> } | null = null;
    if (input.successor) {
      const s = input.successor;
      const validFrom = s.validFrom === undefined ? row.validFrom : toDateOnly(s.validFrom, 'successor.validFrom');
      const validTo = s.validTo === undefined ? row.validTo : s.validTo === null ? null : toDateOnly(s.validTo, 'successor.validTo');
      const merged = { ...attrsOfRow(kind, row), ...(s.attrs ?? {}) } as Record<string, unknown>;
      // Money columns of the copied row are 2-decimal strings; attrsToData wants numbers.
      if (kind === 'COMPENSATION') {
        for (const c of ['basicSalary', 'gosiBaseOverride']) if (typeof merged[c] === 'string') merged[c] = Number(merged[c]);
      }
      successor = { validFrom, validTo, data: attrsToData(kind, row.employeeId, merged as PeriodAttrsByKind[K]) };
    }

    const at = new Date();
    const { old, next } = await supersedeRow(t, kind, row, input.reason, successor, source, op, at);
    const oldView = toView(kind, old);
    const nextView = next ? toView(kind, next) : null;
    const companyId = companyOf(kind, op, (next ?? row) as Record<string, unknown>);
    await audit(t, {
      actor: op.actor,
      action: `${spec.eventDomain}.period.${input.reason === 'VOID' ? 'void' : 'supersede'}`,
      entity: { type: spec.model, id: row.id, companyId },
      before: toView(kind, row),
      after: { superseded: oldView, successor: nextView, source },
      reason: op.reason ?? null,
      operationKey: op.key,
    });
    await emitEvent(t, {
      type: `${spec.eventDomain}.periodSuperseded`,
      aggregateType: spec.model,
      aggregateId: row.lineageId,
      idempotencyKey: `${key}:${spec.eventDomain}.periodSuperseded`,
      payload: { periodId: row.id, successorId: nextView?.id ?? null, lineageId: row.lineageId, employeeId: row.employeeId, reason: input.reason, source },
      companyId,
      actorId: actorId(op.actor),
      effectiveDate: next ? next.validFrom : row.validFrom,
    });
    return { superseded: oldView, successor: nextView };
  });
  const r = outcome.result as { superseded: PeriodView<K>; successor: PeriodView<K> | null };
  return { ...r, replayed: outcome.replayed };
}

export interface ClosePeriodInput {
  /** New exclusive end. null reopens (EMPLOYMENT only, DEC-PO-043). */
  validTo: DateOnly | null;
  source: { type: string; id: string };
}

export interface CloseResult<K extends PeriodKind> {
  /** The active row after the close: the same row (EMPLOYMENT) or its shortened successor. */
  period: PeriodView<K>;
  /** The superseded row (every kind except EMPLOYMENT). */
  superseded: PeriodView<K> | null;
  replayed: boolean;
}

/**
 * Ends a period at `validTo` (exclusive). EMPLOYMENT: validTo is edited in place and the row keeps
 * its id (ADR-0001 #9; lifecycle records every such edit in EmploymentStateChange, P1-LCY). Every
 * other kind: the row is superseded (reason CLOSE) by a copy ending at validTo, same lineage.
 */
export async function closePeriod<K extends PeriodKind>(tx: TxClient, kind: K, periodId: string, input: ClosePeriodInput, op: PeriodOp): Promise<CloseResult<K>> {
  assertTransactionClient(tx, 'closePeriod');
  const spec = kindSpec(kind);
  const key = derivedKey(op, kind, 'close', periodId);
  const outcome = await idempotent(tx, { key, operation: `effective.${spec.eventDomain}.close`, actorId: actorId(op.actor), companyId: op.companyId ?? null }, async (t) => {
    const source = assertSource(input?.source);
    const row = await loadActive(t, kind, periodId);
    const validTo = input.validTo === null ? null : toDateOnly(input.validTo, 'validTo');
    if (validTo === null && !spec.endInPlace) throw new EffectivePeriodInputError(`a ${kind} period is reopened by a new decision, not by clearing its end`);
    assertRange(row.validFrom, validTo);
    const before = toView(kind, row);
    let current: PeriodRow;
    let superseded: PeriodRow | null = null;
    if (spec.endInPlace) {
      if (validTo === null || !row.validTo || validTo.getTime() > row.validTo.getTime()) {
        const clash = await activeOverlaps(t, kind, row.employeeId, row.validFrom, validTo, row.id);
        if (clash.length) throw new PeriodOverlapError(kind, row.employeeId, clash.map((r) => r.id).join(', '));
      }
      const d = spec.delegate(t);
      try {
        const { count } = await d.updateMany({ where: { id: row.id, supersededAt: null }, data: { validTo } });
        if (count !== 1) throw new PeriodAlreadySupersededError(kind, row.id);
      } catch (err) {
        if (isOverlapViolation(err)) throw new PeriodOverlapError(kind, row.employeeId, 'refused by the database');
        throw err;
      }
      current = (await d.findUnique({ where: { id: row.id } })) as PeriodRow;
    } else {
      const data = attrsOfRow(kind, row);
      const r = await supersedeRow(t, kind, row, 'CLOSE', { validFrom: row.validFrom, validTo, data }, source, op, new Date());
      superseded = r.old;
      current = r.next as PeriodRow;
    }
    const view = toView(kind, current);
    const companyId = companyOf(kind, op, current as Record<string, unknown>);
    await audit(t, {
      actor: op.actor,
      action: `${spec.eventDomain}.period.close`,
      entity: { type: spec.model, id: row.id, companyId },
      before,
      after: { period: view, source },
      reason: op.reason ?? null,
      operationKey: op.key,
    });
    await emitEvent(t, {
      type: `${spec.eventDomain}.periodClosed`,
      aggregateType: spec.model,
      aggregateId: row.lineageId,
      idempotencyKey: `${key}:${spec.eventDomain}.periodClosed`,
      payload: { periodId: row.id, activeId: view.id, lineageId: row.lineageId, employeeId: row.employeeId, validTo: view.validTo, source },
      companyId,
      actorId: actorId(op.actor),
      effectiveDate: validTo,
    });
    return { period: view, superseded: superseded ? toView(kind, superseded) : null };
  });
  const r = outcome.result as { period: PeriodView<K>; superseded: PeriodView<K> | null };
  return { ...r, replayed: outcome.replayed };
}

export interface ReadOptions {
  /**
   * Read as the system knew it at this instant: rows recorded by then and not yet superseded then.
   * Limit until P1-LCY: the in-place end of EMPLOYMENT (ADR-0001 #9) is read from the column; its
   * as-recorded derivation from EmploymentStateChange (ADR-0002 #4) comes with that table.
   */
  asRecordedAt?: Date | null;
}

function visibility(opts: ReadOptions | undefined): Record<string, unknown> {
  const t = opts?.asRecordedAt;
  if (!t) return { supersededAt: null };
  if (!(t instanceof Date) || Number.isNaN(t.getTime())) throw new EffectivePeriodInputError('asRecordedAt must be a valid Date');
  return { recordedAt: { lte: t }, OR: [{ supersededAt: null }, { supersededAt: { gt: t } }] };
}

/** The period of the kind active on `date` (zero or one: DOMAIN_MODEL §1.3 rule 3). */
export async function activeAt<K extends PeriodKind>(db: PeriodReader, kind: K, employeeId: string, date: DateOnly, opts?: ReadOptions): Promise<PeriodView<K> | null> {
  const day = toDateOnly(date, 'date');
  const vis = visibility(opts);
  const rows = await kindSpec(kind)
    .delegate(db)
    .findMany({
      where: { AND: [{ employeeId, validFrom: { lte: day }, OR: [{ validTo: null }, { validTo: { gt: day } }] }, vis] },
      orderBy: { recordedAt: 'asc' },
      take: 2,
    });
  if (rows.length > 1) {
    throw new PeriodInvariantError(`INV-EFF-01: ${rows.length} ${kind} periods of employee ${employeeId} are active on ${dayKey(day)} (${rows.map((r) => r.id).join(', ')})`);
  }
  return rows.length ? toView(kind, rows[0]) : null;
}

/** Every period of the employee and kind (active ones, or as recorded at T), oldest first. */
export async function periodsOf<K extends PeriodKind>(db: PeriodReader, kind: K, employeeId: string, opts?: ReadOptions & { includeSuperseded?: boolean }): Promise<PeriodView<K>[]> {
  const where = opts?.includeSuperseded ? { employeeId } : { AND: [{ employeeId }, visibility(opts)] };
  const rows = await kindSpec(kind).delegate(db).findMany({ where, orderBy: [{ validFrom: 'asc' }, { recordedAt: 'asc' }] });
  return rows.map((r) => toView(kind, r));
}

/** Every row of a lineage (the supersede chain), in recorded order. */
export async function lineageOf<K extends PeriodKind>(db: PeriodReader, kind: K, lineageId: string): Promise<PeriodView<K>[]> {
  const rows = await kindSpec(kind).delegate(db).findMany({ where: { lineageId }, orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }] });
  return rows.map((r) => toView(kind, r));
}
