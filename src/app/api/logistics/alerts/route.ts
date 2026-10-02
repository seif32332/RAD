import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
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
  type AlertsDb,
} from '@/lib/alerts';
import { authz, resolveActor, scopeWhere, scopedContext, scopedPrisma } from '@/modules/iam';

export const dynamic = 'force-dynamic';

/**
 * Vehicle document expiry alerts + open accident claims. P1-SCOPE: the vehicles are read through the
 * scoped client (Vehicle.legalCompanyId); AccidentClaim has no company key, so its query is filtered
 * by the same rule on its vehicle.
 */
export async function GET() {
  try {
    const user = await requireUser(ROLE_GROUPS.LOGISTICS);
    const ctx = scopedContext(await resolveActor(prisma, user));
    authz.assert(ctx, 'logistics.read');
    const vehicleScope = scopeWhere(ctx, 'Vehicle') as Prisma.VehicleWhereInput | null;
    const now = new Date();
    const thresholds = await getAlertThresholds(prisma);
    const [vehicles, claims] = await Promise.all([
      loadVehicleAlertSources(scopedPrisma(ctx) as unknown as AlertsDb, thresholds, now),
      loadClaimAlertSources(prisma, vehicleScope ? { vehicle: { is: vehicleScope } } : {}),
    ]);
    const alerts = [...buildVehicleAlerts(vehicles, thresholds, now), ...buildClaimAlerts(claims, now)];
    alerts.sort((a, b) => a.daysLeft - b.daysLeft);
    return NextResponse.json({ alerts });
  } catch (err) {
    return handleApiError(err, 'logistics/alerts:GET');
  }
}
