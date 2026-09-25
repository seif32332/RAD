import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError } from '@/lib/http';
import { buildLegalAlerts, getAlertThresholds, loadLegalAlertSources } from '@/lib/alerts';

export const dynamic = 'force-dynamic';

/**
 * Legal alerts: promissory notes due soon / overdue, active contracts and certified agencies
 * ending soon (or ended), and lawsuits referred to a law firm. Date windows are applied in
 * the query; classification is shared with the other alert screens and the dashboard via
 * src/lib/alerts.
 */
export async function GET() {
  try {
    await requireUser(ROLE_GROUPS.LEGAL);
    const now = new Date();
    const t = await getAlertThresholds(prisma);
    const sources = await loadLegalAlertSources(prisma, t, now);
    const alerts = buildLegalAlerts(sources, t, now);
    return NextResponse.json({ alerts });
  } catch (err) {
    return handleApiError(err, 'legal/alerts:GET');
  }
}
