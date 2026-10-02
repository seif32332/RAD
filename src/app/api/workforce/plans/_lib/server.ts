// Server side of «خطة القوى العاملة»: load the plan and the engine inputs (src/lib/workforce/load.ts +
// the plan tables) -> projectPlan / planVsActual (pure) -> shape. The plan is scenario data: this module
// writes ONLY HeadcountPlan / PlannedPosition / PlanRaise, the audit log and WorkforceCalculation snapshots,
// never Employee, SalaryChange, Allowance or Payroll.
import 'server-only';
import type { HeadcountPlan, LeaveStatus, LeaveType, PlanRaise, PlannedPosition, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { conflict, HttpError, notFound } from '@/lib/http';
import { todayKey } from '@/lib/dates';
import { BALANCE_CONSUMING_STATUSES, BALANCE_LEAVE_TYPES } from '@/lib/leave';
import { LOAN_DEDUCTIBLE_STATUSES, PAYROLL_STATUS } from '@/lib/constants';
import type { AuthUser } from '@/lib/auth';
import type { SettlementLeaveLike, SettlementLoanLike } from '@/lib/settlement';
import { loadLocalizationDecisions, loadNitaqatRegister, loadTrueCostInput } from '@/lib/workforce/load';
import { buildSnapshot, type WorkforceCalculationRecord } from '@/lib/workforce/snapshot';
import { parseDecision } from '@/lib/workforce/saudization';
import {
  PLAN_STATUS_LABELS,
  decidePlanAction,
  planMonthKey,
  projectPlan,
  type PlanAction,
  type PlanBaseInput,
  type PlanDefinition,
  type PlanProjection,
  type PlanStatus,
} from '@/lib/workforce/planning';
import { currentDecisions } from '../../_lib/saudization';
import { assertBranchVisible, assertCompanyVisible, assertDepartmentVisible, assertEmployeeVisible, companyScopeWhere, planScopeWhere, type WfScope } from '../../_lib/scope';

export const PLAN_ENTITY = 'HeadcountPlan';

export type PlanRow = HeadcountPlan & { positions: PlannedPosition[]; raises: PlanRaise[] };

export const PLAN_INCLUDE = {
  positions: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
  raises: { orderBy: [{ effectiveMonth: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] },
} satisfies Prisma.HeadcountPlanInclude;

/** 'YYYY-MM' -> first day of the month (UTC). */
export function monthDate(key: string): Date {
  return new Date(`${key}-01T00:00:00.000Z`);
}

export function todayDate(): Date {
  return new Date(`${todayKey()}T00:00:00.000Z`);
}

/**
 * The plan when it is inside the caller's scope (P1-SCOPE): a plan of another company, or of every company
 * (companyId null) for a restricted caller, is "not found".
 */
export async function loadPlanOr404(id: string, s: WfScope, db: Prisma.TransactionClient = prisma): Promise<PlanRow> {
  const row = await db.headcountPlan.findFirst({ where: { id, AND: [planScopeWhere(s)] }, include: PLAN_INCLUDE });
  if (!row) throw notFound('الخطة غير موجودة');
  return row;
}

export function toDefinition(row: PlanRow): PlanDefinition {
  return {
    id: row.id,
    name: row.name,
    companyId: row.companyId,
    fromMonth: planMonthKey(row.fromMonth)!,
    months: row.months,
    attritionPct: row.attritionPct,
    positions: row.positions.map((p) => ({
      id: p.id,
      kind: p.kind,
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
    })),
    raises: row.raises.map((r) => ({ id: r.id, scope: r.scope, scopeId: r.scopeId, pct: r.pct, amount: r.amount, effectiveMonth: planMonthKey(r.effectiveMonth)!, notes: r.notes })),
  };
}

/** Date of the default attrition rate: the day before the plan starts, or today when the plan starts later. */
export function turnoverAsOfFor(fromMonth: Date): Date {
  const dayBefore = new Date(fromMonth.getTime() - 86400000);
  const t = todayDate();
  return dayBefore.getTime() < t.getTime() ? dayBefore : t;
}

/** Engine inputs of a plan (everything the pure projectPlan needs). */
export async function loadPlanBase(row: PlanRow): Promise<PlanBaseInput> {
  const fromKey = planMonthKey(row.fromMonth)!;
  const exitIds = [...new Set(row.positions.filter((p) => p.kind === 'EXIT' && p.exitEmployeeId).map((p) => p.exitEmployeeId!))];
  const [loaded, register, decisionRows, branches, departments, turnoverEmployees, details] = await Promise.all([
    // A company plan loads that legal company only (levy tiers are per legal company): nothing of another
    // company enters its projection or its snapshot. A plan of every company (unrestricted callers only) loads all.
    loadTrueCostInput({ startMonth: fromKey, months: row.months, scope: row.companyId ? { companyIds: [row.companyId] } : null }),
    loadNitaqatRegister(),
    loadLocalizationDecisions(),
    prisma.branch.findMany({ select: { id: true, nameArabic: true, city: true }, orderBy: { id: 'asc' } }),
    prisma.department.findMany({ select: { id: true, nameArabic: true }, orderBy: { id: 'asc' } }),
    prisma.employee.findMany({
      where: row.companyId ? { legalCompanyId: row.companyId } : {},
      select: { id: true, joinDate: true, isTerminated: true, terminationDate: true, legalCompanyId: true },
      orderBy: { id: 'asc' },
    }),
    exitIds.length
      ? prisma.employee.findMany({
          where: { id: { in: exitIds } },
          select: {
            id: true,
            // Same filters as the settlement screen / loadExitCostInput.
            leaves: {
              where: { status: { in: [...BALANCE_CONSUMING_STATUSES] as LeaveStatus[] }, leaveType: { in: [...BALANCE_LEAVE_TYPES] as LeaveType[] } },
              select: { leaveType: true, status: true, startDate: true, endDate: true, createdAt: true, totalDays: true, paidDays: true },
            },
            loans: {
              where: { status: { in: [...LOAN_DEDUCTIBLE_STATUSES] }, isForgiven: false, remainingAmount: { gt: 0 } },
              select: { remainingAmount: true, installments: { where: { payroll: { status: PAYROLL_STATUS.DRAFT } }, select: { month: true, year: true, amount: true } } },
            },
          },
        })
      : Promise.resolve([]),
  ]);
  // A legal-company plan only needs that company's employees (levy tiers are per legal company).
  const employees = row.companyId ? loaded.input.employees.filter((e) => e.legalCompanyId === row.companyId) : loaded.input.employees;
  const exitDetails: Record<string, { leaves: SettlementLeaveLike[]; loans: SettlementLoanLike[] }> = {};
  for (const d of details) exitDetails[d.id] = { leaves: d.leaves.map((l) => ({ ...l, leaveType: String(l.leaveType), status: String(l.status) })), loans: d.loans };
  return {
    ...loaded.input,
    employees,
    exitDetails,
    nitaqat: { activities: register.activities, curves: register.curves },
    decisions: currentDecisions(decisionRows).map(parseDecision),
    branches: branches.map((b) => ({ id: b.id, name: b.nameArabic, city: b.city })),
    departments: departments.map((d) => ({ id: d.id, name: d.nameArabic })),
    turnoverEmployees,
  };
}

export interface PlanRun {
  projection: PlanProjection;
  base: PlanBaseInput;
  turnoverAsOf: Date;
}

/** Live projection of the plan as stored now (recomputed from the current data). */
export async function computePlan(row: PlanRow): Promise<PlanRun> {
  const base = await loadPlanBase(row);
  const turnoverAsOf = turnoverAsOfFor(row.fromMonth);
  const projection = projectPlan(base, toDefinition(row), { turnoverAsOf });
  return { projection, base, turnoverAsOf };
}

/** Snapshot inputs of a plan (definition + context; no identity or health fields of any employee). */
export function snapshotInputs(row: PlanRow, run: PlanRun, purpose: 'APPROVAL' | 'MANUAL') {
  const def = toDefinition(row);
  return {
    purpose,
    params: { planId: row.id },
    plan: { ...def, status: row.status, basedOnId: row.basedOnId, notes: row.notes },
    turnoverAsOf: run.turnoverAsOf.toISOString().slice(0, 10),
    employeesInScope: run.projection.scope.employees,
    companies: run.base.companies,
    assumptions: run.base.assumptions,
    annualLeaveDaysSetting: run.base.annualLeaveDaysSetting ?? null,
  };
}

export function planSnapshotRecord(row: PlanRow, run: PlanRun, purpose: 'APPROVAL' | 'MANUAL', title?: string | null): WorkforceCalculationRecord {
  return buildSnapshot(
    'WORKFORCE_PLAN',
    { type: 'PLAN', id: row.id, title: title ?? (purpose === 'APPROVAL' ? `اعتماد خطة القوى العاملة — ${row.name}` : `خطة القوى العاملة — ${row.name}`) },
    snapshotInputs(row, run, purpose),
    run.projection,
    run.projection.rulesUsed,
  );
}

/** The projection frozen when the plan was approved (the reference for plan vs actual). */
export async function frozenProjection(planId: string): Promise<{ snapshotId: string; createdAt: string; projection: PlanProjection } | null> {
  const snap = await prisma.workforceCalculation.findFirst({
    where: { kind: 'WORKFORCE_PLAN', subjectType: 'PLAN', subjectId: planId, inputs: { contains: '"purpose":"APPROVAL"' } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true, createdAt: true, outputs: true },
  });
  if (!snap) return null;
  try {
    return { snapshotId: snap.id, createdAt: snap.createdAt.toISOString(), projection: JSON.parse(snap.outputs) as PlanProjection };
  } catch {
    return null;
  }
}

/** Frozen projection for an approved (or archived after approval) plan unless `live`; else the live one. */
export async function projectionFor(row: PlanRow, live: boolean): Promise<{ projection: PlanProjection; frozen: { snapshotId: string; createdAt: string } | null; run: PlanRun | null }> {
  if (!live && (row.status === 'APPROVED' || row.status === 'ARCHIVED')) {
    const f = await frozenProjection(row.id);
    if (f) return { projection: f.projection, frozen: { snapshotId: f.snapshotId, createdAt: f.createdAt }, run: null };
  }
  const run = await computePlan(row);
  return { projection: run.projection, frozen: null, run };
}

/** The projection without the per-person arrays (kept server-side for plan vs actual). */
export function publicProjection(p: PlanProjection): Omit<PlanProjection, 'people'> {
  const { people: _people, ...rest } = p;
  return rest;
}

/** Who submitted the plan last (the SUBMIT audit row written in the same transaction as the status). */
export async function submitterOf(planId: string, db: Prisma.TransactionClient = prisma): Promise<string | null> {
  const row = await db.auditLog.findFirst({
    where: { entityType: PLAN_ENTITY, entityId: planId, details: { contains: '"transition":"SUBMIT"' } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { userId: true },
  });
  return row?.userId ?? null;
}

/** Audit entity types of a plan's positions and raises (their details start with {"planId": ...}). */
export const PLAN_CHILD_ENTITIES = ['PlannedPosition', 'PlanRaise'] as const;

/**
 * Every user who authored the plan's content: a CREATE / UPDATE / DELETE audit row of the plan header (its
 * creation, edits and submissions) or of one of its positions or raises. None of them may approve or reject
 * it (maker-checker, SPEC §8). The plan cannot change while SUBMITTED, so the list is stable during a decision.
 */
export async function authorsOf(planId: string, db: Prisma.TransactionClient = prisma): Promise<string[]> {
  const rows = await db.auditLog.findMany({
    where: {
      action: { in: ['CREATE', 'UPDATE', 'DELETE'] },
      userId: { not: null },
      OR: [
        { entityType: PLAN_ENTITY, entityId: planId },
        { entityType: { in: [...PLAN_CHILD_ENTITIES] }, details: { contains: `"planId":${JSON.stringify(planId)}` } },
      ],
    },
    select: { userId: true },
    distinct: ['userId'],
  });
  return [...new Set(rows.map((r) => r.userId).filter((x): x is string => !!x))].sort();
}

export interface PlanHistory {
  /** The last decision (APPROVE / REJECT audit row), also for an archived plan. */
  decision: 'APPROVED' | 'REJECTED' | null;
  archivedById: string | null;
  archivedAt: string | null;
}

/** Decision and archive of plans, from the audit rows of the transitions (who and when). */
export async function planHistories(ids: ReadonlyArray<string>): Promise<Map<string, PlanHistory>> {
  const out = new Map<string, PlanHistory>();
  if (!ids.length) return out;
  const rows = await prisma.auditLog.findMany({
    where: {
      entityType: PLAN_ENTITY,
      entityId: { in: [...ids] },
      OR: [{ action: { in: ['APPROVE', 'REJECT'] } }, { action: 'UPDATE', details: { contains: '"transition":"ARCHIVE"' } }],
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { entityId: true, action: true, userId: true, createdAt: true },
  });
  for (const r of rows) {
    if (!r.entityId) continue;
    const h = out.get(r.entityId) ?? { decision: null, archivedById: null, archivedAt: null };
    if (r.action === 'APPROVE') h.decision = 'APPROVED';
    else if (r.action === 'REJECT') h.decision = 'REJECTED';
    else {
      h.archivedById = r.userId;
      h.archivedAt = r.createdAt.toISOString();
    }
    out.set(r.entityId, h);
  }
  return out;
}

export function assertAllowed(
  action: PlanAction,
  row: Pick<HeadcountPlan, 'status' | 'createdById'>,
  user: Pick<AuthUser, 'id' | 'role'>,
  submittedById: string | null = null,
  authorIds: ReadonlyArray<string> | null = null,
): PlanStatus {
  const d = decidePlanAction({ action, status: row.status, actorId: user.id, actorRole: user.role, createdById: row.createdById, submittedById, authorIds });
  if (!d.ok) throw new HttpError(d.httpStatus, d.message);
  return d.nextStatus;
}

/** Re-checks inside the transaction that the plan is still editable and bumps its version (updatedAt). */
export async function lockEditable(tx: Prisma.TransactionClient, planId: string): Promise<void> {
  const r = await tx.headcountPlan.updateMany({ where: { id: planId, status: { in: ['DRAFT', 'REJECTED'] } }, data: { updatedAt: new Date() } });
  if (r.count !== 1) throw conflict('الخطة لم تعد قابلة للتعديل (قُدِّمت أو اعتُمدت): أعد التحميل');
}

export interface PlanPermissions {
  edit: boolean;
  submit: boolean;
  approve: boolean;
  reject: boolean;
  archive: boolean;
  copy: boolean;
  /** Why approve / reject is refused for this user (maker-checker, role, status). */
  decideReason: string | null;
}

export function permissionsFor(
  row: Pick<HeadcountPlan, 'status' | 'createdById'>,
  user: Pick<AuthUser, 'id' | 'role'>,
  submittedById: string | null,
  authorIds: ReadonlyArray<string> | null = null,
): PlanPermissions {
  const d = (a: PlanAction) => decidePlanAction({ action: a, status: row.status, actorId: user.id, actorRole: user.role, createdById: row.createdById, submittedById, authorIds });
  const approve = d('APPROVE');
  return {
    edit: d('EDIT').ok,
    submit: d('SUBMIT').ok,
    approve: approve.ok,
    reject: d('REJECT').ok,
    archive: d('ARCHIVE').ok,
    copy: d('COPY').ok,
    decideReason: approve.ok || row.status !== 'SUBMITTED' ? null : approve.message,
  };
}

/** Names of users (id -> name or email). */
export async function userNames(ids: ReadonlyArray<string | null | undefined>): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((x): x is string => !!x))];
  if (!list.length) return new Map();
  const users = await prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true, email: true } });
  return new Map(users.map((u) => [u.id, u.name || u.email]));
}

