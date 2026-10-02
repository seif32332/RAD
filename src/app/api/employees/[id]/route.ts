import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ContractType, PaymentMethod, AccommodationType, type Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { salaryTransferConflict } from '@/lib/documents/queries';
import { requireUser, getClientIp } from '@/lib/auth';
import { managedEmployeesWhere } from '@/lib/hr-workflows';
import { ROLE_GROUPS, roleIn } from '@/lib/constants';
import { handleApiError, parseBody, notFound, conflict, badRequest, forbidden, definedOnly } from '@/lib/http';
import { zText, zOptText, zOptDate, zMoney, zOptMoney, zOptInt, zDate } from '@/lib/validation';
import { roundMoney } from '@/lib/money';
import { today, daysBetween, addDays, dateKey } from '@/lib/dates';
import { logAudit } from '@/lib/audit';
import { classifyEmployeeDocuments } from '@/lib/storage';
import {
  EMPLOYEE_BASIC_SELECT,
  EMPLOYEE_DETAIL_INCLUDE,
  REVIEW_STATE_SELECT,
  assertValidDirectManager,
  employeeAccessLevel,
  isUniqueViolationOn,
  redactForPayroll,
  reviewNoteAfterEdit,
  monthlyAllowanceRows,
  zOptGender,
  zOptNationality,
  employeeGosiFieldsSchema,
  employeeDataWarnings,
  gosiRegimeSourceError,
} from '@/lib/employee';
import { authz, resolveActor, scopeWhere, scopedContext, scopedPrisma } from '@/modules/iam';
import { resolveTeamContext } from '@/lib/employee-scope';
import { lifecycleCompanies, transitionEmploymentState } from '@/modules/lifecycle';
import { projectExitReason } from '@/modules/offboarding';
import { resolveWorkPatternId } from '@/modules/calendar';
import { requestFinancialChange, type FinancialChangeView, type RequestedAllowance } from '@/modules/compensation';
import { assertNoFinalizedPayrollFrom, setEmployeeGosiDeduction } from '@/modules/payroll';
import { moneyActorOf } from '@/modules/platform';
import {
  defaultExitVoluntary,
  employeeExitFieldsSchema,
  employeeWorkforceFieldsSchema,
  redactWorkforceForPayroll,
  resolveWorkforceFields,
  zAllowanceType,
  zExitReason,
  zExitVoluntary,
} from '../_workforce-fields';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

// GET - single employee. Same access levels as GET /api/employees (see employeeAccessLevel):
// HR full record, payroll/finance without identity documents, managers only their team (basic).
// P1-SCOPE: an employee of a company outside the user's scope is "not found" (404); a manager gets
// 403 for an employee of his companies who is not in his team.
export async function GET(_req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(ROLE_GROUPS.STAFF);
    const { id } = await params;
    const level = employeeAccessLevel(user.role);
    const actor = await resolveActor(prisma, user);
    const staff = scopedContext(actor);

    if (level === 'full' || level === 'payroll') {
      authz.assert(staff, 'employee.read');
      const employee = await scopedPrisma(staff).employee.findUnique({ where: { id }, include: EMPLOYEE_DETAIL_INCLUDE });
      if (!employee) throw notFound('الموظف غير موجود');
      // Payroll / finance: no identity documents and no disability data (redactWorkforceForPayroll).
      return NextResponse.json(level === 'payroll' ? redactWorkforceForPayroll(redactForPayroll(employee)) : employee);
    }

    const ctx = level === 'team' ? await resolveTeamContext(prisma, actor) : staff;
    authz.assert(ctx, 'employee.read');
    const scope = level === 'team' ? await managedEmployeesWhere(prisma, user) : null;
    const employee = await scopedPrisma(ctx).employee.findFirst({ where: scope ? { AND: [{ id }, scope] } : { id }, select: EMPLOYEE_BASIC_SELECT });
    if (!employee) {
      if (scope && (await prisma.employee.findFirst({ where: { id, AND: [scopeWhere(staff, 'Employee') ?? {}] }, select: { id: true } }))) {
        throw forbidden('هذا الموظف ليس ضمن نطاق إدارتك');
      }
      throw notFound('الموظف غير موجود');
    }
    return NextResponse.json(employee);
  } catch (err) {
    return handleApiError(err, 'employees/[id]:GET');
  }
}

