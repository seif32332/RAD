// Workforce engine: who may see disability / identity data, and the redaction applied to API responses
// and saved snapshots. PURE, client-safe (no Prisma). SPEC «خصوصية بيانات الإعاقة».
//
// Visibility follows the employees API (src/lib/employee.ts employeeAccessLevel + PAYROLL_HIDDEN_FIELDS):
// the HR group (SUPER_ADMIN, COMPANY_ADMIN, HR_MANAGER) sees isDisabled; FINANCE_MANAGER / PAYROLL_ADMIN
// (and anyone else) do not. The engine keeps computing with the real data (the HRDF +10% category for a
// disabled employee changes the amount); only the WORDING that names the category is redacted, the amount
// and the percentage stay (residual inference risk documented in the SPEC).
import { ROLE_GROUPS, roleIn } from '@/lib/constants';
import { HRDF_CATEGORY_LABELS, HRDF_NEUTRAL_CATEGORIES_TEXT, hrdfNote } from '@/lib/workforce/true-cost';
import type { CostLine, EmployeeMonth, HrdfCategory } from '@/lib/workforce/types';

/**
 * Employee fields never stored in a saved calculation and removed from any snapshot read by a viewer who
 * may not see them. Same list as src/lib/employee.ts PAYROLL_HIDDEN_FIELDS (identity + disability; kept in
 * sync by src/lib/__tests__/wf-privacy.test.ts) — employee.ts is not imported here because it pulls Prisma.
 */
export const SENSITIVE_EMPLOYEE_FIELDS = [
  'iqamaOrIdNumber',
  'passportNumber',
  'dateOfBirth',
  'iqamaCopyUrl',
  'passportCopyUrl',
  'isDisabled',
  'muawamaCertExpiry',
] as const;

/** Categories whose NAME is health data. */
const SENSITIVE_HRDF_CATEGORIES: ReadonlyArray<HrdfCategory> = ['DISABLED'];

/** May this role see disability data (the category names of the HRDF line)? Same as isDisabled in the employees API. */
export function canSeeDisability(role: string | null | undefined): boolean {
  return roleIn(role, ROLE_GROUPS.HR);
}

/**
 * HRDF_SUBSIDY line as a viewer who may not see disability receives it: the category list is replaced
 * with HRDF_NEUTRAL_CATEGORIES_TEXT and the codes are dropped, for EVERY line that has categories (not only
 * disabled employees', otherwise the neutral text itself would single them out). Other lines unchanged.
 */
export function redactCostLine<T extends Pick<CostLine, 'key' | 'note' | 'categories'>>(line: T): T {
  if (line.key !== 'HRDF_SUBSIDY') return line;
  const hasList = !!line.categories?.length || (typeof line.note === 'string' && line.note.includes('الفئات:'));
  if (!hasList) return line;
  const { categories: _c, ...rest } = line;
  return { ...rest, note: hrdfNote('REDACTED') } as T;
}

export function redactMonths(months: ReadonlyArray<EmployeeMonth>): EmployeeMonth[] {
  return months.map((m) => (m.lines.some((l) => l.key === 'HRDF_SUBSIDY') ? { ...m, lines: m.lines.map(redactCostLine) } : m));
}

/** Copy of an employee input without SENSITIVE_EMPLOYEE_FIELDS (what a saved calculation stores). */
export function stripSensitiveEmployeeFields<T extends object>(row: T): Omit<T, (typeof SENSITIVE_EMPLOYEE_FIELDS)[number]> {
  const out = { ...row } as Record<string, unknown>;
  for (const f of SENSITIVE_EMPLOYEE_FIELDS) delete out[f];
  return out as Omit<T, (typeof SENSITIVE_EMPLOYEE_FIELDS)[number]>;
}

const SENSITIVE_KEYS: ReadonlySet<string> = new Set(SENSITIVE_EMPLOYEE_FIELDS);
const SENSITIVE_LABELS: ReadonlyArray<string> = SENSITIVE_HRDF_CATEGORIES.map((c) => HRDF_CATEGORY_LABELS[c]);
const CATEGORY_LIST = /الفئات: [^؛|\n]*/g;

/**
 * Deep copy of a saved snapshot's JSON (inputs / outputs, any engine version) for a viewer who may not see
 * disability: drops SENSITIVE_EMPLOYEE_FIELDS keys at any depth, redacts every HRDF_SUBSIDY line
 * (redactCostLine), and — for snapshots written before the codes existed — replaces any "الفئات: …" list
 * that names a sensitive category, and any remaining sensitive category label, with the neutral text.
 */
export function redactSnapshotJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSnapshotJson);
  if (typeof value === 'string') {
    if (!SENSITIVE_LABELS.some((l) => value.includes(l))) return value;
    let s = value.replace(CATEGORY_LIST, (m) => (SENSITIVE_LABELS.some((l) => m.includes(l)) ? `الفئات: ${HRDF_NEUTRAL_CATEGORIES_TEXT}` : m));
    for (const l of SENSITIVE_LABELS) s = s.split(l).join(HRDF_NEUTRAL_CATEGORIES_TEXT);
    return s;
  }
  if (!value || typeof value !== 'object') return value;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (SENSITIVE_KEYS.has(k)) continue;
    out[k] = redactSnapshotJson(v);
  }
  if (out.key === 'HRDF_SUBSIDY' && typeof out.kind === 'string') return redactCostLine(out as unknown as CostLine);
  return out;
}
