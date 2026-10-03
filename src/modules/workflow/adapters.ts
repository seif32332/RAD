// The adapter contract (wfe-to-be.md §12.10, AUDIT/16 §3.4) and its registry. Each module registers one adapter
// per request type from src/modules/<owner>/workflow-adapter.ts; hooks run inside the engine's transaction and
// call only their own module's transitions, with no side effect (ARC-WFE-A2, ARCH-017.adapter).
//
// What an adapter can NOT do (DEC-PO-145): add a candidate. Candidates come from iam reads only; `guards` can only
// exclude (anything but exactly { ok: true } excludes). It cannot declare a pay effect (payEffect is the literal
// 'NONE', checked at run time too, DEC-PO-139) nor a cross-company type (ARC-WFE-A7).
import type { WorkflowInstanceStatus, WorkflowTaskKind } from '@prisma/client';
import type { AppRole } from '@/lib/constants';
import type { TxClient } from '@/modules/platform';
import type { FieldCatalog } from './definition';
import { WorkflowError } from './errors';

export const REQUEST_TYPE_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;
export const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;

/** Engine-owned pause reason of the cancel confirmation (RT-WFE-905); adapters may not declare it. */
export const CANCEL_REQUESTED = 'CANCEL_REQUESTED';
/** Engine-owned block reason: a step has no eligible candidate (§12.5). */
export const NO_CANDIDATE = 'NO_CANDIDATE';
export const ENGINE_CODES: readonly string[] = Object.freeze([CANCEL_REQUESTED, NO_CANDIDATE]);

export type WfActor = { type: 'USER'; userId: string } | { type: 'SYSTEM'; job: string };

/** The acting user as the adapter sees it (from the session context, never from the client). */
export interface ActorView {
  userId: string;
  role: AppRole;
  employeeId: string | null;
}

export interface InstanceView {
  id: string;
  companyId: string;
  requestType: string;
  requestId: string;
  status: WorkflowInstanceStatus;
  round: number;
  version: number;
  beneficiaryEmployeeIds: readonly string[];
  requesterUserId: string | null;
  contextSnapshot: Readonly<Record<string, unknown>>;
}

export interface StageView {
  nodeId: string;
  kind: WorkflowTaskKind;
  /** The definition stage id (APPROVE), null for the special kinds. */
  stageId: string | null;
}

export type CandidateGuard = (c: { userId: string; instance: InstanceView; stage: StageView }) => { ok: true } | { exclude: true; reason: string };

export interface HookContext {
  instance: InstanceView;
  actor: WfActor;
  operationKey: string;
  /** The stage just approved (onStageApproved), and its decision fields. */
  stage?: StageView;
  decisionFields?: Readonly<Record<string, unknown>>;
  /** Every decision field collected in this round, in stage order. */
  collectedFields?: Readonly<Record<string, unknown>>;
  note?: string | null;
  closeSource?: string | null;
}

export interface Parties {
  beneficiaryEmployeeIds: string[];
  requesterUserId: string | null;
  /** The company when there is no beneficiary (it must be inside the context). */
  companyIdWhenNoBeneficiary?: string;
  contextSnapshot: Record<string, unknown>;
}

export type FinalCheck = { ok: true } | { awaitable: true; requirement: string } | { error: string };

/** What happens to open instances when the beneficiary exits (applied by the owner module's consumer, ARCH-020). */
export interface ExitPolicyDeclaration {
  onTerminated: 'CANCEL' | 'KEEP';
  closeSource?: string;
}

export interface WorkflowAdapter<R = unknown> {
  requestType: string;
  ownerModule: string;
  /** Phase 2: the literal only, checked at run time too (DEC-PO-139). */
  payEffect: 'NONE';
  /** Phase 2 refuses true (ARC-WFE-A7). */
  crossCompany?: false;
  fieldCatalog: FieldCatalog;
  decisionFieldCatalog: FieldCatalog;
  requiredDecisionFields?: readonly string[];
  closeSources: readonly string[];
  pauseReasons: readonly string[];
  blockReasons?: readonly string[];
  decisionStatuses: readonly string[];
  domainStatuses: readonly string[];
  legacyDecisionEntryPoints: readonly string[];
  recheckTriggers: readonly string[];
  /** Interface property only; the core never assigns it (ARCH-020). */
  exitPolicy?: ExitPolicyDeclaration;
  load(tx: TxClient, requestId: string): Promise<R>;
  parties(tx: TxClient, req: R): Promise<Parties>;
  lockKeys?(tx: TxClient, req: R): Promise<void>;
  validateSubmit(tx: TxClient, req: R): Promise<void>;
  validateFinal(tx: TxClient, req: R): Promise<FinalCheck>;
  refresh?(tx: TxClient, req: R): Promise<void>;
  canReject(actor: ActorView, req: R): boolean;
  canReturn(actor: ActorView, req: R): boolean;
  canCancel(actor: ActorView, req: R): boolean;
  cancelNeedsConfirm(instance: InstanceView, req: R): boolean;
  guards?: readonly CandidateGuard[];
  onStageApproved?(tx: TxClient, ctx: HookContext): Promise<void>;
  onApproved(tx: TxClient, ctx: HookContext): Promise<void>;
  onRejected(tx: TxClient, ctx: HookContext): Promise<void>;
  onReturned?(tx: TxClient, ctx: HookContext): Promise<void>;
  onCancelled(tx: TxClient, ctx: HookContext): Promise<void>;
  summary(viewer: ActorView, req: R): Record<string, unknown>;
}

