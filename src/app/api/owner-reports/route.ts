import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth';
import { LEAVE_STATUS, PAYROLL_STATUS, ROLE_GROUPS } from '@/lib/constants';
import { badRequest, handleApiError, parseQuery } from '@/lib/http';
import { dateKey, today } from '@/lib/dates';
import { sumMoney } from '@/lib/money';
import { zOptDate } from '@/lib/validation';
import {
  currentPayrollMonth,
  monthIndex,
  monthsInRange,
  payrollMonthLabel,
  reportMonthKind,
  type ReportMonthKind,
} from '@/lib/payroll-core';

export const dynamic = 'force-dynamic';

const CONTRACT_STATUS_LABELS: Record<string, string> = { ACTIVE: 'ساري', EXPIRED: 'منتهي', TERMINATED: 'مفسوخ' };
const LAWSUIT_STATUS_LABELS: Record<string, string> = { REFERRED: 'محالة لمكتب المحاماة', CLOSED: 'مغلقة' };
const CASE_TYPE_LABELS: Record<string, string> = { LABOR: 'عمالية', COMMERCIAL: 'تجارية', REAL_ESTATE: 'عقارية', OTHER: 'أخرى' };
const FINALIZED = [PAYROLL_STATUS.APPROVED, PAYROLL_STATUS.PAID];

/** Migration that added Payroll.gosiEmployer: lines generated before it store 0 (DOM-009 red team). */
const GOSI_BREAKDOWN_MIGRATION = '5_gosi_regime_payroll_breakdown_maker_checker';

const QuerySchema = z.object({ from: zOptDate, to: zOptDate });

/** When the employer-GOSI column was added; null when unknown (schema applied without migrations). */
async function gosiBreakdownSince(): Promise<Date | null> {
  try {
    const rows = await prisma.$queryRaw<Array<{ finished_at: Date | null }>>`
      SELECT finished_at FROM "_prisma_migrations"
      WHERE migration_name = ${GOSI_BREAKDOWN_MIGRATION} AND finished_at IS NOT NULL AND rolled_back_at IS NULL
      LIMIT 1`;
    return rows[0]?.finished_at ?? null;
  } catch {
    return null;
  }
}

interface ActualMonth {
  year: number;
  month: number;
  label: string;
  kind: ReportMonthKind;
  /** APPROVED / PAID lines of the month (0 for MISSING / ESTIMATE months). */
  lines: number;
  /** basic + allowances (incl. bonuses) + overtime, from the stored lines. */
  gross: number;
  gosiEmployer: number;
  overtimeCost: number;
  bonusAmount: number;
  netSalary: number;
  /**
   * true = every line of the month stores gosiEmployer 0 and was generated before the employer
   * share was recorded: the employer cost of that month is incomplete ("ناقص").
   */
  gosiIncomplete: boolean;
}

/**
 * GET /api/owner-reports?from=YYYY-MM-DD&to=YYYY-MM-DD (default: the current Riyadh month).
 * Record lists for the owner report plus, for the period (council DOM-009 / DATA-03):
 * - payrollActual: ACTUAL totals from the stored APPROVED / PAID payroll lines of each elapsed
 *   month (gross, employer GOSI, overtime, bonuses, net), a MISSING marker for an elapsed month
 *   without an approved payroll, and ESTIMATE for the current month without one and the future
 *   (the page estimates those from today's employees, excluding who has not started).
 * - employerGosi: employer GOSI of the reference payroll month (latest APPROVED / PAID month not
 *   after the current month), the same rule as the dashboard.
 */
