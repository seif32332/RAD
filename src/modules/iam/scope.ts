// The Prisma scope extension (DOMAIN_BOUNDARIES §5.4.1, layer "Prisma scope extension"): a SAFETY NET
// under authz.can and the domain service, not the source of the permission.
//
//   const db = scopedPrisma(ctx);          // throws MissingScopeContextError without a context
//   await db.leave.findMany({ where });    // + the context's company (and Self / Team) filter
//   await db.jobRequest.create({ data });  // refused when data.companyId is outside the context
//
// On a company-scoped model (scope-models.ts):
//   reads   findUnique(OrThrow) / findFirst(OrThrow) / findMany / count / aggregate / groupBy
//           → the context filter is AND-ed into `where` (a row of another company is "not found").
//   writes  update / updateMany / delete / deleteMany / upsert → the same filter on `where`, so a row
//           of another company is never matched (P2025 / count 0); create / createMany /
//           createManyAndReturn / the create and update data of upsert and update → the company (or
//           employee) the data points to must be inside the context, and must be KNOWN: a restricted
//           context never creates a row without a company (fail closed). A read-only
//           CrossCompanyContext refuses every write.
//   other operations on a scoped model are refused.
// Raw SQL ($queryRaw, $executeRaw, …Unsafe) is refused on the scoped client: raw SQL lives in
// src/modules/<m>/sql/ and takes companyIds explicitly (ARCH-009).
// Models that are not company-scoped (users, audit, outbox, settings…) pass through unchanged.
//
// Limits (why authz and the service stay the decision, §5.4.1): relations reached through include /
// select / nested writes are not filtered; nor is the global `prisma` client, which legacy code still
// uses until each package moves to the scoped client (ratchet).
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma as rootPrisma } from '@/lib/prisma';
import { HttpError } from '@/lib/http';
import { ALL_COMPANIES, MissingScopeContextError, assertScopeContext, isScopeContext, type ScopeContext, type TeamContext } from './context';
import { scopeRuleOf, type ScopeRule } from './scope-models';

/** A query the context does not allow (403 in a route through handleApiError). */
export class ScopeViolationError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(403, 'هذه العملية خارج نطاق صلاحياتك', { reason: message, ...(details && typeof details === 'object' ? details : {}) });
    this.name = 'ScopeViolationError';
  }
}

type Where = Record<string, unknown>;
type Args = Record<string, unknown> | undefined;

const READ_OPS = new Set(['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany', 'count', 'aggregate', 'groupBy']);
const WHERE_WRITE_OPS = new Set(['update', 'updateMany', 'delete', 'deleteMany', 'upsert']);
const CREATE_OPS = new Set(['create', 'createMany', 'createManyAndReturn']);

/** Loads rows by id (unscoped, for the write checks): `model` is the Prisma model name. */
export type ScopeLookup = (model: string, ids: string[], select: string[]) => Promise<Record<string, unknown>[]>;

const TEAM_FIELDS = ['id', 'legalCompanyId', 'directManagerId', 'branchId', 'departmentId'];

function restricted(ctx: ScopeContext): boolean {
  return ctx.kind === 'self' || ctx.kind === 'team' || ctx.companies !== ALL_COMPANIES;
}

function companyIn(ctx: ScopeContext): { in: string[] } {
  return { in: ctx.companies === ALL_COMPANIES ? [] : [...ctx.companies] };
}

/** Prisma filter of the manager's team (Employee rows), company included. */
export function teamEmployeeWhere(ctx: TeamContext): Prisma.EmployeeWhereInput {
  const or: Prisma.EmployeeWhereInput[] = [{ id: ctx.managerEmployeeId }, { directManagerId: ctx.managerEmployeeId }];
  if (ctx.branchId) or.push({ branchId: ctx.branchId });
  if (ctx.departmentId) or.push({ departmentId: ctx.departmentId });
  const company: Prisma.EmployeeWhereInput =
    ctx.companies === ALL_COMPANIES ? {} : { legalCompanyId: { in: [...ctx.companies] } };
  return { AND: [{ OR: or }, company] };
}

