// Review of Phase 3 (routes): maker-checker refuses every author of the plan content, the archive is credited
// to its own audit row, the VIEW audit throttle is keyed on the filter set, and plan-vs-actual refuses dates
// that do not exist. In-memory prisma: the audit queries run against rows written by the scenario. SPEC §8, §9.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type AuditRow = { id: string; userId: string | null; action: string; entityType: string; entityId: string | null; details: string | null; createdAt: Date };

const mocks = vi.hoisted(() => ({
  user: { id: 'boss', role: 'SUPER_ADMIN' } as { id: string; role: string },
  audit: [] as AuditRow[],
  plan: null as null | Record<string, unknown>,
  logAudit: vi.fn(),
}));

/** Minimal prisma `where` evaluator: equality, in, not, contains, OR. */
function matches(row: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, cond]) => {
    if (k === 'OR') return (cond as Array<Record<string, unknown>>).some((w) => matches(row, w));
    const v = row[k];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as { in?: unknown[]; not?: unknown; contains?: string };
      if (c.in && !c.in.includes(v)) return false;
      if ('not' in c && v === c.not) return false;
      if (c.contains !== undefined && !(typeof v === 'string' && v.includes(c.contains))) return false;
      return true;
    }
    return v === cond;
  });
}

vi.mock('@/lib/prisma', () => {
  const auditLog = {
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => [...mocks.audit].reverse().find((r) => matches(r, where)) ?? null),
    findMany: vi.fn(async ({ where, distinct }: { where: Record<string, unknown>; distinct?: string[] }) => {
      const rows = mocks.audit.filter((r) => matches(r, where));
      if (!distinct) return rows;
      const seen = new Set<string>();
      return rows.filter((r) => {
        const k = distinct.map((d) => String((r as Record<string, unknown>)[d])).join('|');
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }),
    create: vi.fn(async ({ data }: { data: Omit<AuditRow, 'id' | 'createdAt'> }) => {
      mocks.audit.push({ id: `a${mocks.audit.length}`, createdAt: new Date(), ...data });
      return data;
    }),
  };
  const tx = {
    headcountPlan: { updateMany: vi.fn(async () => ({ count: 1 })) },
    workforceCalculation: { create: vi.fn(async () => ({ id: 'snap-1' })) },
    auditLog,
  };
  return {
    prisma: {
      auditLog,
      headcountPlan: { findUnique: vi.fn(async () => mocks.plan), findFirst: vi.fn(async () => mocks.plan) },
      $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
    },
  };
});
vi.mock('@/lib/auth', () => ({ requireUser: vi.fn(async () => mocks.user), getClientIp: () => '127.0.0.1' }));
vi.mock('@/lib/audit', () => ({ logAudit: mocks.logAudit }));
vi.mock('@/app/api/workforce/plans/_lib/server', async (orig) => {
  const actual = await orig<typeof import('@/app/api/workforce/plans/_lib/server')>();
  // The projection is not under test here: approval freezes whatever computePlan returns.
  return { ...actual, computePlan: vi.fn(async () => ({})), planSnapshotRecord: vi.fn(() => ({ kind: 'WORKFORCE_PLAN' })) };
});

const PLAN = 'plan-P';
const at = (i: number) => new Date(Date.UTC(2026, 8, 1, 10, i));
function audit(userId: string, action: string, entityType: string, entityId: string, details: Record<string, unknown>) {
  mocks.audit.push({ id: `a${mocks.audit.length}`, userId, action, entityType, entityId, details: JSON.stringify(details), createdAt: at(mocks.audit.length) });
}
const post = (body: unknown = {}) => new Request('http://t/x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

describe('maker-checker: an owner who authored the content cannot decide (finding 1)', () => {
  beforeEach(() => {
    mocks.audit.length = 0;
    mocks.plan = { id: PLAN, name: 'خطة', status: 'SUBMITTED', createdById: 'hr', companyId: null, positions: [], raises: [] };
    // HR creates the draft; the super admin edits the header and adds a position; HR submits.
    audit('hr', 'CREATE', 'HeadcountPlan', PLAN, { name: 'خطة' });
    audit('boss', 'UPDATE', 'HeadcountPlan', PLAN, { before: { name: 'خطة' }, after: { name: 'خطة 2' } });
    audit('boss', 'CREATE', 'PlannedPosition', 'pos-1', { planId: PLAN, kind: 'NEW_HIRE' });
    audit('owner2', 'CREATE', 'PlannedPosition', 'pos-9', { planId: 'plan-OTHER', kind: 'NEW_HIRE' }); // another plan
    audit('hr', 'UPDATE', 'HeadcountPlan', PLAN, { transition: 'SUBMIT', from: 'DRAFT', to: 'SUBMITTED' });
  });

  it('the super admin who edited HR’s draft (HR submitted) → 403 on approve and reject', async () => {
    const { transitionHandler } = await import('@/app/api/workforce/plans/_lib/actions');
    const { authorsOf } = await import('@/app/api/workforce/plans/_lib/server');
    expect(await authorsOf(PLAN)).toEqual(['boss', 'hr']);
    mocks.user = { id: 'boss', role: 'SUPER_ADMIN' };
    const res = await transitionHandler(post(), PLAN, 'APPROVE');
    expect(res.status).toBe(403);
    expect((await res.json()).message).toContain('شارك في إعدادها');
    expect((await transitionHandler(post({ note: 'لا' }), PLAN, 'REJECT')).status).toBe(403);
    expect(mocks.audit.some((r) => r.action === 'APPROVE' || r.action === 'REJECT')).toBe(false);
  }, 30_000);

  it('an owner who only touched a raise (deleted it) is an author too', async () => {
    const { transitionHandler } = await import('@/app/api/workforce/plans/_lib/actions');
    audit('owner3', 'DELETE', 'PlanRaise', 'r-1', { planId: PLAN, before: { scope: 'ALL' } });
    mocks.user = { id: 'owner3', role: 'COMPANY_ADMIN' };
    expect((await transitionHandler(post(), PLAN, 'APPROVE')).status).toBe(403);
  });

  it('a different owner who authored nothing → 200 (a position of another plan does not count)', async () => {
    const { transitionHandler } = await import('@/app/api/workforce/plans/_lib/actions');
    mocks.user = { id: 'owner2', role: 'COMPANY_ADMIN' };
    const res = await transitionHandler(post({ note: 'اعتماد' }), PLAN, 'APPROVE');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'APPROVED', snapshotId: 'snap-1' });
    expect(mocks.audit.at(-1)).toMatchObject({ userId: 'owner2', action: 'APPROVE', entityId: PLAN });
  });

  it('permissions shown to the author: approve false with the reason', async () => {
    const { permissionsFor, authorsOf } = await import('@/app/api/workforce/plans/_lib/server');
    const authors = await authorsOf(PLAN);
    const p = permissionsFor({ status: 'SUBMITTED', createdById: 'hr' }, { id: 'boss', role: 'SUPER_ADMIN' }, 'hr', authors);
    expect(p).toMatchObject({ approve: false, reject: false });
    expect(p.decideReason).toContain('شارك في إعدادها');
    expect(permissionsFor({ status: 'SUBMITTED', createdById: 'hr' }, { id: 'owner2', role: 'COMPANY_ADMIN' }, 'hr', authors).approve).toBe(true);
  });
});