export async function GET(req: Request) {
  try {
    await requireUser(ROLE_GROUPS.OWNER);
    const q = parseQuery(req, QuerySchema);
    const now = today();
    const current = currentPayrollMonth();
    const from = q.from ?? now;
    const to = q.to ?? q.from ?? now;
    if (to < from) throw badRequest('تاريخ نهاية الفترة يسبق تاريخ بدايتها');
    const periodMonths = monthsInRange(from, to);
    if (!periodMonths.length) throw badRequest('فترة التقرير غير صالحة');
    const firstIdx = monthIndex(periodMonths[0].year, periodMonths[0].month);
    const lastIdx = monthIndex(periodMonths[periodMonths.length - 1].year, periodMonths[periodMonths.length - 1].month);

    // Only the columns the owner reports page renders / computes costs from.
    const [
      employees,
      medicalInsurances,
      companies,
      branches,
      vehicles,
      utilityMeters,
      telecomSims,
      lawsuitRows,
      contractRows,
      terminatedEmployees,
      employeesOnLeave,
      payrollGroups,
      gosiSince,
      latest,
    ] = await Promise.all([
      prisma.employee.findMany({
        where: { isTerminated: false },
        select: {
          id: true,
          firstNameArabic: true,
          lastNameArabic: true,
          joinDate: true,
          iqamaOrIdExp: true,
          iqamaRenewalCost: true,
          basicSalary: true,
          // Recurring allowances only: the page estimates future months from them.
          allowances: { where: { isMonthly: true }, select: { amount: true, isMonthly: true } },
        },
        orderBy: { firstNameArabic: 'asc' },
      }),
      prisma.medicalInsurance.findMany({
        select: { id: true, insuranceIssuer: true, policyCost: true, expiryDate: true },
      }),
      prisma.company.findMany({
        select: {
          id: true,
          nameArabic: true,
          commercialRegExp: true,
          commercialRegCost: true,
          trademarkExpDate: true,
          trademarkCost: true,
        },
      }),
      prisma.branch.findMany({
        select: {
          id: true,
          nameArabic: true,
          munLicenseExp: true,
          munLicenseCost: true,
          civilDefenseExp: true,
          civilDefenseCost: true,
          rentContractStart: true,
          rentContractExp: true,
          rentContractAmount: true,
          rentPaymentType: true,
          rentPaymentCount: true,
        },
      }),
      prisma.vehicle.findMany({
        select: { id: true, plateNumber: true, brand: true, insuranceExpDate: true, insuranceCost: true },
      }),
      prisma.utilityMeter.findMany({
        select: { id: true, accountNumber: true, meterNumber: true },
      }),
      prisma.telecomSim.findMany({
        select: { id: true, provider: true, simNumber: true, serviceType: true },
      }),
      prisma.lawsuit.findMany({
        select: { id: true, caseType: true, subject: true, lawFirmName: true, plaintiff: true, defendant: true, status: true },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.legalContract.findMany({
        select: { id: true, title: true, secondParty: true, endDate: true, status: true },
        orderBy: { endDate: 'asc' },
      }),
      prisma.employee.count({ where: { isTerminated: true } }),
      prisma.leave.count({
        where: { status: LEAVE_STATUS.APPROVED, startDate: { lte: now }, endDate: { gte: now } },
      }),
      // Stored APPROVED / PAID lines of the period's years (filtered to the months below).
      prisma.payroll.groupBy({
        by: ['year', 'month'],
        where: {
          status: { in: FINALIZED },
          year: { gte: periodMonths[0].year, lte: periodMonths[periodMonths.length - 1].year },
        },
        _sum: { basicSalary: true, totalAllowances: true, overtimeCost: true, gosiEmployer: true, bonusAmount: true, netSalary: true },
        _max: { gosiEmployer: true, createdAt: true },
        _count: { _all: true },
      }),
      gosiBreakdownSince(),
      // Reference payroll month: latest APPROVED / PAID month not after the current month.
      prisma.payroll.findFirst({
        where: {
          status: { in: FINALIZED },
          OR: [{ year: { lt: current.year } }, { year: current.year, month: { lte: current.month } }],
        },
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
        select: { year: true, month: true },
      }),
    ]);

    // --- Actual payroll of the period ------------------------------------------------------
    const byMonth = new Map(
      payrollGroups
        .filter((g) => {
          const i = monthIndex(g.year, g.month);
          return i >= firstIdx && i <= lastIdx;
        })
        .map((g) => [monthIndex(g.year, g.month), g]),
    );
    const months: ActualMonth[] = periodMonths.map(({ year, month }) => {
      const g = byMonth.get(monthIndex(year, month));
      const kind = reportMonthKind({ year, month }, current, !!g && g._count._all > 0);
      const base = { year, month, label: payrollMonthLabel(year, month), kind };
      if (kind !== 'ACTUAL' || !g) {
        return { ...base, lines: 0, gross: 0, gosiEmployer: 0, overtimeCost: 0, bonusAmount: 0, netSalary: 0, gosiIncomplete: false };
      }
      const allZero = (g._max.gosiEmployer ?? 0) === 0;
      const beforeColumn = !gosiSince || !g._max.createdAt || g._max.createdAt < gosiSince;
      return {
        ...base,
        lines: g._count._all,
        gross: sumMoney([g._sum.basicSalary, g._sum.totalAllowances, g._sum.overtimeCost]),
        gosiEmployer: sumMoney([g._sum.gosiEmployer]),
        overtimeCost: sumMoney([g._sum.overtimeCost]),
        bonusAmount: sumMoney([g._sum.bonusAmount]),
        netSalary: sumMoney([g._sum.netSalary]),
        gosiIncomplete: allZero && beforeColumn,
      };
    });
    const actual = months.filter((m) => m.kind === 'ACTUAL');
    const actualGross = sumMoney(actual.map((m) => m.gross));
    const actualGosi = sumMoney(actual.map((m) => m.gosiEmployer));
    const payrollActual = {
      period: { from: dateKey(from), to: dateKey(to) },
      currentMonth: current,
      months,
      totals: {
        lines: actual.reduce((n, m) => n + m.lines, 0),
        gross: actualGross,
        gosiEmployer: actualGosi,
        overtimeCost: sumMoney(actual.map((m) => m.overtimeCost)),
        bonusAmount: sumMoney(actual.map((m) => m.bonusAmount)),
        netSalary: sumMoney(actual.map((m) => m.netSalary)),
        /** gross + employer GOSI (company cost of the approved payrolls). */
        employerCost: sumMoney([actualGross, actualGosi]),
      },
      actualMonths: actual.length,
      missingMonths: months.filter((m) => m.kind === 'MISSING').length,
      estimateMonths: months.filter((m) => m.kind === 'ESTIMATE').length,
      gosiIncompleteMonths: actual.filter((m) => m.gosiIncomplete).length,
    };

    // --- Employer GOSI of the reference payroll month ----------------------------------------
    let employerGosi: {
      year: number;
      month: number;
      label: string;
      gosiEmployer: number;
      gosiEmployee: number;
      employees: number;
      byStatus: Record<string, number>;
      gosiIncomplete: boolean;
    } | null = null;
    if (latest) {
      const groups = await prisma.payroll.groupBy({
        by: ['status'],
        where: { year: latest.year, month: latest.month, status: { in: FINALIZED } },
        _sum: { gosiEmployer: true, gosiEmployee: true },
        _max: { gosiEmployer: true, createdAt: true },
        _count: { _all: true },
      });
      const byStatus: Record<string, number> = {};
      for (const g of groups) byStatus[g.status] = g._count._all;
      const maxGosi = Math.max(0, ...groups.map((g) => g._max.gosiEmployer ?? 0));
      const lastCreated = groups.reduce<Date | null>((a, g) => (g._max.createdAt && (!a || g._max.createdAt > a) ? g._max.createdAt : a), null);
      employerGosi = {
        year: latest.year,
        month: latest.month,
        label: payrollMonthLabel(latest.year, latest.month),
        gosiEmployer: sumMoney(groups.map((g) => g._sum.gosiEmployer ?? 0)),
        gosiEmployee: sumMoney(groups.map((g) => g._sum.gosiEmployee ?? 0)),
        employees: groups.reduce((n, g) => n + g._count._all, 0),
        byStatus,
        gosiIncomplete: maxGosi === 0 && (!gosiSince || !lastCreated || lastCreated < gosiSince),
      };
    }

    // Real column names (no caseNumber / courtName aliases: the lawsuit model has neither).
    const lawsuits = lawsuitRows.map((l) => ({
      ...l,
      caseTypeLabel: CASE_TYPE_LABELS[l.caseType] ?? l.caseType,
      statusLabel: LAWSUIT_STATUS_LABELS[l.status] ?? l.status,
    }));
    const legalContracts = contractRows.map((c) => ({
      ...c,
      statusLabel: CONTRACT_STATUS_LABELS[c.status] ?? c.status,
    }));

    return NextResponse.json({
      employees,
      medicalInsurances,
      companies,
      branches,
      vehicles,
      utilityMeters,
      telecomSims,
      lawsuits,
      legalContracts,
      employerGosi,
      payrollActual,
      metrics: {
        activeEmployees: employees.length,
        terminatedEmployees,
        companies: companies.length,
        branches: branches.length,
        vehicles: vehicles.length,
        employeesOnLeave,
        utilityMeters: utilityMeters.length,
        telecomSims: telecomSims.length,
        lawsuits: lawsuits.length,
        legalContracts: legalContracts.length,
      },
    });
  } catch (err) {
    return handleApiError(err, 'owner-reports:GET');
  }
}