/** Same membership rule as teamEmployeeWhere, on a loaded employee row. */
export function isTeamMember(
  ctx: TeamContext,
  e: { id?: unknown; legalCompanyId?: unknown; directManagerId?: unknown; branchId?: unknown; departmentId?: unknown },
): boolean {
  if (ctx.companies !== ALL_COMPANIES && !(typeof e.legalCompanyId === 'string' && ctx.companies.includes(e.legalCompanyId))) return false;
  if (e.id === ctx.managerEmployeeId || e.directManagerId === ctx.managerEmployeeId) return true;
  if (ctx.branchId && e.branchId === ctx.branchId) return true;
  return !!ctx.departmentId && e.departmentId === ctx.departmentId;
}

/**
 * The `where` fragment a context adds to a query on `model`; null = no restriction (unrestricted
 * context, or a model that is not company-scoped). Throws for a model the context cannot filter.
 * Exported for legacy code inside a root-client transaction: `where: { AND: [where, scopeWhere(ctx, 'JobRequest')] }`.
 */
export function scopeWhere(ctx: ScopeContext, model: string): Where | null {
  assertScopeContext(ctx, `scopeWhere(${model})`);
  const rule = scopeRuleOf(model);
  if (!rule) return null;
  return filterFor(ctx, model, rule);
}

function filterFor(ctx: ScopeContext, model: string, rule: ScopeRule): Where | null {
  if (ctx.kind === 'self') {
    switch (rule.kind) {
      case 'employee':
        return { id: ctx.employeeId };
      case 'via-employee':
      case 'employee-column':
        return { employeeId: ctx.employeeId };
      default:
        return companyFilter(ctx, rule);
    }
  }
  if (ctx.kind === 'team') {
    const team = teamEmployeeWhere(ctx);
    switch (rule.kind) {
      case 'employee':
        return team;
      case 'via-employee':
        return { [rule.relation]: { is: team } };
      case 'employee-column':
        throw new ScopeViolationError(`${model} has no employee relation: it cannot be read in a team context`, { model });
      default:
        return companyFilter(ctx, rule);
    }
  }
  if (ctx.companies === ALL_COMPANIES) return null;
  switch (rule.kind) {
    case 'employee':
      return { legalCompanyId: companyIn(ctx) };
    case 'via-employee':
      return { [rule.relation]: { is: { legalCompanyId: companyIn(ctx) } } };
    case 'employee-column':
      throw new ScopeViolationError(`${model} has no company key: it needs an unrestricted or Self context`, { model });
    default:
      return companyFilter(ctx, rule);
  }
}

function companyFilter(ctx: ScopeContext, rule: ScopeRule): Where | null {
  if (ctx.companies === ALL_COMPANIES) return null;
  switch (rule.kind) {
    case 'company':
      return { id: companyIn(ctx) };
    case 'column':
      return { [rule.column]: companyIn(ctx) };
    case 'via-parent':
      return { [rule.relation]: { is: { [rule.parentColumn]: companyIn(ctx) } } };
    default:
      return null;
  }
}

function andWhere(where: unknown, filter: Where | null): unknown {
  if (!filter) return where;
  const w = (where && typeof where === 'object' ? where : {}) as Where;
  const and = w.AND === undefined ? [] : Array.isArray(w.AND) ? w.AND : [w.AND];
  return { ...w, AND: [...and, filter] };
}

// ---------------------------------------------------------------------------------------------------
// Write checks
// ---------------------------------------------------------------------------------------------------

const UNKNOWN = Symbol('unknown');
type Extracted = string | null | undefined | typeof UNKNOWN;

/** The value `data` gives to a scalar FK column, directly or through its relation. undefined = untouched. */
function extract(data: Where, column: string, relation: string | null): Extracted {
  if (column in data) {
    const v = data[column];
    if (v && typeof v === 'object') return 'set' in (v as Where) ? norm((v as Where).set) : UNKNOWN;
    return norm(v);
  }
  if (relation && relation in data) {
    const r = data[relation] as Where | null | undefined;
    if (!r || typeof r !== 'object') return UNKNOWN;
    if (r.disconnect === true) return null;
    const c = r.connect as Where | undefined;
    if (c && typeof c === 'object' && Object.keys(c).length === 1 && typeof c.id === 'string') return c.id;
    return UNKNOWN; // create / connectOrCreate / connect by another unique: company unknown here
  }
  return undefined;
}

function norm(v: unknown): string | null | typeof UNKNOWN {
  if (v === null) return null;
  return typeof v === 'string' ? v : UNKNOWN;
}

