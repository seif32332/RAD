// GET /api/workforce/total-rewards?employeeId&year — «بيان المكافآت الشاملة» of one employee for HR review
// and printing (SPEC §9). WORKFORCE roles: the same people who see individual salaries in the engine and in
// the employees API (HR: full, finance: payroll). Works whether or not the statement is enabled for
// employees in the portal (`enabledForEmployees` tells). Every view is audited (individual pay data).
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { logAudit } from '@/lib/audit';
import { badRequest, handleApiError, notFound, parseQuery } from '@/lib/http';
import { zId } from '@/lib/validation';
import { limitOrThrow } from '../_lib/server';
import { assertEmployeeVisible, workforceScope } from '../_lib/scope';
import { loadTotalRewards, totalRewardsEnabled, zStatementYear } from './_load';

export const dynamic = 'force-dynamic';

const querySchema = z.object({ employeeId: zId, year: zStatementYear }).strict();

export async function GET(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.WORKFORCE);
    const q = parseQuery(req, querySchema);
    limitOrThrow(user, 'total-rewards', 60, 60_000);
    // P1-SCOPE: an employee outside the caller's legal companies is "not found".
    await assertEmployeeVisible(await workforceScope(user), q.employeeId);
    const loaded = await loadTotalRewards(q.employeeId, q.year ?? null);
    if (!loaded) throw notFound('الموظف غير موجود');
    if (q.year !== undefined && (q.year < loaded.years.first || q.year > loaded.years.last)) {
      throw badRequest(`السنة خارج مدة خدمة الموظف (${loaded.years.first}–${loaded.years.last})`);
    }
    await logAudit({ userId: user.id, action: 'VIEW', entityType: 'WorkforceTotalRewards', entityId: q.employeeId, details: { year: loaded.statement.year }, ipAddress: getClientIp(req) });
    return NextResponse.json({ ...loaded, enabledForEmployees: await totalRewardsEnabled() });
  } catch (err) {
    return handleApiError(err, 'workforce:total-rewards:GET');
  }
}
