// Pure rules of the "final exit via Muqeem" feature of an end-of-service settlement.
// Not a route (no route.ts): Next does not serve this file. No server imports here (unit-tested in
// src/lib/__tests__/mq-finalexit-logic.test.ts).
//
// State is derived ONLY from the MuqeemTransaction rows of the settlement (entityType SETTLEMENT):
//   FINAL_EXIT_ISSUE  SUCCEEDED -> a final exit visa exists (externalRef = visa number)
//   FINAL_EXIT_CANCEL SUCCEEDED -> that visa was cancelled (externalRef / requestSummary.feVisaNumber)
//   any PENDING / UNKNOWN       -> undetermined: nothing else is allowed until it is reconciled.
import { isSaudiNationalityValue } from '@/lib/employee-shared';
import { parseMuqeemGregorian } from '@/lib/muqeem/hijri';

export const FINAL_EXIT_VISA_TYPE = 'خروج نهائي';
export const FINAL_EXIT_ENTITY_TYPE = 'SETTLEMENT';
export const FINAL_EXIT_ISSUE_OP = 'FINAL_EXIT_ISSUE';
export const FINAL_EXIT_CANCEL_OP = 'FINAL_EXIT_CANCEL';
/** Settlement statuses that allow issuing the final exit (owner approved, or already paid). */
export const FINAL_EXIT_SETTLEMENT_STATUSES: readonly string[] = ['OWNER_APPROVED', 'PAID'];
/** Same rule as the Muqeem spec (FEVisaIssuanceRequestVM.iqamaNumber). */
export const IQAMA_RE = /^2[0-9]{9}$/;
/** Same rule as the Muqeem spec (FEVisaCancellationRequestVM.feVisaNumber). */
export const VISA_NUMBER_RE = /^[0-9]{1,250}$/;
/** Mirrors STALE_PENDING_MS of the core (a PENDING row older than this can be reconciled). */
export const STALE_PENDING_MS_MIRROR = 10 * 60_000;

export interface FinalExitTx {
  id: string;
  operation: string;
  status: string;
  externalRef: string | null;
  errorMessage: string | null;
  requestSummary: string | null;
  responseSummary: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export type FinalExitPhase = 'NONE' | 'FAILED' | 'ISSUED' | 'CANCELLED' | 'UNDETERMINED';

export interface FinalExitState {
  phase: FinalExitPhase;
  /** Active (issued, not cancelled) final exit visa number; null when none or unknown. */
  visaNumber: string | null;
  /** The SUCCEEDED issue transaction of the active visa. */
  activeIssue: FinalExitTx | null;
  /** Oldest PENDING / UNKNOWN transaction (blocks every new action). */
  undetermined: FinalExitTx | null;
  /** Number of successful cancellations (used to build a NEW idempotency key for a re-issue). */
  successfulCancels: number;
  /** Error of the latest FAILED transaction when it is the most recent event. */
  lastError: string | null;
}

const byDate = (a: FinalExitTx, b: FinalExitTx) => a.createdAt.getTime() - b.createdAt.getTime();

/** Reads a JSON summary stored by the core (null when absent or not JSON). */
export function parseSummary(json: string | null | undefined): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const v: unknown = JSON.parse(json);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function digits(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) v = String(v);
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return VISA_NUMBER_RE.test(s) ? s : null;
}

/** Visa number a cancel transaction targeted (its externalRef, else what was requested). */
export function cancelledVisaNumber(tx: Pick<FinalExitTx, 'externalRef' | 'requestSummary'>): string | null {
  return digits(tx.externalRef) ?? digits(parseSummary(tx.requestSummary)?.feVisaNumber);
}

/** Derives the final exit state of one settlement from its Muqeem transactions (any order). */
export function deriveFinalExitState(rows: readonly FinalExitTx[]): FinalExitState {
  const txs = rows
    .filter((t) => t.operation === FINAL_EXIT_ISSUE_OP || t.operation === FINAL_EXIT_CANCEL_OP)
    .slice()
    .sort(byDate);
  const undetermined = txs.find((t) => t.status === 'PENDING' || t.status === 'UNKNOWN') ?? null;

  let activeIssue: FinalExitTx | null = null;
  let successfulCancels = 0;
  for (const t of txs) {
    if (t.status !== 'SUCCEEDED') continue;
    if (t.operation === FINAL_EXIT_ISSUE_OP) {
      activeIssue = t;
    } else {
      successfulCancels += 1;
      const cancelled = cancelledVisaNumber(t);
      if (activeIssue && (!cancelled || cancelled === digits(activeIssue.externalRef))) activeIssue = null;
    }
  }

  const last = txs[txs.length - 1];
  const lastError = last && last.status === 'FAILED' ? last.errorMessage : null;
  let phase: FinalExitPhase;
  if (undetermined) phase = 'UNDETERMINED';
  else if (activeIssue) phase = 'ISSUED';
  else if (successfulCancels > 0) phase = 'CANCELLED';
  else if (txs.some((t) => t.status === 'FAILED')) phase = 'FAILED';
  else phase = 'NONE';

  return { phase, visaNumber: activeIssue ? digits(activeIssue.externalRef) : null, activeIssue, undetermined, successfulCancels, lastError };
}

