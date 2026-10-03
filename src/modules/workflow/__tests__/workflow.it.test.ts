// The approval engine (WFE-002) against a real PostgreSQL with every migration applied, real iam contexts (no auth
// mock) and the real ports (src/lib/workflow-wiring.ts: people lock, lifecycle state, org manager, calendar, leave).
// The tenant is a database of its own (iam/__tests__/tenant-db.ts): the candidate pools are "every eligible login of
// the company", which the shared test database cannot keep stable.
//
// Covers AUDIT/16 §4: the double call of each of the 12 exported transitions (sequential and concurrent, ARCH-014),
// concurrency (ANY, act vs cancel, paused, stale version, opposite lock orders, the lock order spy), scope (allow, deny,
// other company, Self, Team, System, two companies, tenant vs company definition, delegations), the DEC-PO-145
// guardrails and the INV-IAM-01 regressions of the engine (ADR-0010), events and effectFailed.
//
// Opt-in: WFE_IT=1 with DATABASE_URL on a THROWAWAY server whose role may CREATE DATABASE.
import { randomBytes, randomUUID } from 'crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { enterTenantDatabase, leaveTenantDatabase, migratedTemplate, tenantFromTemplate, type TenantDatabase } from '@/modules/iam/__tests__/tenant-db';

// Phase 2 is un-activatable by construction (activation.ts); the tests replace the gate (AUDIT/16 §3.8).
vi.mock('../activation', () => ({ ACTIVATION_BLOCKERS: [], activationBlockers: () => [] }));

type FinalCheck = { ok: true } | { awaitable: true; requirement: string } | { error: string };
interface Req {
  id: string;
  beneficiaries: string[];
  requester: string | null;
  companyIdWhenNoBeneficiary?: string;
  final: FinalCheck;
  canReject: boolean;
  canReturn: boolean;
  canCancel: (userId: string) => boolean;
  needsConfirm: boolean;
  failOnApproved: boolean;
}

