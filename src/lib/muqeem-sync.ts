// Resident sync with Muqeem (مطابقة المقيمين): pure, client-safe helpers (no server imports).
//
// The API routes (src/app/api/integrations/muqeem/residents/**) fetch the active residents report of
// a company's MOI number, normalize it (normalizeActiveResidents) and compare it here with the
// Radeef employees whose legal (sponsoring) company is that company, matched by iqama number.
//
// Categories of the diff:
//   (a) mismatched   : in both, with differences in the syncable fields (iqama expiry, passport number,
//                      passport expiry, occupation, dependents count) and/or a name mismatch
//                      (information only, never applied);
//   (b) onlyInMuqeem : active resident of the establishment with no active non-Saudi employee of this
//                      company in Radeef (possibly unregistered; hints for terminated / Saudi / other company);
//   (c) onlyInRadeef : active non-Saudi employee of this company not in the report (possibly transferred / left);
//   (d) matchedCount : in both without any difference (count only).
// Saudi employees are not residents: they are never compared and never updated.
import { dateKey } from '@/lib/dates';
import { isSaudiNationalityValue } from '@/lib/employee-shared';
import type { NormalizedResident } from '@/lib/muqeem/types';

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/** Employee fields that can be copied from Muqeem. */
export const SYNC_FIELDS = ['iqamaOrIdExp', 'passportNumber', 'passportExp', 'occupationName', 'dependentsCount'] as const;
export type SyncField = (typeof SYNC_FIELDS)[number];

export const SYNC_FIELD_LABELS: Record<SyncField, string> = {
  iqamaOrIdExp: 'تاريخ انتهاء الإقامة',
  passportNumber: 'رقم الجواز',
  passportExp: 'تاريخ انتهاء الجواز',
  occupationName: 'المهنة',
  dependentsCount: 'عدد المرافقين',
};

export function isSyncField(v: unknown): v is SyncField {
  return typeof v === 'string' && (SYNC_FIELDS as readonly string[]).includes(v);
}

/** Arabic names of MuqeemTransaction.operation values (MUQEEM_OPERATIONS). */
export const MUQEEM_OPERATION_LABELS: Record<string, string> = {
  EXIT_REENTRY_ISSUE: 'إصدار تأشيرة خروج وعودة',
  EXIT_REENTRY_EXTEND: 'تمديد تأشيرة خروج وعودة',
  EXIT_REENTRY_CANCEL: 'إلغاء تأشيرة خروج وعودة',
  EXIT_REENTRY_REPRINT: 'إعادة طباعة تأشيرة خروج وعودة',
  FINAL_EXIT_ISSUE: 'إصدار تأشيرة خروج نهائي',
  FINAL_EXIT_CANCEL: 'إلغاء تأشيرة خروج نهائي',
  FINAL_EXIT_PROBATION_ISSUE: 'خروج نهائي خلال فترة التجربة',
  IQAMA_RENEW: 'تجديد الإقامة',
  IQAMA_ISSUE: 'إصدار إقامة',
  IQAMA_TRANSFER: 'نقل خدمات',
  IQAMA_REPLACEMENT: 'بدل فاقد / تالف للإقامة',
  IQAMA_REPORT_MISSING: 'بلاغ فقدان إقامة',
  RESIDENT_DROP: 'إسقاط مقيم',
  PASSPORT_RENEW: 'تحديث المعلومات: جواز جديد',
  PASSPORT_EXTEND: 'تحديث المعلومات: تمديد صلاحية الجواز',
  OCCUPATION_CHANGE: 'تغيير المهنة',
  TRANSLATED_NAME_UPDATE: 'تعديل الاسم المترجم',
  VISIT_VISA_EXTEND: 'تمديد تأشيرة الزيارة',
};

export const operationLabel = (op: string) => MUQEEM_OPERATION_LABELS[op] ?? op;

/** Hard cap on the number of residents read from the report (pagination stops there). */
export const MAX_SYNC_RESIDENTS = 5000;
/** Page size requested from Muqeem. */
export const SYNC_PAGE_SIZE = 500;

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

const ARABIC_DIGITS = /[٠-٩۰-۹]/g;

function latinDigits(s: string): string {
  return s.replace(ARABIC_DIGITS, (d) => {
    const c = d.charCodeAt(0);
    return String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660);
  });
}