// ---------------------------------------------------------------------------
// PUT - update employee (partial-safe: only provided fields are written)
// ---------------------------------------------------------------------------

/** '' / null -> undefined: the field is left untouched (for required DB columns). */
const keepIfEmpty = <S extends z.ZodTypeAny>(s: S) =>
  z.preprocess((v) => (v === '' || v === null ? undefined : v), s.optional());

const optNullableId = z.preprocess((v) => (v === '' ? null : v), z.string().trim().max(100).nullable()).optional();
const optNullableEnum = <T extends Record<string, string>>(e: T) =>
  z.preprocess((v) => (v === '' ? null : v), z.nativeEnum(e).nullable()).optional();
const optEmail = z
  .preprocess((v) => (v === '' ? null : v), z.string().trim().toLowerCase().email('بريد إلكتروني غير صالح').max(200).nullable())
  .optional();
const optIban = z
  .preprocess((v) => (typeof v === 'string' ? v.replace(/\s+/g, '').toUpperCase() || null : v), z.string().max(34).nullable())
  .optional();

const updateEmployeeSchema = z.object({
  firstNameArabic: keepIfEmpty(zText(100)),
  lastNameArabic: z.preprocess((v) => (v === null ? '' : v), z.string().trim().max(200).optional()),
  firstNameEnglish: zOptText(100),
  lastNameEnglish: zOptText(200),
  nationality: zOptNationality,
  dateOfBirth: keepIfEmpty(zDate),
  maritalStatus: zOptText(50),
  gender: zOptGender,
  mobileNumber: zOptText(30),
  email: optEmail,
  iqamaOrIdNumber: keepIfEmpty(zText(50)),
  iqamaOrIdExp: keepIfEmpty(zDate),
  passportNumber: zOptText(50),
  passportExp: zOptDate,
  healthCertificateNum: zOptText(100),
  healthCertificateExp: zOptDate,
  joinDate: keepIfEmpty(zDate),
  contractType: keepIfEmpty(z.nativeEnum(ContractType)),
  contractEndDate: zOptDate,
  probationEndDate: zOptDate,
  noticePeriodDays: zOptInt.refine((v) => v === undefined || (v >= 0 && v <= 3650), 'فترة الإشعار غير صالحة'),
  leaveAccrualStartDate: zOptDate,
  basicSalary: zOptMoney,
  /** P1-PAY-B: first day a changed salary / allowances is in force (default: today). */
  payEffectiveDate: zOptDate,
  gosiDeduction: zOptMoney,
  salaryPaymentMethod: keepIfEmpty(z.nativeEnum(PaymentMethod)),
  ibanNumber: optIban,
  bankName: zOptText(200),
  legalCompanyId: optNullableId,
  actualCompanyId: optNullableId,
  administrationId: optNullableId,
  branchId: optNullableId,
  departmentId: optNullableId,
  jobTitle: zOptText(200),
  jobTitleEnglish: zOptText(200),
  directManagerId: optNullableId,
  workSchedule: zOptText(200),
  accommodationType: optNullableEnum(AccommodationType),
  // The edit form uses these names for the document URLs.
  contractDocUrl: zOptText(2000),
  idDocUrl: zOptText(2000),
  healthCertDocUrl: zOptText(2000),
  passportDocUrl: zOptText(2000),
  /** '' / null clears the "incomplete data" warning; missing -> resolved automatically from the edited fields. */
  dataReviewNote: z
    .preprocess((v) => (typeof v === 'string' ? v.trim() || null : v), z.string().max(2000).nullable())
    .optional(),
  allowances: z
    .array(
      z.object({
        id: z.string().optional().nullable(),
        name: z.string().trim().max(200),
        amount: zMoney,
        countsTowardGosi: z.boolean().optional().nullable(),
        /** HOUSING / TRANSPORT / FOOD / OTHER; null = inferred from the name. */
        allowanceType: zAllowanceType,
      }),
    )
    .max(50)
    .optional(),
})
  .merge(employeeGosiFieldsSchema)
  // Workforce decision engine data; exitReason / exitVoluntary only for a terminated employee.
  .merge(employeeWorkforceFieldsSchema)
  .merge(employeeExitFieldsSchema);

