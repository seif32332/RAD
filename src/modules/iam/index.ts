// Public API of the iam module (DOMAIN_BOUNDARIES §5.1): other modules and legacy code import from
// '@/modules/iam' only. iam sits just above platform (§5.3) and imports no other module.
//
// P1-FND-SCOPE: the company-scope layers of §5.4.1 — Actor → Company Scope → authz.can → (service) →
// scopedPrisma (fail-closed safety net). Usage in a route:
//
//   const user = await requireUser(ROLE_GROUPS.HR);
//   const ctx = scopedContext(await resolveActor(prisma, user));
//   authz.assert(ctx, 'recruitment.jobRequest.decide', { companyId });
//   const db = scopedPrisma(ctx);
export {
  ALL_COMPANIES,
  MissingScopeContextError,
  actorCompanies,
  actorFromSession,
  resolveActor,
  intersectCompanies,
  companiesAllowed,
  scopedContext,
  selfContext,
  teamContext,
  crossCompanyContext,
  recordCrossCompanyOperation,
  systemContext,
  forEachCompany,
  isScopeContext,
  assertScopeContext,
  CROSS_COMPANY_OPERATIONS,
  CROSS_COMPANY_JOBS,
} from './context';
export type {
  Actor,
  CompanySet,
  ScopeContext,
  ScopedContext,
  SelfContext,
  TeamContext,
  CrossCompanyContext,
  SystemContext,
  CrossCompanyInput,
  SessionUserLike,
  EmployeePlacement,
} from './context';

export {
  scopedPrisma,
  ambientPrisma,
  runInScope,
  currentScope,
  scopeWhere,
  applyScope,
  teamEmployeeWhere,
  isTeamMember,
  ScopeViolationError,
} from './scope';
export type { ScopedPrismaClient, ScopedPrismaOptions, ScopeLookup } from './scope';

export { SCOPE_RULES, INFRA_MODELS, companyScopedModels, scopeRuleOf, buildScopeRules } from './scope-models';
export type { ScopeRule } from './scope-models';

export { authz, POLICIES } from './authz';
export type { AuthzResource, AuthzDecision } from './authz';

export { activeUsersWithRoles } from './users';
export type { ActiveUser } from './users';
