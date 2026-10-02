// Scope contexts (DOMAIN_BOUNDARIES §5.4.1 layers "Actor" and "Company Scope", §5.4.2 context kinds).
//
// A context says, for one request or one job, which companies (and, for Self / Team, which employees)
// the code may touch. It is built once at the edge (route handler or job) and passed explicitly to the
// domain service, which passes it to every query (scopedPrisma(ctx), scope.ts).
//
// Contexts are only created by the constructors below: each one is frozen and registered in a WeakSet,
// so a hand-made object literal ({ kind: 'scoped', companies: 'ALL' }) is refused by scopedPrisma and
// authz (fail closed).
import { randomUUID } from 'crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { audit } from '@/modules/platform';
import { ROLE_GROUPS, roleIn, type AppRole } from '@/lib/constants';
import { forbidden } from '@/lib/http';

type Db = PrismaClient | Prisma.TransactionClient;

/** Every company of the tenant database. */
export const ALL_COMPANIES = 'ALL' as const;
/** The companies a context may touch: ALL, or an explicit list (an empty list touches nothing). */
export type CompanySet = typeof ALL_COMPANIES | readonly string[];

export interface Actor {
  readonly kind: 'user';
  readonly userId: string;
  readonly role: AppRole;
  /** Employee.id linked to the user (from the session, never from the client). */
  readonly employeeId: string | null;
  /** Explicit owner role (ROLE_GROUPS.OWNER): every company, may open a CrossCompanyContext. */
  readonly isOwner: boolean;
  /** Companies of the actor's UserCompanyScope rows (see actorCompanies). */
  readonly companies: CompanySet;
}

interface Base {
  readonly companies: CompanySet;
}
export interface ScopedContext extends Base {
  readonly kind: 'scoped';
  readonly actor: Actor;
}
export interface SelfContext extends Base {
  readonly kind: 'self';
  readonly actor: Actor;
  readonly employeeId: string;
}
/** The manager's team (§5.4.2, EV-6009): direct reports, own branch / department, inside his company. */
export interface TeamContext extends Base {
  readonly kind: 'team';
  readonly actor: Actor;
  readonly managerEmployeeId: string;
  readonly branchId: string | null;
  readonly departmentId: string | null;
}
export interface CrossCompanyContext extends Base {
  readonly kind: 'crossCompany';
  readonly actor: Actor;
  readonly reason: string;
  /** Named operation (CROSS_COMPANY_OPERATIONS) or 'owner' for an owner's ad-hoc cross-company work. */
  readonly operation: string;
  /** Writes refused through scopedPrisma (e.g. rehire-eligibility returns eligibility only). */
  readonly readOnly: boolean;
  /** The AuditRecord row written when the context was opened. */
  readonly auditId: string;
  readonly contextId: string;
}
export interface SystemContext extends Base {
  readonly kind: 'system';
  readonly job: string;
}
export type ScopeContext = ScopedContext | SelfContext | TeamContext | CrossCompanyContext | SystemContext;

export class MissingScopeContextError extends Error {
  constructor(what: string) {
    super(`${what}: no scope context. Build one with scopedContext / selfContext / teamContext / crossCompanyContext / systemContext (@/modules/iam)`);
    this.name = 'MissingScopeContextError';
  }
}

const issued = new WeakSet<object>();

function issue<T extends ScopeContext>(ctx: T): T {
  const companies = ctx.companies === ALL_COMPANIES ? ALL_COMPANIES : Object.freeze([...new Set(ctx.companies)]);
  const frozen = Object.freeze({ ...ctx, companies } as T);
  issued.add(frozen);
  return frozen;
}

/** True for a context built by this module (not a look-alike object). */
export function isScopeContext(value: unknown): value is ScopeContext {
  return !!value && typeof value === 'object' && issued.has(value);
}

export function assertScopeContext(value: unknown, what: string): asserts value is ScopeContext {
  if (!isScopeContext(value)) throw new MissingScopeContextError(what);
}

// ---------------------------------------------------------------------------------------------------
// Actor and its company scope
// ---------------------------------------------------------------------------------------------------

/**
 * The actor's companies: UserCompanyScope rows; every company for an explicit owner role.
 * Transitional rule kept from phase 0 (docs/document-engine SPEC §10): a staff user WITHOUT scope rows
 * still sees every company until P1-SCOPE makes the scope mandatory.
 */
export async function actorCompanies(db: Db, user: { id: string; role: string }): Promise<CompanySet> {
  if (roleIn(user.role, ROLE_GROUPS.OWNER)) return ALL_COMPANIES;
  const rows = await db.userCompanyScope.findMany({ where: { userId: user.id }, select: { companyId: true } });
  return rows.length ? rows.map((r) => r.companyId) : ALL_COMPANIES;
}

export interface SessionUserLike {
  id: string;
  role: AppRole;
  employeeId: string | null;
  documentsOnly?: boolean;
}

