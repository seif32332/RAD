// Loader of «المؤشرات الداخلية» (server-only): reads the organisation's own records for the period and
// the scope, and builds the PURE input of src/lib/workforce/benchmarks.ts. Only aggregate-friendly columns
// are selected (no names, no identity data). The attendance days are aggregated in SQL (per employee and
// calendar month) so 24 months of attendance never reach the application as rows.
import 'server-only';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { loadAssumptionRows } from '@/lib/workforce/load';
import { resolveAssumption } from '@/lib/workforce/assumptions';
import { benchmarkPeriod, type BenchmarksInput, type BmPopulationEmployee } from '@/lib/workforce/benchmarks';

export interface BenchmarkScope {
  /** Legal company (Employee.legalCompanyId), like every workforce screen. */
  companyId?: string | null;
  branchId?: string | null;
  departmentId?: string | null;
  /** The caller's companies (P1-SCOPE): employees of these legal companies only; null / undefined = every company. */
  companyIds?: ReadonlyArray<string> | null;
}

const DAY_MS = 86400000;
/** Longest new-hire window (6 months): leavers of the months before the period can still be in a cohort. */
const COHORT_LOOKBACK_MONTHS = 6;

/**
 * Every employee of the organisation present in the period, with the organisation-unit fields only (no name,
 * no identity data): the input of scopeDisclosure(), which compares a filtered scope with the wider scopes
 * containing it.
 */
export async function loadBenchmarkPopulation(opts: { asOf: Date; months: number; companyIds?: ReadonlyArray<string> | null }): Promise<BmPopulationEmployee[]> {
  const p = benchmarkPeriod(opts.asOf, opts.months);
  return prisma.employee.findMany({
    where: {
      joinDate: { lte: p.toDate },
      OR: [{ isTerminated: false }, { isTerminated: true, terminationDate: { gte: p.fromDate } }],
      ...(opts.companyIds ? { legalCompanyId: { in: [...opts.companyIds] } } : {}),
    },
    select: { id: true, joinDate: true, isTerminated: true, terminationDate: true, departmentId: true, branchId: true, legalCompanyId: true },
    orderBy: { id: 'asc' },
  });
}

