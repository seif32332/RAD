// Muqeem error model.
//
// Every failure of a Muqeem call is a MuqeemError with a `kind` that tells the caller whether the
// operation may have been executed on Muqeem's side:
//
//   NOT_CONFIGURED   integration disabled / env incomplete. Nothing was sent.
//   NOT_LINKED       the company has no moiNumber or no linked GovPlatform credentials. Nothing was sent.
//   AUTH             Muqeem refused our credentials (authenticate failed, or 401 twice / 403). Not executed.
//   REJECTED         Muqeem answered 4xx with a business error (message kept, Arabic when provided). Not executed.
//   UNAVAILABLE      5xx before execution, 429, connection refused / DNS / TLS. Not executed: safe to retry.
//   UNKNOWN_OUTCOME  timeout / connection reset / 500 / 504 AFTER a mutating request was sent: the operation
//                    MAY have been executed. Never retry blindly: reconcile first (interactive services report).
//
// Muqeem's error body format is not documented in the spec, so parseMuqeemErrorBody() is defensive.
import { HttpError } from '@/lib/http';

export const MUQEEM_ERROR_KINDS = ['NOT_CONFIGURED', 'NOT_LINKED', 'AUTH', 'REJECTED', 'UNAVAILABLE', 'UNKNOWN_OUTCOME'] as const;
export type MuqeemErrorKind = (typeof MUQEEM_ERROR_KINDS)[number];

/** HTTP status OUR API returns for each kind. Never 401 (the UI would log the user out). */
export const MUQEEM_ERROR_HTTP_STATUS: Readonly<Record<MuqeemErrorKind, number>> = {
  NOT_CONFIGURED: 503,
  NOT_LINKED: 409,
  AUTH: 502,
  REJECTED: 422,
  UNAVAILABLE: 503,
  UNKNOWN_OUTCOME: 504,
};

/** Arabic user-facing messages per kind (REJECTED appends Muqeem's own message). */
export const MUQEEM_ERROR_MESSAGES: Readonly<Record<MuqeemErrorKind, string>> = {
  NOT_CONFIGURED: 'الربط مع منصة مقيم غير مفعّل أو غير مكتمل الإعداد على الخادم. تواصل مع مدير النظام.',
  NOT_LINKED: 'الشركة غير مربوطة بمنصة مقيم: أدخل رقم المنشأة في الجوازات (700) واختر حساب مقيم من خزنة المنصات الحكومية في صفحة الشركة.',
  AUTH: 'تعذر تسجيل الدخول إلى منصة مقيم: تحقق من اسم المستخدم وكلمة المرور في خزنة المنصات الحكومية ومن مفاتيح التطبيق.',
  REJECTED: 'رفضت منصة مقيم الطلب',
  UNAVAILABLE: 'منصة مقيم غير متاحة حالياً ولم يُنفَّذ الطلب. حاول مرة أخرى لاحقاً.',
  UNKNOWN_OUTCOME:
    'انقطع الاتصال بمنصة مقيم بعد إرسال الطلب ولا يمكن التأكد من تنفيذه. لا تُعِد المحاولة قبل التحقق من تقرير الخدمات التفاعلية في مقيم ثم تسوية العملية.',
};

export interface MuqeemErrorOptions {
  /** HTTP status returned by Muqeem, when a response was received. */
  upstreamStatus?: number | null;
  /** Message extracted from Muqeem's response (already redacted). */
  upstreamMessage?: string | null;
  /** Operation name (e.g. 'exit-reentry/issue'), for logs. */
  operation?: string | null;
  /** Technical detail for server logs only (already redacted, never shown to users). */
  detail?: string | null;
  cause?: unknown;
}

export class MuqeemError extends Error {
  readonly kind: MuqeemErrorKind;
  readonly upstreamStatus: number | null;
  readonly upstreamMessage: string | null;
  readonly operation: string | null;
  readonly detail: string | null;

