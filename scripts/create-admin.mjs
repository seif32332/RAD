#!/usr/bin/env node
/**
 * Create a user or reset an existing user's password.
 *
 *   npm run admin:create -- <email> [--role SUPER_ADMIN] [--name "الاسم"]
 *   node scripts/create-admin.mjs <email> [--role SUPER_ADMIN] [--name "الاسم"]
 *
 * Password source:
 *   - env NEW_ADMIN_PASSWORD when set (must satisfy the app policy: >= 8 chars, a letter and a digit);
 *   - otherwise a random 16-character password is generated and printed ONCE to stdout.
 *
 * Behaviour:
 *   - New e-mail  -> creates an active user with the given role (default SUPER_ADMIN). One of two flags is
 *                    REQUIRED (BL-PAY-005, pay-to-be.md BR-PAY-005 "التمهيد"):
 *                      --vendor-staff     a Radeef staff account: isVendorStaff=true, identityStatus=VENDOR_BOOTSTRAP
 *                                         (never an approver, never attested);
 *                      --customer-admin   the first admin handed to the customer: isVendorStaff=false,
 *                                         identityStatus=VENDOR_BOOTSTRAP (recorded). He counts as an attested
 *                                         person only once Radeef marks the tenant root (BL-PAY-017) or the
 *                                         root's chain attests him.
 *   - Existing    -> resets the password and re-activates the account. The role is changed only
 *                    when --role is passed explicitly. Linked employee profile is untouched.
 *                    Every session ends. A non-vendor account loses its attestation (identityStatus=UNATTESTED,
 *                    until another attested admin attests it again; a root's powers are suspended until
 *                    Radeef re-confirms him); a one-time credential link issued before stops working.
 *
 * Environment: DATABASE_URL (or ./.env). bcrypt cost 12, same as the login route.
 */
import { randomInt } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const BCRYPT_COST = 12;
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
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function usage(msg) {
  if (msg) console.error(`Error: ${msg}\n`);
  console.error('Usage: node scripts/create-admin.mjs <email> (--vendor-staff | --customer-admin) [--role <ROLE>] [--name <display name>]');
  console.error('  --vendor-staff / --customer-admin: required when the account is new (BL-PAY-005).');
  console.error(`Roles: ${ROLES.join(', ')}`);
  console.error('Password: env NEW_ADMIN_PASSWORD, or a random one is generated and printed once.');
  process.exit(2);
}

function parseArgs(argv) {
  const out = { email: '', role: undefined, name: undefined, kind: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') usage();
    else if (a === '--vendor-staff' || a === '--customer-admin') {
      if (out.kind && out.kind !== a) usage('pass only one of --vendor-staff / --customer-admin');
      out.kind = a;
    }
    else if (a === '--role') out.role = argv[++i];
    else if (a.startsWith('--role=')) out.role = a.slice('--role='.length);
    else if (a === '--name') out.name = argv[++i];
    else if (a.startsWith('--name=')) out.name = a.slice('--name='.length);
    else if (a.startsWith('--')) usage(`unknown option ${a}`);
    else if (!out.email) out.email = a;
    else usage(`unexpected argument ${a}`);
  }
  if (!out.email) usage('email is required');
  out.email = out.email.trim().toLowerCase();
  if (!EMAIL_RE.test(out.email)) usage('invalid email');
  if (out.role !== undefined) {
    out.role = String(out.role).trim().toUpperCase();
    if (!ROLES.includes(out.role)) usage(`invalid role "${out.role}"`);
  }
  if (out.name !== undefined) out.name = String(out.name).trim() || undefined;
  return out;
}

/** Mirrors zPassword in src/lib/validation.ts. */
function passwordProblem(pw) {
  if (pw.length < 8) return 'must be at least 8 characters';
  if (pw.length > 128) return 'must be at most 128 characters';
  if (!/[A-Za-z]/.test(pw)) return 'must contain a letter';
  if (!/\d/.test(pw)) return 'must contain a digit';
  return null;
}

