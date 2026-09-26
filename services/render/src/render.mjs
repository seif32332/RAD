// Runs one Typst compilation per request in a private temporary directory.
//
// Flags are the ones validated by the POC (docs/document-engine/POC.md): project root = the
// request's own directory, only the pinned font bundle, no system / embedded fonts, and the
// issuance time as creation timestamp so the same input always gives the same bytes.
// Any output on stderr (warnings included) fails the render: a document is issued exactly as
// written or not at all.
// @ts-check
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { RequestError } from './validate.mjs';

const MAX_STDERR = 16 * 1024;
const MAX_PDF_BYTES = 25 * 1024 * 1024;

/**
 * Bounded concurrency with a bounded wait queue. Beyond both, callers get 503 immediately
 * (the tenant retries through its job queue) instead of piling up memory.
 */
export class Limiter {
  /** @param {number} concurrency @param {number} queue */
  constructor(concurrency, queue) {
    this.concurrency = concurrency;
    this.maxQueue = queue;
    this.active = 0;
    /** @type {Array<() => void>} */
    this.waiting = [];
  }

  /** @template T @param {() => Promise<T>} fn @returns {Promise<T>} */
  async run(fn) {
    if (this.active >= this.concurrency) {
      if (this.waiting.length >= this.maxQueue) throw new RequestError(503, 'BUSY');
      await new Promise((resolve) => this.waiting.push(() => resolve(undefined)));
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next(); // hand the slot over: `active` is unchanged
      else this.active--;
    }
  }

  get queued() {
    return this.waiting.length;
  }
}

/**
 * @typedef {{
 *   typstBin: string,
 *   fontsDir: string,
 *   tmpDir: string,
 *   timeoutMs: number,
 *   jobs: number,
 * }} RenderOptions
 * @typedef {import('./validate.mjs').RenderJob} RenderJob
 */

/** Typst CLI arguments for a job (exported for tests and documentation). */
export function typstArgs(/** @type {RenderJob} */ job, /** @type {RenderOptions} */ opts, /** @type {string} */ dir) {
  return [
    'compile',
    '--root', dir,
    '--font-path', opts.fontsDir,
    '--ignore-system-fonts',
    '--ignore-embedded-fonts',
    '--creation-timestamp', String(job.creationTimestamp),
    '--jobs', String(opts.jobs),
    '--diagnostic-format', 'short',
    ...(job.pdfStandard === 'none' ? [] : ['--pdf-standard', job.pdfStandard]),
    path.join(dir, 'main.typ'),
    path.join(dir, 'out.pdf'),
  ];
}

/** Exclusive create (never follows or overwrites anything), owner-only. */
async function writeNew(file, data) {
  const fh = await open(file, 'wx', 0o600);
  try {
    await fh.writeFile(data);
  } finally {
    await fh.close();
  }
}

/**
 * @param {RenderJob} job
 * @param {RenderOptions} opts
 * @returns {Promise<{ pdf: Buffer, sha256: string, ms: number }>}
 */
export async function renderPdf(job, opts) {
  const started = performance.now();
  const dir = await mkdtemp(path.join(opts.tmpDir, 'job-'));
  try {
    for (const [name, buf] of job.template) await writeNew(path.join(dir, name), buf);
    for (const [name, buf] of job.assets) await writeNew(path.join(dir, name), buf);
    await writeNew(path.join(dir, 'data.json'), job.dataJson);

    const { code, signal, stderr, timedOut } = await runTypst(opts.typstBin, typstArgs(job, opts, dir), dir, opts.timeoutMs);
    if (timedOut) throw new RequestError(504, 'RENDER_TIMEOUT');
    if (signal) throw new RequestError(500, 'RENDERER_CRASHED', signal);
    // Diagnostics quote the template, which the caller owns; they are returned, never logged.
    if (code !== 0) throw new RequestError(422, 'TEMPLATE_ERROR', stderr.trim());
    if (stderr.trim()) throw new RequestError(422, 'RENDER_WARNING', stderr.trim());

    const out = path.join(dir, 'out.pdf');
    const { size } = await stat(out);
    if (size > MAX_PDF_BYTES) throw new RequestError(500, 'PDF_TOO_LARGE');
    const pdf = await readFile(out);
    if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new RequestError(500, 'INVALID_OUTPUT');
    return { pdf, sha256: createHash('sha256').update(pdf).digest('hex'), ms: performance.now() - started };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * @param {string} bin @param {string[]} args @param {string} cwd @param {number} timeoutMs
 * @returns {Promise<{ code: number | null, signal: NodeJS.Signals | null, stderr: string, timedOut: boolean }>}
 */
export function runTypst(bin, args, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    // Empty environment: nothing of the service (token, paths) reaches Typst, and no TYPST_*
    // variable can change its behaviour. HOME points into the job dir (no package cache).
    // Own process group (detached = setsid): a timeout kills the whole group, so nothing the
    // binary may have started survives or keeps the stderr pipe open.
    const child = spawn(bin, args, {
      cwd,
      env: { HOME: cwd, LANG: 'C.UTF-8', TZ: 'UTC' },
      stdio: ['ignore', 'ignore', 'pipe'],
      shell: false,
      detached: true,
      windowsHide: true,
    });
    let stderr = '';
    let timedOut = false;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      if (stderr.length < MAX_STDERR) stderr += chunk.slice(0, MAX_STDERR - stderr.length);
    });
    const killGroup = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL'); // group already gone, or no process groups on this platform
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    // After a timeout, answer as soon as the process is gone; otherwise wait for 'close' so the
    // whole of stderr has been read.
    child.on('exit', () => {
      if (timedOut) resolve({ code: null, signal: null, stderr, timedOut: true });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (!timedOut) resolve({ code, signal, stderr, timedOut: false });
    });
  });
}

/** Version line of the binary, e.g. "typst 0.15.1 (…)". */
export async function typstVersion(bin) {
  const { stdout } = await new Promise((resolve, reject) => {
    const child = spawn(bin, ['--version'], { env: { LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve({ stdout: out }) : reject(new Error(`${bin} --version exited ${code}`))));
  });
  return String(stdout).trim();
}

/** SHA-256 of a file (the pinned Typst binary). */
export async function fileSha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

