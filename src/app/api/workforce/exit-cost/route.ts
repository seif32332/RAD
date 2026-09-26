// POST /api/workforce/exit-cost — «كلفة الإنهاء والإحلال» (read-only calculation, nothing is written).
// Body: { employeeId, exitReason (Employee.exitReason list), settlementReason? (required when the reason
// has no settlement mapping, e.g. MUTUAL_AGREEMENT / OTHER; overrides an uncertain mapping), lastWorkingDate,
// noticeServed, replacementIsSaudi?, scenario?, assumptionsOverride? {recruitmentCostSaudi,
// recruitmentCostExpat, vacancyMonths} (this calculation only) }.
// EOSB / leave / loans come from computeSettlement() with the settlement screen's inputs.
// result.settlementScreenTotal EXCLUDES the last month's working-day salary (that salary is payroll, not an
// exit cost), so it equals the /api/settlements preview only when an approved / paid payroll already covers
// the month of the last working day. result.lastMonth gives that salary (day rate × day of the month, as the
// settlement screen computes it) and settlementTotalIfUnpaid = the preview while that month is unpaid
// (paidByPayroll says which case applies). Server-computed unpaid overtime and HR's manual items are not
// included (the settlement screen adds them).
import { NextResponse } from 'next/server';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, parseBody } from '@/lib/http';
import { ESTIMATE_DISCLAIMER } from '@/lib/workforce/version';
import { exitCostSchema } from '../_lib/schemas';
import { auditViewOnce, limitOrThrow, runExitCost } from '../_lib/server';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.WORKFORCE);
    const body = await parseBody(req, exitCostSchema);
    limitOrThrow(user, 'exit', 60, 60_000);
    const out = await runExitCost(body);
    await auditViewOnce(user, 'WorkforceExitCost', { employeeId: body.employeeId, exitReason: body.exitReason, settlementReason: body.settlementReason ?? null }, getClientIp(req));
    return NextResponse.json({
      disclaimer: ESTIMATE_DISCLAIMER,
      employee: out.employee,
      reasonMapping: out.reasonMapping,
      warnings: out.warnings,
      assumptionEvidence: out.assumptionEvidence,
      ...out.result,
    });
  } catch (err) {
    return handleApiError(err, 'workforce:exit-cost:POST');
  }
}
