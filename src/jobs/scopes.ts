// The company scope of the job runner (DOMAIN_BOUNDARIES §5.4.2 SystemContext): iam builds the
// contexts, org lists the companies. platform's runner receives them here because platform sits below
// iam and org (§5.3).
import { forEachCompany, systemContext, type SystemContext } from '@/modules/iam';
import { listCompanyIds } from '@/modules/org';
import type { JobScopes } from '@/modules/platform';

export const systemJobScopes: JobScopes<SystemContext> = {
  companyIds: (db) => listCompanyIds(db),
  forEachCompany: (companyIds, job, fn) =>
    forEachCompany(companyIds, job, (ctx) => fn(ctx, (ctx.companies as readonly string[])[0])),
  crossCompany: (job) => systemContext(job),
};
