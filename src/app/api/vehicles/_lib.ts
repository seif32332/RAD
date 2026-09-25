// Vehicle validation schemas and pure helpers. Private module (underscore prefix): not a route.
import { z } from 'zod';
import { zBool, zOptDate, zOptMoney, zOptText, zText } from '@/lib/validation';
import { zOptRef, zOptUrl } from '@/app/api/services/_lib';

/** Text column that is NOT NULL in the DB but may be blank: null -> ''. */
const zBlankText = (max = 200) => z.preprocess((v) => (v === null ? '' : v), z.string().trim().max(max)).optional();

// ---------------------------------------------------------------------------
// Plate number normalisation (duplicate detection) and model year
// ---------------------------------------------------------------------------

/** Arabic-Indic (U+0660..) and Extended Arabic-Indic / Persian (U+06F0..) digits -> ASCII digits. */
export function normalizeDigits(value: string): string {
  return value.replace(/[٠-٩۰-۹]/g, (d) => String((d.charCodeAt(0) & 0xf) % 10));
}

/**
 * Latin letters printed on Saudi plates -> the Arabic letter printed next to them
 * (the 17 letters used on KSA plates). Other Latin letters are kept as they are.
 */
const SAUDI_PLATE_LATIN_TO_ARABIC: Readonly<Record<string, string>> = {
  A: 'ا',
  B: 'ب',
  J: 'ح',
  D: 'د',
  R: 'ر',
  S: 'س',
  X: 'ص',
  T: 'ط',
  E: 'ع',
  G: 'ق',
  K: 'ك',
  L: 'ل',
  Z: 'م',
  N: 'ن',
  H: 'ه',
  U: 'و',
  V: 'ى',
};

/**
 * Comparison key of a plate number, so the same plate typed differently is detected as a duplicate:
 * - spaces, tatweel and separators (- _ . / | ·) are removed;
 * - أ إ آ ٱ -> ا, ي -> ى, ة -> ه;
 * - Latin plate letters -> their Arabic counterpart (A -> ا, J -> ح, ...), case-insensitive;
 * - Arabic-Indic digits -> ASCII digits;
 * - a plate made of exactly one block of letters and one block of digits is keyed letters-first,
 *   so "1234 ا ب ح" and "ا ب ح 1234" (different typing direction) match.
 * The stored plateNumber is left as the user typed it; only the comparison uses this key.
 */
export function normalizePlate(plate: string | null | undefined): string {
  const compact = normalizeDigits(String(plate ?? ''))
    .toUpperCase()
    .replace(/[\sـ\-_./|·]+/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ي/g, 'ى')
    .replace(/ة/g, 'ه')
    .replace(/[A-Z]/g, (c) => SAUDI_PLATE_LATIN_TO_ARABIC[c] ?? c);
  const m = /^(\d+)(\D+)$/.exec(compact);
  return m ? `${m[2]}${m[1]}` : compact;
}

/** Pure: the first plate (other than `excludeId`) whose normalised key equals `plate`'s, if any. */
export function findPlateDuplicate<T extends { id: string; plateNumber: string }>(
  plate: string,
  existing: readonly T[],
  excludeId?: string,
): T | undefined {
  const key = normalizePlate(plate);
  if (!key) return undefined;
  return existing.find((v) => v.id !== excludeId && normalizePlate(v.plateNumber) === key);
}

export const MODEL_YEAR_MIN = 1950;

/** Latest accepted model year: next calendar year (dealers sell next year's models from mid-year). */
export function modelYearMax(now: Date = new Date()): number {
  return now.getUTCFullYear() + 1;
}

/** Pure: '' (not entered) or four digits between MODEL_YEAR_MIN and modelYearMax(now). */
export function isValidModelYear(value: string, now: Date = new Date()): boolean {
  const v = normalizeDigits(value).trim();
  if (v === '') return true;
  if (!/^\d{4}$/.test(v)) return false;
  const year = Number(v);
  return year >= MODEL_YEAR_MIN && year <= modelYearMax(now);
}

/** Model year: blank allowed; otherwise four digits in a plausible range (Arabic digits accepted). */
const zModelYear = z
  .preprocess((v) => (v === null ? '' : v), z.string().trim().max(20))
  .transform((v) => normalizeDigits(v))
  .superRefine((v, ctx) => {
    if (!isValidModelYear(v)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `سنة الموديل يجب أن تكون 4 أرقام بين ${MODEL_YEAR_MIN} و${modelYearMax()}`,
      });
    }
  })
  .optional();

const vehicleFields = {
  category: zBlankText(100),
  brand: zText(100),
  modelYear: zModelYear,
  color: zBlankText(50),
  sequenceNumber: zBlankText(100),
  plateNumber: zText(50),
  legalCompanyId: zOptRef,
  actualCompanyId: zOptRef,
  licenseExpDate: zOptDate,
  insuranceExpDate: zOptDate,
  insuranceCost: zOptMoney,
  inspectionExpDate: zOptDate,
  operatingCardExpDate: zOptDate,
  operatingCardUrl: zOptUrl,
  driverId: zOptRef,
  driverCardNumber: zOptText(100),
  driverCardExpDate: zOptDate,
  drivingAuthorizationUrl: zOptUrl,
  drivingAuthExpDate: zOptDate,
  vehiclePhotosUrl: zOptUrl,
  registrationFormUrl: zOptUrl,
  otherAttachmentsUrl: zOptUrl,
};

export const vehicleCreateSchema = z.object(vehicleFields);

export const vehicleUpdateSchema = z.object({
  ...vehicleFields,
  brand: zText(100).optional(),
  plateNumber: zText(50).optional(),
  isArchived: zBool.optional(),
});

export const vehicleArchiveSchema = z.object({ isArchived: zBool });

/**
 * Next sequential vehicle code (VH-0001, VH-0002, ...), based on the highest existing code
 * rather than the row count, so deleting a vehicle never produces a duplicate code.
 */
export function nextVehicleCode(existingCodes: Array<string | null>, totalCount: number): string {
  let max = 0;
  for (const code of existingCodes) {
    const m = /^VH-(\d+)$/.exec(code ?? '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  const next = Math.max(max, totalCount) + 1;
  return `VH-${String(next).padStart(4, '0')}`;
}