/** Stored values the workforce-field rules depend on (see resolveWorkforceFields). */
const WORKFORCE_STATE_SELECT = {
  contractType: true,
  isTerminated: true,
  isDisabled: true,
  muawamaCertExpiry: true,
  partTimeWeeklyHours: true,
  qiwaContractDocumented: true,
  qiwaContractDocumentedAt: true,
  exitReason: true,
  exitVoluntary: true,
} as const;

/**
 * Company scope of a write on one employee (DOMAIN_BOUNDARIES §5.4.3, legal company): 404 when the
 * employee does not exist, 403 when it belongs to a company outside the actor's scope or the action
 * is not the actor's (iam authz). `moveTo`: the legal / actual company the write gives the employee,
 * which must also be inside the scope (P1-SCOPE).
 */
async function assertEmployeeWrite(
  user: Awaited<ReturnType<typeof requireUser>>,
  id: string,
  action: 'employee.update' | 'employment.exit',
  moveTo: ReadonlyArray<string | null | undefined> = [],
) {
  const target = await prisma.employee.findUnique({ where: { id }, select: { legalCompanyId: true } });
  if (!target) throw notFound('الموظف غير موجود');
  const ctx = scopedContext(await resolveActor(prisma, user));
  authz.assert(ctx, action, { companyId: target.legalCompanyId });
  for (const companyId of moveTo) if (companyId !== undefined) authz.assert(ctx, action, { companyId });
  return ctx;
}

/** The same recurring allowances (as a multiset of name, amount, GOSI flag, type): an echo, not a change. */
function sameAllowances(a: readonly RequestedAllowance[], b: readonly RequestedAllowance[]): boolean {
  const key = (x: RequestedAllowance) => JSON.stringify([x.name, roundMoney(x.amount), !!x.countsTowardGosi, x.allowanceType ?? null]);
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.length === right.length && left.every((k, i) => k === right[i]);
}

