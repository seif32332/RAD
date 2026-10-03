'use strict';
/**
 * TENANT_ROOT, the owner's named people and contact, and the ROOT_ATTEST_OWN code (BL-PAY-017 / BL-PAY-022;
 * pay-to-be.md BR-PAY-005, DEC-PO-016 / 018 / 022). The panel never touches a tenant database for these: it runs
 * the tenant's own vendor CLI (scripts/vendor.mjs → iam's vendor operations through money.gateway, audited) over
 * SSH inside the tenant's app directory, with ONE JSON request on stdin (never on the command line: it can carry
 * a national id) and ONE JSON line back.
 *
 * Every write needs the reference of the owner's formal request (requestRef); root changes, suspension and a
 * revocation also need the tenant name typed again (confirm). A submission carries a requestId: the same id is
 * the same operation on the tenant (a retry replays it, never runs twice).
 */
const crypto = require('crypto');
const V = require('./validate');

class IdentityError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'IdentityError';
    this.status = status;
  }
}

const ROLES = [
  'SUPER_ADMIN',
  'COMPANY_ADMIN',
  'HR_MANAGER',
  'FINANCE_MANAGER',
  'PAYROLL_ADMIN',
  'GOV_RELATIONS',
  'LEGAL_ADMIN',
  'BRANCH_MANAGER',
  'EMPLOYEE',
  'DEPT_MANAGER',
  'PURCHASING_AGENT',
];

/** command -> the fields it takes, and whether the tenant name must be typed again. */
const COMMANDS = Object.freeze({
  'set-root': { fields: ['email', 'replaceCurrent'], confirm: true },
  'suspend-root': { fields: ['reason'], confirm: true },
  'register-person': { fields: ['email', 'nationalId', 'name'] },
  'revoke-person': { fields: ['email'], confirm: true },
  'link-person': { fields: ['email'] },
  'invite-person': { fields: ['email', 'role', 'name', 'linkHours'] },
  'set-owner-contact': { fields: ['email', 'mobile', 'name'] },
  'release-code': { fields: ['email'] },
});
const WRITE_COMMANDS = Object.keys(COMMANDS);

function singleLine(value, label, { min = 0, max = 200 } = {}) {
  const t = String(value ?? '').trim();
  if (/[\r\n\0]/.test(t)) throw new IdentityError(`${label}: سطر واحد فقط`);
  if (t.length < min || t.length > max) throw new IdentityError(`${label}: من ${min} إلى ${max} حرفاً`);
  return t;
}

function field(name, value) {
  switch (name) {
    case 'email':
      return V.validateEmail(value).toLowerCase();
    case 'nationalId': {
      const id = String(value ?? '').replace(/[\s-]/g, '').toUpperCase();
      if (!/^(?:[12][0-9]{9}|[A-Z0-9]{6,20})$/.test(id)) throw new IdentityError('رقم الهوية أو الإقامة غير صالح');
      return id;
    }
    case 'name':
      return value == null || value === '' ? null : singleLine(value, 'الاسم', { min: 1, max: 200 });
    case 'mobile': {
      if (value == null || value === '') return null;
      const m = String(value).replace(/[\s-]/g, '');
      if (!/^\+?[0-9]{8,15}$/.test(m)) throw new IdentityError('رقم الجوال غير صالح');
      return m;
    }
    case 'role': {
      const r = String(value ?? '').trim().toUpperCase();
      if (!ROLES.includes(r)) throw new IdentityError('الدور غير صالح');
      return r;
    }
    case 'reason':
      return singleLine(value, 'السبب', { min: 5, max: 500 });
    case 'replaceCurrent':
      return value === true;
    case 'linkHours': {
      if (value == null || value === '') return 72;
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1 || n > 72) throw new IdentityError('مدة صلاحية الرابط من 1 إلى 72 ساعة');
      return n;
    }
    default:
      throw new IdentityError('حقل غير معروف');
  }
}

