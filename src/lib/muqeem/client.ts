// Muqeem HTTP client (server-only).
//
//   const client = await createMuqeemClient({ companyId });
//   const visa = await client.issueExitReentry({ iqamaNumber, visaType: 1, visaDuration: 60 });
//
// - Loads the company's moiNumber and the linked GovPlatform credentials (password decrypted with
//   decryptField). Throws MuqeemError NOT_CONFIGURED / NOT_LINKED before anything is sent.
// - Authenticates with POST /api/authenticate (headers app-id / app-key [+ X-INTEGRATOR-ID]) and caches
//   the id_token in memory per company until its JWT `exp` minus 60 s (payload decoded, not verified).
//   A 401 on a call invalidates the token, re-authenticates ONCE and replays the call (a 401 means the
//   gateway refused the call before execution, so the replay cannot duplicate an operation).
// - Every call sends app-id, app-key, Authorization: Bearer <id_token> and, when configured,
//   X-INTEGRATOR-ID; it is aborted after MUQEEM_TIMEOUT_MS.
// - Failures are classified precisely (see errors.ts). For MUTATING calls (issue/extend/cancel/renew/
//   update) a timeout, a reset connection, an unreadable 2xx body, a 500 or a 504 are UNKNOWN_OUTCOME,
//   never a plain failure: the operation may have been executed. Callers should run mutations through
//   runMuqeemTransaction (transactions.ts), which records that outcome.
// - Secrets (password, app key, token, integrator id) are redacted from every error text.
//
// Mutating methods do NOT ask for confirmation: the UI must obtain the user's explicit confirmation
// before calling them.
import 'server-only';
import { createHash } from 'crypto';
import { prisma } from '@/lib/prisma';
import { decryptField } from '@/lib/crypto';
import { badRequest, notFound } from '@/lib/http';
import { readMuqeemSettings, type MuqeemSettings } from './config';
import { MuqeemError, parseMuqeemErrorBody, redactSecrets } from './errors';
import { isHijriDateString } from './hijri';
import {
  IQAMA_DURATIONS_MONTHS,
  type ActiveResidentsReportRequest,
  type ExitReentryCancelRequest,
  type ExitReentryCancelResponse,
  type ExitReentryExtendRequest,
  type ExitReentryExtendResponse,
  type ExitReentryIssueRequest,
  type ExitReentryIssueResponse,
  type ExitReentryReprintRequest,
  type ExitReentryReprintResponse,
  type FinalExitCancelRequest,
  type FinalExitCancelResponse,
  type FinalExitIssueRequest,
  type FinalExitIssueResponse,
  type InteractiveServicesReportRequest,
  type InteractiveServicesReportRow,
  type IqamaRenewRequest,
  type IqamaRenewResponse,
  type MuqeemLookupItem,
  type MuqeemLookupType,
  type MuqeemPageable,
  type PassportExtendRequest,
  type PassportRenewRequest,
} from './types';

/** Minimal fetch signature (injectable for tests). */
export type MuqeemFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface CreateMuqeemClientOptions {
  companyId: string;
  /** Override fetch (tests). Defaults to the global fetch. */
  fetch?: MuqeemFetch;
}

/** Typed Muqeem API for one company. All methods throw MuqeemError on Muqeem failures. */
export interface MuqeemClient {
  readonly companyId: string;
  /** The company's MOI (700) number, as stored. */
  readonly moiNumber: string;
  /** Number of mutating requests actually sent so far (0 = nothing reached Muqeem). */
  readonly mutationsSent: number;

  /** Ensures a valid token (force: always re-authenticate). Used by "test connection". */
  authenticate(options?: { force?: boolean }): Promise<void>;

  getCities(): Promise<MuqeemLookupItem[]>;
  getCountries(): Promise<MuqeemLookupItem[]>;
  getMaritalStatuses(): Promise<MuqeemLookupItem[]>;
  getLookup(type: MuqeemLookupType): Promise<MuqeemLookupItem[]>;

