// Reads of the owner dashboard (ARCHITECTURE_INVARIANTS §4.3 rule 6): open findings by severity, the
// oldest, the waivers of this month, the last run of each invariant. Discrepancy is a platform table
// that iam's scoped client does not filter (INFRA_MODELS), so the company scope is applied HERE from
// the caller's companies (the route builds them from its ScopedContext): a restricted caller sees his
// companies only and never the tenant-level findings (companyId NULL).
import type { Prisma, PrismaClient } from '@prisma/client';
import { INVARIANTS, invariantById } from './registry';

type Db = PrismaClient | Prisma.TransactionClient;

/** 'ALL' = every company and the tenant-level findings; a list = those companies only. */
export type DiscrepancyCompanies = 'ALL' | readonly string[];

export function companyFilter(companies: DiscrepancyCompanies): Prisma.DiscrepancyWhereInput {
  return companies === 'ALL' ? {} : { companyId: { in: [...companies] } };
}

const LIST_SELECT = {
  id: true, ruleId: true, checkId: true, domain: true, companyId: true, subjectEmployeeId: true, entityType: true, entityId: true,
  period: true, severity: true, blocking: true, blocks: true, category: true, status: true, pendingAction: true,
  detectedAt: true, lastSeenAt: true, occurrences: true, actualValue: true,
  explanation: true, explanationRef: true, explainedById: true, explainedAt: true, explanationApprovedById: true,
  waiverReason: true, waivedById: true, waivedAt: true, waiverApprovedById: true,
  selfActSingleOperator: true, ownerConfirmation: true, resolution: true, resolutionRef: true, resolvedAt: true, closedAt: true, version: true,
} as const;

const SEVERITY_ORDER = ['BLOCKING', 'HIGH', 'WARNING', 'INFO'];

export interface DashboardOptions {
  companies: DiscrepancyCompanies;
  /** Also list EXPLAINED / WAIVED / RESOLVED / AUTO_CLOSED rows (default: OPEN only). */
  includeClosed?: boolean;
  take?: number;
  now?: Date;
}

export async function integrityDashboard(db: Db, opts: DashboardOptions) {
  const scope = companyFilter(opts.companies);
  const now = opts.now ?? new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const take = Math.min(Math.max(opts.take ?? 200, 1), 500);
  const runScope: Prisma.InvariantRunWhereInput = opts.companies === 'ALL' ? {} : { companyId: { in: [...opts.companies] } };

  const [rows, openBySeverity, openByCompany, waivedThisMonth, lastRuns] = await Promise.all([
    db.discrepancy.findMany({
      where: { ...scope, ...(opts.includeClosed ? {} : { status: 'OPEN' }) },
      orderBy: [{ detectedAt: 'asc' }, { id: 'asc' }],
      take,
      select: LIST_SELECT,
    }),
    db.discrepancy.groupBy({ by: ['severity'], where: { ...scope, status: 'OPEN' }, _count: { _all: true } }),
    db.discrepancy.groupBy({ by: ['companyId', 'severity'], where: { ...scope, status: 'OPEN' }, _count: { _all: true } }),
    db.discrepancy.count({ where: { ...scope, status: 'WAIVED', waivedAt: { gte: monthStart } } }),
    db.invariantRun.findMany({
      where: runScope,
      orderBy: [{ startedAt: 'desc' }],
      take: 500,
      select: { ruleId: true, companyId: true, status: true, startedAt: true, finishedAt: true, found: true, opened: true, reopened: true, autoClosed: true, error: true, runId: true },
    }),
  ]);

  const lastRunByRule = new Map<string, (typeof lastRuns)[number]>();
  for (const r of lastRuns) if (!lastRunByRule.has(r.ruleId)) lastRunByRule.set(r.ruleId, r);

  // Blocking first, then by severity, then the oldest (rule 6: "the oldest").
  rows.sort((a, b) => Number(b.blocking) - Number(a.blocking) || SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || a.detectedAt.getTime() - b.detectedAt.getTime());

  return {
    generatedAt: now.toISOString(),
    summary: {
      openBySeverity: Object.fromEntries(SEVERITY_ORDER.map((s) => [s, openBySeverity.find((g) => g.severity === s)?._count._all ?? 0])),
      openByCompany: openByCompany.map((g) => ({ companyId: g.companyId, severity: g.severity, count: g._count._all })),
      waivedThisMonth,
      oldestOpenAt: rows.find((r) => r.status === 'OPEN')?.detectedAt ?? null,
    },
    invariants: INVARIANTS.map((d) => ({
      id: d.id,
      titleAr: d.titleAr,
      owner: d.owner,
      severity: d.severity,
      integrity: d.integrity,
      blocks: d.blocks,
      measured: typeof invariantById(d.id)?.check === 'function',
      note: d.note ?? null,
      lastRun: lastRunByRule.get(d.id) ?? null,
    })),
    discrepancies: rows,
  };
}

/** One discrepancy with its company, for the scope check of an action. */
export async function discrepancyScopeOf(db: Db, id: string): Promise<{ id: string; companyId: string | null; version: number } | null> {
  return db.discrepancy.findUnique({ where: { id }, select: { id: true, companyId: true, version: true } });
}
