import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError } from '@/lib/http';
import {
  buildClaimAlerts,
  buildVehicleAlerts,
  getAlertThresholds,
  loadClaimAlertSources,
  loadVehicleAlertSources,
} from '@/lib/alerts';

export const dynamic = 'force-dynamic';

/** Vehicle document expiry alerts + open accident claims. */
export async function GET() {
  try {
    await requireUser(ROLE_GROUPS.LOGISTICS);
    const now = new Date();
    const thresholds = await getAlertThresholds(prisma);
    const [vehicles, claims] = await Promise.all([
      loadVehicleAlertSources(prisma, thresholds, now),
      loadClaimAlertSources(prisma),
    ]);
    const alerts = [...buildVehicleAlerts(vehicles, thresholds, now), ...buildClaimAlerts(claims, now)];
    alerts.sort((a, b) => a.daysLeft - b.daysLeft);
    return NextResponse.json({ alerts });
  } catch (err) {
    return handleApiError(err, 'logistics/alerts:GET');
  }
}