  /** MUTATION. Issue an exit/re-entry visa (fee charged by Muqeem). */
  issueExitReentry(req: ExitReentryIssueRequest): Promise<ExitReentryIssueResponse>;
  /** MUTATION. Extend an exit/re-entry visa (resident outside the kingdom; fee charged). */
  extendExitReentry(req: ExitReentryExtendRequest): Promise<ExitReentryExtendResponse>;
  /** MUTATION. Cancel an issued, unused exit/re-entry visa. */
  cancelExitReentry(req: ExitReentryCancelRequest): Promise<ExitReentryCancelResponse>;
  /** Read-only. Re-print an exit/re-entry visa (returns ervisaPDF). */
  reprintExitReentry(req: ExitReentryReprintRequest): Promise<ExitReentryReprintResponse>;
  /** MUTATION. Issue a final exit visa. */
  issueFinalExit(req: FinalExitIssueRequest): Promise<FinalExitIssueResponse>;
  /** MUTATION. Cancel a final exit visa. */
  cancelFinalExit(req: FinalExitCancelRequest): Promise<FinalExitCancelResponse>;
  /** MUTATION. Renew an iqama (fees charged). */
  renewIqama(req: IqamaRenewRequest): Promise<IqamaRenewResponse>;
  /** MUTATION. Update information: new passport. Muqeem answering `false` throws REJECTED. */
  renewPassport(req: PassportRenewRequest): Promise<true>;
  /** MUTATION. Update information: new expiry date of the same passport. `false` throws REJECTED. */
  extendPassportValidity(req: PassportExtendRequest): Promise<true>;

  /** Read-only. Active residents of the company's MOI number. Response shape UNDOCUMENTED: use normalizeActiveResidents(). */
  getActiveResidentsReport(req?: ActiveResidentsReportRequest): Promise<unknown>;
  /** Read-only. Interactive services report (every request made on Muqeem): the reconciliation source. */
  getInteractiveServicesReport(req: InteractiveServicesReportRequest): Promise<InteractiveServicesReportRow[]>;
}

// ---------------------------------------------------------------------------
// Token cache (per process, per company). Kept on globalThis so every route bundle shares it.
// ---------------------------------------------------------------------------

interface CachedToken {
  token: string;
  /** Epoch ms after which the token must not be used. */
  expiresAt: number;
  /** Hash of the credentials the token was obtained with (a credential change invalidates it). */
  fingerprint: string;
}

interface MuqeemGlobals {
  muqeemTokens?: Map<string, CachedToken>;
  muqeemAuthInflight?: Map<string, Promise<CachedToken>>;
  muqeemLookupCache?: Map<string, { at: number; items: MuqeemLookupItem[] }>;
}
const g = globalThis as unknown as MuqeemGlobals;
const tokenCache: Map<string, CachedToken> = (g.muqeemTokens ??= new Map());
const authInflight: Map<string, Promise<CachedToken>> = (g.muqeemAuthInflight ??= new Map());
const lookupCache: Map<string, { at: number; items: MuqeemLookupItem[] }> = (g.muqeemLookupCache ??= new Map());

/** Tokens are dropped this long before their `exp`. */
export const TOKEN_EXPIRY_SKEW_MS = 60_000;
/** Lifetime assumed when the token has no readable `exp`. */
export const DEFAULT_TOKEN_TTL_MS = 5 * 60_000;
/** Lookups (cities / countries / marital statuses) are cached this long. */
export const LOOKUP_CACHE_TTL_MS = 12 * 60 * 60_000;

/** Drops cached tokens (one company, or all) and, with no argument, the lookup cache too. */
export function clearMuqeemCaches(companyId?: string): void {
  if (companyId) {
    tokenCache.delete(companyId);
    return;
  }
  tokenCache.clear();
  authInflight.clear();
  lookupCache.clear();
}

/** `exp` of a JWT in epoch ms (payload decoded WITHOUT verifying the signature), or null. */
export function jwtExpiryMs(token: string): number | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const exp = payload && typeof payload === 'object' ? (payload as { exp?: unknown }).exp : undefined;
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Transport and failure classification
// ---------------------------------------------------------------------------

