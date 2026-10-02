// authz.can (DOMAIN_BOUNDARIES §5.4.1, layer "Authorization Policy"): a SKELETON. It covers the actions
// that exist today with the rules the code already applies (role groups of src/lib/constants, the
// company scope, Self = own rows, Team = assertCanManageEmployee's membership). The full permission
// model (Permission / RoleGrant, field level) is P6-AUTHZ. Deny by default: an unknown action, a
// context kind the action does not list, or a resource outside the context is refused.
import { ROLE_GROUPS, roleIn } from '@/lib/constants';
import { forbidden } from '@/lib/http';
import { ALL_COMPANIES, isScopeContext, type ScopeContext } from './context';
import { isTeamMember } from './scope';

export interface AuthzResource {
  /** Company of the record (its scope key, §5.4.3). Unknown (null) is inside an unrestricted context only. */
  companyId?: string | null;
  /** Employee the record belongs to. */
  employeeId?: string | null;
  /** For a Team check: the employee's placement (as loaded from Employee). */
  directManagerId?: string | null;
  branchId?: string | null;
  departmentId?: string | null;
}

type Kind = ScopeContext['kind'];

interface Policy {
  /** Roles allowed (user contexts). */
  roles: readonly string[];
  /** Context kinds the action may run in. */
  contexts: readonly Kind[];
  /** Deciding on one's own record is refused (maker ≠ checker), except for an owner role. */
  notOwnRecord?: boolean;
}

const STAFF_KINDS: readonly Kind[] = ['scoped', 'crossCompany'];