export function planHeader(
  row: HeadcountPlan & { _count?: { positions: number; raises: number } },
  names: Map<string, string>,
  companyNames: Map<string, string>,
  history: PlanHistory | null = null,
) {
  // The decision (approve / reject) is decidedBy / decidedAt; archiving is a separate step with its own
  // audit row (who / when), never credited to the approver.
  const decision = history?.decision ?? (row.status === 'APPROVED' ? 'APPROVED' : row.status === 'REJECTED' ? 'REJECTED' : null);
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    statusLabel: PLAN_STATUS_LABELS[row.status as PlanStatus] ?? row.status,
    companyId: row.companyId,
    companyName: row.companyId ? (companyNames.get(row.companyId) ?? row.companyId) : null,
    fromMonth: planMonthKey(row.fromMonth),
    months: row.months,
    attritionPct: row.attritionPct,
    notes: row.notes,
    basedOnId: row.basedOnId,
    createdById: row.createdById,
    createdByName: row.createdById ? (names.get(row.createdById) ?? null) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
    decidedById: row.decidedById,
    decidedByName: row.decidedById ? (names.get(row.decidedById) ?? null) : null,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    decisionNote: row.decisionNote,
    /** Which decision decidedBy / decidedAt record (null = none or unknown). */
    decision: row.decidedAt ? decision : null,
    decisionLabel: row.decidedAt ? (decision === 'APPROVED' ? 'اعتمدها' : decision === 'REJECTED' ? 'رفضها' : 'قرّر فيها') : null,
    archivedById: history?.archivedById ?? null,
    archivedByName: history?.archivedById ? (names.get(history.archivedById) ?? null) : null,
    archivedAt: history?.archivedAt ?? null,
    positionsCount: row._count?.positions,
    raisesCount: row._count?.raises,
  };
}

