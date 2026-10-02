// Company-scope contract of the calendar module (DOMAIN_BOUNDARIES §5.4). Every calendar row carries
// its company (WorkSchedule.companyId = the branch's company, HolidayCalendar.companyId,
// RamadanPeriod.companyId). Reads and writes take the caller's companies explicitly, with no default:
// a list (ScopedContext.companies), or 'ALL' / null for an explicit cross-company or system context.

export type CalendarCompanies = readonly string[] | 'ALL' | null;

export class CalendarScopeError extends Error {
  constructor(companyId: string) {
    super(`company ${companyId} is outside the caller's company scope`);
    this.name = 'CalendarScopeError';
  }
}

export function requireCompanies(opts: { companyIds?: CalendarCompanies } | undefined, what: string): CalendarCompanies {
  if (!opts || !('companyIds' in opts) || opts.companyIds === undefined) {
    throw new Error(`${what}: companyIds is required (null only for an explicit cross-company context)`);
  }
  return opts.companyIds;
}

export function inScope(companyIds: CalendarCompanies, companyId: string): boolean {
  return companyIds === null || companyIds === 'ALL' || companyIds.includes(companyId);
}

export function assertCompanyInScope(companyIds: CalendarCompanies, companyId: string): void {
  if (!inScope(companyIds, companyId)) throw new CalendarScopeError(companyId);
}

/** Prisma `where` fragment of the scope (undefined = no restriction). */
export function companyWhere(companyIds: CalendarCompanies): { companyId?: { in: string[] } } {
  return companyIds === null || companyIds === 'ALL' ? {} : { companyId: { in: [...companyIds] } };
}
