import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError } from '@/lib/http';
import { buildAdminAlerts, getAlertThresholds, loadAdminAlertSources } from '@/lib/alerts';

export const dynamic = 'force-dynamic';

const ADMIN_ALERT_ROLES = [...new Set([...ROLE_GROUPS.ADMIN, ...ROLE_GROUPS.GOV])];

/** Company / branch / legal-contract expiry alerts (thresholds from SystemSetting alert_*). */
export async function GET() {
  try {
    await requireUser(ADMIN_ALERT_ROLES);
    const now = new Date();
    const thresholds = await getAlertThresholds(prisma);
    const sources = await loadAdminAlertSources(prisma, thresholds, now);
    const alerts = buildAdminAlerts(sources, thresholds, now);
    return NextResponse.json({ alerts });
  } catch (err) {
    return handleApiError(err, 'admin/alerts:GET');
  }
}