/** Company names (the caller's companies only when `s` is given). */
export async function companyNameMap(s?: WfScope): Promise<Map<string, string>> {
  const rows = await prisma.company.findMany({ where: s ? companyScopeWhere(s) : undefined, select: { id: true, nameArabic: true } });
  return new Map(rows.map((c) => [c.id, c.nameArabic]));
}

// ---------------------------------------------------------------------------
// Validation against the data (existence, scope, horizon)
// ---------------------------------------------------------------------------

function inHorizon(row: Pick<HeadcountPlan, 'fromMonth' | 'months'>, key: string | null | undefined): boolean {
  if (!key) return true;
  const from = planMonthKey(row.fromMonth)!;
  const [fy, fm] = from.split('-').map(Number);
  const [y, m] = key.split('-').map(Number);
  const off = y * 12 + m - (fy * 12 + fm);
  return off >= 0 && off < row.months;
}

export interface PositionData {
  kind: string;
  title: string;
  companyId?: string | null;
  branchId?: string | null;
  departmentId?: string | null;
  nationalityClass?: string | null;
  gosiRegime?: string | null;
  gender?: string | null;
  occupationName?: string | null;
  basicSalary?: number | null;
  housingAllowance?: number | null;
  otherAllowances?: number | null;
  dependentsCount?: number | null;
  medicalClass?: string | null;
  startMonth?: string | null;
  exitEmployeeId?: string | null;
  exitMonth?: string | null;
  exitReason?: string | null;
  notes?: string | null;
}

