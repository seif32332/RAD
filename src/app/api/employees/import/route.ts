import { NextResponse } from 'next/server';
import ExcelJS from 'exceljs';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import { requireUser, getClientIp } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { handleApiError, badRequest, HttpError } from '@/lib/http';
import { addDays } from '@/lib/dates';
import { roundMoney, toNumber } from '@/lib/money';
import { logAudit } from '@/lib/audit';
import {
  ALLOWANCE_NAMES,
  IMPORT_EXAMPLE_ROW,
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_ROWS,
  IMPORT_TEMPLATE,
  NATIONALITY_REQUIRED_MESSAGE,
  REVIEW_STATE_SELECT,
  cellDate,
  cellText,
  createWithEmployeeCode,
  defaultCountsTowardGosi,
  directManagerError,
  employeeDataWarnings,
  employeeDateIssues,
  GENDER_LABELS,
  GENDER_REQUIRED_MESSAGE,
  hijriLikeDateError,
  isUniqueViolationOn,
  mapImportRow,
  matchByName,
  maxEmployeeCodeNumber,
  orgPlacementErrors,
  recordCountLabel,
  resolveOrgUnit,
  normalizeNationality,
  parseAccommodationLabel,
  parseContractTypeLabel,
  parseGenderLabel,
  parsePaymentMethodLabel,
  resolveBankName,
  reviewNoteAfterEdit,
  resolveImportHeader,
  splitFullName,
  type ImportCell,
  type ImportField,
  type ImportRow,
} from '@/lib/employee';
import { normalizeIban } from '@/lib/iban';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RowSuccess {
  row: number;
  name: string;
  /** Employee code; '' for a row that a dry run would create (the code is allocated on the real import). */
  empId: string;
  status: 'created' | 'updated';
  details?: string;
  warnings?: string[];
}
interface RowError {
  row: number;
  name?: string;
  reason: string;
  warnings?: string[];
}
interface RowWarning {
  row: number;
  name?: string;
  message: string;
}

/** Date columns: a non-empty cell that is not a valid date is a row error. */
const DATE_FIELD_LABELS: ReadonlyArray<readonly [ImportField, string]> = [
  ['dateOfBirth', 'تاريخ الميلاد'],
  ['joinDate', 'تاريخ مباشرة العمل'],
  ['iqamaOrIdExp', 'تاريخ انتهاء الهوية / الإقامة'],
  ['leaveAccrualStartDate', 'تاريخ احتساب الإجازة'],
  ['contractEndDate', 'تاريخ انتهاء العقد'],
  ['passportExp', 'تاريخ انتهاء الجواز'],
  ['healthCertificateExp', 'تاريخ انتهاء الشهادة الصحية'],
];

/** Numeric columns: a non-empty cell that is not a number is a row error. */
const NUMBER_FIELD_LABELS: ReadonlyArray<readonly [ImportField, string]> = [
  ['basicSalary', 'الراتب الأساسي'],
  ['housingAllowance', 'بدل السكن'],
  ['transportAllowance', 'بدل النقل'],
  ['otherAllowances', 'بدلات أخرى'],
  ['gosiDeduction', 'خصم التأمينات'],
  ['noticePeriodDays', 'فترة الإشعار'],
  ['probationDays', 'مدة فترة التجربة'],
];

/** Fields of an employee the import keeps in memory (matching, managers, update defaults). */
const KNOWN_EMPLOYEE_SELECT = {
  id: true,
  iqamaOrIdNumber: true,
  employeeId: true,
  firstNameArabic: true,
  lastNameArabic: true,
  joinDate: true,
  branchId: true,
  nationality: true,
  idType: true,
  gender: true,
  dateOfBirth: true,
  contractEndDate: true,
  legalCompanyId: true,
  actualCompanyId: true,
  administrationId: true,
} as const satisfies Prisma.EmployeeSelect;

const EXAMPLE_NAME = IMPORT_EXAMPLE_ROW[IMPORT_TEMPLATE.findIndex((c) => c.field === 'fullNameArabic')];
const EXAMPLE_ID = IMPORT_EXAMPLE_ROW[IMPORT_TEMPLATE.findIndex((c) => c.field === 'iqamaOrIdNumber')];

/** The example row of the downloaded template (left in the sheet by mistake) must never create an employee. */
function isTemplateExampleRow(raw: ImportRow): boolean {
  return cellText(raw.iqamaOrIdNumber) === EXAMPLE_ID && cellText(raw.fullNameArabic) === EXAMPLE_NAME;
}

