// GET /api/workforce/plans/[id]/actual?asOf=YYYY-MM-DD&live=1 — plan vs actual (planVsActual, SPEC §8) for the
// plan months up to asOf (default today) that have APPROVED / PAID payroll rows of the plan scope (legal
// company, or all). An APPROVED plan is compared with the projection frozen at approval (live=1 recomputes);
// any other plan with its live projection (its baseline follows the current data: flagged).
// Read only: payroll rows are read, never written.
import { NextResponse } from 'next/server';
import type { PayrollStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { PAYROLL_STATUS, ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, notFound, parseQuery } from '@/lib/http';
import { zId } from '@/lib/validation';
import { planVsActual } from '@/lib/workforce/planning';
import { auditViewOnce, limitOrThrow } from '../../../_lib/server';
import { actualQuerySchema } from '../../_lib/schemas';
import { loadPlanOr404, projectionFor, todayDate, toDefinition } from '../../_lib/server';
import { workforceScope } from '../../../_lib/scope';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(ROLE_GROUPS.WORKFORCE);
    const idp = zId.safeParse((await ctx.params).id);
    if (!idp.success) throw notFound('الخطة غير موجودة');
    const q = parseQuery(req, actualQuerySchema);
    limitOrThrow(user, 'plan-calc', 30, 60_000);
    // P1-SCOPE: a plan outside the caller's companies is "not found"; a visible plan of one company reads
    // that company's payrolls and employees only (a plan of every company: unrestricted callers only).
    const wf = await workforceScope(user);
    const row = await loadPlanOr404(idp.data, wf);
    const { projection, frozen } = await projectionFor(row, q.live);
    const asOf = q.asOf ? new Date(`${q.asOf}T00:00:00.000Z`) : todayDate();
    const asOfKey = asOf.toISOString().slice(0, 7);
    const byYear = new Map<number, number[]>();
    for (const k of projection.monthKeys) {
      if (k > asOfKey) continue;
      const [y, m] = k.split('-').map(Number);
      byYear.set(y, [...(byYear.get(y) ?? []), m]);
    }
    const scope = row.companyId ? { legalCompanyId: row.companyId } : wf.companyIds ? { legalCompanyId: { in: [...wf.companyIds] } } : {};
    const [rows, employees] = byYear.size
      ? await Promise.all([
          prisma.payroll.findMany({
            where: {
              status: { in: [PAYROLL_STATUS.APPROVED, PAYROLL_STATUS.PAID] as PayrollStatus[] },
              OR: [...byYear.entries()].map(([year, months]) => ({ year, month: { in: months } })),
              ...(row.companyId || wf.companyIds ? { employee: scope } : {}),
            },
            select: { employeeId: true, year: true, month: true, status: true, basicSalary: true, totalAllowances: true, overtimeCost: true, gosiEmployer: true, bonusAmount: true },
            orderBy: [{ year: 'asc' }, { month: 'asc' }, { employeeId: 'asc' }],
          }),
          prisma.employee.findMany({
            where: scope,
            select: { id: true, employeeId: true, firstNameArabic: true, lastNameArabic: true, joinDate: true, terminationDate: true, isTerminated: true, legalCompanyId: true, departmentId: true, nationality: true },
            orderBy: { id: 'asc' },
          }),
        ])
      : [[], []];
    const result = planVsActual(
      toDefinition(row),
      projection,
      rows.map((r) => ({ ...r, status: String(r.status) })),
      asOf,
      {
        employees: employees.map((e) => ({
          id: e.id,
          name: `${e.firstNameArabic ?? ''} ${e.lastNameArabic ?? ''}`.trim() || e.employeeId || e.id,
          employeeNo: e.employeeId,
          joinDate: e.joinDate,
          terminationDate: e.terminationDate,
          isTerminated: e.isTerminated,
          legalCompanyId: e.legalCompanyId,
          departmentId: e.departmentId,
          nationality: e.nationality,
        })),
      },
    );
    await auditViewOnce(user, 'WorkforcePlanActual', { planId: row.id, asOf: result.asOf }, getClientIp(req));
    return NextResponse.json({
      planId: row.id,
      status: row.status,
      frozen,
      warning: frozen
        ? null
        : q.live
          ? 'المخطط معاد حسابه بالبيانات الحالية لا باللقطة المعتمدة: قد يظهر فيه من عُيّن فعلاً بعد بداية الخطة'
          : row.status === 'APPROVED' || row.status === 'ARCHIVED'
            ? 'لم يُعثر على لقطة الاعتماد: المقارنة بالتوقع المعاد حسابه بالبيانات الحالية'
            : 'الخطة غير معتمدة: المخطط يُعاد حسابه من البيانات الحالية، فقد يظهر فيه من عُيّن فعلاً بعد بداية الخطة',
      result,
    });
  } catch (err) {
    return handleApiError(err, 'workforce:plans:actual:GET');
  }
}
