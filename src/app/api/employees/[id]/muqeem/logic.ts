// Pure, client-safe helpers for the employee Muqeem actions (iqama renewal, passport updates,
// reconciliation). Used by the API route (./route.ts), the renewals page and the employee profile.
// NO server imports here (no prisma, no next/server, no '@/lib/muqeem' index).
import { IQAMA_DURATIONS_MONTHS, type IqamaDurationMonths } from '@/lib/muqeem/types';
import { parseMuqeemGregorian } from '@/lib/muqeem/hijri';
import { isSaudiNationalityValue } from '@/lib/employee-shared';

/** POST /api/employees/[id]/muqeem actions. */
export const MUQEEM_EMPLOYEE_ACTIONS = ['RENEW_IQAMA', 'RENEW_PASSPORT', 'EXTEND_PASSPORT', 'RECONCILE'] as const;
export type MuqeemEmployeeAction = (typeof MUQEEM_EMPLOYEE_ACTIONS)[number];

/** Muqeem operations started from this feature (MuqeemTransaction.operation). */
export const EMPLOYEE_MUQEEM_OPERATIONS = ['IQAMA_RENEW', 'PASSPORT_RENEW', 'PASSPORT_EXTEND'] as const;
export type EmployeeMuqeemOperation = (typeof EMPLOYEE_MUQEEM_OPERATIONS)[number];

/** Operations that conflict with each other: an unresolved one blocks every other in its group. */
export const OPERATION_GROUPS: Readonly<Record<EmployeeMuqeemOperation, readonly EmployeeMuqeemOperation[]>> = {
  IQAMA_RENEW: ['IQAMA_RENEW'],
  PASSPORT_RENEW: ['PASSPORT_RENEW', 'PASSPORT_EXTEND'],
  PASSPORT_EXTEND: ['PASSPORT_RENEW', 'PASSPORT_EXTEND'],
};

export const IQAMA_DURATION_OPTIONS = IQAMA_DURATIONS_MONTHS;

export const MUQEEM_OPERATION_LABELS: Readonly<Record<string, string>> = {
  IQAMA_RENEW: 'تجديد الإقامة',
  PASSPORT_RENEW: 'تحديث بيانات الجواز (جواز جديد)',
  PASSPORT_EXTEND: 'تمديد صلاحية الجواز',
  EXIT_REENTRY_ISSUE: 'إصدار تأشيرة خروج وعودة',
  EXIT_REENTRY_EXTEND: 'تمديد تأشيرة خروج وعودة',
  EXIT_REENTRY_CANCEL: 'إلغاء تأشيرة خروج وعودة',
  EXIT_REENTRY_REPRINT: 'إعادة طباعة تأشيرة خروج وعودة',
  FINAL_EXIT_ISSUE: 'إصدار تأشيرة خروج نهائي',
  FINAL_EXIT_CANCEL: 'إلغاء تأشيرة خروج نهائي',
};

export const MUQEEM_TX_STATUS_LABELS: Readonly<Record<string, string>> = {
  PENDING: 'قيد التنفيذ',
  SUCCEEDED: 'نُفذت',
  FAILED: 'لم تُنفذ',
  UNKNOWN: 'نتيجة غير معروفة — تحتاج تسوية',
};

/** PENDING (in flight / abandoned) and UNKNOWN rows block any new call until reconciled. */
export function isUnresolvedStatus(status: string | null | undefined): boolean {
  return status === 'PENDING' || status === 'UNKNOWN';
}

export function isEmployeeMuqeemOperation(v: unknown): v is EmployeeMuqeemOperation {
  return typeof v === 'string' && (EMPLOYEE_MUQEEM_OPERATIONS as readonly string[]).includes(v);
}

