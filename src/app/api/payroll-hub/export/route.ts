import { NextResponse } from 'next/server';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { getClientIp, requireUser } from '@/lib/auth';
import { PAYROLL_STATUS, ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, parseQuery } from '@/lib/http';
import { zMonth, zYear } from '@/lib/validation';
import { logAudit } from '@/lib/audit';
import { decryptField } from '@/lib/crypto';
import { formatDateTime } from '@/lib/dates';
import { roundMoney, sumMoney } from '@/lib/money';
import { hasStoredBreakdown, payrollTotals, STORED_PAYROLL_SELECT } from '@/lib/payroll';

export const dynamic = 'force-dynamic';

/** Visible header note (DEC-002): this sheet is NOT a WPS / Mudad upload file. */
const EXPORT_NOTE = 'كشف للمراجعة الداخلية — ليس ملف حماية الأجور (WPS)';
const EXPORT_NOTE_2 = 'غير معتمد للرفع على مدد أو البنك. القيم مأخوذة من مسير الرواتب المخزّن وقت التوليد.';
const LEGACY_NOTE = 'تفصيل الخصومات غير متوفر (مسير أُنشئ قبل حفظ التفصيل)';

const emptyToUndefined = (v: unknown) => (v === '' || v === null ? undefined : v);

const QuerySchema = z.object({
  month: zMonth,
  year: zYear,
  status: z.preprocess(emptyToUndefined, z.enum([PAYROLL_STATUS.DRAFT, PAYROLL_STATUS.APPROVED, PAYROLL_STATUS.PAID]).optional()),
});

const STATUS_LABELS: Record<string, string> = {
  [PAYROLL_STATUS.DRAFT]: 'مسودة',
  [PAYROLL_STATUS.APPROVED]: 'معتمد',
  [PAYROLL_STATUS.PAID]: 'مصروف',
};

const REGIME_LABELS: Record<string, string> = { OLD: 'قديم', NEW: 'جديد', UNKNOWN: 'غير مؤكد' };

function safeDecrypt(v: string | null | undefined): string | null {
  try {
    return decryptField(v);
  } catch {
    return null;
  }
}

type Cell = string | number | null;

interface Column {
  header: string;
  width: number;
  money?: boolean;
}

const COLUMNS: Column[] = [
  { header: 'الرقم الوظيفي', width: 12 },
  { header: 'اسم الموظف', width: 26 },
  { header: 'رقم الهوية / الإقامة', width: 16 },
  { header: 'الجنسية', width: 12 },
  { header: 'نظام التأمينات', width: 12 },
  { header: 'الشركة القانونية', width: 20 },
  { header: 'الفرع', width: 16 },
  { header: 'القسم', width: 16 },
  { header: 'الحالة', width: 10 },
  { header: 'الراتب الأساسي', width: 14, money: true },
  { header: 'البدلات الشهرية', width: 14, money: true },
  { header: 'مكافآت لمرة واحدة', width: 14, money: true },
  { header: 'العمل الإضافي', width: 14, money: true },
  { header: 'إجمالي المستحق', width: 14, money: true },
  { header: 'تأمينات (حصة الموظف)', width: 16, money: true },
  { header: 'خصم الإجازات والغياب', width: 16, money: true },
  { header: 'السلف', width: 12, money: true },
  { header: 'الجزاءات', width: 12, money: true },
  { header: 'خصومات أخرى', width: 12, money: true },
  { header: 'إجمالي الحسميات', width: 14, money: true },
  { header: 'صافي الراتب', width: 14, money: true },
  { header: 'تأمينات (حصة صاحب العمل - تكلفة لا تُخصم)', width: 22, money: true },
  { header: 'يحتاج مراجعة', width: 12 },
  { header: 'ملاحظات المراجعة', width: 40 },
  { header: 'الآيبان', width: 28 },
  { header: 'البنك', width: 16 },
];

/**
 * GET /api/payroll-hub/export?month&year[&status]
 * .xlsx of one payroll month built on the server from the STORED payroll rows and their stored
 * breakdown (never from values computed in the browser). First row: "internal review sheet, not
 * a WPS file". Rows generated before the breakdown columns existed show the stored totals only.
 */