/** Iqama / ID number as digits only (Arabic-Indic digits converted, spaces and dashes removed). Blank -> null. */
export function normalizeIqamaNumber(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = latinDigits(String(v)).replace(/[\s\u200E\u200F-]/g, '');
  return /^\d+$/.test(s) ? s : null;
}

/** Passport number for comparison: upper-case, no spaces or dashes. Blank -> null. */
export function normalizePassportNumber(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = latinDigits(String(v)).replace(/[\s\u200E\u200F-]/g, '').toUpperCase();
  return s || null;
}

/**
 * Occupation for comparison: same unification as person names (hamza / taa marbuta / diacritics,
 * case, punctuation, spaces). Blank -> ''.
 */
export function normalizeOccupation(v: unknown): string {
  return normalizePersonName(v);
}

/** Occupation to store: trimmed, inner spaces collapsed (as printed by Muqeem). */
function occupationForStorage(v: string): string {
  return v.trim().replace(/\s+/g, ' ');
}

/** Dependents count reported by Muqeem when it is a plausible whole number (0..30), else null. */
export function muqeemDependentsCount(r: Pick<SyncResident, 'dependentsCount'>): number | null {
  const n = r.dependentsCount;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 30 ? n : null;
}

/** Passport number to store: trimmed, upper-case (as printed by Muqeem). */
function passportForStorage(v: string): string {
  return latinDigits(v).trim().replace(/\s+/g, '').toUpperCase();
}

/**
 * Name for comparison: Arabic diacritics / tatweel removed, alef/yaa/taa-marbuta forms unified,
 * Latin lower-cased, punctuation dropped, spaces collapsed.
 */
