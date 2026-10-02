// Fixtures for the ARCH rules: each rule must bite on a small violating example and stay quiet on
// the conforming shape, including rules whose subject (src/modules, DomainEvent, transitions,
// adapters) does not exist in the repository yet. Also covers the ratchet arithmetic.
import { describe, expect, it } from 'vitest';
import { type Baseline, allowed, compare, grow, shrink, unexplainedGrowth } from './ratchet';
import { RULES, type Violation, ownership } from './rules';
import { fixtureProject } from './source';

const DOC = `
## 5.2 ملكية الجداول

| الوحدة | تملك (الحالي) | تملك (جديد في الخطة) |
|---|---|---|
| **platform** | AuditLog، NotificationOutbox | DomainEvent، EventConsumption |
| **people** | Employee (الهوية فقط) | — |
| **lifecycle** | (الإسقاطات على Employee: employmentState) | EmploymentStateChange، EmploymentPeriod |
| **compensation** | Allowance | CompensationPeriod |
| **leave** | Leave | — |
| **payroll** | Payroll (يصبح PayrollLine)، Deduction | — |
| **documents** | IssuedDocument | — |

## 5.3 next
`;

const SCHEMA = `
model AuditLog { id String @id }
model NotificationOutbox { id String @id
  status String }
model Employee {
  id String @id
  legalCompanyId String?
  basicSalary Float
  isTerminated Boolean
  employmentStatus String
}
model Allowance { id String @id
  employeeId String }
model Leave { id String @id
  employeeId String
  status LeaveStatus }
enum LeaveStatus { PENDING }
model Payroll { id String @id
  employeeId String }
model Deduction { id String @id
  employeeId String }
model IssuedDocument { id String @id }
model EmploymentStateChange { id String @id }
model EmploymentPeriod { id String @id
  validFrom DateTime
  validTo DateTime? }
model CompensationPeriod { id String @id
  validFrom DateTime
  validTo DateTime? }
model DomainEvent { id String @id
  idempotencyKey String @unique }
model EventConsumption { id String @id
  consumer String
  eventId String
  @@unique([consumer, eventId]) }
`;

function run(id: string, sources: Record<string, string>, opts: { schema?: string; migrations?: Record<string, string> } = {}): Violation[] {
  const rule = RULES.find((r) => r.id === id);
  if (!rule) throw new Error(id);
  return rule.run(fixtureProject(sources, opts.schema ?? SCHEMA, { boundariesDoc: DOC, migrations: opts.migrations }));
}

describe('ownership table parsing (§5.2)', () => {
  it('reads owners, skips parenthesised commentary and keeps the supplement', () => {
    const { owners, conflicts } = ownership(fixtureProject({}, SCHEMA, { boundariesDoc: DOC }));
    expect(owners.get('Employee')).toBe('people'); // not lifecycle: that row names it only in a parenthesis
    expect(owners.get('EmploymentPeriod')).toBe('lifecycle');
    expect(owners.get('PayrollLine')).toBe('payroll');
    expect(conflicts).toEqual([]);
  });

  it('ARCH-002.owner: a schema model missing from §5.2 is reported', () => {
    const v = run('ARCH-002.owner', {}, { schema: SCHEMA + '\nmodel Mystery { id String @id }' });
    expect(v.map((x) => x.key)).toEqual(['prisma/schema.prisma#Mystery']);
  });
});

