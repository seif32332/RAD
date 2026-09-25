// Pure rules about MuqeemTransaction rows, shared by the server (transactions.ts, API routes) and the
// client (integrations screen). NO server imports here.

/** A PENDING row younger than this is most likely the same request still in flight (double click). */
export const IN_FLIGHT_MS = 60_000;

export const IN_FLIGHT_MESSAGE = 'الطلب نفسه قيد التنفيذ الآن على منصة مقيم؛ انتظر لحظات ثم حدّث الصفحة ولا تُعِد الإرسال';

/** True for a PENDING row created less than IN_FLIGHT_MS ago (a request currently being executed). */
export function isInFlightPending(row: { status: string; createdAt: Date | string }, now: number = Date.now()): boolean {
  if (row.status !== 'PENDING') return false;
  const created = new Date(row.createdAt).getTime();
  return Number.isFinite(created) && now - created < IN_FLIGHT_MS;
}

/**
 * Feature screen that settles (reconciles) an operation AND applies its result to the business
 * record (visa, iqama / passport, final exit). Such operations must not be settled from the generic
 * transactions screen: that would mark them SUCCEEDED while the record keeps the old state, and a
 * new request from the feature screen would then run a second (paid) operation.
 * Null when the generic screen may settle the operation (nothing to apply).
 */
export function featureSettlePath(operation: string, employeeId: string | null | undefined): { path: string; label: string } | null {
  if (operation.startsWith('EXIT_REENTRY_')) return { path: '/visas', label: 'التأشيرات' };
  if (operation.startsWith('FINAL_EXIT_')) return { path: '/settlements', label: 'تصفية المستحقات' };
  if (operation === 'IQAMA_RENEW' || operation === 'PASSPORT_RENEW' || operation === 'PASSPORT_EXTEND') {
    return employeeId ? { path: `/employees/${employeeId}`, label: 'ملف الموظف' } : { path: '/renewals', label: 'التجديدات' };
  }
  return null;
}

/** Last 4 characters of a document number (the only part stored in transaction summaries). */
export function last4(value: string | null | undefined): string | null {
  const v = (value ?? '').trim().toUpperCase();
  return v ? v.slice(-4) : null;
}