/** Throws 400 / 404 / 409 (Arabic) when a position does not fit the plan and the data. */
export async function validatePosition(row: PlanRow, p: PositionData, selfId: string | null, s: WfScope): Promise<void> {
  const bad = (m: string) => new HttpError(400, m);
  // P1-SCOPE: every company / branch / department / employee named by the position is in the caller's scope (404).
  assertCompanyVisible(s, p.companyId);
  await assertBranchVisible(s, p.branchId);
  await assertDepartmentVisible(s, p.departmentId);
  if (p.exitEmployeeId) await assertEmployeeVisible(s, p.exitEmployeeId);
  if (row.companyId && p.companyId && p.companyId !== row.companyId) throw bad('شركة البند يجب أن تكون شركة الخطة');
  if (p.companyId && !(await prisma.company.findUnique({ where: { id: p.companyId }, select: { id: true } }))) throw notFound('الشركة غير موجودة');
  if (p.branchId && !(await prisma.branch.findUnique({ where: { id: p.branchId }, select: { id: true } }))) throw notFound('الفرع غير موجود');
  if (p.departmentId && !(await prisma.department.findUnique({ where: { id: p.departmentId }, select: { id: true } }))) throw notFound('الإدارة غير موجودة');
  if (p.kind === 'NEW_HIRE' && !inHorizon(row, p.startMonth)) throw bad('شهر البداية خارج فترة الخطة');
  if (p.kind === 'BACKFILL' && p.startMonth && !inHorizon(row, p.startMonth)) throw bad('شهر البداية خارج فترة الخطة');
  if (p.kind === 'EXIT' && !inHorizon(row, p.exitMonth)) throw bad('شهر الخروج خارج فترة الخطة');
  if (p.nationalityClass !== 'SAUDI' && p.gosiRegime) throw bad('نظام التأمينات للسعودي فقط');
  if (p.nationalityClass !== 'EXPAT' && p.dependentsCount) throw bad('المرافقون للوافد فقط');
  if (p.exitEmployeeId) {
    const e = await prisma.employee.findUnique({ where: { id: p.exitEmployeeId }, select: { id: true, legalCompanyId: true, isTerminated: true, terminationDate: true } });
    if (!e) throw notFound('الموظف غير موجود');
    if (row.companyId && e.legalCompanyId !== row.companyId) throw bad('الموظف ليس من شركة الخطة');
    if (e.isTerminated && e.terminationDate && e.terminationDate.getTime() < row.fromMonth.getTime()) throw bad('الموظف انتهت خدمته قبل بداية الخطة');
    if (p.kind === 'EXIT') {
      const dup = row.positions.find((x) => x.kind === 'EXIT' && x.exitEmployeeId === p.exitEmployeeId && x.id !== selfId);
      if (dup) throw conflict('للموظف خروج مخطط في هذه الخطة');
    }
  }
}