  constructor(kind: MuqeemErrorKind, opts: MuqeemErrorOptions = {}) {
    super(muqeemUserMessage(kind, opts.upstreamMessage ?? null), opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'MuqeemError';
    this.kind = kind;
    this.upstreamStatus = opts.upstreamStatus ?? null;
    this.upstreamMessage = opts.upstreamMessage ?? null;
    this.operation = opts.operation ?? null;
    this.detail = opts.detail ?? null;
  }

  /** HTTP status for our own API response. */
  get status(): number {
    return MUQEEM_ERROR_HTTP_STATUS[this.kind];
  }

  /** True when the operation may have been executed on Muqeem (must be reconciled, not retried). */
  get outcomeUnknown(): boolean {
    return this.kind === 'UNKNOWN_OUTCOME';
  }

  /** HttpError for handleApiError(), with details { muqeemKind, upstreamStatus }. */
  toHttpError(): HttpError {
    return new HttpError(this.status, this.message, { muqeemKind: this.kind, upstreamStatus: this.upstreamStatus });
  }
}

export function isMuqeemError(err: unknown): err is MuqeemError {
  return err instanceof MuqeemError;
}

/**
 * Route helper: `catch (err) { return handleApiError(toApiError(err), 'ctx') }`.
 * MuqeemError -> HttpError with the right status / Arabic message; anything else unchanged.
 */
export function toApiError(err: unknown): unknown {
  return err instanceof MuqeemError ? err.toHttpError() : err;
}

/** Arabic message for a kind; REJECTED includes Muqeem's message when there is one. */
export function muqeemUserMessage(kind: MuqeemErrorKind, upstreamMessage?: string | null): string {
  const base = MUQEEM_ERROR_MESSAGES[kind];
  if (kind === 'REJECTED' && upstreamMessage) return `${base}: ${upstreamMessage}`;
  return base;
}

// ---------------------------------------------------------------------------
// Error body parsing and redaction (pure)
// ---------------------------------------------------------------------------

const ARABIC_RE = /[؀-ۿ]/;
const MAX_MESSAGE_LENGTH = 500;

function pickString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function messagesFromErrors(errors: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown, depth: number) => {
    if (depth > 3 || out.length >= 10) return;
    const s = pickString(v);
    if (s) {
      out.push(s);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) visit(item, depth + 1);
      return;
    }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const direct =
        pickString(o.messageAr) ?? pickString(o.arabicMessage) ?? pickString(o.message) ?? pickString(o.defaultMessage) ??
        pickString(o.detail) ?? pickString(o.description) ?? pickString(o.error);
      if (direct) {
        const field = pickString(o.field) ?? pickString(o.fieldName);
        out.push(field && !direct.includes(field) ? `${field}: ${direct}` : direct);
        return;
      }
      for (const val of Object.values(o)) visit(val, depth + 1);
    }
  };
  visit(errors, 0);
  return out;
}

/**
 * Best-effort human message from a Muqeem error response body (format undocumented).
 * JSON: prefers Arabic among message / messageAr / title / detail / errorMessage / error / errors[];
 * otherwise plain text (HTML error pages are ignored). Returns null when nothing usable.
 */
export function parseMuqeemErrorBody(body: string | null | undefined): string | null {
  const text = (body ?? '').trim();
  if (!text) return null;
  let candidates: string[] = [];
  if (text.startsWith('{') || text.startsWith('[') || text.startsWith('"')) {
    try {
      const json: unknown = JSON.parse(text);
      if (typeof json === 'string') {
        candidates = [json];
      } else if (Array.isArray(json)) {
        candidates = messagesFromErrors(json);
      } else if (json && typeof json === 'object') {
        const o = json as Record<string, unknown>;
        candidates = [
          o.messageAr, o.arabicMessage, o.message, o.errorMessage, o.error_description, o.title, o.detail, o.description,
          typeof o.error === 'string' ? o.error : null,
        ]
          .map(pickString)
          .filter((s): s is string => !!s);
        candidates.push(...messagesFromErrors(o.errors ?? o.fieldErrors ?? (typeof o.error === 'object' ? o.error : null)));
      }
    } catch {
      candidates = [text];
    }
  } else if (/^<(!doctype|html|\?xml)/i.test(text)) {
    return null;
  } else {
    candidates = [text];
  }
  // Generic JHipster-style keys such as "error.http.400" are not useful to a user.
  const useful = candidates.filter((c) => !/^error\.[\w.]+$/i.test(c));
  if (!useful.length) return null;
  const arabic = useful.filter((c) => ARABIC_RE.test(c));
  const chosen = [...new Set(arabic.length ? arabic : useful)].slice(0, 3).join(' — ');
  return chosen.length > MAX_MESSAGE_LENGTH ? `${chosen.slice(0, MAX_MESSAGE_LENGTH)}…` : chosen;
}

/**
 * Removes secrets from any text before it is logged, stored or returned: every value in `secrets`
 * (ignoring values shorter than 4 chars), Bearer tokens and JWT-looking strings.
 */
export function redactSecrets(text: string, secrets: readonly (string | null | undefined)[] = []): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join('[REDACTED]');
  }
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
  out = out.replace(/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, '[REDACTED_JWT]');
  return out;
}