/**
 * Validates a panel submission and builds the tenant request (pure). body: { name, command, requestRef, confirm,
 * requestId?, …fields }; `name` is the tenant, a person's display name is `personName`. operator: the panel user. Returns { tenant, request }.
 */
function buildVendorRequest(body, operator) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const tenant = V.validateExistingName(b.name);
  const command = String(b.command ?? '');
  const spec = COMMANDS[command];
  if (!spec) throw new IdentityError('إجراء غير صالح');
  if (!/^[A-Za-z0-9._@-]{1,64}$/.test(String(operator ?? ''))) throw new IdentityError('مشغّل غير صالح', 500);
  const requestRef = singleLine(b.requestRef, 'مرجع الطلب الرسمي من المالك', { min: 3, max: 200 });
  if (spec.confirm && b.confirm !== tenant) throw new IdentityError('اكتب اسم النسخة بالضبط لتأكيد هذا الإجراء');
  const requestId = b.requestId == null || b.requestId === '' ? crypto.randomBytes(16).toString('hex') : String(b.requestId);
  if (!/^[a-f0-9]{32}$/.test(requestId)) throw new IdentityError('requestId غير صالح');
  const request = { command, operator, requestId, requestRef };
  for (const f of spec.fields) {
    const optionalEmail = f === 'email' && command === 'set-owner-contact' && (b.email == null || b.email === '');
    // The panel body's `name` is the tenant; the person's (or owner's) display name comes as `personName`.
    request[f] = optionalEmail ? null : field(f, f === 'name' ? b.personName : b[f]);
  }
  if (command === 'set-owner-contact' && !request.email && !request.mobile) throw new IdentityError('بريد المالك أو جواله مطلوب');
  return { tenant, request };
}

/** The status request (read only). */
function statusRequest(operator) {
  return { command: 'status', operator, requestId: '', requestRef: '' };
}

/** The remote command: the tenant's own CLI with the tenant's own environment (no value interpolated but the path). */
function remoteCommand(appDir) {
  const dir = V.validateSafePath(appDir, 'app dir');
  return `cd ${V.shq(dir)} && set -a && . ./.env && set +a && node scripts/vendor.mjs`;
}

/** The CLI's answer: the last non-empty stdout line, as JSON. */
function parseVendorReply(stdout) {
  const lines = String(stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) throw new IdentityError('لم يرد أمر رديف على السيرفر بأي نتيجة', 502);
  let reply;
  try {
    reply = JSON.parse(last);
  } catch {
    throw new IdentityError('رد غير مفهوم من أمر رديف على السيرفر', 502);
  }
  if (!reply || typeof reply !== 'object') throw new IdentityError('رد غير مفهوم من أمر رديف على السيرفر', 502);
  return reply;
}

/**
 * Runs one request on the tenant host. exec(conn, cmd, { stdin, allowFail, label, timeoutMs }) is lib/ssh.js's
 * exec (injected so this file needs no SSH package to be tested). Returns the result or throws IdentityError.
 */
async function runVendorCommand({ exec, conn, appDir, request }) {
  const { code, stdout } = await exec(conn, remoteCommand(appDir), {
    stdin: `${JSON.stringify(request)}\n`,
    allowFail: true,
    label: `vendor ${request.command}`,
    timeoutMs: 2 * 60 * 1000,
  });
  const reply = parseVendorReply(stdout);
  if (reply.ok === true && code === 0) return reply.result;
  const status = Number.isInteger(reply.status) && reply.status >= 400 && reply.status < 600 ? reply.status : 502;
  throw new IdentityError(status < 500 && typeof reply.error === 'string' ? reply.error : 'فشل أمر رديف على السيرفر', status);
}

module.exports = { IdentityError, COMMANDS, WRITE_COMMANDS, ROLES, buildVendorRequest, statusRequest, remoteCommand, parseVendorReply, runVendorCommand };