type CallKind = 'read' | 'mutation';

interface CallSpec {
  /** Short operation name for errors / logs, e.g. 'exit-reentry/issue'. */
  operation: string;
  method: 'GET' | 'POST';
  path: string;
  kind: CallKind;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
}

interface RawResponse {
  status: number;
  text: string;
  headers: Headers;
}

/** Network error codes meaning the request never reached the server (safe to retry). */
const NOT_SENT_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_INVALID_URL',
]);

function errorCodes(err: unknown): string[] {
  const codes: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur && typeof cur === 'object'; i++) {
    const c = (cur as { code?: unknown }).code;
    if (typeof c === 'string') codes.push(c);
    const name = (cur as { name?: unknown }).name;
    if (typeof name === 'string') codes.push(name);
    cur = (cur as { cause?: unknown }).cause;
  }
  return codes;
}

/** Classifies a thrown fetch/body error. `timedOut` = our AbortController fired. */
function classifyNetworkError(err: unknown, spec: CallSpec, timedOut: boolean, secrets: readonly string[]): MuqeemError {
  const codes = errorCodes(err);
  const notSent = !timedOut && codes.some((c) => NOT_SENT_CODES.has(c));
  const detail = redactSecrets(`${spec.operation}: ${timedOut ? 'timeout' : codes.join('/') || 'network error'}`, secrets);
  if (spec.kind === 'mutation' && !notSent) {
    return new MuqeemError('UNKNOWN_OUTCOME', { operation: spec.operation, detail });
  }
  return new MuqeemError('UNAVAILABLE', { operation: spec.operation, detail });
}

/** Classifies a non-2xx response (after the 401 retry). */
function classifyHttpError(res: RawResponse, spec: CallSpec, secrets: readonly string[]): MuqeemError {
  const message = (() => {
    const m = parseMuqeemErrorBody(res.text);
    return m ? redactSecrets(m, secrets) : null;
  })();
  const base = { operation: spec.operation, upstreamStatus: res.status, upstreamMessage: message, detail: `${spec.operation}: HTTP ${res.status}` };
  const s = res.status;
  if (s === 401 || s === 403) return new MuqeemError('AUTH', base);
  if (s === 408 || s === 429) {
    // 408: the server gave up waiting for our request body (not executed). 429: rate limited.
    return new MuqeemError('UNAVAILABLE', base);
  }
  if (s >= 400 && s < 500) return new MuqeemError('REJECTED', base);
  // 5xx. 502/503: gateway could not reach / refused the backend: not executed.
  // 500/504 (and anything else) on a mutation: the backend may have executed it.
  if (spec.kind === 'mutation' && s !== 502 && s !== 503) return new MuqeemError('UNKNOWN_OUTCOME', base);
  return new MuqeemError('UNAVAILABLE', base);
}

