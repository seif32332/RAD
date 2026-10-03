// A tenant of its own for a test (BL-PAY-021 acceptance). Radeef has one database per customer, and the
// controls mode is computed from the whole tenant's users, so a test of the REAL mode needs a tenant whose
// users it owns: a fresh database, migrated once as a template and copied per tenant.
//
// (Kept under __tests__: it builds its own maintenance PrismaClient, which application code never may.)
//
//   const tpl = await migratedTemplate('p021');      // CREATE DATABASE + prisma migrate deploy (once)
//   const t = await tenantFromTemplate(tpl, 'one');  // CREATE DATABASE … TEMPLATE …
//   await enterTenantDatabase(t.url);                  // the app modules imported after this use t's database
//   … dynamic imports, the test …
//   await leaveTenantDatabase();  await t.drop();  await tpl.drop();
//
// Needs CREATEDB on DATABASE_URL's server (a throwaway test server). Never used by application code.
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { vi } from 'vitest';

const ORIGINAL_URL = process.env.DATABASE_URL;

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  u.searchParams.delete('schema');
  return u.toString();
}

async function admin<T>(fn: (c: PrismaClient) => Promise<T>): Promise<T> {
  if (!ORIGINAL_URL) throw new Error('tenant-db: DATABASE_URL is not set');
  // The maintenance database of the same server: CREATE / DROP DATABASE cannot run inside the target.
  const c = new PrismaClient({ datasourceUrl: withDatabase(ORIGINAL_URL, 'postgres') });
  try {
    return await fn(c);
  } finally {
    await c.$disconnect();
  }
}

const NAME = /^[a-z0-9_]{1,50}$/;

export interface TenantDatabase {
  name: string;
  url: string;
  drop(): Promise<void>;
}

function handle(name: string): TenantDatabase {
  return {
    name,
    url: withDatabase(ORIGINAL_URL as string, name),
    drop: () => admin((c) => c.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)).then(() => undefined),
  };
}

/** A new database with every migration applied (the template of the tenants of one test file). */
export async function migratedTemplate(label: string): Promise<TenantDatabase> {
  const name = `${label}_tpl_${randomBytes(4).toString('hex')}`;
  if (!NAME.test(name)) throw new Error(`tenant-db: invalid name ${name}`);
  await admin((c) => c.$executeRawUnsafe(`CREATE DATABASE "${name}"`));
  const t = handle(name);
  execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: t.url }, stdio: 'pipe', timeout: 180_000 });
  return t;
}

/** A tenant database copied from the template (fast; the template must have no open connection). */
export async function tenantFromTemplate(template: TenantDatabase, label: string): Promise<TenantDatabase> {
  const name = `${template.name.replace(/_tpl_.*/, '')}_${label}_${randomBytes(4).toString('hex')}`;
  if (!NAME.test(name)) throw new Error(`tenant-db: invalid name ${name}`);
  await admin((c) => c.$executeRawUnsafe(`CREATE DATABASE "${name}" TEMPLATE "${template.name}"`));
  return handle(name);
}

/** Points the app's one Prisma client at `url`: the modules imported (dynamically) after this call use it. */
export async function enterTenantDatabase(url: string): Promise<void> {
  await leaveTenantDatabase();
  process.env.DATABASE_URL = url;
}

/** Disconnects the tenant's client and restores DATABASE_URL (the next test file must not inherit it). */
export async function leaveTenantDatabase(): Promise<void> {
  const g = globalThis as unknown as { prisma?: PrismaClient };
  if (g.prisma) await g.prisma.$disconnect().catch(() => undefined);
  delete g.prisma;
  vi.resetModules();
  process.env.DATABASE_URL = ORIGINAL_URL;
}
