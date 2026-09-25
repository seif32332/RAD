// Accident-claim validation schemas. Private module (underscore prefix): not a route.
import { ClaimStatus } from '@prisma/client';
import { z } from 'zod';
import { zId, zMoney, zNumber, zOptText } from '@/lib/validation';
import { zOptRef, zOptUrl } from '@/app/api/services/_lib';

/** Optional nullable number: '' / null -> null (cleared), missing -> undefined (unchanged). */
const zNullableNumber = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => (v === '' || v === null ? null : v), inner.nullable()).optional();

const zPercent = zNumber.pipe(z.number().min(0, 'النسبة لا تقل عن 0').max(100, 'النسبة لا تزيد عن 100'));

export const claimStatusSchema = z.nativeEnum(ClaimStatus);

const claimFields = {
  faultPercentageAgainst: zNullableNumber(zPercent),
  faultPercentageFor: zNullableNumber(zPercent),
  claimAmount: zNullableNumber(zMoney),
  insuranceCompany: zOptText(200),
  status: claimStatusSchema.optional(),
  najmReportUrl: zOptUrl,
  estimatesUrl: zOptUrl,
  accidentPhotosUrl: zOptUrl,
  ibanUrl: zOptUrl,
  otherAttachmentsUrl: zOptUrl,
};

/**
 * Pure: the two fault shares (ours / the other party's) of one accident cannot exceed 100% together.
 * A missing / cleared share counts as not entered (no constraint from it).
 */
export function faultSharesValid(against: number | null | undefined, forUs: number | null | undefined): boolean {
  if (typeof against !== 'number' || typeof forUs !== 'number') return true;
  // Tolerate float noise (e.g. 33.3 + 66.7).
  return against + forUs <= 100 + 1e-9;
}

const FAULT_SUM_MESSAGE = 'مجموع نسبتي الخطأ (علينا ولنا) يجب ألا يتجاوز 100%';

/** Rejects a body whose two fault percentages add up to more than 100 (checked when both are sent). */
function refineFaultShares(
  v: { faultPercentageAgainst?: number | null; faultPercentageFor?: number | null },
  ctx: z.RefinementCtx,
): void {
  if (!faultSharesValid(v.faultPercentageAgainst, v.faultPercentageFor)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['faultPercentageFor'], message: FAULT_SUM_MESSAGE });
  }
}

export const claimCreateSchema = z.object({ vehicleId: zId, ...claimFields }).superRefine(refineFaultShares);

export const claimUpdateSchema = z
  .object({
    // '' / null are ignored: a claim must always belong to a vehicle.
    vehicleId: zOptRef.transform((v) => v ?? undefined),
    ...claimFields,
  })
  .superRefine(refineFaultShares);

/** Vehicle projection used by the claims pages. */
export const claimVehicleInclude = {
  vehicle: {
    include: {
      legalCompany: { select: { nameArabic: true } },
      actualCompany: { select: { nameArabic: true } },
      driver: {
        select: { firstNameArabic: true, lastNameArabic: true, employeeId: true, branch: { select: { nameArabic: true } } },
      },
    },
  },
} as const;