/** The actions that exist today (routes and services). Adding one here is a reviewed change. */
export const POLICIES: Readonly<Record<string, Policy>> = Object.freeze({
  // recruitment (src/app/api/recruitment)
  'recruitment.jobRequest.read': { roles: ROLE_GROUPS.MANAGERS, contexts: ['scoped', 'team', 'crossCompany'] },
  'recruitment.jobRequest.create': { roles: ROLE_GROUPS.MANAGERS, contexts: ['scoped', 'team'] },
  'recruitment.jobRequest.decide': { roles: ROLE_GROUPS.HR, contexts: STAFF_KINDS },
  // onboarding (manager portal submit, incoming-requests decide)
  'onboarding.request.create': { roles: ROLE_GROUPS.MANAGERS, contexts: ['scoped', 'team'] },
  'onboarding.request.decide': { roles: ROLE_GROUPS.HR, contexts: STAFF_KINDS },
  // people
  'employee.read': { roles: ROLE_GROUPS.ALL, contexts: ['scoped', 'self', 'team', 'crossCompany'] },
  'employee.update': { roles: ROLE_GROUPS.HR, contexts: STAFF_KINDS },
  // lifecycle (P1-LCY): exit an employee (T1 / T3; TERMINATE_ROLES of lcy-to-be.md §13 = HR + legal).
  // The two-person acts (T1c, T3n, T4, D1, V1) add their second-person rule in the transition itself.
  'employment.exit': { roles: [...ROLE_GROUPS.HR, 'LEGAL_ADMIN'], contexts: STAFF_KINDS },
  // leave (src/lib/hr-workflows.ts)
  'leave.request.create': { roles: ROLE_GROUPS.ALL, contexts: ['self', 'scoped'] },
  'leave.request.decide': { roles: ROLE_GROUPS.MANAGERS, contexts: ['scoped', 'team'], notOwnRecord: true },
  // time (portal punch)
  'attendance.punch': { roles: ROLE_GROUPS.ALL, contexts: ['self'] },
  // P1-SCOPE part B: leave, time, payroll, settlements, payments, logistics services, insurance and the
  // HR approval hub. The routes keep their own role gates (requireUser and the per-action checks of
  // the workflow helpers); these entries add the context kind and the company (§5.4.3).
  'leave.request.read': { roles: ROLE_GROUPS.ALL, contexts: ['scoped', 'team', 'self'] },
  'leave.request.act': { roles: ROLE_GROUPS.ALL, contexts: ['scoped', 'team', 'self'] },
  'attendance.read': { roles: ROLE_GROUPS.HR, contexts: STAFF_KINDS },
  'attendance.manage': { roles: ROLE_GROUPS.HR, contexts: STAFF_KINDS },
  'attendance.location.read': { roles: ROLE_GROUPS.STAFF, contexts: STAFF_KINDS },
  'attendance.location.manage': { roles: ROLE_GROUPS.HR, contexts: STAFF_KINDS },
  'attendance.correction.read': { roles: ROLE_GROUPS.ALL, contexts: ['scoped', 'team', 'self'] },
  'attendance.correction.create': { roles: ROLE_GROUPS.ALL, contexts: ['scoped', 'team', 'self'] },
  'attendance.correction.decide': { roles: ROLE_GROUPS.MANAGERS, contexts: ['scoped', 'team'] },
  'payroll.read': { roles: [...ROLE_GROUPS.PAYROLL, ...ROLE_GROUPS.MANAGERS], contexts: ['scoped', 'team'] },
  'payroll.hub.act': { roles: ROLE_GROUPS.ALL, contexts: ['scoped', 'team', 'self'] },
  'payroll.run': { roles: ROLE_GROUPS.PAYROLL, contexts: STAFF_KINDS },
  // P1-PAY-B: financial change requests (BR-PAY-009). The second-person and beneficiary rules of a
  // decision are the compensation transition's (money.gateway), not a role check.
  'compensation.change.read': { roles: ROLE_GROUPS.PAYROLL, contexts: STAFF_KINDS },
  'compensation.change.decide': { roles: ROLE_GROUPS.PAYROLL, contexts: STAFF_KINDS },
  'compensation.change.cancel': { roles: ROLE_GROUPS.PAYROLL, contexts: STAFF_KINDS },
  'settlement.read': { roles: [...ROLE_GROUPS.HR, ...ROLE_GROUPS.FINANCE, ...ROLE_GROUPS.GOV], contexts: STAFF_KINDS },
  'settlement.create': { roles: ROLE_GROUPS.HR, contexts: STAFF_KINDS },
  'settlement.decide': { roles: ROLE_GROUPS.FINANCE, contexts: STAFF_KINDS },
  'settlement.muqeem.operate': { roles: ROLE_GROUPS.GOV, contexts: STAFF_KINDS },
  'payment.read': { roles: [...ROLE_GROUPS.FINANCE, ...ROLE_GROUPS.GOV], contexts: STAFF_KINDS },
  'payment.manage': { roles: [...ROLE_GROUPS.FINANCE, ...ROLE_GROUPS.GOV], contexts: STAFF_KINDS },
  // (claims / telecom / utilities use part C's 'logistics.read' / 'logistics.manage')
  'insurance.read': { roles: [...ROLE_GROUPS.HR, ...ROLE_GROUPS.GOV], contexts: STAFF_KINDS },
  'insurance.manage': { roles: [...ROLE_GROUPS.HR, ...ROLE_GROUPS.GOV], contexts: STAFF_KINDS },
  'hrHub.read': { roles: [...ROLE_GROUPS.PAYROLL, 'PURCHASING_AGENT'], contexts: STAFF_KINDS },
  'hrHub.decide': { roles: [...ROLE_GROUPS.PAYROLL, 'PURCHASING_AGENT'], contexts: STAFF_KINDS },
  // employee portal (src/app/api/portal): the session employee's own records only (SelfContext)
  'portal.self.read': { roles: ROLE_GROUPS.ALL, contexts: ['self'] },
  'portal.self.request': { roles: ROLE_GROUPS.ALL, contexts: ['self'] },
  // recruitment applications (src/app/api/applications): through the vacancy's JobRequest.companyId
  'recruitment.application.read': { roles: ROLE_GROUPS.HR, contexts: STAFF_KINDS },
  'recruitment.application.manage': { roles: ROLE_GROUPS.HR, contexts: STAFF_KINDS },
  // workforce decision engine (src/app/api/workforce): aggregation inside the allowed companies (§5.4.3).
  // Tenant-wide rows (assumption defaults, plans of every company, the legal registers) are written by
  // an unrestricted actor only (the route checks it); the finer role rules stay in the routes.
  'workforce.read': { roles: ROLE_GROUPS.WORKFORCE, contexts: STAFF_KINDS },
  'workforce.plan.manage': { roles: ROLE_GROUPS.WORKFORCE, contexts: STAFF_KINDS },
  'workforce.assumptions.manage': { roles: ['SUPER_ADMIN', 'COMPANY_ADMIN', 'FINANCE_MANAGER'], contexts: STAFF_KINDS },
  'workforce.register.manage': { roles: ['SUPER_ADMIN'], contexts: STAFF_KINDS },
  // org
  'company.create': { roles: ROLE_GROUPS.OWNER, contexts: ['crossCompany'] },
  // P1-SCOPE part A: org structure, people, manager portals, dashboards and owner views. The routes
  // keep their own role gates (requireUser); these entries add the context kind and the company.
  'org.read': { roles: ROLE_GROUPS.STAFF, contexts: STAFF_KINDS },
  'org.manage': { roles: ROLE_GROUPS.HR, contexts: STAFF_KINDS },
  'employee.create': { roles: ROLE_GROUPS.HR, contexts: STAFF_KINDS },
  'employee.gosi.confirm': { roles: ROLE_GROUPS.PAYROLL, contexts: STAFF_KINDS },
  'employee.muqeem.operate': { roles: ROLE_GROUPS.GOV, contexts: STAFF_KINDS },
  'employee.transfer.request': { roles: ROLE_GROUPS.MANAGERS, contexts: ['scoped', 'team'] },
  'employee.transfer.decide': { roles: ROLE_GROUPS.HR, contexts: STAFF_KINDS },
  'evaluation.read': { roles: ROLE_GROUPS.ALL, contexts: ['scoped', 'self'] },
  'evaluation.manage': { roles: ROLE_GROUPS.HR, contexts: STAFF_KINDS },
  'evaluation.score': { roles: ROLE_GROUPS.MANAGERS, contexts: ['scoped'] },
  'evaluation.acknowledge': { roles: ROLE_GROUPS.ALL, contexts: ['self'] },
  'managerPortal.read': { roles: [...ROLE_GROUPS.MANAGERS, ...ROLE_GROUPS.LOGISTICS], contexts: ['scoped', 'team'] },
  'managerPortal.request.create': { roles: ROLE_GROUPS.ALL, contexts: ['scoped', 'team', 'self'] },
  'deptManager.read': { roles: ROLE_GROUPS.MANAGERS, contexts: ['scoped', 'team'] },
  'deptManager.request.decide': { roles: ROLE_GROUPS.MANAGERS, contexts: ['scoped', 'team'], notOwnRecord: true },
  'dashboard.read': { roles: ROLE_GROUPS.STAFF, contexts: ['scoped', 'team'] },
  'alerts.read': { roles: ROLE_GROUPS.STAFF, contexts: STAFF_KINDS },
  'search.run': { roles: ROLE_GROUPS.STAFF, contexts: ['scoped', 'team'] },
  'notification.read': { roles: ROLE_GROUPS.ALL, contexts: ['scoped'] },
  'owner.report.read': { roles: ROLE_GROUPS.OWNER, contexts: STAFF_KINDS },
  'faceProfile.photo.read': { roles: ROLE_GROUPS.HR, contexts: STAFF_KINDS },
  // calendar (P1-CAL): work patterns, holidays, Ramadan period (src/app/api/calendar, work-schedules)
  'calendar.read': { roles: ROLE_GROUPS.STAFF, contexts: STAFF_KINDS },
  'calendar.manage': { roles: ROLE_GROUPS.HR, contexts: STAFF_KINDS },
  // platform: data integrity (P1-FND-INV, owner dashboard /settings/integrity). The second-person and
  // beneficiary rules of an explanation or waiver are enforced by the platform transitions themselves.
  'platform.discrepancy.read': { roles: ROLE_GROUPS.PAYROLL, contexts: STAFF_KINDS },
  'platform.discrepancy.decide': { roles: ROLE_GROUPS.PAYROLL, contexts: STAFF_KINDS },
  'platform.reconcile.run': { roles: ROLE_GROUPS.PAYROLL, contexts: STAFF_KINDS },
  // P1-SCOPE part C: gov, legal, logistics, assets, compliance, integrations, settings, files. Same
  // role groups as the routes' requireUser; the company comes from the record (§5.4.3).
  'gov.visa.read': { roles: [...ROLE_GROUPS.GOV, ...ROLE_GROUPS.HR], contexts: STAFF_KINDS },
  'gov.visa.manage': { roles: [...ROLE_GROUPS.GOV, ...ROLE_GROUPS.HR], contexts: STAFF_KINDS },
  'gov.muqeem.operate': { roles: ROLE_GROUPS.GOV, contexts: STAFF_KINDS },
  'gov.renewal.read': { roles: ROLE_GROUPS.GOV, contexts: STAFF_KINDS },
  'gov.renewal.decide': { roles: ROLE_GROUPS.GOV, contexts: STAFF_KINDS },
  'gov.platform.manage': { roles: ['SUPER_ADMIN', 'COMPANY_ADMIN', 'GOV_RELATIONS'], contexts: STAFF_KINDS },
  'legal.read': { roles: ROLE_GROUPS.LEGAL, contexts: STAFF_KINDS },
  'legal.manage': { roles: ROLE_GROUPS.LEGAL, contexts: STAFF_KINDS },
  // investigations link to deductions (penalties): legal and HR together
  'legal.investigation.read': { roles: [...ROLE_GROUPS.LEGAL, ...ROLE_GROUPS.HR], contexts: STAFF_KINDS },
  'legal.investigation.manage': { roles: [...ROLE_GROUPS.LEGAL, ...ROLE_GROUPS.HR], contexts: STAFF_KINDS },
  'logistics.read': { roles: ROLE_GROUPS.STAFF, contexts: STAFF_KINDS },
  'logistics.manage': { roles: ROLE_GROUPS.LOGISTICS, contexts: STAFF_KINDS },
  'assets.read': { roles: ROLE_GROUPS.ALL, contexts: ['scoped', 'self', 'crossCompany'] },
  'assets.manage': { roles: ROLE_GROUPS.LOGISTICS, contexts: STAFF_KINDS },
  'compliance.read': { roles: ROLE_GROUPS.STAFF, contexts: STAFF_KINDS },
  'compliance.manage': { roles: [...ROLE_GROUPS.ADMIN, ...ROLE_GROUPS.HR, ...ROLE_GROUPS.GOV], contexts: STAFF_KINDS },
  // Tenant-wide settings, users, permissions and audit log: an admin who sees every company.
  'platform.settings.manage': { roles: ROLE_GROUPS.ADMIN, contexts: ['scoped'] },
  'files.upload': { roles: ROLE_GROUPS.ALL, contexts: ['scoped', 'self'] },
});