describe('ARCH-001 module boundaries', () => {
  it('refuses deep imports into another module and cross-module reads inside a module', () => {
    const v = run('ARCH-001', {
      'src/modules/leave/index.ts': `import { x } from '@/modules/payroll/transitions';\nimport { y } from '@/modules/payroll';\nexport async function f(tx) { return tx.payroll.findMany({}); }`,
      'src/modules/payroll/index.ts': 'export const y = 1;',
      'src/modules/payroll/transitions.ts': 'export const x = 1;',
    });
    expect(v.map((x) => x.message)).toEqual([expect.stringContaining('deep import "@/modules/payroll/transitions"'), expect.stringContaining('reads Payroll')]);
  });

  it('allows own internals, the index of another module, and tests', () => {
    const v = run('ARCH-001', {
      'src/modules/payroll/index.ts': `export * from './transitions';\nexport async function f(tx) { return tx.payroll.findMany({}); }`,
      'src/modules/payroll/transitions.ts': `import { a } from '@/modules/payroll/queries';\nexport const x = a;`,
      'src/modules/payroll/queries.ts': 'export const a = 1;',
      'src/lib/__tests__/p.test.ts': `import { x } from '@/modules/payroll/transitions';`,
    });
    expect(v).toEqual([]);
  });

  it('ARCH-001.dir: upward and same-layer imports are refused, downward allowed', () => {
    const v = run('ARCH-001.dir', {
      'src/modules/finance/index.ts': `import { p } from '@/modules/payroll';`, // finance is below payroll (ADR-0002 #7)
      'src/modules/payroll/index.ts': `import { f } from '@/modules/finance';\nexport const p = 1;`,
      'src/modules/people/index.ts': `import { o } from '@/modules/org';`,
      'src/modules/org/index.ts': `export const o = 1;`,
      'src/modules/workflow/index.ts': `import { l } from '@/modules/leave';`,
      'src/modules/leave/index.ts': `import { w } from '@/modules/workflow';\nexport const l = 1;`,
    });
    expect(v.map((x) => x.key).sort()).toEqual(['src/modules/finance/index.ts', 'src/modules/people/index.ts', 'src/modules/workflow/index.ts']);
  });
});

describe('ARCH-002 / 003 / 004 / 005 / 012 writers', () => {
  it('ARCH-002: a module writing a table it does not own', () => {
    const v = run('ARCH-002', {
      'src/modules/leave/transitions.ts': `export async function a(tx) { await tx.leave.update({ where: { id: 1 }, data: {} }); await tx.payroll.create({ data: {} }); }`,
    });
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain('writes Payroll');
  });

  it('ARCH-002: the projector may write its own Employee projection columns', () => {
    const ok = run('ARCH-002', { 'src/modules/lifecycle/transitions.ts': `export async function t(tx) { await tx.employee.update({ where: { id }, data: { isTerminated: true } }); }` });
    expect(ok).toEqual([]);
    const bad = run('ARCH-002', { 'src/modules/lifecycle/transitions.ts': `export async function t(tx) { await tx.employee.update({ where: { id }, data: { isTerminated: true, firstNameArabic: 'x' } }); }` });
    expect(bad).toHaveLength(1);
  });

  it('ARCH-003: projection columns outside their projector, and the state fallback outside lifecycle', () => {
    const v = run('ARCH-003', {
      'src/modules/payroll/transitions.ts': `export async function t(tx, e) { await tx.employee.update({ where: { id }, data: { basicSalary: 1 } }); return e.employmentState ?? (e.isTerminated ? 'X' : 'A'); }`,
      'src/modules/lifecycle/readers.ts': `export const s = (e) => e.employmentState ?? (e.isTerminated ? 'X' : 'A');`,
    });
    expect(v.map((x) => [x.key, x.tag ?? null])).toEqual([
      ['src/modules/payroll/transitions.ts', null],
      ['src/modules/payroll/transitions.ts', 'employment-state-fallback'],
      ['src/modules/lifecycle/readers.ts', 'employment-state-fallback'],
    ]);
    // ADR-0002 #5 allowance covers the lifecycle readers only.
    const allowance = [{ rule: 'ARCH-003', tag: 'employment-state-fallback', pathPrefix: 'src/modules/lifecycle/', adr: 'ADR-0002 #5' }];
    expect(v.filter((x) => !allowed(x, allowance)).map((x) => x.key)).toEqual(['src/modules/payroll/transitions.ts', 'src/modules/payroll/transitions.ts']);
  });

  it('ARCH-004: money tables only in the owner transitions', () => {
    const v = run('ARCH-004', {
      'src/modules/payroll/transitions.ts': `export async function t(tx) { await tx.deduction.create({ data: {} }); }`,
      'src/modules/payroll/service.ts': `export async function s(tx) { await tx.deduction.create({ data: {} }); }`,
      'src/app/api/x/route.ts': `export async function POST() { await prisma.employee.update({ where: { id }, data: { basicSalary: 2 } }); }`,
    });
    expect(v.map((x) => x.key)).toEqual(['src/modules/payroll/service.ts', 'src/app/api/x/route.ts']);
  });

  it('ARCH-005: employment state only in lifecycle transitions', () => {
    const v = run('ARCH-005', {
      'src/modules/lifecycle/transitions.ts': `export async function transitionEmploymentState(tx) { await tx.employmentStateChange.create({ data: {} }); await tx.employee.update({ where: { id }, data: { employmentStatus: 'X' } }); }`,
      'src/modules/offboarding/transitions.ts': `export async function t(tx) { await tx.employee.updateMany({ where: { id }, data: { isTerminated: true } }); }`,
    });
    expect(v.map((x) => x.key)).toEqual(['src/modules/offboarding/transitions.ts']);
  });

  it('ARCH-012: period tables through platform/effective only', () => {
    const v = run('ARCH-012', {
      'src/modules/platform/effective/periods.ts': `export async function openPeriod(tx) { await tx.compensationPeriod.create({ data: {} }); }`,
      'src/modules/compensation/transitions.ts': `export async function t(tx) { await tx.compensationPeriod.create({ data: {} }); }`,
    });
    expect(v.map((x) => x.key)).toEqual(['src/modules/compensation/transitions.ts']);
  });
});