export interface RaiseData {
  scope: string;
  scopeId?: string | null;
  pct?: number | null;
  amount?: number | null;
  effectiveMonth: string;
}

export async function validateRaise(row: PlanRow, r: RaiseData, s: WfScope): Promise<void> {
  // P1-SCOPE: the company / department / employee the raise targets is in the caller's scope (404).
  if (r.scope === 'COMPANY') assertCompanyVisible(s, r.scopeId);
  else if (r.scope === 'DEPARTMENT') await assertDepartmentVisible(s, r.scopeId);
  else if (r.scope === 'EMPLOYEE' && r.scopeId) await assertEmployeeVisible(s, r.scopeId);
  if (!inHorizon(row, r.effectiveMonth)) throw new HttpError(400, 'شهر سريان الزيادة خارج فترة الخطة');
  if (r.scope === 'COMPANY') {
    if (row.companyId && r.scopeId !== row.companyId) throw new HttpError(400, 'الشركة يجب أن تكون شركة الخطة');
    if (!(await prisma.company.findUnique({ where: { id: r.scopeId! }, select: { id: true } }))) throw notFound('الشركة غير موجودة');
  } else if (r.scope === 'DEPARTMENT') {
    if (!(await prisma.department.findUnique({ where: { id: r.scopeId! }, select: { id: true } }))) throw notFound('الإدارة غير موجودة');
  } else if (r.scope === 'EMPLOYEE') {
    const e = await prisma.employee.findUnique({ where: { id: r.scopeId! }, select: { legalCompanyId: true } });
    if (!e) throw notFound('الموظف غير موجود');
    if (row.companyId && e.legalCompanyId !== row.companyId) throw new HttpError(400, 'الموظف ليس من شركة الخطة');
  }
}