/** Converts an exceljs cell value to a plain value (rich text, hyperlinks, formulas unwrapped). */
function plainCellValue(v: ExcelJS.CellValue): ImportCell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v instanceof Date) return v;
  if (typeof v === 'object') {
    if ('richText' in v && Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if ('error' in v) return null;
    if ('result' in v) {
      const r = (v as { result?: unknown }).result;
      if (r === null || r === undefined) return null;
      if (typeof r === 'string' || typeof r === 'number' || typeof r === 'boolean' || r instanceof Date) return r;
      return null;
    }
    if ('text' in v) {
      const t = (v as { text?: unknown }).text;
      return typeof t === 'string' ? t : null;
    }
  }
  return null;
}

/** Positive number from a cell, or null when blank / not a number. */
function cellNumber(v: ImportCell | undefined): number | null {
  const s = cellText(v);
  if (!s) return null;
  const n = toNumber(s, NaN);
  return Number.isFinite(n) ? n : null;
}

/** Safe per-row error text: never the raw exception message. */
function rowErrorReason(err: unknown): string {
  if (err instanceof HttpError) return err.message;
  if (isUniqueViolationOn(err, 'iqamaOrIdNumber')) return 'رقم الهوية مسجل مسبقاً لموظف آخر';
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') return 'قيمة مكررة لحقل يجب أن يكون فريداً';
    if (err.code === 'P2003') return 'ارتباط غير صالح بشركة / فرع / قسم';
  }
  if (err instanceof Prisma.PrismaClientValidationError) return 'بيانات السطر غير صالحة';
  return 'تعذر حفظ بيانات هذا السطر';
}

function isTruthyFlag(v: FormDataEntryValue | string | null): boolean {
  return typeof v === 'string' && ['1', 'true', 'yes'].includes(v.trim().toLowerCase());
}

/**
 * POST /api/employees/import (multipart: file=<xlsx>)
 *   ?validateOnly=1 (or form field validateOnly=1): dry run. Same parsing, matching and checks,
 *   same report (success / errors / warnings), but NOTHING is written (no employee, no allowance,
 *   no audit row).
 * Warnings never reject a row (unmatched org unit, department outside the branch, invalid or shared
 * IBAN, zero salary, ID format, probation > 180 days, non-Saudi without a contract end date).
 * Row errors (council WP-3): a new employee without a nationality or a gender; an ID number that
 * appears in more than one row of the file (every such row); a date whose year is < 1900 (a Hijri
 * date typed as Gregorian); a company / branch name that exactly matches several records; for a new
 * employee, a birth date in the future or a contract end before the join date (warnings on update).
 */
