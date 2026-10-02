import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError } from '@/lib/http';
import { buildLegalAlerts, getAlertThresholds, loadLegalAlertSources, type AlertsDb } from '@/lib/alerts';
import { authz, resolveActor, scopedContext, scopedPrisma } from '@/modules/iam';

export const dynamic = 'force-dynamic';

/**
 * Legal alerts: promissory notes due soon / overdue, active contracts and certified agencies
 * ending soon (or ended), and lawsuits referred to a law firm. Date windows are applied in
 * the query; classification is shared with the other alert screens and the dashboard via
 * src/lib/alerts. P1-SCOPE: the sources are read through the scoped client (the legal tables'
 * companyId), so a scoped user gets the alerts of his companies only.
 */
export async function GET() {
  try {
    const user = await requireUser(ROLE_GROUPS.LEGAL);
    const ctx = scopedContext(await resolveActor(prisma, user));
    authz.assert(ctx, 'legal.read');
    const now = new Date();
    const t = await getAlertThresholds(prisma);
    const sources = await loadLegalAlertSources(scopedPrisma(ctx) as unknown as AlertsDb, t, now);
    const alerts = buildLegalAlerts(sources, t, now);
    return NextResponse.json({ alerts });
  } catch (err) {
    return handleApiError(err, 'legal/alerts:GET');
  }
}