describe('scope, constants, scripts, raw SQL, events', () => {
  it('ARCH-006: a route querying scoped data must reach a scope helper', () => {
    const v = run('ARCH-006', {
      'src/app/api/a/route.ts': `export async function GET() { await requireUser(); return prisma.leave.findMany({}); }`,
      'src/app/api/b/route.ts': `import { userCompanyScope } from '@/lib/company-scope';\nexport async function GET() { const s = await userCompanyScope(prisma, u); return prisma.leave.findMany({}); }`,
      'src/app/api/c/route.ts': `import { load } from './load';\nexport async function GET() { return load(); }`,
      'src/app/api/c/load.ts': `export async function load() { return prisma.leave.findMany({ where: companyScopeWhere(s) }); }`,
      'src/app/api/d/route.ts': `import { load2 } from './load2';\nexport async function GET() { await prisma.leave.count(); return load2(); }`,
      'src/app/api/d/load2.ts': `export async function load2() { return companyScopeWhere(s); }`,
      'src/app/api/e/route.ts': `export async function GET() { return prisma.auditLog.findMany({}); }`, // platform table: not company scoped
    });
    expect(v.map((x) => x.key)).toEqual(['src/app/api/a/route.ts']);
  });

  it('ARCH-007: legal numbers in legal context, not elsewhere', () => {
    const v = run('ARCH-007', {
      'src/lib/leave.ts': `export const ANNUAL_LEAVE_DAYS = 21;\nexport const noticeDays = (x) => x ?? 60;\nexport const pageSize = 30;\nconst z = { type: 'SICK', days: 90 };`,
      'scripts/seed-demo.mjs': `const leaveDays = 21;`,
      'src/lib/__tests__/l.test.ts': `const annualLeave = 21;`,
    });
    expect(v.map((x) => `${x.key}:${x.line}`)).toEqual(['src/lib/leave.ts:1', 'src/lib/leave.ts:2', 'src/lib/leave.ts:4']);
  });

  it('ARCH-008: scripts do not write', () => {
    const v = run('ARCH-008', {
      'scripts/job.mjs': `await prisma.leave.updateMany({ where: {}, data: {} });\nawait prisma.$executeRawUnsafe('x');\nawait prisma.leave.findMany({});`,
    });
    expect(v).toHaveLength(2);
  });

  it('ARCH-009: raw SQL only in module sql/, with companyIds for scoped tables', () => {
    const v = run('ARCH-009', {
      'src/lib/x.ts': 'export const a = () => prisma.$queryRaw`SELECT 1`;',
      'src/modules/leave/sql/q.ts':
        'export const ok = (companyIds: string[]) => prisma.$queryRaw`SELECT * FROM "Leave"`;\n' +
        'export const bad = () => prisma.$queryRaw`SELECT * FROM "Leave"`;\n' +
        'export const neutral = () => prisma.$queryRaw`SELECT now()`;',
    });
    expect(v.map((x) => `${x.key}:${x.line}`)).toEqual(['src/lib/x.ts:1', 'src/modules/leave/sql/q.ts:2']);
  });

  it('ARCH-010: DomainEvent needs a unique idempotencyKey and every emit sets it', () => {
    const schemaBad = SCHEMA.replace('idempotencyKey String @unique', 'idempotencyKey String').replace('@@unique([consumer, eventId])', '');
    const v = run(
      'ARCH-010',
      {
        'src/modules/platform/events.ts': `export async function emit(tx) { await tx.domainEvent.create({ data: { type: 't' } }); await tx.domainEvent.create({ data: { type: 't', idempotencyKey: k } }); }`,
      },
      { schema: schemaBad },
    );
    expect(v.map((x) => x.key)).toEqual(['prisma/schema.prisma#DomainEvent', 'prisma/schema.prisma#EventConsumption', 'src/modules/platform/events.ts']);
    expect(run('ARCH-010', {})).toEqual([]);
  });
});