/** Actor from an authenticated session user (requireUser) and its resolved companies. */
export function actorFromSession(user: SessionUserLike, companies: CompanySet): Actor {
  if (!user?.id) throw new MissingScopeContextError('actorFromSession');
  if (user.documentsOnly) throw forbidden('حساب المستندات فقط لا يملك نطاق عمل');
  const isOwner = roleIn(user.role, ROLE_GROUPS.OWNER);
  return Object.freeze({
    kind: 'user' as const,
    userId: user.id,
    role: user.role,
    employeeId: user.employeeId ?? null,
    isOwner,
    companies: isOwner ? ALL_COMPANIES : companies === ALL_COMPANIES ? ALL_COMPANIES : Object.freeze([...companies]),
  });
}

/** actorFromSession with the companies loaded from UserCompanyScope. */
export async function resolveActor(db: Db, user: SessionUserLike): Promise<Actor> {
  return actorFromSession(user, await actorCompanies(db, user));
}

/** Intersection of two company sets. */
export function intersectCompanies(a: CompanySet, b: CompanySet): CompanySet {
  if (a === ALL_COMPANIES) return b;
  if (b === ALL_COMPANIES) return a;
  return a.filter((id) => b.includes(id));
}

/** True when every id is inside the set; an unknown company (null) is inside ALL only (fail closed). */
export function companiesAllowed(set: CompanySet, companyIds: readonly (string | null | undefined)[]): boolean {
  if (set === ALL_COMPANIES) return true;
  return companyIds.every((id) => !!id && set.includes(id));
}

// ---------------------------------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------------------------------

/**
 * Staff context over the actor's companies, or a NARROWER list (e.g. the one company of the record
 * being worked on). Asking for a company outside the actor's scope is a 403.
 */
export function scopedContext(actor: Actor, companyIds: CompanySet = actor.companies): ScopedContext {
  if (actor?.kind !== 'user') throw new MissingScopeContextError('scopedContext');
  if (companyIds === ALL_COMPANIES) {
    if (actor.companies !== ALL_COMPANIES) throw forbidden('هذه الشركة خارج نطاق صلاحياتك');
  } else if (!companiesAllowed(actor.companies, companyIds)) {
    throw forbidden('هذه الشركة خارج نطاق صلاحياتك');
  }
  return issue({ kind: 'scoped', actor, companies: companyIds });
}

/**
 * The session employee's placement, loaded by the caller from Employee (people/org tables, which iam
 * does not read: §5.3, ARCH-001). The people-layer resolvers resolveSelfContext / resolveTeamContext
 * (src/lib/employee-scope.ts) load it and call the constructors below.
 */
export interface EmployeePlacement {
  legalCompanyId: string | null;
  branchId?: string | null;
  departmentId?: string | null;
}

/**
 * Employee self-service: his own records only. The employee is the session's (actor.employeeId), never
 * a client value (EV-6008). `companies` = his legal company, for the company-keyed tables he may read
 * (brand profile, branches…); an employee without a legal company reads no company-keyed row.
 */
export function selfContext(actor: Actor, me: EmployeePlacement | null): SelfContext {
  if (actor?.kind !== 'user') throw new MissingScopeContextError('selfContext');
  if (!actor.employeeId || !me) throw forbidden('حسابك غير مرتبط بملف موظف');
  return issue({ kind: 'self', actor, employeeId: actor.employeeId, companies: me.legalCompanyId ? [me.legalCompanyId] : [] });
}

/**
 * Manager's team (same membership rule as assertCanManageEmployee: direct reports; the branch of a
 * BRANCH_MANAGER; the department of a DEPT_MANAGER; himself), restricted to his OWN legal company
 * intersected with the actor's company scope. Phase 0 found that the legacy manager scope has no
 * company dimension (a BRANCH_MANAGER could reach a direct report registered on another company);
 * here a report of another company is outside the team. A manager without a legal company has an
 * empty team (fail closed).
 */
export function teamContext(actor: Actor, me: EmployeePlacement | null): TeamContext {
  if (actor?.kind !== 'user') throw new MissingScopeContextError('teamContext');
  if (!roleIn(actor.role, ROLE_GROUPS.MANAGERS)) throw forbidden();
  if (!actor.employeeId || !me) throw forbidden('حسابك غير مرتبط بملف موظف');
  const companies = me.legalCompanyId ? intersectCompanies([me.legalCompanyId], actor.companies) : [];
  return issue({
    kind: 'team',
    actor,
    managerEmployeeId: actor.employeeId,
    branchId: actor.role === 'BRANCH_MANAGER' ? (me.branchId ?? null) : null,
    departmentId: actor.role === 'DEPT_MANAGER' ? (me.departmentId ?? null) : null,
    companies,
  });
}

/**
 * Named cross-company operations a NON-owner may open (§5.4.3 "عمليات عابرة للشركات مسموحة").
 * An explicit owner role may open any operation with a reason. Adding an entry is a reviewed change.
 */
export const CROSS_COMPANY_OPERATIONS: Readonly<Record<string, { roles: readonly string[]; readOnly: boolean }>> = Object.freeze({
  // recruitment / onboarding: re-hire eligibility across companies returns the eligibility only.
  'rehire-eligibility': { roles: ROLE_GROUPS.HR, readOnly: true },
});

