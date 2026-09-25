'use strict';
/**
 * Input validation + shell/SQL quoting helpers shared by server.js and cli.js.
 *
 * EVERY value that ends up in a remote shell command must be validated with one of the
 * validators below AND quoted with shq(). Every identifier that ends up in SQL must go through
 * sqlIdent() and every literal through sqlLiteral().
 */
const crypto = require('crypto');

/** New tenant names: lower-case letter first, then lower-case letters, digits or '-'. */
const TENANT_NAME_RE = /^[a-z][a-z0-9-]{1,29}$/;
/** Names of processes that already exist on the server (legacy tenants may use '_' or capitals). */
const EXISTING_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Fully-qualified domain name (lower-case, at least one dot, no trailing dot). */
const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
/** PostgreSQL database / role names we create or accept. */
const PG_NAME_RE = /^[A-Za-z0-9_-]{1,63}$/;
/** Absolute POSIX path made of safe characters only. */
const SAFE_PATH_RE = /^\/[A-Za-z0-9._\/-]+$/;
const EMAIL_RE = /^[^\s@"'`\\<>]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

function fail(message) {
  throw new ValidationError(message);
}

/** POSIX single-quote a shell argument: abc'd -> 'abc'\''d'. */
function shq(value) {
  const s = String(value);
  if (s.includes('\0')) fail('Invalid character in shell argument');
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Quote a PostgreSQL identifier (after validating it). */
function sqlIdent(name) {
  const s = String(name);
  if (!PG_NAME_RE.test(s)) fail('Invalid database identifier');
  return `"${s.replace(/"/g, '""')}"`;
}

/** Quote a PostgreSQL string literal. */
function sqlLiteral(value) {
  const s = String(value);
  if (s.includes('\0')) fail('Invalid character in SQL literal');
  return `'${s.replace(/'/g, "''")}'`;
}

function asTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validateTenantName(value) {
  const s = asTrimmedString(value);
  if (!TENANT_NAME_RE.test(s)) {
    fail('اسم النسخة غير صالح: يجب أن يبدأ بحرف إنجليزي صغير ويحتوي على حروف صغيرة وأرقام و - فقط (2-30 حرفاً)');
  }
  return s;
}

function validateExistingName(value) {
  const s = asTrimmedString(value);
  if (!EXISTING_NAME_RE.test(s)) fail('اسم النسخة غير صالح');
  return s;
}

function validateDomain(value) {
  const s = asTrimmedString(value).toLowerCase();
  if (!DOMAIN_RE.test(s)) fail('النطاق غير صالح (مثال: client.radeef-sa.com)');
  return s;
}

function validateEmail(value) {
  const s = asTrimmedString(value).toLowerCase();
  if (!EMAIL_RE.test(s) || s.length > 254) fail('البريد الإلكتروني غير صالح');
  return s;
}

function validateMonths(value) {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(n) || n < 1 || n > 60) fail('مدة الاشتراك يجب أن تكون بين 1 و 60 شهراً');
  return n;
}

/** YYYY-MM-DD that is a real calendar date. */
function validateDateKey(value) {
  const s = asTrimmedString(value);
  if (!DATE_RE.test(s)) fail('التاريخ غير صالح (YYYY-MM-DD)');
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) fail('التاريخ غير صالح');
  return s;
}

/** Optional date: '' / null / undefined -> null (no automatic expiry). */
function validateOptionalDateKey(value) {
  if (value === null || value === undefined || asTrimmedString(value) === '') return null;
  return validateDateKey(value);
}

function validatePgName(value) {
  const s = String(value ?? '');
  if (!PG_NAME_RE.test(s)) fail('اسم قاعدة البيانات غير صالح');
  return s;
}

/** Absolute path with safe characters, no '..' segments, not '/' itself. */
function validateSafePath(value, label = 'path') {
  const s = String(value ?? '').replace(/\/+$/, '');
  if (!SAFE_PATH_RE.test(s) || s.split('/').some((seg) => seg === '..' || seg === '.')) {
    fail(`Invalid ${label}`);
  }
  if (s.split('/').filter(Boolean).length < 1) fail(`Invalid ${label}`);
  return s;
}

/**
 * Guard for anything passed to `rm -rf`: must be a safe absolute path at least two levels deep
 * whose last segment is exactly the tenant name.
 */
function assertDeletableTenantPath(p, name) {
  const s = validateSafePath(p, 'tenant path');
  const segments = s.split('/').filter(Boolean);
  if (segments.length < 2 || segments[segments.length - 1] !== name) {
    fail(`Refusing to delete unexpected path: ${s}`);
  }
  const forbidden = ['/', '/root', '/home', '/etc', '/var', '/var/lib', '/usr', '/opt', '/srv', '/bin', '/boot'];
  if (forbidden.includes(s)) fail(`Refusing to delete protected path: ${s}`);
  return s;
}

function validateEnvName(name) {
  if (!ENV_NAME_RE.test(name)) fail(`Invalid environment variable name: ${name}`);
  return name;
}

/** A value that is safe to pass on one line of stdin and inside a double-quoted .env value. */
function assertSingleLineSecret(value, label = 'secret') {
  const s = String(value);
  if (/[\r\n\0"$`\\]/.test(s)) fail(`${label} contains unsupported characters`);
  return s;
}

/** Derived per-tenant PostgreSQL names for NEW tenants ('-' is not valid unquoted in SQL). */
function pgNamesFor(name) {
  const base = name.replace(/-/g, '_');
  return { dbName: `${base}_erp`, roleName: `${base}_app` };
}

/** Legacy tenants created their DB unquoted, so PostgreSQL folded it to lower case. */
function legacyDbNameFor(name) {
  return `${name}_erp`.toLowerCase();
}

function randomSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function randomHex(bytes = 24) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** Random initial admin password accepted by prisma/seed.mjs (>= 8 chars, a letter and a digit). */
function randomAdminPassword() {
  for (;;) {
    const pw = crypto.randomBytes(15).toString('base64url');
    if (/[A-Za-z]/.test(pw) && /\d/.test(pw)) return pw;
  }
}

/** Constant-time string comparison (hashes both sides so lengths always match). */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

module.exports = {
  TENANT_NAME_RE,
  EXISTING_NAME_RE,
  DOMAIN_RE,
  PG_NAME_RE,
  SAFE_PATH_RE,
  EMAIL_RE,
  ValidationError,
  fail,
  shq,
  sqlIdent,
  sqlLiteral,
  validateTenantName,
  validateExistingName,
  validateDomain,
  validateEmail,
  validateMonths,
  validateDateKey,
  validateOptionalDateKey,
  validatePgName,
  validateSafePath,
  assertDeletableTenantPath,
  validateEnvName,
  assertSingleLineSecret,
  pgNamesFor,
  legacyDbNameFor,
  randomSecret,
  randomHex,
  randomAdminPassword,
  safeEqual,
};
