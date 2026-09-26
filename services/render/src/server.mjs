// HTTP surface of radeef-render.
//
//   GET  /health  -> 200 { status, typst, fontsSha256, busy, queued }        (no auth, no secrets)
//   POST /render  -> 200 application/pdf                                     (Bearer token)
//                    X-Renderer: typst, X-Renderer-Version, X-Typst-Sha256, X-Fonts-Sha256,
//                    X-Pdf-Sha256, X-Request-Id
//                 -> 4xx/5xx application/json { error: CODE, detail?, requestId }
//
// Logs are one JSON line per request with sizes, timings and error codes only: never the body,
// never Typst diagnostics (they quote the caller's template and data).
// @ts-check
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { Limiter, renderPdf } from './render.mjs';
import { RequestError, validateRenderRequest } from './validate.mjs';

/**
 * @typedef {{
 *   token: string,
 *   maxBodyBytes: number,
 *   limiter: Limiter,
 *   renderOptions: import('./render.mjs').RenderOptions,
 *   fonts: import('./fonts.mjs').FontBundle,
 *   typst: { version: string, sha256: string },
 *   log?: (entry: Record<string, unknown>) => void,
 * }} ServerContext
 */

/** Constant-time comparison of two secrets of any length (compares their digests). */
export function sameSecret(a, b) {
  const da = createHash('sha256').update(a).digest();
  const db = createHash('sha256').update(b).digest();
  return timingSafeEqual(da, db) && a.length === b.length;
}

/** Reads the body up to `limit` bytes; 413 as soon as it is exceeded. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      reject(new RequestError(413, 'BODY_TOO_LARGE', { limit }));
      req.resume();
      return;
    }
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new RequestError(413, 'BODY_TOO_LARGE', { limit }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** @param {http.ServerResponse} res @param {number} status @param {unknown} body @param {Record<string, string>} [headers] */
function sendJson(res, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length, ...headers });
  res.end(payload);
  return payload.length;
}

/** @param {ServerContext} ctx */
export function createServer(ctx) {
  const log = ctx.log ?? ((e) => process.stdout.write(JSON.stringify(e) + '\n'));

  const server = http.createServer(async (req, res) => {
    const started = performance.now();
    const requestId = randomUUID();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const common = { 'X-Request-Id': requestId, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    /** @type {Record<string, unknown>} */
    const entry = { ts: new Date().toISOString(), requestId, method: req.method, path: url.pathname };
    let status = 500;
    let bytesOut = 0;
    try {
      if (url.pathname === '/health') {
        if (req.method !== 'GET') throw new RequestError(405, 'METHOD_NOT_ALLOWED');
        status = 200;
        bytesOut = sendJson(res, 200, {
          status: 'ok',
          typst: ctx.typst,
          fontsSha256: ctx.fonts.bundleSha256,
          busy: ctx.limiter.active,
          queued: ctx.limiter.queued,
          concurrency: ctx.limiter.concurrency,
        }, common);
        return;
      }
      if (url.pathname !== '/render') throw new RequestError(404, 'NOT_FOUND');
      if (req.method !== 'POST') throw new RequestError(405, 'METHOD_NOT_ALLOWED');

      const auth = req.headers.authorization ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!token || !sameSecret(token, ctx.token)) throw new RequestError(401, 'UNAUTHORIZED');

      const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (type !== 'application/json') throw new RequestError(415, 'UNSUPPORTED_MEDIA_TYPE');

      const raw = await readBody(req, ctx.maxBodyBytes);
      entry.bytesIn = raw.length;
      let body;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        throw new RequestError(400, 'INVALID_JSON');
      }
      const job = validateRenderRequest(body, ctx.fonts.coverage);
      entry.templateRef = job.templateRef;

      const { pdf, sha256, ms } = await ctx.limiter.run(() => renderPdf(job, ctx.renderOptions));
      entry.renderMs = Math.round(ms);
      status = 200;
      res.writeHead(200, {
        ...common,
        'Content-Type': 'application/pdf',
        'Content-Length': pdf.length,
        'X-Renderer': 'typst',
        'X-Renderer-Version': ctx.typst.version,
        'X-Typst-Sha256': ctx.typst.sha256,
        'X-Fonts-Sha256': ctx.fonts.bundleSha256,
        'X-Pdf-Sha256': sha256,
      });
      res.end(pdf);
      bytesOut = pdf.length;
    } catch (err) {
      if (err instanceof RequestError) {
        status = err.status;
        entry.error = err.code;
        const headers = status === 503 ? { ...common, 'Retry-After': '2' } : common;
        if (!res.headersSent) bytesOut = sendJson(res, status, { error: err.code, detail: err.detail, requestId }, headers);
      } else {
        status = 500;
        entry.error = 'INTERNAL';
        entry.cause = err instanceof Error ? err.message.slice(0, 200) : 'unknown';
        if (!res.headersSent) bytesOut = sendJson(res, 500, { error: 'INTERNAL', requestId }, common);
      }
    } finally {
      log({ ...entry, status, bytesOut, ms: Math.round(performance.now() - started) });
    }
  });

  // Slow or stuck clients cannot hold sockets: headers in 10 s, the whole request in 60 s.
  server.headersTimeout = 10_000;
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  return server;
}