export async function GET(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.PAYROLL);
    const { month, year, status } = parseQuery(req, QuerySchema);

    const rows = await prisma.payroll.findMany({
      where: { month, year, ...(status ? { status } : {}) },
      select: {
        ...STORED_PAYROLL_SELECT,
        id: true,
        createdAt: true,
        employee: {
          select: {
            employeeId: true,
            firstNameArabic: true,
            lastNameArabic: true,
            iqamaOrIdNumber: true,
            nationality: true,
            gosiRegime: true,
            ibanNumber: true,
            bankName: true,
            legalCompany: { select: { nameArabic: true } },
            branch: { select: { nameArabic: true } },
            department: { select: { nameArabic: true } },
          },
        },
      },
      orderBy: [{ employee: { firstNameArabic: 'asc' } }, { employee: { lastNameArabic: 'asc' } }],
    });

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Radeef';
    workbook.created = new Date();
    const ws = workbook.addWorksheet(`رواتب ${month}-${year}`, { views: [{ rightToLeft: true, state: 'frozen', ySplit: 3 }] });
    ws.columns = COLUMNS.map((c) => ({ width: c.width }));
    const lastCol = COLUMNS.length;

    // Row 1-2: visible notes (merged across the sheet).
    ws.mergeCells(1, 1, 1, lastCol);
    const note = ws.getCell(1, 1);
    note.value = EXPORT_NOTE;
    note.font = { bold: true, size: 14, color: { argb: 'FF9A3412' } };
    note.alignment = { horizontal: 'center', vertical: 'middle' };
    note.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFEDD5' } };
    ws.getRow(1).height = 26;
    ws.mergeCells(2, 1, 2, lastCol);
    const note2 = ws.getCell(2, 1);
    note2.value = `مسير رواتب شهر ${month}/${year}${status ? ` (${STATUS_LABELS[status]})` : ''} — ${EXPORT_NOTE_2} — تاريخ التصدير: ${formatDateTime(new Date())}`;
    note2.font = { bold: true, size: 11, color: { argb: 'FF7C2D12' } };
    note2.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    ws.getRow(2).height = 30;

    const header = ws.getRow(3);
    COLUMNS.forEach((c, i) => {
      const cell = header.getCell(i + 1);
      cell.value = c.header;
      cell.font = { bold: true };
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
      cell.border = { bottom: { style: 'thin' } };
    });
    header.height = 32;

    for (const r of rows) {
      const e = r.employee;
      const detailed = hasStoredBreakdown(r);
      const notes = [r.reviewNote, detailed ? null : LEGACY_NOTE].filter(Boolean).join(' | ');
      const values: Cell[] = [
        e.employeeId ?? '',
        `${e.firstNameArabic ?? ''} ${e.lastNameArabic ?? ''}`.trim(),
        e.iqamaOrIdNumber ?? '',
        e.nationality ?? '',
        REGIME_LABELS[e.gosiRegime] ?? e.gosiRegime,
        e.legalCompany?.nameArabic ?? '',
        e.branch?.nameArabic ?? '',
        e.department?.nameArabic ?? '',
        STATUS_LABELS[r.status] ?? r.status,
        r.basicSalary,
        roundMoney(r.totalAllowances - r.bonusAmount),
        r.bonusAmount,
        r.overtimeCost,
        sumMoney([r.basicSalary, r.totalAllowances, r.overtimeCost]),
        detailed ? r.gosiEmployee : null,
        detailed ? r.leaveDeduction : null,
        detailed ? r.loansDeduction : null,
        detailed ? r.violationsDeduction : null,
        detailed ? r.otherDeductions : null,
        r.totalDeductions,
        r.netSalary,
        r.gosiEmployer,
        r.needsReview ? 'نعم' : '',
        notes,
        safeDecrypt(e.ibanNumber) ?? '',
        e.bankName ?? '',
      ];
      const row = ws.addRow(values);
      if (r.needsReview) row.getCell(23).font = { bold: true, color: { argb: 'FFB91C1C' } };
    }

    // Totals row (from the stored rows).
    const t = payrollTotals(rows);
    const totalsRow = ws.addRow([
      'الإجمالي',
      `${rows.length} موظف`,
      '', '', '', '', '', '', '',
      t.basicSalary,
      t.recurringAllowances,
      t.bonusAmount,
      t.overtimeCost,
      t.gross,
      t.gosiEmployee,
      t.leaveDeduction,
      t.loansDeduction,
      t.violationsDeduction,
      t.otherDeductions,
      t.totalDeductions,
      t.netSalary,
      t.gosiEmployer,
      String(rows.filter((r) => r.needsReview).length),
      '',
      '',
      '',
    ]);
    totalsRow.font = { bold: true };
    totalsRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
      cell.border = { top: { style: 'thin' } };
    });

    COLUMNS.forEach((c, i) => {
      if (c.money) ws.getColumn(i + 1).numFmt = '#,##0.00';
    });

    const buffer = await workbook.xlsx.writeBuffer();
    await logAudit({
      userId: user.id,
      action: 'EXPORT',
      entityType: 'PAYROLL',
      entityId: `${year}-${month}`,
      details: { month, year, status: status ?? null, rows: rows.length },
      ipAddress: getClientIp(req),
    });

    const fileName = `كشف_رواتب_${month}_${year}_مراجعة_داخلية.xlsx`;
    const asciiName = `payroll_review_${year}_${String(month).padStart(2, '0')}.xlsx`;
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        'Cache-Control': 'no-store',
        'X-Row-Count': String(rows.length),
      },
    });
  } catch (err) {
    return handleApiError(err, 'payroll-hub/export:GET');
  }
}
