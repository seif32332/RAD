#!/usr/bin/env node
/**
 * Radeef HRMS — read-only usage counts per tenant, as JSON, for the owner's pricing / packaging
 * decisions (DEC-007: the billing metric under discussion is the ACTIVE EMPLOYEE).
 *
 *   node --env-file=/etc/radeef/<tenant>.env scripts/tenant-stats.mjs            one tenant (DATABASE_URL)
 *   node scripts/tenant-stats.mjs --env-dir /etc/radeef [--tenant a --tenant b]   every /etc/radeef/*.env
 *
 * Output: one JSON document on stdout:
 *   { generatedAt, tenants: [ { tenant, ok, counts: {...} } | { tenant, ok: false, error } ] }
 *
 * Only COUNTs are read: no names, ID numbers, salaries or any other record content. Every query runs
 * inside a READ ONLY transaction with a 15s statement_timeout and a single pooled connection, so the
 * script can never write, and cannot hold a tenant's pool for long. A tenant that fails (unreachable,
 * older schema) is reported with ok:false and does not stop the others; the exit code is 1 when any
 * tenant failed.
 */
import { PrismaClient } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TENANT_RE = /^[a-z][a-z0-9-]{1,29}$/;

/** Minimal dotenv reader (KEY=value, KEY="value", KEY='value'); the file is never executed. */
export function readEnvValue(text, key) {
  let value = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(raw);
    if (!m || m[1] !== key) continue;
    let v = m[2].trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.endsWith(v[0])) v = v.slice(1, -1);
    value = v;
  }
  return value;
}

/** Force a single pooled connection for this read-only script. */
export function singleConnectionUrl(url) {
  const [base, query = ''] = String(url).split('?');
  const params = query.split('&').filter((p) => p && !/^(connection_limit|pool_timeout)=/.test(p));
  params.push('connection_limit=1', 'pool_timeout=30');
  return `${base}?${params.join('&')}`;
}

/** The last `n` calendar months (Asia/Riyadh) as [{year, month}], newest first, current month included. */
export function lastMonths(n, now = new Date()) {
  const riyadh = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  let y = riyadh.getUTCFullYear();
  let m = riyadh.getUTCMonth() + 1;
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ year: y, month: m });
    m -= 1;
    if (m === 0) {
      m = 12;
      y -= 1;
    }
  }
  return out;
}

export function parseArgs(argv) {
  const out = { envDir: null, tenants: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--env-dir') out.envDir = argv[++i];
    else if (argv[i] === '--tenant') out.tenants.push(argv[++i]);
    else if (argv[i] === '-h' || argv[i] === '--help') out.help = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return out;
}

async function countsFor(url, now = new Date()) {
  const prisma = new PrismaClient({ datasources: { db: { url: singleConnectionUrl(url) } } });
  const months = lastMonths(3, now);
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '15s'");
        // Sequential on purpose: one connection, one transaction.
        const c = {};
        c.companies = await tx.company.count();
        c.branches = await tx.branch.count();
        c.activeEmployees = await tx.employee.count({ where: { isTerminated: false } });
        c.terminatedEmployees = await tx.employee.count({ where: { isTerminated: true } });
        c.activeUsers = await tx.user.count({ where: { isActive: true } });
        c.legalContracts = await tx.legalContract.count();
        c.lawsuits = await tx.lawsuit.count();
        c.vehicles = await tx.vehicle.count();
        c.vehiclesActive = await tx.vehicle.count({ where: { isArchived: false } });
        c.telecomSims = await tx.telecomSim.count();
        c.govPlatforms = await tx.govPlatform.count();
        c.renewals = await tx.renewalArchive.count();
        c.payrollsLast3Months = await tx.payroll.count({ where: { OR: months.map(({ year, month }) => ({ year, month })) } });
        c.payrollMonthsLast3 = months.map((p) => `${p.year}-${String(p.month).padStart(2, '0')}`);
        return c;
      },
      { timeout: 60000, maxWait: 30000 },
    );
  } finally {
    await prisma.$disconnect();
  }
}

function discover(envDir, only) {
  const names = fs
    .readdirSync(envDir)
    .filter((f) => f.endsWith('.env'))
    .map((f) => f.slice(0, -4))
    .filter((n) => TENANT_RE.test(n))
    .sort();
  const selected = only.length ? names.filter((n) => only.includes(n)) : names;
  for (const n of only) if (!names.includes(n)) selected.push(n); // reported as missing below
  return selected.map((tenant) => {
    try {
      const url = readEnvValue(fs.readFileSync(path.join(envDir, `${tenant}.env`), 'utf8'), 'DATABASE_URL');
      return url ? { tenant, url } : { tenant, error: 'DATABASE_URL missing' };
    } catch (err) {
      return { tenant, error: `cannot read env file: ${err.code || err.message}` };
    }
  });
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`[tenant-stats] ${err.message}`);
    return 2;
  }
  if (args.help) {
    console.error('usage: node --env-file=<tenant.env> scripts/tenant-stats.mjs | node scripts/tenant-stats.mjs --env-dir /etc/radeef [--tenant <name>]...');
    return 0;
  }
  const targets = args.envDir
    ? discover(args.envDir, args.tenants)
    : process.env.DATABASE_URL
      ? [{ tenant: process.env.RADEEF_TENANT || 'current', url: process.env.DATABASE_URL }]
      : [];
  if (targets.length === 0) {
    console.error('[tenant-stats] nothing to do: set DATABASE_URL (node --env-file=...) or pass --env-dir');
    return 2;
  }
  const tenants = [];
  for (const t of targets) {
    if (t.error) {
      tenants.push({ tenant: t.tenant, ok: false, error: t.error });
      continue;
    }
    try {
      tenants.push({ tenant: t.tenant, ok: true, counts: await countsFor(t.url) });
    } catch (err) {
      // Never echo the URL (it holds the password).
      tenants.push({ tenant: t.tenant, ok: false, error: String((err && err.message) || err).split('\n').filter(Boolean).pop().slice(0, 300) });
    }
  }
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), readOnly: true, tenants }, null, 2));
  return tenants.every((t) => t.ok) ? 0 : 1;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error('[tenant-stats] fatal:', err && err.message);
      process.exitCode = 1;
    },
  );
}