export interface AuthzDecision {
  allowed: boolean;
  reason: string;
}

const deny = (reason: string): AuthzDecision => ({ allowed: false, reason });

function check(ctx: ScopeContext, action: string, resource: AuthzResource = {}): AuthzDecision {
  if (!isScopeContext(ctx)) return deny('no scope context');
  const policy = Object.prototype.hasOwnProperty.call(POLICIES, action) ? POLICIES[action] : undefined;
  if (!policy) return deny(`unknown action ${action}`);
  if (!policy.contexts.includes(ctx.kind)) return deny(`${action} is not allowed in a ${ctx.kind} context`);
  if (ctx.kind === 'system') return deny('system contexts are not authorized through user policies');
  if (!roleIn(ctx.actor.role, policy.roles)) return deny(`role ${ctx.actor.role} may not ${action}`);
  if (ctx.kind === 'crossCompany' && ctx.readOnly && !action.endsWith('.read')) return deny('read-only cross-company context');

  if ('companyId' in resource && ctx.companies !== ALL_COMPANIES) {
    if (!resource.companyId || !ctx.companies.includes(resource.companyId)) return deny('company outside the context');
  }
  if (policy.notOwnRecord && resource.employeeId && resource.employeeId === ctx.actor.employeeId && !ctx.actor.isOwner) {
    return deny('a decision on one\'s own record');
  }
  if (ctx.kind === 'self') {
    if (resource.employeeId !== undefined && resource.employeeId !== ctx.employeeId) return deny('not the own record');
  }
  if (ctx.kind === 'team' && resource.employeeId !== undefined) {
    const member = isTeamMember(ctx, {
      id: resource.employeeId,
      legalCompanyId: resource.companyId,
      directManagerId: resource.directManagerId,
      branchId: resource.branchId,
      departmentId: resource.departmentId,
    });
    if (!member) return deny('employee outside the team');
  }
  return { allowed: true, reason: 'policy' };
}

export const authz = Object.freeze({
  /** Deny-by-default decision. */
  can(ctx: ScopeContext, action: string, resource?: AuthzResource): boolean {
    return check(ctx, action, resource).allowed;
  },
  /** The decision with its reason (for logs and tests). */
  check,
  /** Throws 403 (HttpError) when not allowed. */
  assert(ctx: ScopeContext, action: string, resource?: AuthzResource, message?: string): void {
    const d = check(ctx, action, resource);
    if (!d.allowed) throw forbidden(message);
  },
});
