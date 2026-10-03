// Adapter and port registries, the activation gate and fail-closed behaviour (AUDIT/16 §3.2, §3.4, §3.8, §4
// "registries"), without a database: every refusal here happens before the first query.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { systemContext } from '@/modules/iam';
import { ACTIVATION_BLOCKERS, activationBlockers } from '../activation';
import { registerWorkflowAdapter, requireAdapter, type WorkflowAdapter } from '../adapters';
import { isWorkflowError } from '../errors';
import { registerWorkflowPort, requirePort } from '../ports';
import { resetWorkflowRegistries } from '../testing';
import { actOnWorkflowTask, cancelWorkflow, closeWorkflowExternally, pauseWorkflow, recheckWorkflow, resubmitWorkflow, resumeWorkflow, restartWorkflowRound, startWorkflow } from '../index';

function adapter(over: Record<string, unknown> = {}): WorkflowAdapter<unknown> {
  return {
    requestType: 'tests.reg',
    ownerModule: 'tests',
    payEffect: 'NONE',
    fieldCatalog: { days: { type: 'number' } },
    decisionFieldCatalog: {},
    closeSources: ['WITHDRAWAL'],
    pauseReasons: ['DEFERRAL'],
    decisionStatuses: [],
    domainStatuses: [],
    legacyDecisionEntryPoints: [],
    recheckTriggers: [],
    load: async () => ({}),
    parties: async () => ({ beneficiaryEmployeeIds: [], requesterUserId: null, contextSnapshot: {} }),
    validateSubmit: async () => undefined,
    validateFinal: async () => ({ ok: true }),
    canReject: () => true,
    canReturn: () => true,
    canCancel: () => true,
    cancelNeedsConfirm: () => false,
    onApproved: async () => undefined,
    onRejected: async () => undefined,
    onCancelled: async () => undefined,
    summary: () => ({}),
    ...over,
  } as WorkflowAdapter<unknown>;
}

function code(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return isWorkflowError(err) ? err.code : (err as Error).message;
  }
}
async function codeAsync(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return isWorkflowError(err) ? err.code : (err as Error).message;
  }
}

/** A client that fails the test if it is touched: the refusal must come before the first query. */
const untouchable = new Proxy({}, { get: (_t, k) => (k === 'then' ? undefined : () => { throw new Error(`database touched (${String(k)})`); }) }) as never;

afterEach(() => resetWorkflowRegistries());

describe('registerWorkflowAdapter (DEC-PO-139, ARC-WFE-A7)', () => {
  it('refuses a payEffect cast to another value, a crossCompany adapter, a duplicate type, a bad type and a bad code', () => {
    expect(code(() => registerWorkflowAdapter(adapter({ payEffect: 'PAY' as never })))).toBe('WFE_ADAPTER_INVALID');
    expect(code(() => registerWorkflowAdapter(adapter({ payEffect: undefined })))).toBe('WFE_ADAPTER_INVALID');
    expect(code(() => registerWorkflowAdapter(adapter({ crossCompany: true as never })))).toBe('WFE_ADAPTER_INVALID');
    expect(code(() => registerWorkflowAdapter(adapter({ requestType: 'Bad Type' })))).toBe('WFE_ADAPTER_INVALID');
    expect(code(() => registerWorkflowAdapter(adapter({ requestType: 'single' })))).toBe('WFE_ADAPTER_INVALID');
    expect(code(() => registerWorkflowAdapter(adapter({ closeSources: ['with-drawal'] })))).toBe('WFE_ADAPTER_INVALID');
    expect(code(() => registerWorkflowAdapter(adapter({ pauseReasons: ['CANCEL_REQUESTED'] })))).toBe('WFE_ADAPTER_INVALID'); // engine-owned
    expect(code(() => registerWorkflowAdapter(adapter({ onApproved: undefined })))).toBe('WFE_ADAPTER_INVALID');
    expect(code(() => registerWorkflowAdapter(adapter({ guards: ['not a function'] })))).toBe('WFE_ADAPTER_INVALID');
    expect(code(() => registerWorkflowAdapter(adapter({ requiredDecisionFields: ['nope'] })))).toBe('WFE_ADAPTER_INVALID');
    expect(code(() => registerWorkflowAdapter(adapter({ fieldCatalog: { x: { type: 'enum' } } })))).toBe('WFE_ADAPTER_INVALID');
    expect(code(() => registerWorkflowAdapter(adapter()))).toBeNull();
    expect(code(() => registerWorkflowAdapter(adapter()))).toBe('WFE_ADAPTER_INVALID'); // duplicate
    expect(Object.isFrozen(requireAdapter('tests.reg'))).toBe(true);
    expect(code(() => requireAdapter('tests.none'))).toBe('WFE_ADAPTER_MISSING');
  });
});