describe('money reads and arithmetic, transitions, schema', () => {
  it('ARCH-011: projected salary in financial modules', () => {
    const v = run('ARCH-011', {
      'src/modules/payroll/calc.ts': `export async function c(tx, emp) { await tx.employee.findMany({ select: { basicSalary: true } }); return emp.basicSalary; }`,
      'src/modules/payroll/snap.ts': `export const s = (line) => line.basicSalary;`,
      'src/modules/people/view.ts': `export const v = (emp) => emp.basicSalary;`,
    });
    expect(v.map((x) => `${x.key}:${x.message}`)).toEqual(['src/modules/payroll/calc.ts:selects Employee.basicSalary', 'src/modules/payroll/calc.ts:reads emp.basicSalary']);
  });

  it('ARCH-013: amount arithmetic outside money.ts', () => {
    const v = run('ARCH-013', {
      'src/modules/payroll/calc.ts': `export const d = (m) => m / 30 + m * 0.1 + m * 2;`,
      'src/modules/payroll/money.ts': `export const d = (m) => m / 30;`,
      'src/modules/time/x.ts': `export const d = (m) => m / 30;`,
    });
    expect(v).toHaveLength(2);
  });

  it('ARCH-014: every transition export has a named idempotency test', () => {
    const src = { 'src/modules/leave/transitions.ts': `export async function approveLeave() {}\nexport async function cancelLeave() {}` };
    const v = run('ARCH-014', {
      ...src,
      'src/modules/leave/__tests__/t.test.ts': `describe('approveLeave', () => { it('is idempotent on a double call', () => {}); });`,
    });
    expect(v.map((x) => x.message)).toEqual([expect.stringContaining('cancelLeave')]);
  });

  it('ARCH-015: free String state columns need a CHECK', () => {
    const v = run('ARCH-015', {}, { migrations: { 'prisma/migrations/9q_x/migration.sql': `ALTER TABLE "NotificationOutbox" ADD CONSTRAINT "s" CHECK ("status" IN ('A','B'));` } });
    expect(v.map((x) => x.key)).toEqual(['prisma/schema.prisma#Employee.employmentStatus']);
  });
});

