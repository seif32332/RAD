// GET /api/leaves/preview?employeeId=&leaveType=&startDate=&endDate=&acceptUnpaidExtraDays=&isOutsideKSA=&eventDate=&bereavementRelation=
// Read-only server calculation of a leave request (the same evaluateLeave() used by POST /api/leaves),
// so forms show exactly the numbers the server will store: days, balance, paid/unpaid split,
// sick-leave tiers, salary deduction and the exit/re-entry visa fee. Nothing is written.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireEmployeeId, requireUser } from '@/lib/auth';
import { ROLE_GROUPS, roleIn } from '@/lib/constants';
import { forbidden, handleApiError, parseQuery } from '@/lib/http';
import { zBool, zDate, zId, zOptDate } from '@/lib/validation';
import { BALANCE_LEAVE_TYPES, BEREAVEMENT_RELATIONS, EVENT_DATED_LEAVE_TYPES, LEAVE_TYPES, describeLeaveIssue, isSaudiNationality } from '@/lib/leave';
import { evaluateLeave, getExitReentryVisaFee } from '@/lib/hr-workflows';

export const dynamic = 'force-dynamic';

/** Same rule as POST /api/leaves: HR may preview any employee, everyone else only themselves. */
const PREVIEW_ANY = ROLE_GROUPS.HR;

const query = z.object({
  employeeId: zId.optional(),
  leaveType: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.enum(LEAVE_TYPES).default('ANNUAL')),
  startDate: zDate,
  endDate: zDate,
  acceptUnpaidExtraDays: zBool.optional(),
  isOutsideKSA: zBool.optional(),
  eventDate: zOptDate,
  bereavementRelation: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.enum(BEREAVEMENT_RELATIONS).optional()),
});

export async function GET(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.ALL);
    const q = parseQuery(req, query);
    let employeeId: string;
    if (roleIn(user.role, PREVIEW_ANY) && q.employeeId) {
      employeeId = q.employeeId;
    } else {
      employeeId = await requireEmployeeId(user);
      if (q.employeeId && q.employeeId !== employeeId) throw forbidden();
    }

    const evaluation = await evaluateLeave(prisma, {
      employeeId,
      leaveType: q.leaveType,
      startDate: q.startDate,
      endDate: q.endDate,
      acceptUnpaidExtraDays: q.acceptUnpaidExtraDays === true,
      eventDate: EVENT_DATED_LEAVE_TYPES.includes(q.leaveType) ? (q.eventDate ?? null) : null,
      bereavementRelation: q.leaveType === 'BEREAVEMENT' ? (q.bereavementRelation ?? 'FIRST_DEGREE') : null,
    });
    const needsVisa = q.isOutsideKSA === true && !isSaudiNationality(evaluation.employee.nationality);
    const { result } = evaluation;

    return NextResponse.json({
      employeeId,
      leaveType: q.leaveType,
      totalDays: evaluation.totalDays,
      balance: evaluation.balance,
      dailyRate: evaluation.dailyRate,
      paidDays: result.paidDays,
      unpaidDays: result.unpaidDays,
      totalDeduction: result.totalDeduction,
      sickTiers: result.sickTiers,
      issue: result.issue,
      issueMessage: result.issue
        ? describeLeaveIssue(result.issue, { leaveType: q.leaveType, rules: evaluation.statutory?.rules, bereavementRelation: evaluation.statutory?.bereavementRelation })
        : null,
      // Statutory leave types: paid-day entitlement, and whether the annual balance is used (never for these types).
      entitlementDays: result.entitlementDays ?? null,
      consumesAnnualBalance: BALANCE_LEAVE_TYPES.includes(q.leaveType),
      statutory: evaluation.statutory
        ? {
            rules: evaluation.statutory.rules,
            serviceYears: evaluation.statutory.serviceYears,
            priorHajjLeaves: evaluation.statutory.priorHajjLeaves,
            daysFromEvent: evaluation.statutory.daysFromEvent,
            provisional: true,
          }
        : null,
      needsVisa,
      exitReentryVisaCost: needsVisa ? await getExitReentryVisaFee(prisma) : 0,
    });
  } catch (err) {
    return handleApiError(err, 'leaves/preview:GET');
  }
}
