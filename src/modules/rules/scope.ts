// Company-scope contract of the rules module (DOMAIN_BOUNDARIES §5.4.3):
//   read   RuleParameter is tenant-wide law (no company); CompanyRuleOverride is read for one company,
//          by rules.valueAt(key, companyId, d) inside the caller's scope.
//   write  an override is written for ONE company that must be in the caller's companies (the
//          CompanySet of an iam ScopeContext), or with an explicit cross-company context ('ALL' /
//          null, e.g. the owner). RuleParameter versions are not written here (legal registry,
//          /workforce/rules admin screen).

export class RuleScopeError extends Error {
  constructor(companyId: string) {
    super(`company ${companyId} is outside the caller's company scope`);
    this.name = 'RuleScopeError';
  }
}

/** The caller's companies, or 'ALL' / null for an explicit cross-company context. */
export type RuleCompanyScope = readonly string[] | 'ALL' | null;

export function assertCompanyInScope(companyIds: RuleCompanyScope | undefined, companyId: string): void {
  if (companyIds === undefined) throw new RuleScopeError(`${companyId} (no scope given)`);
  if (companyIds === null || companyIds === 'ALL') return;
  if (!companyIds.includes(companyId)) throw new RuleScopeError(companyId);
}