describe('routes, transactions, adapters', () => {
  it('ARCH-016: every handler reaches a guard (directly, via a helper, or via an alias)', () => {
    const v = run('ARCH-016', {
      'src/lib/auth.ts': `export async function requireUser() {}`,
      'src/app/api/a/route.ts': `import { requireUser } from '@/lib/auth';\nexport async function GET() { await requireUser(); }\nexport async function POST() {}`,
      'src/app/api/b/_lib.ts': `import { requireUser } from '@/lib/auth';\nexport async function guarded() { await requireUser(); }`,
      'src/app/api/b/route.ts': `import { guarded } from './_lib';\nasync function save() { await guarded(); }\nexport const PUT = save;`,
      'src/app/api/health/route.ts': `export async function GET() {}`,
    });
    expect(v.map((x) => `${x.key}:${x.message}`)).toEqual(['src/app/api/a/route.ts:POST handler never calls an auth guard']);
  });

  it('ARCH-016.test: a route needs a test with unmocked auth', () => {
    const v = run('ARCH-016.test', {
      'src/lib/auth.ts': `export async function requireUser() {}`,
      'src/app/api/a/route.ts': `export async function GET() {}`,
      'src/app/api/b/route.ts': `export async function GET() {}`,
      'src/lib/__tests__/a.test.ts': `import { GET } from '@/app/api/a/route';`,
      'src/lib/__tests__/b.test.ts': `vi.mock('@/lib/auth', () => ({}));\nconst { GET } = await import('@/app/api/b/route');`,
    });
    expect(v.map((x) => x.key)).toEqual(['src/app/api/b/route.ts']);
  });

  it('ARCH-017: no side effect inside $transaction, followed through repo functions', () => {
    const v = run('ARCH-017', {
      'src/lib/mailer.ts': `export async function sendMail(m) { await fetch('x'); }`,
      'src/lib/notify.ts': `import { sendMail } from './mailer';\nexport async function tell() { await sendMail({}); }`,
      'src/lib/a.ts':
        `import { tell } from './notify';\n` +
        `export async function bad() { await prisma.$transaction(async (tx) => { await tx.leave.update({}); await tell(); }); }\n` +
        `export async function good() { await prisma.$transaction(async (tx) => { await tx.notificationOutbox.create({ data: {} }); }); await tell(); }`,
    });
    expect(v.map((x) => `${x.key}:${x.line}`)).toEqual(['src/lib/a.ts:2']);
    expect(v[0].message).toContain('tell');
  });

  it('ARCH-019: multi-employee writes lock employees first', () => {
    const v = run('ARCH-019', {
      'src/lib/a.ts':
        `export async function bad() { await prisma.$transaction(async (tx) => { for (const id of ids) await tx.allowance.update({ where: { id }, data: {} }); }); }\n` +
        `export async function good() { await prisma.$transaction(async (tx) => { await lockEmployees(tx, ids); await tx.allowance.updateMany({ where: { employeeId: { in: ids } }, data: {} }); }); }\n` +
        `export async function single() { await prisma.$transaction(async (tx) => { await tx.allowance.updateMany({ where: { employeeId: id }, data: {} }); }); }\n` +
        `export async function late() { await prisma.$transaction(async (tx) => { await tx.deduction.deleteMany({ where: {} }); await lockEmployees(tx, ids); }); }`,
    });
    expect(v.map((x) => `${x.line}:${x.message.slice(0, 20)}`)).toEqual(['1:writes Allowance for', '4:lockEmployees is not']);
  });

  it('ARCH-020: an adapter with exitPolicy needs an employment.terminated consumer', () => {
    const adapter = { 'src/modules/assets/adapters.ts': `export const a = { type: 'assets.request', exitPolicy: 'CANCEL' };` };
    expect(run('ARCH-020', adapter)).toHaveLength(1);
    expect(run('ARCH-020', { ...adapter, 'src/modules/assets/consumers.ts': `export const c = { 'employment.terminated': handle };` })).toEqual([]);
  });

  it('ARCH-021: only the owning module calls the period writers for its kind (ADR-0005)', () => {
    const v = run('ARCH-021', {
      'src/modules/payroll/a.ts':
        `import { openPeriod, closePeriod as endPeriod } from '@/modules/platform';\n` +
        `const K = 'COMPENSATION';\n` +
        `export async function a(tx) { await openPeriod(tx, 'EMPLOYMENT', input, op); }\n` +
        `export async function b(tx) { await endPeriod(tx, K, id, input, op); }\n` +
        `export async function c(tx) { await platform.supersedePeriod(tx, 'ASSIGNMENT' as const, id, input, op); }\n` +
        `export async function d(tx, kind) { await openPeriod(tx, kind, input, op); await openLegacyPeriod(tx, 'EMPLOYMENT', input, actor); }`,
      'src/modules/lifecycle/transitions.ts': 'export async function hire(tx) { await openPeriod(tx, \'EMPLOYMENT\', input, op); await closePeriod(tx, `EMPLOYMENT`, id, input, op); }',
      'src/modules/org/transitions.ts': `export async function move(tx) { await supersedePeriod(tx, 'ASSIGNMENT', id, input, op); }`,
      'src/modules/compensation/transitions.ts': `export async function pay(tx) { await openPeriod(tx, 'COMPENSATION', input, op); }`,
      'src/modules/platform/effective/legacy.ts': `export async function x(tx) { await openPeriod(tx, 'EMPLOYMENT', input, op); }`,
      'src/modules/platform/__tests__/e.test.ts': `it('x', async () => { await openPeriod(tx, 'COMPENSATION', input, op); });`,
      'src/lib/employee.ts': `export async function legacy(tx) { await openPeriod(tx, 'ASSIGNMENT', input, op); }`,
    });
    expect(v.map((x) => `${x.key}:${x.line}:${x.message.split(' outside')[0]}`)).toEqual([
      "src/modules/payroll/a.ts:3:openPeriod(…, 'EMPLOYMENT')",
      "src/modules/payroll/a.ts:4:closePeriod(…, 'COMPENSATION')",
      "src/modules/payroll/a.ts:5:supersedePeriod(…, 'ASSIGNMENT')",
      "src/lib/employee.ts:1:openPeriod(…, 'ASSIGNMENT')",
    ]);
  });
});

