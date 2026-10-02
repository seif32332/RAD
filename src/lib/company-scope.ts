// Company scope of a back-office user (DOMAIN_BOUNDARIES §5.4, layer "Company Scope").
//
// Same rule as the document engine (docs/document-engine SPEC §10, staffCompanyScope): the companies in
// the user's UserCompanyScope rows; null = every company (owner roles always; a user without scope
// rows until P1-SCOPE makes the scope mandatory). Kept in iam-neutral src/lib so recruitment and
// onboarding do not import the documents module.
import type { Prisma, PrismaClient } from '@prisma/client';
import { ALL_COMPANIES, actorCompanies } from '@/modules/iam';
import { forbidden } from '@/lib/http';

type Db = PrismaClient | Prisma.TransactionClient;

/** null = every company. */
export type CompanyScope = string[] | null;

/** The rule itself lives in iam (actorCompanies, P1-FND-SCOPE); this is its legacy shape (null = every company). */
export async function userCompanyScope(db: Db, user: { id: string; role: string }): Promise<CompanyScope> {
  const companies = await actorCompanies(db, user);
  return companies === ALL_COMPANIES ? null : [...companies];
}

/**
 * True when every company is inside the scope. A record without a company (null) is inside only an
 * unrestricted scope: a scoped user never acts on a record whose company is unknown (fail closed).
 */
export function companiesInScope(scope: CompanyScope, companyIds: readonly (string | null | undefined)[]): boolean {
  if (scope === null) return true;
  return companyIds.every((id) => !!id && scope.includes(id));
}

/** Prisma filter on a `companyId` column for the scope (undefined = no filter). */
export function companyScopeWhere(scope: CompanyScope): { companyId: { in: string[] } } | undefined {
  return scope === null ? undefined : { companyId: { in: scope } };
}

export async function assertCompaniesInScope(
  db: Db,
  user: { id: string; role: string },
  companyIds: readonly (string | null | undefined)[],
  message = 'هذه الشركة خارج نطاق صلاحياتك',
): Promise<void> {
  if (!companiesInScope(await userCompanyScope(db, user), companyIds)) throw forbidden(message);
}
