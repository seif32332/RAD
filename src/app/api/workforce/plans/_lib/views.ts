// Response shapes of the plan routes (positions, raises, display names). Server-only.
import 'server-only';
import { prisma } from '@/lib/prisma';
import { planMonthKey, POSITION_KIND_LABELS, RAISE_SCOPE_LABELS, type PositionKind, type RaiseScope } from '@/lib/workforce/planning';
import { companyNameMap, type PlanRow } from './server';

/** Names shown next to the positions and raises (employees, branches, departments, companies). */
export async function displayNames(row: PlanRow) {
  const empIds = [...new Set([...row.positions.map((p) => p.exitEmployeeId), ...row.raises.filter((r) => r.scope === 'EMPLOYEE').map((r) => r.scopeId)].filter((x): x is string => !!x))];
  const [emps, branches, departments, companies] = await Promise.all([
    empIds.length ? prisma.employee.findMany({ where: { id: { in: empIds } }, select: { id: true, employeeId: true, firstNameArabic: true, lastNameArabic: true } }) : Promise.resolve([]),
    prisma.branch.findMany({ select: { id: true, nameArabic: true } }),
    prisma.department.findMany({ select: { id: true, nameArabic: true } }),
    companyNameMap(),
  ]);
  return {
    employees: Object.fromEntries(emps.map((e) => [e.id, `${e.firstNameArabic ?? ''} ${e.lastNameArabic ?? ''}`.trim() || e.employeeId || e.id])),
    branches: Object.fromEntries(branches.map((b) => [b.id, b.nameArabic])),
    departments: Object.fromEntries(departments.map((d) => [d.id, d.nameArabic])),
    companies: Object.fromEntries(companies),
  };
}

export function serializePositions(row: PlanRow) {
  return row.positions.map((p) => ({
    id: p.id,
    kind: p.kind,
    kindLabel: POSITION_KIND_LABELS[p.kind as PositionKind] ?? p.kind,
    title: p.title,
    companyId: p.companyId,
    branchId: p.branchId,
    departmentId: p.departmentId,
    nationalityClass: p.nationalityClass,
    gosiRegime: p.gosiRegime,
    gender: p.gender,
    occupationName: p.occupationName,
    basicSalary: p.basicSalary,
    housingAllowance: p.housingAllowance,
    otherAllowances: p.otherAllowances,
    dependentsCount: p.dependentsCount,
    medicalClass: p.medicalClass,
    startMonth: p.startMonth ? planMonthKey(p.startMonth) : null,
    exitEmployeeId: p.exitEmployeeId,
    exitMonth: p.exitMonth ? planMonthKey(p.exitMonth) : null,
    exitReason: p.exitReason,
    notes: p.notes,
  }));
}

export function serializeRaises(row: PlanRow) {
  return row.raises.map((r) => ({
    id: r.id,
    scope: r.scope,
    scopeLabel: RAISE_SCOPE_LABELS[r.scope as RaiseScope] ?? r.scope,
    scopeId: r.scopeId,
    pct: r.pct,
    amount: r.amount,
    effectiveMonth: planMonthKey(r.effectiveMonth),
    notes: r.notes,
  }));
}