export async function PUT(req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(ROLE_GROUPS.HR);
    const { id } = await params;
    const b = await parseBody(req, updateEmployeeSchema);
    await assertEmployeeWrite(user, id, 'employee.update', [b.legalCompanyId, b.actualCompanyId]);

    const existing = await prisma.employee.findUnique({
      where: { id },
      select: {
        ...REVIEW_STATE_SELECT,
        ...WORKFORCE_STATE_SELECT,
        gosiRegime: true,
        gosiRegistrationSource: true,
        idType: true,
        probationEndDate: true,
        joinDate: true,
        contractEndDate: true,
        branchId: true,
        workSchedule: true,
        legalCompanyId: true,
        // Pay columns (money.gateway): only CHANGED values are written, through compensation / payroll.
        basicSalary: true,
        gosiDeduction: true,
        salaryPaymentMethod: true,
        ibanNumber: true,
        bankName: true,
        allowances: { where: { isMonthly: true }, select: { name: true, amount: true, countsTowardGosi: true, allowanceType: true } },
      },
    });
    if (!existing) throw notFound('الموظف غير موجود');
    // Workforce fields: part-time hours only for PART_TIME, Muawama only when disabled, Qiwa date
    // auto-set when documented, exit reason only once terminated (Arabic errors, nothing written).
    // The exit reason is not edited here any more (BL-LCY-003, BR-LCY-006): it is recorded with the
    // exit and corrected by a D1 (two people). The stored values echoed back by the form are ignored.
    if (
      (b.exitReason !== undefined && (b.exitReason ?? null) !== existing.exitReason) ||
      (b.exitVoluntary !== undefined && (b.exitVoluntary ?? null) !== existing.exitVoluntary)
    ) {
      throw conflict('سبب الخروج يُسجَّل مع إنهاء الخدمة، وتصحيحه طلب تصحيح بشخصين (لا يُعدَّل من ملف الموظف)', { code: 'EXIT_FIELDS_READ_ONLY' });
    }
    const workforce = resolveWorkforceFields({ ...b, exitReason: undefined, exitVoluntary: undefined }, existing, b.contractType ?? existing.contractType);
    if (workforce.errors.length) throw badRequest(workforce.errors.join(' — '));
    // Same date gates as creation: no future birth date, no contract ending before the join date.
    const todayDate = today();
    if (b.dateOfBirth && b.dateOfBirth > todayDate) throw badRequest('تاريخ الميلاد لا يمكن أن يكون في المستقبل');
    const effectiveJoin = b.joinDate ?? existing.joinDate;
    const effectiveContractEnd = b.contractEndDate !== undefined ? b.contractEndDate : existing.contractEndDate;
    // Only checked when this edit touches one of the two dates, so legacy rows with bad stored
    // dates can still receive unrelated edits (the import reports them as warnings).
    const touchesContractDates = b.joinDate !== undefined || b.contractEndDate !== undefined;
    if (touchesContractDates && effectiveJoin && effectiveContractEnd && effectiveContractEnd < effectiveJoin) {
      throw badRequest('تاريخ نهاية العقد لا يمكن أن يسبق تاريخ المباشرة');
    }
    // A newly confirmed OLD / NEW regime needs its source (kept when the regime does not change).
    if (b.gosiRegime !== undefined && b.gosiRegime !== existing.gosiRegime) {
      const sourceError = gosiRegimeSourceError(b.gosiRegime, b.gosiRegistrationSource, existing.gosiRegistrationSource);
      if (sourceError) throw badRequest(sourceError);
    }

    // Incomplete-data warning: an explicit value wins; otherwise the fields the note lists that
    // this edit completed (new non-empty value different from the stored one) are removed from it.
    const dataReviewNote = b.dataReviewNote !== undefined ? b.dataReviewNote : reviewNoteAfterEdit(existing, b);

    if (b.directManagerId !== undefined) await assertValidDirectManager(prisma, id, b.directManagerId);
    // P1-CAL: the work pattern is stored as a FK; the form still sends its name within the branch.
    const workPatternId =
      b.branchId !== undefined || b.workSchedule !== undefined
        ? await resolveWorkPatternId(prisma, b.branchId !== undefined ? b.branchId : existing.branchId, b.workSchedule !== undefined ? b.workSchedule : existing.workSchedule)
        : undefined;

    const data: Prisma.EmployeeUncheckedUpdateInput = definedOnly({
      firstNameArabic: b.firstNameArabic,
      lastNameArabic: b.lastNameArabic,
      firstNameEnglish: b.firstNameEnglish,
      lastNameEnglish: b.lastNameEnglish,
      nationality: b.nationality,
      dateOfBirth: b.dateOfBirth,
      maritalStatus: b.maritalStatus,
      gender: b.gender,
      mobileNumber: b.mobileNumber,
      email: b.email,
      iqamaOrIdNumber: b.iqamaOrIdNumber,
      iqamaOrIdExp: b.iqamaOrIdExp,
      passportNumber: b.passportNumber,
      passportExp: b.passportExp,
      healthCertificateNum: b.healthCertificateNum,
      healthCertificateExp: b.healthCertificateExp,
      joinDate: b.joinDate,
      contractType: b.contractType,
      contractEndDate: b.contractEndDate,
      probationEndDate: b.probationEndDate,
      noticePeriodDays: b.noticePeriodDays,
      leaveAccrualStartDate: b.leaveAccrualStartDate ?? undefined,
      legalCompanyId: b.legalCompanyId,
      actualCompanyId: b.actualCompanyId,
      administrationId: b.administrationId,
      branchId: b.branchId,
      departmentId: b.departmentId,
      jobTitle: b.jobTitle,
      jobTitleEnglish: b.jobTitleEnglish,
      directManagerId: b.directManagerId,
      workSchedule: b.workSchedule,
      workPatternId,
      accommodationType: b.accommodationType,
      workContractUrl: b.contractDocUrl,
      iqamaCopyUrl: b.idDocUrl,
      healthCertificateUrl: b.healthCertDocUrl,
      passportCopyUrl: b.passportDocUrl,
      gosiRegime: b.gosiRegime,
      gosiRegistrationSource: b.gosiRegistrationSource,
      gosiNumber: b.gosiNumber,
      idType: b.idType,
      dataReviewNote,
      ...workforce.data,
    });

    // Pay (P1-PAY-B, BR-PAY-009): the form echoes every value back; a CHANGED salary / allowances or bank
    // identity becomes an EmployeeFinancialChange REQUEST (nothing changes until a second person decides;
    // the requester may be the employee himself, DEC-PO-006). An IBAN that replaces the one on file is the
    // employee's own portal request (IbanSelfServiceOnlyError). gosiDeduction stays payroll's operation.
    const basicChanged = b.basicSalary !== undefined && roundMoney(b.basicSalary) !== existing.basicSalary;
    const bankChanged =
      (b.salaryPaymentMethod !== undefined && b.salaryPaymentMethod !== existing.salaryPaymentMethod) ||
      (b.ibanNumber !== undefined && (b.ibanNumber ?? null) !== existing.ibanNumber) ||
      (b.bankName !== undefined && (b.bankName ?? null) !== existing.bankName);
    const payEffective = (b.payEffectiveDate ?? todayDate).toISOString().slice(0, 10);
    const gosiDeduction = b.gosiDeduction !== undefined && roundMoney(b.gosiDeduction) !== existing.gosiDeduction ? roundMoney(b.gosiDeduction) : undefined;
    const idem = req.headers.get('idempotency-key')?.trim();
    const payKey = `employee.pay:${id}:${user.id}:${idem ? `k:${idem.slice(0, 100)}` : Date.now()}`;

    let updated;
    let financialChanges: FinancialChangeView[] = [];
    try {
      updated = await prisma.$transaction(async (tx) => {
        await tx.employee.update({ where: { id }, data });
        await classifyEmployeeDocuments(tx, id, {
          workContractUrl: data.workContractUrl as string | null | undefined,
          iqamaCopyUrl: data.iqamaCopyUrl as string | null | undefined,
          healthCertificateUrl: data.healthCertificateUrl as string | null | undefined,
          passportCopyUrl: data.passportCopyUrl as string | null | undefined,
        });

        let allowances: RequestedAllowance[] | undefined;
        if (b.allowances) {
          // Only recurring allowances are replaced; one-off bonuses (isMonthly=false) are kept,
          // including when the form echoes them back.
          const oneOff = await tx.allowance.findMany({ where: { employeeId: id, isMonthly: false }, select: { id: true } });
          // Row by row so each kept row keeps its own allowanceType (monthlyAllowanceRows drops it).
          const oneOffIds = oneOff.map((a) => a.id);
          const toCreate = b.allowances.flatMap((a) =>
            monthlyAllowanceRows([a], oneOffIds).map((row) => ({ ...row, allowanceType: a.allowanceType ?? null })),
          );
          const next: RequestedAllowance[] = toCreate.map((a) => ({ name: a.name, amount: roundMoney(a.amount), countsTowardGosi: a.countsTowardGosi, allowanceType: a.allowanceType }));
          allowances = sameAllowances(existing.allowances, next) ? undefined : next;
        }
        const actor = moneyActorOf(user);
        if (basicChanged || allowances || bankChanged) {
          if (basicChanged || allowances) await assertNoFinalizedPayrollFrom(tx, id, payEffective);
          const filed = await requestFinancialChange(tx, {
            actor,
            employeeId: id,
            source: 'EDIT',
            effectiveDate: payEffective,
            compensation:
              basicChanged || allowances
                ? { basicSalary: roundMoney(b.basicSalary ?? existing.basicSalary), allowances: allowances ?? existing.allowances }
                : null,
            bank: bankChanged
              ? {
                  iban: b.ibanNumber !== undefined ? (b.ibanNumber ?? null) : existing.ibanNumber,
                  bankName: b.bankName !== undefined ? (b.bankName ?? null) : existing.bankName,
                  paymentMethod: b.salaryPaymentMethod ?? existing.salaryPaymentMethod,
                }
              : null,
            operationKey: payKey,
            ipAddress: getClientIp(req),
          });
          financialChanges = filed.changes;
        }
        if (gosiDeduction !== undefined) {
          await setEmployeeGosiDeduction(tx, { actor, employeeId: id, gosiDeduction, before: existing.gosiDeduction, companyId: existing.legalCompanyId, operationKey: `${payKey}:gosi`, ipAddress: getClientIp(req) });
        }
        return tx.employee.findUniqueOrThrow({ where: { id } });
      });
    } catch (err) {
      if (isUniqueViolationOn(err, 'iqamaOrIdNumber')) throw conflict('رقم الهوية أو الإقامة مسجل مسبقاً لموظف آخر!');
      throw err;
    }

    await logAudit({
      userId: user.id,
      action: 'UPDATE',
      entityType: 'Employee',
      entityId: id,
      details: {
        fields: Object.keys(data),
        allowancesReplaced: !!b.allowances,
        ...(dataReviewNote !== undefined ? { dataReviewNote: dataReviewNote === null ? 'cleared' : dataReviewNote } : {}),
      },
      ipAddress: getClientIp(req),
    });

    // Data-quality warnings on the saved values (never block the save).
    const probationDays = updated.probationEndDate ? daysBetween(updated.joinDate, updated.probationEndDate) : null;
    const warnings = employeeDataWarnings({
      ibanNumber: updated.ibanNumber,
      iqamaOrIdNumber: updated.iqamaOrIdNumber,
      idType: updated.idType,
      nationality: updated.nationality,
      probationDays,
      basicSalary: updated.basicSalary,
    });

    // A valid salary transfer letter commits the company to a bank (warning only, owner decision).
    const commitment = await salaryTransferConflict(updated.id, updated.ibanNumber, updated.bankName ?? null);
    if (commitment) warnings.push({ field: 'ibanNumber', message: commitment });

    return NextResponse.json({
      message: financialChanges.length ? 'تم تحديث بيانات الموظف. تغيير الراتب أو بيانات الصرف بانتظار اعتماد شخص ثانٍ' : 'تم تحديث بيانات الموظف بنجاح',
      employee: updated,
      financialChanges,
      warnings,
    });
  } catch (err) {
    return handleApiError(err, 'employees/[id]:PUT');
  }
}

