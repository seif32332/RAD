// Outgoing e-mail (SMTP via nodemailer).
//
// Configuration (env): SMTP_HOST, SMTP_PORT (default 587), SMTP_SECURE ('true' for 465),
// SMTP_USER, SMTP_PASS, SMTP_FROM (optional display "from").
//
// - One cached transporter per process (rebuilt only if the env config changes).
// - Every network phase is capped at 10s, and sendMail() itself never waits longer than
//   SEND_TIMEOUT_MS, so an unreachable SMTP server can't hang an API response.
// - sendMail() never throws: it returns { sent, reason } so callers can tell the user.
// - Always build HTML bodies with escapeHtml() around every interpolated value.
import 'server-only';
import nodemailer, { type Transporter } from 'nodemailer';

const NETWORK_TIMEOUT_MS = 10_000;
const SEND_TIMEOUT_MS = 12_000;

export type MailFailureReason = 'NOT_CONFIGURED' | 'INVALID_RECIPIENT' | 'TIMEOUT' | 'SEND_FAILED';

export interface MailResult {
  sent: boolean;
  reason?: MailFailureReason;
}

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  /** Plain-text alternative. Derived from the HTML when omitted. */
  text?: string;
  replyTo?: string;
}

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
}

/** Reads the SMTP config from env, or null when it is incomplete. */
export function getSmtpConfig(env: NodeJS.ProcessEnv = process.env): SmtpConfig | null {
  const host = env.SMTP_HOST?.trim();
  const user = env.SMTP_USER?.trim();
  const pass = env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  const parsedPort = Number.parseInt(env.SMTP_PORT || '', 10);
  const port = Number.isFinite(parsedPort) && parsedPort > 0 && parsedPort < 65536 ? parsedPort : 587;
  const secure = env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465;
  const from = env.SMTP_FROM?.trim() || `"نظام رديف" <${user}>`;
  return { host, port, secure, user, pass, from };
}

export function isMailConfigured(): boolean {
  return getSmtpConfig() !== null;
}

let cached: { key: string; transporter: Transporter } | null = null;

function getTransporter(cfg: SmtpConfig): Transporter {
  const key = `${cfg.host}|${cfg.port}|${cfg.secure}|${cfg.user}|${cfg.pass}`;
  if (cached && cached.key === key) return cached.transporter;
  cached?.transporter.close();
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: NETWORK_TIMEOUT_MS,
    greetingTimeout: NETWORK_TIMEOUT_MS,
    socketTimeout: NETWORK_TIMEOUT_MS,
  });
  cached = { key, transporter };
  return transporter;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

/** Escapes a value for safe interpolation into HTML text or a quoted attribute. */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"'`]/g, (c) => HTML_ESCAPES[c] ?? c);
}

/** Removes CR/LF so a value can't inject extra headers (e.g. in the subject). */
export function sanitizeHeader(value: string, max = 200): string {
  return value.replace(/[\r\n]+/g, ' ').trim().slice(0, max);
}

const SIMPLE_EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;

export function isValidEmail(value: string | null | undefined): value is string {
  return !!value && value.length <= 200 && SIMPLE_EMAIL.test(value.trim());
}

/** Rough plain-text version of an HTML body. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#96;/g, '`')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/** Sends one e-mail. Never throws; resolves within ~SEND_TIMEOUT_MS. */
export async function sendMail(message: MailMessage): Promise<MailResult> {
  const cfg = getSmtpConfig();
  if (!cfg) {
    console.warn('[mailer] SMTP is not configured (SMTP_HOST/SMTP_USER/SMTP_PASS); e-mail not sent.');
    return { sent: false, reason: 'NOT_CONFIGURED' };
  }
  if (!isValidEmail(message.to)) return { sent: false, reason: 'INVALID_RECIPIENT' };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<MailResult>((resolve) => {
    timer = setTimeout(() => resolve({ sent: false, reason: 'TIMEOUT' }), SEND_TIMEOUT_MS);
  });

  const send = (async (): Promise<MailResult> => {
    try {
      await getTransporter(cfg).sendMail({
        from: cfg.from,
        to: message.to.trim(),
        subject: sanitizeHeader(message.subject),
        html: message.html,
        text: message.text ?? htmlToText(message.html),
        replyTo: message.replyTo,
      });
      return { sent: true };
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? String((err as { code?: unknown }).code) : '';
      console.error('[mailer] failed to send e-mail:', code || (err instanceof Error ? err.name : 'unknown error'));
      return { sent: false, reason: code === 'ETIMEDOUT' ? 'TIMEOUT' : 'SEND_FAILED' };
    }
  })();

  try {
    const result = await Promise.race([send, timeout]);
    if (result.reason === 'TIMEOUT') console.warn('[mailer] e-mail send timed out');
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
