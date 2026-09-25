// Identity-document number format checks (pure, client-safe: no server imports).
//
// HEURISTIC, NOT A REGULATION: the checks below encode the commonly observed format of Saudi
// identity numbers (national ID: 10 digits starting with 1; iqama / resident ID: 10 digits
// starting with 2). They are used ONLY to show warnings to HR (form, Excel import, the
// nationality review report) and never block a save. Border numbers and passports are free-form.

export const ID_TYPES = ['NATIONAL_ID', 'IQAMA', 'BORDER_NUMBER', 'PASSPORT'] as const;
export type IdTypeValue = (typeof ID_TYPES)[number];

export const ID_TYPE_LABELS: Record<IdTypeValue, string> = {
  NATIONAL_ID: 'هوية وطنية',
  IQAMA: 'إقامة',
  BORDER_NUMBER: 'رقم حدود',
  PASSPORT: 'جواز سفر',
};

/** Accepted spellings (enum values, Arabic labels, common English) -> IdType. */
const ID_TYPE_ALIASES: ReadonlyArray<readonly [RegExp, IdTypeValue]> = [
  [/^(national[_\s-]?id|nid|هوية(\s*وطنية)?|الهوية(\s*الوطنية)?|بطاقة\s*أحوال)$/i, 'NATIONAL_ID'],
  [/^(iqama|resident[_\s-]?id|إقامة|اقامة|الإقامة|الاقامة|هوية\s*مقيم)$/i, 'IQAMA'],
  [/^(border[_\s-]?number|border|رقم\s*حدود|حدود)$/i, 'BORDER_NUMBER'],
  [/^(passport|جواز(\s*سفر)?|جواز\s*السفر)$/i, 'PASSPORT'],
];

/** 'IQAMA' / 'إقامة' / 'iqama' -> IQAMA; blank or unknown -> null. */
export function parseIdType(v: unknown): IdTypeValue | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().replace(/\s+/g, ' ');
  if (!s) return null;
  if ((ID_TYPES as readonly string[]).includes(s.toUpperCase())) return s.toUpperCase() as IdTypeValue;
  for (const [re, t] of ID_TYPE_ALIASES) if (re.test(s)) return t;
  return null;
}

/** Trims and converts Arabic-Indic digits so "١٠٢٣..." is checked like "1023...". */
export function normalizeIdNumber(v: unknown): string {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  return String(v)
    .replace(/[‎‏\s]/g, '')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

const TEN_DIGITS = /^\d{10}$/;

/**
 * Arabic warning when `idNumber` does not have the expected format for `idType`, else null.
 * NATIONAL_ID: 10 digits starting with 1. IQAMA: 10 digits starting with 2.
 * BORDER_NUMBER / PASSPORT / unknown type: lenient (only letters, digits and '-' up to 20 chars).
 * Blank numbers return null (the "required" rule is enforced elsewhere).
 */
export function idNumberWarning(idNumber: unknown, idType: IdTypeValue | null | undefined): string | null {
  const n = normalizeIdNumber(idNumber);
  if (!n) return null;
  switch (idType) {
    case 'NATIONAL_ID':
      if (!TEN_DIGITS.test(n)) return 'رقم الهوية الوطنية يتكون عادةً من 10 أرقام';
      if (!n.startsWith('1')) return 'رقم الهوية الوطنية يبدأ عادةً بالرقم 1 (تحقق من نوع الهوية)';
      return null;
    case 'IQAMA':
      if (!TEN_DIGITS.test(n)) return 'رقم الإقامة يتكون عادةً من 10 أرقام';
      if (!n.startsWith('2')) return 'رقم الإقامة يبدأ عادةً بالرقم 2 (تحقق من نوع الهوية)';
      return null;
    default:
      if (!/^[A-Za-z0-9-]{1,20}$/.test(n)) return 'رقم الوثيقة يحتوي على رموز غير متوقعة';
      return null;
  }
}

/**
 * Heuristic nationality / ID mismatch: a Saudi whose 10-digit ID does not start with 1, or a
 * non-Saudi whose 10-digit ID starts with 1. Only 10-digit numbers are judged. Returns an Arabic
 * warning or null. `isSaudi` null (nationality unknown) -> null.
 */
export function nationalityIdMismatch(isSaudi: boolean | null | undefined, idNumber: unknown): string | null {
  if (isSaudi === null || isSaudi === undefined) return null;
  const n = normalizeIdNumber(idNumber);
  if (!TEN_DIGITS.test(n)) return null;
  if (isSaudi && !n.startsWith('1')) return 'الجنسية المسجلة سعودية بينما رقم الهوية لا يبدأ بـ 1 (يشبه رقم إقامة) — تحقق من الجنسية';
  if (!isSaudi && n.startsWith('1')) return 'الجنسية المسجلة غير سعودية بينما رقم الهوية يبدأ بـ 1 (يشبه هوية وطنية) — تحقق من الجنسية';
  return null;
}
