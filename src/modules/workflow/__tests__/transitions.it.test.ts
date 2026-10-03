// Event payloads per transition and the remaining act paths of the approval engine (WFE-002; AUDIT/16 §3.5-§3.7, §4),
// against a real PostgreSQL with every migration applied, real iam contexts (no auth mock) and the real ports
// (src/lib/workflow-wiring.ts). The same fixture shape as workflow.it.test.ts; the tenant is a database of its own.
//
// Covers: the payload of workflow.instance.decided (approve, reject, cancel, close, with outcome, closeKind, closeSource,
// requesterUserId, requestType, requestId, companyId), workflow.task.notRequired (priorApproverUserIds),
// workflow.instance.awaitingRequirement and the REQUIREMENT_CHECK task.assigned; maxReturns; adapter canReject /
// canReturn false; decision-field validation, onStageApproved fields and runtime conditions on decision fields;
// REQUIREMENT_CHECK RECHECK and REJECT; the REJECT_PAIR decline; CANCEL_CONFIRM DECLINE; resume from BLOCKED (also with the
// awaiting requirement kept by a CANCEL_CONFIRM) and dueAt recomputed on resume.
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
  final: FinalCheck;
  canReject: boolean;
  canReturn: boolean;
  canCancel: (userId: string) => boolean;
  needsConfirm: boolean;
}