export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.HR);

    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      throw badRequest('صيغة الطلب غير صحيحة');
    }
    const validateOnly = isTruthyFlag(new URL(req.url).searchParams.get('validateOnly')) || isTruthyFlag(formData.get('validateOnly'));
    const file = formData.get('file');
    if (!file || typeof file === 'string') throw badRequest('لم يتم رفع أي ملف');
    if (file.size === 0) throw badRequest('الملف فارغ');
    if (file.size > IMPORT_MAX_FILE_BYTES) throw badRequest('حجم الملف يتجاوز الحد المسموح (5 ميجابايت)');

    // ---- Read the first worksheet -------------------------------------------------------
    const workbook = new ExcelJS.Workbook();
    try {
      await workbook.xlsx.load(await file.arrayBuffer());
    } catch {
      throw badRequest('تعذر قراءة الملف. يرجى رفع ملف Excel بصيغة ‎.xlsx');
    }
    const sheet = workbook.worksheets[0];
    if (!sheet) throw badRequest('الملف فارغ أو لا يحتوي على بيانات');

    const headerRow = sheet.getRow(1);
    const headers: Array<{ col: number; header: ReturnType<typeof resolveImportHeader> }> = [];
    headerRow.eachCell({ includeEmpty: false }, (cell, col) => {
      headers.push({ col, header: resolveImportHeader(cellText(plainCellValue(cell.value))) });
    });
    if (!headers.some((h) => h.header)) throw badRequest('لم يتم التعرف على أعمدة الملف. استخدم النموذج المعتمد للاستيراد');

    const rows: Array<{ rowNum: number; data: ImportRow }> = [];
    for (let r = 2; r <= sheet.rowCount; r++) {
      const row = sheet.getRow(r);
      const cells = headers.map((h) => ({ header: h.header, value: plainCellValue(row.getCell(h.col).value) }));
      if (cells.every((c) => cellText(c.value) === '')) continue; // skip blank rows
      rows.push({ rowNum: r, data: mapImportRow(cells) });
      if (rows.length > IMPORT_MAX_ROWS) throw badRequest(`عدد الأسطر يتجاوز الحد المسموح (${IMPORT_MAX_ROWS} سطر)`);
    }
    if (rows.length === 0) throw badRequest('الملف فارغ أو لا يحتوي على بيانات');

    // ---- Reference data ----------------------------------------------------------------
    const [companies, departments, branches, administrations, existingEmployees, maxCode] = await Promise.all([
      prisma.company.findMany({ select: { id: true, nameArabic: true, nameEnglish: true, commercialRegNum: true, unifiedNumber: true } }),
      prisma.department.findMany({ select: { id: true, nameArabic: true, nameEnglish: true, branchId: true } }),
      prisma.branch.findMany({ select: { id: true, nameArabic: true, nameEnglish: true, branchCode: true, companyId: true } }),
      prisma.administration.findMany({ select: { id: true, nameArabic: true, nameEnglish: true } }),
      prisma.employee.findMany({
        select: {
          ...KNOWN_EMPLOYEE_SELECT,
          ibanNumber: true,
        },
      }),
      maxEmployeeCodeNumber(prisma),
    ]);

    type KnownEmployee = Prisma.EmployeeGetPayload<{ select: typeof KNOWN_EMPLOYEE_SELECT }>;
    const byIdNumber = new Map<string, KnownEmployee>(existingEmployees.map((e) => [e.iqamaOrIdNumber, e]));
    const knownEmployees: KnownEmployee[] = [...existingEmployees];
    let nextCodeNumber = maxCode + 1;

    // ---- File-level checks ----------------------------------------------------------------
    // An ID number on several rows: every such row is an error (the last row no longer wins silently).
    const rowsById = new Map<string, number[]>();
    for (const { rowNum, data } of rows) {
      const id = cellText(data.iqamaOrIdNumber);
      if (!id) continue;
      rowsById.set(id, [...(rowsById.get(id) ?? []), rowNum]);
    }
    // IBAN owners after this import: the database value, replaced by the row's IBAN when the row has one.
    const ibanOwners = new Map<string, { iban: string; label: string }>();
    for (const e of existingEmployees) {
      const iban = e.ibanNumber ? normalizeIban(e.ibanNumber) : '';
      if (iban) ibanOwners.set(e.id, { iban, label: e.employeeId });
    }
    const ibanOwnerKeyOfRow = new Map<number, string>();
    for (const { rowNum, data } of rows) {
      const id = cellText(data.iqamaOrIdNumber);
      const iban = cellText(data.ibanNumber) ? normalizeIban(cellText(data.ibanNumber)) : '';
      if (!id || !iban || (rowsById.get(id)?.length ?? 0) > 1) continue;
      const existing = byIdNumber.get(id);
      const key = existing?.id ?? `row:${rowNum}`;
      ibanOwners.set(key, { iban, label: existing?.employeeId || `الصف ${rowNum}` });
      ibanOwnerKeyOfRow.set(rowNum, key);
    }
    const ownersByIban = new Map<string, Array<{ key: string; label: string }>>();
    for (const [key, { iban, label }] of ibanOwners) ownersByIban.set(iban, [...(ownersByIban.get(iban) ?? []), { key, label }]);
    const ibanSharedWithOfRow = (rowNum: number, iban: string | null): string[] => {
      const key = ibanOwnerKeyOfRow.get(rowNum);
      if (!iban || !key) return [];
      return (ownersByIban.get(iban) ?? []).filter((o) => o.key !== key).map((o) => o.label);
    };

    const success: RowSuccess[] = [];
    const errors: RowError[] = [];
    const warnings: RowWarning[] = [];

    for (const { rowNum, data: raw } of rows) {
      const { first: firstNameArabic, last: lastNameArabic } = splitFullName(cellText(raw.fullNameArabic));
      const fullNameEn = splitFullName(cellText(raw.fullNameEnglish));
      const firstNameEnglish = fullNameEn.first || null;
      const lastNameEnglish = fullNameEn.last || null;
      const displayName = `${firstNameArabic} ${lastNameArabic}`.trim();

      if (!firstNameArabic) {
        errors.push({ row: rowNum, reason: 'الاسم بالعربي مطلوب' });
        continue;
      }
      const idNumber = cellText(raw.iqamaOrIdNumber);
      if (!idNumber) {
        errors.push({ row: rowNum, name: firstNameArabic, reason: 'رقم الهوية مطلوب' });
        continue;
      }
      if (isTemplateExampleRow(raw)) {
        errors.push({ row: rowNum, name: displayName, reason: 'هذا صف المثال التوضيحي من النموذج: احذفه أو استبدله ببيانات حقيقية' });
        continue;
      }

      const sameIdRows = rowsById.get(idNumber) ?? [];
      if (sameIdRows.length > 1) {
        errors.push({
          row: rowNum,
          name: displayName,
          reason: `رقم الهوية «${idNumber}» مكرر في الملف (الصفوف: ${sameIdRows.join('، ')}) — أبقِ صفاً واحداً لكل موظف ثم أعد الرفع`,
        });
        continue;
      }

      const existingEmp = byIdNumber.get(idNumber);
      const rowWarnings: string[] = [];
      // Blocking problems found while matching the org units (e.g. a company name shared by several records).
      const rowErrors: string[] = [];

      // Org-unit matching. An exact name (or number) wins; several exact matches are ambiguous: an
      // update row keeps the employee's current unit when it is one of them, otherwise the row is an
      // error for a company / branch (never a random pick). A cell that matches nothing is a warning
      // (the field is left empty on create / unchanged on update), never a silent drop.
      const orgLookup = <T extends { id: string; nameArabic: string; nameEnglish?: string | null }>(
        items: T[],
        field: ImportField,
        label: string,
        opts: { extraKeys?: (item: T) => ReadonlyArray<string | null | undefined>; preferId?: string | null; ambiguousHint?: string } = {},
      ): T | undefined => {
        const name = cellText(raw[field]);
        if (!name) return undefined;
        const match = resolveOrgUnit(items, name, opts);
        if (match.kind === 'none') {
          rowWarnings.push(`${label} «${name}» غير موجود في النظام — لم يتم ربطه`);
          return undefined;
        }
        if (match.kind === 'ambiguous') {
          const text = `${label} «${name}» يطابق ${recordCountLabel(match.count)} بالاسم نفسه`;
          if (opts.ambiguousHint) rowErrors.push(`${text} — ${opts.ambiguousHint}`);
          else rowWarnings.push(`${text} — لم يتم ربطه`);
          return undefined;
        }
        if (match.kind === 'approx') {
          // A name contained in another: say which record was used.
          rowWarnings.push(`${label} «${name}» طُوبق تقريبياً مع «${match.item.nameArabic}» — تحقق من صحة الربط`);
        }
        return match.item;
      };
      const companyKeys = (c: (typeof companies)[number]) => [c.id, c.commercialRegNum, c.unifiedNumber];
      const COMPANY_HINT = 'اكتب رقم السجل التجاري أو الرقم الموحد للشركة، أو اسمها الفريد';
      const legalCompanyId =
        orgLookup(companies, 'legalCompanyName', 'الشركة القانونية', { extraKeys: companyKeys, preferId: existingEmp?.legalCompanyId, ambiguousHint: COMPANY_HINT })?.id ?? null;
      const actualCompanyName = cellText(raw.actualCompanyName);
      const actualCompanyId = actualCompanyName
        ? (orgLookup(companies, 'actualCompanyName', 'الشركة الفعلية', { extraKeys: companyKeys, preferId: existingEmp?.actualCompanyId, ambiguousHint: COMPANY_HINT })?.id ?? null)
        : legalCompanyId;
      const administrationId =
        orgLookup(administrations, 'administrationName', 'الإدارة', { extraKeys: (a) => [a.id], preferId: existingEmp?.administrationId })?.id ?? null;
      const branch = orgLookup(branches, 'branchName', 'الفرع', {
        extraKeys: (b) => [b.id, b.branchCode],
        preferId: existingEmp?.branchId,
        ambiguousHint: 'اكتب رمز الفرع أو اسمه الفريد',
      });
      const branchId = branch?.id ?? null;
      // Prefer a department of the row's branch (two branches may have a department with the same name).
      const deptName = cellText(raw.departmentName);
      const effectiveBranchId = branchId ?? existingEmp?.branchId ?? null;
      let department = deptName && effectiveBranchId ? matchByName(departments.filter((d) => d.branchId === effectiveBranchId), deptName) : undefined;
      if (department && department.nameArabic !== deptName && (department.nameEnglish ?? '') !== deptName) {
        rowWarnings.push(`القسم «${deptName}» طُوبق تقريبياً مع «${department.nameArabic}» — تحقق من صحة الربط`);
      }
      if (!department) department = orgLookup(departments, 'departmentName', 'القسم');
      const departmentId = department?.id ?? null;
      if (department && effectiveBranchId && department.branchId !== effectiveBranchId) {
        rowWarnings.push(`القسم «${department.nameArabic}» لا يتبع فرع الموظف`);
      }
      // Branch outside the workplace company: a warning in the import (POST /api/employees rejects it).
      if (branch) {
        for (const msg of orgPlacementErrors({
          legalCompanyId: legalCompanyId ?? existingEmp?.legalCompanyId ?? null,
          actualCompanyId: actualCompanyName ? actualCompanyId : (existingEmp?.actualCompanyId ?? null),
          branch,
        })) {
          rowWarnings.push(`${msg} (تنبيه فقط)`);
        }
      }

      // Direct manager: by ID number, employee code or full Arabic name. Never self.
      let directManagerId: string | null = null;
      const managerVal = cellText(raw.directManager);
      if (managerVal) {
        const manager = knownEmployees.find(
          (e) => e.iqamaOrIdNumber === managerVal || e.employeeId === managerVal || `${e.firstNameArabic} ${e.lastNameArabic}`.trim() === managerVal,
        );
        if (manager && !directManagerError(existingEmp?.id ?? null, manager.id) && manager.iqamaOrIdNumber !== idNumber) {
          directManagerId = manager.id;
        } else {
          rowWarnings.push(`المدير المباشر «${managerVal}» غير موجود أو غير صالح — لم يتم ربطه`);
        }
      }

      const contractType = parseContractTypeLabel(cellText(raw.contractType));
      const salaryPaymentMethod = parsePaymentMethodLabel(cellText(raw.salaryPaymentMethod));
      const accommodationType = parseAccommodationLabel(cellText(raw.accommodationType));

      const dateOfBirth = cellDate(raw.dateOfBirth);
      const joinDate = cellDate(raw.joinDate);
      const iqamaOrIdExp = cellDate(raw.iqamaOrIdExp);
      const leaveAccrualStartDate = cellDate(raw.leaveAccrualStartDate);
      const contractEndDate = cellDate(raw.contractEndDate);
      const passportExp = cellDate(raw.passportExp);
      const healthCertificateExp = cellDate(raw.healthCertificateExp);

      const probDays = cellNumber(raw.probationDays);
      const probationBase = joinDate ?? existingEmp?.joinDate ?? null;
      const probationEndDate = probDays && probDays > 0 && probationBase ? addDays(probationBase, Math.round(probDays)) : null;

      const noticeDays = cellNumber(raw.noticePeriodDays);
      const basicSalary = cellNumber(raw.basicSalary);
      const gosiDeduction = cellNumber(raw.gosiDeduction);

      // Monthly allowances from the row (housing counts toward the GOSI base: Allowance.countsTowardGosi).
      // The template has one column per allowance kind, so the type is known (Allowance.allowanceType).
      const allowances: Array<{ name: string; amount: number; countsTowardGosi: boolean; allowanceType: 'HOUSING' | 'TRANSPORT' | 'OTHER' }> = [];
      const housing = cellNumber(raw.housingAllowance);
      const transport = cellNumber(raw.transportAllowance);
      const other = cellNumber(raw.otherAllowances);
      const addAllowance = (name: string, amount: number | null, allowanceType: 'HOUSING' | 'TRANSPORT' | 'OTHER') => {
        if (amount && amount > 0) allowances.push({ name, amount: roundMoney(amount), countsTowardGosi: defaultCountsTowardGosi(name), allowanceType });
      };
      addAllowance(ALLOWANCE_NAMES.HOUSING, housing, 'HOUSING');
      addAllowance(ALLOWANCE_NAMES.TRANSPORT, transport, 'TRANSPORT');
      addAllowance(ALLOWANCE_NAMES.OTHER, other, 'OTHER');

      // Non-empty cells that cannot be read are reported instead of being silently dropped
      // (a date or amount is never invented or skipped without telling the user).
      const invalid: string[] = [];
      const hijri: string[] = [];
      for (const [field, label] of DATE_FIELD_LABELS) {
        const text = cellText(raw[field]);
        if (!text) continue;
        const parsed = cellDate(raw[field]);
        if (!parsed) invalid.push(label);
        else {
          const h = hijriLikeDateError(label, parsed, typeof raw[field] === 'string' ? text : null);
          if (h) hijri.push(h);
        }
      }
      for (const [field, label] of NUMBER_FIELD_LABELS) {
        if (cellText(raw[field]) && cellNumber(raw[field]) === null) invalid.push(label);
      }
      const genderText = cellText(raw.gender);
      const gender = parseGenderLabel(genderText);
      if (genderText && !gender) invalid.push('الجنس (ذكر / أنثى)');
      const blocking = [...(invalid.length ? [`قيم غير صالحة: ${invalid.join('، ')}`] : []), ...hijri, ...rowErrors];
      if (blocking.length) {
        errors.push({ row: rowNum, name: displayName, reason: blocking.join(' — '), warnings: rowWarnings.length ? rowWarnings : undefined });
        continue;
      }

      const nationality = normalizeNationality(cellText(raw.nationality));
      // DEC-002/003: a new employee must have an explicit nationality (no default).
      if (!existingEmp && !nationality) {
        errors.push({ row: rowNum, name: displayName, reason: NATIONALITY_REQUIRED_MESSAGE, warnings: rowWarnings.length ? rowWarnings : undefined });
        continue;
      }
      // WP-3 / HR-07: no default gender (it decides maternity-leave eligibility). A new employee needs
      // one; an update row with a blank cell keeps the stored value and says so.
      if (!gender) {
        if (!existingEmp) {
          errors.push({ row: rowNum, name: displayName, reason: GENDER_REQUIRED_MESSAGE, warnings: rowWarnings.length ? rowWarnings : undefined });
          continue;
        }
        const stored = existingEmp.gender === 'MALE' || existingEmp.gender === 'FEMALE' ? GENDER_LABELS[existingEmp.gender] : existingEmp.gender;
        rowWarnings.push(`خانة الجنس فارغة — أُبقيت القيمة الحالية (${stored || 'غير محددة'})`);
      }

      // Date logic: blocking for a new employee, a warning on update (existing records are not rejected).
      const dateIssues = employeeDateIssues({
        dateOfBirth: dateOfBirth ?? existingEmp?.dateOfBirth ?? null,
        joinDate: joinDate ?? existingEmp?.joinDate ?? null,
        contractEndDate: contractEndDate ?? existingEmp?.contractEndDate ?? null,
      });
      if (!existingEmp && dateIssues.errors.length) {
        errors.push({ row: rowNum, name: displayName, reason: dateIssues.errors.join(' — '), warnings: rowWarnings.length ? rowWarnings : undefined });
        continue;
      }
      for (const msg of [...dateIssues.errors, ...dateIssues.warnings]) rowWarnings.push(msg);
      const bankName = resolveBankName(cellText(raw.bankName), cellText(raw.swiftCode));
      const txt = (v: ImportCell | undefined) => cellText(v) || null;
      const iban = txt(raw.ibanNumber) ? normalizeIban(cellText(raw.ibanNumber)) : null;

      // Data-quality warnings (IBAN, shared IBAN, ID format, nationality vs ID, probation, zero salary,
      // non-Saudi without a contract end date).
      for (const w of employeeDataWarnings({
        ibanNumber: iban,
        iqamaOrIdNumber: idNumber,
        idType: existingEmp?.idType ?? null,
        nationality: nationality ?? existingEmp?.nationality ?? null,
        probationDays: probDays,
        // New employee: a blank salary is stored as 0, so it is checked as 0.
        basicSalary: existingEmp ? basicSalary : (basicSalary ?? 0),
        contractEndDate: contractEndDate ?? existingEmp?.contractEndDate ?? null,
        ibanSharedWith: ibanSharedWithOfRow(rowNum, iban),
      })) {
        rowWarnings.push(w.message);
      }
      const rowWarningList = rowWarnings.length ? [...rowWarnings] : undefined;
      const pushWarnings = () => {
        for (const message of rowWarnings) warnings.push({ row: rowNum, name: displayName, message });
      };

      try {
        if (existingEmp) {
          // ---- Update: only non-empty cells overwrite existing data ----
          // Names are not overwritten on update (same as before): the ID number is the match key.
          const updateData: Prisma.EmployeeUncheckedUpdateInput = {};
          if (nationality) updateData.nationality = nationality;
          if (gender) updateData.gender = gender;
          if (txt(raw.passportNumber)) updateData.passportNumber = cellText(raw.passportNumber);
          if (txt(raw.healthCertificateNum)) updateData.healthCertificateNum = cellText(raw.healthCertificateNum);
          if (txt(raw.maritalStatus)) updateData.maritalStatus = cellText(raw.maritalStatus);
          if (txt(raw.mobileNumber)) updateData.mobileNumber = cellText(raw.mobileNumber);
          if (txt(raw.email)) updateData.email = cellText(raw.email).toLowerCase();
          if (iban) updateData.ibanNumber = iban;
          if (bankName) updateData.bankName = bankName;
          if (txt(raw.jobTitle)) updateData.jobTitle = cellText(raw.jobTitle);
          if (txt(raw.workSchedule)) updateData.workSchedule = cellText(raw.workSchedule);
          if (basicSalary !== null) updateData.basicSalary = roundMoney(basicSalary);
          if (gosiDeduction !== null) updateData.gosiDeduction = roundMoney(gosiDeduction);
          if (txt(raw.salaryPaymentMethod)) updateData.salaryPaymentMethod = salaryPaymentMethod;
          if (txt(raw.accommodationType)) updateData.accommodationType = accommodationType;
          if (txt(raw.contractType)) updateData.contractType = contractType;
          if (noticeDays !== null) updateData.noticePeriodDays = Math.max(0, Math.round(noticeDays));
          if (legalCompanyId) updateData.legalCompanyId = legalCompanyId;
          if (actualCompanyId) updateData.actualCompanyId = actualCompanyId;
          if (administrationId) updateData.administrationId = administrationId;
          if (branchId) updateData.branchId = branchId;
          if (departmentId) updateData.departmentId = departmentId;
          if (directManagerId) updateData.directManagerId = directManagerId;
          if (dateOfBirth) updateData.dateOfBirth = dateOfBirth;
          if (joinDate) updateData.joinDate = joinDate;
          if (leaveAccrualStartDate) updateData.leaveAccrualStartDate = leaveAccrualStartDate;
          if (contractEndDate) updateData.contractEndDate = contractEndDate;
          if (iqamaOrIdExp) updateData.iqamaOrIdExp = iqamaOrIdExp;
          if (passportExp) updateData.passportExp = passportExp;
          if (healthCertificateExp) updateData.healthCertificateExp = healthCertificateExp;
          if (probationEndDate) updateData.probationEndDate = probationEndDate;

          if (!validateOnly) {
            await prisma.$transaction(async (tx) => {
              if (Object.keys(updateData).length) {
                // Fields listed in the employee's incomplete-data warning that this row completes are removed from it.
                const current = await tx.employee.findUnique({ where: { id: existingEmp.id }, select: REVIEW_STATE_SELECT });
                const note = current ? reviewNoteAfterEdit(current, updateData) : undefined;
                if (note !== undefined) updateData.dataReviewNote = note;
                await tx.employee.update({ where: { id: existingEmp.id }, data: updateData });
              }
              // Replace recurring allowances only when the row carries allowance amounts.
              // One-off bonuses (isMonthly=false) are never touched.
              if (allowances.length > 0) {
                await tx.allowance.deleteMany({ where: { employeeId: existingEmp.id, isMonthly: true } });
                await tx.allowance.createMany({
                  data: allowances.map((a) => ({ employeeId: existingEmp.id, ...a, isMonthly: true })),
                });
              }
            });
          }

          if (joinDate) existingEmp.joinDate = joinDate;
          if (branchId) existingEmp.branchId = branchId;
          if (nationality) existingEmp.nationality = nationality;
          if (gender) existingEmp.gender = gender;
          if (dateOfBirth) existingEmp.dateOfBirth = dateOfBirth;
          if (contractEndDate) existingEmp.contractEndDate = contractEndDate;
          if (legalCompanyId) existingEmp.legalCompanyId = legalCompanyId;
          if (actualCompanyId) existingEmp.actualCompanyId = actualCompanyId;
          if (administrationId) existingEmp.administrationId = administrationId;
          success.push({
            row: rowNum,
            name: displayName,
            empId: existingEmp.employeeId,
            status: 'updated',
            details: validateOnly ? 'سيتم تحديث البيانات والرواتب' : 'تم تحديث البيانات والرواتب بنجاح',
            warnings: rowWarningList,
          });
          pushWarnings();
        } else {
          // ---- Create: required dates must be present (no invented values) ----
          const missing: string[] = [];
          if (!dateOfBirth) missing.push('تاريخ الميلاد');
          if (!iqamaOrIdExp) missing.push('تاريخ انتهاء الهوية / الإقامة');
          if (!joinDate) missing.push('تاريخ مباشرة العمل');
          if (!dateOfBirth || !iqamaOrIdExp || !joinDate || !nationality || !gender) {
            errors.push({ row: rowNum, name: firstNameArabic, reason: `حقول مطلوبة مفقودة أو غير صالحة: ${missing.join('، ')}`, warnings: rowWarningList });
            continue;
          }

          const createData: Omit<Prisma.EmployeeUncheckedCreateInput, 'employeeId'> = {
            firstNameArabic,
            lastNameArabic,
            firstNameEnglish,
            lastNameEnglish,
            nationality,
            iqamaOrIdNumber: idNumber,
            iqamaOrIdExp,
            passportNumber: txt(raw.passportNumber),
            passportExp,
            healthCertificateNum: txt(raw.healthCertificateNum),
            healthCertificateExp,
            dateOfBirth,
            gender,
            maritalStatus: txt(raw.maritalStatus),
            mobileNumber: txt(raw.mobileNumber),
            email: txt(raw.email)?.toLowerCase() ?? null,
            ibanNumber: iban,
            bankName,
            salaryPaymentMethod,
            legalCompanyId,
            actualCompanyId,
            administrationId,
            branchId,
            departmentId,
            jobTitle: txt(raw.jobTitle),
            workSchedule: txt(raw.workSchedule),
            accommodationType,
            joinDate,
            contractType,
            contractEndDate,
            probationEndDate,
            noticePeriodDays: noticeDays !== null ? Math.max(0, Math.round(noticeDays)) : 30,
            leaveAccrualStartDate: leaveAccrualStartDate ?? joinDate,
            basicSalary: roundMoney(basicSalary ?? 0),
            gosiDeduction: roundMoney(gosiDeduction ?? 0),
            directManagerId,
            allowances: allowances.length ? { create: allowances.map((a) => ({ ...a, isMonthly: true })) } : undefined,
          };

          let created: KnownEmployee;
          if (validateOnly) {
            // Dry run: nothing is written; later rows can still reference this one (manager / duplicate ID).
            created = {
              id: `dry-run-row-${rowNum}`,
              employeeId: '',
              iqamaOrIdNumber: idNumber,
              firstNameArabic,
              lastNameArabic,
              joinDate,
              branchId,
              nationality,
              idType: null,
              gender,
              dateOfBirth,
              contractEndDate,
              legalCompanyId,
              actualCompanyId,
              administrationId,
            };
          } else {
            const res = await createWithEmployeeCode(
              prisma,
              (code, tx) =>
                tx.employee.create({
                  data: { ...createData, employeeId: code },
                  select: KNOWN_EMPLOYEE_SELECT,
                }),
              { start: nextCodeNumber },
            );
            created = res.result;
            nextCodeNumber = res.codeNumber + 1;
          }

          byIdNumber.set(idNumber, created);
          knownEmployees.push(created);
          success.push({
            row: rowNum,
            name: displayName,
            empId: created.employeeId,
            status: 'created',
            details: validateOnly ? 'سيتم إنشاء موظف جديد' : undefined,
            warnings: rowWarningList,
          });
          pushWarnings();
        }
      } catch (err) {
        console.error(`[employees/import] row ${rowNum} failed:`, err instanceof Error ? err.message : err);
        errors.push({ row: rowNum, name: firstNameArabic, reason: rowErrorReason(err), warnings: rowWarningList });
      }
    }

    const createdCount = success.filter((s) => s.status === 'created').length;
    const updatedCount = success.length - createdCount;

    if (!validateOnly) {
      await logAudit({
        userId: user.id,
        action: 'IMPORT',
        entityType: 'Employee',
        details: {
          fileName: file.name,
          totalRows: rows.length,
          created: createdCount,
          updated: updatedCount,
          errors: errors.length,
          warnings: warnings.length,
        },
        ipAddress: getClientIp(req),
      });
    }

    const warnPart = warnings.length > 0 ? ` و${warnings.length} تنبيه` : '';
    const message = validateOnly
      ? `فحص تجريبي (لم يُحفظ أي شيء): ${success.length} صف جاهز للاستيراد (${createdCount} جديد، ${updatedCount} تحديث)، ${errors.length} خطأ${warnPart}`
      : `تم استيراد ${success.length} موظف بنجاح${errors.length > 0 ? ` مع ${errors.length} خطأ` : ''}${warnPart}`;

    return NextResponse.json({
      message,
      validateOnly,
      totalRows: rows.length,
      successCount: success.length,
      createdCount,
      updatedCount,
      errorCount: errors.length,
      warningCount: warnings.length,
      success,
      errors,
      warnings,
    });
  } catch (err) {
    return handleApiError(err, 'employees/import:POST');
  }
}
