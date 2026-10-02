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
// Maker-checker (DEC-001 / DEC-002 / DEC-008, risk R-005; pay-to-be BR-PAY-002, BL-PAY-008).
// ---------------------------------------------------------------------------

export type MakerCheckerStep = 'APPROVE' | 'PAY';

export interface MakerCheckerInput {
  step: MakerCheckerStep;
  actorId: string;
  /** Kept for the callers' shape; no role is an exception any more (BL-PAY-008). */
  actorRole?: string;
  /** PaymentRequest.requestedById; null for legacy / system-generated requests. */
  requestedById: string | null | undefined;
  /** PaymentRequest.approvedById (the owner's approval), for the PAY step. */
  approvedById?: string | null;
}

export type MakerCheckerDecision = { ok: true; basis: 'DIFFERENT_USER' } | { ok: false; message: string };

/**
 * Pure maker-checker rule of a payment request, as the screens show it (the server decision is
 * finance's, through money.gateway): the user who created a request may not approve it (owner portal);
 * the user who created or approved it may not record it as paid (payments screen); a request with
 * neither a recorded requester nor approver is not paid before a second person attests it
 * (BR-PAY-015). BL-PAY-008 removed the SUPER_ADMIN, allow_self_approval and UNKNOWN_REQUESTER passes;
 * a single-operator tenant acts through the gateway's recorded SELF_ACT instead (BR-PAY-020).
 */
export function decideMakerChecker(input: MakerCheckerInput): MakerCheckerDecision {
  if (input.step === 'APPROVE') {
    if (input.requestedById && input.requestedById === input.actorId) {
      return { ok: false, message: 'لا يمكنك اعتماد طلب صرف أنشأته بنفسك؛ يجب أن يعتمده مستخدم آخر (فصل الصلاحيات)' };
    }
    return { ok: true, basis: 'DIFFERENT_USER' };
  }
  if (!input.requestedById && !input.approvedById) {
    return { ok: false, message: 'لا يوجد منشئ ولا معتمد مسجَّل لطلب الصرف؛ يلزم إقرار شخص ثانٍ قبل الصرف' };
  }
  if ((input.requestedById && input.requestedById === input.actorId) || (input.approvedById && input.approvedById === input.actorId)) {
    return { ok: false, message: 'لا يمكنك تسجيل سداد طلب صرف أنشأته أو اعتمدته بنفسك؛ يجب أن يسجله مستخدم آخر (فصل الصلاحيات)' };
  }
  return { ok: true, basis: 'DIFFERENT_USER' };
}

/** Parses a SystemSetting value ('true', '"true"', 'TRUE') as a boolean flag; anything else is false. */
export function parseBooleanSetting(value: string | null | undefined): boolean {
  if (!value) return false;
  return value.trim().replace(/^"(.*)"$/, '$1').trim().toLowerCase() === 'true';
}