/** 16 chars from an unambiguous alphabet, guaranteed to contain upper, lower and digit. */
function generatePassword(length = 16) {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const all = upper + lower + digits;
  const pick = (set) => set[randomInt(set.length)];
  const chars = [pick(upper), pick(lower), pick(digits)];
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

function loadDotEnv() {
  try {
    if (typeof process.loadEnvFile === 'function') process.loadEnvFile('.env');
  } catch {
    // No .env file — rely on the process environment.
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadDotEnv();
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set (export it or put it in .env)');

  const fromEnv = process.env.NEW_ADMIN_PASSWORD;
  const generated = !fromEnv;
  const password = fromEnv ?? generatePassword();
  const problem = passwordProblem(password);
  if (problem) throw new Error(`NEW_ADMIN_PASSWORD ${problem}`);

  const prisma = new PrismaClient();
  try {
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    const existing = await prisma.user.findFirst({
      where: { email: { equals: args.email, mode: 'insensitive' } },
      select: { id: true, email: true, role: true },
    });

    let userId;
    let summary;
    if (existing) {
      const identity = await prisma.user.findUnique({
        where: { id: existing.id },
        select: { isVendorStaff: true, identityStatus: true, tenantRoot: true, rootSuspendedAt: true },
      });
      const data = { passwordHash, isActive: true, sessionVersion: { increment: 1 } };
      if (args.role) data.role = args.role;
      if (args.name) data.name = args.name;
      // BL-PAY-005: a reset of a non-vendor account suspends its eligibility as an approver until another
      // attested admin attests it again (a root's powers until Radeef re-confirms him, RT-PAY-1004).
      if (!identity.isVendorStaff) {
        const counted = identity.identityStatus !== 'UNATTESTED' || identity.tenantRoot;
        data.identityStatus = 'UNATTESTED';
        if (counted) {
          data.identityDroppedReason = 'CREDENTIAL_RESET';
          data.identityDroppedAt = new Date();
        }
        if (identity.tenantRoot && !identity.rootSuspendedAt) data.rootSuspendedAt = new Date();
      }
      // A one-time credential link issued before this reset stops working by itself: it is bound to the
      // credentials it was issued for (CredentialToken.credentialFingerprint).
      await prisma.user.update({ where: { id: existing.id }, data });
      userId = existing.id;
      summary = `Password reset for ${existing.email} (role: ${args.role ?? existing.role}, active${identity.isVendorStaff ? ', vendor staff' : ', identity UNATTESTED'}).`;
    } else {
      if (!args.kind) usage('a new account needs --vendor-staff or --customer-admin (BL-PAY-005)');
      const role = args.role ?? 'SUPER_ADMIN';
      const isVendorStaff = args.kind === '--vendor-staff';
      const user = await prisma.user.create({
        data: {
          email: args.email,
          passwordHash,
          role,
          isActive: true,
          name: args.name ?? null,
          // BL-PAY-005: a vendor script writes both explicitly (never left to the column defaults).
          isVendorStaff,
          identityStatus: 'VENDOR_BOOTSTRAP',
        },
        select: { id: true },
      });
      userId = user.id;
      summary = `Created ${args.email} with role ${role} (${isVendorStaff ? 'Radeef staff' : 'customer first admin'}, identity VENDOR_BOOTSTRAP).`;
    }

    try {
      await prisma.auditLog.create({
        data: {
          userId: null,
          action: existing ? 'PASSWORD_RESET' : 'CREATE',
          entityType: 'User',
          entityId: userId,
          details: JSON.stringify({ source: 'scripts/create-admin.mjs', role: args.role ?? null, kind: existing ? 'reset' : args.kind }),
          ipAddress: 'cli',
        },
      });
    } catch {
      // Audit logging must never block an admin recovery.
    }

    console.log(summary);
    if (generated) {
      console.log('\nGenerated password (shown only once — store it securely and change it after first login):');
      console.log(password);
    } else {
      console.log('Password taken from NEW_ADMIN_PASSWORD.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('create-admin FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
