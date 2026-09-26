import { NextResponse } from 'next/server';
import ExcelJS from 'exceljs';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError } from '@/lib/http';
import { daysBetween, parseDateOnly } from '@/lib/dates';
import { roundMoney, sumMoney } from '@/lib/money';
import { findBank } from '@/lib/banks';
import {
  ACCOMMODATION_LABELS,
  CONTRACT_TYPE_LABELS,
  GENDER_LABELS,
  IMPORT_EXAMPLE_ROW,
  IMPORT_TEMPLATE,
  PAYMENT_METHOD_LABELS,
  allowanceBucket,
  normalizeNationality,
  parseGenderLabel,
  type ImportField,
} from '@/lib/employee';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TEMPLATE_FILE_NAME = 'نموذج_استيراد_الموظفين.xlsx';
const EXPORT_FILE_NAME = 'قاعدة_بيانات_الموظفين.xlsx';

type CellValue = string | number | Date | null;

const EXPORT_SELECT = {
  employeeId: true,
  firstNameArabic: true,
  lastNameArabic: true,
  firstNameEnglish: true,
  lastNameEnglish: true,
  nationality: true,
  gender: true,
  dateOfBirth: true,
  maritalStatus: true,
  mobileNumber: true,
  email: true,
  legalCompany: { select: { nameArabic: true } },
  actualCompany: { select: { nameArabic: true } },
  administration: { select: { nameArabic: true } },
  branch: { select: { nameArabic: true } },
  department: { select: { nameArabic: true } },
  directManager: { select: { employeeId: true } },
  jobTitle: true,
  jobTitleEnglish: true,
  workSchedule: true,
  accommodationType: true,
  contractType: true,
  noticePeriodDays: true,
  joinDate: true,
  leaveAccrualStartDate: true,
  contractEndDate: true,
  probationEndDate: true,
  iqamaOrIdNumber: true,
  iqamaOrIdExp: true,
  passportNumber: true,
  passportExp: true,
  healthCertificateNum: true,
  healthCertificateExp: true,
  salaryPaymentMethod: true,
  bankName: true,
  ibanNumber: true,
  basicSalary: true,
  gosiDeduction: true,
  allowances: { where: { isMonthly: true }, select: { name: true, amount: true } },
} as const;

type ExportEmployee = Awaited<ReturnType<typeof loadEmployees>>[number];

function loadEmployees() {
  return prisma.employee.findMany({ where: { isTerminated: false }, select: EXPORT_SELECT, orderBy: { employeeId: 'asc' } });
}

