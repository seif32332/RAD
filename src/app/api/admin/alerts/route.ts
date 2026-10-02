import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError } from '@/lib/http';
import { buildAdminAlerts, getAlertThresholds, loadAdminAlertSources, type AlertsDb } from '@/lib/alerts';
import { authz, resolveActor, scopedContext, scopedPrisma } from '@/modules/iam';

export const dynamic = 'force-dynamic';

const ADMIN_ALERT_ROLES = [...new Set([...ROLE_GROUPS.ADMIN, ...ROLE_GROUPS.GOV])];

/**
 * Company / branch / legal-contract expiry alerts (thresholds from SystemSetting alert_*).
 * P1-SCOPE: companies, branches and legal contracts of the user's companies only (scoped client).
 */
export async function GET() {
  try {
    const user = await requireUser(ADMIN_ALERT_ROLES);
    const ctx = scopedContext(await resolveActor(prisma, user));
    authz.assert(ctx, 'alerts.read');
    const now = new Date();
    const thresholds = await getAlertThresholds(prisma);
    const sources = await loadAdminAlertSources(scopedPrisma(ctx) as unknown as AlertsDb, thresholds, now); // the extended client runs the same calls
    const alerts = buildAdminAlerts(sources, thresholds, now);
    return NextResponse.json({ alerts });
  } catch (err) {
    return handleApiError(err, 'admin/alerts:GET');
  }
}