describe('workflow engine on PostgreSQL (WFE-002)', { timeout: 900_000 }, () => {
  if (process.env.WFE_IT !== '1') return; // skipped: build nothing (the suite creates a database)

  let template: TenantDatabase;
  let tenant: TenantDatabase;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let prisma: any;
  let wf: typeof import('@/modules/workflow');
  let iam: typeof import('@/modules/iam');
  let fx: typeof import('@/test/money-fixtures');
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const store = new Map<string, Req>();
  const hooks: { type: string; hook: string; requestId: string }[] = [];
  const order: string[] = [];
  const tag = randomBytes(4).toString('hex');
  const U: Record<string, string> = {};
  const E: Record<string, string> = {};
  let A = '';
  let B = '';

  const SETTINGS = { maxReturns: null, returnExpiryWorkingDays: null, coverRole: null, rejectRequiresPair: false, rejectAuthority: ['HR_MANAGER'] };
  const hrStage = (id: string, extra: Record<string, unknown> = {}) => ({ type: 'stage', id, approver: { kind: 'ROLE', role: 'HR_MANAGER' }, ...extra });
  const DEFS: Record<string, unknown> = {
    'tests.role': { schemaVersion: 1, settings: SETTINGS, root: { type: 'sequence', id: 'root', children: [hrStage('hr')] } },
    'tests.chain': {
      schemaVersion: 1,
      settings: SETTINGS,
      root: { type: 'sequence', id: 'root', children: [{ type: 'stage', id: 'mgr', approver: { kind: 'MANAGER_CHAIN', levels: 1 } }, hrStage('hr', { distinctFromPrior: true, deadline: { workingDays: 2, onDeadline: 'NOTIFY' } })] },
    },
    'tests.two': { schemaVersion: 1, settings: SETTINGS, root: { type: 'sequence', id: 'root', children: [hrStage('first'), hrStage('second', { distinctFromPrior: true })] } },
    'tests.any': { schemaVersion: 1, settings: SETTINGS, root: { type: 'parallel', id: 'p', join: 'ANY', branches: [hrStage('a'), { type: 'stage', id: 'b', approver: { kind: 'ROLE', role: 'COMPANY_ADMIN' } }] } },
    'tests.all': { schemaVersion: 1, settings: SETTINGS, root: { type: 'parallel', id: 'p', join: 'ALL', branches: [hrStage('a'), hrStage('b')] } },
    'tests.auto': { schemaVersion: 1, settings: SETTINGS, root: { type: 'sequence', id: 'root', children: [] } },
    'tests.pair': { schemaVersion: 1, settings: { ...SETTINGS, rejectRequiresPair: true, rejectAuthority: ['HR_MANAGER', 'COMPANY_ADMIN'] }, root: { type: 'sequence', id: 'root', children: [hrStage('hr')] } },
    'tests.legal': { schemaVersion: 1, settings: SETTINGS, root: { type: 'sequence', id: 'root', children: [{ type: 'stage', id: 'legal', approver: { kind: 'ROLE', role: 'LEGAL_ADMIN' } }] } },
  };

  function adapterFor(requestType: string, guards: ((c: { userId: string }) => { ok: true } | { exclude: true; reason: string })[] = []) {
    return {
      requestType,
      ownerModule: 'tests',
      payEffect: 'NONE' as const,
      fieldCatalog: {},
      decisionFieldCatalog: {},
      closeSources: ['WITHDRAWAL', 'DEEMED'],
      pauseReasons: ['DEFERRAL', 'SUPERSEDED'],
      decisionStatuses: [],
      domainStatuses: [],
      legacyDecisionEntryPoints: [],
      recheckTriggers: [],
      guards,
      load: async (_tx: unknown, id: string) => {
        const r = store.get(id);
        if (!r) throw new Error(`no request ${id}`);
        return r;
      },
      parties: async (_tx: unknown, r: Req) => ({
        beneficiaryEmployeeIds: r.beneficiaries,
        requesterUserId: r.requester,
        companyIdWhenNoBeneficiary: r.companyIdWhenNoBeneficiary,
        contextSnapshot: { kind: requestType },
      }),
      lockKeys: async () => {
        order.push('lockKeys');
      },
      validateSubmit: async () => undefined,
      validateFinal: async (_tx: unknown, r: Req) => r.final,
      canReject: (_a: unknown, r: Req) => r.canReject,
      canReturn: (_a: unknown, r: Req) => r.canReturn,
      canCancel: (a: { userId: string }, r: Req) => r.canCancel(a.userId),
      cancelNeedsConfirm: (_i: unknown, r: Req) => r.needsConfirm,
      onApproved: async (_tx: unknown, c: { instance: { requestId: string } }) => {
        const r = store.get(c.instance.requestId);
        if (r?.failOnApproved) throw new Error('downstream refused');
        hooks.push({ type: requestType, hook: 'onApproved', requestId: c.instance.requestId });
      },
      onRejected: async (_tx: unknown, c: { instance: { requestId: string } }) => void hooks.push({ type: requestType, hook: 'onRejected', requestId: c.instance.requestId }),
      onCancelled: async (_tx: unknown, c: { instance: { requestId: string } }) => void hooks.push({ type: requestType, hook: 'onCancelled', requestId: c.instance.requestId }),
      onReturned: async (_tx: unknown, c: { instance: { requestId: string } }) => void hooks.push({ type: requestType, hook: 'onReturned', requestId: c.instance.requestId }),
      summary: () => ({}),
    };
  }

  // ------------------------------------------------------------------------------------------------
  // Fixtures

  beforeAll(async () => {
    template = await migratedTemplate('wfe');
    tenant = await tenantFromTemplate(template, 'core');
    await enterTenantDatabase(tenant.url);
    prisma = (await import('@/lib/prisma')).prisma;
    wf = await import('@/modules/workflow');
    iam = await import('@/modules/iam');
    fx = await import('@/test/money-fixtures');
    const people = await import('@/modules/people');
    const platform = await import('@/modules/platform');

    // The lock-order spy (registered before the wiring, which then keeps it: a port is never overridden).
    wf.registerWorkflowPort('EmployeeLock', {
      lockEmployees: async (tx, ids, companies) => {
        order.push(`lock:${[...ids].join(',')}`);
        return people.lockEmployees(tx, ids, companies === 'ALL' ? 'ALL' : [...companies]);
      },
    });
    (await import('@/lib/workflow-wiring')).ensureWorkflowWiring();
    for (const t of Object.keys(DEFS)) {
      wf.registerWorkflowAdapter(
        adapterFor(
          t,
          t === 'tests.legal'
            ? [
                // A guard that tries to "allow" everyone: it can only narrow. Excludes nobody → returns ok.
                () => ({ ok: true }),
              ]
            : [],
        ) as never,
      );
    }

    const company = async (n: string) => (await prisma.company.create({ data: { nameArabic: `WFE ${n} ${tag}`, commercialRegNum: `WFE${n}${tag}`, commercialRegExp: new Date('2035-01-01') } })).id;
    A = await company('A');
    B = await company('B');
    const user = async (key: string, role: string, scope: string[] | null) => {
      const id = (await prisma.user.create({ data: { email: `${key}-${tag}@example.test`, name: key, passwordHash: 'x', role } })).id;
      if (scope) for (const companyId of scope) await fx.moneyFixture((tx) => tx.userCompanyScope.create({ data: { userId: id, companyId } }));
      U[key] = id;
      return id;
    };
    await user('super', 'SUPER_ADMIN', null);
    await user('ownerA', 'COMPANY_ADMIN', [A]);
    await user('hr1', 'HR_MANAGER', [A]);
    await user('hr2', 'HR_MANAGER', [A]);
    await user('hr3', 'HR_MANAGER', [A]);
    await user('hrB', 'HR_MANAGER', [B]);
    await user('mgr', 'BRANCH_MANAGER', [A]);
    await user('emp', 'EMPLOYEE', [A]);
    await user('benHr', 'HR_MANAGER', [A]); // an HR login that is itself a beneficiary
    await user('vendorHr', 'HR_MANAGER', [A]);
    await user('leftHr', 'HR_MANAGER', [A]); // linked to a TERMINATED employee
    await user('legal', 'LEGAL_ADMIN', [A]);
    await fx.identityFixture(U.vendorHr, { isVendorStaff: true });

    const employee = async (key: string, companyId: string, over: Record<string, unknown> = {}) => {
      const t = randomBytes(4).toString('hex');
      const e = await fx.employeeFixture({
        employeeId: `WFE-${t}`, firstNameArabic: 'موظف', lastNameArabic: key, nationality: 'SA', iqamaOrIdNumber: `WFE${t}`,
        iqamaOrIdExp: new Date('2030-01-01'), dateOfBirth: new Date('1990-01-01'), gender: 'M', joinDate: new Date('2024-01-01'),
        basicSalary: 5000, legalCompanyId: companyId, ...over,
      });
      E[key] = e.id;
      return e.id;
    };
    await employee('mgrEmp', A);
    await employee('ben', A);
    await employee('ben2', A);
    await employee('benHrEmp', A);
    await employee('benB', B);
    await employee('left', A, { isTerminated: true, employmentState: 'TERMINATED', terminationDate: new Date('2025-01-01') });
    await fx.linkFixture(U.mgr, E.mgrEmp);
    await fx.linkFixture(U.emp, E.ben);
    await fx.linkFixture(U.benHr, E.benHrEmp);
    await fx.linkFixture(U.leftHr, E.left);
    // The manager of ben and of benHrEmp is mgrEmp (the assignment in force).
    for (const k of ['ben', 'benHrEmp', 'ben2']) {
      await prisma.$transaction((tx: never) =>
        platform.openLegacyPeriod(tx, 'ASSIGNMENT', { employeeId: E[k], validFrom: '2024-01-01', attrs: { legalCompanyId: A, managerId: E.mgrEmp } }, { type: 'SYSTEM', id: 'test' }),
      );
    }

    // Tenant-default definitions, saved and activated by the owner (G7).
    const sup = await ctxOf('super');
    for (const [t, def] of Object.entries(DEFS)) {
      const d = await wf.saveWorkflowDefinitionDraft(prisma, { ctx: sup, requestType: t, companyId: null, definition: def });
      await wf.activateWorkflowDefinition(prisma, { ctx: sup, definitionId: d.result.id });
    }
  }, 600_000);

  afterAll(async () => {
    await leaveTenantDatabase();
    await tenant?.drop().catch(() => undefined);
    await template?.drop().catch(() => undefined);
  }, 120_000);

  // ------------------------------------------------------------------------------------------------
  // Helpers

  async function actorOf(key: string) {
    const u = await prisma.user.findUniqueOrThrow({ where: { id: U[key] }, select: { id: true, role: true } });
    const e = await prisma.employee.findFirst({ where: { userId: u.id }, select: { id: true } });
    return iam.resolveActor(prisma, { id: u.id, role: u.role, employeeId: e?.id ?? null });
  }
  async function ctxOf(key: string) {
    return iam.scopedContext(await actorOf(key));
  }
  const sys = (companyId: string) => iam.systemContext('workflow-test', companyId);

  function request(over: Partial<Req> = {}): Req {
    const r: Req = {
      id: randomUUID(),
      beneficiaries: [E.ben],
      requester: U.emp,
      final: { ok: true },
      canReject: true,
      canReturn: true,
      canCancel: () => true,
      needsConfirm: false,
      failOnApproved: false,
      ...over,
    };
    store.set(r.id, r);
    return r;
  }

  async function start(type: string, r: Req, ctx: unknown = null) {
    return prisma.$transaction((tx: never) => wf.startWorkflow(tx, { ctx: (ctx ?? sys(A)) as never, requestType: type, requestId: r.id }));
  }
  /** Start in a transaction; a concurrent twin that lost the operation-key race retries once (then replays). */
  async function startRetry(type: string, r: Req) {
    try {
      return await start(type, r);
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') return start(type, r);
      throw err;
    }
  }
  const inst = (requestId: string) => prisma.workflowInstance.findUniqueOrThrow({ where: { requestType_requestId: { requestType: findType(requestId), requestId } } });
  const typeOf = new Map<string, string>();
  const findType = (id: string) => typeOf.get(id) as string;
  async function started(type: string, over: Partial<Req> = {}) {
    const r = request(over);
    typeOf.set(r.id, type);
    const res = await start(type, r);
    return { r, res, inst: await inst(r.id) };
  }
  const openTasks = (instanceId: string) => prisma.workflowTask.findMany({ where: { instanceId, status: 'OPEN' }, orderBy: { createdAt: 'asc' } });
  const tasksOf = (instanceId: string) => prisma.workflowTask.findMany({ where: { instanceId }, orderBy: { createdAt: 'asc' } });
  const eventsOf = (instanceId: string) => prisma.domainEvent.findMany({ where: { aggregateType: 'WorkflowInstance', aggregateId: instanceId }, orderBy: { seq: 'asc' } });
  const auditsOf = (instanceId: string) => prisma.auditRecord.findMany({ where: { entityType: 'WorkflowInstance', entityId: instanceId }, orderBy: { seq: 'asc' } });
  const counts = async (instanceId: string) => ({
    tasks: (await tasksOf(instanceId)).length,
    events: (await eventsOf(instanceId)).length,
    audits: (await auditsOf(instanceId)).length,
    version: (await prisma.workflowInstance.findUniqueOrThrow({ where: { id: instanceId } })).version,
  });

  async function act(key: string, taskId: string, decision: string, over: Record<string, unknown> = {}) {
    const t = await prisma.workflowTask.findUniqueOrThrow({ where: { id: taskId }, include: { instance: true } });
    return wf.actOnWorkflowTask(prisma, { ctx: (over.ctx as never) ?? (await ctxOf(key)), taskId, expectedVersion: (over.expectedVersion as number) ?? t.instance.version, decision: decision as never, note: (over.note as string) ?? 'ok', ...(over.idempotencyKey ? { idempotencyKey: over.idempotencyKey as string } : {}) });
  }
  async function refused(p: Promise<unknown>): Promise<{ status: number; code: string }> {
    try {
      await p;
    } catch (err) {
      const e = err as { status?: number; code?: string; details?: { code?: string } };
      return { status: e.status ?? 0, code: e.code ?? e.details?.code ?? (err as Error).name };
    }
    throw new Error('expected a refusal');
  }

  // ------------------------------------------------------------------------------------------------
  // The double call of every exported transition (ARCH-014)

  describe('idempotency: every transition called twice (sequential and concurrent) does its work once', () => {
    it('startWorkflow is idempotent on a double call, sequential and concurrent: one instance, one task, one event set, one audit', async () => {
      const r = request();
      typeOf.set(r.id, 'tests.role');
      const a = await start('tests.role', r);
      const b = await start('tests.role', r);
      expect(b).toEqual(a);
      const i = await inst(r.id);
      expect(i).toMatchObject({ status: 'RUNNING', version: 1, round: 1, companyId: A, beneficiaryEmployeeIds: [E.ben], requesterUserId: U.emp, hasPayEffect: false });
      expect(await counts(i.id)).toEqual({ tasks: 1, events: 1, audits: 1, version: 1 });

      const r2 = request({ beneficiaries: [E.ben2] });
      typeOf.set(r2.id, 'tests.role');
      const [x, y] = await Promise.all([startRetry('tests.role', r2), startRetry('tests.role', r2)]);
      expect(y).toEqual(x);
      const i2 = await inst(r2.id);
      expect(await counts(i2.id)).toEqual({ tasks: 1, events: 1, audits: 1, version: 1 });
    });

    it('actOnWorkflowTask is idempotent on a double call: the replay returns the same result; concurrent twins act once', async () => {
      const { inst: i } = await started('tests.two');
      const [t] = await openTasks(i.id);
      const first = await act('hr1', t.id, 'APPROVE');
      const again = await act('hr1', t.id, 'APPROVE', { expectedVersion: i.version });
      expect(again.replayed).toBe(true);
      expect(again.result).toEqual(first.result);
      const c1 = await counts(i.id);
      expect(c1.tasks).toBe(2);
      const [t2] = await openTasks(i.id);
      const ctx = await ctxOf('hr2');
      const v = (await prisma.workflowInstance.findUniqueOrThrow({ where: { id: i.id } })).version;
      const both = await Promise.all([0, 1].map(() => wf.actOnWorkflowTask(prisma, { ctx, taskId: t2.id, expectedVersion: v, decision: 'APPROVE', note: 'ok' })));
      expect(both.map((o) => o.replayed).sort()).toEqual([false, true]);
      const done = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: i.id } });
      expect(done).toMatchObject({ status: 'APPROVED', closeKind: 'DECIDED', closedByUserId: U.hr2 });
      expect((await eventsOf(i.id)).filter((e: { type: string }) => e.type === 'workflow.instance.decided')).toHaveLength(1);
      expect(hooks.filter((h) => h.requestId === done.requestId && h.hook === 'onApproved')).toHaveLength(1);
    });

    it('cancelWorkflow is idempotent on a double call (sequential replay, concurrent twins): one cancellation, one onCancelled', async () => {
      const { r, inst: i } = await started('tests.role');
      const ctx = await ctxOf('hr1');
      const a = await wf.cancelWorkflow(prisma, { ctx, instanceId: i.id, expectedVersion: i.version, reason: 'withdrawn' });
      const b = await wf.cancelWorkflow(prisma, { ctx, instanceId: i.id, expectedVersion: i.version, reason: 'withdrawn' });
      expect(b.replayed).toBe(true);
      expect(b.result).toEqual(a.result);
      expect(a.result.status).toBe('CANCELLED');
      const c = await counts(i.id);
      // With another key (idempotencyKey) on a terminal instance: NO_CHANGE, nothing written.
      const n = await wf.cancelWorkflow(prisma, { ctx, instanceId: i.id, expectedVersion: c.version, reason: 'again', idempotencyKey: randomUUID() });
      expect(n.result.outcome).toBe('NO_CHANGE');
      expect(await counts(i.id)).toEqual(c);
      expect(hooks.filter((h) => h.requestId === r.id && h.hook === 'onCancelled')).toHaveLength(1);

      const { inst: j } = await started('tests.role');
      const twins = await Promise.all([0, 1].map(() => wf.cancelWorkflow(prisma, { ctx, instanceId: j.id, expectedVersion: j.version, reason: 'withdrawn', idempotencyKey: 'k-' + j.id })));
      expect(twins.map((o) => o.replayed).sort()).toEqual([false, true]);
      expect((await eventsOf(j.id)).filter((e: { type: string }) => e.type === 'workflow.instance.decided')).toHaveLength(1);
    });

    it('pauseWorkflow is idempotent: a double call (and the same reason with another key) pauses once; concurrent twins too', async () => {
      const { inst: i } = await started('tests.role');
      const p = (callerKey: string) => prisma.$transaction((tx: never) => wf.pauseWorkflow(tx, { ctx: sys(A), instanceId: i.id, reason: 'DEFERRAL', callerKey }));
      const a = await p('k1');
      const b = await p('k1');
      expect(b).toEqual(a);
      expect(a).toMatchObject({ status: 'PAUSED', outcome: 'APPLIED' });
      expect((await p('k2')).outcome).toBe('NO_CHANGE'); // the stack is a set
      const now = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: i.id } });
      expect(now).toMatchObject({ status: 'PAUSED', previousStatus: 'RUNNING', pauseReasons: ['DEFERRAL'], version: 2 });
      const second = await Promise.allSettled([p('k3x'), p('k3x')]);
      expect(second.some((s) => s.status === 'fulfilled')).toBe(true);
      expect((await prisma.workflowInstance.findUniqueOrThrow({ where: { id: i.id } })).version).toBe(2);
    });

    it('resumeWorkflow is idempotent: a double call resumes once; the deadlines start again; concurrent twins too', async () => {
      const { inst: i } = await started('tests.role');
      await prisma.$transaction((tx: never) => wf.pauseWorkflow(tx, { ctx: sys(A), instanceId: i.id, reason: 'DEFERRAL', callerKey: 'p' }));
      await prisma.$transaction((tx: never) => wf.pauseWorkflow(tx, { ctx: sys(A), instanceId: i.id, reason: 'SUPERSEDED', callerKey: 'p' }));
      const r = (reason: string, callerKey: string) => prisma.$transaction((tx: never) => wf.resumeWorkflow(tx, { ctx: sys(A), instanceId: i.id, reason, callerKey }));
      const a = await r('SUPERSEDED', 'k');
      expect(await r('SUPERSEDED', 'k')).toEqual(a);
      expect(a.status).toBe('PAUSED'); // DEFERRAL is still on the stack
      expect((await r('SUPERSEDED', 'other')).outcome).toBe('NO_CHANGE');
      const twins = await Promise.allSettled([r('DEFERRAL', 'z'), r('DEFERRAL', 'z')]);
      expect(twins.some((s) => s.status === 'fulfilled')).toBe(true);
      expect(await prisma.workflowInstance.findUniqueOrThrow({ where: { id: i.id } })).toMatchObject({ status: 'RUNNING', previousStatus: null, pauseReasons: [], pausedAt: null, version: 5 });
    });

    it('closeWorkflowExternally is idempotent: one close per instance, a double call replays, another outcome is a key conflict', async () => {
      const { r, inst: i } = await started('tests.role');
      const close = (outcome: 'APPROVED' | 'REJECTED' | 'CANCELLED') =>
        prisma.$transaction((tx: never) => wf.closeWorkflowExternally(tx, { ctx: sys(A), instanceId: i.id, outcome, source: 'WITHDRAWAL', actor: { type: 'SYSTEM', job: 'workflow-test' } }));
      const a = await close('CANCELLED');
      expect(await close('CANCELLED')).toEqual(a);
      expect(a.status).toBe('CANCELLED');
      expect((await refused(close('APPROVED'))).code).toBe('OperationKeyConflictError');
      expect(await prisma.workflowInstance.findUniqueOrThrow({ where: { id: i.id } })).toMatchObject({ closeKind: 'EXTERNAL', closeSource: 'WITHDRAWAL', closedByUserId: null });
      expect(await openTasks(i.id)).toHaveLength(0);
      expect(hooks.filter((h) => h.requestId === r.id && h.hook === 'onCancelled')).toHaveLength(1);
      const { inst: j } = await started('tests.role');
      const c2 = () => prisma.$transaction((tx: never) => wf.closeWorkflowExternally(tx, { ctx: sys(A), instanceId: j.id, outcome: 'REJECTED', source: 'DEEMED', actor: { type: 'SYSTEM', job: 'workflow-test' } }));
      const twins = await Promise.allSettled([c2(), c2()]);
      expect(twins.some((s) => s.status === 'fulfilled')).toBe(true);
      expect((await eventsOf(j.id)).filter((e: { type: string }) => e.type === 'workflow.instance.decided')).toHaveLength(1);
    });

    it('recheckWorkflow is idempotent: AWAITING_REQUIREMENT → APPROVED once (REQUIREMENT_MET), a double call replays', async () => {
      const { r, inst: i } = await started('tests.auto', { final: { awaitable: true, requirement: 'DOCUMENT_MISSING' } });
      expect(i).toMatchObject({ status: 'AWAITING_REQUIREMENT', awaitingRequirement: 'DOCUMENT_MISSING' });
      const rc = (callerKey: string) => prisma.$transaction((tx: never) => wf.recheckWorkflow(tx, { ctx: sys(A), instanceId: i.id, callerKey }));
      expect((await rc('job-1')).outcome).toBe('NO_CHANGE');
      r.final = { ok: true };
      const a = await rc('job-2');
      expect(await rc('job-2')).toEqual(a);
      expect(a.status).toBe('APPROVED');
      expect(await prisma.workflowInstance.findUniqueOrThrow({ where: { id: i.id } })).toMatchObject({ closeKind: 'AUTO_APPROVED', closedByUserId: null });
      expect((await auditsOf(i.id)).map((x: { action: string }) => x.action)).toContain('REQUIREMENT_MET');
      expect(hooks.filter((h) => h.requestId === r.id && h.hook === 'onApproved')).toHaveLength(1);
      expect((await rc('job-3')).outcome).toBe('NO_CHANGE');
    });

    it('resubmitWorkflow is idempotent: a returned request resubmitted twice opens one new round', async () => {
      const { inst: i } = await started('tests.role');
      const [t] = await openTasks(i.id);
      await act('hr1', t.id, 'RETURN', { note: 'missing attachment' });
      expect(await prisma.workflowInstance.findUniqueOrThrow({ where: { id: i.id } })).toMatchObject({ status: 'RETURNED', returns: 1 });
      const rs = () => prisma.$transaction((tx: never) => wf.resubmitWorkflow(tx, { ctx: sys(A), instanceId: i.id }));
      const a = await rs();
      expect(await rs()).toEqual(a);
      expect(a).toMatchObject({ status: 'RUNNING', round: 2, outcome: 'APPLIED' });
      expect((await openTasks(i.id)).map((x: { round: number }) => x.round)).toEqual([2]);
      // Returned again in round 2, then two concurrent resubmits: one new round (3), the twin replays or loses the key race.
      const [t2] = await openTasks(i.id);
      await act('hr2', t2.id, 'RETURN', { note: 'still missing' });
      const twins = await Promise.allSettled([rs(), rs()]);
      expect(twins.every((s) => s.status === 'fulfilled' || (s.reason as { code?: string }).code === 'P2002')).toBe(true);
      expect(twins.some((s) => s.status === 'fulfilled')).toBe(true);
      expect((await openTasks(i.id)).map((x: { round: number }) => x.round)).toEqual([3]);
    });

    it('restartWorkflowRound is idempotent: a double call restarts once (old tasks NOT_REQUIRED, one new round)', async () => {
      const { inst: i } = await started('tests.role');
      const rr = (callerKey: string) => prisma.$transaction((tx: never) => wf.restartWorkflowRound(tx, { ctx: sys(A), instanceId: i.id, reason: 'EDITED', callerKey }));
      const a = await rr('edit-1');
      expect(await rr('edit-1')).toEqual(a);
      expect(a).toMatchObject({ status: 'RUNNING', round: 2 });
      const all = await tasksOf(i.id);
      expect(all.map((t: { round: number; status: string }) => `${t.round}:${t.status}`)).toEqual(['1:NOT_REQUIRED', '2:OPEN']);
      const twins = await Promise.allSettled([rr('edit-2'), rr('edit-2')]);
      expect(twins.some((s) => s.status === 'fulfilled')).toBe(true);
      expect((await openTasks(i.id)).map((t: { round: number }) => t.round)).toEqual([3]);
    });

    it('saveWorkflowDefinitionDraft, activateWorkflowDefinition and retireWorkflowDefinition are idempotent on a double call (and concurrent twins)', async () => {
      const sup = await ctxOf('super');
      const def = { schemaVersion: 1, settings: SETTINGS, root: { type: 'sequence', id: 'root', children: [hrStage('x')] } };
      const save = () => wf.saveWorkflowDefinitionDraft(prisma, { ctx: sup, requestType: 'tests.role', companyId: A, definition: def });
      const [s1, s2] = await Promise.all([save(), save()]);
      expect(s1.result).toEqual(s2.result);
      const s3 = await save();
      expect(s3.replayed).toBe(true);
      expect(await prisma.workflowDefinition.count({ where: { requestType: 'tests.role', companyId: A } })).toBe(1);
      const act1 = await wf.activateWorkflowDefinition(prisma, { ctx: sup, definitionId: s1.result.id });
      const act2 = await wf.activateWorkflowDefinition(prisma, { ctx: sup, definitionId: s1.result.id });
      expect(act2.replayed).toBe(true);
      expect(act1.result.status).toBe('ACTIVE');
      const ret = () => wf.retireWorkflowDefinition(prisma, { ctx: sup, definitionId: s1.result.id });
      const [r1, r2] = await Promise.all([ret(), ret()]);
      expect([r1.replayed, r2.replayed].sort()).toEqual([false, true]);
      expect(r1.result.status).toBe('RETIRED');
      expect(await prisma.auditRecord.count({ where: { entityType: 'WorkflowDefinition', entityId: s1.result.id } })).toBe(3);
    });
  });

  // ------------------------------------------------------------------------------------------------
  // Concurrency and the lock order

  describe('concurrency (§12.11)', () => {
    it('two candidates act concurrently on one task: one APPLIED, the other NO_CHANGE ("already processed")', async () => {
      const { inst: i } = await started('tests.role');
      const [t] = await openTasks(i.id);
      expect([...t.candidateUserIds].sort()).toEqual([U.hr1, U.hr2, U.hr3, U.benHr].sort()); // not vendorHr, leftHr, hrB
      const [x, y] = await Promise.all([act('hr1', t.id, 'APPROVE', { expectedVersion: i.version }), act('hr2', t.id, 'APPROVE', { expectedVersion: i.version })]);
      expect([x.result.outcome, y.result.outcome].sort()).toEqual(['APPLIED', 'NO_CHANGE']);
      expect((await eventsOf(i.id)).filter((e: { type: string }) => e.type === 'workflow.instance.decided')).toHaveLength(1);
    });

    it('a parallel ANY: the first approval completes it, the other branch becomes NOT_REQUIRED', async () => {
      const { inst: i } = await started('tests.any');
      const open = await openTasks(i.id);
      expect(open.map((t: { nodeId: string }) => t.nodeId).sort()).toEqual(['a', 'b']);
      await act('hr1', open.find((t: { nodeId: string }) => t.nodeId === 'a').id, 'APPROVE');
      expect((await tasksOf(i.id)).map((t: { nodeId: string; status: string }) => `${t.nodeId}:${t.status}`).sort()).toEqual(['a:APPROVED', 'b:NOT_REQUIRED']);
      expect((await prisma.workflowInstance.findUniqueOrThrow({ where: { id: i.id } })).status).toBe('APPROVED');
    });

    it('act racing cancel: exactly one wins, the other is NO_CHANGE or a retryable 409', async () => {
      const { inst: i } = await started('tests.role');
      const [t] = await openTasks(i.id);
      const res = await Promise.allSettled([act('hr1', t.id, 'APPROVE', { expectedVersion: i.version }), wf.cancelWorkflow(prisma, { ctx: await ctxOf('hr2'), instanceId: i.id, expectedVersion: i.version, reason: 'x' })]);
      const now = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: i.id } });
      expect(['APPROVED', 'CANCELLED']).toContain(now.status);
      const outcomes = res.map((s) => (s.status === 'fulfilled' ? s.value.result.outcome : (s.reason as { code: string }).code));
      expect(outcomes.filter((o) => o === 'APPLIED')).toHaveLength(1);
      expect(outcomes.every((o) => ['APPLIED', 'NO_CHANGE', 'WFE_CONFLICT'].includes(o))).toBe(true);
      expect((await eventsOf(i.id)).filter((e: { type: string }) => e.type === 'workflow.instance.decided')).toHaveLength(1);
    });

    it('act on a PAUSED instance is a 409 and changes nothing', async () => {
      const { inst: i } = await started('tests.role');
      await prisma.$transaction((tx: never) => wf.pauseWorkflow(tx, { ctx: sys(A), instanceId: i.id, reason: 'DEFERRAL', callerKey: 'p' }));
      const [t] = await openTasks(i.id);
      const c = await counts(i.id);
      expect(await refused(act('hr1', t.id, 'APPROVE'))).toEqual({ status: 409, code: 'WFE_INVALID_STATE' });
      expect(await counts(i.id)).toEqual(c);
    });

    it('a stale expectedVersion is a retryable 409 on an open task, NO_CHANGE on a decided one', async () => {
      const { inst: i } = await started('tests.two');
      const [t] = await openTasks(i.id);
      await prisma.$transaction((tx: never) => wf.recheckWorkflow(tx, { ctx: sys(A), instanceId: i.id, callerKey: 'noop' }));
      await prisma.$transaction((tx: never) => wf.pauseWorkflow(tx, { ctx: sys(A), instanceId: i.id, reason: 'DEFERRAL', callerKey: 'p' }));
      await prisma.$transaction((tx: never) => wf.resumeWorkflow(tx, { ctx: sys(A), instanceId: i.id, reason: 'DEFERRAL', callerKey: 'p' }));
      let err: unknown;
      try {
        await act('hr1', t.id, 'APPROVE', { expectedVersion: i.version });
      } catch (e) {
        err = e;
      }
      expect(err).toMatchObject({ status: 409, code: 'WFE_CONFLICT', details: { retryable: true } });
      await act('hr1', t.id, 'APPROVE');
      const late = await act('hr2', t.id, 'APPROVE', { expectedVersion: i.version });
      expect(late.result.outcome).toBe('NO_CHANGE');
    });

    it('two starts with beneficiaries {e1, e2} given in opposite order both complete (one lock order, no deadlock)', async () => {
      const r1 = request({ beneficiaries: [E.ben, E.ben2] });
      const r2 = request({ beneficiaries: [E.ben2, E.ben] });
      typeOf.set(r1.id, 'tests.role');
      typeOf.set(r2.id, 'tests.role');
      const [a, b] = await Promise.all([start('tests.role', r1), start('tests.role', r2)]);
      expect([a.status, b.status]).toEqual(['RUNNING', 'RUNNING']);
      expect((await inst(r1.id)).beneficiaryEmployeeIds).toEqual([E.ben, E.ben2].sort());
    });

    it('the spy: lockEmployees (ascending) runs before adapter.lockKeys and before any workflow write', async () => {
      order.length = 0;
      const r = request({ beneficiaries: [E.ben2, E.ben] });
      typeOf.set(r.id, 'tests.role');
      await start('tests.role', r);
      expect(order.slice(0, 2)).toEqual([`lock:${[E.ben, E.ben2].sort().join(',')}`, 'lockKeys']);
      const i = await inst(r.id);
      const [t] = await openTasks(i.id);
      order.length = 0;
      await act('hr1', t.id, 'APPROVE');
      expect(order.slice(0, 2)).toEqual([`lock:${[E.ben, E.ben2].sort().join(',')}`, 'lockKeys']);
    });
  });

  // ------------------------------------------------------------------------------------------------
  // Company scope (guardrail 6)

  describe('company scope (real iam contexts)', () => {
    it('allow: a same-company candidate; deny: a same-company non-candidate (403); the beneficiary is never a candidate', async () => {
      const { inst: i } = await started('tests.role', { beneficiaries: [E.benHrEmp], requester: U.hr3 });
      const [t] = await openTasks(i.id);
      expect(t.candidateUserIds).not.toContain(U.benHr); // G1: the HR login of the beneficiary
      expect(t.candidateUserIds).not.toContain(U.hr3); // G1b: the requester
      expect(t.candidateUserIds).not.toContain(U.vendorHr); // G9: a Radeef vendor account
      expect(t.candidateUserIds).not.toContain(U.leftHr); // G9: the login of a TERMINATED employee
      expect(t.candidateUserIds).not.toContain(U.hrB); // another company
      expect(t.candidateUserIds).toEqual([U.hr1, U.hr2].sort());
      expect(await refused(act('ownerA', t.id, 'APPROVE'))).toEqual({ status: 403, code: 'WFE_FORBIDDEN' });
      expect((await act('hr1', t.id, 'APPROVE')).result.status).toBe('APPROVED');
    });

    it('other company: act, timeline and inbox give 404 / no rows', async () => {
      const { inst: i } = await started('tests.role');
      const [t] = await openTasks(i.id);
      const ctxB = await ctxOf('hrB');
      expect(await refused(act('hrB', t.id, 'APPROVE', { ctx: ctxB }))).toEqual({ status: 404, code: 'WFE_NOT_FOUND' });
      expect(await refused(wf.timelineOf(prisma, ctxB, i.id))).toEqual({ status: 404, code: 'WFE_NOT_FOUND' });
      expect((await wf.tasksForUser(prisma, ctxB)).map((x: { id: string }) => x.id)).not.toContain(t.id);
      expect(await wf.instanceOf(prisma, ctxB, 'tests.role', i.requestId)).toBeNull();
      expect(await refused(wf.cancelWorkflow(prisma, { ctx: ctxB, instanceId: i.id, expectedVersion: i.version, reason: 'x' }))).toEqual({ status: 404, code: 'WFE_NOT_FOUND' });
      expect(await refused(prisma.$transaction((tx: never) => wf.pauseWorkflow(tx, { ctx: sys(B), instanceId: i.id, reason: 'DEFERRAL', callerKey: 'x' })))).toEqual({ status: 404, code: 'WFE_NOT_FOUND' });
      // The inbox of a same-company candidate lists it.
      expect((await wf.tasksForUser(prisma, await ctxOf('hr1'))).map((x: { id: string }) => x.id)).toContain(t.id);
    });

    it('a Self context sees only its own instances (beneficiary or requester); a Team context its manager view', async () => {
      const mine = await started('tests.role', { beneficiaries: [E.ben], requester: U.emp });
      const other = await started('tests.role', { beneficiaries: [E.ben2], requester: U.hr3 });
      const empActor = await actorOf('emp');
      const self = iam.selfContext(empActor, { legalCompanyId: A });
      const seen = (await wf.instancesFor(prisma, self)).map((x: { id: string }) => x.id);
      expect(seen).toContain(mine.inst.id);
      expect(seen).not.toContain(other.inst.id);
      expect(await refused(wf.timelineOf(prisma, self, other.inst.id))).toEqual({ status: 404, code: 'WFE_NOT_FOUND' });
      expect((await wf.timelineOf(prisma, self, mine.inst.id)).tasks).toHaveLength(1);
      // The beneficiary cannot act on his own request whatever context he uses.
      const [t] = await openTasks(mine.inst.id);
      expect((await refused(act('emp', t.id, 'APPROVE', { ctx: self }))).status).toBe(403);

      const chain = await started('tests.chain', { beneficiaries: [E.ben], requester: U.hr3 });
      const mgrActor = await actorOf('mgr');
      const team = iam.teamContext(mgrActor, { legalCompanyId: A });
      const [lvl] = await openTasks(chain.inst.id);
      expect(lvl).toMatchObject({ nodeId: 'mgr.L1', candidateUserIds: [U.mgr] });
      expect((await wf.instancesFor(prisma, team)).map((x: { id: string }) => x.id)).toContain(chain.inst.id);
      expect((await wf.instancesFor(prisma, team)).map((x: { id: string }) => x.id)).not.toContain(other.inst.id);
      expect((await act('mgr', lvl.id, 'APPROVE', { ctx: team })).result.status).toBe('RUNNING');
      const [hr] = await openTasks(chain.inst.id);
      expect(hr.nodeId).toBe('hr');
      expect(hr.dueAt).not.toBeNull(); // the deadline from the company calendar (WorkingDaysPort)
    });

    it('a System context of one company works only on that company; beneficiaries of two companies are refused (WFE_CROSS_COMPANY / 403)', async () => {
      const both = request({ beneficiaries: [E.ben, E.benB] });
      typeOf.set(both.id, 'tests.role');
      const sup = await ctxOf('super');
      expect((await refused(start('tests.role', both, sup))).code).toBe('WFE_CROSS_COMPANY');
      expect((await refused(start('tests.role', both, sys(A)))).status).toBe(403); // ben of B is outside the context
      expect(await prisma.workflowInstance.count({ where: { requestId: both.id } })).toBe(0);
      const inB = request({ beneficiaries: [E.benB], requester: null });
      typeOf.set(inB.id, 'tests.role');
      expect((await refused(start('tests.role', inB, sys(A)))).status).toBe(403);
      const ok = await start('tests.role', inB, sys(B));
      expect(ok.status).toBe('RUNNING');
      const [t] = await openTasks(ok.instanceId);
      expect(t.candidateUserIds).toEqual([U.hrB]);
      expect(t.companyId).toBe(B);
    });

    it('the tenant definition serves both companies; a company definition overrides it for its company only', async () => {
      const sup = await ctxOf('super');
      const def = { schemaVersion: 1, settings: SETTINGS, root: { type: 'sequence', id: 'root', children: [{ type: 'stage', id: 'own', approver: { kind: 'ROLE', role: 'COMPANY_ADMIN' } }] } };
      const d = await wf.saveWorkflowDefinitionDraft(prisma, { ctx: sup, requestType: 'tests.legal', companyId: B, definition: def });
      await wf.activateWorkflowDefinition(prisma, { ctx: sup, definitionId: d.result.id });
      expect((await wf.activeDefinitionFor(prisma, 'tests.legal', B))?.id).toBe(d.result.id);
      expect((await wf.activeDefinitionFor(prisma, 'tests.legal', A))?.companyId).toBeNull();
      // An editor whose context is narrowed to A cannot edit B's or the tenant's definitions (G7 + scope: 404).
      // (COMPANY_ADMIN is an owner role in iam: its own context covers every company.)
      const onlyA = iam.scopedContext(await actorOf('ownerA'), [A]);
      expect((await refused(wf.saveWorkflowDefinitionDraft(prisma, { ctx: onlyA, requestType: 'tests.legal', companyId: B, definition: def }))).status).toBe(404);
      expect((await refused(wf.saveWorkflowDefinitionDraft(prisma, { ctx: onlyA, requestType: 'tests.legal', companyId: null, definition: def }))).status).toBe(404);
      // A Radeef vendor account is never an editor, whatever its role (G7).
      const vendorOwner = await prisma.user.create({ data: { email: `vo-${tag}@example.test`, passwordHash: 'x', role: 'SUPER_ADMIN' } });
      await fx.identityFixture(vendorOwner.id, { isVendorStaff: true });
      const vctx = iam.scopedContext(await iam.resolveActor(prisma, { id: vendorOwner.id, role: 'SUPER_ADMIN', employeeId: null }));
      expect((await refused(wf.saveWorkflowDefinitionDraft(prisma, { ctx: vctx, requestType: 'tests.legal', companyId: A, definition: def }))).status).toBe(403);
      // An HR manager is no editor (G7).
      expect((await refused(wf.saveWorkflowDefinitionDraft(prisma, { ctx: await ctxOf('hr1'), requestType: 'tests.legal', companyId: A, definition: def }))).status).toBe(403);
    });

    it('the delegation filter: companyIds hasSome the context companies; Self sees its own grants only', async () => {
      const now = new Date();
      const later = new Date(now.getTime() + 86_400_000 * 10);
      const dA = await prisma.approvalDelegation.create({ data: { fromUserId: U.hr1, toUserId: U.hr2, createdById: U.hr1, companyIds: [A], startsAt: now, endsAt: later } });
      const dB = await prisma.approvalDelegation.create({ data: { fromUserId: U.hrB, toUserId: U.super, createdById: U.hrB, companyIds: [B], startsAt: now, endsAt: later } });
      const inA = (await wf.delegationsFor(prisma, await ctxOf('hr3'))).map((x: { id: string }) => x.id);
      expect(inA).toContain(dA.id);
      expect(inA).not.toContain(dB.id);
      const self = iam.selfContext(await actorOf('emp'), { legalCompanyId: A });
      expect(await wf.delegationsFor(prisma, self)).toEqual([]);
      expect(wf.canWriteDelegations(self)).toBe(false);
    });
  });

  // ------------------------------------------------------------------------------------------------
  // Separation of duties, self-approval, eligibility (DEC-PO-145) and INV-IAM-01 (ADR-0010)

  describe('INV-IAM-01 / DEC-PO-145: no one approves his own request or widens his own authority through the engine', () => {
    it('G1 / G1b at act time on current data: a login linked to the beneficiary AFTER the task was opened cannot act', async () => {
      const t0 = randomBytes(3).toString('hex');
      const e = await fx.employeeFixture({
        employeeId: `WFE-L${t0}`, firstNameArabic: 'م', lastNameArabic: 'late', nationality: 'SA', iqamaOrIdNumber: `WFEL${t0}`, iqamaOrIdExp: new Date('2030-01-01'),
        dateOfBirth: new Date('1990-01-01'), gender: 'M', joinDate: new Date('2024-01-01'), basicSalary: 5000, legalCompanyId: A,
      });
      const { inst: i } = await started('tests.role', { beneficiaries: [e.id], requester: U.emp });
      const [t] = await openTasks(i.id);
      expect(t.candidateUserIds).toContain(U.hr3);
      await fx.linkFixture(U.hr3, e.id); // hr3's login now IS the beneficiary
      expect(await refused(act('hr3', t.id, 'APPROVE'))).toEqual({ status: 403, code: 'WFE_SELF_ACTION' });
      expect((await prisma.workflowTask.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('OPEN');
      await fx.moneyFixture(async (tx) => {
        await tx.employee.update({ where: { id: e.id }, data: { userId: null } });
        await tx.userEmployeeLink.deleteMany({ where: { userId: U.hr3, employeeId: e.id } });
      });
    });

    it('the requester never approves, even when he holds the stage role (G1b), nor rejects through rejectAuthority', async () => {
      const { inst: i } = await started('tests.role', { requester: U.hr1 });
      const [t] = await openTasks(i.id);
      expect(t.candidateUserIds).not.toContain(U.hr1);
      expect(await refused(act('hr1', t.id, 'APPROVE'))).toEqual({ status: 403, code: 'WFE_FORBIDDEN' });
      expect(await refused(act('hr1', t.id, 'REJECT', { note: 'no' }))).toEqual({ status: 403, code: 'WFE_SELF_ACTION' });
    });

    it('a role downgraded, a company scope narrowed or an account deactivated after the task was opened: the act is refused (live iam)', async () => {
      const { inst: i } = await started('tests.role');
      const [t] = await openTasks(i.id);
      expect(t.candidateUserIds).toEqual(expect.arrayContaining([U.hr1, U.hr2, U.hr3]));
      const ctx2 = await ctxOf('hr2');
      const ctx3 = await ctxOf('hr3');
      const ctx1 = await ctxOf('hr1');
      await fx.identityFixture(U.hr2, { role: 'EMPLOYEE' });
      await fx.moneyFixture(async (tx) => {
        await tx.userCompanyScope.deleteMany({ where: { userId: U.hr3 } });
        await tx.userCompanyScope.create({ data: { userId: U.hr3, companyId: B } });
      });
      await fx.identityFixture(U.hr1, { isActive: false });
      try {
        // The sessions still say HR_MANAGER in A: the engine reads iam again.
        expect((await refused(wf.actOnWorkflowTask(prisma, { ctx: ctx2, taskId: t.id, expectedVersion: i.version, decision: 'APPROVE' }))).status).toBe(403);
        expect((await refused(wf.actOnWorkflowTask(prisma, { ctx: ctx1, taskId: t.id, expectedVersion: i.version, decision: 'APPROVE' }))).status).toBe(403);
        expect((await refused(wf.actOnWorkflowTask(prisma, { ctx: ctx3, taskId: t.id, expectedVersion: i.version, decision: 'APPROVE' }))).status).toBe(403);
        expect((await prisma.workflowTask.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('OPEN');
      } finally {
        await fx.identityFixture(U.hr2, { role: 'HR_MANAGER' });
        await fx.identityFixture(U.hr1, { isActive: true });
        await fx.moneyFixture(async (tx) => {
          await tx.userCompanyScope.deleteMany({ where: { userId: U.hr3 } });
          await tx.userCompanyScope.create({ data: { userId: U.hr3, companyId: A } });
        });
      }
    });

    it('a delegation row (even one a user grants himself through another) never makes anyone a candidate in package B', async () => {
      const now = new Date();
      await prisma.approvalDelegation.create({ data: { fromUserId: U.legal, toUserId: U.emp, createdById: U.legal, companyIds: [A], startsAt: new Date(now.getTime() - 3_600_000), endsAt: new Date(now.getTime() + 86_400_000) } });
      const { inst: i } = await started('tests.legal', { beneficiaries: [E.ben2], requester: U.hr3 });
      const [t] = await openTasks(i.id);
      expect(t.candidateUserIds).toEqual([U.legal]);
      expect(await refused(act('emp', t.id, 'APPROVE', { ctx: iam.selfContext(await actorOf('emp'), { legalCompanyId: A }) }))).toEqual({ status: 403, code: 'WFE_FORBIDDEN' });
    });

    it('an adapter guard can only narrow: a guard returning ok does not bring back the beneficiary, the requester or a vendor account', async () => {
      const { inst: i } = await started('tests.legal', { beneficiaries: [E.ben], requester: U.legal });
      const [t] = await openTasks(i.id);
      // The only LEGAL_ADMIN is the requester: cover (no coverRole) → the owner group (super; ownerA), never legal.
      expect(t.candidateUserIds).not.toContain(U.legal);
      expect(t.coverReason).toBe('APPROVER_UNAVAILABLE');
      expect([...t.candidateUserIds].sort()).toEqual([U.super, U.ownerA].sort());
      expect((t.candidatesSnapshotJson as { via: string }[]).every((c) => c.via === 'OWNER_COVER')).toBe(true);
    });

    it('REJECT_PAIR: the first rejection opens one pair task without the first rejecter, who cannot confirm it; another holder confirms', async () => {
      const { r, inst: i } = await started('tests.pair');
      const [t] = await openTasks(i.id);
      const first = await act('hr1', t.id, 'REJECT', { note: 'incomplete' });
      expect(first.result.status).toBe('RUNNING');
      const pair = (await openTasks(i.id)).find((x: { kind: string }) => x.kind === 'REJECT_PAIR');
      expect(pair.candidateUserIds).not.toContain(U.hr1);
      expect(pair.candidateUserIds).toEqual(expect.arrayContaining([U.hr2, U.ownerA]));
      expect(await refused(act('hr1', pair.id, 'CONFIRM', { note: 'again' }))).toMatchObject({ status: 403 });
      expect(await refused(act('hr1', t.id, 'REJECT', { note: 'twice' }))).toEqual({ status: 409, code: 'WFE_INVALID_STATE' });
      const done = await act('hr2', pair.id, 'CONFIRM', { note: 'agreed' });
      expect(done.result.status).toBe('REJECTED');
      expect(hooks.filter((h) => h.requestId === r.id && h.hook === 'onRejected')).toHaveLength(1);
      expect((await tasksOf(i.id)).map((x: { kind: string; status: string }) => `${x.kind}:${x.status}`).sort()).toEqual(['APPROVE:NOT_REQUIRED', 'REJECT_PAIR:APPROVED']);
    });

    it('distinctFromPrior and the G2b siblings of a parallel ALL: one person never approves two of the steps', async () => {
      const two = await started('tests.two');
      const [s1] = await openTasks(two.inst.id);
      await act('hr1', s1.id, 'APPROVE');
      const [s2] = await openTasks(two.inst.id);
      expect(s2.candidateUserIds).not.toContain(U.hr1);
      expect(await refused(act('hr1', s2.id, 'APPROVE'))).toMatchObject({ status: 403 });

      const all = await started('tests.all');
      const [a, b] = await openTasks(all.inst.id);
      await act('hr1', a.id, 'APPROVE');
      expect(await refused(act('hr1', b.id, 'APPROVE'))).toEqual({ status: 403, code: 'WFE_SELF_ACTION' });
      expect((await act('hr2', b.id, 'APPROVE')).result.status).toBe('APPROVED');
    });

    it('closeExternally by a person: the beneficiary\'s login and the requester are refused (strict G1 / G1b); an eligible HR closes', async () => {
      const { inst: i } = await started('tests.role', { beneficiaries: [E.benHrEmp], requester: U.hr3 });
      const close = (key: string) =>
        ctxOf(key).then((ctx) => prisma.$transaction((tx: never) => wf.closeWorkflowExternally(tx, { ctx, instanceId: i.id, outcome: 'APPROVED', source: 'DEEMED', actor: { type: 'USER', userId: U[key] } })));
      expect(await refused(close('benHr'))).toEqual({ status: 403, code: 'WFE_SELF_ACTION' });
      expect(await refused(close('hr3'))).toEqual({ status: 403, code: 'WFE_SELF_ACTION' });
      // A USER actor that is not the context's login is refused before anything.
      const ctx = await ctxOf('hr1');
      expect((await refused(prisma.$transaction((tx: never) => wf.closeWorkflowExternally(tx, { ctx, instanceId: i.id, outcome: 'APPROVED', source: 'DEEMED', actor: { type: 'USER', userId: U.hr2 } })))).status).toBe(403);
      expect((await close('hr1')).status).toBe('APPROVED');
    });

    it('when every eligible person is excluded the step is BLOCKED (no silent skip, no self-approval), and recheck unblocks it when someone qualifies', async () => {
      const { inst: i } = await started('tests.legal', { beneficiaries: [E.ben], requester: U.super });
      // legal is the candidate; make him ineligible and recheck: cover = owner group minus the requester (super) = ownerA.
      await fx.identityFixture(U.legal, { isActive: false });
      await fx.identityFixture(U.ownerA, { isActive: false });
      try {
        const rc = await prisma.$transaction((tx: never) => wf.recheckWorkflow(tx, { ctx: sys(A), instanceId: i.id, callerKey: 'block' }));
        expect(rc.status).toBe('BLOCKED');
        expect(await prisma.workflowInstance.findUniqueOrThrow({ where: { id: i.id } })).toMatchObject({ blockedReason: 'NO_CANDIDATE' });
        expect((await eventsOf(i.id)).map((e: { type: string }) => e.type)).toContain('workflow.instance.blocked');
        const [t] = await openTasks(i.id);
        expect(t.candidateUserIds).toEqual([]);
      } finally {
        await fx.identityFixture(U.legal, { isActive: true });
        await fx.identityFixture(U.ownerA, { isActive: true });
      }
      const back = await prisma.$transaction((tx: never) => wf.recheckWorkflow(tx, { ctx: sys(A), instanceId: i.id, callerKey: 'unblock' }));
      expect(back.status).toBe('RUNNING');
      expect((await openTasks(i.id))[0].candidateUserIds).toEqual([U.legal]);
    });
  });

  // ------------------------------------------------------------------------------------------------
  // Findings of the independent security review of package B (each failed before its fix)

  describe('security review fixes (H-1, M-2, L-3)', () => {
    it('H-1: closeExternally with a SYSTEM actor from a person\'s context (Self, Scoped) or another job is refused; the instance is unchanged', async () => {
      const { inst: i } = await started('tests.role', { beneficiaries: [E.ben], requester: U.emp });
      const self = iam.selfContext(await actorOf('emp'), { legalCompanyId: A });
      const asJob = (ctx: unknown, job: string) =>
        prisma.$transaction((tx: never) => wf.closeWorkflowExternally(tx, { ctx: ctx as never, instanceId: i.id, outcome: 'APPROVED', source: 'DEEMED', actor: { type: 'SYSTEM', job } }));
      expect(await refused(asJob(self, 'workflow-test'))).toEqual({ status: 403, code: 'WFE_FORBIDDEN' });
      expect(await refused(asJob(await ctxOf('hr1'), 'workflow-test'))).toEqual({ status: 403, code: 'WFE_FORBIDDEN' });
      expect(await refused(asJob(sys(A), 'another-job'))).toEqual({ status: 403, code: 'WFE_FORBIDDEN' });
      const now = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: i.id } });
      expect(now).toMatchObject({ status: 'RUNNING', version: i.version, closedAt: null });
      expect(await prisma.operationLog.count({ where: { operationKey: `wf:close:${i.id}` } })).toBe(0);
      // The job of the SystemContext itself still closes.
      expect((await asJob(sys(A), 'workflow-test')).status).toBe('APPROVED');
    });

    it('M-2: a manager replaced after the task was opened no longer approves; recheck reassigns the level to the new manager (snapshot updated, audited)', async () => {
      const t0 = randomBytes(3).toString('hex');
      const mk = async (key: string) =>
        (
          await fx.employeeFixture({
            employeeId: `WFE-M${key}${t0}`, firstNameArabic: 'م', lastNameArabic: key, nationality: 'SA', iqamaOrIdNumber: `WFEM${key}${t0}`, iqamaOrIdExp: new Date('2030-01-01'),
            dateOfBirth: new Date('1990-01-01'), gender: 'M', joinDate: new Date('2024-01-01'), basicSalary: 5000, legalCompanyId: A,
          })
        ).id;
      const platform = await import('@/modules/platform');
      const benM = await mk('b');
      const newMgrEmp = await mk('n');
      const newMgr = (await prisma.user.create({ data: { email: `mgr2-${t0}@example.test`, passwordHash: 'x', role: 'DEPT_MANAGER' } })).id;
      await fx.moneyFixture((tx) => tx.userCompanyScope.create({ data: { userId: newMgr, companyId: A } }));
      await fx.linkFixture(newMgr, newMgrEmp);
      await prisma.$transaction((tx: never) => platform.openLegacyPeriod(tx, 'ASSIGNMENT', { employeeId: benM, validFrom: '2024-01-01', attrs: { legalCompanyId: A, managerId: E.mgrEmp } }, { type: 'SYSTEM', id: 'test' }));
      const { inst: i } = await started('tests.chain', { beneficiaries: [benM], requester: U.hr3 });
      const [lvl] = await openTasks(i.id);
      expect(lvl.candidateUserIds).toEqual([U.mgr]);
      // The beneficiary's manager changes (a correction of the assignment in force).
      const period = await platform.activeAt(prisma, 'ASSIGNMENT', benM, '2024-06-01');
      await prisma.$transaction((tx: never) =>
        platform.supersedePeriod(tx, 'ASSIGNMENT', period!.id, { reason: 'CORRECTION', source: { type: 'TEST', id: t0 }, successor: { attrs: { managerId: newMgrEmp } } }, { key: `test:mgr:${t0}`, actor: { type: 'SYSTEM', id: 'test' } }),
      );
      const team = iam.teamContext(await actorOf('mgr'), { legalCompanyId: A });
      expect(await refused(act('mgr', lvl.id, 'APPROVE', { ctx: team }))).toEqual({ status: 403, code: 'WFE_FORBIDDEN' });
      expect((await prisma.workflowTask.findUniqueOrThrow({ where: { id: lvl.id } })).status).toBe('OPEN');
      const rc = await prisma.$transaction((tx: never) => wf.recheckWorkflow(tx, { ctx: sys(A), instanceId: i.id, callerKey: `mgr-${t0}` }));
      expect(rc.outcome).toBe('APPLIED');
      expect((await prisma.workflowTask.findUniqueOrThrow({ where: { id: lvl.id } })).candidateUserIds).toEqual([newMgr]);
      const snap = (await prisma.workflowInstance.findUniqueOrThrow({ where: { id: i.id } })).managerChainSnapshot as { employeeId: string }[];
      expect(snap[0].employeeId).toBe(newMgrEmp);
      const audit = (await auditsOf(i.id)).find((a: { action: string }) => a.action === 'workflow.instance.recheck');
      expect((audit.after as { managerChain?: unknown }).managerChain).toBeDefined();
      U.mgr2 = newMgr;
      const r = await wf.actOnWorkflowTask(prisma, { ctx: iam.teamContext(await actorOf('mgr2'), { legalCompanyId: A }), taskId: lvl.id, expectedVersion: rc.version, decision: 'APPROVE' });
      expect(r.result.status).toBe('RUNNING');
    });

    it('M-2: the manager\'s login relinked to another employee no longer approves the level of the first one', async () => {
      const { inst: i } = await started('tests.chain', { beneficiaries: [E.ben2], requester: U.hr3 });
      const [lvl] = await openTasks(i.id);
      expect(lvl.candidateUserIds).toEqual([U.mgr]);
      const ctx = iam.teamContext(await actorOf('mgr'), { legalCompanyId: A });
      const t0 = randomBytes(3).toString('hex');
      const other = await fx.employeeFixture({
        employeeId: `WFE-R${t0}`, firstNameArabic: 'م', lastNameArabic: 'r', nationality: 'SA', iqamaOrIdNumber: `WFER${t0}`, iqamaOrIdExp: new Date('2030-01-01'),
        dateOfBirth: new Date('1990-01-01'), gender: 'M', joinDate: new Date('2024-01-01'), basicSalary: 5000, legalCompanyId: A,
      });
      await fx.moneyFixture(async (tx) => {
        await tx.employee.update({ where: { id: E.mgrEmp }, data: { userId: null } });
        await tx.userEmployeeLink.deleteMany({ where: { userId: U.mgr, employeeId: E.mgrEmp } });
      });
      await fx.linkFixture(U.mgr, other.id);
      try {
        expect(await refused(act('mgr', lvl.id, 'APPROVE', { ctx }))).toEqual({ status: 403, code: 'WFE_FORBIDDEN' });
        expect((await prisma.workflowTask.findUniqueOrThrow({ where: { id: lvl.id } })).status).toBe('OPEN');
      } finally {
        await fx.moneyFixture(async (tx) => {
          await tx.employee.update({ where: { id: other.id }, data: { userId: null } });
          await tx.userEmployeeLink.deleteMany({ where: { userId: U.mgr, employeeId: other.id } });
        });
        await fx.linkFixture(U.mgr, E.mgrEmp);
      }
    });

    it('L-3: a second person replaying a closeExternally or resubmit key gets a conflict, not the first caller\'s APPLIED result', async () => {
      const { inst: i } = await started('tests.role', { beneficiaries: [E.ben2], requester: U.emp });
      const close = (key: string) =>
        ctxOf(key).then((ctx) => prisma.$transaction((tx: never) => wf.closeWorkflowExternally(tx, { ctx, instanceId: i.id, outcome: 'APPROVED', source: 'DEEMED', actor: { type: 'USER', userId: U[key] } })));
      expect((await close('hr1')).outcome).toBe('APPLIED');
      expect((await close('hr1')).outcome).toBe('APPLIED'); // the same person: a replay
      expect((await refused(close('hr2'))).code).toBe('OperationKeyConflictError');

      const { inst: j } = await started('tests.role', { beneficiaries: [E.ben2], requester: U.emp });
      const [t] = await openTasks(j.id);
      await act('hr1', t.id, 'RETURN', { note: 'fix' });
      const resubmit = (ctx: unknown) => prisma.$transaction((tx: never) => wf.resubmitWorkflow(tx, { ctx: ctx as never, instanceId: j.id }));
      expect((await resubmit(await ctxOf('hr1'))).outcome).toBe('APPLIED');
      expect((await refused(resubmit(await ctxOf('hr2')))).code).toBe('OperationKeyConflictError');
    });
  });

  // ------------------------------------------------------------------------------------------------
  // Paths, events and effects

  describe('paths, events and effects', () => {
    it('the automatic path: zero stages and validateFinal ok → APPROVED (AUTO_APPROVED_BY_DEFINITION), onApproved, one decided event', async () => {
      const { r, inst: i } = await started('tests.auto');
      expect(i).toMatchObject({ status: 'APPROVED', closeKind: 'AUTO_APPROVED' });
      expect((await auditsOf(i.id)).map((a: { action: string }) => a.action)).toEqual(['workflow.instance.start', 'AUTO_APPROVED_BY_DEFINITION']);
      expect((await eventsOf(i.id)).map((e: { type: string }) => e.type)).toEqual(['workflow.instance.decided']);
      expect(hooks.filter((h) => h.requestId === r.id)).toEqual([{ type: 'tests.auto', hook: 'onApproved', requestId: r.id }]);
      const bad = request({ final: { error: 'not allowed' } });
      typeOf.set(bad.id, 'tests.auto');
      expect((await refused(start('tests.auto', bad))).code).toBe('WFE_VALIDATION');
      expect(await prisma.workflowInstance.count({ where: { requestId: bad.id } })).toBe(0);
    });

    it('each transition emits exactly its events, with unique keys and the company', async () => {
      const { inst: i } = await started('tests.chain');
      const [l1] = await openTasks(i.id);
      await act('mgr', l1.id, 'APPROVE', { ctx: iam.teamContext(await actorOf('mgr'), { legalCompanyId: A }) });
      const [hr] = await openTasks(i.id);
      await act('hr1', hr.id, 'RETURN', { note: 'fix' });
      const ev = await eventsOf(i.id);
      expect(ev.map((e: { type: string }) => e.type)).toEqual(['workflow.task.assigned', 'workflow.task.assigned', 'workflow.instance.returned']);
      expect(new Set(ev.map((e: { idempotencyKey: string }) => e.idempotencyKey)).size).toBe(ev.length);
      expect(ev.every((e: { companyId: string; payload: { companyId: string } }) => e.companyId === A && e.payload.companyId === A)).toBe(true);
      expect(ev[2].payload).toMatchObject({ round: 1, requesterUserId: U.emp });
    });

    it('a persistent onApproved failure: the task stays OPEN, effectFailedAt is written in a separate transaction and effectFailed is emitted once on a double call', async () => {
      const { inst: i } = await started('tests.role', { failOnApproved: true });
      const [t] = await openTasks(i.id);
      expect((await refused(act('hr1', t.id, 'APPROVE'))).code).toBe('WFE_EFFECT_FAILED');
      expect((await prisma.workflowTask.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('OPEN');
      const after = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: i.id } });
      expect(after).toMatchObject({ status: 'RUNNING', version: i.version + 1 });
      expect(after.effectFailedAt).not.toBeNull();
      expect(after.lastEffectError).toContain('downstream refused');
      // The same call again (same key): the version moved, so a retryable 409; no second effectFailed event.
      expect((await refused(act('hr1', t.id, 'APPROVE', { expectedVersion: i.version }))).code).toBe('WFE_CONFLICT');
      expect((await eventsOf(i.id)).filter((e: { type: string }) => e.type === 'workflow.instance.effectFailed')).toHaveLength(1);
      expect((await auditsOf(i.id)).map((a: { action: string }) => a.action)).toContain('workflow.instance.effectFailed');
    });

    it('cancel with cancelNeedsConfirm: PAUSED(CANCEL_REQUESTED) + one CANCEL_CONFIRM for the stage candidates minus the canceller; a second request is refused; confirm cancels', async () => {
      const { r, inst: i } = await started('tests.role', { needsConfirm: true });
      const asked = await wf.cancelWorkflow(prisma, { ctx: await ctxOf('hr1'), instanceId: i.id, expectedVersion: i.version, reason: 'duplicate' });
      expect(asked.result.status).toBe('PAUSED');
      const cc = (await openTasks(i.id)).find((x: { kind: string }) => x.kind === 'CANCEL_CONFIRM');
      expect(cc.candidateUserIds).not.toContain(U.hr1);
      expect(cc.candidateUserIds).toEqual(expect.arrayContaining([U.hr2, U.hr3]));
      expect((await refused(wf.cancelWorkflow(prisma, { ctx: await ctxOf('hr2'), instanceId: i.id, expectedVersion: asked.result.version, reason: 'again' }))).status).toBe(409);
      expect(await refused(act('hr1', cc.id, 'CONFIRM'))).toMatchObject({ status: 403 });
      const done = await act('hr2', cc.id, 'CONFIRM');
      expect(done.result.status).toBe('CANCELLED');
      expect(await prisma.workflowInstance.findUniqueOrThrow({ where: { id: i.id } })).toMatchObject({ closedByUserId: U.hr1, closeKind: 'CANCELLED_BY_ACTOR' });
      expect(hooks.filter((h) => h.requestId === r.id && h.hook === 'onCancelled')).toHaveLength(1);
    });

    it('a DEFERRAL_DECISION task is refused (WFE_KIND_NOT_SUPPORTED) until BL-WFE-011', async () => {
      const { inst: i } = await started('tests.role');
      const t = await prisma.workflowTask.create({ data: { instanceId: i.id, companyId: A, round: 1, nodeId: 'DEFERRAL_DECISION#1', kind: 'DEFERRAL_DECISION', candidateUserIds: [U.hr1], candidatesSnapshotJson: [{ userId: U.hr1, via: 'STAGE', roles: ['HR_MANAGER'] }] } });
      expect((await refused(act('hr1', t.id, 'CONFIRM'))).code).toBe('WFE_KIND_NOT_SUPPORTED');
    });
  });

  // ------------------------------------------------------------------------------------------------
  // The schema of 9zj (a sample of each constraint kind; the full list is in AUDIT/16 §4)

  describe('9zj constraints', () => {
    it('hasPayEffect = true is refused by the DB (DEC-PO-139); a task of another company than its instance is refused (composite FK)', async () => {
      const { inst: i } = await started('tests.role');
      await expect(prisma.workflowInstance.update({ where: { id: i.id }, data: { hasPayEffect: true } })).rejects.toThrow();
      await expect(prisma.workflowTask.create({ data: { instanceId: i.id, companyId: B, round: 1, nodeId: 'x', kind: 'APPROVE' } })).rejects.toThrow();
      await expect(prisma.workflowTask.create({ data: { instanceId: i.id, companyId: A, round: 1, nodeId: 'REJECT_PAIR#9', kind: 'REJECT_PAIR', status: 'REJECTED', decidedAt: new Date(), actedByUserId: U.hr1 } })).rejects.toThrow(); // no reason
    });

    it('an ACTIVE definition is immutable and cannot be deleted (trigger G6); a second overlapping delegation of one delegator is refused (EXCLUDE)', async () => {
      const d = await prisma.workflowDefinition.findFirstOrThrow({ where: { requestType: 'tests.role', companyId: null, status: 'ACTIVE' } });
      await expect(prisma.workflowDefinition.update({ where: { id: d.id }, data: { checksum: 'f'.repeat(64) } })).rejects.toThrow();
      await expect(prisma.workflowDefinition.delete({ where: { id: d.id } })).rejects.toThrow();
      const s = new Date();
      const e = new Date(s.getTime() + 86_400_000);
      await prisma.approvalDelegation.create({ data: { fromUserId: U.hr3, toUserId: U.hr2, createdById: U.hr3, companyIds: [A], startsAt: s, endsAt: e } });
      await expect(prisma.approvalDelegation.create({ data: { fromUserId: U.hr3, toUserId: U.hr1, createdById: U.hr3, companyIds: [A], startsAt: s, endsAt: e } })).rejects.toThrow();
    });
  });
});
