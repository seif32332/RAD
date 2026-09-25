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
 *   - New e-mail  -> creates an active user with the given role (default SUPER_ADMIN).
 *   - Existing    -> resets the password and re-activates the account. The role is changed only
 *                    when --role is passed explicitly. Linked employee profile is untouched.
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
  console.error('Usage: node scripts/create-admin.mjs <email> [--role <ROLE>] [--name <display name>]');
  console.error(`Roles: ${ROLES.join(', ')}`);
  console.error('Password: env NEW_ADMIN_PASSWORD, or a random one is generated and printed once.');
  process.exit(2);
}

function parseArgs(argv) {
  const out = { email: '', role: undefined, name: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') usage();
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
      const data = { passwordHash, isActive: true };
      if (args.role) data.role = args.role;
      if (args.name) data.name = args.name;
      await prisma.user.update({ where: { id: existing.id }, data });
      userId = existing.id;
      summary = `Password reset for ${existing.email} (role: ${args.role ?? existing.role}, active).`;
    } else {
      const role = args.role ?? 'SUPER_ADMIN';
      const user = await prisma.user.create({
        data: { email: args.email, passwordHash, role, isActive: true, name: args.name ?? null },
        select: { id: true },
      });
      userId = user.id;
      summary = `Created ${args.email} with role ${role}.`;
    }

    try {
      await prisma.auditLog.create({
        data: {
          userId: null,
          action: existing ? 'PASSWORD_RESET' : 'CREATE',
          entityType: 'User',
          entityId: userId,
          details: JSON.stringify({ source: 'scripts/create-admin.mjs', role: args.role ?? null }),
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
