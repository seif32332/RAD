import { NextResponse } from 'next/server';
import { z } from 'zod';
import { ContractType, PaymentMethod, AccommodationType, Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { requireUser, getClientIp } from '@/lib/auth';
import { managedEmployeesWhere } from '@/lib/hr-workflows';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, parseBody, parseQuery, conflict, badRequest } from '@/lib/http';
import { zText, zOptText, zDate, zOptDate, zMoney, zOptMoney, zOptInt, zPagination } from '@/lib/validation';
import { roundMoney } from '@/lib/money';
import { logAudit } from '@/lib/audit';
import { classifyEmployeeDocuments } from '@/lib/storage';
import {
  EMPLOYEE_BASIC_SELECT,
  EMPLOYEE_LIST_FULL_INCLUDE,
  assertValidDirectManager,
  createWithEmployeeCode,
  employeeAccessLevel,
  isUniqueViolationOn,
  redactForPayroll,
  zRequiredGender,
  zRequiredNationality,
  employeeGosiFieldsSchema,
  employeeDataWarnings,
  gosiRegimeSourceError,
  defaultCountsTowardGosi,
  employeeDateIssues,
  hijriLikeDateError,
  orgPlacementErrors,
} from '@/lib/employee';
import { daysBetween } from '@/lib/dates';
import { employeeWorkforceFieldsSchema, redactWorkforceForPayroll, resolveWorkforceFields, zAllowanceType } from './_workforce-fields';

export const dynamic = 'force-dynamic';

const nullableEnum = <T extends Record<string, string>>(e: T) =>
  z.preprocess((v) => (v === '' || v === undefined ? null : v), z.nativeEnum(e).nullable()).optional();
const enumWithDefault = <T extends Record<string, string>>(e: T, def: T[keyof T]) =>
  z.preprocess((v) => (v === '' || v === null || v === undefined ? def : v), z.nativeEnum(e));
const optId = z.preprocess((v) => (v === '' || v === undefined ? null : v), z.string().trim().max(100).nullable()).optional();
const optEmail = z
  .preprocess((v) => (v === '' || v === undefined ? null : v), z.string().trim().toLowerCase().email('بريد إلكتروني غير صالح').max(200).nullable())
  .optional();
const optIban = z
  .preprocess(
    (v) => (typeof v === 'string' ? (v.replace(/\s+/g, '').toUpperCase() || null) : v === undefined ? null : v),
    z.string().max(34).nullable(),
  )
  .optional();

const allowanceSchema = z.object({
  id: z.string().optional().nullable(),
  name: z.string().trim().max(200),
  amount: zMoney,
  countsTowardGosi: z.boolean().optional().nullable(),
  /** HOUSING / TRANSPORT / FOOD / OTHER; null = inferred from the name. */
  allowanceType: zAllowanceType,
});

const createEmployeeSchema = z.object({
  firstNameArabic: zText(100),
  lastNameArabic: zOptText(200),
  firstNameEnglish: zOptText(100),
  lastNameEnglish: zOptText(200),
  dateOfBirth: zDate,
  nationality: zRequiredNationality,
  gender: zRequiredGender,
  maritalStatus: zOptText(50),
  iqamaOrIdNumber: zText(50),
  iqamaOrIdExp: zDate,
  passportNumber: zOptText(50),
  passportExp: zOptDate,
  healthCertificateNum: zOptText(100),
  healthCertificateExp: zOptDate,
  joinDate: zDate,
  contractType: enumWithDefault(ContractType, ContractType.FULL_TIME),
  contractEndDate: zOptDate,
  probationEndDate: zOptDate,
  noticePeriodDays: zOptInt.refine((v) => v === undefined || (v >= 0 && v <= 3650), 'فترة الإشعار غير صالحة'),
  leaveAccrualStartDate: zOptDate,
  basicSalary: zMoney,
  gosiDeduction: zOptMoney,
  salaryPaymentMethod: enumWithDefault(PaymentMethod, PaymentMethod.BANK_TRANSFER),
  mobileNumber: zOptText(30),
  email: optEmail,
  ibanNumber: optIban,
  bankName: zOptText(200),
  legalCompanyId: optId,
  actualCompanyId: optId,
  administrationId: optId,
  branchId: optId,
  departmentId: optId,
  jobTitle: zOptText(200),
  directManagerId: optId,
  workSchedule: zOptText(200),
  accommodationType: nullableEnum(AccommodationType),
  contractDocUrl: zOptText(2000),
  idDocUrl: zOptText(2000),
  healthCertDocUrl: zOptText(2000),
  passportDocUrl: zOptText(2000),
  allowances: z.array(allowanceSchema).max(50).optional(),
})
  .merge(employeeGosiFieldsSchema)
  // Workforce decision engine data (occupation, dependents, Nitaqat flags, Qiwa, medical class).
  .merge(employeeWorkforceFieldsSchema);