describe('archive is credited to its own audit row, not to the approver (finding 8)', () => {
  it('planHistories + planHeader: «اعتمدها» by the approver, «أرشفها» by the archiver', async () => {
    mocks.audit.length = 0;
    audit('owner2', 'APPROVE', 'HeadcountPlan', PLAN, { transition: 'APPROVE' });
    audit('owner3', 'UPDATE', 'HeadcountPlan', PLAN, { transition: 'ARCHIVE', from: 'APPROVED', to: 'ARCHIVED' });
    audit('boss', 'REJECT', 'HeadcountPlan', 'plan-R', { transition: 'REJECT' });
    audit('boss', 'UPDATE', 'HeadcountPlan', 'plan-R', { transition: 'ARCHIVE', from: 'REJECTED', to: 'ARCHIVED' });
    const { planHistories, planHeader } = await import('@/app/api/workforce/plans/_lib/server');
    const h = await planHistories([PLAN, 'plan-R']);
    const row = (id: string) =>
      ({ id, name: 'خطة', status: 'ARCHIVED', companyId: null, fromMonth: new Date('2027-01-01T00:00:00Z'), months: 12, attritionPct: null, notes: null, basedOnId: null, createdById: 'hr', createdAt: at(0), updatedAt: at(9), submittedAt: at(1), decidedById: id === PLAN ? 'owner2' : 'boss', decidedAt: at(2), decisionNote: null }) as never;
    const names = new Map([['owner2', 'المالك 2'], ['owner3', 'المالك 3'], ['boss', 'المدير']]);
    const approved = planHeader(row(PLAN), names, new Map(), h.get(PLAN));
    expect(approved).toMatchObject({ statusLabel: 'مؤرشفة', decision: 'APPROVED', decisionLabel: 'اعتمدها', decidedByName: 'المالك 2', archivedByName: 'المالك 3' });
    expect(approved.archivedAt).toBe(at(1).toISOString());
    expect(planHeader(row('plan-R'), names, new Map(), h.get('plan-R'))).toMatchObject({ decision: 'REJECTED', decisionLabel: 'رفضها', archivedByName: 'المدير' });
  });
});