/** Prisma data of a position (months stored as the first day of the month). */
export function positionColumns(p: PositionData) {
  return {
    kind: p.kind,
    title: p.title,
    companyId: p.companyId ?? null,
    branchId: p.branchId ?? null,
    departmentId: p.departmentId ?? null,
    nationalityClass: p.kind === 'EXIT' ? null : (p.nationalityClass ?? null),
    gosiRegime: p.kind === 'EXIT' ? null : (p.gosiRegime ?? null),
    gender: p.kind === 'EXIT' ? null : (p.gender ?? null),
    occupationName: p.occupationName ?? null,
    basicSalary: p.kind === 'EXIT' ? null : (p.basicSalary ?? null),
    housingAllowance: p.kind === 'EXIT' ? null : (p.housingAllowance ?? null),
    otherAllowances: p.kind === 'EXIT' ? null : (p.otherAllowances ?? null),
    dependentsCount: p.kind === 'EXIT' ? null : p.dependentsCount === null || p.dependentsCount === undefined ? null : Math.floor(p.dependentsCount),
    medicalClass: p.kind === 'EXIT' ? null : (p.medicalClass ?? null),
    startMonth: p.kind === 'EXIT' || !p.startMonth ? null : monthDate(p.startMonth),
    exitEmployeeId: p.kind === 'NEW_HIRE' ? null : (p.exitEmployeeId ?? null),
    exitMonth: p.kind === 'EXIT' && p.exitMonth ? monthDate(p.exitMonth) : null,
    exitReason: p.kind === 'EXIT' ? (p.exitReason ?? null) : null,
    notes: p.notes ?? null,
  };
}

/** A stored position as PositionData (to merge an update). */
export function positionData(p: PlannedPosition): PositionData {
  return {
    kind: p.kind,
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
  };
}

/** Plans compared / listed must exist; returns them in the requested order. */
export async function loadPlansOr404(ids: ReadonlyArray<string>, s: WfScope): Promise<PlanRow[]> {
  const rows = await prisma.headcountPlan.findMany({ where: { id: { in: [...ids] }, AND: [planScopeWhere(s)] }, include: PLAN_INCLUDE });
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => {
    const r = byId.get(id);
    if (!r) throw notFound('إحدى الخطط غير موجودة');
    return r;
  });
}

/** Max positions / raises per plan (bounded computation). */
export const MAX_POSITIONS = 500;
export const MAX_RAISES = 100;
