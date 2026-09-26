// Snapshot of a calculation (WorkforceCalculation row): engine version, exact rule versions, inputs and
// outputs, so that a number shown today can be explained a year later (SPEC principle 5). PURE.
import { ENGINE_VERSION } from '@/lib/workforce/version';
import type { RuleVersionRef } from '@/lib/workforce/types';

export type SnapshotKind = 'TRUE_COST' | 'EXIT_COST' | 'OVERVIEW' | 'SAUDIZATION' | 'HIRE_SCENARIO';
export type SnapshotSubjectType = 'EMPLOYEE' | 'COMPANY' | 'BRANCH' | 'DEPARTMENT' | 'ALL';

export interface SnapshotSubject {
  type: SnapshotSubjectType;
  id?: string | null;
  title?: string | null;
}

/** Data for prisma.workforceCalculation.create({ data: { ...record, createdById } }). */
export interface WorkforceCalculationRecord {
  kind: SnapshotKind;
  subjectType: SnapshotSubjectType;
  subjectId: string | null;
  title: string | null;
  engineVersion: string;
  /** JSON: [{key, effectiveFrom, status, value}] sorted by key then date. */
  ruleVersions: string;
  /** JSON (stable key order, dates as ISO strings). */
  inputs: string;
  outputs: string;
}

/** JSON.stringify with sorted object keys (stable across runs), Dates as ISO strings, non-finite -> null. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(v: unknown): unknown {
  if (v === null || v === undefined) return v ?? null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (Array.isArray(v)) return v.map(normalize);
  if (v instanceof Map) return normalize(Object.fromEntries(v));
  if (v instanceof Set) return normalize([...v]);
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x === undefined || typeof x === 'function') continue;
      out[k] = normalize(x);
    }
    return out;
  }
  return v;
}

export function buildSnapshot(
  kind: SnapshotKind,
  subject: SnapshotSubject,
  inputs: unknown,
  outputs: unknown,
  rulesUsed: ReadonlyArray<RuleVersionRef>,
): WorkforceCalculationRecord {
  const refs = [...rulesUsed].sort((a, b) => a.key.localeCompare(b.key) || String(a.effectiveFrom).localeCompare(String(b.effectiveFrom)));
  return {
    kind,
    subjectType: subject.type,
    subjectId: subject.id ?? null,
    title: subject.title ?? null,
    engineVersion: ENGINE_VERSION,
    ruleVersions: stableStringify(refs),
    inputs: stableStringify(inputs),
    outputs: stableStringify(outputs),
  };
}
