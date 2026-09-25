import { ROLE_GROUPS, type AppRole } from '@/lib/constants';

/**
 * Who can see / file payment requests: finance, plus government relations (the payments
 * screen is also listed under "operations management" for renewals / SADAD bills).
 * Paying or returning a request stays FINANCE only.
 */
export const PAYMENTS_ACCESS: readonly AppRole[] = [...new Set<AppRole>([...ROLE_GROUPS.FINANCE, ...ROLE_GROUPS.GOV])];

/** PaymentStatus values (Prisma enum PaymentStatus). */
export const PAYMENT_STATUS = {
  PENDING_OWNER: 'PENDING_OWNER',
  PENDING_FINANCE: 'PENDING_FINANCE',
  PAID: 'PAID',
  COMPLETED: 'COMPLETED',
  RETURNED: 'RETURNED',
} as const;

/** Requests that have not been paid yet (can still be edited / returned / deleted). */
export const PAYMENT_OPEN_STATUSES = [PAYMENT_STATUS.PENDING_OWNER, PAYMENT_STATUS.PENDING_FINANCE] as const;

/**
 * Payment requests generated for another record (visa fee, settlement payout, loan transfer).
 * Their lifecycle belongs to that record: they are paid or returned ("رد السداد"), never deleted,
 * otherwise the linked visa / settlement / loan would be left waiting for a payment that vanished.
 */
export const LINKED_PAYMENT_ENTITY_TYPES = ['VISA', 'SETTLEMENT', 'LOAN'] as const;

export function isLinkedPaymentRequest(entityType: string | null | undefined): boolean {
  return !!entityType && (LINKED_PAYMENT_ENTITY_TYPES as readonly string[]).includes(entityType);
}

/**
 * Why a payment request cannot be deleted, or null when deleting it is allowed.
 * Pure: used by the DELETE handler (409 message) and by the payments page (hide the button).
 */
export function paymentDeleteBlockReason(p: { status: string; entityType?: string | null }): string | null {
  if (p.status === PAYMENT_STATUS.PAID || p.status === PAYMENT_STATUS.COMPLETED) {
    return 'لا يمكن حذف طلب سداد تم صرفه';
  }
  if (isLinkedPaymentRequest(p.entityType)) {
    const what =
      p.entityType === 'VISA' ? 'رسوم تأشيرة' : p.entityType === 'SETTLEMENT' ? 'صرف تصفية مستحقات' : 'تحويل سلفة';
    return p.status === PAYMENT_STATUS.RETURNED
      ? `لا يمكن حذف طلب سداد مرتبط (${what})؛ يبقى محفوظاً كسجل بعد رده`
      : `لا يمكن حذف طلب سداد مرتبط (${what})؛ استخدم "رد السداد" بدلاً من ذلك`;
  }
  if (p.status !== PAYMENT_STATUS.PENDING_OWNER && p.status !== PAYMENT_STATUS.PENDING_FINANCE && p.status !== PAYMENT_STATUS.RETURNED) {
    return 'لا يمكن حذف طلب السداد في حالته الحالية';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Maker-checker (DEC-001 / DEC-002 / DEC-008, risk R-005).
// ---------------------------------------------------------------------------

/** SystemSetting key: 'true' lets the requester approve / pay their own request (single-admin companies). */
export const ALLOW_SELF_APPROVAL_SETTING = 'allow_self_approval';

/** AuditLog.action written when a requester approves / pays their own payment request. */
export const SELF_APPROVAL_AUDIT_ACTION = 'SELF_APPROVAL_OVERRIDE';

export type MakerCheckerStep = 'APPROVE' | 'PAY';

export interface MakerCheckerInput {
  step: MakerCheckerStep;
  actorId: string;
  actorRole: string;
  /** PaymentRequest.requestedById; null for legacy / system-generated requests. */
  requestedById: string | null | undefined;
  /** Value of the allow_self_approval SystemSetting (false when unset). */
  allowSelfApproval: boolean;
}

export type MakerCheckerDecision =
  | { ok: true; basis: 'DIFFERENT_USER' }
  /** Legacy row without a requester: allowed, recorded in the audit details. */
  | { ok: true; basis: 'UNKNOWN_REQUESTER' }
  /** Same user, allowed by SUPER_ADMIN override or by the company setting: always audited separately. */
  | { ok: true; basis: 'SUPER_ADMIN_OVERRIDE' | 'SETTING_ALLOW_SELF_APPROVAL' }
  | { ok: false; message: string };

/**
 * Pure maker-checker rule: the user who created a payment request may not approve it (owner portal)
 * nor record it as paid (payments screen), unless they are SUPER_ADMIN (allowed, audited) or the
 * company opted in with SystemSetting allow_self_approval='true' (allowed, audited).
 */
export function decideMakerChecker(input: MakerCheckerInput): MakerCheckerDecision {
  if (!input.requestedById) return { ok: true, basis: 'UNKNOWN_REQUESTER' };
  if (input.requestedById !== input.actorId) return { ok: true, basis: 'DIFFERENT_USER' };
  if (input.actorRole === 'SUPER_ADMIN') return { ok: true, basis: 'SUPER_ADMIN_OVERRIDE' };
  if (input.allowSelfApproval) return { ok: true, basis: 'SETTING_ALLOW_SELF_APPROVAL' };
  return {
    ok: false,
    message:
      input.step === 'APPROVE'
        ? 'لا يمكنك اعتماد طلب صرف أنشأته بنفسك؛ يجب أن يعتمده مستخدم آخر (فصل الصلاحيات)'
        : 'لا يمكنك تسجيل سداد طلب صرف أنشأته بنفسك؛ يجب أن يسجله مستخدم آخر (فصل الصلاحيات)',
  };
}

/** Parses a SystemSetting value ('true', '"true"', 'TRUE') as a boolean flag; anything else is false. */
export function parseBooleanSetting(value: string | null | undefined): boolean {
  if (!value) return false;
  return value.trim().replace(/^"(.*)"$/, '$1').trim().toLowerCase() === 'true';
}