function buildUrl(baseUrl: string, path: string, query?: CallSpec['query']): string {
  const url = new URL(baseUrl + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
  return url.toString();
}

function pageQuery(p?: MuqeemPageable): Record<string, string | number | undefined> {
  return {
    page: p?.page ?? 0,
    size: p?.size ?? 500,
    sort: p?.sort?.length ? p.sort.join(',') : undefined,
  };
}

// ---------------------------------------------------------------------------
// Input guards (throw HttpError 400 before anything is sent)
// ---------------------------------------------------------------------------

const IQAMA_RE = /^2\d{9}$/;
const VISA_NUMBER_RE = /^\d{1,250}$/;
const PASSPORT_RE = /^[A-Za-z0-9]{1,15}$/;
const GREGORIAN_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertIqama(v: string) {
  if (!IQAMA_RE.test(v ?? '')) throw badRequest('رقم الإقامة يجب أن يتكون من 10 أرقام ويبدأ بالرقم 2');
}
function assertVisaNumber(v: string) {
  if (!VISA_NUMBER_RE.test(v ?? '')) throw badRequest('رقم التأشيرة غير صالح');
}
function assertPassport(v: string, label = 'رقم الجواز') {
  if (!PASSPORT_RE.test(v ?? '')) throw badRequest(`${label} غير صالح (حروف إنجليزية وأرقام حتى 15 خانة)`);
}
function assertGregorian(v: string, label: string) {
  if (!GREGORIAN_RE.test(v ?? '') || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw badRequest(`${label}: تاريخ ميلادي غير صالح (yyyy-MM-dd)`);
}
function assertDuration(v: number | undefined, required: boolean) {
  if (v === undefined && !required) return;
  if (!Number.isInteger(v) || (v as number) < 7) throw badRequest('مدة التأشيرة يجب أن تكون 7 أيام على الأقل');
}
function assertHijri(v: string | undefined, required: boolean) {
  if (v === undefined && !required) return;
  if (!isHijriDateString(v)) throw badRequest('تاريخ "العودة قبل" يجب أن يكون تاريخاً هجرياً بصيغة yyyy-MM-dd');
}

// ---------------------------------------------------------------------------
// Account loading
// ---------------------------------------------------------------------------

interface MuqeemAccount {
  companyId: string;
  moiNumber: string;
  platformId: string;
  username: string;
  password: string;
}

async function loadAccount(companyId: string): Promise<MuqeemAccount> {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: {
      id: true,
      moiNumber: true,
      muqeemPlatform: { select: { id: true, username: true, password: true } },
    },
  });
  if (!company) throw notFound('الشركة غير موجودة');
  const moiNumber = company.moiNumber?.trim() ?? '';
  const platform = company.muqeemPlatform;
  if (!moiNumber || !platform) {
    throw new MuqeemError('NOT_LINKED', { detail: !moiNumber ? 'company has no moiNumber' : 'company has no muqeemPlatformId' });
  }
  let password: string | null;
  try {
    password = decryptField(platform.password);
  } catch {
    throw new MuqeemError('NOT_LINKED', { detail: 'stored Muqeem password cannot be decrypted (DATA_ENCRYPTION_KEY?)' });
  }
  if (!platform.username?.trim() || !password) {
    throw new MuqeemError('NOT_LINKED', { detail: 'linked GovPlatform has no username/password' });
  }
  return { companyId: company.id, moiNumber, platformId: platform.id, username: platform.username.trim(), password };
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

/**
 * Creates a Muqeem client for a company. Throws MuqeemError NOT_CONFIGURED (integration off / env
 * incomplete), NOT_LINKED (no moiNumber / no linked credentials) or HttpError 404 (unknown company).
 */
export async function createMuqeemClient(options: CreateMuqeemClientOptions): Promise<MuqeemClient> {
  const settings: MuqeemSettings = readMuqeemSettings();
  const account = await loadAccount(options.companyId);
  const fetchImpl: MuqeemFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const fingerprint = createHash('sha256')
    .update([settings.baseUrl, settings.appId, settings.appKey, settings.integratorId ?? '', account.platformId, account.username, account.password].join('\u0000'))
    .digest('hex');
  const secretsBase = [account.password, settings.appKey, settings.appId, settings.integratorId ?? ''].filter(Boolean);
  let mutationsSent = 0;

  const secrets = (): string[] => {
    const cached = tokenCache.get(account.companyId);
    return cached ? [...secretsBase, cached.token] : secretsBase;
  };

  const baseHeaders = (): Record<string, string> => {
    const h: Record<string, string> = {
      'app-id': settings.appId,
      'app-key': settings.appKey,
      Accept: 'application/json',
    };
    if (settings.integratorId) h['X-INTEGRATOR-ID'] = settings.integratorId;
    return h;
  };

  /** One HTTP exchange with timeout. Throws a classified MuqeemError on network failures. */
  async function send(spec: CallSpec, token: string | null): Promise<RawResponse> {
    const headers = baseHeaders();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (spec.body !== undefined) headers['Content-Type'] = 'application/json';
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, settings.timeoutMs);
    try {
      if (spec.kind === 'mutation') mutationsSent++;
      const res = await fetchImpl(buildUrl(settings.baseUrl, spec.path, spec.query), {
        method: spec.method,
        headers,
        body: spec.body !== undefined ? JSON.stringify(spec.body) : undefined,
        signal: controller.signal,
        cache: 'no-store',
        redirect: 'error',
      });
      let text: string;
      try {
        text = await res.text();
      } catch (err) {
        // Headers arrived but the body did not: for a 2xx mutation the operation was executed.
        if (res.ok || spec.kind === 'mutation') throw classifyNetworkError(err, spec, true, secrets());
        text = '';
      }
      return { status: res.status, text, headers: res.headers };
    } catch (err) {
      if (err instanceof MuqeemError) throw err;
      throw classifyNetworkError(err, spec, timedOut, secrets());
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchToken(): Promise<CachedToken> {
    const spec: CallSpec = {
      operation: 'authenticate',
      method: 'POST',
      path: '/api/authenticate',
      kind: 'read',
      body: { username: account.username, password: account.password },
    };
    const res = await send(spec, null);
    if (res.status < 200 || res.status >= 300) {
      const err = classifyHttpError(res, spec, secrets());
      // Any 4xx on authenticate means our credentials / app keys were refused.
      if (err.kind === 'REJECTED') {
        throw new MuqeemError('AUTH', { operation: spec.operation, upstreamStatus: err.upstreamStatus, upstreamMessage: err.upstreamMessage, detail: err.detail });
      }
      throw err;
    }
    let token: string | null = null;
    try {
      const json: unknown = JSON.parse(res.text);
      const t = json && typeof json === 'object' ? (json as { id_token?: unknown }).id_token : undefined;
      if (typeof t === 'string' && t.trim()) token = t.trim();
    } catch {
      token = null;
    }
    if (!token) {
      const header = res.headers.get('authorization');
      if (header?.toLowerCase().startsWith('bearer ')) token = header.slice(7).trim() || null;
    }
    if (!token) throw new MuqeemError('AUTH', { operation: spec.operation, upstreamStatus: res.status, detail: 'authenticate: no id_token in response' });
    const exp = jwtExpiryMs(token);
    const expiresAt = exp !== null ? exp - TOKEN_EXPIRY_SKEW_MS : Date.now() + DEFAULT_TOKEN_TTL_MS;
    return { token, expiresAt, fingerprint };
  }

  async function getToken(force: boolean): Promise<string> {
    const cached = tokenCache.get(account.companyId);
    if (!force && cached && cached.fingerprint === fingerprint && cached.expiresAt > Date.now()) return cached.token;
    tokenCache.delete(account.companyId);
    let pending = authInflight.get(account.companyId);
    if (!pending) {
      pending = fetchToken().finally(() => authInflight.delete(account.companyId));
      authInflight.set(account.companyId, pending);
    }
    const fresh = await pending;
    tokenCache.set(account.companyId, fresh);
    return fresh.token;
  }

  async function call<T>(spec: CallSpec): Promise<T> {
    let token = await getToken(false);
    let res = await send(spec, token);
    if (res.status === 401) {
      // Refused before execution: re-authenticate once and replay.
      tokenCache.delete(account.companyId);
      token = await getToken(true);
      res = await send(spec, token);
    }
    if (res.status < 200 || res.status >= 300) {
      if (res.status === 401) tokenCache.delete(account.companyId);
      throw classifyHttpError(res, spec, secrets());
    }
    const text = res.text.trim();
    if (!text) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      if (spec.kind === 'mutation') {
        throw new MuqeemError('UNKNOWN_OUTCOME', { operation: spec.operation, upstreamStatus: res.status, detail: `${spec.operation}: 2xx with a non-JSON body` });
      }
      throw new MuqeemError('UNAVAILABLE', { operation: spec.operation, upstreamStatus: res.status, detail: `${spec.operation}: 2xx with a non-JSON body` });
    }
  }

  const post = <T>(operation: string, path: string, kind: CallKind, body: unknown, query?: CallSpec['query']) =>
    call<T>({ operation, method: 'POST', path: `/api/v1/${path}`, kind, body, query });

  const lookup = async (type: MuqeemLookupType): Promise<MuqeemLookupItem[]> => {
    const data = await call<unknown>({ operation: `lookups/${type}`, method: 'GET', path: `/api/lookups/${type}`, kind: 'read' });
    return Array.isArray(data) ? (data as MuqeemLookupItem[]) : [];
  };

  const updateInformation = async (operation: 'update-information/renew' | 'update-information/extend', body: unknown): Promise<true> => {
    const ok = await post<unknown>(operation, operation, 'mutation', body);
    if (ok === false) {
      throw new MuqeemError('REJECTED', { operation, upstreamStatus: 200, upstreamMessage: 'لم تقبل منصة مقيم تحديث بيانات الجواز', detail: `${operation}: false` });
    }
    return true;
  };

  return {
    companyId: account.companyId,
    moiNumber: account.moiNumber,
    get mutationsSent() {
      return mutationsSent;
    },

    async authenticate(opts) {
      await getToken(!!opts?.force);
    },

    getCities: () => lookup('cities'),
    getCountries: () => lookup('countries'),
    getMaritalStatuses: () => lookup('marital-statuses'),
    getLookup: (type) => lookup(type),

    async issueExitReentry(req) {
      assertIqama(req.iqamaNumber);
      if (req.visaType !== 1 && req.visaType !== 2) throw badRequest('نوع التأشيرة يجب أن يكون 1 (مفردة) أو 2 (متعددة)');
      assertDuration(req.visaDuration, false);
      assertHijri(req.returnBefore, false);
      if (req.visaDuration === undefined && req.returnBefore === undefined) throw badRequest('حدد مدة التأشيرة أو تاريخ العودة قبل');
      return post<ExitReentryIssueResponse>('exit-reentry/issue', 'exit-reentry/issue', 'mutation', {
        iqamaNumber: req.iqamaNumber,
        visaType: req.visaType,
        ...(req.visaDuration !== undefined ? { visaDuration: req.visaDuration } : {}),
        ...(req.returnBefore !== undefined ? { returnBefore: req.returnBefore } : {}),
      });
    },

    async extendExitReentry(req) {
      assertIqama(req.iqamaNumber);
      assertVisaNumber(req.visaNumber);
      assertDuration(req.visaDuration, true);
      assertHijri(req.returnBefore, true);
      return post<ExitReentryExtendResponse>('exit-reentry/extend', 'exit-reentry/extend', 'mutation', {
        iqamaNumber: req.iqamaNumber,
        visaNumber: req.visaNumber,
        visaDuration: req.visaDuration,
        returnBefore: req.returnBefore,
      });
    },

    async cancelExitReentry(req) {
      assertIqama(req.iqamaNumber);
      assertVisaNumber(req.erVisaNumber);
      return post<ExitReentryCancelResponse>('exit-reentry/cancel', 'exit-reentry/cancel', 'mutation', {
        iqamaNumber: req.iqamaNumber,
        erVisaNumber: req.erVisaNumber,
      });
    },

    async reprintExitReentry(req) {
      assertIqama(req.iqamaNumber);
      assertVisaNumber(req.visaNumber);
      return post<ExitReentryReprintResponse>('exit-reentry/reprint', 'exit-reentry/reprint', 'read', {
        iqamaNumber: req.iqamaNumber,
        visaNumber: req.visaNumber,
      });
    },

    async issueFinalExit(req) {
      assertIqama(req.iqamaNumber);
      return post<FinalExitIssueResponse>('final-exit/issue', 'final-exit/issue', 'mutation', {
        iqamaNumber: req.iqamaNumber,
        ...(req.visaType !== undefined ? { visaType: req.visaType } : {}),
      });
    },

    async cancelFinalExit(req) {
      assertIqama(req.iqamaNumber);
      assertVisaNumber(req.feVisaNumber);
      return post<FinalExitCancelResponse>('final-exit/cancel', 'final-exit/cancel', 'mutation', {
        iqamaNumber: req.iqamaNumber,
        feVisaNumber: req.feVisaNumber,
        ...(req.visaType !== undefined ? { visaType: req.visaType } : {}),
      });
    },

    async renewIqama(req) {
      assertIqama(req.iqamaNumber);
      if (!(IQAMA_DURATIONS_MONTHS as readonly string[]).includes(req.iqamaDuration)) {
        throw badRequest(`مدة الإقامة يجب أن تكون إحدى القيم: ${IQAMA_DURATIONS_MONTHS.join('، ')} شهراً`);
      }
      return post<IqamaRenewResponse>('iqama/renew', 'iqama/renew', 'mutation', {
        iqamaNumber: req.iqamaNumber,
        iqamaDuration: req.iqamaDuration,
      });
    },

    async renewPassport(req) {
      assertIqama(req.iqamaNumber);
      assertPassport(req.passportNumber, 'رقم الجواز الحالي');
      assertPassport(req.newPassportNumber, 'رقم الجواز الجديد');
      assertGregorian(req.newPassportIssueDate, 'تاريخ إصدار الجواز الجديد');
      assertGregorian(req.newPassportExpiryDate, 'تاريخ انتهاء الجواز الجديد');
      if (!req.newPassportIssueLocation?.trim()) throw badRequest('مكان إصدار الجواز الجديد مطلوب');
      return updateInformation('update-information/renew', {
        iqamaNumber: req.iqamaNumber,
        passportNumber: req.passportNumber,
        newPassportNumber: req.newPassportNumber,
        newPassportIssueDate: req.newPassportIssueDate,
        newPassportExpiryDate: req.newPassportExpiryDate,
        newPassportIssueLocation: req.newPassportIssueLocation.trim(),
      });
    },

    async extendPassportValidity(req) {
      assertIqama(req.iqamaNumber);
      assertPassport(req.passportNumber);
      assertGregorian(req.newPassportExpiryDate, 'تاريخ انتهاء الجواز الجديد');
      return updateInformation('update-information/extend', {
        iqamaNumber: req.iqamaNumber,
        passportNumber: req.passportNumber,
        newPassportExpiryDate: req.newPassportExpiryDate,
      });
    },

    async getActiveResidentsReport(req) {
      return post<unknown>(
        'report/active-residents-report',
        'report/active-residents-report',
        'read',
        { moiNumber: account.moiNumber, withDependents: !!req?.withDependents },
        pageQuery(req),
      );
    },

    async getInteractiveServicesReport(req) {
      assertGregorian(req.fromDate, 'من تاريخ');
      assertGregorian(req.toDate, 'إلى تاريخ');
      if (!/^[1-2]\d{9}$/.test(req.operatorId ?? '')) throw badRequest('رقم هوية المشغل يجب أن يتكون من 10 أرقام ويبدأ بـ 1 أو 2');
      const data = await post<unknown>(
        'report/interactive-services-report',
        'report/interactive-services-report',
        'read',
        { fromDate: req.fromDate, toDate: req.toDate, operatorId: req.operatorId, user: req.user?.trim() || account.username },
        pageQuery(req),
      );
      return Array.isArray(data) ? (data as InteractiveServicesReportRow[]) : [];
    },
  };
}

/**
 * Lookup list with a 12 h in-memory cache (lookups are global reference data, so the cache is
 * shared by every company). The company only provides the credentials for the first fetch.
 */
export async function getCachedMuqeemLookup(
  type: MuqeemLookupType,
  companyId: string,
  options: { fetch?: MuqeemFetch; refresh?: boolean } = {},
): Promise<{ items: MuqeemLookupItem[]; cachedAt: Date; fromCache: boolean }> {
  const settings = readMuqeemSettings();
  const key = `${settings.baseUrl}|${type}`;
  const hit = lookupCache.get(key);
  if (!options.refresh && hit && Date.now() - hit.at < LOOKUP_CACHE_TTL_MS) {
    return { items: hit.items, cachedAt: new Date(hit.at), fromCache: true };
  }
  const client = await createMuqeemClient({ companyId, fetch: options.fetch });
  const items = await client.getLookup(type);
  const at = Date.now();
  lookupCache.set(key, { at, items });
  return { items, cachedAt: new Date(at), fromCache: false };
}
