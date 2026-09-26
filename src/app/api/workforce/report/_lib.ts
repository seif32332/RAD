// Shared server helpers of the internal PDF reports (SPEC §11 «تقارير PDF»): GET/POST /api/workforce/report and
// GET /api/portal/total-rewards/pdf. Not a route.
//
// The report data come from the SAME view objects the pages receive: the view's own route handler is called
// in-process with the caller's session (same role checks, same privacy restriction, same validation and
// errors, which are passed through unchanged), or, for «لوحة القرار», the same runner + shaping function.
import 'server-only';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { logAudit } from '@/lib/audit';
import { rateLimit } from '@/lib/rate-limit';
import { HttpError, jsonError } from '@/lib/http';
import type { AuthUser } from '@/lib/auth';
import {
  REPORT_SERVICE_NOT_CONFIGURED,
  REPORT_SERVICE_UNAVAILABLE,
  RenderError,
  ReportServiceNotConfiguredError,
  pdfContentDisposition,
  renderWorkforceReport,
  reportBranding,
  reportServiceConfigured,
  viewForRole,
  type ReportModel,
} from '@/lib/workforce/report-pdf';

/** PDFs per user per minute (rendering is the expensive part: one Typst run each). */
export const PDF_LIMIT = 6;
const PDF_WINDOW_MS = 60_000;

export function limitPdf(user: Pick<AuthUser, 'id'>, bucket: string): void {
  const r = rateLimit(`wf-pdf:${bucket}:${user.id}`, PDF_LIMIT, PDF_WINDOW_MS);
  if (!r.ok) throw new HttpError(429, `طلبات تقارير كثيرة خلال وقت قصير. أعد المحاولة بعد ${r.retryAfterSeconds} ثانية.`);
}

/** 503 before any computation when radeef-render is not configured (the UI then offers the Excel export). */
export function notConfiguredResponse(): NextResponse {
  return jsonError(503, REPORT_SERVICE_NOT_CONFIGURED, { code: 'REPORT_SERVICE_NOT_CONFIGURED' });
}

export function assertConfigured(): void {
  if (!reportServiceConfigured()) throw new ReportServiceNotConfiguredError();
}

/** Renderer errors -> 503 (not configured / service trouble, retry later) or 422 with the code (bad input). */
export function renderErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof ReportServiceNotConfiguredError) return notConfiguredResponse();
  if (err instanceof RenderError) {
    if (err.retryable) return jsonError(503, REPORT_SERVICE_UNAVAILABLE, { code: err.code });
    return jsonError(422, `تعذر تجهيز التقرير (${err.code})`, { code: err.code });
  }
  return null;
}

/** A view handler's response: its JSON when OK, otherwise the response itself (passed through unchanged). */
export async function viewJson<T>(res: Response): Promise<{ ok: true; body: T } | { ok: false; res: Response }> {
  if (!res.ok) return { ok: false, res };
  return { ok: true, body: (await res.json()) as T };
}

/** In-process request to a view handler: the caller's headers (session cookie, client IP), a new URL / body. */
export function innerRequest(req: Request, pathAndQuery: string, body?: unknown): Request {
  const headers = new Headers(req.headers);
  headers.delete('content-length');
  if (body !== undefined) headers.set('content-type', 'application/json');
  return new Request(new URL(pathAndQuery, 'http://internal.local'), {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Query string of the given params (undefined / '' dropped). */
export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

export async function companyName(companyId: string | null): Promise<string | null> {
  if (!companyId) return null;
  const c = await prisma.company.findUnique({ where: { id: companyId }, select: { nameArabic: true } });
  return c?.nameArabic ?? null;
}

/** Calculation time, whole seconds (= the PDF creation timestamp). */
export function calculationTime(): Date {
  return new Date(Math.floor(Date.now() / 1000) * 1000);
}

/**
 * Renders the model with the letterhead company's branding, writes one EXPORT audit row per PDF (kind,
 * scope, sha256: never throttled) and returns the PDF response.
 */
export async function pdfResponse(opts: {
  req: Request;
  user: Pick<AuthUser, 'id' | 'role'>;
  model: ReportModel;
  brandCompanyId: string | null;
  brandCompanyName: string | null;
  multiCompany: boolean;
  generatedAt: Date;
  entityType: string;
  entityId?: string | null;
  ip: string | null;
}): Promise<Response> {
  const branding = await reportBranding(opts.brandCompanyId, opts.brandCompanyName, opts.multiCompany);
  const out = await renderWorkforceReport(opts.model, branding, opts.generatedAt);
  await logAudit({
    userId: opts.user.id,
    action: 'EXPORT',
    entityType: opts.entityType,
    entityId: opts.entityId ?? null,
    details: { format: 'PDF', kind: opts.model.kind, scope: opts.model.scope, brandCompanyId: opts.brandCompanyId, multiCompany: opts.multiCompany, sha256: out.sha256, bytes: out.pdf.length, generatedAt: opts.generatedAt.toISOString() },
    ipAddress: opts.ip,
  });
  return new Response(new Uint8Array(out.pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(out.pdf.length),
      'Content-Disposition': pdfContentDisposition(out.fileName, out.fileNameAr),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Report-Sha256': out.sha256,
    },
  });
}

export { viewForRole };
