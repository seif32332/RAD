// Pure, client-safe helpers for exit/re-entry visas issued through Muqeem (مقيم).
// Used by the API (src/app/api/visas/**) and by the visas page. NO server imports here.
//
// Date convention (src/lib/dates.ts): date-only values are 'YYYY-MM-DD' / UTC midnight; "today" is
// the Riyadh calendar day (todayKey()). Muqeem takes returnBefore as an Umm al-Qura Hijri
// 'yyyy-MM-dd' and returns Gregorian dates in several spellings (parseMuqeemGregorian).
import { hijriToGregorian, parseMuqeemGregorian, toHijriDateString } from '@/lib/muqeem/hijri';
import { isSaudiNationalityValue } from '@/lib/employee-shared';

export const EXIT_REENTRY_VISA_TYPE = 'خروج وعودة';

/** Muqeem's minimum exit/re-entry duration (and minimum extension), in days. */
export const MIN_VISA_DAYS = 7;
/** Sanity bound on what the form accepts (typos); Muqeem enforces its own limits. */
export const MAX_VISA_DAYS = 3650;
/** Days added after the leave / ticket return date when suggesting "return before". */
export const RETURN_MARGIN_DAYS = 14;
/** A PENDING Muqeem transaction older than this can be reconciled (mirrors STALE_PENDING_MS). */
export const STALE_PENDING_MS = 10 * 60_000;

export const VISA_MUQEEM_TYPES = { SINGLE: 1, MULTIPLE: 2 } as const;
export type VisaMuqeemType = 1 | 2;
export const VISA_MUQEEM_TYPE_LABEL: Record<VisaMuqeemType, string> = { 1: 'مفردة', 2: 'متعددة' };

/** Operations this screen performs on Muqeem (subset of MUQEEM_OPERATIONS). */
export const VISA_MUQEEM_OPERATIONS = ['EXIT_REENTRY_ISSUE', 'EXIT_REENTRY_EXTEND', 'EXIT_REENTRY_CANCEL', 'EXIT_REENTRY_REPRINT'] as const;
export type VisaMuqeemOperation = (typeof VISA_MUQEEM_OPERATIONS)[number];