// ---------------------------------------------------------------------------
// PATCH - terminate employee OR update document URLs
// ---------------------------------------------------------------------------

const DOC_FIELDS = ['workContractUrl', 'iqamaCopyUrl', 'healthCertificateUrl', 'passportCopyUrl', 'ibanCertificateUrl', 'resumeUrl'] as const;

/** Leave types during which the employer may not end the contract (DOM-004: maternity / sick leave). */
const PROTECTED_LEAVE_TYPES = ['MATERNITY', 'SICK'] as const;
/** Roles that may terminate despite a protected leave, with a written reason kept in the audit log. */
const PROTECTED_LEAVE_OVERRIDE_ROLES: readonly string[] = ['SUPER_ADMIN', 'LEGAL_ADMIN'];
/** Direct termination (without the settlement wizard): HR, plus the legal department. */
const TERMINATE_ROLES = [...new Set([...ROLE_GROUPS.HR, 'LEGAL_ADMIN' as const])];

export interface ProtectedLeaveLike {
  id: string;
  leaveType: string;
  status: string;
  startDate: Date;
  endDate: Date;
  isReturned: boolean;
  actualReturnDate: Date | null;
}

/**
 * The approved maternity / sick leave in effect on one of the given days (the termination date
 * and today), or null. A leave the employee already returned from no longer protects.
 */
