// Pure helpers of the employee self-service portal (no React, no DB) so they can be unit-tested.

/** Message shown to signed-in accounts that have no linked employee file (admins, finance...). */
export const UNLINKED_ACCOUNT_MESSAGE = 'حسابك غير مرتبط بملف موظف — تواصل مع الموارد البشرية';

/**
 * True when the session is known to have no employee file, so the portal can show the
 * "not linked" card without calling /api/portal. Unknown (still loading / /me failed) -> false.
 */
export function isUnlinkedAccount(
  me: { employeeId?: string | null } | null | undefined,
  loading: boolean,
): boolean {
  return !loading && !!me && !me.employeeId;
}

/**
 * Only same-origin paths ("/uploads/x.pdf", "/api/files/…") and http(s) URLs may be rendered as
 * links; anything else (javascript:, data:, protocol-relative "//host") -> null.
 */
export function safeHref(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  const u = url.trim();
  if (!u) return null;
  if (u.startsWith('/')) return u.startsWith('//') || u.startsWith('/\\') ? null : u;
  return /^https?:\/\/[^\s/]/i.test(u) ? u : null;
}

export interface LeavePreviewInput {
  leaveType: string;
  startDate: string;
  endDate: string;
  acceptUnpaidExtraDays: boolean;
  isOutsideKSA: boolean;
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Query string for GET /api/leaves/preview (the employee is taken from the session, so no
 * employeeId is sent). null while the dates are incomplete or the range is inverted.
 */
export function leavePreviewQuery(input: LeavePreviewInput): string | null {
  const { startDate, endDate } = input;
  if (!DATE_KEY.test(startDate) || !DATE_KEY.test(endDate) || endDate < startDate) return null;
  const q = new URLSearchParams({
    leaveType: input.leaveType || 'ANNUAL',
    startDate,
    endDate,
    acceptUnpaidExtraDays: String(input.acceptUnpaidExtraDays),
    isOutsideKSA: String(input.isOutsideKSA),
  });
  return q.toString();
}

/** Subset of the GET /api/leaves/preview response rendered by the portal. */
export interface LeavePreview {
  totalDays: number;
  paidDays: number;
  unpaidDays: number;
  totalDeduction: number;
  issue: string | null;
  issueMessage: string | null;
  needsVisa: boolean;
  exitReentryVisaCost: number;
  balance?: { available?: number | null } | null;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Validates / normalizes the preview JSON; null when it is not a preview object. */
export function parseLeavePreview(data: unknown): LeavePreview | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (typeof d.totalDays !== 'number' || typeof d.paidDays !== 'number') return null;
  const balance = d.balance && typeof d.balance === 'object' ? (d.balance as { available?: unknown }) : null;
  return {
    totalDays: num(d.totalDays),
    paidDays: num(d.paidDays),
    unpaidDays: num(d.unpaidDays),
    totalDeduction: num(d.totalDeduction),
    issue: typeof d.issue === 'string' ? d.issue : null,
    issueMessage: typeof d.issueMessage === 'string' ? d.issueMessage : null,
    needsVisa: d.needsVisa === true,
    exitReentryVisaCost: num(d.exitReentryVisaCost),
    balance: balance ? { available: typeof balance.available === 'number' ? balance.available : null } : null,
  };
}

/** Portal history row (shape of /api/portal `history`). */
export interface CancellableHistoryItem {
  status: string;
  leaveId?: string | null;
  canCancel?: boolean | null;
}

/** The leave id the employee may cancel from this history row (own PENDING leave), else null. */
export function cancellableLeaveId(h: CancellableHistoryItem): string | null {
  return h.canCancel === true && h.status === 'PENDING' && typeof h.leaveId === 'string' && h.leaveId ? h.leaveId : null;
}

/**
 * The single display rule for leave-balance days in the portal (DEC-005 "48 vs 48.4"):
 * whole days as an integer ("48"), one decimal only when the balance is fractional ("48.4").
 * The value is truncated to one decimal, never rounded up, so the portal never shows more days
 * than the server-side balance grants. Unknown / non-finite values render as "—".
 */
export function formatLeaveDays(days: number | null | undefined): string {
  if (typeof days !== 'number' || !Number.isFinite(days)) return '—';
  // +1e-9 absorbs binary noise (2.3 * 10 = 22.999999999999996).
  const tenths = Math.floor(days * 10 + 1e-9);
  const value = tenths / 10;
  const text = tenths % 10 === 0 ? String(value) : value.toFixed(1);
  return text === '-0' ? '0' : text;
}

/**
 * Message an account without an employee file can send to HR to get linked. Plain text so it can
 * be copied into any channel (email, WhatsApp, ticket).
 */
export function hrLinkRequestMessage(account: { name?: string | null; email?: string | null }): string {
  const lines = [
    'السلام عليكم،',
    'أرجو ربط حسابي في نظام رديف بملفي الوظيفي حتى أتمكن من استخدام بوابة الموظف.',
  ];
  if (account.name?.trim()) lines.push(`الاسم: ${account.name.trim()}`);
  if (account.email?.trim()) lines.push(`حساب الدخول: ${account.email.trim()}`);
  lines.push('الرقم الوظيفي: ', 'وشكراً.');
  return lines.join('\n');
}