function refuse(model: string, why: string): never {
  throw new ScopeViolationError(`${model}: ${why}`, { model });
}

function inCompanies(ctx: ScopeContext, id: string | null | undefined): boolean {
  if (ctx.companies === ALL_COMPANIES) return true;
  return !!id && ctx.companies.includes(id);
}

async function checkData(ctx: ScopeContext, model: string, rule: ScopeRule, data: unknown, creating: boolean, lookup: ScopeLookup) {
  if (!data || typeof data !== 'object') return;
  const d = data as Where;
  const checkCompany = (v: Extracted) => {
    if (v === undefined && !creating) return;
    if (v === UNKNOWN) refuse(model, 'the company of the written row cannot be determined');
    if (!inCompanies(ctx, v)) refuse(model, 'write to a company outside the context');
  };
  switch (rule.kind) {
    case 'company':
      if (creating && ctx.companies !== ALL_COMPANIES) refuse(model, 'creating a company needs an unrestricted context');
      return;
    case 'column':
      return checkCompany(extract(d, rule.column, rule.relation));
    case 'employee': {
      if (creating && (ctx.kind === 'self' || ctx.kind === 'team')) refuse(model, 'a self or team context does not create employees');
      const v = extract(d, 'legalCompanyId', 'legalCompany');
      if (ctx.kind === 'self' || ctx.kind === 'team') {
        if (v !== undefined) refuse(model, 'a self or team context does not move an employee to a company');
        return;
      }
      return checkCompany(v);
    }
    case 'via-parent': {
      const v = extract(d, `${rule.relation}Id`, rule.relation);
      if (v === undefined && !creating) return;
      if (v === UNKNOWN || !v) return refuse(model, 'the parent of the written row cannot be determined');
      if (ctx.companies === ALL_COMPANIES) return;
      const parentModel = parentModelOf(rule.relation);
      const [row] = await lookup(parentModel, [v], [rule.parentColumn]);
      if (!row || !inCompanies(ctx, row[rule.parentColumn] as string | null)) refuse(model, 'write under a parent outside the context');
      return;
    }
    case 'via-employee':
    case 'employee-column': {
      const v = extract(d, 'employeeId', rule.kind === 'via-employee' ? rule.relation : null);
      if (v === undefined && !creating) return;
      if (v === UNKNOWN) refuse(model, 'the employee of the written row cannot be determined');
      if (!v) {
        if (restricted(ctx)) refuse(model, 'a restricted context does not write a row without an employee');
        return;
      }
      if (ctx.kind === 'self') {
        if (v !== ctx.employeeId) refuse(model, 'a self context writes only its own rows');
        return;
      }
      if (!restricted(ctx)) return;
      // The employee's company is loaded (unscoped); an employee created in the same, still open
      // transaction is not visible here and the write is refused (fail closed).
      const [e] = await lookup('Employee', [v], TEAM_FIELDS);
      if (!e) refuse(model, 'unknown employee');
      if (ctx.kind === 'team' ? !isTeamMember(ctx, e) : !inCompanies(ctx, e.legalCompanyId as string | null)) {
        refuse(model, 'write for an employee outside the context');
      }
      return;
    }
  }
}

/** Relation name → model name for the INDIRECT parents (Department.branch → Branch). */
function parentModelOf(relation: string): string {
  return relation.charAt(0).toUpperCase() + relation.slice(1);
}

/**
 * Rewrites (reads, where-writes) or checks (creates, data) one operation for the context. Pure apart
 * from `lookup`. Exported for the unit tests and for services that build queries by hand.
 */
