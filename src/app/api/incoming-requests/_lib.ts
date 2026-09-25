// Pure helpers of the HR approval hub (no DB), exported separately so they can be unit-tested.
import { normalizeNationality } from '@/lib/employee';

/**
 * Required Employee dates that an onboarding request may leave empty. The employee is still
 * created (with today() as a placeholder), but the placeholders are recorded on the request's
 * hrNote, on Employee.dataReviewNote, in the audit log and in the API response so HR completes
 * the employee file.
 */
export const ONBOARDING_PLACEHOLDER_LABELS = {
  dateOfBirth: 'تاريخ الميلاد',
  iqamaOrIdExp: 'تاريخ انتهاء الهوية / الإقامة',
  joinDate: 'تاريخ المباشرة',
} as const;
export type OnboardingPlaceholderField = keyof typeof ONBOARDING_PLACEHOLDER_LABELS;

const PLACEHOLDER_FIELDS = Object.keys(ONBOARDING_PLACEHOLDER_LABELS) as OnboardingPlaceholderField[];

/** Required dates that are missing (null / undefined / invalid Date) in the merged onboarding data. */
export function onboardingPlaceholderFields(
  m: Partial<Record<OnboardingPlaceholderField, Date | null | undefined>>,
): OnboardingPlaceholderField[] {
  return PLACEHOLDER_FIELDS.filter((k) => {
    const v = m[k];
    return !(v instanceof Date) || Number.isNaN(v.getTime());
  });
}

/** Arabic labels of the given placeholder fields, in the canonical order. */
export function onboardingPlaceholderLabels(fields: readonly OnboardingPlaceholderField[]): string[] {
  return PLACEHOLDER_FIELDS.filter((k) => fields.includes(k)).map((k) => ONBOARDING_PLACEHOLDER_LABELS[k]);
}

/** Label added to the review note when the request only said "non-Saudi" (legacy manager form). */
export const NATIONALITY_REVIEW_LABEL = 'الجنسية';

/**
 * Employee.dataReviewNote for an employee created from an onboarding request: lists the required
 * dates that were filled with today() plus any extra labels (e.g. an unspecified nationality);
 * null when nothing needs review.
 */
export function onboardingDataReviewNote(
  fields: readonly OnboardingPlaceholderField[],
  extraLabels: readonly string[] = [],
): string | null {
  const labels = [...onboardingPlaceholderLabels(fields), ...extraLabels.filter(Boolean)];
  if (!labels.length) return null;
  return `بيانات ناقصة من طلب مباشرة العمل (عُبئت مؤقتاً عند الاعتماد) يجب استكمالها: ${labels.join('، ')}`;
}

/** Legacy values of the old manager onboarding form ("مقيم (غير سعودي)"): nationality unknown. */
const NON_SAUDI_PLACEHOLDERS = new Set(['non_saudi', 'non saudi', 'non-saudi', 'غير سعودي', 'مقيم', 'غير محدد']);
/** Stored value for an onboarded non-Saudi whose actual nationality was not given. */
export const UNSPECIFIED_NON_SAUDI_NATIONALITY = 'غير سعودي';

/**
 * Stored nationality of an onboarded employee:
 * Saudi aliases ('SAUDI', 'سعودي', ...) -> DEFAULT_NATIONALITY; blank -> never assumed Saudi:
 * blank and legacy 'NON_SAUDI' / 'غير محدد' -> 'غير سعودي' with needsReview (HR must set the real one),
 * anything else -> trimmed as is.
 */
export function onboardingNationality(v: unknown): { nationality: string; needsReview: boolean } {
  const n = normalizeNationality(v);
  // Blank: never assume Saudi (that silently applies GOSI). Store 'غير محدد' and flag for HR review.
  if (!n) return { nationality: UNSPECIFIED_NON_SAUDI_NATIONALITY, needsReview: true };
  if (NON_SAUDI_PLACEHOLDERS.has(n.toLowerCase())) return { nationality: UNSPECIFIED_NON_SAUDI_NATIONALITY, needsReview: true };
  return { nationality: n, needsReview: false };
}