describe('ports (fail closed, never overridden)', () => {
  it('a missing port is WFE_PORT_MISSING; a second registration or a port without its method is refused', () => {
    expect(code(() => requirePort('EmployeeLock'))).toBe('WFE_PORT_MISSING');
    const lock = { lockEmployees: async () => [] };
    registerWorkflowPort('EmployeeLock', lock);
    expect(code(() => registerWorkflowPort('EmployeeLock', lock))).toMatch(/already registered/);
    expect(code(() => registerWorkflowPort('ManagerChain', {} as never))).toMatch(/missing method managerOf/);
    expect(code(() => registerWorkflowPort('Nope' as never, lock as never))).toBe('WFE_PORT_MISSING');
  });

  it('every command refuses without the lock port or the state port, before touching the database', async () => {
    registerWorkflowAdapter(adapter());
    const ctx = systemContext('t', 'c1');
    const all = () =>
      Promise.all([
        codeAsync(startWorkflow(untouchable, { ctx, requestType: 'tests.reg', requestId: 'r' })),
        codeAsync(pauseWorkflow(untouchable, { ctx, instanceId: 'i', reason: 'DEFERRAL', callerKey: 'k' })),
        codeAsync(resumeWorkflow(untouchable, { ctx, instanceId: 'i', reason: 'DEFERRAL', callerKey: 'k' })),
        codeAsync(recheckWorkflow(untouchable, { ctx, instanceId: 'i', callerKey: 'k' })),
        codeAsync(resubmitWorkflow(untouchable, { ctx, instanceId: 'i' })),
        codeAsync(restartWorkflowRound(untouchable, { ctx, instanceId: 'i', reason: 'EDITED', callerKey: 'k' })),
        codeAsync(closeWorkflowExternally(untouchable, { ctx, instanceId: 'i', outcome: 'CANCELLED', source: 'WITHDRAWAL', actor: { type: 'SYSTEM', job: 't' } })),
      ]);
    expect(new Set(await all())).toEqual(new Set(['WFE_PORT_MISSING']));
    registerWorkflowPort('EmployeeLock', { lockEmployees: async () => [] });
    expect(new Set(await all())).toEqual(new Set(['WFE_PORT_MISSING'])); // the state port is required too
  });

  it('act and cancel need a person; both refuse a SystemContext and a missing port before the database', async () => {
    const ctx = systemContext('t', 'c1');
    expect(await codeAsync(actOnWorkflowTask(untouchable, { ctx, taskId: 't', expectedVersion: 1, decision: 'APPROVE' }))).toBe('WFE_FORBIDDEN');
    expect(await codeAsync(cancelWorkflow(untouchable, { ctx, instanceId: 'i', expectedVersion: 1, reason: 'x' }))).toBe('WFE_FORBIDDEN');
  });
});

describe('the activation gate (§3.8)', () => {
  it('is never empty in phase 2, and startWorkflow refuses with WFE_NOT_ACTIVATABLE before the database', async () => {
    expect(ACTIVATION_BLOCKERS.length).toBeGreaterThan(0);
    // WFE-003 is lifted by package C (BL-WFE-003); FIRST-TYPE stays until the owner chooses the first request type.
    expect(activationBlockers('tests.reg')).toEqual(['FIRST-TYPE', 'NO-ADAPTER']);
    registerWorkflowAdapter(adapter());
    expect(activationBlockers('tests.reg')).toEqual(['FIRST-TYPE']);
    registerWorkflowPort('EmployeeLock', { lockEmployees: async () => [] });
    registerWorkflowPort('BeneficiaryState', { employees: async () => [], employeesOfUsers: async () => [] });
    expect(await codeAsync(startWorkflow(untouchable, { ctx: systemContext('t', 'c1'), requestType: 'tests.reg', requestId: 'r' }))).toBe('WFE_NOT_ACTIVATABLE');
  });
});

describe('guard test: no adapter in src registers a pay effect (DEC-PO-139)', () => {
  it('every payEffect written in src/ outside the engine is the literal NONE', () => {
    const root = join(__dirname, '..', '..', '..');
    const hits: string[] = [];
    const walkDir = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          if (name !== '__tests__' && name !== 'node_modules') walkDir(p);
          continue;
        }
        if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
        if (p.includes(join('modules', 'workflow'))) continue; // the engine declares the type and checks it
        const text = readFileSync(p, 'utf8');
        for (const m of text.matchAll(/payEffect\s*:\s*([^,}\n]+)/g)) if (m[1].trim() !== "'NONE'" && m[1].trim() !== '"NONE"' && m[1].trim() !== "'NONE' as const") hits.push(`${p}: ${m[0]}`);
      }
    };
    walkDir(root);
    expect(hits).toEqual([]);
  });
});