export function isIqamaDuration(v: unknown): v is IqamaDurationMonths {
  return typeof v === 'string' && (IQAMA_DURATIONS_MONTHS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/** A Saudi national ID starts with 1; an iqama (resident permit) with 2. */
export const IQAMA_NUMBER_RE = /^2\d{9}$/;
export const PASSPORT_NUMBER_RE = /^[A-Za-z0-9]{1,15}$/;

export type IneligibleReason = 'SAUDI' | 'NO_IQAMA' | 'NO_LEGAL_COMPANY' | 'NOT_LINKED' | 'NOT_CONFIGURED';

export interface EligibilityInput {
  nationality: string | null | undefined;
  iqamaOrIdNumber: string | null | undefined;
  /** The sponsoring legal entity (Employee.legalCompany); null when not set. */
  legalCompany: { nameArabic: string; moiNumber: string | null; muqeemPlatformId: string | null } | null;
  /** muqeemConfig().usable */
  integrationUsable: boolean;
}

export interface Eligibility {
  eligible: boolean;
  reason: IneligibleReason | null;
  message: string | null;
}

/** True when the iqama number looks like a resident permit (10 digits starting with 2). */
export function looksLikeIqama(v: string | null | undefined): boolean {
  return IQAMA_NUMBER_RE.test((v ?? '').trim());
}

/** Whether Muqeem services can be used for this employee, with the Arabic reason when not. */
export function muqeemEligibility(input: EligibilityInput): Eligibility {
  const no = (reason: IneligibleReason, message: string): Eligibility => ({ eligible: false, reason, message });
  if (isSaudiNationalityValue(input.nationality)) {
    return no('SAUDI', 'الموظف سعودي الجنسية: خدمات منصة مقيم مخصصة للمقيمين (غير السعوديين) فقط.');
  }
  if (!looksLikeIqama(input.iqamaOrIdNumber)) {
    return no('NO_IQAMA', 'رقم الإقامة المسجل للموظف غير صالح لخدمات مقيم: يجب أن يتكون من 10 أرقام ويبدأ بالرقم 2. صحّحه من تعديل بيانات الموظف.');
  }
  if (!input.legalCompany) {
    return no('NO_LEGAL_COMPANY', 'لم تُحدد الشركة القانونية (الكفيل) للموظف، فلا يُعرف حساب مقيم الذي تُنفذ به العملية. حدّدها من تعديل بيانات الموظف.');
  }
  if (!input.legalCompany.moiNumber?.trim() || !input.legalCompany.muqeemPlatformId) {
    return no(
      'NOT_LINKED',
      `الشركة القانونية للموظف «${input.legalCompany.nameArabic}» غير مربوطة بمنصة مقيم: أدخل رقم المنشأة في الجوازات (700) واختر حساب مقيم من صفحة تعديل الشركة.`,
    );
  }
  if (!input.integrationUsable) {
    return no('NOT_CONFIGURED', 'الربط مع منصة مقيم غير مفعّل أو غير مكتمل الإعداد على الخادم. تواصل مع مدير النظام.');
  }
  return { eligible: true, reason: null, message: null };
}

// ---------------------------------------------------------------------------
// Dates and validation
// ---------------------------------------------------------------------------

/** True for a real calendar date written 'YYYY-MM-DD'. */
export function isDateKey(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** 'YYYY-MM-DD' + whole months, clamped to the month's last day (estimate shown before renewal). */
export function addMonthsToDateKey(key: string, months: number): string | null {
  if (!isDateKey(key) || !Number.isInteger(months)) return null;
  const [y, m, d] = key.split('-').map(Number);
  const target = m - 1 + months;
  const lastDay = new Date(Date.UTC(y, target + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, target, Math.min(d, lastDay))).toISOString().slice(0, 10);
}

const samePassport = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.trim().toUpperCase() === b.trim().toUpperCase();

export interface PassportRenewInput {
  currentPassportNumber: string | null | undefined;
  newPassportNumber: string;
  newPassportIssueDate: string;
  newPassportExpiryDate: string;
  newPassportIssueLocation: string;
}

/** Arabic validation errors for a new passport (empty = valid). `today` is 'YYYY-MM-DD' (Riyadh). */
export function validatePassportRenew(input: PassportRenewInput, today: string): string[] {
  const errors: string[] = [];
  const current = input.currentPassportNumber?.trim() ?? '';
  if (!current) errors.push('لا يوجد رقم جواز حالي مسجل للموظف، ومقيم يشترطه لتحديث الجواز. أدخله أولاً من تعديل بيانات الموظف.');
  else if (!PASSPORT_NUMBER_RE.test(current)) errors.push('رقم الجواز الحالي المسجل للموظف غير صالح لمقيم (حروف إنجليزية وأرقام حتى 15 خانة).');
  const next = input.newPassportNumber?.trim() ?? '';
  if (!PASSPORT_NUMBER_RE.test(next)) errors.push('رقم الجواز الجديد غير صالح (حروف إنجليزية وأرقام فقط، حتى 15 خانة).');
  else if (samePassport(current, next)) errors.push('رقم الجواز الجديد مطابق للجواز الحالي. لتغيير تاريخ الانتهاء فقط استخدم «تمديد صلاحية الجواز».');
  const issueOk = isDateKey(input.newPassportIssueDate);
  const expiryOk = isDateKey(input.newPassportExpiryDate);
  if (!issueOk) errors.push('تاريخ إصدار الجواز الجديد غير صالح.');
  else if (input.newPassportIssueDate > today) errors.push('تاريخ إصدار الجواز الجديد لا يمكن أن يكون في المستقبل.');
  if (!expiryOk) errors.push('تاريخ انتهاء الجواز الجديد غير صالح.');
  else if (input.newPassportExpiryDate <= today) errors.push('تاريخ انتهاء الجواز الجديد يجب أن يكون بعد اليوم.');
  if (issueOk && expiryOk && input.newPassportExpiryDate <= input.newPassportIssueDate) {
    errors.push('تاريخ انتهاء الجواز يجب أن يكون بعد تاريخ إصداره.');
  }
  const location = input.newPassportIssueLocation?.trim() ?? '';
  if (!location) errors.push('مكان إصدار الجواز الجديد مطلوب.');
  else if (location.length > 100) errors.push('مكان إصدار الجواز طويل جداً (100 حرف كحد أقصى).');
  return errors;
}

export interface PassportExtendInput {
  currentPassportNumber: string | null | undefined;
  /** Current Employee.passportExp as 'YYYY-MM-DD' (null when not recorded). */
  currentPassportExp: string | null | undefined;
  newPassportExpiryDate: string;
}

/** Arabic validation errors for a passport validity extension (empty = valid). */
export function validatePassportExtend(input: PassportExtendInput, today: string): string[] {
  const errors: string[] = [];
  const current = input.currentPassportNumber?.trim() ?? '';
  if (!current) errors.push('لا يوجد رقم جواز مسجل للموظف، ومقيم يشترطه لتمديد الصلاحية. أدخله أولاً من تعديل بيانات الموظف.');
  else if (!PASSPORT_NUMBER_RE.test(current)) errors.push('رقم الجواز المسجل للموظف غير صالح لمقيم (حروف إنجليزية وأرقام حتى 15 خانة).');
  if (!isDateKey(input.newPassportExpiryDate)) {
    errors.push('تاريخ الانتهاء الجديد للجواز غير صالح.');
  } else {
    if (input.newPassportExpiryDate <= today) errors.push('تاريخ الانتهاء الجديد للجواز يجب أن يكون بعد اليوم.');
    if (input.currentPassportExp && isDateKey(input.currentPassportExp) && input.newPassportExpiryDate <= input.currentPassportExp) {
      errors.push('تاريخ الانتهاء الجديد يجب أن يكون بعد تاريخ الانتهاء الحالي للجواز.');
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Renewal payment rule
// ---------------------------------------------------------------------------

/** PaymentRequest statuses meaning the renewal fee has been requested but not paid yet. */
export const UNPAID_RENEWAL_PAYMENT_STATUSES = ['PENDING_OWNER', 'PENDING_FINANCE'] as const;

/**
 * Decision (documented in the route): the manual renewal flow does NOT require a payment request
 * (it is optional), but while one is open (awaiting the owner / finance) the renewals screen
 * blocks renewing. The Muqeem renewal keeps that rule: blocked while a fee request for the same
 * document is unpaid; allowed when none exists or it is PAID / RETURNED.
 */
export function unpaidRenewalBlock(paymentStatuses: readonly string[]): string | null {
  const unpaid = paymentStatuses.some((s) => (UNPAID_RENEWAL_PAYMENT_STATUSES as readonly string[]).includes(s));
  return unpaid
    ? 'يوجد طلب سداد رسوم تجديد لهذه الإقامة لم يُسدَّد بعد (بانتظار اعتماد صاحب العمل أو المالية). لا يمكن التجديد عبر مقيم قبل سداده.'
    : null;
}

// ---------------------------------------------------------------------------
// Stored summaries
// ---------------------------------------------------------------------------

/** JSON.parse of a stored summary; null when absent / not an object. */
export function parseStoredSummary(json: string | null | undefined): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * New iqama expiry ('YYYY-MM-DD') from the stored response of a SUCCEEDED IQAMA_RENEW transaction
 * (newIqamaExpiryDateGre, any spelling Muqeem uses), or the date the operator read on Muqeem when
 * the row was reconciled (reconciliation.details.newIqamaExpiryDate). Null when absent.
 */
export function iqamaExpiryFromResponseSummary(json: string | null | undefined): string | null {
  const s = parseStoredSummary(json);
  const d = s ? parseMuqeemGregorian(s.newIqamaExpiryDateGre) : null;
  if (d) return d.toISOString().slice(0, 10);
  const rec = s?.reconciliation;
  const details = rec && typeof rec === 'object' ? (rec as Record<string, unknown>).details : null;
  const reconciled = details && typeof details === 'object' ? (details as Record<string, unknown>).newIqamaExpiryDate : null;
  return isDateKey(reconciled) ? reconciled : null;
}

/**
 * User-facing text of MuqeemTransaction.errorMessage, which is stored as 'KIND: message'
 * (e.g. 'REJECTED: الإقامة غير مؤهلة للخدمة'). The technical kind prefix is dropped.
 */
export function displayMuqeemError(errorMessage: string | null | undefined): string | null {
  const s = (errorMessage ?? '').trim();
  if (!s) return null;
  const m = s.match(/^([A-Z][A-Z0-9_]*)(?::\s*([\s\S]*))?$/);
  if (!m) return s;
  const [, kind, rest] = m;
  if (kind === 'RECONCILED_FAILED') return rest ? `سُوّيت كغير منفذة: ${rest}` : 'سُوّيت كغير منفذة';
  return rest?.trim() || s;
}

/**
 * What happened to the employee record after an executed Muqeem operation:
 * written = updated by this request; already = it already held the result (concurrent identical
 * request); changed = it changed in between and was left untouched (to be checked manually).
 */
export type ApplyState = 'written' | 'already' | 'changed';

/** Wraps a Latin value (date, number) in a left-to-right isolate so it reads correctly inside Arabic text. */
export function ltr(value: string): string {
  return `\u2066${value}\u2069`;
}

/** Arabic result message of an executed (or replayed: alreadyDone) Muqeem operation. */
export function muqeemResultMessage(op: EmployeeMuqeemOperation, state: ApplyState, alreadyDone: boolean, rawValue: string): string {
  const value = ltr(rawValue);
  if (op === 'IQAMA_RENEW') {
    const done = alreadyDone ? 'سبق تنفيذ هذا التجديد في منصة مقيم (لم يُرسل طلب جديد)' : 'تم تجديد الإقامة في منصة مقيم';
    if (state === 'written') return `${done}، وحُدّث تاريخ انتهاء الإقامة في النظام إلى ${value}.`;
    if (state === 'already') return `${done}، وتاريخ انتهاء الإقامة في النظام محدَّث إلى ${value}.`;
    return `${done} (تاريخ الانتهاء الجديد في مقيم ${value})، لكن تاريخ الإقامة في النظام تغيّر أثناء التنفيذ فلم يُعدَّل. راجعه يدوياً.`;
  }
  if (op === 'PASSPORT_RENEW') {
    const done = alreadyDone ? 'سبق تحديث بيانات هذا الجواز في منصة مقيم (لم يُرسل طلب جديد)' : 'تم تحديث بيانات الجواز في منصة مقيم';
    if (state === 'written') return `${done}، وحُدّث رقم الجواز وتاريخ انتهائه (${value}) في النظام.`;
    if (state === 'already') return `${done}، وبيانات الجواز في النظام محدَّثة.`;
    return `${done}، لكن بيانات الجواز في النظام تغيّرت أثناء التنفيذ فلم تُعدَّل. راجعها يدوياً.`;
  }
  const done = alreadyDone ? 'سبق تمديد صلاحية هذا الجواز في منصة مقيم (لم يُرسل طلب جديد)' : 'تم تمديد صلاحية الجواز في منصة مقيم';
  if (state === 'written') return `${done}، وحُدّث تاريخ انتهائه في النظام إلى ${value}.`;
  if (state === 'already') return `${done}، وتاريخ انتهائه في النظام محدَّث إلى ${value}.`;
  return `${done}، لكن بيانات الجواز في النظام تغيّرت أثناء التنفيذ فلم تُعدَّل. راجعها يدوياً.`;
}

/**
 * What happened to the employee record, after a differentRequestNotice (the result applied is the
 * one of the operation ALREADY executed, never the values of the new request).
 */
export function recordStateSentence(op: EmployeeMuqeemOperation, state: ApplyState | null, rawValue: string | null): string {
  const value = rawValue ? ltr(rawValue) : null;
  if (op === 'IQAMA_RENEW') {
    if (state === 'written' && value) return `حُدّث تاريخ انتهاء الإقامة في النظام إلى ${value} وفق التجديد المنفذ.`;
    if (state === 'already' && value) return `تاريخ انتهاء الإقامة في النظام محدَّث إلى ${value} وفق التجديد المنفذ.`;
    if (state === 'changed') return `تاريخ الإقامة في النظام تغيّر فلم يُعدَّل${value ? ` (التاريخ في مقيم ${value})` : ''}؛ راجعه يدوياً.`;
    return 'لا يتوفر في النظام تاريخ الانتهاء الذي نتج عن ذلك التجديد: سوِّ العملية من بطاقة «مقيم» في ملف الموظف أو أدخل التاريخ الموجود في مقيم من شاشة التجديدات.';
  }
  if (state === 'written') return `حُدّثت بيانات الجواز في النظام وفق العملية المنفذة${value ? ` (تاريخ الانتهاء ${value})` : ''}.`;
  if (state === 'already') return 'بيانات الجواز في النظام محدَّثة وفق العملية المنفذة.';
  if (state === 'changed') return 'بيانات الجواز في النظام تغيّرت فلم تُعدَّل؛ راجعها يدوياً.';
  return 'حدّث بيانات الجواز في ملف الموظف (تعديل بيانات الموظف) وفق ما هو مسجل في مقيم.';
}

/** String field of a stored request summary. */
export function summaryString(summary: Record<string, unknown> | null, key: string): string | null {
  const v = summary?.[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// Idempotency keys are built from the BASE state the operation changes, never from the requested
// new value: two requests on the same base (a 12-month and a 6-month renewal sent at the same
// moment, two different new passport dates...) then collide on MuqeemTransaction.idempotencyKey and
// only one of them reaches Muqeem (one fee). The other gets the stored result (alreadyDone) or 409.

/** 'IQAMA_RENEW' + employee + current iqama expiry (whatever the duration). */
export function iqamaRenewKeyParts(employeeId: string, currentExpiry: string): [string, string] {
  return [employeeId, currentExpiry];
}

/** 'PASSPORT_RENEW' + employee + current passport (upper-cased) + current passport expiry ('none'). */
export function passportRenewKeyParts(employeeId: string, currentPassport: string, currentExpiry: string | null | undefined): [string, string, string] {
  return [employeeId, currentPassport.trim().toUpperCase(), currentExpiry || 'none'];
}

/** 'PASSPORT_EXTEND' + employee + passport (upper-cased) + current passport expiry ('none'), whatever the new date. */
export function passportExtendKeyParts(employeeId: string, passport: string, currentExpiry: string | null | undefined): [string, string, string] {
  return [employeeId, passport.trim().toUpperCase(), currentExpiry || 'none'];
}

/** Last 4 characters (upper-cased) of a document number; null when empty. */
export function docLast4(value: string | null | undefined): string | null {
  const v = (value ?? '').trim().toUpperCase();
  return v ? v.slice(-4) : null;
}

/**
 * Last 4 of a passport number from a stored request summary: the masked field (`<field>Last4`)
 * or, for rows written before masking, the full number (`<field>`).
 */
export function summaryPassportLast4(summary: Record<string, unknown> | null, field: string): string | null {
  return summaryString(summary, `${field}Last4`)?.toUpperCase() ?? docLast4(summaryString(summary, field));
}

/**
 * When a request was answered from a transaction already executed on the same base (alreadyDone)
 * but asked for something else (another duration / date / passport), the Arabic notice that says
 * so. Null when the stored request is the same as this one. Never claims the new values were applied.
 */
export function differentRequestNotice(
  op: EmployeeMuqeemOperation,
  stored: Record<string, unknown> | null,
  requested: {
    iqamaDuration?: string;
    newPassportNumber?: string;
    newPassportExpiryDate?: string;
    newPassportIssueDate?: string;
    newPassportIssueLocation?: string;
  },
): string | null {
  if (op === 'IQAMA_RENEW') {
    const prev = summaryString(stored, 'iqamaDuration');
    if (!requested.iqamaDuration || !prev || prev === requested.iqamaDuration) return null;
    return `سبق تنفيذ تجديد لهذه الإقامة في منصة مقيم على تاريخ الانتهاء نفسه بمدة ${prev} شهراً، ولم تُطبَّق المدة المطلوبة الآن (${requested.iqamaDuration} شهراً) ولم يُرسل طلب جديد.`;
  }
  const prevExp = summaryString(stored, 'newPassportExpiryDate');
  const expDiffers = !!requested.newPassportExpiryDate && !!prevExp && prevExp !== requested.newPassportExpiryDate;
  if (op === 'PASSPORT_RENEW') {
    const prevNew = summaryPassportLast4(stored, 'newPassportNumber');
    const reqNew = docLast4(requested.newPassportNumber);
    const numberDiffers = !!prevNew && !!reqNew && prevNew !== reqNew;
    const differs = (field: 'newPassportIssueDate' | 'newPassportIssueLocation') => {
      const prev = summaryString(stored, field);
      const req = requested[field]?.trim();
      return !!prev && !!req && prev !== req;
    };
    if (!numberDiffers && !expDiffers && !differs('newPassportIssueDate') && !differs('newPassportIssueLocation')) return null;
    return (
      `سبق تحديث بيانات هذا الجواز في منصة مقيم بجواز جديد${prevNew ? ` ينتهي رقمه بـ ${ltr(prevNew)}` : ''}${prevExp ? ` وتاريخ انتهاء ${ltr(prevExp)}` : ''}، ` +
      'ولم تُطبَّق البيانات المطلوبة الآن ولم يُرسل طلب جديد.'
    );
  }
  if (!expDiffers) return null;
  return `سبق تمديد صلاحية هذا الجواز في منصة مقيم إلى ${ltr(prevExp as string)}، ولم يُطبَّق التاريخ المطلوب الآن (${ltr(requested.newPassportExpiryDate as string)}) ولم يُرسل طلب جديد.`;
}

export const passportsEqual = samePassport;

// ---------------------------------------------------------------------------
// GET /api/employees/[id]/muqeem response (shared with the pages)
// ---------------------------------------------------------------------------

export interface MuqeemTxView {
  id: string;
  operation: string;
  operationLabel: string;
  status: string;
  statusLabel: string;
  unresolved: boolean;
  canReconcile: boolean;
  externalRef: string | null;
  errorMessage: string | null;
  /** Outcome recorded manually (reconciliation) rather than from Muqeem's response. */
  reconciled: boolean;
  /** PASSPORT_RENEW: last 4 of the new passport requested (the full number is never stored). */
  newPassportLast4?: string | null;
  documentUrl: string | null;
  requestedBy: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface MuqeemEmployeeStatus {
  employee: {
    id: string;
    name: string;
    isTerminated: boolean;
    iqamaNumber: string;
    iqamaExp: string | null;
    passportNumber: string | null;
    passportExp: string | null;
  };
  company: { id: string; name: string; linked: boolean } | null;
  integration: { enabled: boolean; usable: boolean };
  canReconcile: boolean;
  eligibility: Eligibility;
  iqamaDurations: readonly string[];
  unpaidRenewalPayment: string | null;
  transactions: MuqeemTxView[];
}

/** First unresolved transaction among `operations` (the UI disables new calls while one exists). */
export function firstUnresolved(transactions: readonly MuqeemTxView[], operations: readonly string[]): MuqeemTxView | null {
  return transactions.find((t) => t.unresolved && operations.includes(t.operation)) ?? null;
}

// ---------------------------------------------------------------------------
// API error classification for the pages
// ---------------------------------------------------------------------------

export type MuqeemUiErrorKind = 'UNKNOWN_OUTCOME' | 'UNRESOLVED' | 'REJECTED' | 'NOT_LINKED' | 'UNAVAILABLE' | 'DONE_NOT_SAVED' | 'OTHER';

export interface MuqeemUiError {
  kind: MuqeemUiErrorKind;
  message: string;
  /** MuqeemTransaction to reconcile (UNKNOWN_OUTCOME / UNRESOLVED), when known. */
  transactionId: string | null;
  /** True when the user must NOT retry before reconciling (the call may have been executed). */
  mustReconcile: boolean;
}

/** Turns an error response of /api/employees/[id]/muqeem into what the UI shows. */
export function classifyMuqeemApiError(httpStatus: number, body: unknown, fallback = 'حدث خطأ غير متوقع'): MuqeemUiError {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const d = b.details && typeof b.details === 'object' ? (b.details as Record<string, unknown>) : {};
  const message = (typeof b.message === 'string' && b.message) || (typeof b.error === 'string' && b.error) || fallback;
  const transactionId = typeof d.muqeemTransactionId === 'string' ? d.muqeemTransactionId : null;
  const muqeemKind = typeof d.muqeemKind === 'string' ? d.muqeemKind : null;
  const txStatus = typeof d.status === 'string' ? d.status : null;
  if (d.outcomeUnknown === true || muqeemKind === 'UNKNOWN_OUTCOME') {
    return { kind: 'UNKNOWN_OUTCOME', message, transactionId, mustReconcile: true };
  }
  if (d.inProgress === true) {
    // The same request is running right now (double click): wait and refresh, nothing to reconcile.
    return { kind: 'UNRESOLVED', message, transactionId, mustReconcile: false };
  }
  if (d.code === 'MUQEEM_UNRESOLVED' || (httpStatus === 409 && transactionId && isUnresolvedStatus(txStatus))) {
    return { kind: 'UNRESOLVED', message, transactionId, mustReconcile: true };
  }
  if (d.code === 'MUQEEM_DONE_DB_FAILED') return { kind: 'DONE_NOT_SAVED', message, transactionId, mustReconcile: false };
  if (muqeemKind === 'REJECTED') return { kind: 'REJECTED', message, transactionId, mustReconcile: false };
  if (muqeemKind === 'NOT_LINKED') return { kind: 'NOT_LINKED', message, transactionId: null, mustReconcile: false };
  if (muqeemKind === 'UNAVAILABLE' || muqeemKind === 'AUTH' || muqeemKind === 'NOT_CONFIGURED') {
    return { kind: 'UNAVAILABLE', message, transactionId, mustReconcile: false };
  }
  return { kind: 'OTHER', message, transactionId, mustReconcile: false };
}

/** Guidance shown under an undetermined outcome (never an automatic retry). */
export const RECONCILE_GUIDANCE =
  'لا تُعِد المحاولة. افتح بوابة مقيم أو «تقرير الخدمات التفاعلية» وتحقق هل نُفذت العملية، ثم سجّل النتيجة من زر «تسوية» في بطاقة «مقيم» بملف الموظف.';