/** One template row per employee, in IMPORT_TEMPLATE order, with the labels the import understands. */
function employeeRow(emp: ExportEmployee): CellValue[] {
  const buckets = { housing: [] as number[], transport: [] as number[], other: [] as number[] };
  for (const a of emp.allowances) buckets[allowanceBucket(a.name)].push(a.amount ?? 0);
  const housing = sumMoney(buckets.housing);
  const transport = sumMoney(buckets.transport);
  const other = sumMoney(buckets.other);
  const gender = parseGenderLabel(emp.gender);
  const money = (n: number | null | undefined) => (n === null || n === undefined ? null : roundMoney(n));

  const values: Record<ImportField, CellValue> = {
    fullNameArabic: [emp.firstNameArabic, emp.lastNameArabic].filter(Boolean).join(' '),
    fullNameEnglish: [emp.firstNameEnglish, emp.lastNameEnglish].filter(Boolean).join(' '),
    nationality: normalizeNationality(emp.nationality),
    gender: gender ? GENDER_LABELS[gender] : null,
    dateOfBirth: emp.dateOfBirth,
    maritalStatus: emp.maritalStatus,
    mobileNumber: emp.mobileNumber,
    email: emp.email,
    legalCompanyName: emp.legalCompany?.nameArabic ?? null,
    actualCompanyName: emp.actualCompany?.nameArabic ?? null,
    administrationName: emp.administration?.nameArabic ?? null,
    branchName: emp.branch?.nameArabic ?? null,
    departmentName: emp.department?.nameArabic ?? null,
    // The employee code is unambiguous and the import resolves managers by code.
    directManager: emp.directManager?.employeeId ?? null,
    jobTitle: emp.jobTitle,
    jobTitleEnglish: emp.jobTitleEnglish,
    workSchedule: emp.workSchedule,
    accommodationType: emp.accommodationType ? ACCOMMODATION_LABELS[emp.accommodationType] : null,
    contractType: CONTRACT_TYPE_LABELS[emp.contractType],
    noticePeriodDays: emp.noticePeriodDays,
    joinDate: emp.joinDate,
    leaveAccrualStartDate: emp.leaveAccrualStartDate,
    contractEndDate: emp.contractEndDate,
    probationDays: emp.probationEndDate ? Math.max(0, daysBetween(emp.joinDate, emp.probationEndDate)) : null,
    iqamaOrIdNumber: emp.iqamaOrIdNumber,
    iqamaOrIdExp: emp.iqamaOrIdExp,
    passportNumber: emp.passportNumber,
    passportExp: emp.passportExp,
    healthCertificateNum: emp.healthCertificateNum,
    healthCertificateExp: emp.healthCertificateExp,
    salaryPaymentMethod: PAYMENT_METHOD_LABELS[emp.salaryPaymentMethod],
    bankName: emp.bankName,
    swiftCode: findBank(emp.bankName)?.code ?? null,
    ibanNumber: emp.ibanNumber,
    basicSalary: money(emp.basicSalary),
    housingAllowance: housing > 0 ? housing : null,
    transportAllowance: transport > 0 ? transport : null,
    otherAllowances: other > 0 ? other : null,
    gosiDeduction: money(emp.gosiDeduction),
    totalSalary: sumMoney([emp.basicSalary ?? 0, housing, transport, other, -(emp.gosiDeduction ?? 0)]),
  };
  return IMPORT_TEMPLATE.map((c) => values[c.field] ?? null);
}

/**
 * GET /api/employees/import/template                 -> blank import template with one example row.
 * GET /api/employees/import/template?withEmployees=1 -> the same template filled with the current
 *     (non-terminated) employees, ready to be edited and re-imported (same columns and labels).
 */
export async function GET(req: Request) {
  try {
    await requireUser(ROLE_GROUPS.HR);
    const withEmployees = ['1', 'true'].includes(new URL(req.url).searchParams.get('withEmployees') ?? '');

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Radeef HRMS';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('الموظفين', {
      views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }],
    });

    sheet.columns = IMPORT_TEMPLATE.map((col, i) => ({
      header: col.header,
      key: `c${i}`,
      width: col.width ?? 24,
      // Column-level formats also apply to rows the user adds later.
      style: col.format === 'text' ? { numFmt: '@' } : col.format === 'date' ? { numFmt: 'yyyy-mm-dd' } : {},
    }));

    const header = sheet.getRow(1);
    header.font = { bold: true };
    header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    header.height = 32;
    header.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
    });

    const rows: CellValue[][] = withEmployees
      ? (await loadEmployees()).map(employeeRow)
      : [IMPORT_EXAMPLE_ROW.map((v, i) => (IMPORT_TEMPLATE[i].format === 'date' && v ? (parseDateOnly(v) ?? v) : v))];

    for (const values of rows) {
      const row = sheet.addRow(values);
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        const col = IMPORT_TEMPLATE[colNumber - 1];
        if (!col) return;
        if (col.format === 'text') {
          // Identifiers stay text so leading zeros survive the round trip.
          cell.numFmt = '@';
          const v = values[colNumber - 1];
          cell.value = v === null || v === undefined ? null : String(v);
        } else if (col.format === 'date') {
          cell.numFmt = 'yyyy-mm-dd';
        }
      });
    }

    const buffer = await workbook.xlsx.writeBuffer();
    const fileName = withEmployees ? EXPORT_FILE_NAME : TEMPLATE_FILE_NAME;
    const asciiName = withEmployees ? 'employees_export.xlsx' : 'employees_import_template.xlsx';
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        'Cache-Control': 'no-store',
        'X-Row-Count': String(withEmployees ? rows.length : 0),
      },
    });
  } catch (err) {
    return handleApiError(err, 'employees/import/template:GET');
  }
}