export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.HR);
    const b = await parseBody(req, createEmployeeSchema);

    await assertValidDirectManager(prisma, null, b.directManagerId);
    const sourceError = gosiRegimeSourceError(b.gosiRegime, b.gosiRegistrationSource);
    if (sourceError) throw badRequest(sourceError);

    // Data-quality gates (council DATA-10 / WP-3): impossible dates and an inconsistent org placement
    // are rejected; a far-future join date or an under-age birth date is only a warning.
    const dateErrors: string[] = [];
    const DATE_LABELS: ReadonlyArray<readonly [Date | null | undefined, string]> = [
      [b.dateOfBirth, 'تاريخ الميلاد'],
      [b.joinDate, 'تاريخ مباشرة العمل'],
      [b.iqamaOrIdExp, 'تاريخ انتهاء الهوية / الإقامة'],
      [b.contractEndDate, 'تاريخ انتهاء العقد'],
      [b.leaveAccrualStartDate, 'تاريخ احتساب الإجازة'],
      [b.passportExp, 'تاريخ انتهاء الجواز'],
      [b.healthCertificateExp, 'تاريخ انتهاء الشهادة الصحية'],
    ];
    for (const [date, label] of DATE_LABELS) {
      const hijri = hijriLikeDateError(label, date);
      if (hijri) dateErrors.push(hijri);
    }
    const dateIssues = employeeDateIssues({ dateOfBirth: b.dateOfBirth, joinDate: b.joinDate, contractEndDate: b.contractEndDate });
    dateErrors.push(...dateIssues.errors);
    const workforce = resolveWorkforceFields(b, null, b.contractType);
    dateErrors.push(...workforce.errors);
    if (dateErrors.length) throw badRequest(dateErrors.join(' — '));

    const [branch, department] = await Promise.all([
      b.branchId ? prisma.branch.findUnique({ where: { id: b.branchId }, select: { id: true, companyId: true } }) : null,
      b.departmentId ? prisma.department.findUnique({ where: { id: b.departmentId }, select: { id: true, branchId: true } }) : null,
    ]);
    if (b.branchId && !branch) throw badRequest('الفرع المختار غير موجود');
    if (b.departmentId && !department) throw badRequest('القسم المختار غير موجود');
    const placementErrors = orgPlacementErrors({ legalCompanyId: b.legalCompanyId, actualCompanyId: b.actualCompanyId, branch, department });
    if (placementErrors.length) throw badRequest(placementErrors.join(' — '));

    const allowances = (b.allowances ?? [])
      .filter((a) => a.name && a.amount > 0)
      .map((a) => ({
        name: a.name,
        amount: roundMoney(a.amount),
        isMonthly: true,
        countsTowardGosi: typeof a.countsTowardGosi === 'boolean' ? a.countsTowardGosi : defaultCountsTowardGosi(a.name),
        allowanceType: a.allowanceType ?? null,
      }));

    const data: Omit<Prisma.EmployeeUncheckedCreateInput, 'employeeId'> = {
      firstNameArabic: b.firstNameArabic,
      lastNameArabic: b.lastNameArabic ?? '',
      firstNameEnglish: b.firstNameEnglish ?? null,
      lastNameEnglish: b.lastNameEnglish ?? null,
      dateOfBirth: b.dateOfBirth,
      nationality: b.nationality,
      gender: b.gender,
      maritalStatus: b.maritalStatus ?? null,
      iqamaOrIdNumber: b.iqamaOrIdNumber,
      iqamaOrIdExp: b.iqamaOrIdExp,
      passportNumber: b.passportNumber ?? null,
      passportExp: b.passportExp ?? null,
      healthCertificateNum: b.healthCertificateNum ?? null,
      healthCertificateExp: b.healthCertificateExp ?? null,
      joinDate: b.joinDate,
      contractType: b.contractType,
      contractEndDate: b.contractEndDate ?? null,
      probationEndDate: b.probationEndDate ?? null,
      noticePeriodDays: b.noticePeriodDays ?? 30,
      leaveAccrualStartDate: b.leaveAccrualStartDate ?? b.joinDate,
      basicSalary: roundMoney(b.basicSalary),
      gosiDeduction: roundMoney(b.gosiDeduction ?? 0),
      salaryPaymentMethod: b.salaryPaymentMethod,
      mobileNumber: b.mobileNumber ?? null,
      email: b.email ?? null,
      ibanNumber: b.ibanNumber ?? null,
      bankName: b.bankName ?? null,
      legalCompanyId: b.legalCompanyId ?? null,
      actualCompanyId: b.actualCompanyId ?? null,
      administrationId: b.administrationId ?? null,
      branchId: b.branchId ?? null,
      departmentId: b.departmentId ?? null,
      jobTitle: b.jobTitle ?? null,
      directManagerId: b.directManagerId ?? null,
      workSchedule: b.workSchedule ?? null,
      accommodationType: b.accommodationType ?? null,
      workContractUrl: b.contractDocUrl ?? null,
      iqamaCopyUrl: b.idDocUrl ?? null,
      healthCertificateUrl: b.healthCertDocUrl ?? null,
      passportCopyUrl: b.passportDocUrl ?? null,
      gosiRegime: b.gosiRegime ?? undefined,
      gosiRegistrationSource: b.gosiRegistrationSource ?? null,
      gosiNumber: b.gosiNumber ?? null,
      idType: b.idType ?? null,
      ...workforce.data,
      allowances: allowances.length ? { create: allowances } : undefined,
    };

    let created;
    try {
      ({ result: created } = await createWithEmployeeCode(prisma, async (code, tx) => {
        const emp = await tx.employee.create({ data: { ...data, employeeId: code } });
        // Documents uploaded before the employee existed: give them their category and owner.
        await classifyEmployeeDocuments(tx, emp.id, {
          workContractUrl: emp.workContractUrl,
          iqamaCopyUrl: emp.iqamaCopyUrl,
          healthCertificateUrl: emp.healthCertificateUrl,
          passportCopyUrl: emp.passportCopyUrl,
        });
        return emp;
      }));
    } catch (err) {
      if (isUniqueViolationOn(err, 'iqamaOrIdNumber')) throw conflict('رقم الهوية أو الإقامة مسجل مسبقاً لموظف آخر!');
      if (isUniqueViolationOn(err, 'userId') || isUniqueViolationOn(err, 'biometricId')) throw conflict();
      throw err;
    }

    await logAudit({
      userId: user.id,
      action: 'CREATE',
      entityType: 'Employee',
      entityId: created.id,
      details: { employeeId: created.employeeId, name: `${created.firstNameArabic} ${created.lastNameArabic}`.trim() },
      ipAddress: getClientIp(req),
    });

    // Data-quality warnings (IBAN, shared IBAN, ID format, nationality/ID, probation > 180 days,
    // non-Saudi without a contract end date, far-future join date): never block the save.
    const sharedIban = b.ibanNumber
      ? await prisma.employee.findMany({
          where: { ibanNumber: b.ibanNumber, id: { not: created.id } },
          select: { employeeId: true },
          orderBy: { employeeId: 'asc' },
        })
      : [];
    const warnings: Array<{ field: string; message: string }> = [
      ...employeeDataWarnings({
        ibanNumber: b.ibanNumber,
        iqamaOrIdNumber: b.iqamaOrIdNumber,
        idType: b.idType,
        nationality: b.nationality,
        probationDays: b.probationEndDate ? daysBetween(b.joinDate, b.probationEndDate) : null,
        basicSalary: b.basicSalary,
        contractEndDate: b.contractEndDate ?? null,
        ibanSharedWith: sharedIban.map((e) => e.employeeId),
      }),
      ...dateIssues.warnings.map((message) => ({ field: 'dates', message })),
    ];

    return NextResponse.json({ message: 'تم إضافة الموظف بنجاح', employee: created, warnings }, { status: 201 });
  } catch (err) {
    return handleApiError(err, 'employees:POST');
  }
}