export function normalizePersonName(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v
    .normalize('NFKC')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Loose name equality: identical after normalization, or same first AND last token (Radeef often
 * stores "first + last" while Muqeem has the full 4-part name). Empty names are never a mismatch.
 */
export function namesLooselyMatch(a: unknown, b: unknown): boolean {
  const x = normalizePersonName(a);
  const y = normalizePersonName(b);
  if (!x || !y) return true;
  if (x === y) return true;
  const tx = x.split(' ');
  const ty = y.split(' ');
  return tx[0] === ty[0] && tx[tx.length - 1] === ty[ty.length - 1];
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

/** Minimal employee shape the diff needs (dates as Date or ISO string). */
export interface SyncEmployee {
  id: string;
  /** Employee code (الرقم الوظيفي). */
  employeeCode: string;
  nameArabic: string;
  nameEnglish: string | null;
  nationality: string | null;
  iqamaOrIdNumber: string;
  iqamaOrIdExp: Date | string | null;
  passportNumber: string | null;
  passportExp: Date | string | null;
  /** Employee.occupationName (the occupation as recorded in Muqeem / Qiwa). */
  occupationName: string | null;
  /** Employee.dependentsCount (null = unknown). */
  dependentsCount: number | null;
  isTerminated: boolean;
  legalCompanyId: string | null;
}

/** Minimal resident shape (NormalizedResident without `raw`). */
export type SyncResident = Pick<
  NormalizedResident,
  'iqamaNumber' | 'name' | 'translatedName' | 'nationality' | 'occupation' | 'iqamaExpiry' | 'passportNumber' | 'passportExpiry' | 'dependentsCount'
>;

export interface FieldDiff {
  field: SyncField;
  label: string;
  /** Display value in Radeef ('YYYY-MM-DD' for dates), null when empty. */
  radeef: string | null;
  /** Display value in Muqeem, never null (a missing Muqeem value is not a difference). */
  muqeem: string;
}

export interface MismatchedRow {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  iqamaNumber: string;
  residentName: string | null;
  residentTranslatedName: string | null;
  /** Differences that can be applied (Muqeem value -> employee). */
  diffs: FieldDiff[];
  /** Neither the Arabic nor the English name matches Muqeem's: information only. */
  nameMismatch: boolean;
}

export type OnlyInMuqeemHint =
  /** An employee with this iqama exists in this company but is terminated in Radeef. */
  | 'TERMINATED_IN_RADEEF'
  /** An employee with this iqama exists but under another legal company. */
  | 'OTHER_COMPANY'
  /** The matching employee is recorded as Saudi in Radeef. */
  | 'SAUDI_IN_RADEEF';

export interface OnlyInMuqeemRow {
  iqamaNumber: string;
  name: string | null;
  translatedName: string | null;
  nationality: string | null;
  occupation: string | null;
  iqamaExpiry: string | null;
  passportNumber: string | null;
  passportExpiry: string | null;
  hint: OnlyInMuqeemHint | null;
  /** The Radeef employee behind the hint (when any). */
  employee: { id: string; employeeCode: string; name: string } | null;
}

export interface OnlyInRadeefRow {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  iqamaNumber: string;
  nationality: string | null;
  iqamaExpiry: string | null;
}

export interface ResidentDiff {
  mismatched: MismatchedRow[];
  onlyInMuqeem: OnlyInMuqeemRow[];
  onlyInRadeef: OnlyInRadeefRow[];
  matchedCount: number;
  counts: {
    residents: number;
    /** Active non-Saudi employees of the company in Radeef. */
    radeefResidents: number;
    mismatched: number;
    onlyInMuqeem: number;
    onlyInRadeef: number;
    matched: number;
    /** Active Saudi employees of the company, skipped (not residents). */
    skippedSaudi: number;
    /** Report rows repeating an iqama number already seen (ignored). */
    duplicateResidents: number;
  };
}

function employeeName(e: SyncEmployee): string {
  return e.nameArabic.trim() || (e.nameEnglish ?? '').trim() || e.employeeCode;
}

/** Differences between an employee and its resident row, for the requested fields (default: all). */
export function fieldDiffs(e: SyncEmployee, r: SyncResident, fields: readonly SyncField[] = SYNC_FIELDS): FieldDiff[] {
  const out: FieldDiff[] = [];
  for (const field of fields) {
    let radeef: string | null;
    let muqeem: string | null;
    let differs: boolean;
    if (field === 'passportNumber') {
      radeef = e.passportNumber?.trim() || null;
      muqeem = r.passportNumber?.trim() || null;
      differs = !!muqeem && normalizePassportNumber(radeef) !== normalizePassportNumber(muqeem);
    } else if (field === 'occupationName') {
      radeef = e.occupationName?.trim() || null;
      muqeem = r.occupation ? occupationForStorage(r.occupation) || null : null;
      differs = !!muqeem && normalizeOccupation(radeef) !== normalizeOccupation(muqeem);
    } else if (field === 'dependentsCount') {
      // 0 is a real value from Muqeem ("no dependents"); a missing count is never a difference.
      radeef = e.dependentsCount === null || e.dependentsCount === undefined ? null : String(e.dependentsCount);
      const count = muqeemDependentsCount(r);
      muqeem = count === null ? null : String(count);
      differs = muqeem !== null && radeef !== muqeem;
    } else {
      radeef = dateKey(field === 'iqamaOrIdExp' ? e.iqamaOrIdExp : e.passportExp);
      muqeem = dateKey(field === 'iqamaOrIdExp' ? r.iqamaExpiry : r.passportExpiry);
      differs = !!muqeem && radeef !== muqeem;
    }
    if (differs && muqeem) out.push({ field, label: SYNC_FIELD_LABELS[field], radeef, muqeem });
  }
  return out;
}

/** True when neither the Arabic nor the English name of the employee matches Muqeem's names. */
export function isNameMismatch(e: SyncEmployee, r: SyncResident): boolean {
  if (!r.name && !r.translatedName) return false;
  const arabicOk = !!r.name && !!e.nameArabic.trim() && namesLooselyMatch(e.nameArabic, r.name);
  const englishOk = !!r.translatedName && !!e.nameEnglish?.trim() && namesLooselyMatch(e.nameEnglish, r.translatedName);
  if (arabicOk || englishOk) return false;
  // Nothing comparable on our side (e.g. only an English name in Muqeem and none in Radeef).
  const comparable = (!!r.name && !!e.nameArabic.trim()) || (!!r.translatedName && !!e.nameEnglish?.trim());
  return comparable;
}

/**
 * Compares the active residents report with Radeef employees.
 * `employees` must contain the employees of `companyId` (terminated included) and may contain
 * employees of other companies whose iqama appears in the report (to explain category (b)).
 */
export function computeResidentDiff(companyId: string, residents: readonly SyncResident[], employees: readonly SyncEmployee[]): ResidentDiff {
  const byIqama = new Map<string, SyncEmployee>();
  for (const e of employees) {
    const k = normalizeIqamaNumber(e.iqamaOrIdNumber);
    if (!k) continue;
    const prev = byIqama.get(k);
    // Prefer the employee of this company, then an active one.
    if (!prev || (prev.legalCompanyId !== companyId && e.legalCompanyId === companyId) || (prev.isTerminated && !e.isTerminated && e.legalCompanyId === companyId)) {
      byIqama.set(k, e);
    }
  }

  const mismatched: MismatchedRow[] = [];
  const onlyInMuqeem: OnlyInMuqeemRow[] = [];
  const matchedEmployeeIds = new Set<string>();
  const seen = new Set<string>();
  let matchedCount = 0;
  let duplicateResidents = 0;

  for (const r of residents) {
    const iqama = normalizeIqamaNumber(r.iqamaNumber);
    if (!iqama) continue;
    if (seen.has(iqama)) {
      duplicateResidents++;
      continue;
    }
    seen.add(iqama);

    const e = byIqama.get(iqama);
    let hint: OnlyInMuqeemHint | null = null;
    if (e) {
      if (e.legalCompanyId !== companyId) hint = 'OTHER_COMPANY';
      else if (e.isTerminated) hint = 'TERMINATED_IN_RADEEF';
      else if (isSaudiNationalityValue(e.nationality)) hint = 'SAUDI_IN_RADEEF';
    }

    if (!e || hint) {
      onlyInMuqeem.push({
        iqamaNumber: iqama,
        name: r.name,
        translatedName: r.translatedName,
        nationality: r.nationality,
        occupation: r.occupation,
        iqamaExpiry: dateKey(r.iqamaExpiry),
        passportNumber: r.passportNumber,
        passportExpiry: dateKey(r.passportExpiry),
        hint,
        employee: e ? { id: e.id, employeeCode: e.employeeCode, name: employeeName(e) } : null,
      });
      if (e) matchedEmployeeIds.add(e.id);
      continue;
    }

    matchedEmployeeIds.add(e.id);
    const diffs = fieldDiffs(e, r);
    const nameMismatch = isNameMismatch(e, r);
    if (!diffs.length && !nameMismatch) {
      matchedCount++;
      continue;
    }
    mismatched.push({
      employeeId: e.id,
      employeeCode: e.employeeCode,
      employeeName: employeeName(e),
      iqamaNumber: iqama,
      residentName: r.name,
      residentTranslatedName: r.translatedName,
      diffs,
      nameMismatch,
    });
  }

  const onlyInRadeef: OnlyInRadeefRow[] = [];
  let radeefResidents = 0;
  let skippedSaudi = 0;
  for (const e of employees) {
    if (e.legalCompanyId !== companyId || e.isTerminated) continue;
    if (isSaudiNationalityValue(e.nationality)) {
      skippedSaudi++;
      continue;
    }
    radeefResidents++;
    if (matchedEmployeeIds.has(e.id)) continue;
    onlyInRadeef.push({
      employeeId: e.id,
      employeeCode: e.employeeCode,
      employeeName: employeeName(e),
      iqamaNumber: normalizeIqamaNumber(e.iqamaOrIdNumber) ?? e.iqamaOrIdNumber,
      nationality: e.nationality,
      iqamaExpiry: dateKey(e.iqamaOrIdExp),
    });
  }

  const byName = (a: { employeeName: string }, b: { employeeName: string }) => a.employeeName.localeCompare(b.employeeName, 'ar');
  mismatched.sort(byName);
  onlyInRadeef.sort(byName);
  onlyInMuqeem.sort((a, b) => a.iqamaNumber.localeCompare(b.iqamaNumber));

  return {
    mismatched,
    onlyInMuqeem,
    onlyInRadeef,
    matchedCount,
    counts: {
      residents: seen.size,
      radeefResidents,
      mismatched: mismatched.length,
      onlyInMuqeem: onlyInMuqeem.length,
      onlyInRadeef: onlyInRadeef.length,
      matched: matchedCount,
      skippedSaudi,
      duplicateResidents,
    },
  };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface FieldChange {
  field: SyncField;
  before: string | null;
  after: string;
}

export interface EmployeeUpdatePlan {
  /** Prisma update data (only the fields that really change). */
  data: { iqamaOrIdExp?: Date; passportNumber?: string; passportExp?: Date; occupationName?: string; dependentsCount?: number };
  changes: FieldChange[];
  /** Requested fields left untouched, with the reason. */
  unchanged: { field: SyncField; reason: 'SAME_VALUE' | 'NO_MUQEEM_VALUE' }[];
}

const utcDay = (key: string) => new Date(`${key}T00:00:00.000Z`);

/** What applying `fields` from the resident row would change on the employee (values from Muqeem only). */
export function planEmployeeUpdate(e: SyncEmployee, r: SyncResident, fields: readonly SyncField[]): EmployeeUpdatePlan {
  const plan: EmployeeUpdatePlan = { data: {}, changes: [], unchanged: [] };
  const wanted = SYNC_FIELDS.filter((f) => fields.includes(f));
  const diffs = new Map(fieldDiffs(e, r, wanted).map((d) => [d.field, d]));
  for (const field of wanted) {
    const d = diffs.get(field);
    if (!d) {
      const hasMuqeemValue =
        field === 'passportNumber'
          ? !!r.passportNumber?.trim()
          : field === 'occupationName'
            ? !!r.occupation?.trim()
            : field === 'dependentsCount'
              ? muqeemDependentsCount(r) !== null
              : !!dateKey(field === 'iqamaOrIdExp' ? r.iqamaExpiry : r.passportExpiry);
      plan.unchanged.push({ field, reason: hasMuqeemValue ? 'SAME_VALUE' : 'NO_MUQEEM_VALUE' });
      continue;
    }
    let after = d.muqeem;
    if (field === 'passportNumber') plan.data.passportNumber = after = passportForStorage(d.muqeem);
    else if (field === 'occupationName') plan.data.occupationName = after = occupationForStorage(d.muqeem);
    else if (field === 'dependentsCount') plan.data.dependentsCount = Number(d.muqeem);
    else if (field === 'iqamaOrIdExp') plan.data.iqamaOrIdExp = utcDay(d.muqeem);
    else plan.data.passportExp = utcDay(d.muqeem);
    plan.changes.push({ field, before: d.radeef, after });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Report pagination
// ---------------------------------------------------------------------------

export interface ReportPage<T> {
  /** Normalized rows of this page. */
  rows: T[];
  /** Number of raw rows the page contained (before normalization dropped any). */
  rawCount: number;
  /** Total element count announced by the report, when any. */
  total: number | null;
}

export interface CollectedReport<T> {
  rows: T[];
  pages: number;
  /** Stopped at the cap: more residents may exist. */
  truncated: boolean;
  total: number | null;
}

/**
 * Reads a paginated report until a short / empty page, the announced total, a repeated page
 * (a server ignoring `page`), or the cap. Pure: the page fetcher is injected.
 */
export async function collectReportPages<T>(
  fetchPage: (page: number, size: number) => Promise<ReportPage<T>>,
  options: { pageSize?: number; cap?: number; keyOf?: (row: T) => string | null } = {},
): Promise<CollectedReport<T>> {
  const size = Math.max(1, options.pageSize ?? SYNC_PAGE_SIZE);
  const cap = Math.max(1, options.cap ?? MAX_SYNC_RESIDENTS);
  const maxPages = Math.ceil(cap / size) + 1;
  const rows: T[] = [];
  let total: number | null = null;
  let pages = 0;
  let truncated = false;
  let previousFirstKey: string | null = null;

  for (let page = 0; page < maxPages; page++) {
    const res = await fetchPage(page, size);
    pages++;
    if (res.total !== null) total = res.total;
    const firstKey = options.keyOf && res.rows.length ? options.keyOf(res.rows[0]) : null;
    if (page > 0 && firstKey !== null && firstKey === previousFirstKey) break; // same page again
    previousFirstKey = firstKey;

    const room = cap - rows.length;
    if (res.rows.length > room) {
      rows.push(...res.rows.slice(0, room));
      truncated = true;
      break;
    }
    rows.push(...res.rows);
    if (res.rawCount < size) break;
    if (total !== null && (page + 1) * size >= total) break;
    if (rows.length >= cap) {
      truncated = total === null || total > cap;
      break;
    }
  }
  return { rows, pages, truncated, total };
}