export function activeProtectedLeave<T extends ProtectedLeaveLike>(leaves: readonly T[], days: readonly Date[]): T | null {
  const keys = days.map((d) => dateKey(d)).filter((k): k is string => !!k);
  for (const l of leaves) {
    if (!(PROTECTED_LEAVE_TYPES as readonly string[]).includes(l.leaveType) || l.status !== 'APPROVED') continue;
    const start = dateKey(l.startDate);
    const endDate = l.isReturned && l.actualReturnDate && l.actualReturnDate < l.endDate ? addDays(l.actualReturnDate, -1) : l.endDate;
    const end = dateKey(endDate);
    if (!start || !end) continue;
    if (keys.some((k) => k >= start && k <= end)) return l;
  }
  return null;
}

const patchSchema = z.object({
  action: z.enum(['terminate']).optional(),
  terminationDate: zOptDate,
  /** Required with action=terminate: the written reason (kept in the audit log). */
  reason: zOptText(1000),
  /** action=terminate: structured exit reason (Employee.exitReason, fixed list) and whether the exit is voluntary. */
  exitReason: zExitReason,
  /** Missing -> defaultExitVoluntary(exitReason) (null when the reason is ambiguous). */
  exitVoluntary: zExitVoluntary,
  /** SUPER_ADMIN / LEGAL_ADMIN only: terminate despite an approved maternity / sick leave in effect. */
  overrideProtectedLeave: z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean().optional()),
  workContractUrl: zOptText(2000),
  iqamaCopyUrl: zOptText(2000),
  healthCertificateUrl: zOptText(2000),
  passportCopyUrl: zOptText(2000),
  ibanCertificateUrl: zOptText(2000),
  resumeUrl: zOptText(2000),
});