describe('VIEW audit throttle keyed on user + screen + filter set (finding 4)', () => {
  it('the same filters once per 5 minutes; every different scope is logged', async () => {
    const { auditViewOnce, normalizeViewFilters } = await import('@/app/api/workforce/_lib/server');
    mocks.logAudit.mockClear();
    const u = { id: `viewer-${Date.now()}` };
    await auditViewOnce(u, 'WorkforceBenchmarks', { months: 12, companyId: 'X', branchId: null, departmentId: null }, null);
    await auditViewOnce(u, 'WorkforceBenchmarks', { departmentId: null, branchId: null, companyId: 'X', months: 12 }, null); // same set, other order
    expect(mocks.logAudit).toHaveBeenCalledTimes(1);
    await auditViewOnce(u, 'WorkforceBenchmarks', { months: 12, companyId: 'X', departmentId: 'A' }, null);
    await auditViewOnce(u, 'WorkforceBenchmarks', { months: 12, companyId: 'X', departmentId: 'B' }, null);
    await auditViewOnce(u, 'WorkforceBenchmarks', { months: 6, companyId: 'X' }, null);
    expect(mocks.logAudit).toHaveBeenCalledTimes(4);
    expect(mocks.logAudit.mock.calls.map((c) => (c[0] as { details: { departmentId?: string } }).details.departmentId ?? null)).toEqual([null, 'A', 'B', null]);
    await auditViewOnce({ id: `${u.id}-2` }, 'WorkforceBenchmarks', { months: 12, companyId: 'X', departmentId: 'A' }, null); // another user
    expect(mocks.logAudit).toHaveBeenCalledTimes(5);
    expect(normalizeViewFilters({ b: 1, a: { d: null, c: [2, 1] } })).toBe('{"a":{"c":[2,1]},"b":1}');
  });
});

describe('plan vs actual asOf must be a real calendar date (finding 7)', () => {
  it('2026-02-31 → 400 (not rolled to March); leap days follow the calendar', async () => {
    const { actualQuerySchema, isCalendarDate } = await import('@/app/api/workforce/plans/_lib/schemas');
    expect(actualQuerySchema.safeParse({ asOf: '2026-02-31' }).success).toBe(false);
    expect(actualQuerySchema.safeParse({ asOf: '2026-04-31' }).success).toBe(false);
    expect(actualQuerySchema.safeParse({ asOf: '2026-02-29' }).success).toBe(false);
    expect(actualQuerySchema.safeParse({ asOf: '2028-02-29' }).success).toBe(true);
    expect(actualQuerySchema.safeParse({ asOf: '2026-09-30' }).success).toBe(true);
    expect(actualQuerySchema.safeParse({}).success).toBe(true);
    expect(isCalendarDate('2026-13-01')).toBe(false);
    const bad = actualQuerySchema.safeParse({ asOf: '2026-02-31' });
    expect(bad.success ? '' : bad.error.issues[0].message).toContain('التقويم');
  });
});
