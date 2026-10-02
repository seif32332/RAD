// Pure helpers of the effective-period primitive: date-only values, the kind's own columns, and
// the JSON-safe view of a row. No database access here (unit-tested without Postgres).
import { roundMoney } from '@/lib/money';
import { kindSpec, type CompensationAllowance, type PeriodAttrsByKind, type PeriodKind, type PeriodRow } from './kinds';

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** A date-only value: 'YYYY-MM-DD', or a Date at UTC midnight (the storage convention of src/lib/dates.ts). */
export type DateOnly = Date | string;

export class EffectivePeriodInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EffectivePeriodInputError';
  }
}

/**
 * Normalises a date-only input to the stored Date (UTC midnight). A Date with a time part is refused
 * rather than truncated: a Riyadh-local midnight (21:00Z the day before) would otherwise shift a day.
 */
export function toDateOnly(value: DateOnly, what = 'date'): Date {
  if (typeof value === 'string') {
    if (!DAY_KEY.test(value)) throw new EffectivePeriodInputError(`${what} must be YYYY-MM-DD, got "${value}"`);
    const d = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) throw new EffectivePeriodInputError(`${what} is not a calendar date: "${value}"`);
    return d;
  }
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new EffectivePeriodInputError(`${what} is not a valid date`);
  if (value.getTime() % 86_400_000 !== 0) throw new EffectivePeriodInputError(`${what} must be a date-only value (UTC midnight), got ${value.toISOString()}`);
  return new Date(value.getTime());
}

export function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** validFrom < validTo (validTo exclusive; null = open). */
export function assertRange(validFrom: Date, validTo: Date | null): void {
  if (validTo && validTo.getTime() <= validFrom.getTime()) {
    throw new EffectivePeriodInputError(`validTo (${dayKey(validTo)}) must be after validFrom (${dayKey(validFrom)}); validTo is exclusive`);
  }
}

/** [aFrom, aTo) and [bFrom, bTo) share at least one day (null = unbounded). */
export function rangesOverlap(aFrom: Date, aTo: Date | null, bFrom: Date, bTo: Date | null): boolean {
  const aEnd = aTo ? aTo.getTime() : Infinity;
  const bEnd = bTo ? bTo.getTime() : Infinity;
  return aFrom.getTime() < bEnd && bFrom.getTime() < aEnd;
}

export function assertSource(source: { type: string; id: string } | undefined | null): { type: string; id: string } {
  if (!source || !/^[A-Z][A-Z0-9_]*$/.test(source.type ?? '')) {
    throw new EffectivePeriodInputError('source.type is required, in UPPER_SNAKE_CASE (e.g. CHANGE_ORDER, ONBOARDING)');
  }
  if (source.type === 'LEGACY_OPENING') throw new EffectivePeriodInputError('LEGACY_OPENING periods are written by openLegacyPeriod only (ARC-SYS-A3)');
  if (!source.id?.trim()) throw new EffectivePeriodInputError('source.id is required');
  return { type: source.type, id: source.id };
}

function money(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new EffectivePeriodInputError(`${what} must be a finite amount >= 0`);
  if (Math.abs(roundMoney(value) - value) > 1e-9) throw new EffectivePeriodInputError(`${what} has more than two decimals (halala precision)`);
  return roundMoney(value);
}

function optId(value: unknown, what: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim()) throw new EffectivePeriodInputError(`${what} must be an id or null`);
  return value;
}

const LINES = new Set(['HOUSING', 'TRANSPORT', 'OTHER']);

/**
 * Validates the kind's own columns and returns them in their stored form (money as a 2-decimal
 * string for the Decimal columns). Unknown columns are refused.
 */
