// The ratchet of ARCHITECTURE_INVARIANTS §4.1.3.
//
// baseline.json records today's inherited violations as { rule: { key: count } } where key is a
// file (or prisma/schema.prisma#Model[.field]). A rule fails when
//   - a key has MORE violations than its baseline count (a new violation), or
//   - a key has FEWER violations than its baseline count (stale entry: shrink the baseline in the
//     same change, so the number can never climb back).
// Counting per file keeps the baseline stable under line drift (several sessions edit the tree).
//
// Entries may only be ADDED with an ADR: `npm run arch:baseline -- --grow ADR-00xx` (the ADR file
// must exist in docs/architecture/decisions/); each growth is logged in baseline.json "growth".
// "allowances" are standing exceptions an ADR grants by pattern (e.g. ADR-0002 #5).
import type { Violation } from './rules';

export interface Allowance {
  rule: string;
  tag: string;
  pathPrefix: string;
  adr: string;
  until?: string;
  note?: string;
}

export interface GrowthEntry {
  date: string;
  adr: string;
  rule: string;
  key: string;
  from: number;
  to: number;
}

export interface Baseline {
  _about?: string[];
  rules: Record<string, Record<string, number>>;
  allowances: Allowance[];
  growth: GrowthEntry[];
}

export function allowed(v: Violation, allowances: Allowance[]): boolean {
  return allowances.some((a) => a.rule === v.rule && a.tag === v.tag && v.key.startsWith(a.pathPrefix));
}

export function countByKey(violations: Violation[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of violations) out[x.key] = (out[x.key] ?? 0) + 1;
  return out;
}

export interface Comparison {
  /** Keys with more violations than the baseline, with their violations. */
  grown: { key: string; baseline: number; actual: number; violations: Violation[] }[];
  /** Keys with fewer violations than the baseline. */
  stale: { key: string; baseline: number; actual: number }[];
}

export function compare(rule: string, violations: Violation[], baseline: Baseline): Comparison {
  const actual = countByKey(violations);
  const base = baseline.rules[rule] ?? {};
  const grown: Comparison['grown'] = [];
  const stale: Comparison['stale'] = [];
  for (const [key, n] of Object.entries(actual)) {
    const b = base[key] ?? 0;
    if (n > b) grown.push({ key, baseline: b, actual: n, violations: violations.filter((x) => x.key === key).sort((a, c) => a.line - c.line) });
  }
  for (const [key, b] of Object.entries(base)) {
    const n = actual[key] ?? 0;
    if (n < b) stale.push({ key, baseline: b, actual: n });
  }
  return { grown, stale };
}

/** Shrink-only update: every count becomes min(baseline, actual); zero entries disappear. */
export function shrink(baseline: Baseline, actualByRule: Record<string, Record<string, number>>): Baseline {
  const rules: Baseline['rules'] = {};
  for (const [rule, entries] of Object.entries(baseline.rules)) {
    const actual = actualByRule[rule] ?? {};
    const next: Record<string, number> = {};
    for (const [key, b] of Object.entries(entries)) {
      const n = Math.min(b, actual[key] ?? 0);
      if (n > 0) next[key] = n;
    }
    if (Object.keys(next).length) rules[rule] = sortKeys(next);
  }
  return { ...baseline, rules: sortKeys(rules) };
}

/** ADR-backed growth: counts become the actual counts; every increase is logged. */
export function grow(baseline: Baseline, actualByRule: Record<string, Record<string, number>>, adr: string, date: string): Baseline {
  const shrunk = shrink(baseline, actualByRule);
  const rules: Baseline['rules'] = { ...shrunk.rules };
  const growth = [...baseline.growth];
  for (const [rule, actual] of Object.entries(actualByRule)) {
    const next = { ...(rules[rule] ?? {}) };
    for (const [key, n] of Object.entries(actual)) {
      const b = baseline.rules[rule]?.[key] ?? 0;
      if (n > b) {
        growth.push({ date, adr, rule, key, from: b, to: n });
        next[key] = n;
      }
    }
    if (Object.keys(next).length) rules[rule] = sortKeys(next);
  }
  return { ...shrunk, rules: sortKeys(rules), growth };
}

export function totals(baseline: Baseline): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [rule, entries] of Object.entries(baseline.rules)) out[rule] = Object.values(entries).reduce((a, b) => a + b, 0);
  return out;
}

/** Keys (rule/key) whose count in `next` exceeds `prev` without a growth entry naming an ADR. */
export function unexplainedGrowth(prev: Baseline, next: Baseline): string[] {
  const old = new Set(prev.growth.map((g) => JSON.stringify(g)));
  const added = next.growth.filter((g) => !old.has(JSON.stringify(g)) && /^ADR-\d{4}/.test(g.adr));
  const out: string[] = [];
  for (const [rule, entries] of Object.entries(next.rules)) {
    for (const [key, n] of Object.entries(entries)) {
      const b = prev.rules[rule]?.[key] ?? 0;
      if (n > b && !added.some((g) => g.rule === rule && g.key === key && g.to >= n)) out.push(`${rule} ${key}: ${b} -> ${n}`);
    }
  }
  return out;
}

function sortKeys<T>(o: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function formatFailure(rule: { id: string; title: string; fix: string }, c: Comparison): string {
  const lines: string[] = [];
  if (c.grown.length) {
    const n = c.grown.reduce((a, g) => a + g.actual - g.baseline, 0);
    lines.push(`${rule.id} (${rule.title}): ${n} NEW violation(s). What to do: ${rule.fix}`);
    lines.push('A new violation may not be added to the baseline (only an ADR can: npm run arch:baseline -- --grow ADR-00xx).');
    for (const g of c.grown) {
      lines.push(`  ${g.key}: ${g.actual} found, baseline allows ${g.baseline}. Occurrences in this file:`);
      for (const x of g.violations) lines.push(`    ${x.key.includes('#') ? x.key.split('#')[0] : x.key}:${x.line}  ${x.message}`);
    }
  }
  if (c.stale.length) {
    const n = c.stale.reduce((a, s) => a + s.baseline - s.actual, 0);
    lines.push(`${rule.id}: ${n} violation(s) fixed but still in the baseline (${c.stale.length} stale entr${c.stale.length === 1 ? 'y' : 'ies'}). ` + 'Shrink it in this change: npm run arch:baseline');
    for (const s of c.stale) lines.push(`  ${s.key}: baseline ${s.baseline}, found ${s.actual}`);
  }
  return lines.join('\n');
}