describe('ratchet (§4.1.3)', () => {
  const V = (key: string, line = 1): Violation => ({ rule: 'R', key, line, message: 'm' });
  const base: Baseline = { rules: { R: { a: 2, b: 1 } }, allowances: [], growth: [] };

  it('fails on a new violation and on a stale entry', () => {
    expect(compare('R', [V('a'), V('a'), V('b')], base)).toEqual({ grown: [], stale: [] });
    const c = compare('R', [V('a'), V('a'), V('a'), V('c')], base);
    expect(c.grown.map((g) => [g.key, g.baseline, g.actual])).toEqual([
      ['a', 2, 3],
      ['c', 0, 1],
    ]);
    expect(c.stale).toEqual([{ key: 'b', baseline: 1, actual: 0 }]);
  });

  it('shrink never adds, grow logs the ADR', () => {
    const actual = { R: { a: 1, c: 5 } };
    expect(shrink(base, actual).rules).toEqual({ R: { a: 1 } });
    const g = grow(base, actual, 'ADR-0003', '2026-09-28');
    expect(g.rules).toEqual({ R: { a: 1, c: 5 } });
    expect(g.growth).toEqual([{ date: '2026-09-28', adr: 'ADR-0003', rule: 'R', key: 'c', from: 0, to: 5 }]);
    expect(unexplainedGrowth(base, g)).toEqual([]);
    expect(unexplainedGrowth(base, { ...g, growth: [] })).toEqual(['R c: 0 -> 5']);
  });
});
