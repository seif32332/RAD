// Asset / custody (العهد) status values, validation schemas and pure helpers.
// Private module (underscore prefix): not a route.
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { zOptDate, zOptText, zText } from '@/lib/validation';
import { zOptRef } from '@/app/api/services/_lib';

/** Asset.status values written by the API (the column is a plain String). */
export const ASSET_STATUS = {
  /** In an employee's custody. */
  ACTIVE: 'ACTIVE',
  /** In the warehouse, available to assign. */
  VACANT: 'VACANT',
  /** Legacy "returned to warehouse" value; treated like VACANT. */
  RETURNED: 'RETURNED',
  DAMAGED: 'DAMAGED',
  /** History row kept for the previous holder after a transfer. */
  TRANSFERRED: 'TRANSFERRED',
} as const;

export const ASSET_ACTIONS = ['edit', 'clear', 'assign', 'transfer', 'damage'] as const;
export type AssetAction = (typeof ASSET_ACTIONS)[number];

export const assetItemSchema = z.object({
  employeeId: zOptRef,
  assetType: zText(200),
  description: zOptText(2000),
  receiveDate: zOptDate,
  returnDate: zOptDate,
});

/** Accepts either a single asset or { assets: [...] } (max 100 per request). */
export const assetCreateSchema = z.preprocess(
  (v) => {
    if (v && typeof v === 'object' && 'assets' in v && Array.isArray((v as { assets: unknown }).assets)) {
      return (v as { assets: unknown[] }).assets;
    }
    return [v];
  },
  z.array(assetItemSchema).min(1, 'يجب إدخال أصل واحد على الأقل').max(100, 'الحد الأقصى 100 أصل في الطلب الواحد'),
);

/** Minimum length of the reason required to mark an asset (or a SIM) as damaged / lost. */
export const DAMAGE_REASON_MIN = 5;

/** Pure: whether a damage / loss reason is acceptable (at least DAMAGE_REASON_MIN visible characters). */
export function isValidDamageReason(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && reason.trim().length >= DAMAGE_REASON_MIN;
}

/** Message after "damage" on a telecom SIM: the line itself is still active at the operator. */
export const SIM_DAMAGE_MESSAGE = 'تم فصل الشريحة عن الموظف؛ راجع إلغاء الخط لدى المشغل';

export const assetActionSchema = z
  .object({
    action: z.enum(ASSET_ACTIONS, { errorMap: () => ({ message: 'إجراء غير معروف' }) }),
    employeeId: zOptRef,
    assetType: zOptText(200),
    description: zOptText(2000),
    /** Required for 'damage' (min DAMAGE_REASON_MIN characters); recorded in the audit log. */
    reason: zOptText(1000),
  })
  .superRefine((v, ctx) => {
    if ((v.action === 'assign' || v.action === 'transfer') && !v.employeeId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['employeeId'], message: 'يجب تحديد الموظف' });
    }
    if (v.action === 'edit' && !v.assetType) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['assetType'], message: 'نوع العهدة مطلوب' });
    }
    if (v.action === 'damage' && !isValidDamageReason(v.reason)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reason'],
        message: `اكتب سبب الإتلاف أو الفقد (${DAMAGE_REASON_MIN} أحرف على الأقل)`,
      });
    }
  });

export const assetListQuerySchema = z.object({
  employeeId: z.string().trim().max(100).optional(),
  active: z.enum(['true', 'false']).optional(),
  /** '1': only items still held by employees whose service has ended (assets + SIMs). */
  heldByTerminated: z.enum(['1', 'true', '0', 'false']).optional(),
});

/**
 * The `where` guard each action requires on the current row, so the state transition is applied
 * atomically (updateMany + count check) and a double submit can't apply it twice.
 * Mirrors what the assets page offers for each state.
 */
export function assetActionGuard(action: AssetAction): Prisma.AssetWhereInput {
  switch (action) {
    case 'assign':
      // "Vacant": no holder, or in the warehouse.
      return {
        status: { notIn: [ASSET_STATUS.DAMAGED, ASSET_STATUS.TRANSFERRED] },
        OR: [{ employeeId: null }, { status: { in: [ASSET_STATUS.VACANT, ASSET_STATUS.RETURNED] } }],
      };
    case 'clear':
    case 'transfer':
      // Currently in an employee's custody.
      return { status: ASSET_STATUS.ACTIVE, employeeId: { not: null } };
    case 'damage':
      return { status: { notIn: [ASSET_STATUS.DAMAGED, ASSET_STATUS.TRANSFERRED] } };
    case 'edit':
    default:
      return {};
  }
}

export interface CustodyItem {
  id: string;
  employeeId: string | null;
  assetType: string;
  description: string | null;
  receiveDate: Date | null;
  returnDate: Date | null;
  status: string;
  createdAt: Date;
  isTelecomSim?: boolean;
  /** Holder projection (same shape as the asset list's `employee`), when loaded. */
  employee?: CustodyHolder | null;
}

export interface CustodyHolder {
  id: string;
  employeeId: string;
  firstNameArabic: string;
  lastNameArabic: string;
  isTerminated: boolean;
  branch?: { nameArabic: string } | null;
}

/** Presents a telecom SIM held by an employee as a custody item (shown with regular assets). */
export function simAsCustodyItem(sim: {
  id: string;
  employeeId: string | null;
  simNumber: string;
  plan: string | null;
  provider: string | null;
  createdAt: Date;
  employee?: CustodyHolder | null;
}): CustodyItem {
  return {
    ...(sim.employee !== undefined ? { employee: sim.employee } : {}),
    id: sim.id,
    employeeId: sim.employeeId,
    assetType: `شريحة اتصال (${sim.simNumber})`,
    description: `الباقة: ${sim.plan || '-'} | مزود الخدمة: ${sim.provider || '-'}`,
    receiveDate: sim.createdAt,
    createdAt: sim.createdAt,
    returnDate: null,
    status: ASSET_STATUS.ACTIVE,
    isTelecomSim: true,
  };
}

/** Newest first, by createdAt (falling back to receiveDate). */
export function sortCustodyNewestFirst<T extends { createdAt: Date | null; receiveDate: Date | null }>(items: T[]): T[] {
  const ts = (x: T) => new Date(x.createdAt ?? x.receiveDate ?? 0).getTime();
  return [...items].sort((a, b) => ts(b) - ts(a));
}
