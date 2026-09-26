// /api/workforce/calculations — saved calculations (WorkforceCalculation snapshots, SPEC principle 5).
// GET ?kind&take&skip: list, newest first (metadata only: no inputs / outputs).
// POST { kind: TRUE_COST | EXIT_COST | OVERVIEW | SAUDIZATION | HIRE_SCENARIO, params, title? }: the
//      calculation is RECOMPUTED on the server from `params` (validated with the same schemas as the live
//      endpoints); outputs sent by the client are never stored. buildSnapshot() records the engine version
//      and the exact rule versions. SAUDIZATION snapshots store the RESTRICTED view (no names, no
//      per-category or per-line weights: disability is health data) whoever saves them.
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, notFound, parseBody, parseQuery } from '@/lib/http';
import { logAudit } from '@/lib/audit';
import { buildSnapshot, type SnapshotSubject } from '@/lib/workforce/snapshot';
import { saveWorkforceCalculation } from '@/lib/workforce/load';
import { stripSensitiveEmployeeFields } from '@/lib/workforce/privacy';
import { calculationListSchema, calculationPostSchema, exitCostSchema, overviewQuerySchema, trueCostParamsSchema } from '../_lib/schemas';
import { hireScenarioSchema, saudizationSnapshotSchema } from '../_lib/saudization-schemas';
import { runHireScenario, runSaudization, runSolve } from '../_lib/saudization';
import { limitOrThrow, runExitCost, runOverview, runTrueCost, trueCostTotals } from '../_lib/server';
import type { RuleVersionRef } from '@/lib/workforce/types';
import { summarizeEmployee } from '../_lib/views';

export const dynamic = 'force-dynamic';

/** Employee inputs are stored in full only for small scopes (bounded row size). */
const MAX_STORED_EMPLOYEE_INPUTS = 50;

/**
 * Identity / disability fields are never stored (privacy.ts SENSITIVE_EMPLOYEE_FIELDS = PAYROLL_HIDDEN_FIELDS).
 * Reproducibility: the HRDF categories they produced are kept as codes in the outputs (HRDF_SUBSIDY lines,
 * `categories`), which GET /api/workforce/calculations/[id] redacts for viewers who may not see them.
 * The marker names the policy, not the fields (a stored field name would itself hint at the data).
 */
const REDACTED_INPUTS_NOTE = {
  policy: 'PAYROLL_HIDDEN_FIELDS',
  note: 'حُذفت البيانات الشخصية الحساسة (الهوية والبيانات الصحية) من مدخلات الموظف المحفوظة؛ أثرها على دعم هدف محفوظ في النتائج (فئات سطر الدعم)',
};