/**
 * Idempotency key parts of the issue action (after the operation name). Deterministic per
 * settlement AND per issue "generation": a double click / retry reuses the same key, while a new
 * issue after a successful cancellation gets a new one.
 */
export function issueKeyParts(settlementId: string, successfulCancels: number): string[] {
  return successfulCancels > 0 ? ['settlement', settlementId, 'reissue', String(successfulCancels)] : ['settlement', settlementId];
}

/** Idempotency key parts of the cancel action (one per settlement and visa number). */
export function cancelKeyParts(settlementId: string, visaNumber: string): string[] {
  return ['settlement', settlementId, visaNumber];
}

export type FinalExitBlockCode =
  | 'NOT_END_OF_SERVICE'
  | 'SETTLEMENT_STATUS'
  | 'SAUDI'
  | 'INVALID_IQAMA'
  | 'NO_LEGAL_COMPANY'
  | 'NOT_LINKED'
  | 'NOT_CONFIGURED'
  | 'ALREADY_ISSUED'
  | 'UNDETERMINED';

export interface FinalExitBlock {
  code: FinalExitBlockCode;
  message: string;
}

export interface FinalExitEligibilityInput {
  settlement: { type: string; status: string };
  employee: { nationality: string | null; iqamaOrIdNumber: string | null };
  company: { name: string; linked: boolean } | null;
  muqeemUsable: boolean;
  state: FinalExitState;
}

const SETTLEMENT_STATUS_AR: Record<string, string> = {
  PENDING_APPROVAL: 'بانتظار تعميد صاحب العمل',
  OWNER_APPROVED: 'معتمدة',
  PAID: 'مدفوعة',
  REJECTED: 'مرفوضة',
};

/** Why the final exit cannot be issued now (empty = eligible). Order: most fundamental first. */
export function issueBlockers(i: FinalExitEligibilityInput): FinalExitBlock[] {
  const out: FinalExitBlock[] = [];
  if (i.settlement.type !== 'END_OF_SERVICE') {
    out.push({ code: 'NOT_END_OF_SERVICE', message: 'إصدار الخروج النهائي عبر مقيم متاح لتصفيات نهاية الخدمة فقط.' });
  }
  if (!FINAL_EXIT_SETTLEMENT_STATUSES.includes(i.settlement.status)) {
    const label = SETTLEMENT_STATUS_AR[i.settlement.status] ?? i.settlement.status;
    out.push({
      code: 'SETTLEMENT_STATUS',
      message: `يجب أن تكون التصفية معتمدة من صاحب العمل أو مدفوعة قبل إصدار الخروج النهائي (حالتها الآن: ${label}).`,
    });
  }
  if (isSaudiNationalityValue(i.employee.nationality)) {
    out.push({ code: 'SAUDI', message: 'الموظف سعودي الجنسية وليس مقيماً، فلا تنطبق عليه تأشيرة الخروج النهائي في مقيم.' });
  } else if (!IQAMA_RE.test((i.employee.iqamaOrIdNumber ?? '').trim())) {
    out.push({
      code: 'INVALID_IQAMA',
      message: 'رقم إقامة الموظف المسجل غير صالح لمقيم (يجب أن يكون 10 أرقام تبدأ بالرقم 2). صحّحه في ملف الموظف أولاً.',
    });
  }
  if (!i.company) {
    out.push({
      code: 'NO_LEGAL_COMPANY',
      message: 'لم تُحدَّد الشركة الكفيلة (الكيان النظامي) للموظف، ومنها يُعرف حساب مقيم المستخدم. حدّدها في ملف الموظف.',
    });
  } else if (!i.company.linked) {
    out.push({
      code: 'NOT_LINKED',
      message: `الشركة الكفيلة «${i.company.name}» غير مربوطة بمنصة مقيم: أدخل رقم المنشأة في الجوازات (700) واختر حساب مقيم في صفحة الشركة.`,
    });
  }
  if (!i.muqeemUsable) {
    out.push({ code: 'NOT_CONFIGURED', message: 'الربط مع منصة مقيم غير مفعّل أو غير مكتمل الإعداد على الخادم. تواصل مع مدير النظام.' });
  }
  if (i.state.phase === 'UNDETERMINED') {
    out.push({
      code: 'UNDETERMINED',
      message:
        'توجد عملية سابقة على مقيم لهذه التصفية لم تُحسم نتيجتها. لا تُعِد المحاولة: راجع تقرير الخدمات التفاعلية في مقيم ثم سجّل النتيجة (تسوية) أولاً.',
    });
  } else if (i.state.phase === 'ISSUED') {
    out.push({
      code: 'ALREADY_ISSUED',
      message: `صدرت تأشيرة خروج نهائي لهذه التصفية${i.state.visaNumber ? ` (رقم ${i.state.visaNumber})` : ''}.`,
    });
  }
  return out;
}

