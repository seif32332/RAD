// DocumentRenderer (ADR DOC-01): the engine's only contact with the PDF renderer. Today the
// radeef-render service (Typst 0.15.1, services/render). Nothing outside this file knows Typst.
import 'server-only';
import { sha256Hex } from './core';

export interface RenderInput {
  templateRef: string;
  template: Record<string, Buffer>;
  data: unknown; // render model
  assets: Record<string, Buffer>;
  creationTimestamp: number; // seconds; = issuedAt (determinism)
  pdfStandard: 'a-2b';
}

export interface RenderOutput {
  pdf: Buffer;
  pdfSha256: string;
  rendererId: 'typst';
  rendererVersion: string;
  typstSha256: string;
  fontsSha256: string;
}

/** Renderer failures. `retryable` separates service trouble (retry later) from bad input. */
export class RenderError extends Error {
  constructor(message: string, readonly code: string, readonly retryable: boolean, readonly detail?: unknown) {
    super(message);
  }
}

export interface DocumentRenderer {
  readonly id: 'typst';
  render(input: RenderInput): Promise<RenderOutput>;
}

const b64 = (m: Record<string, Buffer>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.toString('base64')]));

export function renderServiceConfig(): { url: string; token: string } | null {
  const url = process.env.RENDER_SERVICE_URL?.trim();
  const token = process.env.RENDER_SERVICE_TOKEN?.trim();
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ''), token };
}

/** HTTP client for radeef-render (POST /render). */
export function typstServiceRenderer(config = renderServiceConfig(), timeoutMs = 30_000): DocumentRenderer {
  return {
    id: 'typst',
    async render(input) {
      if (!config) throw new RenderError('خدمة إصدار المستندات غير مهيأة (RENDER_SERVICE_URL)', 'RENDERER_NOT_CONFIGURED', true);
      let res: Response;
      try {
        res = await fetch(`${config.url}/render`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            templateRef: input.templateRef,
            template: b64(input.template),
            data: input.data,
            assets: b64(input.assets),
            creationTimestamp: input.creationTimestamp,
            pdfStandard: input.pdfStandard,
          }),
          signal: AbortSignal.timeout(timeoutMs),
          cache: 'no-store',
        });
      } catch (err) {
        throw new RenderError('تعذر الاتصال بخدمة إصدار المستندات', 'RENDERER_UNAVAILABLE', true, err instanceof Error ? err.message : undefined);
      }
      if (!res.ok) {
        let body: { error?: string; detail?: unknown } = {};
        try {
          body = await res.json();
        } catch {
          /* non-JSON error */
        }
        const code = body.error ?? `HTTP_${res.status}`;
        // 5xx / 503 BUSY / 504 timeout: the service's trouble, retry. 4xx: the input is wrong.
        const retryable = res.status >= 500 || res.status === 429;
        const message = code === 'UNSUPPORTED_CHARACTERS'
          ? 'بعض الأحرف في بيانات المستند غير مدعومة في خط المستندات'
          : retryable ? 'خدمة إصدار المستندات غير متاحة حالياً' : 'تعذر تجهيز المستند';
        throw new RenderError(message, code, retryable, body.detail);
      }
      const pdf = Buffer.from(await res.arrayBuffer());
      const pdfSha256 = sha256Hex(pdf);
      // The service states the hash it produced; a mismatch means corruption in transit.
      if (res.headers.get('x-pdf-sha256') !== pdfSha256) throw new RenderError('بصمة المستند لا تطابق ما أعلنته الخدمة', 'PDF_HASH_MISMATCH', true);
      if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new RenderError('مخرجات غير صالحة من خدمة المستندات', 'INVALID_OUTPUT', true);
      return {
        pdf,
        pdfSha256,
        rendererId: 'typst',
        rendererVersion: res.headers.get('x-renderer-version') ?? 'unknown',
        typstSha256: res.headers.get('x-typst-sha256') ?? 'unknown',
        fontsSha256: res.headers.get('x-fonts-sha256') ?? 'unknown',
      };
    },
  };
}
