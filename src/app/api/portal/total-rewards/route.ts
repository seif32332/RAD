// GET /api/portal/total-rewards?year=YYYY — the logged-in employee's OWN «بيان المكافآت الشاملة» (SPEC §9).
// The employee is taken from the session ONLY: any other query parameter (employeeId…) is refused (400).
// Visible only when the owner enabled it (WorkforceAssumption TOTAL_REWARDS_ENABLED, global row): otherwise
// 200 { enabled: false } with no data, and the portal hides the card.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireEmployeeId, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { badRequest, handleApiError, notFound, parseQuery } from '@/lib/http';
import { limitOrThrow } from '@/app/api/workforce/_lib/server';
import { loadTotalRewards, totalRewardsEnabled, zStatementYear } from '@/app/api/workforce/total-rewards/_load';

export const dynamic = 'force-dynamic';

const querySchema = z
  .object({ year: zStatementYear })
  .strict({ message: 'يعرض البيان بياناتك أنت فقط: لا يمكن طلب بيان موظف آخر' });

export async function GET(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.ALL);
    const q = parseQuery(req, querySchema);
    const employeeId = await requireEmployeeId(user);
    limitOrThrow(user, 'portal-total-rewards', 30, 60_000);
    if (!(await totalRewardsEnabled())) {
      return NextResponse.json({ enabled: false, message: 'بيان المكافآت الشاملة غير مفعّل في منشأتك' });
    }
    const loaded = await loadTotalRewards(employeeId, q.year ?? null);
    if (!loaded) throw notFound('ملف الموظف غير موجود');
    if (q.year !== undefined && (q.year < loaded.years.first || q.year > loaded.years.last)) {
      throw badRequest(`اختر سنة من ${loaded.years.first} إلى ${loaded.years.last}`);
    }
    return NextResponse.json({ enabled: true, ...loaded });
  } catch (err) {
    return handleApiError(err, 'portal:total-rewards:GET');
  }
}
