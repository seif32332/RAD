// GET /api/workforce/benchmarks — «المؤشرات الداخلية» (SPEC §1 module 7, §9).
//   ?months=3|6|12|24 (default 12) &companyId (legal company) &branchId &departmentId
// WORKFORCE roles. Aggregated only: no names, no employee ids; every breakdown group below 5 people is
// suppressed («أقل من 5»), a scope below 5 shows no metric, a sub-scope that would reveal a small group by
// subtraction from a wider scope is hidden (scopeDisclosure), and per-case metrics on fewer than 5 cases are
// hidden. Values come ONLY from the organisation's records in Radeef (no default or industry figure). Rate
// limited; VIEW audited at most once per 5 minutes per user AND filter set (every scope probed is logged).
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { badRequest, handleApiError, parseQuery } from '@/lib/http';
import { today } from '@/lib/dates';
import { zId } from '@/lib/validation';
import { BENCHMARK_PERIODS, BENCHMARK_SOURCE, MIN_GROUP_SIZE, computeBenchmarks, scopeDisclosure } from '@/lib/workforce/benchmarks';
import { auditViewOnce, limitOrThrow } from '../_lib/server';
import { loadBenchmarkPopulation, loadBenchmarksInput } from './_load';

export const dynamic = 'force-dynamic';

const blank = (v: unknown) => (v === '' || v === null ? undefined : v);

const querySchema = z
  .object({
    months: z.preprocess(
      (v) => (v === '' || v === undefined || v === null ? 12 : Number(v)),
      z.number().refine((n) => (BENCHMARK_PERIODS as ReadonlyArray<number>).includes(n), 'الفترة يجب أن تكون 3 أو 6 أو 12 أو 24 شهراً'),
    ),
    companyId: z.preprocess(blank, zId.optional()),
    branchId: z.preprocess(blank, zId.optional()),
    departmentId: z.preprocess(blank, zId.optional()),
  })
  .strict();

export async function GET(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.WORKFORCE);
    const q = parseQuery(req, querySchema);
    limitOrThrow(user, 'benchmarks', 30, 60_000);
    const [company, branch, department] = await Promise.all([
      q.companyId ? prisma.company.findUnique({ where: { id: q.companyId }, select: { id: true, nameArabic: true } }) : null,
      q.branchId ? prisma.branch.findUnique({ where: { id: q.branchId }, select: { id: true, nameArabic: true } }) : null,
      q.departmentId ? prisma.department.findUnique({ where: { id: q.departmentId }, select: { id: true, nameArabic: true } }) : null,
    ]);
    if (q.companyId && !company) throw badRequest('الشركة غير موجودة');
    if (q.branchId && !branch) throw badRequest('الفرع غير موجود');
    if (q.departmentId && !department) throw badRequest('الإدارة غير موجودة');

    const asOf = today();
    const scope = { companyId: q.companyId ?? null, branchId: q.branchId ?? null, departmentId: q.departmentId ?? null };
    const scoped = !!(scope.companyId || scope.branchId || scope.departmentId);
    const [{ input, notes }, population] = await Promise.all([loadBenchmarksInput({ asOf, months: q.months, scope }), scoped ? loadBenchmarkPopulation({ asOf, months: q.months }) : Promise.resolve(null)]);
    // A sub-scope is compared with the wider scopes containing it (no recovery of a small group by subtraction).
    const disclosure = population ? scopeDisclosure(population, scope, asOf, q.months, MIN_GROUP_SIZE) : null;
    const result = computeBenchmarks(input, { asOf, months: q.months, minGroupSize: MIN_GROUP_SIZE, disclosure });
    await auditViewOnce(user, 'WorkforceBenchmarks', { months: q.months, ...scope }, getClientIp(req));
    return NextResponse.json({
      ...result,
      source: BENCHMARK_SOURCE,
      scope: { ...scope, companyName: company?.nameArabic ?? null, branchName: branch?.nameArabic ?? null, departmentName: department?.nameArabic ?? null },
      notes,
    });
  } catch (err) {
    return handleApiError(err, 'workforce:benchmarks:GET');
  }
}
