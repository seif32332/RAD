// Client-safe, pure employee helpers shared by the pages (client components) and the API
// (re-exported by src/lib/employee.ts). NO server imports here: no prisma, no next/server.
import { ibanWarning } from '@/lib/iban';
import { idNumberWarning, nationalityIdMismatch, parseIdType, type IdTypeValue } from '@/lib/identity';

// ---------------------------------------------------------------------------
// Nationality
// ---------------------------------------------------------------------------

/**
 * Stored value for Saudi nationality (Nationality.label and the employee form use Arabic labels).
 * DEC-002/003: nationality is REQUIRED and has NO default. This constant is the canonical Saudi
 * label for normalizing legacy spellings and for comparisons, never a fallback for a blank value.
 */
export const SAUDI_NATIONALITY = 'سعودي';

/**
 * @deprecated Kept only for modules outside the employees area that still import it. It is the
 * Saudi label (SAUDI_NATIONALITY), NOT a default: a blank nationality must be rejected.
 */
export const DEFAULT_NATIONALITY = SAUDI_NATIONALITY;

/** Arabic 400 message when a new employee (form / API / import row) has no nationality. */
export const NATIONALITY_REQUIRED_MESSAGE = 'الجنسية مطلوبة: يجب اختيارها صراحةً (لا توجد جنسية افتراضية)';

/** Legacy / alternate spellings that mean Saudi ('SAUDI' was the old form default and DB default). */
const SAUDI_NATIONALITY_ALIASES = new Set(['saudi', 'saudi arabia', 'saudi arabian', 'sa', 'ksa', 'سعودي', 'سعودى', 'سعودية', 'السعودية']);

/** Trims a nationality and maps every Saudi alias to SAUDI_NATIONALITY. Blank / not a string -> null. */
export function normalizeNationality(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/\s+/g, ' ');
  if (!s) return null;
  return SAUDI_NATIONALITY_ALIASES.has(s.toLowerCase()) ? SAUDI_NATIONALITY : s;
}

/** True when the stored nationality (any legacy spelling) is Saudi. */
export function isSaudiNationalityValue(v: unknown): boolean {
  return normalizeNationality(v) === SAUDI_NATIONALITY;
}

// ---------------------------------------------------------------------------
// GOSI regime (DEC-003): OLD / NEW / UNKNOWN, confirmed by HR from a source document
// ---------------------------------------------------------------------------

export const GOSI_REGIMES = ['OLD', 'NEW', 'UNKNOWN'] as const;
export type GosiRegimeValue = (typeof GOSI_REGIMES)[number];

export const GOSI_REGIME_LABELS: Record<GosiRegimeValue, string> = {
  OLD: 'النظام السابق (مشترك قبل 2024-07-03)',
  NEW: 'النظام الجديد',
  UNKNOWN: 'غير مؤكد — يلزم تأكيد الموارد البشرية',
};

/** Suggested values for Employee.gosiRegistrationSource (free text is accepted too). */
export const GOSI_SOURCE_SUGGESTIONS = ['شهادة اشتراك التأمينات', 'قائمة مشتركي المنشأة في GOSI', 'إفادة الموظف مع مستند'] as const;

/** 'OLD' / 'قديم' / 'new' / 'جديد' -> regime; blank or unknown -> null. */
export function parseGosiRegime(v: unknown): GosiRegimeValue | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase();
  if (!s) return null;
  if ((GOSI_REGIMES as readonly string[]).includes(s)) return s as GosiRegimeValue;
  if (/قديم|سابق/.test(s)) return 'OLD';
  if (/جديد/.test(s)) return 'NEW';
  return null;
}

// ---------------------------------------------------------------------------
// Data-quality warnings (never block a save): IBAN, ID format, nationality/ID, probation
// ---------------------------------------------------------------------------

/**
 * Probation length above which the form / API / import show a warning (DEC-003 "تحذير لا منع
 * عند probationDays > 180"). It is a review prompt for HR, not a legal ruling.
 */
export const PROBATION_WARNING_DAYS = 180;

export function probationWarning(days: number | null | undefined): string | null {
  if (days === null || days === undefined || !Number.isFinite(days)) return null;
  if (days <= PROBATION_WARNING_DAYS) return null;
  return `مدة فترة التجربة (${Math.round(days)} يوماً) تتجاوز ${PROBATION_WARNING_DAYS} يوماً — يُرجى التحقق من توافقها مع نظام العمل وعقد الموظف (تنبيه فقط)`;
}

export interface EmployeeDataWarning {
  field: 'ibanNumber' | 'iqamaOrIdNumber' | 'nationality' | 'probationDays' | 'basicSalary' | 'contractEndDate';
  message: string;
}