export async function PATCH(req: Request, { params }: Ctx) {
  try {
    const user = await requireUser(TERMINATE_ROLES);
    const { id } = await params;
    const b = await parseBody(req, patchSchema);
    const ip = getClientIp(req);
    const scope = await assertEmployeeWrite(user, id, b.action === 'terminate' ? 'employment.exit' : 'employee.update');

    if (b.action === 'terminate') {
      const reason = b.reason?.trim() ?? '';
      if (reason.length < 3) throw badRequest('سبب إنهاء الخدمات مطلوب (نص مكتوب يُحفظ في سجل التدقيق)');
      const terminationDate = b.terminationDate ?? today();
      const canOverride = PROTECTED_LEAVE_OVERRIDE_ROLES.includes(user.role);
      const exitReason = b.exitReason ?? null;
      if (!exitReason && b.exitVoluntary !== undefined && b.exitVoluntary !== null) {
        throw badRequest('حدد سبب الخروج قبل تحديد هل الخروج طوعي');
      }
      const exitVoluntary = b.exitVoluntary !== undefined && b.exitVoluntary !== null ? b.exitVoluntary : defaultExitVoluntary(exitReason);
      if (b.overrideProtectedLeave === true && !canOverride) {
        throw forbidden('تجاوز حماية إجازة الوضع أو الإجازة المرضية متاح لمدير النظام أو الإدارة القانونية فقط');
      }
      // The exit goes through lifecycle.transitionEmploymentState (the sole writer, BR-LCY-006): T3 for a
      // last working day up to today (the login stops now, with the terminated_access_days grace), T1
      // for a later one once NOTICE is released (ADR-0004), nothing for a repeat with the same date,
      // refused (the way is a D1 correction) for another date. The protected-leave guard (DOM-004)
      // stays here: lifecycle sits below leave and cannot read it (DOMAIN_BOUNDARIES §5.3).
      const key = req.headers.get('idempotency-key')?.trim();
      const operationKey = `employee.terminate:${id}:${key ? `k:${key.slice(0, 100)}` : `${user.id}:${dateKey(terminationDate)}`}`;
      const { terminated, access, result } = await prisma.$transaction(async (tx) => {
        // DOM-004: no termination during an approved maternity / sick leave in effect, except by
        // SUPER_ADMIN / LEGAL_ADMIN with an explicit override (the reason is audited).
        const leaves = await tx.leave.findMany({
          where: { employeeId: id, status: 'APPROVED', leaveType: { in: [...PROTECTED_LEAVE_TYPES] } },
          select: { id: true, leaveType: true, status: true, startDate: true, endDate: true, isReturned: true, actualReturnDate: true },
        });
        const protectedLeave = activeProtectedLeave(leaves, [terminationDate, today()]);
        if (protectedLeave && !(canOverride && b.overrideProtectedLeave === true)) {
          const kind = protectedLeave.leaveType === 'MATERNITY' ? 'إجازة وضع' : 'إجازة مرضية';
          throw conflict(
            `لا يمكن إنهاء خدمات الموظف أثناء ${kind} سارية (من ${dateKey(protectedLeave.startDate)} إلى ${dateKey(protectedLeave.endDate)}).` +
              (canOverride
                ? ' يمكنك التجاوز بتأكيد صريح، ويُسجَّل السبب في سجل التدقيق.'
                : ' التجاوز متاح لمدير النظام أو الإدارة القانونية فقط، مع سبب مكتوب.'),
            { code: 'PROTECTED_LEAVE', leaveId: protectedLeave.id, leaveType: protectedLeave.leaveType, canOverride },
          );
        }
        const result = await transitionEmploymentState(tx, {
          employeeId: id,
          command: 'EXIT',
          date: terminationDate,
          exitReason,
          exitVoluntary,
          reason,
          source: { type: 'EMPLOYEE_FILE', id },
          actor: { type: 'USER', id: user.id },
          operationKey,
          companyIds: lifecycleCompanies(scope),
          access: { ipAddress: ip },
        });
        if (!result.changed) throw conflict('تم إنهاء خدمات هذا الموظف مسبقاً');
        // The exit-reason projection (offboarding) in the same transaction; its event consumer converges too.
        await projectExitReason(tx, id, { key: `${operationKey}:exitReason`, actor: { type: 'USER', id: user.id } });
        const access = result.access ?? { hasUser: false, deactivated: false, graceDays: 0 };
        if (!result.replayed) {
          await logAudit(
            {
              userId: user.id,
              action: 'UPDATE',
              entityType: 'Employee',
              entityId: id,
              details: {
                action: 'terminate',
                transition: result.transition,
                stateChangeId: result.stateChangeId,
                terminationDate: dateKey(terminationDate),
                reason,
                exitReason,
                exitVoluntary,
                ...(protectedLeave
                  ? { protectedLeaveOverride: true, protectedLeaveId: protectedLeave.id, protectedLeaveType: protectedLeave.leaveType, overriddenByRole: user.role }
                  : {}),
                accountDeactivated: access.deactivated,
                graceDays: access.graceDays,
              },
              ipAddress: ip,
            },
            tx,
          );
        }
        const terminated = await tx.employee.findUnique({ where: { id } });
        return { terminated, access, result };
      }, { timeout: 20_000, maxWait: 10_000 });
      const accessNote = !access.hasUser
        ? ''
        : access.deactivated
          ? ' وتم إيقاف حساب الدخول المرتبط به'
          : access.graceDays > 0
            ? ` ويبقى حساب الدخول فعالاً ${access.graceDays} يوماً حسب الإعدادات`
            : '';
      return NextResponse.json({
        message: `تم إنهاء خدمات الموظف${accessNote}`,
        employee: terminated,
        access,
        employment: { transition: result.transition, state: result.toState, stateChangeId: result.stateChangeId, replayed: result.replayed },
      });
    }

    // Document updates stay HR-only (the legal department may only use action=terminate).
    if (!roleIn(user.role, ROLE_GROUPS.HR)) throw forbidden();
    const docData: Partial<Record<(typeof DOC_FIELDS)[number], string | null>> = {};
    for (const field of DOC_FIELDS) {
      const v = b[field];
      if (v !== undefined) docData[field] = v;
    }
    if (Object.keys(docData).length === 0) throw badRequest('إجراء غير معروف');

    const updated = await prisma.$transaction(async (tx) => {
      const emp = await tx.employee.update({ where: { id }, data: docData });
      await classifyEmployeeDocuments(tx, id, docData);
      return emp;
    });
    await logAudit({
      userId: user.id,
      action: 'UPDATE',
      entityType: 'Employee',
      entityId: id,
      details: { documents: Object.keys(docData) },
      ipAddress: ip,
    });
    return NextResponse.json({ message: 'تم تحديث الوثائق بنجاح', employee: updated });
  } catch (err) {
    return handleApiError(err, 'employees/[id]:PATCH');
  }
}