/** Why the active final exit cannot be cancelled now (empty = allowed). */
export function cancelBlockers(i: Omit<FinalExitEligibilityInput, 'settlement'>): FinalExitBlock[] {
  const out: FinalExitBlock[] = [];
  if (i.state.phase === 'UNDETERMINED') {
    out.push({
      code: 'UNDETERMINED',
      message: 'توجد عملية سابقة على مقيم لهذه التصفية لم تُحسم نتيجتها. سجّل نتيجتها (تسوية) قبل أي إجراء جديد.',
    });
    return out;
  }
  if (i.state.phase !== 'ISSUED' || !i.state.visaNumber) {
    out.push({ code: 'ALREADY_ISSUED', message: 'لا توجد تأشيرة خروج نهائي صادرة معروفة الرقم لهذه التصفية لإلغائها.' });
  }
  if (!IQAMA_RE.test((i.employee.iqamaOrIdNumber ?? '').trim())) {
    out.push({ code: 'INVALID_IQAMA', message: 'رقم إقامة الموظف المسجل غير صالح لمقيم (10 أرقام تبدأ بالرقم 2).' });
  }
  if (!i.company) out.push({ code: 'NO_LEGAL_COMPANY', message: 'لم تُحدَّد الشركة الكفيلة للموظف.' });
  else if (!i.company.linked) out.push({ code: 'NOT_LINKED', message: `الشركة الكفيلة «${i.company.name}» غير مربوطة بمنصة مقيم.` });
  if (!i.muqeemUsable) out.push({ code: 'NOT_CONFIGURED', message: 'الربط مع منصة مقيم غير مفعّل أو غير مكتمل الإعداد على الخادم.' });
  return out;
}

export interface FinalExitDetails {
  visaNumber: string | null;
  /** Must leave the Kingdom before this day (Gregorian, UTC midnight). */
  exitBefore: Date | null;
  exitBeforeHijri: string | null;
  issuedOn: Date | null;
  residentName: string | null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

/**
 * Reads FEVisaIssuanceResponseVM / FEVisaCancellationResponseVM defensively:
 * mainResident.finalExitVisa.visaNumber first (the FE visa itself), then mainResident.visaNumber.
 * Also accepts the { response, pdfError } wrapper the core stores when a PDF could not be saved.
 */
export function extractFinalExitDetails(resp: unknown): FinalExitDetails {
  let root: unknown = resp;
  if (root && typeof root === 'object' && 'response' in root && !('mainResident' in root)) root = (root as { response: unknown }).response;
  const main = root && typeof root === 'object' ? (root as { mainResident?: unknown }).mainResident : undefined;
  const m = main && typeof main === 'object' ? (main as Record<string, unknown>) : {};
  const fe = m.finalExitVisa && typeof m.finalExitVisa === 'object' ? (m.finalExitVisa as Record<string, unknown>) : {};
  return {
    visaNumber: digits(fe.visaNumber) ?? digits(m.visaNumber),
    exitBefore: parseMuqeemGregorian(fe.exitBeforeG),
    exitBeforeHijri: str(fe.exitBeforeH),
    issuedOn: parseMuqeemGregorian(fe.issuanceDateG),
    residentName: str(m.residentName),
  };
}

/** Validates a visa number typed by HR during reconciliation (Arabic digits accepted). */
export function normalizeVisaNumberInput(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const latin = String(v).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  return digits(latin.replace(/[\s-]/g, ''));
}

/** A transaction the core's reconcileTransaction() accepts: UNKNOWN, or PENDING older than 10 minutes. */
export function isReconcilable(tx: Pick<FinalExitTx, 'status' | 'createdAt'>, now: Date): boolean {
  if (tx.status === 'UNKNOWN') return true;
  return tx.status === 'PENDING' && now.getTime() - tx.createdAt.getTime() > STALE_PENDING_MS_MIRROR;
}

export interface FinalExitLoanRow {
  remainingAmount: number;
}

/** Extra warnings specific to the final exit (in addition to the settlement's open obligations). */
export function finalExitExtraWarnings(i: { settlementStatus: string; loans: readonly FinalExitLoanRow[] }): string[] {
  const w: string[] = [];
  if (i.settlementStatus === 'OWNER_APPROVED') {
    w.push('مستحقات التصفية معتمدة لكنها لم تُصرف بعد. تأكد من ترتيب صرفها قبل مغادرة الموظف.');
  }
  const remaining = i.loans.reduce((s, l) => s + (Number.isFinite(l.remainingAmount) ? l.remainingAmount : 0), 0);
  if (remaining > 0.004) {
    w.push(`على الموظف سلف قائمة برصيد متبقٍ ${remaining.toFixed(2)} ر.س. تأكد من تسويتها قبل المغادرة.`);
  }
  return w;
}