export async function GET(req: Request) {
  try {
    await requireUser(ROLE_GROUPS.WORKFORCE);
    const q = parseQuery(req, calculationListSchema);
    const where = q.kind ? { kind: q.kind } : {};
    const [rows, total] = await Promise.all([
      prisma.workforceCalculation.findMany({
        where,
        select: { id: true, kind: true, subjectType: true, subjectId: true, title: true, engineVersion: true, createdById: true, createdAt: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.take,
        skip: q.skip,
      }),
      prisma.workforceCalculation.count({ where }),
    ]);
    const userIds = [...new Set(rows.map((r) => r.createdById).filter((x): x is string => !!x))];
    const users = userIds.length ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }) : [];
    const names = new Map(users.map((u) => [u.id, u.name || u.email]));
    return NextResponse.json({
      total,
      take: q.take,
      skip: q.skip,
      items: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), createdByName: r.createdById ? (names.get(r.createdById) ?? null) : null })),
    });
  } catch (err) {
    return handleApiError(err, 'workforce:calculations:GET');
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.WORKFORCE);
    const body = await parseBody(req, calculationPostSchema);
    limitOrThrow(user, 'calc-save', 20, 60_000);

    let record;
    if (body.kind === 'TRUE_COST') {
      const p = trueCostParamsSchema.parse(body.params);
      const run = await runTrueCost(p);
      const single = p.employeeId ? run.tc.employees.find((e) => e.employeeId === p.employeeId) : null;
      if (p.employeeId && !single) throw notFound('الموظف غير موجود أو لا يعمل خلال فترة التوقع');
      const subject: SnapshotSubject = single
        ? { type: 'EMPLOYEE', id: single.employeeId, title: body.title ?? `الكلفة الحقيقية — ${single.name}` }
        : p.departmentId
          ? { type: 'DEPARTMENT', id: p.departmentId, title: body.title ?? 'الكلفة الحقيقية — إدارة' }
          : p.branchId
            ? { type: 'BRANCH', id: p.branchId, title: body.title ?? 'الكلفة الحقيقية — فرع' }
            : p.companyId
              ? { type: 'COMPANY', id: p.companyId, title: body.title ?? 'الكلفة الحقيقية — شركة' }
              : { type: 'ALL', id: null, title: body.title ?? 'الكلفة الحقيقية — كل الموظفين' };
      const reported = new Set(run.tc.employees.map((e) => e.employeeId));
      const inputs = {
        params: { ...p, startMonth: run.startMonth },
        months: run.tc.monthKeys.length,
        scope: run.scope,
        reportedEmployees: reported.size,
        employees: reported.size <= MAX_STORED_EMPLOYEE_INPUTS ? run.input.employees.filter((e) => reported.has(e.id)).map(stripSensitiveEmployeeFields) : null,
        redactedEmployeeFields: REDACTED_INPUTS_NOTE,
        employeesNote: reported.size <= MAX_STORED_EMPLOYEE_INPUTS ? null : `مدخلات ${reported.size} موظف غير محفوظة بالكامل (الحد ${MAX_STORED_EMPLOYEE_INPUTS})؛ حُفظت النتائج لكل موظف`,
        companies: run.input.companies,
        assumptions: run.assumptions,
        annualLeaveDaysSetting: run.input.annualLeaveDaysSetting ?? null,
      };
      const outputs = single
        ? { employee: summarizeEmployee(single), totals: single.totals, months: single.months, byLine: single.byLine, liabilities: single.liabilities, flags: single.flags }
        : { ...trueCostTotals(run.tc), composition: run.tc.composition, byCompany: run.tc.byCompany.map(({ series: _s, ...g }) => g), byBranch: run.tc.byBranch.map(({ series: _s, ...g }) => g), byDepartment: run.tc.byDepartment.map(({ series: _s, ...g }) => g), employees: run.tc.employees.map(summarizeEmployee) };
      record = buildSnapshot('TRUE_COST', subject, inputs, outputs, run.tc.rulesUsed);
    } else if (body.kind === 'EXIT_COST') {
      const p = exitCostSchema.parse(body.params);
      const out = await runExitCost(p);
      const inputs = {
        params: { ...p, lastWorkingDate: p.lastWorkingDate.toISOString().slice(0, 10) },
        employee: stripSensitiveEmployeeFields(out.input.employee),
        redactedEmployeeFields: REDACTED_INPUTS_NOTE,
        lastMonthAlreadyPaid: out.input.lastMonthAlreadyPaid ?? null,
        company: out.input.company,
        // «إعدادات الكلفة» used (legal company, else actual company).
        settingsCompany: out.input.settingsCompany ?? null,
        companyEmployees: out.input.companyEmployees.length,
        assumptions: out.input.assumptions,
        annualLeaveDaysSetting: out.input.annualLeaveDaysSetting ?? null,
      };
      const outputs = { ...out.result, warnings: out.warnings, reasonMapping: out.reasonMapping };
      record = buildSnapshot('EXIT_COST', { type: 'EMPLOYEE', id: out.employee.id, title: body.title ?? `كلفة الإنهاء — ${out.employee.name}` }, inputs, outputs, out.result.rulesUsed);
    } else if (body.kind === 'SAUDIZATION') {
      const p = saudizationSnapshotSchema.parse(body.params);
      // Restricted view (viewer role null): the stored snapshot never names who is disabled.
      const est = await runSaudization({ companyId: p.companyId, date: p.date, summary: false }, null);
      const company = 'companies' in est ? est.companies[0] : null;
      if (!company || !('compliance' in company)) throw notFound('الشركة غير موجودة');
      const solve = p.targetBand ? (await runSolve({ companyId: p.companyId, targetBand: p.targetBand, byDate: p.byDate ?? p.date, options: p.options }, null)).result : null;
      const inputs = { params: { ...p, date: est.date, byDate: solve?.byDate ?? null }, activity: company.estimate.activity, counts: company.estimate.counts, assumptions: company.estimate.assumptions };
      const outputs = { estimate: company.estimate, compliance: company.compliance, alerts: company.alerts, solve };
      const refs: RuleVersionRef[] = company.estimate.evidence.map((e) => ({ key: e.key, effectiveFrom: e.effectiveFrom, status: e.status, value: e.value }));
      record = buildSnapshot('SAUDIZATION', { type: 'COMPANY', id: p.companyId, title: body.title ?? `مخطط السعودة — ${company.companyName}` }, inputs, outputs, refs);
    } else if (body.kind === 'HIRE_SCENARIO') {
      const p = hireScenarioSchema.parse(body.params);
      const out = await runHireScenario(p);
      const refs = new Map<string, RuleVersionRef>();
      for (const c of out.result.candidates) for (const r of c.rulesUsed) refs.set(`${r.key}@${r.effectiveFrom}`, r);
      const inputs = { params: { ...p, startMonth: out.result.startMonth }, company: out.result.company };
      record = buildSnapshot('HIRE_SCENARIO', { type: 'COMPANY', id: p.companyId, title: body.title ?? `سيناريو توظيف — ${out.result.company.name}` }, inputs, out.result, [...refs.values()]);
    } else {
      const p = overviewQuerySchema.parse(body.params);
      const { run, response } = await runOverview(p);
      const inputs = { params: { ...p, startMonth: run.startMonth }, months: run.tc.monthKeys.length, employees: run.tc.employees.length, companies: run.input.companies, assumptions: run.assumptions };
      record = buildSnapshot('OVERVIEW', { type: 'ALL', id: null, title: body.title ?? `لوحة القرار — ${p.months} شهراً` }, inputs, response, run.tc.rulesUsed);
    }

    const id = await saveWorkforceCalculation(record, user.id);
    await logAudit({
      userId: user.id,
      action: 'CREATE',
      entityType: 'WorkforceCalculation',
      entityId: id,
      details: { kind: record.kind, subjectType: record.subjectType, subjectId: record.subjectId, title: record.title, engineVersion: record.engineVersion },
      ipAddress: getClientIp(req),
    });
    return NextResponse.json({ id, kind: record.kind, title: record.title, engineVersion: record.engineVersion }, { status: 201 });
  } catch (err) {
    return handleApiError(err, 'workforce:calculations:POST');
  }
}