export const VISA_MUQEEM_OPERATION_LABEL: Record<VisaMuqeemOperation, string> = {
  EXIT_REENTRY_ISSUE: 'إصدار التأشيرة',
  EXIT_REENTRY_EXTEND: 'تمديد التأشيرة',
  EXIT_REENTRY_CANCEL: 'إلغاء التأشيرة',
  EXIT_REENTRY_REPRINT: 'إعادة طباعة التأشيرة',
};

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function keyToMs(key: string): number | null {
  if (!DATE_KEY_RE.test(key)) return null;
  const ms = Date.parse(`${key}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== key) return null;
  return ms;
}

function msToKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' of a stored date-only value (UTC calendar day), or null. */
export function toDateKey(d: Date | string | null | undefined): string | null {
  if (d === null || d === undefined || d === '') return null;
  if (typeof d === 'string' && DATE_KEY_RE.test(d)) return keyToMs(d) === null ? null : d;
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

/** Hijri (Umm al-Qura) 'yyyy-MM-dd' of a date, or null when invalid. */
export function safeHijri(d: Date | string | null | undefined): string | null {
  const key = toDateKey(d);
  if (!key) return null;
  try {
    return toHijriDateString(key);
  } catch {
    return null;
  }
}

/**
 * Why this employee cannot get an exit/re-entry visa through Muqeem, or null when eligible.
 * Saudis are citizens (no iqama, no exit/re-entry visa); Muqeem needs a resident iqama 2xxxxxxxxx.
 */
export function residentIneligibility(e: { nationality?: string | null; iqamaOrIdNumber?: string | null }): string | null {
  const id = (e.iqamaOrIdNumber ?? '').trim();
  if (isSaudiNationalityValue(e.nationality) || /^1\d{9}$/.test(id)) {
    return 'الموظف سعودي الجنسية وليس مقيماً: تأشيرات الخروج والعودة عبر مقيم تخص المقيمين فقط.';
  }
  if (!/^2\d{9}$/.test(id)) {
    return 'رقم إقامة الموظف غير صالح لمنصة مقيم (يجب أن يتكون من 10 أرقام ويبدأ بالرقم 2). صحّح بيانات الموظف أولاً.';
  }
  return null;
}

/** Leave id embedded by the leave workflow in Visa.deductedFrom ("... (#<uuid>)"), or null. */
export function leaveIdFromDeductedFrom(deductedFrom: string | null | undefined): string | null {
  const m = (deductedFrom ?? '').match(/\(#([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/i);
  return m ? m[1].toLowerCase() : null;
}

export interface ReturnSuggestion {
  /** Suggested "return before" (Gregorian 'YYYY-MM-DD'). */
  date: string;
  /** Where it comes from, for the UI hint. */
  source: 'leave' | 'ticket';
  /** The leave end / ticket return date the margin was added to. */
  baseDate: string;
  marginDays: number;
}

/**
 * Suggested "return before" date: the later of the linked leave's end date and the booked return
 * flight, plus a safety margin. Null when neither is known or the result would be under the
 * 7-day minimum from today (the user then enters a duration / date).
 */
export function suggestReturnBefore(input: {
  leaveEnd?: Date | string | null;
  ticketReturn?: Date | string | null;
  today: string;
  marginDays?: number;
}): ReturnSuggestion | null {
  const margin = input.marginDays ?? RETURN_MARGIN_DAYS;
  const todayMs = keyToMs(input.today);
  if (todayMs === null) return null;
  const leave = toDateKey(input.leaveEnd);
  const ticket = toDateKey(input.ticketReturn);
  let base: string | null = null;
  let source: ReturnSuggestion['source'] = 'leave';
  if (leave && (!ticket || leave >= ticket)) {
    base = leave;
    source = 'leave';
  } else if (ticket) {
    base = ticket;
    source = 'ticket';
  }
  if (!base) return null;
  const date = msToKey((keyToMs(base) as number) + margin * DAY_MS);
  if (daysFrom(input.today, date) < MIN_VISA_DAYS) return null;
  return { date, source, baseDate: base, marginDays: margin };
}

/** Whole days from `from` to `to` ('YYYY-MM-DD'); NaN when either is invalid. */
export function daysFrom(from: string, to: string): number {
  const a = keyToMs(from);
  const b = keyToMs(to);
  if (a === null || b === null) return NaN;
  return Math.round((b - a) / DAY_MS);
}

export type PlanResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type DurationInput = { mode: 'days'; days: number } | { mode: 'date'; returnBefore: string };

export interface IssuePlan {
  /** Sent to Muqeem as visaDuration (mode 'days'). */
  visaDuration?: number;
  /** Sent to Muqeem as returnBefore, Hijri 'yyyy-MM-dd' (mode 'date'). */
  returnBeforeHijri?: string;
  /** Expected Gregorian "return before" ('YYYY-MM-DD'); Muqeem's answer is authoritative. */
  expectedReturnBefore: string;
  /** Expected duration in days from today. */
  days: number;
}

/** Validates the issue form (duration in days OR a return-before date) relative to `today`. */
export function planIssue(input: DurationInput, today: string): PlanResult<IssuePlan> {
  if (keyToMs(today) === null) return { ok: false, error: 'تاريخ اليوم غير صالح' };
  if (input.mode === 'days') {
    const days = input.days;
    if (!Number.isInteger(days) || days < MIN_VISA_DAYS) return { ok: false, error: `مدة التأشيرة يجب أن تكون ${MIN_VISA_DAYS} أيام على الأقل` };
    if (days > MAX_VISA_DAYS) return { ok: false, error: 'مدة التأشيرة كبيرة جداً، تحقق من القيمة' };
    const expectedReturnBefore = msToKey((keyToMs(today) as number) + days * DAY_MS);
    return { ok: true, value: { visaDuration: days, expectedReturnBefore, days } };
  }
  const date = toDateKey(input.returnBefore);
  if (!date) return { ok: false, error: 'تاريخ "العودة قبل" غير صالح' };
  const days = daysFrom(today, date);
  if (days < MIN_VISA_DAYS) return { ok: false, error: `تاريخ "العودة قبل" يجب أن يكون بعد ${MIN_VISA_DAYS} أيام على الأقل من اليوم` };
  if (days > MAX_VISA_DAYS) return { ok: false, error: 'تاريخ "العودة قبل" بعيد جداً، تحقق من القيمة' };
  const hijri = safeHijri(date);
  if (!hijri) return { ok: false, error: 'تعذر تحويل التاريخ إلى الهجري' };
  return { ok: true, value: { returnBeforeHijri: hijri, expectedReturnBefore: date, days } };
}

export interface ExtensionPlan {
  /** Extra days (Muqeem's visaDuration for an extension, >= 7). */
  extraDays: number;
  /** New Gregorian "return before" ('YYYY-MM-DD'). */
  newReturnBefore: string;
  /** New "return before" in Hijri (Muqeem's returnBefore). */
  newReturnBeforeHijri: string;
}

/**
 * Validates an extension. Muqeem requires both the extra days and the new Hijri return-before date,
 * so the one the user did not enter is derived from the current return-before date.
 */
export function planExtension(currentReturnBefore: Date | string | null | undefined, input: DurationInput): PlanResult<ExtensionPlan> {
  const current = toDateKey(currentReturnBefore);
  if (!current) return { ok: false, error: 'تاريخ "العودة قبل" الحالي للتأشيرة غير معروف؛ أعد طباعة التأشيرة أو راجع مقيم' };
  let extraDays: number;
  let newReturnBefore: string;
  if (input.mode === 'days') {
    extraDays = input.days;
    if (!Number.isInteger(extraDays) || extraDays < MIN_VISA_DAYS) return { ok: false, error: `مدة التمديد يجب أن تكون ${MIN_VISA_DAYS} أيام على الأقل` };
    if (extraDays > MAX_VISA_DAYS) return { ok: false, error: 'مدة التمديد كبيرة جداً، تحقق من القيمة' };
    newReturnBefore = msToKey((keyToMs(current) as number) + extraDays * DAY_MS);
  } else {
    const date = toDateKey(input.returnBefore);
    if (!date) return { ok: false, error: 'تاريخ "العودة قبل" الجديد غير صالح' };
    extraDays = daysFrom(current, date);
    if (extraDays <= 0) return { ok: false, error: 'تاريخ "العودة قبل" الجديد يجب أن يكون بعد التاريخ الحالي' };
    if (extraDays < MIN_VISA_DAYS) return { ok: false, error: `التمديد يجب أن يكون ${MIN_VISA_DAYS} أيام على الأقل بعد تاريخ العودة الحالي` };
    if (extraDays > MAX_VISA_DAYS) return { ok: false, error: 'تاريخ "العودة قبل" الجديد بعيد جداً، تحقق من القيمة' };
    newReturnBefore = date;
  }
  const hijri = safeHijri(newReturnBefore);
  if (!hijri) return { ok: false, error: 'تعذر تحويل التاريخ إلى الهجري' };
  return { ok: true, value: { extraDays, newReturnBefore, newReturnBeforeHijri: hijri } };
}

/**
 * Idempotency key parts (after the operation name) for muqeemIdempotencyKey(op, ...parts):
 *  - ISSUE: one per visa record, whatever the chosen duration, so a double click / retry can never
 *    issue a second visa;
 *  - EXTEND: visa + visa number + the CURRENT (base) return-before date, never the requested new
 *    date: two extensions sent at the same moment on the same base (+10 and +20 days) collide on the
 *    unique key and only one reaches Muqeem; once the visa is extended its return-before changes,
 *    so a later extension is a new key;
 *  - CANCEL: one per official visa number;
 *  - REPRINT: per official visa number and current return-before (a reprint after an extension
 *    fetches the updated document; repeating it returns the stored copy).
 */
export function visaMuqeemKeyParts(
  op: VisaMuqeemOperation,
  visa: { id: string; externalVisaNumber?: string | null; returnBefore?: Date | string | null },
  /** EXTEND only: the base return-before the request was computed from (defaults to visa.returnBefore). */
  baseReturnBefore?: Date | string | null,
): string[] {
  const id = visa.id.trim();
  const number = (visa.externalVisaNumber ?? '').trim();
  switch (op) {
    case 'EXIT_REENTRY_ISSUE':
      return ['visa', id];
    case 'EXIT_REENTRY_EXTEND':
      return ['visa', id, number, toDateKey(baseReturnBefore === undefined ? visa.returnBefore : baseReturnBefore) ?? 'none'];
    case 'EXIT_REENTRY_CANCEL':
      return ['visa', id, number];
    case 'EXIT_REENTRY_REPRINT':
      return ['visa', id, number, toDateKey(visa.returnBefore) ?? 'none'];
  }
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  return null;
}

function str(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Gregorian date from Muqeem's Gregorian field, else from its Hijri field. */
function muqeemDate(gregorian: unknown, hijri: unknown): Date | null {
  return parseMuqeemGregorian(gregorian) ?? (typeof hijri === 'string' ? hijriToGregorian(hijri) : null);
}

export interface IssuedVisaFields {
  externalVisaNumber: string | null;
  visaDurationDays: number | null;
  returnBefore: Date | null;
}

/** Visa fields from an ERVisaIssuanceResponseVM (fresh result or the stored response summary). */
export function issuedVisaFields(response: unknown): IssuedVisaFields {
  const r = obj(response);
  return {
    externalVisaNumber: str(r.visaNumber),
    visaDurationDays: num(r.visaDuration),
    returnBefore: muqeemDate(r.visaReturnBeforeGregorianDate, r.visaReturnBeforeHijriDate),
  };
}

export interface ExtendedVisaFields {
  returnBefore: Date | null;
  /** Total duration after the extension, when Muqeem gives the parts. */
  visaDurationDays: number | null;
  serviceCost: number | null;
}

/** Visa fields from an ERVisaExtendResponseVM. */
export function extendedVisaFields(response: unknown): ExtendedVisaFields {
  const r = obj(response);
  const before = num(r.visaDurationBeforeExtension);
  const extra = num(r.requestedExtendedDuration);
  const cost = r.serviceCost;
  return {
    returnBefore: muqeemDate(r.returnBeforeAfterExtensionG, r.returnBeforeAfterExtensionH),
    visaDurationDays: before !== null && extra !== null ? before + extra : null,
    serviceCost: typeof cost === 'number' && Number.isFinite(cost) ? cost : null,
  };
}

/** Parses a stored JSON summary (MuqeemTransaction.request/responseSummary); {} when unusable. */
export function parseSummary(summary: string | null | undefined): Record<string, unknown> {
  if (!summary) return {};
  try {
    return obj(JSON.parse(summary));
  } catch {
    return {};
  }
}

const ERROR_KIND_PREFIX: Record<string, string> = {
  REJECTED: 'رفضت منصة مقيم الطلب',
  AUTH: 'تعذر تسجيل الدخول إلى منصة مقيم',
  UNAVAILABLE: 'منصة مقيم غير متاحة ولم يُنفَّذ الطلب',
  UNKNOWN_OUTCOME: 'انقطع الاتصال بعد إرسال الطلب ولا يُعرف إن نُفِّذ',
  NOT_CONFIGURED: 'الربط مع مقيم غير مفعّل',
  NOT_LINKED: 'الشركة غير مربوطة بمقيم',
  INTERNAL: 'خطأ داخلي',
};

/**
 * Arabic text for MuqeemTransaction.errorMessage ('KIND: message' / 'RECONCILED_FAILED: note'),
 * for display. Null when there is nothing to show.
 */
export function describeTxError(errorMessage: string | null | undefined): string | null {
  const text = (errorMessage ?? '').trim();
  if (!text) return null;
  const m = text.match(/^([A-Z_0-9]+):\s*([\s\S]*)$/);
  const kind = m ? m[1] : text.match(/^[A-Z_0-9]+$/) ? text : null;
  const rest = m ? m[2].trim() : kind ? '' : text;
  if (kind === 'RECONCILED_FAILED') return rest ? `سُوّيت كعملية لم تُنفَّذ: ${rest}` : 'سُوّيت كعملية لم تُنفَّذ في مقيم';
  if (kind && kind.startsWith('HTTP_')) return rest || 'تعذر تنفيذ الطلب';
  if (kind && ERROR_KIND_PREFIX[kind]) {
    const prefix = ERROR_KIND_PREFIX[kind];
    if (!rest || rest === prefix || rest.startsWith(prefix)) return rest || prefix;
    // Without an upstream message the core stores its own full Arabic sentence (it names مقيم).
    if (kind !== 'REJECTED' && rest.includes('مقيم')) return rest;
    return `${prefix}: ${rest}`;
  }
  return text;
}

/**
 * A Muqeem operation that SUCCEEDED (typically settled by reconciliation, possibly from the
 * integrations screen, which does not touch the visa) but is not reflected on the Visa record yet.
 * Returns the operation to apply (no Muqeem call needed), or null when the record is up to date.
 */
export function pendingVisaSync(
  visa: { status: string; externalVisaNumber?: string | null; returnBefore?: Date | string | null },
  txs: { operation: string; status: string; requestSummary?: string | null }[],
): VisaMuqeemOperation | null {
  const done = txs.filter((t) => t.status === 'SUCCEEDED');
  if (visa.status === 'CANCELLED') return null;
  if (!visa.externalVisaNumber && done.some((t) => t.operation === 'EXIT_REENTRY_ISSUE')) return 'EXIT_REENTRY_ISSUE';
  if (!visa.externalVisaNumber) return null;
  if (done.some((t) => t.operation === 'EXIT_REENTRY_CANCEL')) return 'EXIT_REENTRY_CANCEL';
  const current = toDateKey(visa.returnBefore);
  const extension = done.find((t) => {
    if (t.operation !== 'EXIT_REENTRY_EXTEND') return false;
    const s = parseSummary(t.requestSummary);
    return typeof s.previousReturnBefore === 'string' && s.previousReturnBefore === current && s.newReturnBefore !== current;
  });
  return extension ? 'EXIT_REENTRY_EXTEND' : null;
}

export type TxTone ='success' | 'pending' | 'unknown' | 'failed';

export interface TxStatusView {
  label: string;
  tone: TxTone;
  /** UNKNOWN, or PENDING for longer than STALE_PENDING_MS: must be reconciled before any retry. */
  needsReconcile: boolean;
  /** PENDING or UNKNOWN: blocks a new identical request. */
  blocking: boolean;
}

/** Badge text / tone for a MuqeemTransaction status. */
export function txStatusView(tx: { status: string; createdAt: Date | string }, now: number = Date.now()): TxStatusView {
  const created = new Date(tx.createdAt).getTime();
  switch (tx.status) {
    case 'SUCCEEDED':
      return { label: 'نُفِّذت في مقيم', tone: 'success', needsReconcile: false, blocking: false };
    case 'FAILED':
      return { label: 'لم تُنفَّذ (فشلت)', tone: 'failed', needsReconcile: false, blocking: false };
    case 'UNKNOWN':
      return { label: 'نتيجة غير معروفة - تتطلب تسوية', tone: 'unknown', needsReconcile: true, blocking: true };
    case 'PENDING': {
      const stale = Number.isFinite(created) && now - created > STALE_PENDING_MS;
      return stale
        ? { label: 'معلّقة منذ مدة - تتطلب تسوية', tone: 'unknown', needsReconcile: true, blocking: true }
        : { label: 'قيد التنفيذ في مقيم', tone: 'pending', needsReconcile: false, blocking: true };
    }
    default:
      return { label: tx.status, tone: 'pending', needsReconcile: false, blocking: false };
  }
}