export async function loadBenchmarksInput(opts: { asOf: Date; months: number; scope: BenchmarkScope }): Promise<{ input: BenchmarksInput; notes: string[] }> {
  const p = benchmarkPeriod(opts.asOf, opts.months);
  const from = p.fromDate;
  const toExclusive = new Date(p.toDate.getTime() + DAY_MS);
  const lookback = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - COHORT_LOOKBACK_MONTHS, 1));
  const s = opts.scope;
  // A restricted caller always reads a filtered population (his companies): every query below is narrowed to it.
  const scoped = !!(s.companyId || s.branchId || s.departmentId || s.companyIds);
  const notes: string[] = [];

  const rows = await prisma.employee.findMany({
    where: {
      joinDate: { lte: p.toDate },
      OR: [{ isTerminated: false }, { isTerminated: true, terminationDate: null }, { isTerminated: true, terminationDate: { gte: lookback } }],
      ...(s.companyId ? { legalCompanyId: s.companyId } : {}),
      ...(s.companyIds ? { AND: [{ legalCompanyId: { in: [...s.companyIds] } }] } : {}),
      ...(s.branchId ? { branchId: s.branchId } : {}),
      ...(s.departmentId ? { departmentId: s.departmentId } : {}),
    },
    select: {
      id: true,
      joinDate: true,
      isTerminated: true,
      terminationDate: true,
      exitVoluntary: true,
      exitReason: true,
      nationality: true,
      departmentId: true,
      branchId: true,
      legalCompanyId: true,
      basicSalary: true,
      department: { select: { nameArabic: true } },
      allowances: { where: { isMonthly: true }, select: { amount: true } },
    },
    orderBy: { id: 'asc' },
  });
  const ids = rows.map((r) => r.id);
  const idFilter = scoped ? { in: ids } : undefined;

  const jobWhere: Prisma.JobRequestWhereInput = {
    status: 'FULFILLED',
    updatedAt: { gte: from },
    ...(s.departmentId ? { departmentId: s.departmentId } : {}),
    ...(s.branchId ? { department: { branchId: s.branchId } } : {}),
    ...(s.companyId ? { department: { branch: { companyId: s.companyId }, ...(s.branchId ? { branchId: s.branchId } : {}) } } : {}),
    ...(s.companyIds ? { companyId: { in: [...s.companyIds] } } : {}),
  };
  if (s.companyId) notes.push('مدة التوظيف: تُنسب طلبات الوظائف إلى الشركة حسب فرع الإدارة الطالبة (لا حسب الكيان النظامي للموظف)');

  const [payrolls, overtime, attendance, leaves, settlements, jobs, fees, assumptions] = await Promise.all([
    prisma.payroll.findMany({
      where: { employeeId: idFilter, status: { in: ['APPROVED', 'PAID'] }, year: { gte: from.getUTCFullYear(), lte: p.toDate.getUTCFullYear() } },
      select: { employeeId: true, year: true, month: true, basicSalary: true, totalAllowances: true, overtimeCost: true, bonusAmount: true, gosiEmployer: true },
    }),
    prisma.overtimeRequest.findMany({
      where: { employeeId: idFilter, status: 'APPROVED', date: { gte: from, lt: toExclusive } },
      select: { employeeId: true, date: true, hours: true, amount: true, type: true },
    }),
    ids.length
      ? prisma.$queryRaw<Array<{ employeeId: string; month: string; present: number; absent: number }>>`
          SELECT "employeeId", to_char("date", 'YYYY-MM') AS "month",
                 (COUNT(*) FILTER (WHERE "status" = 'PRESENT'))::int AS "present",
                 (COUNT(*) FILTER (WHERE "status" = 'ABSENT'))::int AS "absent"
          FROM "Attendance"
          WHERE "date" >= ${from} AND "date" < ${toExclusive}
            ${scoped ? Prisma.sql`AND "employeeId" = ANY(${ids}::text[])` : Prisma.empty}
          GROUP BY 1, 2`
      : Promise.resolve([]),
    prisma.leave.findMany({
      where: { employeeId: idFilter, leaveType: 'SICK', status: { in: ['APPROVED', 'COMPLETED'] }, startDate: { lt: toExclusive }, endDate: { gte: from } },
      select: { employeeId: true, leaveType: true, startDate: true, endDate: true, totalDays: true },
    }),
    prisma.settlement.findMany({
      where: {
        employeeId: idFilter,
        type: 'END_OF_SERVICE',
        status: { in: ['PAID', 'OWNER_APPROVED'] },
        OR: [{ lastWorkingDate: { gte: from, lt: toExclusive } }, { lastWorkingDate: null, createdAt: { gte: from, lt: toExclusive } }],
      },
      select: { employeeId: true, type: true, status: true, endOfServiceAmount: true, leaveCompensation: true, terminationReason: true, lastWorkingDate: true, createdAt: true, salaryBasis: true },
    }),
    prisma.jobRequest.findMany({
      where: jobWhere,
      select: { id: true, createdAt: true, updatedAt: true, departmentId: true, applications: { where: { status: 'HIRED' }, select: { updatedAt: true }, orderBy: { updatedAt: 'asc' }, take: 1 } },
    }),
    prisma.paymentRequest.findMany({
      where: { entityType: 'EMPLOYEE', entityId: idFilter, status: { in: ['PAID', 'COMPLETED'] }, updatedAt: { gte: from, lt: toExclusive }, documentType: { not: null } },
      select: { entityId: true, documentType: true, amount: true, updatedAt: true },
    }),
    loadAssumptionRows(undefined, s.companyIds),
  ]);

  const recruitmentCompany = s.companyId ?? null;
  const rc = (k: 'RECRUITMENT_COST_SAUDI' | 'RECRUITMENT_COST_EXPAT') => {
    const v = resolveAssumption(assumptions, k, recruitmentCompany, 'base').value;
    return typeof v === 'number' ? v : null;
  };

  return {
    notes,
    input: {
      employees: rows.map((r) => ({
        id: r.id,
        joinDate: r.joinDate,
        isTerminated: r.isTerminated,
        terminationDate: r.terminationDate,
        exitVoluntary: r.exitVoluntary,
        exitReason: r.exitReason,
        nationality: r.nationality,
        departmentId: r.departmentId,
        departmentName: r.department?.nameArabic ?? null,
        branchId: r.branchId,
        legalCompanyId: r.legalCompanyId,
        basicSalary: r.basicSalary,
        monthlyAllowances: r.allowances.reduce((a, x) => a + (x.amount ?? 0), 0),
      })),
      payrolls,
      overtimeRequests: overtime,
      attendance: attendance.map((a) => ({ employeeId: a.employeeId, month: a.month, present: Number(a.present), absent: Number(a.absent) })),
      leaves: leaves.map((l) => ({ ...l, leaveType: String(l.leaveType) })),
      settlements: settlements.map((x) => ({ ...x, terminationReason: x.terminationReason ? String(x.terminationReason) : null, type: String(x.type) })),
      jobRequests: jobs.map((j) => ({ id: j.id, createdAt: j.createdAt, fulfilledAt: j.updatedAt, hiredAt: j.applications[0]?.updatedAt ?? null, departmentId: j.departmentId })),
      govFees: fees.filter((f) => f.entityId && f.documentType).map((f) => ({ employeeId: f.entityId as string, documentType: f.documentType as string, amount: f.amount, paidAt: f.updatedAt })),
      recruitmentCost: { saudi: rc('RECRUITMENT_COST_SAUDI'), expat: rc('RECRUITMENT_COST_EXPAT') },
    },
  };
}