export async function applyScope(ctx: ScopeContext, model: string, operation: string, args: Args, lookup: ScopeLookup): Promise<Args> {
  assertScopeContext(ctx, `${model}.${operation}`);
  const rule = scopeRuleOf(model);
  if (!rule) return args;
  const a = { ...(args ?? {}) } as Where;
  const isWrite = WHERE_WRITE_OPS.has(operation) || CREATE_OPS.has(operation);
  if (isWrite && ctx.kind === 'crossCompany' && ctx.readOnly) refuse(model, `read-only cross-company operation "${ctx.operation}"`);
  if (READ_OPS.has(operation)) {
    const f = filterFor(ctx, model, rule);
    if (f) a.where = andWhere(a.where, f);
    return a;
  }
  if (WHERE_WRITE_OPS.has(operation)) {
    const f = filterFor(ctx, model, rule);
    if (f) a.where = andWhere(a.where, f);
    if (operation === 'upsert') {
      await checkData(ctx, model, rule, a.create, true, lookup);
      await checkData(ctx, model, rule, a.update, false, lookup);
    } else if (operation === 'update' || operation === 'updateMany') {
      await checkData(ctx, model, rule, a.data, false, lookup);
    }
    return a;
  }
  if (CREATE_OPS.has(operation)) {
    const rows = Array.isArray(a.data) ? a.data : [a.data];
    for (const row of rows) await checkData(ctx, model, rule, row, true, lookup);
    return a;
  }
  refuse(model, `operation ${operation} is not supported on the scoped client`);
}

// ---------------------------------------------------------------------------------------------------
// The clients
// ---------------------------------------------------------------------------------------------------

type Delegate = { findMany: (args: unknown) => Promise<Record<string, unknown>[]> };

function lookupOn(base: PrismaClient): ScopeLookup {
  return async (model, ids, select) => {
    const delegate = (base as unknown as Record<string, Delegate>)[model.charAt(0).toLowerCase() + model.slice(1)];
    if (!delegate) throw new Error(`scope lookup: no model ${model}`);
    return delegate.findMany({ where: { id: { in: ids } }, select: Object.fromEntries(select.map((s) => [s, true])) });
  };
}

function rawRefused(operation: string): never {
  throw new ScopeViolationError(`raw SQL (${operation}) is refused on the scoped client; use src/modules/<m>/sql with companyIds (ARCH-009)`);
}

export interface ScopedPrismaOptions {
  /** Row loader for the write checks (default: unscoped reads on `base`). Tests pass a fixture. */
  lookup?: ScopeLookup;
}

function extend(base: PrismaClient, resolve: (model: string, operation: string) => ScopeContext | null, opts: ScopedPrismaOptions = {}) {
  const lookup = opts.lookup ?? lookupOn(base);
  return base.$extends({
    name: 'iam-company-scope',
    query: {
      async $allOperations({ model, operation, args, query }) {
        if (!model) rawRefused(operation);
        if (!scopeRuleOf(model)) return query(args);
        const ctx = resolve(model, operation);
        if (!ctx) throw new MissingScopeContextError(`${model}.${operation}`);
        return query((await applyScope(ctx, model, operation, args as Args, lookup)) as typeof args);
      },
    },
  });
}

export type ScopedPrismaClient = ReturnType<typeof extend>;

/**
 * A Prisma client bound to one context. Throws MissingScopeContextError immediately when `ctx` is
 * missing or is not a context built by @/modules/iam (fail closed). New module code uses this client,
 * never the global `prisma`, for company-scoped models.
 */
export function scopedPrisma(ctx: ScopeContext, base: PrismaClient = rootPrisma, opts?: ScopedPrismaOptions): ScopedPrismaClient {
  assertScopeContext(ctx, 'scopedPrisma');
  return extend(base, () => ctx, opts);
}

// Ambient variant: one client whose context comes from runInScope (AsyncLocalStorage). A query on a
// company-scoped model outside runInScope throws MissingScopeContextError; that is the §5.4.1 rule
// "any query on a scoped model without a context throws".
const store = new AsyncLocalStorage<ScopeContext>();
const ambientClients = new WeakMap<PrismaClient, ScopedPrismaClient>();

/**
 * Runs `fn` with `ctx` as the ambient context. The result is awaited INSIDE the scope: Prisma queries
 * are lazy (they run when awaited), so returning an un-awaited query would run it without a context.
 */
export async function runInScope<T>(ctx: ScopeContext, fn: () => T | PromiseLike<T>): Promise<T> {
  assertScopeContext(ctx, 'runInScope');
  return store.run(ctx, async () => await fn());
}

export function currentScope(): ScopeContext | null {
  const ctx = store.getStore();
  return ctx && isScopeContext(ctx) ? ctx : null;
}

/** The ambient scoped client (context from runInScope). */
export function ambientPrisma(base: PrismaClient = rootPrisma): ScopedPrismaClient {
  let client = ambientClients.get(base);
  if (!client) {
    client = extend(base, () => currentScope());
    ambientClients.set(base, client);
  }
  return client;
}
