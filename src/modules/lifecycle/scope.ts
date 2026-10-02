// The company-scope contract of lifecycle (DOMAIN_BOUNDARIES §5.4.3, "people / lifecycle /
// compensation"): the key is the employee's legal company (the projection of the AssignmentPeriod in
// force; EmploymentStateChange.companyId records it at each change).
//
//   * Every transition takes the caller's companies explicitly (no default): people.lockEmployees
//     locks the employee only inside them, so an employee of another company is refused (403) before
//     anything is read or written.
//   * Staff (ScopedContext): the actor's companies. Owner roles and CrossCompanyContext: ALL.
//   * Jobs (SystemContext): one company at a time (employment-notice-end, employment-state-opening);
//     the one-time opening of migration 9y is the named cross-company data migration.
//   * A move between two companies needs both in scope (org.applyAssignment); lifecycle never changes
//     the company.
import { ALL_COMPANIES, type ScopeContext } from '@/modules/iam';

/** The companies a lifecycle call may touch, from an iam context (built by constructors only). */
export function lifecycleCompanies(ctx: ScopeContext): readonly string[] | 'ALL' {
  return ctx.companies === ALL_COMPANIES ? 'ALL' : ctx.companies;
}