const registry = new Map<string, WorkflowAdapter<unknown>>();

const REQUIRED_FUNCTIONS = ['load', 'parties', 'validateSubmit', 'validateFinal', 'canReject', 'canReturn', 'canCancel', 'cancelNeedsConfirm', 'onApproved', 'onRejected', 'onCancelled', 'summary'] as const;
const OPTIONAL_FUNCTIONS = ['lockKeys', 'refresh', 'onStageApproved', 'onReturned'] as const;

function refuse(detail: string): never {
  throw new WorkflowError('WFE_ADAPTER_INVALID', detail);
}

function codes(list: unknown, what: string, allowEngine = false): void {
  if (!Array.isArray(list)) refuse(`${what} must be a list of codes`);
  for (const c of list) {
    if (typeof c !== 'string' || !CODE_PATTERN.test(c)) refuse(`${what}: "${String(c)}" is not a code (${CODE_PATTERN})`);
    if (!allowEngine && ENGINE_CODES.includes(c)) refuse(`${what}: "${c}" is reserved by the engine`);
  }
}

/** Runtime validation of an adapter (the types are not trusted: a cast must not get through). */
export function validateAdapter(a: WorkflowAdapter<unknown>): void {
  if (!a || typeof a !== 'object') refuse('adapter must be an object');
  if (typeof a.requestType !== 'string' || !REQUEST_TYPE_PATTERN.test(a.requestType)) refuse(`bad request type "${String(a.requestType)}"`);
  if (typeof a.ownerModule !== 'string' || !/^[a-z][a-z0-9]*$/.test(a.ownerModule) || a.ownerModule === 'workflow') refuse('ownerModule must name the owning module');
  if ((a as { payEffect?: unknown }).payEffect !== 'NONE') refuse('DEC-PO-139: payEffect must be NONE in phase 2');
  if ((a as { crossCompany?: unknown }).crossCompany !== undefined && (a as { crossCompany?: unknown }).crossCompany !== false) refuse('ARC-WFE-A7: crossCompany adapters are refused in phase 2');
  for (const k of ['fieldCatalog', 'decisionFieldCatalog'] as const) {
    const cat = a[k];
    if (!cat || typeof cat !== 'object' || Array.isArray(cat)) refuse(`${k} must be an object`);
    for (const [name, spec] of Object.entries(cat)) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name)) refuse(`${k}: bad field name "${name}"`);
      if (!spec || !['string', 'number', 'boolean', 'date', 'enum'].includes(spec.type)) refuse(`${k}.${name}: bad type`);
      if (spec.type === 'enum' && (!Array.isArray(spec.values) || !spec.values.length)) refuse(`${k}.${name}: an enum needs values`);
    }
  }
  for (const f of a.requiredDecisionFields ?? []) if (!(f in a.decisionFieldCatalog)) refuse(`requiredDecisionFields: "${f}" is not in decisionFieldCatalog`);
  codes(a.closeSources, 'closeSources');
  codes(a.pauseReasons, 'pauseReasons');
  if (a.blockReasons !== undefined) codes(a.blockReasons, 'blockReasons');
  for (const k of ['decisionStatuses', 'domainStatuses', 'legacyDecisionEntryPoints', 'recheckTriggers'] as const) {
    if (!Array.isArray(a[k]) || !a[k].every((x) => typeof x === 'string')) refuse(`${k} must be a list of strings`);
  }
  for (const f of REQUIRED_FUNCTIONS) if (typeof a[f] !== 'function') refuse(`missing ${f}()`);
  for (const f of OPTIONAL_FUNCTIONS) if (a[f] !== undefined && typeof a[f] !== 'function') refuse(`${f} must be a function`);
  if (a.guards !== undefined && (!Array.isArray(a.guards) || !a.guards.every((g) => typeof g === 'function'))) refuse('guards must be a list of functions');
  if (a.exitPolicy !== undefined) {
    const p = a.exitPolicy;
    if (!p || !['CANCEL', 'KEEP'].includes(p.onTerminated)) refuse('exitPolicy.onTerminated must be CANCEL or KEEP');
    if (p.closeSource !== undefined) codes([p.closeSource], 'exitPolicy.closeSource');
  }
}

export function registerWorkflowAdapter<R>(adapter: WorkflowAdapter<R>): void {
  const a = adapter as unknown as WorkflowAdapter<unknown>;
  validateAdapter(a);
  if (registry.has(a.requestType)) refuse(`request type ${a.requestType} is already registered`);
  registry.set(a.requestType, Object.freeze({ ...a, guards: a.guards ? Object.freeze([...a.guards]) : undefined }));
}

export function adapterOf(requestType: string): WorkflowAdapter<unknown> | undefined {
  return registry.get(requestType);
}

export function requireAdapter(requestType: string): WorkflowAdapter<unknown> {
  const a = registry.get(requestType);
  if (!a) throw new WorkflowError('WFE_ADAPTER_MISSING', requestType);
  // Re-checked on every use: a registered adapter is frozen, but the check costs nothing (DEC-PO-139).
  if ((a as { payEffect?: unknown }).payEffect !== 'NONE') throw new WorkflowError('WFE_PAY_EFFECT_UNSUPPORTED', requestType);
  return a;
}

export function registeredRequestTypes(): string[] {
  return [...registry.keys()].sort();
}

/** testing.ts only. */
export function resetAdapterRegistry(): void {
  registry.clear();
}