describe('workflow engine: event payloads and act paths on PostgreSQL (WFE-002)', { timeout: 900_000 }, () => {
  if (process.env.WFE_IT !== '1') return; // skipped: build nothing (the suite creates a database)

  let template: TenantDatabase;
  let tenant: TenantDatabase;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let prisma: any;
  let wf: typeof import('@/modules/workflow');
  let iam: typeof import('@/modules/iam');
  let fx: typeof import('@/test/money-fixtures');
  let calendar: typeof import('@/modules/calendar');
  let dates: typeof import('@/lib/dates');
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const store = new Map<string, Req>();
  const hooks: { type: string; hook: string; requestId: string; note?: string | null }[] = [];
  const stageHooks: { requestId: string; stage?: { nodeId: string; kind: string; stageId: string | null }; decisionFields?: Record<string, unknown>; collectedFields?: Record<string, unknown> }[] = [];
  const typeOf = new Map<string, string>();
  const tag = randomBytes(4).toString('hex');
  const U: Record<string, string> = {};
  const E: Record<string, string> = {};
  let A = '';

  const SETTINGS = { maxReturns: null, returnExpiryWorkingDays: null, coverRole: null, rejectRequiresPair: false, rejectAuthority: ['HR_MANAGER'] };
  const PAIR = { ...SETTINGS, rejectRequiresPair: true, rejectAuthority: ['HR_MANAGER', 'COMPANY_ADMIN'] };
  const hrStage = (id: string, extra: Record<string, unknown> = {}) => ({ type: 'stage', id, approver: { kind: 'ROLE', role: 'HR_MANAGER' }, ...extra });
  const seq = (...children: unknown[]) => ({ type: 'sequence', id: 'root', children });
  const DEFS: Record<string, unknown> = {
    'trn.role': { schemaVersion: 1, settings: SETTINGS, root: seq(hrStage('hr')) },
    'trn.two': { schemaVersion: 1, settings: SETTINGS, root: seq(hrStage('first'), hrStage('second', { distinctFromPrior: true })) },
    'trn.any': { schemaVersion: 1, settings: SETTINGS, root: { type: 'parallel', id: 'p', join: 'ANY', branches: [hrStage('a'), { type: 'stage', id: 'b', approver: { kind: 'ROLE', role: 'COMPANY_ADMIN' } }] } },
    'trn.auto': { schemaVersion: 1, settings: SETTINGS, root: seq() },
    'trn.autopair': { schemaVersion: 1, settings: PAIR, root: seq() },
    'trn.pair': { schemaVersion: 1, settings: PAIR, root: seq(hrStage('hr')) },
    'trn.maxret0': { schemaVersion: 1, settings: { ...SETTINGS, maxReturns: 0 }, root: seq(hrStage('hr')) },
    'trn.maxret1': { schemaVersion: 1, settings: { ...SETTINGS, maxReturns: 1 }, root: seq(hrStage('hr')) },
    // The stage role is LEGAL_ADMIN; rejectAuthority is HR_MANAGER (a holder who is not a candidate may still reject).
    'trn.legal': { schemaVersion: 1, settings: SETTINGS, root: seq({ type: 'stage', id: 'legal', approver: { kind: 'ROLE', role: 'LEGAL_ADMIN' }, deadline: { workingDays: 2, onDeadline: 'NOTIFY' } }) },
    'trn.fields': {
      schemaVersion: 1,
      settings: SETTINGS,
      root: seq(hrStage('collect', { decisionFields: ['grade', 'amount'] }), {
        type: 'condition',
        id: 'route',
        branches: [
          { when: { field: 'grade', op: 'eq', value: 'A' }, node: hrStage('gradeA', { decisionFields: ['memo'] }) },
          { when: { field: 'amount', op: 'gt', value: 1000 }, node: hrStage('big') },
        ],
        otherwise: hrStage('small'),
      }),
    },
  };

  function adapterFor(requestType: string) {
    return {
      requestType,
      ownerModule: 'tests',
      payEffect: 'NONE' as const,
      fieldCatalog: {},
      decisionFieldCatalog: {
        grade: { type: 'enum' as const, values: ['A', 'B'] },
        amount: { type: 'number' as const },
        memo: { type: 'string' as const },
        ok: { type: 'boolean' as const },
        due: { type: 'date' as const },
      },
      closeSources: ['WITHDRAWAL', 'DEEMED'],
      pauseReasons: ['DEFERRAL', 'SUPERSEDED'],
      decisionStatuses: [],
      domainStatuses: [],
      legacyDecisionEntryPoints: [],
      recheckTriggers: [],
      load: async (_tx: unknown, id: string) => {
        const r = store.get(id);
        if (!r) throw new Error(`no request ${id}`);
        return r;
      },
      parties: async (_tx: unknown, r: Req) => ({ beneficiaryEmployeeIds: r.beneficiaries, requesterUserId: r.requester, contextSnapshot: { kind: requestType } }),
      validateSubmit: async () => undefined,
      validateFinal: async (_tx: unknown, r: Req) => r.final,
      canReject: (_a: unknown, r: Req) => r.canReject,
      canReturn: (_a: unknown, r: Req) => r.canReturn,
      canCancel: (a: { userId: string }, r: Req) => r.canCancel(a.userId),
      cancelNeedsConfirm: (_i: unknown, r: Req) => r.needsConfirm,
      onStageApproved: async (_tx: unknown, c: { instance: { requestId: string }; stage?: never; decisionFields?: Record<string, unknown>; collectedFields?: Record<string, unknown> }) =>
        void stageHooks.push({ requestId: c.instance.requestId, stage: c.stage, decisionFields: c.decisionFields, collectedFields: c.collectedFields }),
      onApproved: async (_tx: unknown, c: { instance: { requestId: string } }) => void hooks.push({ type: requestType, hook: 'onApproved', requestId: c.instance.requestId }),
      onRejected: async (_tx: unknown, c: { instance: { requestId: string }; note?: string | null }) => void hooks.push({ type: requestType, hook: 'onRejected', requestId: c.instance.requestId, note: c.note }),
      onCancelled: async (_tx: unknown, c: { instance: { requestId: string } }) => void hooks.push({ type: requestType, hook: 'onCancelled', requestId: c.instance.requestId }),
      onReturned: async (_tx: unknown, c: { instance: { requestId: string } }) => void hooks.push({ type: requestType, hook: 'onReturned', requestId: c.instance.requestId }),
      summary: () => ({}),
    };
  }

  // ------------------------------------------------------------------------------------------------
  // Fixtures

  beforeAll(async () => {
    template = await migratedTemplate('wft');
    tenant = await tenantFromTemplate(template, 'core');
    await enterTenantDatabase(tenant.url);
    prisma = (await import('@/lib/prisma')).prisma;
    wf = await import('@/modules/workflow');
    iam = await import('@/modules/iam');
    fx = await import('@/test/money-fixtures');
    calendar = await import('@/modules/calendar');
    dates = await import('@/lib/dates');
    (await import('@/lib/workflow-wiring')).ensureWorkflowWiring();
    for (const t of Object.keys(DEFS)) wf.registerWorkflowAdapter(adapterFor(t) as never);

    A = (await prisma.company.create({ data: { nameArabic: `WFT A ${tag}`, commercialRegNum: `WFTA${tag}`, commercialRegExp: new Date('2035-01-01') } })).id;
    const user = async (key: string, role: string, scope: string[] | null) => {
      const id = (await prisma.user.create({ data: { email: `${key}-${tag}@example.test`, name: key, passwordHash: 'x', role } })).id;
      if (scope) for (const companyId of scope) await fx.moneyFixture((tx) => tx.userCompanyScope.create({ data: { userId: id, companyId } }));
      U[key] = id;
    };
    await user('super', 'SUPER_ADMIN', null);
    await user('ownerA', 'COMPANY_ADMIN', [A]);
    await user('hr1', 'HR_MANAGER', [A]);
    await user('hr2', 'HR_MANAGER', [A]);
    await user('hr3', 'HR_MANAGER', [A]);
    await user('emp', 'EMPLOYEE', [A]);
    await user('legal', 'LEGAL_ADMIN', [A]);

    const t = randomBytes(4).toString('hex');
    const e = await fx.employeeFixture({
      employeeId: `WFT-${t}`, firstNameArabic: 'موظف', lastNameArabic: 'ben', nationality: 'SA', iqamaOrIdNumber: `WFT${t}`,
      iqamaOrIdExp: new Date('2030-01-01'), dateOfBirth: new Date('1990-01-01'), gender: 'M', joinDate: new Date('2024-01-01'), basicSalary: 5000, legalCompanyId: A,
    });
    E.ben = e.id;
    await fx.linkFixture(U.emp, E.ben);

    // Tenant-default definitions, saved and activated by the owner (G7).
    const sup = await ctxOf('super');
    for (const [type, def] of Object.entries(DEFS)) {
      const d = await wf.saveWorkflowDefinitionDraft(prisma, { ctx: sup, requestType: type, companyId: null, definition: def });
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
  const ctxOf = async (key: string) => iam.scopedContext(await actorOf(key));
  const sys = () => iam.systemContext('workflow-test', A);

  function request(over: Partial<Req> = {}): Req {
    const r: Req = { id: randomUUID(), beneficiaries: [E.ben], requester: U.emp, final: { ok: true }, canReject: true, canReturn: true, canCancel: () => true, needsConfirm: false, ...over };
    store.set(r.id, r);
    return r;
  }
  async function started(type: string, over: Partial<Req> = {}) {
    const r = request(over);
    typeOf.set(r.id, type);
    const res = await prisma.$transaction((tx: never) => wf.startWorkflow(tx, { ctx: sys(), requestType: type, requestId: r.id }));
    const inst = await prisma.workflowInstance.findUniqueOrThrow({ where: { requestType_requestId: { requestType: type, requestId: r.id } } });
    return { r, res, inst };
  }
  const instanceOf = (id: string) => prisma.workflowInstance.findUniqueOrThrow({ where: { id } });
  const openTasks = (instanceId: string) => prisma.workflowTask.findMany({ where: { instanceId, status: 'OPEN' }, orderBy: { createdAt: 'asc' } });
  const tasksOf = (instanceId: string) => prisma.workflowTask.findMany({ where: { instanceId }, orderBy: { createdAt: 'asc' } });
  const eventsOf = (instanceId: string, type?: string) =>
    prisma.domainEvent.findMany({ where: { aggregateType: 'WorkflowInstance', aggregateId: instanceId, ...(type ? { type } : {}) }, orderBy: { seq: 'asc' } });
  const auditsOf = (instanceId: string) => prisma.auditRecord.findMany({ where: { entityType: 'WorkflowInstance', entityId: instanceId }, orderBy: { seq: 'asc' } });
  const hooksOf = (requestId: string, hook: string) => hooks.filter((h) => h.requestId === requestId && h.hook === hook);

  async function act(key: string, taskId: string, decision: string, over: { note?: string; expectedVersion?: number; decisionFields?: Record<string, unknown> } = {}) {
    const t = await prisma.workflowTask.findUniqueOrThrow({ where: { id: taskId }, include: { instance: true } });
    return wf.actOnWorkflowTask(prisma, {
      ctx: await ctxOf(key),
      taskId,
      expectedVersion: over.expectedVersion ?? t.instance.version,
      decision: decision as never,
      note: over.note ?? 'ok',
      ...(over.decisionFields !== undefined ? { decisionFields: over.decisionFields } : {}),
    });
  }
  async function refused(p: Promise<unknown>): Promise<{ status: number; code: string }> {
    try {
      await p;
    } catch (err) {
      const e = err as { status?: number; code?: string };
      return { status: e.status ?? 0, code: e.code ?? (err as Error).name };
    }
    throw new Error('expected a refusal');
  }
  const pause = (id: string, reason: string, callerKey: string) => prisma.$transaction((tx: never) => wf.pauseWorkflow(tx, { ctx: sys(), instanceId: id, reason, callerKey }));
  const resume = (id: string, reason: string, callerKey: string) => prisma.$transaction((tx: never) => wf.resumeWorkflow(tx, { ctx: sys(), instanceId: id, reason, callerKey }));
  const recheck = (id: string, callerKey: string) => prisma.$transaction((tx: never) => wf.recheckWorkflow(tx, { ctx: sys(), instanceId: id, callerKey }));
  const cancel = async (key: string, id: string, reason = 'withdrawn') => wf.cancelWorkflow(prisma, { ctx: await ctxOf(key), instanceId: id, expectedVersion: (await instanceOf(id)).version, reason });

  /** Logins deactivated for the body of `fn` (and restored whatever happens). */
  async function without(keys: string[], fn: () => Promise<void>) {
    for (const k of keys) await fx.identityFixture(U[k], { isActive: false });
    try {
      await fn();
    } finally {
      for (const k of keys) await fx.identityFixture(U[k], { isActive: true });
    }
  }
  const ALL_APPROVERS = ['legal', 'ownerA', 'super'];
  /** The day `days` working days after today in company A's calendar (what the engine stores as dueAt). */
  const dueIn = (days: number) => calendar.addCompanyWorkingDays(prisma, A, dates.today(new Date()), days);
  const STALE = new Date('2020-01-01T00:00:00.000Z');

  // ------------------------------------------------------------------------------------------------
  // Event payloads (AUDIT/16 §3.7)

  describe('event payloads per transition', () => {
    it('decided on approve: outcome APPROVED, closeKind DECIDED, closeSource null, the requester, the request and the company', async () => {
      const { r, inst } = await started('trn.role');
      const [t] = await openTasks(inst.id);
      await act('hr1', t.id, 'APPROVE');
      const [ev, ...rest] = await eventsOf(inst.id, 'workflow.instance.decided');
      expect(rest).toHaveLength(0);
      expect(ev.companyId).toBe(A);
      expect(ev.aggregateType).toBe('WorkflowInstance');
      expect(ev.payload).toEqual({
        instanceId: inst.id,
        companyId: A,
        actorId: U.hr1,
        outcome: 'APPROVED',
        closeKind: 'DECIDED',
        closeSource: null,
        requesterUserId: U.emp,
        requestType: 'trn.role',
        requestId: r.id,
      });
    });

    it('decided on reject: outcome REJECTED, closeKind DECIDED, closeSource null; the rejecter is the actor', async () => {
      const { r, inst } = await started('trn.role');
      const [t] = await openTasks(inst.id);
      await act('hr2', t.id, 'REJECT', { note: 'incomplete file' });
      const events = await eventsOf(inst.id, 'workflow.instance.decided');
      expect(events).toHaveLength(1);
      expect(events[0].payload).toEqual({
        instanceId: inst.id,
        companyId: A,
        actorId: U.hr2,
        outcome: 'REJECTED',
        closeKind: 'DECIDED',
        closeSource: null,
        requesterUserId: U.emp,
        requestType: 'trn.role',
        requestId: r.id,
      });
      expect(hooksOf(r.id, 'onRejected')).toEqual([{ type: 'trn.role', hook: 'onRejected', requestId: r.id, note: 'incomplete file' }]);
    });

    it('decided on cancel: outcome CANCELLED, closeKind CANCELLED_BY_ACTOR, closeSource null; the canceller is the actor', async () => {
      const { r, inst } = await started('trn.role');
      await cancel('hr1', inst.id, 'duplicate request');
      const events = await eventsOf(inst.id, 'workflow.instance.decided');
      expect(events).toHaveLength(1);
      expect(events[0].payload).toEqual({
        instanceId: inst.id,
        companyId: A,
        actorId: U.hr1,
        outcome: 'CANCELLED',
        closeKind: 'CANCELLED_BY_ACTOR',
        closeSource: null,
        requesterUserId: U.emp,
        requestType: 'trn.role',
        requestId: r.id,
      });
      expect(events[0].companyId).toBe(A);
    });

    it('decided on close (closeExternally): outcome, closeKind EXTERNAL and the closeSource; a SYSTEM actor has no actorId', async () => {
      const { r, inst } = await started('trn.role');
      await prisma.$transaction((tx: never) => wf.closeWorkflowExternally(tx, { ctx: sys(), instanceId: inst.id, outcome: 'REJECTED', source: 'DEEMED', actor: { type: 'SYSTEM', job: 'workflow-test' } }));
      const events = await eventsOf(inst.id, 'workflow.instance.decided');
      expect(events).toHaveLength(1);
      expect(events[0].payload).toEqual({
        instanceId: inst.id,
        companyId: A,
        actorId: null,
        outcome: 'REJECTED',
        closeKind: 'EXTERNAL',
        closeSource: 'DEEMED',
        requesterUserId: U.emp,
        requestType: 'trn.role',
        requestId: r.id,
      });
      expect(events[0].actorId).toBeNull();

      // A person closing it: the actor is that login.
      const second = await started('trn.role');
      const ctx = await ctxOf('hr1');
      await prisma.$transaction((tx: never) => wf.closeWorkflowExternally(tx, { ctx, instanceId: second.inst.id, outcome: 'CANCELLED', source: 'WITHDRAWAL', actor: { type: 'USER', userId: U.hr1 } }));
      const [ev2] = await eventsOf(second.inst.id, 'workflow.instance.decided');
      expect(ev2.payload).toMatchObject({ outcome: 'CANCELLED', closeKind: 'EXTERNAL', closeSource: 'WITHDRAWAL', actorId: U.hr1 });
    });

    it('decided on an automatic approval: closeKind AUTO_APPROVED; the requester is null when the request has none', async () => {
      const { r, inst } = await started('trn.auto', { requester: null });
      expect(inst).toMatchObject({ status: 'APPROVED', closeKind: 'AUTO_APPROVED' });
      const events = await eventsOf(inst.id, 'workflow.instance.decided');
      expect(events).toHaveLength(1);
      expect(events[0].payload).toEqual({
        instanceId: inst.id,
        companyId: A,
        actorId: null,
        outcome: 'APPROVED',
        closeKind: 'AUTO_APPROVED',
        closeSource: null,
        requesterUserId: null,
        requestType: 'trn.auto',
        requestId: r.id,
      });
    });

    it('notRequired: a parallel ANY closes the other branch with the candidates of that task and the prior approvers', async () => {
      const { inst } = await started('trn.any');
      const open = await openTasks(inst.id);
      const a = open.find((t: { nodeId: string }) => t.nodeId === 'a');
      const b = open.find((t: { nodeId: string }) => t.nodeId === 'b');
      await act('hr1', a.id, 'APPROVE');
      const events = await eventsOf(inst.id, 'workflow.task.notRequired');
      expect(events).toHaveLength(1);
      expect(events[0].payload).toEqual({
        instanceId: inst.id,
        taskId: b.id,
        companyId: A,
        actorId: U.hr1,
        candidateUserIds: b.candidateUserIds,
        priorApproverUserIds: [U.hr1],
      });
      expect(events[0].companyId).toBe(A);
      expect(b.candidateUserIds).toEqual(expect.arrayContaining([U.ownerA]));
    });

    it('notRequired on a cancel: the step that was open names the earlier approver, and each closed task has its own event key', async () => {
      const { inst } = await started('trn.two');
      const [first] = await openTasks(inst.id);
      await act('hr1', first.id, 'APPROVE');
      const [second] = await openTasks(inst.id);
      await cancel('hr2', inst.id);
      const events = await eventsOf(inst.id, 'workflow.task.notRequired');
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({ taskId: second.id, candidateUserIds: second.candidateUserIds, priorApproverUserIds: [U.hr1], actorId: U.hr2 });
      expect(events[0].idempotencyKey.endsWith(`:workflow.task.notRequired:${second.id}`)).toBe(true);
      expect(second.candidateUserIds).not.toContain(U.hr1); // distinctFromPrior
    });

    it('awaitingRequirement: the REQUIREMENT_CHECK task.assigned (kind, round, node, candidates, request) and the instance event with the requirement', async () => {
      const { r, inst } = await started('trn.auto', { final: { awaitable: true, requirement: 'DOCUMENT_MISSING' } });
      expect(inst).toMatchObject({ status: 'AWAITING_REQUIREMENT', awaitingRequirement: 'DOCUMENT_MISSING' });
      const [check] = await openTasks(inst.id);
      expect(check).toMatchObject({ kind: 'REQUIREMENT_CHECK', nodeId: 'REQUIREMENT_CHECK#1', round: 1 });
      expect(check.candidateUserIds).toEqual([U.hr1, U.hr2, U.hr3].sort()); // rejectAuthority holders minus the beneficiary and the requester

      const events = await eventsOf(inst.id);
      expect(events.map((e: { type: string }) => e.type)).toEqual(['workflow.task.assigned', 'workflow.instance.awaitingRequirement']);
      expect(events[0].payload).toEqual({
        instanceId: inst.id,
        taskId: check.id,
        companyId: A,
        actorId: null,
        kind: 'REQUIREMENT_CHECK',
        round: 1,
        nodeId: 'REQUIREMENT_CHECK#1',
        candidateUserIds: check.candidateUserIds,
        dueAt: null,
        requestType: 'trn.auto',
        requestId: r.id,
      });
      expect(events[1].payload).toEqual({ instanceId: inst.id, companyId: A, actorId: null, requirement: 'DOCUMENT_MISSING' });
      expect(new Set(events.map((e: { idempotencyKey: string }) => e.idempotencyKey)).size).toBe(2);
      expect(events.every((e: { companyId: string }) => e.companyId === A)).toBe(true);
    });
  });

  // ------------------------------------------------------------------------------------------------
  // Return, reject and the adapter's permissions

  describe('maxReturns and the adapter permissions (canReject, canReturn)', () => {
    it('maxReturns 1: the first return is accepted, the second (after a resubmit) is refused and changes nothing', async () => {
      const { r, inst } = await started('trn.maxret1');
      const [t1] = await openTasks(inst.id);
      await act('hr1', t1.id, 'RETURN', { note: 'missing attachment' });
      expect(await instanceOf(inst.id)).toMatchObject({ status: 'RETURNED', returns: 1 });
      await prisma.$transaction((tx: never) => wf.resubmitWorkflow(tx, { ctx: sys(), instanceId: inst.id }));
      const [t2] = await openTasks(inst.id);
      expect(t2.round).toBe(2);
      const before = await instanceOf(inst.id);
      const err = await refused(act('hr2', t2.id, 'RETURN', { note: 'again' }));
      expect(err).toEqual({ status: 422, code: 'WFE_VALIDATION' });
      const after = await instanceOf(inst.id);
      expect(after).toMatchObject({ status: 'RUNNING', returns: 1, version: before.version });
      expect((await prisma.workflowTask.findUniqueOrThrow({ where: { id: t2.id } })).status).toBe('OPEN');
      expect(hooksOf(r.id, 'onReturned')).toHaveLength(1);
      // Rejecting and approving are still open to him.
      expect((await act('hr2', t2.id, 'APPROVE')).result.status).toBe('APPROVED');
    });

    it('maxReturns 0: no return at all', async () => {
      const { inst } = await started('trn.maxret0');
      const [t] = await openTasks(inst.id);
      expect(await refused(act('hr1', t.id, 'RETURN', { note: 'no' }))).toEqual({ status: 422, code: 'WFE_VALIDATION' });
      expect(await instanceOf(inst.id)).toMatchObject({ status: 'RUNNING', returns: 0 });
    });

    it('a return needs a note (422), and the unrestricted definition (no maxReturns) takes any number of returns', async () => {
      const { inst } = await started('trn.role');
      const [t] = await openTasks(inst.id);
      expect(await refused(act('hr1', t.id, 'RETURN', { note: '   ' }))).toEqual({ status: 422, code: 'WFE_VALIDATION' });
      for (let n = 1; n <= 3; n += 1) {
        const [open] = await openTasks(inst.id);
        await act('hr1', open.id, 'RETURN', { note: `round ${n}` });
        await prisma.$transaction((tx: never) => wf.resubmitWorkflow(tx, { ctx: sys(), instanceId: inst.id }));
      }
      expect(await instanceOf(inst.id)).toMatchObject({ status: 'RUNNING', returns: 3, round: 4 });
    });

    it('canReturn false: a candidate\'s RETURN is refused (403); the task stays OPEN and nothing is written', async () => {
      const { r, inst } = await started('trn.role', { canReturn: false });
      const [t] = await openTasks(inst.id);
      const before = { inst: await instanceOf(inst.id), events: (await eventsOf(inst.id)).length, audits: (await auditsOf(inst.id)).length };
      expect(await refused(act('hr1', t.id, 'RETURN', { note: 'fix' }))).toEqual({ status: 403, code: 'WFE_FORBIDDEN' });
      expect(await instanceOf(inst.id)).toMatchObject({ status: 'RUNNING', returns: 0, version: before.inst.version });
      expect((await eventsOf(inst.id)).length).toBe(before.events);
      expect((await auditsOf(inst.id)).length).toBe(before.audits);
      expect(hooksOf(r.id, 'onReturned')).toHaveLength(0);
      r.canReturn = true;
      expect((await act('hr1', t.id, 'RETURN', { note: 'fix' })).result.status).toBe('RETURNED');
    });

    it('canReject false: a candidate\'s REJECT is refused (403) while he can still approve; a rejectAuthority holder who is not a candidate is not asked', async () => {
      const { r, inst } = await started('trn.role', { canReject: false });
      const [t] = await openTasks(inst.id);
      expect(await refused(act('hr1', t.id, 'REJECT', { note: 'no' }))).toEqual({ status: 403, code: 'WFE_FORBIDDEN' });
      expect(await instanceOf(inst.id)).toMatchObject({ status: 'RUNNING' });
      expect(hooksOf(r.id, 'onRejected')).toHaveLength(0);
      expect((await act('hr1', t.id, 'APPROVE')).result.status).toBe('APPROVED');

      // trn.legal: the stage is LEGAL_ADMIN, rejectAuthority HR_MANAGER. The legal candidate is asked canReject; an HR
      // holder (not a candidate) rejects through rejectAuthority without it (§12.8).
      const l1 = await started('trn.legal', { canReject: false, requester: U.hr3 });
      const [lt] = await openTasks(l1.inst.id);
      expect(lt.candidateUserIds).toEqual([U.legal]);
      expect(await refused(act('legal', lt.id, 'REJECT', { note: 'no' }))).toEqual({ status: 403, code: 'WFE_FORBIDDEN' });
      const rejected = await act('hr1', lt.id, 'REJECT', { note: 'rejected by the authority' });
      expect(rejected.result.status).toBe('REJECTED');
      expect(await instanceOf(l1.inst.id)).toMatchObject({ closeKind: 'DECIDED', closedByUserId: U.hr1 });
      expect(hooksOf(l1.r.id, 'onRejected')).toHaveLength(1);
    });

    it('a rejection needs a reason (422); a rejectAuthority holder who is not a candidate can neither approve nor return', async () => {
      const { inst } = await started('trn.legal', { requester: U.hr3 });
      const [t] = await openTasks(inst.id);
      expect(await refused(act('hr1', t.id, 'REJECT', { note: '' }))).toEqual({ status: 422, code: 'WFE_VALIDATION' });
      expect(await refused(act('hr1', t.id, 'APPROVE'))).toEqual({ status: 403, code: 'WFE_FORBIDDEN' });
      expect(await refused(act('hr1', t.id, 'RETURN', { note: 'x' }))).toEqual({ status: 403, code: 'WFE_FORBIDDEN' });
      expect(await instanceOf(inst.id)).toMatchObject({ status: 'RUNNING' });
    });

    it('REJECT_PAIR: a canReject that no longer holds closes the pair task (nothing rejected); a DECLINE does too; a later rejection opens REJECT_PAIR#2', async () => {
      const { r, inst } = await started('trn.pair');
      const [t] = await openTasks(inst.id);
      await act('hr1', t.id, 'REJECT', { note: 'incomplete' });
      const pair1 = (await openTasks(inst.id)).find((x: { kind: string }) => x.kind === 'REJECT_PAIR');
      expect(pair1.nodeId).toBe('REJECT_PAIR#1');
      r.canReject = false;
      const declined = await act('hr2', pair1.id, 'CONFIRM', { note: 'agreed' });
      expect(declined.result.status).toBe('RUNNING');
      const closed = await prisma.workflowTask.findUniqueOrThrow({ where: { id: pair1.id } });
      expect(closed).toMatchObject({ status: 'REJECTED', actedByUserId: U.hr2, note: 'agreed' });
      expect(hooksOf(r.id, 'onRejected')).toHaveLength(0);
      expect((await prisma.workflowTask.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('OPEN');

      r.canReject = true;
      await act('hr1', t.id, 'REJECT', { note: 'still incomplete' });
      const pair2 = (await openTasks(inst.id)).find((x: { kind: string }) => x.kind === 'REJECT_PAIR');
      expect(pair2.nodeId).toBe('REJECT_PAIR#2');
      const dec = await act('hr3', pair2.id, 'DECLINE', { note: 'I disagree' });
      expect(dec.result.status).toBe('RUNNING');
      expect(await prisma.workflowTask.findUniqueOrThrow({ where: { id: pair2.id } })).toMatchObject({ status: 'REJECTED', actedByUserId: U.hr3, note: 'I disagree' });
      expect(hooksOf(r.id, 'onRejected')).toHaveLength(0);
      expect((await act('hr2', t.id, 'APPROVE')).result.status).toBe('APPROVED');
    });
  });

  // ------------------------------------------------------------------------------------------------
  // Decision fields

  describe('decision fields, onStageApproved and runtime conditions', () => {
    const fieldsTask = async (over: Partial<Req> = {}) => {
      const s = await started('trn.fields', over);
      const [t] = await openTasks(s.inst.id);
      expect(t.nodeId).toBe('collect');
      return { ...s, t };
    };

    it('a value of the wrong type, an unknown field or a field this stage does not collect is refused (422) and the task stays OPEN', async () => {
      const { inst, t } = await fieldsTask();
      const bad: Record<string, unknown>[] = [
        { grade: 'Z' }, // not in the enum
        { grade: 5 },
        { amount: '1000' }, // a string for a number
        { amount: Number.POSITIVE_INFINITY },
        { amount: Number.NaN },
        { unknownField: 1 }, // not in the catalog
        { memo: 'fine' }, // in the catalog, but collected by another stage
        { ok: true }, // in the catalog, collected by no stage
        { grade: 'A', amount: 'x' }, // one good and one bad: nothing is taken
      ];
      for (const decisionFields of bad) {
        expect(await refused(act('hr1', t.id, 'APPROVE', { decisionFields }))).toEqual({ status: 422, code: 'WFE_VALIDATION' });
      }
      expect(await refused(act('hr1', t.id, 'APPROVE', { decisionFields: ['A'] as never }))).toEqual({ status: 422, code: 'WFE_VALIDATION' });
      expect(await refused(act('hr1', t.id, 'APPROVE', { decisionFields: 'A' as never }))).toEqual({ status: 422, code: 'WFE_VALIDATION' });
      const now = await instanceOf(inst.id);
      expect(now).toMatchObject({ status: 'RUNNING', version: inst.version });
      expect((await prisma.workflowTask.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('OPEN');
      expect(stageHooks.filter((h) => h.requestId === inst.requestId)).toHaveLength(0);
    });

    it('a stage that collects nothing refuses any decision field; a long string and a malformed date are refused where the catalog says so', async () => {
      const { inst, t } = await fieldsTask();
      await act('hr1', t.id, 'APPROVE', { decisionFields: { grade: 'B', amount: 10 } });
      const [small] = await openTasks(inst.id);
      expect(small.nodeId).toBe('small');
      expect(await refused(act('hr2', small.id, 'APPROVE', { decisionFields: { grade: 'A' } }))).toEqual({ status: 422, code: 'WFE_VALIDATION' });
      expect(await instanceOf(inst.id)).toMatchObject({ status: 'RUNNING' });

      const second = await fieldsTask();
      await act('hr1', second.t.id, 'APPROVE', { decisionFields: { grade: 'A', amount: 1 } });
      const [gradeA] = await openTasks(second.inst.id);
      expect(gradeA.nodeId).toBe('gradeA');
      expect(await refused(act('hr2', gradeA.id, 'APPROVE', { decisionFields: { memo: 'x'.repeat(2001) } }))).toEqual({ status: 422, code: 'WFE_VALIDATION' });
      expect(await refused(act('hr2', gradeA.id, 'APPROVE', { decisionFields: { memo: 42 } }))).toEqual({ status: 422, code: 'WFE_VALIDATION' });
      expect((await act('hr2', gradeA.id, 'APPROVE', { decisionFields: { memo: 'x'.repeat(2000) } })).result.status).toBe('APPROVED');
    });

    it('onStageApproved receives the stage and its decision fields, then every field collected so far; the task stores what was collected', async () => {
      const { r, inst, t } = await fieldsTask();
      await act('hr1', t.id, 'APPROVE', { decisionFields: { grade: 'A', amount: 750 } });
      const [next] = await openTasks(inst.id);
      expect(next.nodeId).toBe('gradeA');
      await act('hr2', next.id, 'APPROVE', { decisionFields: { memo: 'looks fine' } });
      const mine = stageHooks.filter((h) => h.requestId === r.id);
      expect(mine).toEqual([
        { requestId: r.id, stage: { nodeId: 'collect', kind: 'APPROVE', stageId: 'collect' }, decisionFields: { grade: 'A', amount: 750 }, collectedFields: { grade: 'A', amount: 750 } },
        { requestId: r.id, stage: { nodeId: 'gradeA', kind: 'APPROVE', stageId: 'gradeA' }, decisionFields: { memo: 'looks fine' }, collectedFields: { grade: 'A', amount: 750, memo: 'looks fine' } },
      ]);
      const tasks = await tasksOf(inst.id);
      expect(tasks.map((x: { nodeId: string; status: string; decisionFieldsJson: unknown }) => [x.nodeId, x.status, x.decisionFieldsJson])).toEqual([
        ['collect', 'APPROVED', { grade: 'A', amount: 750 }],
        ['gradeA', 'APPROVED', { memo: 'looks fine' }],
      ]);
      expect(await instanceOf(inst.id)).toMatchObject({ status: 'APPROVED' });
      expect(hooksOf(r.id, 'onApproved')).toHaveLength(1);
    });

    it('an approval without decision fields (or with an empty object) stores none; null is accepted as "no value"', async () => {
      const a = await fieldsTask();
      await act('hr1', a.t.id, 'APPROVE', { decisionFields: {} });
      expect(stageHooks.filter((h) => h.requestId === a.r.id)[0]).toMatchObject({ decisionFields: {}, collectedFields: {} });
      expect((await openTasks(a.inst.id))[0].nodeId).toBe('small');

      const b = await fieldsTask();
      await act('hr1', b.t.id, 'APPROVE', { decisionFields: { grade: null, amount: null } });
      expect((await prisma.workflowTask.findUniqueOrThrow({ where: { id: b.t.id } })).decisionFieldsJson).toEqual({ grade: null, amount: null });
      expect((await openTasks(b.inst.id))[0].nodeId).toBe('small'); // null matches neither branch
    });

    it('runtime conditions on decision fields choose the next stage: grade eq, then amount gt, then otherwise; the path is recorded', async () => {
      const route = async (fields: Record<string, unknown> | undefined) => {
        const { inst, t } = await fieldsTask();
        await act('hr1', t.id, 'APPROVE', fields ? { decisionFields: fields } : {});
        const open = await openTasks(inst.id);
        expect(open).toHaveLength(1);
        return { node: open[0].nodeId as string, path: (await instanceOf(inst.id)).pathTaken };
      };
      expect(await route({ grade: 'A', amount: 5000 })).toEqual({ node: 'gradeA', path: [{ nodeId: 'route', branch: 0 }] }); // first matching branch wins
      expect(await route({ grade: 'B', amount: 5000 })).toEqual({ node: 'big', path: [{ nodeId: 'route', branch: 1 }] });
      expect(await route({ grade: 'B', amount: 1000 })).toEqual({ node: 'small', path: [{ nodeId: 'route', branch: 'otherwise' }] }); // gt, not gte
      expect(await route({ grade: 'B', amount: 1001 })).toMatchObject({ node: 'big' });
      expect(await route({ amount: 5000 })).toMatchObject({ node: 'big' });
      expect(await route(undefined)).toEqual({ node: 'small', path: [{ nodeId: 'route', branch: 'otherwise' }] });
    });

    it('a stage after the condition completes the walk: approving the chosen stage approves the request (onApproved once, decided once)', async () => {
      const { r, inst, t } = await fieldsTask();
      await act('hr1', t.id, 'APPROVE', { decisionFields: { grade: 'B', amount: 9999 } });
      const [big] = await openTasks(inst.id);
      expect(big.nodeId).toBe('big');
      const done = await act('hr2', big.id, 'APPROVE');
      expect(done.result.status).toBe('APPROVED');
      expect(hooksOf(r.id, 'onApproved')).toHaveLength(1);
      expect(await eventsOf(inst.id, 'workflow.instance.decided')).toHaveLength(1);
      expect(stageHooks.filter((h) => h.requestId === r.id).map((h) => h.stage?.stageId)).toEqual(['collect', 'big']);
    });
  });

  // ------------------------------------------------------------------------------------------------
  // REQUIREMENT_CHECK

  describe('REQUIREMENT_CHECK (an automatic path waiting on a requirement)', () => {
    const awaiting = (over: Partial<Req> = {}) => started('trn.auto', { final: { awaitable: true, requirement: 'DOCUMENT_MISSING' }, ...over });

    it('RECHECK while the requirement is still unmet is refused (422) with the requirement; the task stays OPEN, nothing is written', async () => {
      const { inst } = await awaiting();
      const [t] = await openTasks(inst.id);
      const before = { version: inst.version, events: (await eventsOf(inst.id)).length, audits: (await auditsOf(inst.id)).length };
      expect(await refused(act('hr1', t.id, 'RECHECK'))).toEqual({ status: 422, code: 'WFE_VALIDATION' });
      expect(await instanceOf(inst.id)).toMatchObject({ status: 'AWAITING_REQUIREMENT', awaitingRequirement: 'DOCUMENT_MISSING', version: before.version });
      expect((await prisma.workflowTask.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('OPEN');
      expect((await eventsOf(inst.id)).length).toBe(before.events);
      expect((await auditsOf(inst.id)).length).toBe(before.audits);
    });

    it('RECHECK once the requirement is met approves the request (REQUIREMENT_MET, AUTO_APPROVED, onApproved and decided once); a replay changes nothing', async () => {
      const { r, inst } = await awaiting();
      const [t] = await openTasks(inst.id);
      r.final = { ok: true };
      const first = await act('hr2', t.id, 'RECHECK', { expectedVersion: inst.version });
      expect(first.result).toMatchObject({ status: 'APPROVED', outcome: 'APPLIED' });
      expect(await instanceOf(inst.id)).toMatchObject({ status: 'APPROVED', closeKind: 'AUTO_APPROVED', awaitingRequirement: null, awaitingSince: null });
      expect((await prisma.workflowTask.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('NOT_REQUIRED');
      expect((await auditsOf(inst.id)).map((a: { action: string }) => a.action)).toContain('REQUIREMENT_MET');
      expect(hooksOf(r.id, 'onApproved')).toHaveLength(1);
      const [decided, ...more] = await eventsOf(inst.id, 'workflow.instance.decided');
      expect(more).toHaveLength(0);
      expect(decided.payload).toMatchObject({ outcome: 'APPROVED', closeKind: 'AUTO_APPROVED', actorId: U.hr2, requestType: 'trn.auto', requestId: r.id });

      const counts = async () => ({ events: (await eventsOf(inst.id)).length, audits: (await auditsOf(inst.id)).length, tasks: (await tasksOf(inst.id)).length });
      const c1 = await counts();
      const again = await act('hr2', t.id, 'RECHECK', { expectedVersion: inst.version });
      expect(again.replayed).toBe(true);
      expect(again.result).toEqual(first.result);
      expect(await counts()).toEqual(c1);
      expect(hooksOf(r.id, 'onApproved')).toHaveLength(1);
    });

    it('RECHECK when the requirement changed keeps the request waiting for the new one (event and audit), the task stays OPEN', async () => {
      const { r, inst } = await awaiting();
      const [t] = await openTasks(inst.id);
      r.final = { awaitable: true, requirement: 'SIGNATURE_MISSING' };
      const res = await act('hr1', t.id, 'RECHECK');
      expect(res.result).toMatchObject({ status: 'AWAITING_REQUIREMENT', outcome: 'APPLIED' });
      expect(await instanceOf(inst.id)).toMatchObject({ status: 'AWAITING_REQUIREMENT', awaitingRequirement: 'SIGNATURE_MISSING', version: inst.version + 1 });
      expect((await prisma.workflowTask.findUniqueOrThrow({ where: { id: t.id } })).status).toBe('OPEN');
      const events = await eventsOf(inst.id, 'workflow.instance.awaitingRequirement');
      expect(events.map((e: { payload: { requirement: string } }) => e.payload.requirement)).toEqual(['DOCUMENT_MISSING', 'SIGNATURE_MISSING']);
      expect((await auditsOf(inst.id)).map((a: { action: string }) => a.action)).toContain('workflow.instance.recheck');
    });

    it('RECHECK is for the candidates only: a non-candidate owner (403), the requester and the beneficiary (G1 / G1b) are refused', async () => {
      const { inst } = await awaiting({ requester: U.hr3 });
      const [t] = await openTasks(inst.id);
      expect(t.candidateUserIds).not.toContain(U.hr3);
      expect(t.candidateUserIds).not.toContain(U.emp);
      expect(await refused(act('ownerA', t.id, 'RECHECK'))).toEqual({ status: 403, code: 'WFE_FORBIDDEN' });
      expect(await refused(act('hr3', t.id, 'RECHECK'))).toEqual({ status: 403, code: 'WFE_FORBIDDEN' });
      expect(await refused(act('emp', t.id, 'RECHECK'))).toEqual({ status: 403, code: 'WFE_FORBIDDEN' });
      // APPROVE is not a decision of this kind.
      expect(await refused(act('hr1', t.id, 'APPROVE'))).toEqual({ status: 422, code: 'WFE_VALIDATION' });
      expect(await instanceOf(inst.id)).toMatchObject({ status: 'AWAITING_REQUIREMENT' });
    });

    it('REJECT by a candidate rejects the request (needs a reason): REJECTED, onRejected, decided; the REQUIREMENT_CHECK task is the rejecter\'s', async () => {
      const { r, inst } = await awaiting();
      const [t] = await openTasks(inst.id);
      expect(await refused(act('hr1', t.id, 'REJECT', { note: '' }))).toEqual({ status: 422, code: 'WFE_VALIDATION' });
      const res = await act('hr1', t.id, 'REJECT', { note: 'the document will never come' });
      expect(res.result).toMatchObject({ status: 'REJECTED', outcome: 'APPLIED' });
      expect(await instanceOf(inst.id)).toMatchObject({ status: 'REJECTED', closeKind: 'DECIDED', closedByUserId: U.hr1, awaitingRequirement: null, awaitingSince: null });
      expect(await prisma.workflowTask.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ status: 'REJECTED', actedByUserId: U.hr1, note: 'the document will never come' });
      expect(hooksOf(r.id, 'onRejected')).toEqual([{ type: 'trn.auto', hook: 'onRejected', requestId: r.id, note: 'the document will never come' }]);
      const [ev] = await eventsOf(inst.id, 'workflow.instance.decided');
      expect(ev.payload).toMatchObject({ outcome: 'REJECTED', closeKind: 'DECIDED', actorId: U.hr1 });
    });

    it('REJECT when the adapter\'s canReject is false is refused for a candidate (403)', async () => {
      const { inst } = await awaiting({ canReject: false });
      const [t] = await openTasks(inst.id);
      expect(await refused(act('hr1', t.id, 'REJECT', { note: 'no' }))).toEqual({ status: 403, code: 'WFE_FORBIDDEN' });
      expect(await instanceOf(inst.id)).toMatchObject({ status: 'AWAITING_REQUIREMENT' });
    });

    it('REJECT with rejectRequiresPair opens a REJECT_PAIR while the request keeps waiting; the second person confirms and it is REJECTED', async () => {
      const r = request({ final: { awaitable: true, requirement: 'DOCUMENT_MISSING' } });
      typeOf.set(r.id, 'trn.autopair');
      await prisma.$transaction((tx: never) => wf.startWorkflow(tx, { ctx: sys(), requestType: 'trn.autopair', requestId: r.id }));
      const inst = await prisma.workflowInstance.findUniqueOrThrow({ where: { requestType_requestId: { requestType: 'trn.autopair', requestId: r.id } } });
      expect(inst.status).toBe('AWAITING_REQUIREMENT');
      const [check] = await openTasks(inst.id);
      await act('hr1', check.id, 'REJECT', { note: 'first opinion' });
      expect(await instanceOf(inst.id)).toMatchObject({ status: 'AWAITING_REQUIREMENT' });
      const pair = (await openTasks(inst.id)).find((x: { kind: string }) => x.kind === 'REJECT_PAIR');
      expect(pair.candidateUserIds).not.toContain(U.hr1);
      expect(await refused(act('hr1', pair.id, 'CONFIRM', { note: 'again' }))).toMatchObject({ status: 403 });
      const done = await act('hr2', pair.id, 'CONFIRM', { note: 'agreed' });
      expect(done.result.status).toBe('REJECTED');
      expect(hooksOf(r.id, 'onRejected')).toHaveLength(1);
      expect(await openTasks(inst.id)).toHaveLength(0);
    });
  });

  // ------------------------------------------------------------------------------------------------
  // CANCEL_CONFIRM

  describe('CANCEL_CONFIRM DECLINE', () => {
    it('a decline needs a reason (422); the canceller cannot decide his own request (403); another holder declines and the request resumes', async () => {
      const { r, inst } = await started('trn.role', { needsConfirm: true });
      const [stage] = await openTasks(inst.id);
      const asked = await cancel('hr1', inst.id, 'duplicate');
      expect(asked.result.status).toBe('PAUSED');
      const confirmTask = (await openTasks(inst.id)).find((x: { kind: string }) => x.kind === 'CANCEL_CONFIRM');
      expect(confirmTask.nodeId).toBe('CANCEL_CONFIRM#1');
      expect(await instanceOf(inst.id)).toMatchObject({ status: 'PAUSED', previousStatus: 'RUNNING', pauseReasons: ['CANCEL_REQUESTED'] });

      expect(await refused(act('hr2', confirmTask.id, 'DECLINE', { note: '' }))).toEqual({ status: 422, code: 'WFE_VALIDATION' });
      expect(await refused(act('hr1', confirmTask.id, 'DECLINE', { note: 'my own' }))).toEqual({ status: 403, code: 'WFE_FORBIDDEN' });
      expect(await instanceOf(inst.id)).toMatchObject({ status: 'PAUSED' });

      const version = (await instanceOf(inst.id)).version;
      const declined = await act('hr2', confirmTask.id, 'DECLINE', { note: 'still needed' });
      expect(declined.result).toMatchObject({ status: 'RUNNING', outcome: 'APPLIED' });
      expect(await instanceOf(inst.id)).toMatchObject({ status: 'RUNNING', previousStatus: null, pauseReasons: [], pausedAt: null, closedAt: null, version: version + 1 });
      expect(await prisma.workflowTask.findUniqueOrThrow({ where: { id: confirmTask.id } })).toMatchObject({ status: 'REJECTED', actedByUserId: U.hr2, note: 'still needed' });
      expect((await prisma.workflowTask.findUniqueOrThrow({ where: { id: stage.id } })).status).toBe('OPEN'); // the stage is untouched
      expect(hooksOf(r.id, 'onCancelled')).toHaveLength(0);
      expect(await eventsOf(inst.id, 'workflow.instance.decided')).toHaveLength(0);
      const audit = (await auditsOf(inst.id)).filter((a: { action: string }) => a.action === 'workflow.task.act').pop();
      expect(audit.after).toMatchObject({ decision: 'DECLINE', kind: 'CANCEL_CONFIRM', taskId: confirmTask.id });
      expect(audit.reason).toBe('still needed');
      expect((await auditsOf(inst.id)).map((a: { action: string }) => a.action)).toContain('workflow.instance.resume');

      // The same call again (same key) replays; the stage can still be approved; a new cancel request opens CANCEL_CONFIRM#2.
      const again = await act('hr2', confirmTask.id, 'DECLINE', { note: 'still needed', expectedVersion: version });
      expect(again.replayed).toBe(true);
      expect(again.result).toEqual(declined.result);
      const asked2 = await cancel('hr3', inst.id, 'again');
      expect(asked2.result.status).toBe('PAUSED');
      expect((await openTasks(inst.id)).find((x: { kind: string }) => x.kind === 'CANCEL_CONFIRM').nodeId).toBe('CANCEL_CONFIRM#2');
    });

    it('a decline of a request that was waiting for a requirement sends it back to AWAITING_REQUIREMENT with the same requirement and the same awaitingSince', async () => {
      const { inst } = await started('trn.auto', { final: { awaitable: true, requirement: 'DOCUMENT_MISSING' }, needsConfirm: true });
      const waiting = await instanceOf(inst.id);
      await cancel('hr1', inst.id, 'not needed');
      const paused = await instanceOf(inst.id);
      expect(paused).toMatchObject({ status: 'PAUSED', previousStatus: 'AWAITING_REQUIREMENT', pauseReasons: ['CANCEL_REQUESTED'], awaitingRequirement: 'DOCUMENT_MISSING' });
      const confirmTask = (await openTasks(inst.id)).find((x: { kind: string }) => x.kind === 'CANCEL_CONFIRM');
      expect(confirmTask.candidateUserIds).toEqual([U.super, U.ownerA].sort()); // nobody from a stage: the owner group
      await act('ownerA', confirmTask.id, 'DECLINE', { note: 'keep waiting' });
      const back = await instanceOf(inst.id);
      expect(back).toMatchObject({ status: 'AWAITING_REQUIREMENT', previousStatus: null, pauseReasons: [], pausedAt: null, awaitingRequirement: 'DOCUMENT_MISSING' });
      expect(back.awaitingSince.getTime()).toBe(waiting.awaitingSince.getTime());
      // The REQUIREMENT_CHECK task is still the open one.
      expect((await openTasks(inst.id)).map((x: { kind: string }) => x.kind)).toEqual(['REQUIREMENT_CHECK']);
    });

    it('a cancellation nobody can confirm BLOCKS the request and keeps the awaiting requirement for the way back (BLOCKED cannot hold it); unblocking and declining restores it', async () => {
      const { inst } = await started('trn.auto', { final: { awaitable: true, requirement: 'DOCUMENT_MISSING' }, needsConfirm: true });
      const waiting = await instanceOf(inst.id);
      await without(['ownerA', 'super'], async () => {
        await cancel('hr1', inst.id, 'not needed');
        const blocked = await instanceOf(inst.id);
        expect(blocked).toMatchObject({ status: 'BLOCKED', blockedReason: 'NO_CANDIDATE', previousStatus: 'AWAITING_REQUIREMENT', pauseReasons: ['CANCEL_REQUESTED'], awaitingRequirement: null, awaitingSince: null });
        const confirmTask = (await openTasks(inst.id)).find((x: { kind: string }) => x.kind === 'CANCEL_CONFIRM');
        expect(confirmTask.candidateUserIds).toEqual([]);
        expect(confirmTask.decisionFieldsJson).toMatchObject({ requestedByUserId: U.hr1, reason: 'not needed', awaitingRequirement: 'DOCUMENT_MISSING' });
        expect((await eventsOf(inst.id, 'workflow.instance.blocked')).length).toBe(1);
      });
      // The owners are back: recheck resolves the CANCEL_CONFIRM again and leaves BLOCKED for PAUSED (the stack is not empty).
      const rc = await recheck(inst.id, 'unblock');
      expect(rc.status).toBe('PAUSED');
      const paused = await instanceOf(inst.id);
      expect(paused).toMatchObject({ status: 'PAUSED', previousStatus: 'AWAITING_REQUIREMENT', pauseReasons: ['CANCEL_REQUESTED'], blockedAt: null, blockedReason: null, awaitingRequirement: null });
      const confirmTask = (await openTasks(inst.id)).find((x: { kind: string }) => x.kind === 'CANCEL_CONFIRM');
      expect(confirmTask.candidateUserIds).toEqual([U.super, U.ownerA].sort());
      await act('ownerA', confirmTask.id, 'DECLINE', { note: 'keep waiting' });
      const back = await instanceOf(inst.id);
      expect(back).toMatchObject({ status: 'AWAITING_REQUIREMENT', previousStatus: null, pauseReasons: [], awaitingRequirement: 'DOCUMENT_MISSING' });
      expect(back.awaitingSince.getTime()).toBe(waiting.awaitingSince.getTime()); // from the stash
    });

    it('a confirmation of a blocked-then-unblocked cancellation cancels it for the person who asked', async () => {
      const { r, inst } = await started('trn.auto', { final: { awaitable: true, requirement: 'DOCUMENT_MISSING' }, needsConfirm: true });
      await without(['ownerA', 'super'], async () => {
        await cancel('hr1', inst.id, 'not needed');
      });
      await recheck(inst.id, 'unblock');
      const confirmTask = (await openTasks(inst.id)).find((x: { kind: string }) => x.kind === 'CANCEL_CONFIRM');
      const done = await act('ownerA', confirmTask.id, 'CONFIRM', { note: 'agreed' });
      expect(done.result.status).toBe('CANCELLED');
      expect(await instanceOf(inst.id)).toMatchObject({ status: 'CANCELLED', closeKind: 'CANCELLED_BY_ACTOR', closedByUserId: U.hr1, awaitingRequirement: null });
      expect(hooksOf(r.id, 'onCancelled')).toHaveLength(1);
      const [ev] = await eventsOf(inst.id, 'workflow.instance.decided');
      expect(ev.payload).toMatchObject({ outcome: 'CANCELLED', closeKind: 'CANCELLED_BY_ACTOR', actorId: U.ownerA });
    });
  });

  // ------------------------------------------------------------------------------------------------
  // resume from BLOCKED, dueAt on resume

  describe('resume from BLOCKED and dueAt recomputed on resume', () => {
    /** A trn.legal request BLOCKED because the only legal admin and both owners are inactive (called inside `without`). */
    async function blockedLegal() {
      const s = await started('trn.legal', { requester: U.hr3 });
      const [t] = await openTasks(s.inst.id);
      expect(t.candidateUserIds).toEqual([U.legal]);
      expect(t.dueAt).not.toBeNull();
      return { ...s, t };
    }
    const makeBlocked = async (id: string) => {
      const rc = await recheck(id, `block-${randomUUID()}`);
      expect(rc.status).toBe('BLOCKED');
    };

    it('the deadline of a stage is two working days from now in the company calendar', async () => {
      const { t } = await blockedLegal();
      expect(t.dueAt.getTime()).toBe((await dueIn(2)).getTime());
    });

    it('PAUSED -> RUNNING on resume restarts the deadlines (dueAt from now, overdueAt cleared); a resume that leaves reasons on the stack does not', async () => {
      const { inst, t } = await blockedLegal();
      await pause(inst.id, 'DEFERRAL', 'p1');
      await pause(inst.id, 'SUPERSEDED', 'p2');
      await prisma.workflowTask.update({ where: { id: t.id }, data: { dueAt: STALE, overdueAt: STALE } });
      const half = await resume(inst.id, 'DEFERRAL', 'r1');
      expect(half.status).toBe('PAUSED');
      expect(await prisma.workflowTask.findUniqueOrThrow({ where: { id: t.id } })).toMatchObject({ dueAt: STALE, overdueAt: STALE });
      const full = await resume(inst.id, 'SUPERSEDED', 'r2');
      expect(full.status).toBe('RUNNING');
      const after = await prisma.workflowTask.findUniqueOrThrow({ where: { id: t.id } });
      expect(after.dueAt.getTime()).toBe((await dueIn(2)).getTime());
      expect(after.overdueAt).toBeNull();
      // The replay of the same resume changes nothing.
      const dueBefore = after.dueAt;
      expect((await resume(inst.id, 'SUPERSEDED', 'r2')).status).toBe('RUNNING');
      expect((await prisma.workflowTask.findUniqueOrThrow({ where: { id: t.id } })).dueAt).toEqual(dueBefore);
    });

    it('BLOCKED + pause stays BLOCKED (reason pushed, previousStatus RUNNING); resume with candidates back leaves BLOCKED for RUNNING and restarts the deadline', async () => {
      const { inst, t } = await blockedLegal();
      await without(ALL_APPROVERS, async () => {
        await makeBlocked(inst.id);
        const p = await pause(inst.id, 'DEFERRAL', 'p');
        expect(p.status).toBe('BLOCKED');
        expect(await instanceOf(inst.id)).toMatchObject({ status: 'BLOCKED', previousStatus: 'RUNNING', pauseReasons: ['DEFERRAL'], blockedReason: 'NO_CANDIDATE', pausedAt: null });
      });
      await prisma.workflowTask.update({ where: { id: t.id }, data: { dueAt: STALE } });
      const res = await resume(inst.id, 'DEFERRAL', 'r');
      expect(res.status).toBe('RUNNING');
      expect(await instanceOf(inst.id)).toMatchObject({ status: 'RUNNING', previousStatus: null, pauseReasons: [], blockedAt: null, blockedReason: null });
      const after = await prisma.workflowTask.findUniqueOrThrow({ where: { id: t.id } });
      expect(after.candidateUserIds).toEqual([U.legal]);
      expect(after.dueAt.getTime()).toBe((await dueIn(2)).getTime());
      expect((await eventsOf(inst.id, 'workflow.task.assigned')).some((e: { payload: { taskId: string; candidateUserIds: string[] } }) => e.payload.taskId === t.id && e.payload.candidateUserIds[0] === U.legal)).toBe(true);
      expect(await refused(act('hr2', t.id, 'APPROVE'))).toEqual({ status: 403, code: 'WFE_FORBIDDEN' });
      expect((await act('legal', t.id, 'APPROVE')).result.status).toBe('APPROVED');
    });

    it('BLOCKED + resume while nobody qualifies stays BLOCKED with an empty stack; a later recheck leaves BLOCKED and restarts the deadline', async () => {
      const { inst, t } = await blockedLegal();
      await without(ALL_APPROVERS, async () => {
        await makeBlocked(inst.id);
        await pause(inst.id, 'DEFERRAL', 'p');
        const res = await resume(inst.id, 'DEFERRAL', 'r');
        expect(res.status).toBe('BLOCKED');
        expect(await instanceOf(inst.id)).toMatchObject({ status: 'BLOCKED', pauseReasons: [], blockedReason: 'NO_CANDIDATE' });
        expect((await prisma.workflowTask.findUniqueOrThrow({ where: { id: t.id } })).candidateUserIds).toEqual([]);
        expect((await resume(inst.id, 'DEFERRAL', 'r2')).outcome).toBe('NO_CHANGE'); // the reason is no longer on the stack
      });
      await prisma.workflowTask.update({ where: { id: t.id }, data: { dueAt: STALE } });
      expect((await recheck(inst.id, 'back')).status).toBe('RUNNING');
      expect((await prisma.workflowTask.findUniqueOrThrow({ where: { id: t.id } })).dueAt.getTime()).toBe((await dueIn(2)).getTime());
    });

    // Regression: unblockTarget (transitions/internal/flows.ts) once omitted pauseReasons when returning to PAUSED, so the
    // resumed reason (DEFERRAL) stayed on the stack and the request was PAUSED with ['DEFERRAL', 'SUPERSEDED'].
    it('BLOCKED with two reasons: the first resume (candidates back) goes to PAUSED with the other reason, keeping the stale deadline; the second goes to RUNNING and restarts it', async () => {
      const { inst, t } = await blockedLegal();
      await without(ALL_APPROVERS, async () => {
        await makeBlocked(inst.id);
        await pause(inst.id, 'DEFERRAL', 'p1');
        await pause(inst.id, 'SUPERSEDED', 'p2');
        expect(await instanceOf(inst.id)).toMatchObject({ status: 'BLOCKED', pauseReasons: ['DEFERRAL', 'SUPERSEDED'], previousStatus: 'RUNNING' });
      });
      await prisma.workflowTask.update({ where: { id: t.id }, data: { dueAt: STALE } });
      const first = await resume(inst.id, 'DEFERRAL', 'r1');
      expect(first.status).toBe('PAUSED');
      expect(await instanceOf(inst.id)).toMatchObject({ status: 'PAUSED', previousStatus: 'RUNNING', pauseReasons: ['SUPERSEDED'], blockedAt: null, blockedReason: null });
      expect((await prisma.workflowTask.findUniqueOrThrow({ where: { id: t.id } })).dueAt).toEqual(STALE);
      const second = await resume(inst.id, 'SUPERSEDED', 'r2');
      expect(second.status).toBe('RUNNING');
      expect((await prisma.workflowTask.findUniqueOrThrow({ where: { id: t.id } })).dueAt.getTime()).toBe((await dueIn(2)).getTime());
    });

    it('a request waiting for a requirement keeps its requirement and awaitingSince through pause and resume', async () => {
      const { inst } = await started('trn.auto', { final: { awaitable: true, requirement: 'DOCUMENT_MISSING' } });
      const waiting = await instanceOf(inst.id);
      await pause(inst.id, 'DEFERRAL', 'p');
      expect(await instanceOf(inst.id)).toMatchObject({ status: 'PAUSED', previousStatus: 'AWAITING_REQUIREMENT', awaitingRequirement: 'DOCUMENT_MISSING' });
      await resume(inst.id, 'DEFERRAL', 'r');
      const back = await instanceOf(inst.id);
      expect(back).toMatchObject({ status: 'AWAITING_REQUIREMENT', previousStatus: null, pauseReasons: [], pausedAt: null, awaitingRequirement: 'DOCUMENT_MISSING' });
      expect(back.awaitingSince.getTime()).toBe(waiting.awaitingSince.getTime());
    });
  });
});