export interface EmployeeWarningInput {
  ibanNumber?: unknown;
  iqamaOrIdNumber?: unknown;
  idType?: unknown;
  nationality?: unknown;
  probationDays?: number | null;
  basicSalary?: number | null;
  /**
   * Checked only when the key is present: a non-Saudi without a contract end date gets a warning
   * (Labor Law art. 37). Callers that do not know the value (e.g. a partial update) omit the key.
   */
  contractEndDate?: unknown;
  /**
   * Codes / labels of OTHER employees that already use the same IBAN (the caller looks them up).
   * Checked only when given; an empty list means "not shared".
   */
  ibanSharedWith?: ReadonlyArray<string> | null;
}

/** Warning text when a non-Saudi employee has no contract end date (Saudi Labor Law art. 37). */
export const NON_SAUDI_CONTRACT_END_WARNING =
  'الموظف غير سعودي ولا يوجد تاريخ انتهاء للعقد: عقد غير السعودي محدد المدة (المادة 37 من نظام العمل)، وإذا خلا من المدة عُدّت مدة رخصة العمل مدةً له — أضف تاريخ انتهاء العقد';

/** How many other-employee codes the shared-IBAN warning lists before "و N آخرون". */
const SHARED_IBAN_LIST_MAX = 3;

/** "رقم الآيبان نفسه مسجل أيضاً لـ: EMP-0001، EMP-0002 …" or null when the list is empty. */
export function sharedIbanWarning(others: ReadonlyArray<string> | null | undefined): string | null {
  const list = [...new Set((others ?? []).map((o) => o.trim()).filter(Boolean))];
  if (list.length === 0) return null;
  const shown = list.slice(0, SHARED_IBAN_LIST_MAX).join('، ');
  const rest = list.length - SHARED_IBAN_LIST_MAX;
  const tail = rest > 0 ? ` و${rest} آخرين` : '';
  return `رقم الآيبان نفسه مسجل أيضاً لـ: ${shown}${tail} — تحقق من صاحب الحساب قبل صرف الرواتب (تنبيه فقط)`;
}