export interface CrossCompanyInput {
  reason: string;
  /** Named operation; defaults to 'owner' (owner roles only). */
  operation?: string;
  /** Limit to some companies (default: every company). */
  companyIds?: CompanySet;
  ipAddress?: string | null;
}

function isRootClient(db: Db): db is PrismaClient {
  return typeof (db as { $transaction?: unknown }).$transaction === 'function';
}

/**
 * Explicit, audited cross-company context (§5.4.2 CrossCompanyContext). Refused unless the actor has an
 * explicit owner role or the operation is a named one his role may open. Opening it writes an
 * AuditRecord (action `iam.crossCompany.open`, the reason, the operation, the companies) in the given
 * transaction, or in its own transaction when given the root client; the context carries that row's id.
 * Each write made under it should also be recorded with recordCrossCompanyOperation.
 */
export async function crossCompanyContext(db: Db, actor: Actor, input: CrossCompanyInput): Promise<CrossCompanyContext> {
  if (actor?.kind !== 'user') throw new MissingScopeContextError('crossCompanyContext');
  const reason = input?.reason?.trim() ?? '';
  if (reason.length < 3) throw forbidden('العملية العابرة للشركات تتطلب سبباً');
  const operation = input.operation?.trim() || 'owner';
  let readOnly = false;
  if (operation === 'owner') {
    if (!actor.isOwner) throw forbidden('العمليات العابرة للشركات لدور المالك فقط');
  } else {
    const named = CROSS_COMPANY_OPERATIONS[operation];
    if (!named) throw forbidden('عملية عابرة للشركات غير معرّفة');
    if (!actor.isOwner && !roleIn(actor.role, named.roles)) throw forbidden();
    readOnly = named.readOnly;
  }
  const companies = input.companyIds ?? ALL_COMPANIES;
  const contextId = randomUUID();
  const write = (tx: Prisma.TransactionClient) =>
    audit(tx, {
      actor: { type: 'USER', id: actor.userId },
      action: 'iam.crossCompany.open',
      entity: { type: 'CrossCompanyContext', id: contextId },
      reason,
      after: { operation, readOnly, role: actor.role, companies },
      ipAddress: input.ipAddress ?? null,
    });
  const row = isRootClient(db) ? await db.$transaction((tx) => write(tx)) : await write(db);
  return issue({ kind: 'crossCompany', actor, reason, operation, readOnly, auditId: row.id, contextId, companies });
}

/** Audit row for one operation made under a CrossCompanyContext (the reason is repeated on every row). */
export async function recordCrossCompanyOperation(
  tx: Prisma.TransactionClient,
  ctx: CrossCompanyContext,
  input: { action: string; entity: { type: string; id?: string | null; companyId?: string | null }; before?: unknown; after?: unknown },
): Promise<{ id: string }> {
  assertScopeContext(ctx, 'recordCrossCompanyOperation');
  if (ctx.kind !== 'crossCompany') throw new Error('recordCrossCompanyOperation: not a CrossCompanyContext');
  return audit(tx, {
    actor: { type: 'USER', id: ctx.actor.userId },
    action: input.action,
    entity: input.entity,
    before: input.before,
    after: { ...(input.after && typeof input.after === 'object' ? input.after : { value: input.after ?? null }), crossCompanyContextId: ctx.contextId, operation: ctx.operation },
    reason: ctx.reason,
  });
}

/**
 * Jobs defined as cross-company (§5.4.2: "إلا المهام المعرفة عابرةً للشركات، مثل تنظيف الـoutbox").
 * Every other job runs company by company (forEachCompany). Adding an entry is a reviewed change.
 */
export const CROSS_COMPANY_JOBS: readonly string[] = Object.freeze([
  // The outboxes: NotificationOutbox has no company; the DomainEvent dispatcher also takes events
  // without a company, and every consumer scopes its own effect.
  'outbox-dispatch',
  'domain-events',
  // One hash chain per tenant (DocumentEvent), not one per company.
  'documents-integrity',
  // Removal duties owed whatever the company, including files without one (P1-FND-JOBS): ending the
  // logins of terminated employees (User is tenant-wide) and erasing their biometric data (PDPL).
  'deactivate-terminated',
  'purge-attendance-biometrics',
]);

/** A scheduled job: one company, or every company for a job declared in CROSS_COMPANY_JOBS. */
export function systemContext(job: string, companyId?: string): SystemContext {
  if (!job?.trim()) throw new MissingScopeContextError('systemContext');
  if (companyId) return issue({ kind: 'system', job, companies: [companyId] });
  if (!CROSS_COMPANY_JOBS.includes(job)) {
    throw new Error(`systemContext: job "${job}" is not declared cross-company; run it per company (forEachCompany)`);
  }
  return issue({ kind: 'system', job, companies: ALL_COMPANIES });
}

/**
 * Runs `fn` once per company with a one-company SystemContext (sequentially). The job lists the
 * companies itself (Company is an org table, which iam does not read).
 */
export async function forEachCompany<T>(companyIds: readonly string[], job: string, fn: (ctx: SystemContext) => Promise<T>): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  for (const id of companyIds) out.set(id, await fn(systemContext(job, id)));
  return out;
}