const listQuerySchema = zPagination.extend({
  fields: z.enum(['basic', 'full']).optional(),
});

/**
 * GET /api/employees
 *   ?fields=basic  -> lightweight rows for dropdowns (id, code, names, org ids, job title...)
 *   ?take=&skip=   -> optional pagination (default: all rows, newest first)
 * Access (see employeeAccessLevel): HR gets the full record; FINANCE_MANAGER / PAYROLL_ADMIN get the
 * full record without identity documents; BRANCH_MANAGER / DEPT_MANAGER get basic rows of their
 * team only; other back-office roles get basic rows.
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.STAFF);
    const q = parseQuery(req, listQuerySchema);
    const page = { take: q.take, skip: q.skip };
    const orderBy = { createdAt: 'desc' } as const;
    const level = employeeAccessLevel(user.role);
    const where = level === 'team' ? ((await managedEmployeesWhere(prisma, user)) ?? undefined) : undefined;

    if (q.fields === 'basic' || level === 'team' || level === 'basic') {
      const rows = await prisma.employee.findMany({ where, select: EMPLOYEE_BASIC_SELECT, orderBy, ...page });
      return NextResponse.json(rows);
    }

    const rows = await prisma.employee.findMany({ include: EMPLOYEE_LIST_FULL_INCLUDE, orderBy, ...page });
    return NextResponse.json(level === 'payroll' ? rows.map((r) => redactWorkforceForPayroll(redactForPayroll(r))) : rows);
  } catch (err) {
    return handleApiError(err, 'employees:GET');
  }
}