function isBlankValue(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/**
 * Warnings shown inline in the employee form, returned by POST/PUT /api/employees and listed per
 * row by the Excel import. Only the fields present in `input` are checked.
 */
export function employeeDataWarnings(input: EmployeeWarningInput): EmployeeDataWarning[] {
  const out: EmployeeDataWarning[] = [];
  const iban = ibanWarning(input.ibanNumber);
  if (iban) out.push({ field: 'ibanNumber', message: iban });
  // One IBAN message per field: a malformed IBAN is fixed first.
  const shared = !iban && !isBlankValue(input.ibanNumber) ? sharedIbanWarning(input.ibanSharedWith) : null;
  if (shared) out.push({ field: 'ibanNumber', message: shared });

  const idType: IdTypeValue | null = parseIdType(input.idType);
  const idFormat = idNumberWarning(input.iqamaOrIdNumber, idType);
  if (idFormat) out.push({ field: 'iqamaOrIdNumber', message: idFormat });
  const nat = normalizeNationality(input.nationality);
  const mismatch = nat ? nationalityIdMismatch(nat === SAUDI_NATIONALITY, input.iqamaOrIdNumber) : null;
  // Same root cause as a NATIONAL_ID / IQAMA format warning: show one message, not two.
  if (mismatch && !idFormat) out.push({ field: 'nationality', message: mismatch });

  const prob = probationWarning(input.probationDays);
  if (prob) out.push({ field: 'probationDays', message: prob });

  if (input.basicSalary !== undefined && input.basicSalary !== null && Number.isFinite(input.basicSalary) && input.basicSalary <= 0) {
    out.push({ field: 'basicSalary', message: 'الراتب الأساسي صفر — تحقق من القيمة' });
  }

  if ('contractEndDate' in input && nat && nat !== SAUDI_NATIONALITY && isBlankValue(input.contractEndDate)) {
    out.push({ field: 'contractEndDate', message: NON_SAUDI_CONTRACT_END_WARNING });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Employee.dataReviewNote ("بيانات ناقصة يجب استكمالها: label1، label2")
// ---------------------------------------------------------------------------

/**
 * Employee fields that a review note may list, with the Arabic labels used by the notes
 * (onboarding approval writes "…: تاريخ الميلاد، تاريخ انتهاء الهوية / الإقامة، تاريخ المباشرة، الجنسية").
 */
export const DATA_REVIEW_FIELD_LABELS = {
  dateOfBirth: 'تاريخ الميلاد',
  iqamaOrIdExp: 'تاريخ انتهاء الهوية / الإقامة',
  joinDate: 'تاريخ المباشرة',
  nationality: 'الجنسية',
  iqamaOrIdNumber: 'رقم الهوية / الإقامة',
  passportNumber: 'رقم الجواز',
  passportExp: 'تاريخ انتهاء الجواز',
  ibanNumber: 'رقم الآيبان',
  bankName: 'اسم البنك',
  mobileNumber: 'رقم الجوال',
} as const;
export type DataReviewField = keyof typeof DATA_REVIEW_FIELD_LABELS;

/** Alternate spellings of the labels above (legacy notes / hand-written notes). */
const DATA_REVIEW_LABEL_ALIASES: ReadonlyArray<readonly [string, DataReviewField]> = [
  ['تاريخ انتهاء الهوية', 'iqamaOrIdExp'],
  ['تاريخ انتهاء الإقامة', 'iqamaOrIdExp'],
  ['انتهاء الهوية', 'iqamaOrIdExp'],
  ['تاريخ مباشرة العمل', 'joinDate'],
  ['تاريخ الانضمام', 'joinDate'],
  ['رقم الهوية', 'iqamaOrIdNumber'],
  ['رقم الإقامة', 'iqamaOrIdNumber'],
  ['رقم جواز السفر', 'passportNumber'],
  ['الآيبان', 'ibanNumber'],
  ['الايبان', 'ibanNumber'],
  ['IBAN', 'ibanNumber'],
  ['البنك', 'bankName'],
  ['الجوال', 'mobileNumber'],
];

/** Collapses whitespace and unifies alef forms so "الاقامة" matches "الإقامة". */
function normalizeLabel(s: string): string {
  return s.replace(/\s*\/\s*/g, ' / ').replace(/\s+/g, ' ').replace(/[أإآ]/g, 'ا').trim().toLowerCase();
}

const LABEL_LOOKUP: ReadonlyArray<readonly [string, DataReviewField]> = [
  ...(Object.entries(DATA_REVIEW_FIELD_LABELS) as Array<[DataReviewField, string]>).map(([f, l]) => [normalizeLabel(l), f] as const),
  ...DATA_REVIEW_LABEL_ALIASES.map(([l, f]) => [normalizeLabel(l), f] as const),
];

/** Field a review-note label refers to (exact label first, then the longest known label it contains); null if unknown. */
export function dataReviewFieldOfLabel(label: string): DataReviewField | null {
  const n = normalizeLabel(label);
  if (!n) return null;
  const exact = LABEL_LOOKUP.find(([l]) => l === n);
  if (exact) return exact[1];
  let best: readonly [string, DataReviewField] | null = null;
  for (const entry of LABEL_LOOKUP) {
    if (n.includes(entry[0]) && (!best || entry[0].length > best[0].length)) best = entry;
  }
  return best ? best[1] : null;
}

/** Splits "prefix: a، b, c" into its prefix and listed labels. No ':' -> the whole note is the prefix. */
export function parseDataReviewNote(note: string | null | undefined): { prefix: string; labels: string[] } | null {
  const s = (note ?? '').trim();
  if (!s) return null;
  const idx = Math.max(s.lastIndexOf(':'), s.lastIndexOf('：'));
  if (idx < 0) return { prefix: s, labels: [] };
  const labels = s
    .slice(idx + 1)
    .split(/[،,؛;\n]/)
    .map((l) => l.trim().replace(/[.。]+$/, '').trim())
    .filter(Boolean);
  return { prefix: s.slice(0, idx).trim(), labels };
}

/** Known employee fields listed by the note (in note order, without duplicates). */
export function dataReviewFields(note: string | null | undefined): DataReviewField[] {
  const parsed = parseDataReviewNote(note);
  if (!parsed) return [];
  const out: DataReviewField[] = [];
  for (const l of parsed.labels) {
    const f = dataReviewFieldOfLabel(l);
    if (f && !out.includes(f)) out.push(f);
  }
  return out;
}

/**
 * Review note after an edit that completed `completed` fields:
 * - every listed label resolved -> null (the warning disappears),
 * - some resolved -> same prefix with only the remaining labels,
 * - nothing resolved (or labels unknown) -> the note unchanged (HR clears it by hand).
 */
export function resolveDataReviewNote(note: string | null | undefined, completed: Iterable<string>): string | null {
  const parsed = parseDataReviewNote(note);
  if (!parsed) return null;
  const done = new Set(completed);
  const remaining = parsed.labels.filter((l) => {
    const f = dataReviewFieldOfLabel(l);
    return !f || !done.has(f);
  });
  if (remaining.length === parsed.labels.length) return (note ?? '').trim();
  if (remaining.length === 0) return null;
  return `${parsed.prefix}: ${remaining.join('، ')}`;
}
