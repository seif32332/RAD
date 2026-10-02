// Owner dashboard of data integrity (P1-FND-INV; ARCHITECTURE_INVARIANTS §4.3 rule 6).
//   GET   open discrepancies by severity and company, waivers of the month, last run per invariant.
//   POST  { action: 'reconcile' }: runs the invariants now for the caller's companies (one READ ONLY
//         snapshot, then company by company through iam.forEachCompany; the tenant-level findings only
//         for a caller who sees every company).
// Scope: the caller's companies (UserCompanyScope). Discrepancy is a platform table that the scoped
// client does not filter, so the platform read takes the companies explicitly.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, parseBody, parseQuery } from '@/lib/http';
import { ALL_COMPANIES, authz, forEachCompany, resolveActor, scopedContext, scopedPrisma } from '@/modules/iam';
import { integrityDashboard, recordInvariantResults, registerInvariantCheck, takeInvariantSnapshot } from '@/modules/platform';
import { INV_RULE_02_ID, belowLegalOverrideCheck } from '@/modules/rules';
import { INV_PAY_04_ID, employmentChangeCheck } from '@/modules/payroll';

// INV-RULE-02's check belongs to rules (DEC-PO-126); a manual run and the dashboard see it too.
registerInvariantCheck(INV_RULE_02_ID, belowLegalOverrideCheck);
// INV-PAY-04's employment-change check belongs to payroll (BL-PAY-025): same composition root.
registerInvariantCheck(INV_PAY_04_ID, employmentChangeCheck);

export const dynamic = 'force-dynamic';

const QuerySchema = z.object({ closed: z.enum(['0', '1']).optional() });
const RunSchema = z.object({ action: z.literal('reconcile') });

export async function GET(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.PAYROLL);
    const ctx = scopedContext(await resolveActor(prisma, user));
    authz.assert(ctx, 'platform.discrepancy.read');
    const { closed } = parseQuery(req, QuerySchema);
    const companies = ctx.companies === ALL_COMPANIES ? 'ALL' : ctx.companies;
    const [dashboard, companyRows] = await Promise.all([
      integrityDashboard(prisma, { companies, includeClosed: closed === '1' }),
      scopedPrisma(ctx).company.findMany({ select: { id: true, nameArabic: true }, orderBy: { nameArabic: 'asc' } }),
    ]);
    return NextResponse.json({ ...dashboard, companies: companyRows, seesTenantLevel: companies === 'ALL' });
  } catch (err) {
    return handleApiError(err, 'integrity:GET');
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.PAYROLL);
    const ctx = scopedContext(await resolveActor(prisma, user));
    authz.assert(ctx, 'platform.reconcile.run');
    await parseBody(req, RunSchema);
    const companyIds = (await scopedPrisma(ctx).company.findMany({ select: { id: true }, orderBy: { id: 'asc' } })).map((c) => c.id);
    const snapshot = await takeInvariantSnapshot(prisma, { trigger: 'MANUAL' });
    const perCompany = await forEachCompany(companyIds, 'reconcile', (sys) =>
      recordInvariantResults(prisma, snapshot, { companyId: (sys.companies as readonly string[])[0] }),
    );
    const summaries = [...perCompany.values()];
    if (ctx.companies === ALL_COMPANIES) summaries.push(await recordInvariantResults(prisma, snapshot, { companyId: null }));
    return NextResponse.json({ runId: snapshot.runId, snapshotAt: snapshot.snapshotAt, summaries });
  } catch (err) {
    return handleApiError(err, 'integrity:POST');
  }
}