export function attrsToData<K extends PeriodKind>(kind: K, employeeId: string, attrs: PeriodAttrsByKind[K] | undefined): Record<string, unknown> {
  const spec = kindSpec(kind);
  const input = (attrs ?? {}) as Record<string, unknown>;
  const unknown = Object.keys(input).filter((k) => !spec.attrColumns.includes(k));
  if (unknown.length) throw new EffectivePeriodInputError(`${unknown.join(', ')} is not a column of a ${kind} period`);

  if (kind === 'COMPENSATION') {
    const basic = money(input.basicSalary, 'basicSalary');
    if (!Array.isArray(input.allowances)) throw new EffectivePeriodInputError('allowances must be an array');
    const allowances: CompensationAllowance[] = (input.allowances as unknown[]).map((raw, i) => {
      const a = (raw ?? {}) as Record<string, unknown>;
      if (typeof a.name !== 'string' || !a.name.trim()) throw new EffectivePeriodInputError(`allowances[${i}].name is required`);
      if (typeof a.line !== 'string' || !LINES.has(a.line)) throw new EffectivePeriodInputError(`allowances[${i}].line must be HOUSING, TRANSPORT or OTHER`);
      if (typeof a.countsTowardGosi !== 'boolean') throw new EffectivePeriodInputError(`allowances[${i}].countsTowardGosi must be a boolean`);
      return {
        name: a.name,
        line: a.line as CompensationAllowance['line'],
        allowanceType: optId(a.allowanceType, `allowances[${i}].allowanceType`),
        amount: money(a.amount, `allowances[${i}].amount`),
        countsTowardGosi: a.countsTowardGosi,
        allowanceId: optId(a.allowanceId, `allowances[${i}].allowanceId`),
      };
    });
    const override = input.gosiBaseOverride === undefined || input.gosiBaseOverride === null ? null : money(input.gosiBaseOverride, 'gosiBaseOverride');
    return { basicSalary: basic.toFixed(2), allowances, gosiBaseOverride: override === null ? null : override.toFixed(2) };
  }

  if (kind === 'ASSIGNMENT') {
    if (typeof input.legalCompanyId !== 'string' || !input.legalCompanyId.trim()) throw new EffectivePeriodInputError('legalCompanyId is required');
    const managerId = optId(input.managerId, 'managerId');
    if (managerId && managerId === employeeId) throw new EffectivePeriodInputError('an employee is not their own manager');
    return {
      legalCompanyId: input.legalCompanyId,
      actualCompanyId: optId(input.actualCompanyId, 'actualCompanyId'),
      branchId: optId(input.branchId, 'branchId'),
      departmentId: optId(input.departmentId, 'departmentId'),
      managerId,
      workPatternId: optId(input.workPatternId, 'workPatternId'),
    };
  }

  if (kind === 'BANK_IDENTITY') {
    const method = input.paymentMethod;
    if (method !== 'CASH' && method !== 'BANK_TRANSFER' && method !== 'WPS') throw new EffectivePeriodInputError('paymentMethod must be CASH, BANK_TRANSFER or WPS');
    const text = (v: unknown, what: string): string | null => {
      if (v === undefined || v === null || v === '') return null;
      if (typeof v !== 'string') throw new EffectivePeriodInputError(`${what} must be a string or null`);
      return v;
    };
    const ibanEncrypted = text(input.ibanEncrypted, 'ibanEncrypted');
    const ibanFingerprint = text(input.ibanFingerprint, 'ibanFingerprint');
    const ibanLast4 = text(input.ibanLast4, 'ibanLast4');
    if (method === 'CASH') {
      if (ibanEncrypted || ibanFingerprint || ibanLast4) throw new EffectivePeriodInputError('a CASH bank identity has no IBAN');
    } else {
      if (!ibanEncrypted) throw new EffectivePeriodInputError(`a ${method} bank identity needs its IBAN`);
      if (!ibanFingerprint || !/^[0-9a-f]{64}$/.test(ibanFingerprint)) throw new EffectivePeriodInputError('ibanFingerprint must be the sha256 (hex) of the normalized IBAN');
      if (!ibanLast4 || !/^[0-9A-Z]{4}$/.test(ibanLast4)) throw new EffectivePeriodInputError('ibanLast4 must be the last 4 characters of the IBAN');
    }
    return { paymentMethod: method, ibanEncrypted, ibanFingerprint, ibanLast4, bankName: text(input.bankName, 'bankName') };
  }

  return {};
}

/** The kind's own columns of a row, in the stored form (to copy them to a successor). */
export function attrsOfRow(kind: PeriodKind, row: PeriodRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of kindSpec(kind).attrColumns) out[c] = row[c] ?? null;
  if (kind === 'COMPENSATION') {
    out.basicSalary = decimalToNumber(row.basicSalary)?.toFixed(2);
    const g = decimalToNumber(row.gosiBaseOverride);
    out.gosiBaseOverride = g === null ? null : g.toFixed(2);
  }
  return out;
}

/** The kind's own columns of a row, as the caller sees them (numbers for money). */
export function attrsView(kind: PeriodKind, row: PeriodRow): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of kindSpec(kind).attrColumns) out[c] = row[c] ?? null;
  if (kind === 'COMPENSATION') {
    out.basicSalary = decimalToNumber(row.basicSalary);
    out.gosiBaseOverride = decimalToNumber(row.gosiBaseOverride);
  }
  return out;
}

/** Prisma.Decimal | number | string | null -> number | null. */
export function decimalToNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  const n = Number(typeof v === 'string' ? v : String(v));
  if (!Number.isFinite(n)) throw new Error(`not a number: ${String(v)}`);
  return n;
}

/** JSON-safe view of a period row (also what an operation key replays). */
export interface PeriodView<K extends PeriodKind = PeriodKind> {
  kind: K;
  id: string;
  employeeId: string;
  lineageId: string;
  /** YYYY-MM-DD, inclusive. */
  validFrom: string;
  /** YYYY-MM-DD, exclusive; null = open. */
  validTo: string | null;
  supersedesId: string | null;
  supersededAt: string | null;
  supersedeReason: string | null;
  source: { type: string; id: string };
  recordedAt: string;
  attrs: Record<string, unknown>;
}

export function toView<K extends PeriodKind>(kind: K, row: PeriodRow): PeriodView<K> {
  return {
    kind,
    id: row.id,
    employeeId: row.employeeId,
    lineageId: row.lineageId,
    validFrom: dayKey(row.validFrom),
    validTo: row.validTo ? dayKey(row.validTo) : null,
    supersedesId: row.supersedesId,
    supersededAt: row.supersededAt ? row.supersededAt.toISOString() : null,
    supersedeReason: row.supersedeReason,
    source: { type: row.sourceType, id: row.sourceId },
    recordedAt: row.recordedAt.toISOString(),
    attrs: attrsView(kind, row),
  };
}
