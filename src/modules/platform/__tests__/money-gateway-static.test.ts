// BL-PAY-002 "ci-direct-writes" (BR-PAY-018): the static half of money.gateway. The run-time half is the
// Prisma extension (money-gateway.it.test.ts); the per-file ratchet of direct money writes is ARCH-004
// (src/test/architecture). Here:
//   1. only src/lib/prisma.ts constructs a PrismaClient in src/ (the one extended client), and scripts
//      that construct their own are a reviewed list (they must not write money, BR-PAY-018);
//   2. AsyncLocalStorage.enterWith is never used (the gateway context is run() only);
//   3. money operations are defined only by the owning modules (operations.ts), the listed legacy
//      writers, and the test fixture; nothing outside tests imports the test fixture;
//   4. the runtime lists equal the constitution's (config MONEY_MODELS / EMPLOYEE_MONEY_FIELDS).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import { EMPLOYEE_MONEY_COLUMNS, MONEY_TABLES } from '@/modules/platform';
import { EMPLOYEE_MONEY_FIELDS, MONEY_MODELS } from '@/test/architecture/config';

const ROOT = join(__dirname, '..', '..', '..', '..');
const rel = (p: string) => relative(ROOT, p).replace(/\\/g, '/');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === 'node_modules' || name.startsWith('.')) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

const isTest = (p: string) => /\.test\.ts$/.test(p) || p.includes('/__tests__/');
const SRC = walk(join(ROOT, 'src')).map((p) => ({ path: rel(p), text: readFileSync(p, 'utf8') }));

/** Scripts that build their own client (vendor bootstrap, reports, one-off data tools). A new one is a reviewed change. */
const SCRIPT_CLIENTS = [
  'prisma/demo-seed.mjs',
  'prisma/seed.mjs',
  'scripts/create-admin.mjs',
  'scripts/encrypt-gov-passwords.mjs',
  'scripts/reconcile-report.mjs',
  'scripts/register-legacy-uploads.mjs',
  'scripts/report-nationality-review.mjs',
  'scripts/report-self-approvals.mjs',
  'scripts/seed-demo.mjs',
  'scripts/seed-nitaqat.mjs',
  'scripts/tenant-stats.mjs',
];

/** Where money operations may be defined: the owning modules, the listed legacy writers, the test fixture. */
const OPERATION_SITES = [/^src\/modules\/[a-z]+\/operations\.ts$/, /^src\/lib\/finance\.ts$/, /^src\/test\/money-fixtures\.ts$/];

describe('money.gateway static checks (BL-PAY-002)', () => {
  it('only src/lib/prisma.ts constructs a PrismaClient in src/ (tests aside)', () => {
    const found = SRC.filter((f) => !isTest(f.path) && /new\s+PrismaClient\s*\(/.test(f.text)).map((f) => f.path);
    expect(found).toEqual(['src/lib/prisma.ts']);
    expect(SRC.find((f) => f.path === 'src/lib/prisma.ts')?.text).toMatch(/\$extends\(moneyGatewayExtension\)/);
  });

  it('scripts that construct their own client are the reviewed list', () => {
    const files = [...walk(join(ROOT, 'scripts')), ...walk(join(ROOT, 'prisma'))].map((p) => ({ path: rel(p), text: readFileSync(p, 'utf8') }));
    const found = files.filter((f) => /new\s+PrismaClient\s*\(/.test(f.text)).map((f) => f.path).sort();
    expect(found).toEqual([...SCRIPT_CLIENTS].sort());
  });

  it('AsyncLocalStorage.enterWith is never used (the gateway context is run() only)', () => {
    expect(SRC.filter((f) => /\.enterWith\s*\(/.test(f.text) && !f.path.endsWith('money-gateway-static.test.ts')).map((f) => f.path)).toEqual([]);
  });

  it('money operations are defined only by the owning modules, the listed legacy writers and the test fixture', () => {
    const sites = SRC.filter((f) => !isTest(f.path) && /defineMoneyOperation\s*[<(]/.test(f.text) && !f.path.startsWith('src/modules/platform/money/')).map((f) => f.path);
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.filter((p) => !OPERATION_SITES.some((re) => re.test(p)))).toEqual([]);
  });

  it('application code never imports the test fixtures', () => {
    const offenders = SRC.filter((f) => !isTest(f.path) && !f.path.startsWith('src/test/') && /from ['"]@\/test\//.test(f.text)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it('the runtime lists are the constitution\'s (MONEY_MODELS that exist in the schema; EMPLOYEE_MONEY_FIELDS)', () => {
    const models = new Set(Prisma.dmmf.datamodel.models.map((m) => m.name));
    // P1-PAY-B: the period tables of compensation joined (written by platform/effective inside compensation's operations).
    expect([...MONEY_TABLES].sort()).toEqual(MONEY_MODELS.filter((m) => models.has(m)).sort());
    expect([...EMPLOYEE_MONEY_COLUMNS].sort()).toEqual([...EMPLOYEE_MONEY_FIELDS].sort());
  });
});
