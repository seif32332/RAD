// Employee domain helpers: employee-code allocation, direct-manager validation,
// response shapes (selects) and the Excel import/template column definitions.
//
// Pure helpers (no DB) are exported separately so they can be unit-tested.
import { Prisma, type LeaveStatus, type PrismaClient } from '@prisma/client';
import { badRequest } from '@/lib/http';
import { BALANCE_CONSUMING_STATUSES } from '@/lib/leave';
import { addDays, parseDateOnly, todayKey } from '@/lib/dates';
import { z } from 'zod';
import { zOptText, zOptDate, zMoney, zInt, zOptMoney } from '@/lib/validation';
import { SAUDI_BANKS } from '@/lib/banks';
import {
  NATIONALITY_REQUIRED_MESSAGE,
  SAUDI_NATIONALITY,
  normalizeNationality,
  parseGosiRegime as parseGosiRegimeValue,
  dataReviewFields as dataReviewFieldsOf,
  resolveDataReviewNote as resolveReviewNote,
  type DataReviewField,
} from '@/lib/employee-shared';
import { ROLE_GROUPS, roleIn } from '@/lib/constants';
import { ID_TYPES, parseIdType } from '@/lib/identity';

type DbClient = PrismaClient | Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Employee code (Employee.employeeId, e.g. "EMP-0001")
// ---------------------------------------------------------------------------

export const EMPLOYEE_CODE_PREFIX = 'EMP-';
const EMPLOYEE_CODE_RE = /^EMP-(\d+)$/;

/** 1 -> "EMP-0001", 12345 -> "EMP-12345". */
export function formatEmployeeCode(n: number): string {
  return `${EMPLOYEE_CODE_PREFIX}${Math.max(1, Math.trunc(n)).toString().padStart(4, '0')}`;
}

/** "EMP-0042" -> 42; anything else -> null. */
export function parseEmployeeCodeNumber(code: string | null | undefined): number | null {
  const m = typeof code === 'string' ? code.trim().match(EMPLOYEE_CODE_RE) : null;
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}

/** Highest numeric suffix among EMP-xxxx codes (0 when none). */
export function maxEmployeeCodeNumberOf(codes: Array<string | null | undefined>): number {
  let max = 0;
  for (const c of codes) {
    const n = parseEmployeeCodeNumber(c);
    if (n !== null && n > max) max = n;
  }
  return max;
}

/** Highest numeric suffix of existing EMP-xxxx codes in the database (0 when none). */
export async function maxEmployeeCodeNumber(client: DbClient): Promise<number> {
  const rows = await client.$queryRaw<Array<{ max: number | bigint | null }>>(
    Prisma.sql`SELECT MAX(CAST(SUBSTRING("employeeId" FROM 5) AS BIGINT)) AS "max"
               FROM "Employee"
               WHERE "employeeId" ~ '^EMP-[0-9]{1,15}$'`,
  );
  const v = rows[0]?.max;
  return v === null || v === undefined ? 0 : Number(v);
}

/** Arbitrary constant key of the Postgres advisory lock that serializes employee-code allocation. */
const EMPLOYEE_CODE_LOCK_KEY = 72_917_001;

/** True for the root PrismaClient (it can open transactions); false for a transaction client. */
function isRootClient(client: DbClient): client is PrismaClient {
  return '$transaction' in client;
}

/**
 * Takes the transaction-scoped advisory lock that serializes employee-code allocation.
 * Released automatically when the surrounding transaction commits / rolls back.
 */
export async function lockEmployeeCodes(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${EMPLOYEE_CODE_LOCK_KEY}::bigint)`;
}

/**
 * Next free employee code: max existing numeric suffix + 1.
 * Inside a transaction it first takes the allocation lock, so concurrent transactions that
 * create employees get distinct codes (the lock is held until the insert commits).
 */
export async function nextEmployeeCode(client: DbClient): Promise<string> {
  if (!isRootClient(client)) await lockEmployeeCodes(client);
  return formatEmployeeCode((await maxEmployeeCodeNumber(client)) + 1);
}

/** True when `err` is a unique-constraint violation (P2002) on `field`. */
export function isUniqueViolationOn(err: unknown, field: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  const target = err.meta?.target;
  if (Array.isArray(target)) return target.some((t) => String(t) === field);
  if (typeof target === 'string') return target === field || target.includes(`_${field}_`);
  return false;
}

export const EMPLOYEE_CODE_MAX_ATTEMPTS = 5;

/** Interactive-transaction options for code allocation: waiting for the lock counts toward the timeout. */
const CODE_TX_OPTIONS = { maxWait: 15_000, timeout: 30_000 } as const;

/**
 * Runs `create(code, tx)` with a freshly allocated employee code inside a transaction that holds
 * the allocation lock (see lockEmployeeCodes), so concurrent requests never pick the same code.
 * `create` MUST write through `tx`. A P2002 on employeeId (a code written by a path that does not
 * take the lock) is retried with a higher code, up to 5 attempts.
 * `start` is a lower bound for the code number (bulk import passes the next number it expects).
 */
export async function createWithEmployeeCode<T>(
  client: DbClient,
  create: (code: string, tx: Prisma.TransactionClient) => Promise<T>,
  opts: { start?: number } = {},
): Promise<{ result: T; code: string; codeNumber: number }> {
  let floor = opts.start && opts.start > 0 ? opts.start : 0;
  const attemptOnce = async (tx: Prisma.TransactionClient) => {
    await lockEmployeeCodes(tx);
    const n = Math.max((await maxEmployeeCodeNumber(tx)) + 1, floor);
    const code = formatEmployeeCode(n);
    try {
      return { result: await create(code, tx), code, codeNumber: n };
    } catch (err) {
      if (isUniqueViolationOn(err, 'employeeId')) floor = n + 1;
      throw err;
    }
  };
  for (let attempt = 1; attempt <= EMPLOYEE_CODE_MAX_ATTEMPTS; attempt++) {
    try {
      // Already inside a transaction: a failed statement aborts it, so there is no retry there.
      if (!isRootClient(client)) return await attemptOnce(client);
      return await client.$transaction((tx) => attemptOnce(tx), CODE_TX_OPTIONS);
    } catch (err) {
      if (isRootClient(client) && attempt < EMPLOYEE_CODE_MAX_ATTEMPTS && isUniqueViolationOn(err, 'employeeId')) continue;
      throw err;
    }
  }
  // Unreachable: the last attempt either returns or throws.
  throw new Error('employee code allocation failed');
}

// ---------------------------------------------------------------------------
// Direct manager validation
// ---------------------------------------------------------------------------

/** Pure check: an employee can't be their own manager. Returns an error message or null. */
export function directManagerError(employeeId: string | null | undefined, managerId: string | null | undefined): string | null {
  if (!managerId) return null;
  if (employeeId && managerId === employeeId) return 'لا يمكن أن يكون الموظف مديراً مباشراً لنفسه';
  return null;
}

/**
 * Validates a direct manager: not self, exists, and does not create a reporting cycle
 * (the manager's chain must not lead back to this employee). Throws HttpError(400).
 */
export async function assertValidDirectManager(
  client: DbClient,
  employeeId: string | null,
  managerId: string | null | undefined,
): Promise<void> {
  if (!managerId) return;
  const selfErr = directManagerError(employeeId, managerId);
  if (selfErr) throw badRequest(selfErr);

  const manager = await client.employee.findUnique({ where: { id: managerId }, select: { id: true, directManagerId: true } });
  if (!manager) throw badRequest('المدير المباشر المحدد غير موجود');
  if (!employeeId) return;

  // Walk up the chain (bounded) to detect cycles.
  const seen = new Set<string>([manager.id]);
  let next = manager.directManagerId;
  for (let depth = 0; next && depth < 50; depth++) {
    if (next === employeeId) throw badRequest('لا يمكن اختيار هذا المدير لأنه يتبع الموظف نفسه في التسلسل الإداري');
    if (seen.has(next)) break;
    seen.add(next);
    const row = await client.employee.findUnique({ where: { id: next }, select: { directManagerId: true } });
    next = row?.directManagerId ?? null;
  }
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

/** Non-sensitive fields: safe for any back-office user and for dropdowns (?fields=basic). */
export const EMPLOYEE_BASIC_SELECT = {
  id: true,
  employeeId: true,
  userId: true,
  firstNameArabic: true,
  lastNameArabic: true,
  firstNameEnglish: true,
  lastNameEnglish: true,
  jobTitle: true,
  legalCompanyId: true,
  actualCompanyId: true,
  administrationId: true,
  branchId: true,
  departmentId: true,
  directManagerId: true,
  joinDate: true,
  leaveAccrualStartDate: true,
  isTerminated: true,
  terminationDate: true,
  employmentStatus: true,
  createdAt: true,
  branch: { select: { id: true, nameArabic: true } },
  department: { select: { id: true, nameArabic: true } },
} satisfies Prisma.EmployeeSelect;

const ORG_NAME_SELECT = { select: { id: true, nameArabic: true, nameEnglish: true } } as const;
const MANAGER_SELECT = { select: { id: true, employeeId: true, firstNameArabic: true, lastNameArabic: true } } as const;

/** Full list (HR / payroll): every scalar plus the relations the list, leave and settlement pages use. */
export const EMPLOYEE_LIST_FULL_INCLUDE = {
  legalCompany: ORG_NAME_SELECT,
  actualCompany: ORG_NAME_SELECT,
  administration: ORG_NAME_SELECT,
  branch: ORG_NAME_SELECT,
  department: ORG_NAME_SELECT,
  directManager: MANAGER_SELECT,
  // Approved + completed (returned) leaves: both consume the balance (same set as src/lib/leave.ts).
  leaves: {
    where: { status: { in: BALANCE_CONSUMING_STATUSES as LeaveStatus[] } },
    select: {
      id: true,
      leaveType: true,
      status: true,
      startDate: true,
      endDate: true,
      totalDays: true,
      paidDays: true,
      unpaidDays: true,
      isReturned: true,
      actualReturnDate: true,
      createdAt: true,
      // Read by the settlement page to pre-fill a leave settlement (outside KSA / flight ticket).
      isOutsideKSA: true,
      flightTicketOption: true,
      flightTicketAmount: true,
    },
  },
  // Only recurring allowances belong to the salary; one-off bonuses are paid by payroll.
  allowances: {
    where: { isMonthly: true },
    select: { id: true, name: true, amount: true, isMonthly: true, allowanceType: true },
  },
  loans: {
    select: {
      id: true,
      amount: true,
      monthlyInstallment: true,
      remainingAmount: true,
      status: true,
      isForgiven: true,
      createdAt: true,
    },
  },
  overtimeRequests: {
    where: { status: 'APPROVED' },
    select: { id: true, date: true, type: true, hours: true, amount: true, status: true },
  },
} satisfies Prisma.EmployeeInclude;

/** Single employee (HR / payroll): profile page + edit page. */
export const EMPLOYEE_DETAIL_INCLUDE = {
  legalCompany: ORG_NAME_SELECT,
  actualCompany: ORG_NAME_SELECT,
  administration: ORG_NAME_SELECT,
  branch: ORG_NAME_SELECT,
  department: ORG_NAME_SELECT,
  directManager: MANAGER_SELECT,
  allowances: { orderBy: { createdAt: 'asc' } },
  loans: { orderBy: { createdAt: 'desc' } },
  assets: true,
} satisfies Prisma.EmployeeInclude;

// ---------------------------------------------------------------------------
// Who sees what (GET /api/employees and /api/employees/[id])
// ---------------------------------------------------------------------------

/**
 * - full:    HR group (SUPER_ADMIN, COMPANY_ADMIN, HR_MANAGER): every field, every employee.
 * - payroll: FINANCE_MANAGER / PAYROLL_ADMIN: salary, bank, allowances, join date... but not the
 *            identity documents (PAYROLL_HIDDEN_FIELDS).
 * - team:    BRANCH_MANAGER / DEPT_MANAGER: basic fields of their team only (managedEmployeesWhere).
 * - basic:   other back-office roles: basic fields (dropdowns).
 */
export type EmployeeAccessLevel = 'full' | 'payroll' | 'team' | 'basic';

export function employeeAccessLevel(role: string | null | undefined): EmployeeAccessLevel {
  if (roleIn(role, ROLE_GROUPS.HR)) return 'full';
  if (roleIn(role, ROLE_GROUPS.PAYROLL)) return 'payroll';
  if (role === 'BRANCH_MANAGER' || role === 'DEPT_MANAGER') return 'team';
  return 'basic';
}

/**
 * Data that payroll / finance users do not need: identity (ID & passport numbers, birth date, document
 * copies) and health / disability (isDisabled, muawamaCertExpiry: same list as WORKFORCE_PAYROLL_HIDDEN_FIELDS
 * in src/app/api/employees/_workforce-fields.ts, kept here so every redactForPayroll caller drops them).
 */
export const PAYROLL_HIDDEN_FIELDS = [
  'iqamaOrIdNumber',
  'passportNumber',
  'dateOfBirth',
  'iqamaCopyUrl',
  'passportCopyUrl',
  'isDisabled',
  'muawamaCertExpiry',
] as const;

/** Copy of an employee row without PAYROLL_HIDDEN_FIELDS. */
export function redactForPayroll<T extends object>(row: T): Omit<T, (typeof PAYROLL_HIDDEN_FIELDS)[number]> {
  const out = { ...row } as Record<string, unknown>;
  for (const f of PAYROLL_HIDDEN_FIELDS) delete out[f];
  return out as Omit<T, (typeof PAYROLL_HIDDEN_FIELDS)[number]>;
}

/** Stored date-only values are equal (both missing counts as equal). */
function sameInstant(a: Date | null | undefined, b: Date | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.getTime() === b.getTime();
}

/**
 * Fields of a review note that an edit completed: the edit sent a non-empty value that differs
 * from the stored one (re-saving the placeholder date filled at onboarding does not count).
 */
export function completedReviewFields(
  current: Partial<Record<string, unknown>>,
  next: Partial<Record<string, unknown>>,
): string[] {
  const out: string[] = [];
  for (const [field, v] of Object.entries(next)) {
    if (v === undefined || v === null || v === '') continue;
    const cur = current[field];
    const changed = v instanceof Date ? !(cur instanceof Date) || !sameInstant(cur, v) : String(cur ?? '') !== String(v);
    if (changed) out.push(field);
  }
  return out;
}

/** Current values of the fields a review note may list (+ the note itself): the `current` of reviewNoteAfterEdit. */
export const REVIEW_STATE_SELECT = {
  id: true,
  dataReviewNote: true,
  dateOfBirth: true,
  iqamaOrIdExp: true,
  joinDate: true,
  nationality: true,
  iqamaOrIdNumber: true,
  passportNumber: true,
  passportExp: true,
  ibanNumber: true,
  bankName: true,
  mobileNumber: true,
} satisfies Prisma.EmployeeSelect & Record<DataReviewField, true>;

/**
 * New Employee.dataReviewNote after an edit (`edit` = the values being written, by field name),
 * or undefined when the note does not change. Only the fields the note lists are considered.
 */
export function reviewNoteAfterEdit(
  current: { dataReviewNote: string | null } & Partial<Record<string, unknown>>,
  edit: Partial<Record<string, unknown>>,
): string | null | undefined {
  if (!current.dataReviewNote) return undefined;
  const listed = dataReviewFieldsOf(current.dataReviewNote);
  if (!listed.length) return undefined;
  const sent = Object.fromEntries(listed.map((f) => [f, edit[f]]));
  const resolved = resolveReviewNote(current.dataReviewNote, completedReviewFields(current, sent));
  return resolved === current.dataReviewNote ? undefined : resolved;
}

// ---------------------------------------------------------------------------
// Allowance helpers
// ---------------------------------------------------------------------------

export interface AllowanceInput {
  id?: string | null;
  name: string;
  amount: number;
  /** Allowance.countsTowardGosi; missing -> defaultCountsTowardGosi(name). */
  countsTowardGosi?: boolean | null;
}

/**
 * Default of Allowance.countsTowardGosi when the caller does not say: true for housing allowances
 * (same rule as the migration backfill), false otherwise. HR can change it per allowance.
 */
export function defaultCountsTowardGosi(name: string | null | undefined): boolean {
  return allowanceBucket(name) === 'housing';
}

/**
 * Given the allowances submitted by the edit form and the employee's current one-off
 * allowances (isMonthly=false), returns the entries that should be (re)created as monthly
 * allowances with their GOSI-base flag. Rows whose id belongs to a one-off bonus are left untouched.
 */
export function monthlyAllowanceRows(
  submitted: AllowanceInput[],
  oneOffIds: Iterable<string>,
): Array<{ name: string; amount: number; countsTowardGosi: boolean }> {
  const skip = new Set(oneOffIds);
  return submitted
    .filter((a) => !(a.id && skip.has(a.id)))
    .filter((a) => a.name.trim() !== '' && Number.isFinite(a.amount) && a.amount > 0)
    .map((a) => ({
      name: a.name.trim(),
      amount: a.amount,
      countsTowardGosi: typeof a.countsTowardGosi === 'boolean' ? a.countsTowardGosi : defaultCountsTowardGosi(a.name),
    }));
}

/** monthlyAllowanceRows without the GOSI flag (kept for existing callers). */
export function monthlyAllowancesToCreate(submitted: AllowanceInput[], oneOffIds: Iterable<string>): Array<{ name: string; amount: number }> {
  return monthlyAllowanceRows(submitted, oneOffIds).map(({ name, amount }) => ({ name, amount }));
}

// ---------------------------------------------------------------------------
// Canonical values shared by the employee form, the Excel import and the export
// ---------------------------------------------------------------------------

// Nationality / GOSI / warning helpers live in the client-safe src/lib/employee-shared.ts
// (the pages use them too) and are re-exported here for the API routes.
export {
  DEFAULT_NATIONALITY,
  SAUDI_NATIONALITY,
  NATIONALITY_REQUIRED_MESSAGE,
  GOSI_REGIMES,
  GOSI_REGIME_LABELS,
  PROBATION_WARNING_DAYS,
  employeeDataWarnings,
  sharedIbanWarning,
  NON_SAUDI_CONTRACT_END_WARNING,
  parseGosiRegime,
  probationWarning,
  normalizeNationality,
  isSaudiNationalityValue,
  DATA_REVIEW_FIELD_LABELS,
  dataReviewFields,
  resolveDataReviewNote,
  type DataReviewField,
  type EmployeeDataWarning,
  type GosiRegimeValue,
} from '@/lib/employee-shared';

/** Create (POST /api/employees): nationality is required (no default); legacy Saudi spellings are normalized. */
export const zRequiredNationality = z.preprocess(
  (v) => (v === undefined || v === null || typeof v === 'string' ? (normalizeNationality(v) ?? '') : v),
  z.string({ invalid_type_error: NATIONALITY_REQUIRED_MESSAGE }).min(1, NATIONALITY_REQUIRED_MESSAGE).max(100),
);
/**
 * @deprecated Blank -> Saudi silently. DEC-002/003 removed this default and no employee route uses
 * it any more (use zRequiredNationality). Kept only until its old unit test is retired.
 */
export const zNationalityOrDefault = z.preprocess(
  (v) => (v === undefined || v === null || typeof v === 'string' ? (normalizeNationality(v) ?? SAUDI_NATIONALITY) : v),
  z.string().max(100),
);

/** Optional GOSI / identity fields shared by POST and PUT /api/employees ('' -> null clears). */
const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);
export const employeeGosiFieldsSchema = z.object({
  gosiRegime: z
    .preprocess((v) => (v === '' || v === null ? undefined : typeof v === 'string' ? (parseGosiRegimeValue(v) ?? v) : v), z.enum(['OLD', 'NEW', 'UNKNOWN'], {
      errorMap: () => ({ message: 'قيمة نظام التأمينات غير صالحة (OLD / NEW / UNKNOWN)' }),
    }))
    .optional(),
  gosiRegistrationSource: z.preprocess(blankToNull, z.string().trim().max(300).nullable()).optional(),
  gosiNumber: z.preprocess(blankToNull, z.string().trim().max(50).nullable()).optional(),
  idType: z
    .preprocess((v) => (typeof v === 'string' ? (v.trim() === '' ? null : (parseIdType(v) ?? v)) : v), z.enum(ID_TYPES, {
      errorMap: () => ({ message: 'نوع الهوية غير صالح' }),
    }).nullable())
    .optional(),
});

/**
 * Setting a confirmed GOSI regime (OLD / NEW) needs the source it was confirmed from (DEC-003:
 * "مع مستند المصدر"). Returns an Arabic error or null. `storedSource` is the value already saved.
 */
export function gosiRegimeSourceError(
  regime: string | null | undefined,
  source: string | null | undefined,
  storedSource?: string | null,
): string | null {
  if (regime !== 'OLD' && regime !== 'NEW') return null;
  const effective = source === undefined ? storedSource : source;
  return effective && effective.trim() ? null : 'تأكيد نظام التأمينات (قديم / جديد) يتطلب ذكر مصدر التأكيد (شهادة اشتراك أو قائمة GOSI للمنشأة)';
}
/** Update: blank / missing -> undefined (unchanged). */
export const zOptNationality = z.preprocess(
  (v) => (v === undefined || v === null || typeof v === 'string' ? (normalizeNationality(v) ?? undefined) : v),
  z.string().max(100).optional(),
);

export const GENDERS = ['MALE', 'FEMALE'] as const;
export type Gender = (typeof GENDERS)[number];
export const GENDER_LABELS: Record<Gender, string> = { MALE: 'ذكر', FEMALE: 'أنثى' };

/** 'MALE' / 'ذكر' / 'm' -> MALE, 'FEMALE' / 'أنثى' / 'f' -> FEMALE, blank or unknown -> null. */
export function parseGenderLabel(v: unknown): Gender | null {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  if (['male', 'm', 'ذكر', 'ذ', 'رجل'].includes(s)) return 'MALE';
  if (['female', 'f', 'أنثى', 'انثى', 'أنثي', 'انثي', 'ا', 'أ', 'امرأة'].includes(s)) return 'FEMALE';
  return null;
}

/** Update: blank / missing -> undefined (unchanged); labels accepted; anything else is a 400. */
export const zOptGender = z.preprocess(
  (v) => (v === undefined || v === null || v === '' ? undefined : (parseGenderLabel(v) ?? v)),
  z.enum(GENDERS, { errorMap: () => ({ message: 'قيمة الجنس غير صالحة (MALE / FEMALE)' }) }).optional(),
);
/** Arabic 400 message when a new employee (form / API / import row) has no gender. */
export const GENDER_REQUIRED_MESSAGE = 'الجنس مطلوب: اختر ذكر أو أنثى صراحةً (لا توجد قيمة افتراضية)';
const GENDER_INVALID_MESSAGE = 'قيمة الجنس غير صالحة: اختر ذكر أو أنثى';

/**
 * Create (POST /api/employees): MALE or FEMALE (Arabic / English labels accepted). A blank value is
 * an error, never a silent MALE: the gender decides maternity-leave eligibility (council HR-07 / UX-11).
 */
export const zRequiredGender = z.preprocess(
  (v) => (v === undefined || v === null || (typeof v === 'string' && v.trim() === '') ? undefined : (parseGenderLabel(v) ?? v)),
  z.enum(GENDERS, {
    errorMap: (issue) => ({
      message: issue.code === 'invalid_type' && issue.received === 'undefined' ? GENDER_REQUIRED_MESSAGE : GENDER_INVALID_MESSAGE,
    }),
  }),
);

export const CONTRACT_TYPE_LABELS = { FULL_TIME: 'دوام كامل', PART_TIME: 'دوام جزئي', FREELANCE: 'عمل حر/مستقل' } as const;
export const PAYMENT_METHOD_LABELS = { BANK_TRANSFER: 'تحويل بنكي', WPS: 'مدد (حماية الأجور)', CASH: 'كاش نقدي' } as const;
export const ACCOMMODATION_LABELS = { INSIDE_COMPANY: 'سكن الشركة', OUTSIDE_COMPANY: 'خارج الشركة' } as const;

/** Canonical names of the recurring allowances used by the employee form, the template and the import. */
export const ALLOWANCE_NAMES = { HOUSING: 'بدل سكن', TRANSPORT: 'بدل نقل', OTHER: 'بدلات أخرى' } as const;

/** Buckets a recurring allowance by its name (legacy spellings such as 'بدل السكن' / 'بدل المواصلات' included). */
export function allowanceBucket(name: string | null | undefined): 'housing' | 'transport' | 'other' {
  const n = (name ?? '').trim();
  if (/سكن|housing/i.test(n)) return 'housing';
  if (/نقل|مواصلات|transport/i.test(n)) return 'transport';
  return 'other';
}

/**
 * Maps a bank cell to the stored SAUDI_BANKS value ('الراجحي' or SWIFT 'RJHISARI' -> 'مصرف الراجحي').
 * Unknown banks are kept as typed. Blank -> null.
 */
export function resolveBankName(name: string | null | undefined, swift?: string | null): string | null {
  const n = (name ?? '').trim();
  const code = (swift ?? '').trim().toUpperCase();
  if (n) {
    const exact = SAUDI_BANKS.find((b) => b.value === n || b.label === n);
    if (exact) return exact.value;
    const partial = SAUDI_BANKS.find((b) => b.value.includes(n) || n.includes(b.value));
    if (partial) return partial.value;
  }
  if (code) {
    const byCode = SAUDI_BANKS.find((b) => code.startsWith(b.code));
    if (byCode) return byCode.value;
  }
  return n || null;
}

// ---------------------------------------------------------------------------
// Excel import / template
// ---------------------------------------------------------------------------

export const IMPORT_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 5000;

export interface ImportTemplateColumn {
  header: string;
  field: ImportField;
  /** 'text' keeps leading zeros (IDs, phones, IBAN); 'date' uses yyyy-mm-dd. */
  format?: 'text' | 'date';
  example: string;
  width?: number;
}

/** Column order of the template (GET /api/employees/import/template) and of the "current employees" export. */
export const IMPORT_TEMPLATE: readonly ImportTemplateColumn[] = [
  { header: 'الاسم بالكامل بالعربي', field: 'fullNameArabic', example: 'محمد أحمد العمري', width: 30 },
  { header: 'الاسم بالكامل بالإنجليزية', field: 'fullNameEnglish', example: 'Mohammed Ahmed Al-Omari', width: 30 },
  { header: 'الجنسية', field: 'nationality', example: SAUDI_NATIONALITY },
  { header: 'الجنس', field: 'gender', example: GENDER_LABELS.MALE, width: 12 },
  { header: 'تاريخ الميلاد', field: 'dateOfBirth', format: 'date', example: '1990-05-15' },
  { header: 'الحالة الاجتماعية', field: 'maritalStatus', example: 'متزوج' },
  { header: 'الجوال الشخصي', field: 'mobileNumber', format: 'text', example: '0551234567' },
  { header: 'البريد الإلكتروني', field: 'email', example: 'mohammed@example.com' },
  { header: 'الشركة القانونية التابع لها', field: 'legalCompanyName', example: '' },
  { header: 'الشركة الفعلية لمكان العمل', field: 'actualCompanyName', example: '' },
  { header: 'الإدارة المركزية', field: 'administrationName', example: '' },
  { header: 'الفرع المرتبط به', field: 'branchName', example: '' },
  { header: 'القسم الإداري', field: 'departmentName', example: '' },
  { header: 'المدير المباشر', field: 'directManager', example: '' },
  { header: 'المسمى الوظيفي المعتمد', field: 'jobTitle', example: 'محاسب' },
  { header: 'جدول العمل / الشفتات', field: 'workSchedule', example: '' },
  { header: 'محل السكن', field: 'accommodationType', example: '' },
  { header: 'نوع العقد', field: 'contractType', example: CONTRACT_TYPE_LABELS.FULL_TIME },
  { header: 'فترة الإشعار لإنهاء العقد', field: 'noticePeriodDays', example: '30' },
  { header: 'تاريخ مباشرة العمل (آلياً للتصفية النهائية)', field: 'joinDate', format: 'date', example: '2024-01-15' },
  { header: 'تاريخ احتساب الإجازة / العودة من آخر إجازة', field: 'leaveAccrualStartDate', format: 'date', example: '2024-01-15' },
  { header: 'تاريخ انتهاء العقد', field: 'contractEndDate', format: 'date', example: '2026-01-14' },
  { header: 'مدة فترة التجربة (بالأيام)', field: 'probationDays', example: '90' },
  { header: 'رقم الهوية / الإقامة', field: 'iqamaOrIdNumber', format: 'text', example: '1088888888' },
  { header: 'تاريخ انتهاء الصلاحية', field: 'iqamaOrIdExp', format: 'date', example: '2027-06-30' },
  { header: 'رقم جواز السفر', field: 'passportNumber', format: 'text', example: 'A12345678' },
  { header: 'تاريخ انتهاء الجواز', field: 'passportExp', format: 'date', example: '2028-12-31' },
  { header: 'رقم الشهادة الصحية', field: 'healthCertificateNum', format: 'text', example: '' },
  { header: 'تاريخ انتهاء الشهادة', field: 'healthCertificateExp', format: 'date', example: '' },
  { header: 'طريقة استلام الراتب', field: 'salaryPaymentMethod', example: PAYMENT_METHOD_LABELS.BANK_TRANSFER },
  { header: 'اسم البنك', field: 'bankName', example: 'مصرف الراجحي' },
  { header: 'رمز البنك (SWIFT)', field: 'swiftCode', format: 'text', example: 'RJHI' },
  { header: 'رقم الآيبان (IBAN)', field: 'ibanNumber', format: 'text', example: 'SA0380000000608010167519', width: 28 },
  { header: 'الراتب الأساسي الشهري', field: 'basicSalary', example: '5000' },
  { header: ALLOWANCE_NAMES.HOUSING, field: 'housingAllowance', example: '1500' },
  { header: ALLOWANCE_NAMES.TRANSPORT, field: 'transportAllowance', example: '500' },
  { header: ALLOWANCE_NAMES.OTHER, field: 'otherAllowances', example: '' },
  { header: 'خصم التأمينات الاجتماعية', field: 'gosiDeduction', example: '0' },
  { header: 'الراتب الشامل', field: 'totalSalary', example: '7000' },
];

export const IMPORT_TEMPLATE_COLUMNS: readonly string[] = IMPORT_TEMPLATE.map((c) => c.header);
/** Example row shown under the headers. */
export const IMPORT_EXAMPLE_ROW: readonly string[] = IMPORT_TEMPLATE.map((c) => c.example);
/** 0-based indexes of columns that must be Excel TEXT ('@'): mobile, ID, passport, health cert, SWIFT, IBAN. */
export const IMPORT_TEXT_COLUMNS: readonly number[] = IMPORT_TEMPLATE.flatMap((c, i) => (c.format === 'text' ? [i] : []));
/** 0-based indexes of date columns. */
export const IMPORT_DATE_COLUMNS: readonly number[] = IMPORT_TEMPLATE.flatMap((c, i) => (c.format === 'date' ? [i] : []));

export type ImportField =
  | 'fullNameArabic'
  | 'fullNameEnglish'
  | 'nationality'
  | 'gender'
  | 'dateOfBirth'
  | 'maritalStatus'
  | 'mobileNumber'
  | 'email'
  | 'legalCompanyName'
  | 'actualCompanyName'
  | 'administrationName'
  | 'branchName'
  | 'departmentName'
  | 'directManager'
  | 'jobTitle'
  | 'workSchedule'
  | 'accommodationType'
  | 'contractType'
  | 'noticePeriodDays'
  | 'joinDate'
  | 'leaveAccrualStartDate'
  | 'contractEndDate'
  | 'probationDays'
  | 'iqamaOrIdNumber'
  | 'iqamaOrIdExp'
  | 'passportNumber'
  | 'passportExp'
  | 'healthCertificateNum'
  | 'healthCertificateExp'
  | 'salaryPaymentMethod'
  | 'bankName'
  | 'swiftCode'
  | 'ibanNumber'
  | 'basicSalary'
  | 'housingAllowance'
  | 'transportAllowance'
  | 'otherAllowances'
  | 'gosiDeduction'
  | 'totalSalary';

/** Arabic header -> field. Several spellings are accepted. Order matters for partial matching. */
export const IMPORT_COLUMN_MAP: ReadonlyArray<readonly [string, ImportField]> = [
  ['الاسم بالكامل بالعربي', 'fullNameArabic'],
  ['الاسم بالكامل بالإنجليزية', 'fullNameEnglish'],
  ['الاسم بالكامل بالانجليزية', 'fullNameEnglish'],
  ['الجنسية', 'nationality'],
  ['الجنس', 'gender'],
  ['النوع', 'gender'],
  ['تاريخ الميلاد', 'dateOfBirth'],
  ['الحالة الاجتماعية', 'maritalStatus'],
  ['الجوال الشخصي', 'mobileNumber'],
  ['الجوال', 'mobileNumber'],
  ['رقم الجوال', 'mobileNumber'],
  ['البريد الإلكتروني', 'email'],
  ['البريد الالكتروني', 'email'],
  ['الشركة القانونية التابع لها', 'legalCompanyName'],
  ['الشركة الفعلية لمكان العمل', 'actualCompanyName'],
  ['الإدارة المركزية', 'administrationName'],
  ['الادارة المركزية', 'administrationName'],
  ['الفرع المرتبط به', 'branchName'],
  ['الفرع', 'branchName'],
  ['القسم الإداري', 'departmentName'],
  ['القسم الاداري', 'departmentName'],
  ['القسم', 'departmentName'],
  ['المدير المباشر', 'directManager'],
  ['المسمى الوظيفي المعتمد', 'jobTitle'],
  ['المسمى الوظيفي', 'jobTitle'],
  ['جدول العمل / الشفتات', 'workSchedule'],
  ['جدول العمل', 'workSchedule'],
  ['محل السكن', 'accommodationType'],
  ['نوع العقد', 'contractType'],
  ['فترة الإشعار لإنهاء العقد', 'noticePeriodDays'],
  ['فترة الاشعار لانهاء العقد', 'noticePeriodDays'],
  ['تاريخ مباشرة العمل (آلياً للتصفية النهائية)', 'joinDate'],
  ['تاريخ مباشرة العمل', 'joinDate'],
  ['تاريخ المباشرة', 'joinDate'],
  ['تاريخ احتساب الإجازة / العودة من آخر إجازة', 'leaveAccrualStartDate'],
  ['تاريخ احتساب الاجازة', 'leaveAccrualStartDate'],
  ['تاريخ انتهاء العقد', 'contractEndDate'],
  ['مدة فترة التجربة (بالأيام)', 'probationDays'],
  ['مدة فترة التجربة', 'probationDays'],
  ['رقم الهوية / الإقامة', 'iqamaOrIdNumber'],
  ['رقم الهوية / الاقامة', 'iqamaOrIdNumber'],
  ['رقم الهوية', 'iqamaOrIdNumber'],
  ['الهوية', 'iqamaOrIdNumber'],
  ['تاريخ انتهاء الصلاحية', 'iqamaOrIdExp'],
  ['انتهاء الهوية', 'iqamaOrIdExp'],
  ['رقم جواز السفر', 'passportNumber'],
  ['تاريخ انتهاء الجواز', 'passportExp'],
  ['رقم الشهادة الصحية', 'healthCertificateNum'],
  ['تاريخ انتهاء الشهادة', 'healthCertificateExp'],
  ['طريقة استلام الراتب', 'salaryPaymentMethod'],
  ['اسم البنك', 'bankName'],
  ['رمز البنك (SWIFT)', 'swiftCode'],
  ['رمز البنك', 'swiftCode'],
  ['رقم الآيبان (IBAN)', 'ibanNumber'],
  ['رقم الايبان', 'ibanNumber'],
  ['IBAN', 'ibanNumber'],
  ['الراتب الأساسي الشهري', 'basicSalary'],
  ['الراتب الاساسي', 'basicSalary'],
  ['بدل سكن', 'housingAllowance'],
  ['بدل نقل', 'transportAllowance'],
  ['بدلات أخرى', 'otherAllowances'],
  ['بدلات اخرى', 'otherAllowances'],
  ['خصم التأمينات الاجتماعية', 'gosiDeduction'],
  ['خصم التامينات', 'gosiDeduction'],
  ['الراتب الشامل', 'totalSalary'],
];

const DIRECT_HEADER_MAP = new Map<string, ImportField>(IMPORT_COLUMN_MAP.map(([h, f]) => [h, f]));

/** Collapse newlines/whitespace in a header cell. */
export function normalizeHeader(h: unknown): string {
  return String(h ?? '')
    .replace(/\r?\n|\r/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Resolves a sheet header to a field. `exact` is true for a direct match; otherwise the first
 * map entry that contains / is contained in the header wins (same behaviour as before).
 */
export function resolveImportHeader(rawHeader: unknown): { field: ImportField; exact: boolean } | null {
  const h = normalizeHeader(rawHeader);
  if (!h) return null;
  const direct = DIRECT_HEADER_MAP.get(h);
  if (direct) return { field: direct, exact: true };
  for (const [key, field] of IMPORT_COLUMN_MAP) {
    if (h.includes(key) || key.includes(h)) return { field, exact: false };
  }
  return null;
}

export type ImportCell = string | number | boolean | Date | null;
export type ImportRow = Partial<Record<ImportField, ImportCell>>;

function isBlank(v: ImportCell | undefined): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/**
 * Builds a field->value row from (header, value) pairs. Exact header matches overwrite;
 * partial matches only fill a field that is still blank.
 */
export function mapImportRow(cells: Array<{ header: { field: ImportField; exact: boolean } | null; value: ImportCell }>): ImportRow {
  const out: ImportRow = {};
  for (const { header, value } of cells) {
    if (!header) continue;
    if (header.exact || isBlank(out[header.field])) out[header.field] = value;
  }
  return out;
}

/** Trimmed string for a cell ('' for empty). Dates become YYYY-MM-DD. */
export function cellText(v: ImportCell | undefined): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10);
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  return String(v).trim();
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Date-only value (UTC midnight) from a cell. Excel dates read by exceljs are UTC-based and may
 * carry floating-point drift, so they are rounded to the nearest UTC day.
 */
export function cellDate(v: ImportCell | undefined): Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    const t = v.getTime();
    if (Number.isNaN(t)) return null;
    return new Date(Math.round(t / DAY_MS) * DAY_MS);
  }
  if (typeof v === 'boolean') return null;
  return parseDateOnly(v);
}

export function parseContractTypeLabel(s: string): 'FULL_TIME' | 'PART_TIME' | 'FREELANCE' {
  if (s.includes('جزئي') || /part/i.test(s)) return 'PART_TIME';
  // 'عمل حر/مستقل' is the FREELANCE label; 'عمل عن بعد' was the old (wrong) label in older exported files.
  if (s.includes('حر') || s.includes('عن بعد') || /freelance|remote/i.test(s)) return 'FREELANCE';
  return 'FULL_TIME';
}

export function parsePaymentMethodLabel(s: string): 'CASH' | 'BANK_TRANSFER' | 'WPS' {
  if (s.toUpperCase().includes('WPS') || s.includes('مدد')) return 'WPS';
  if (s.includes('كاش') || s.includes('نقد')) return 'CASH';
  return 'BANK_TRANSFER';
}

export function parseAccommodationLabel(s: string): 'INSIDE_COMPANY' | 'OUTSIDE_COMPANY' | null {
  if (s.includes('خارج')) return 'OUTSIDE_COMPANY';
  if (s.includes('داخل') || s.includes('سكن الشركة')) return 'INSIDE_COMPANY';
  return null;
}

/** "محمد أحمد العمري" -> { first: "محمد", last: "أحمد العمري" }. */
export function splitFullName(full: string): { first: string; last: string } {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  return { first: parts[0] ?? '', last: parts.slice(1).join(' ') };
}

/** Flexible org-unit name match (exact Arabic/English first, then containment). */
export function matchByName<T extends { id: string; nameArabic: string; nameEnglish?: string | null }>(items: T[], name: string): T | undefined {
  const n = name.trim();
  if (!n) return undefined;
  return (
    items.find((i) => i.nameArabic === n || (i.nameEnglish ?? '') === n) ??
    items.find((i) => (i.nameArabic && i.nameArabic.includes(n)) || (i.nameArabic && n.includes(i.nameArabic)))
  );
}

/**
 * Every record whose Arabic or English name is exactly `name` (both sides trimmed), in `items` order.
 * `extraKeys` adds identifiers that also count as an exact match (e.g. the record id, the company
 * commercial-registration / unified number, the branch code), so a user can disambiguate by number.
 */
export function matchAllByName<T extends { id: string; nameArabic: string; nameEnglish?: string | null }>(
  items: T[],
  name: string,
  extraKeys?: (item: T) => ReadonlyArray<string | null | undefined>,
): T[] {
  const n = name.trim();
  if (!n) return [];
  return items.filter(
    (i) =>
      (i.nameArabic ?? '').trim() === n ||
      (i.nameEnglish ?? '').trim() === n ||
      (extraKeys ? extraKeys(i).some((k) => typeof k === 'string' && k.trim() !== '' && k.trim() === n) : false),
  );
}

export type OrgUnitMatch<T> =
  | { kind: 'none' }
  | { kind: 'exact'; item: T }
  | { kind: 'approx'; item: T }
  | { kind: 'ambiguous'; count: number };

/**
 * Import lookup of a company / branch / administration cell:
 * - one exact match (name or extra key) -> that record;
 * - several exact matches -> `preferId` when it is one of them (an update row keeps the employee's
 *   current unit), otherwise 'ambiguous' (a row error: never pick one of them silently);
 * - no exact match -> the containment match of matchByName ('approx', reported as a warning) or 'none'.
 */
export function resolveOrgUnit<T extends { id: string; nameArabic: string; nameEnglish?: string | null }>(
  items: T[],
  name: string,
  opts: { extraKeys?: (item: T) => ReadonlyArray<string | null | undefined>; preferId?: string | null } = {},
): OrgUnitMatch<T> {
  if (!name.trim()) return { kind: 'none' };
  const exact = matchAllByName(items, name, opts.extraKeys);
  if (exact.length === 1) return { kind: 'exact', item: exact[0] };
  if (exact.length > 1) {
    const preferred = opts.preferId ? exact.find((i) => i.id === opts.preferId) : undefined;
    return preferred ? { kind: 'exact', item: preferred } : { kind: 'ambiguous', count: exact.length };
  }
  const approx = matchByName(items, name);
  return approx ? { kind: 'approx', item: approx } : { kind: 'none' };
}

/** "سجلين" / "3 سجلات" / "11 سجلاً" (Arabic count agreement for the ambiguity message). */
export function recordCountLabel(n: number): string {
  if (n === 2) return 'سجلين';
  if (n >= 3 && n <= 10) return `${n} سجلات`;
  return `${n} سجلاً`;
}

// ---------------------------------------------------------------------------
// Date sanity checks (council DATA-10): create / import
// ---------------------------------------------------------------------------

/** Dates before this year are almost always Hijri dates typed in a Gregorian column (1448 -> 2026). */
export const MIN_GREGORIAN_YEAR = 1900;
/** A join date further than this many days ahead is only a warning (test data uses far dates). */
export const FAR_FUTURE_JOIN_DAYS = 365;
/** Saudi Labor Law art. 162: no one under 15 may be employed (warning only, the birth date may be a typo). */
export const MIN_EMPLOYMENT_AGE = 15;

/** "تاريخ الميلاد «1448-05-10» يبدو هجرياً، حوّله إلى ميلادي" when the year is < 1900; else null. */
export function hijriLikeDateError(label: string, date: Date | null | undefined, raw?: string | null): string | null {
  if (!date || Number.isNaN(date.getTime()) || date.getUTCFullYear() >= MIN_GREGORIAN_YEAR) return null;
  const shown = (raw ?? '').trim() || date.toISOString().slice(0, 10);
  return `${label} «${shown}» يبدو هجرياً، حوّله إلى ميلادي`;
}

export interface EmployeeDateInput {
  dateOfBirth?: Date | null;
  joinDate?: Date | null;
  contractEndDate?: Date | null;
}

function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Logical checks of the key employee dates. `errors` block a create (POST / new import row);
 * `warnings` never block. Dates are date-only values (UTC midnight); "today" is the Riyadh day.
 */
export function employeeDateIssues(input: EmployeeDateInput, now: Date = new Date()): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const todayKeyValue = todayKey(now);
  const { dateOfBirth: dob, joinDate: join, contractEndDate: end } = input;

  if (dob && utcDayKey(dob) > todayKeyValue) errors.push('تاريخ الميلاد في المستقبل — تحقق من التاريخ');
  if (join && end && utcDayKey(end) < utcDayKey(join)) errors.push('تاريخ انتهاء العقد يسبق تاريخ مباشرة العمل');

  if (join) {
    const limit = addDays(new Date(`${todayKeyValue}T00:00:00.000Z`), FAR_FUTURE_JOIN_DAYS);
    if (join.getTime() > limit.getTime()) {
      warnings.push(`تاريخ مباشرة العمل (${utcDayKey(join)}) بعد أكثر من سنة من اليوم — تحقق من التاريخ (تنبيه فقط)`);
    }
  }
  if (dob && join && utcDayKey(dob) <= todayKeyValue) {
    const fifteenth = new Date(Date.UTC(dob.getUTCFullYear() + MIN_EMPLOYMENT_AGE, dob.getUTCMonth(), dob.getUTCDate()));
    if (join.getTime() < fifteenth.getTime()) {
      warnings.push(`عمر الموظف عند المباشرة أقل من ${MIN_EMPLOYMENT_AGE} سنة — تحقق من تاريخ الميلاد (المادة 162 من نظام العمل)`);
    }
  }
  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Org placement (council DATA-10): department within the branch, branch within the company
// ---------------------------------------------------------------------------

export interface OrgPlacementInput {
  legalCompanyId?: string | null;
  actualCompanyId?: string | null;
  branch?: { id: string; companyId: string } | null;
  department?: { id: string; branchId: string } | null;
}

/**
 * Arabic errors when the chosen department is not a department of the chosen branch, or the chosen
 * branch does not belong to the employee's workplace company (the actual company when set, else the
 * legal one). Nothing is checked for a unit that is not chosen.
 */
export function orgPlacementErrors(input: OrgPlacementInput): string[] {
  const out: string[] = [];
  const { branch, department } = input;
  if (branch && department && department.branchId !== branch.id) out.push('القسم المختار لا يتبع الفرع المختار');
  if (branch) {
    if (input.actualCompanyId) {
      if (branch.companyId !== input.actualCompanyId) out.push('الفرع المختار لا يتبع «الشركة الفعلية لمكان العمل»');
    } else if (input.legalCompanyId && branch.companyId !== input.legalCompanyId) {
      out.push('الفرع المختار لا يتبع الشركة القانونية المختارة — إذا كان الموظف يعمل في فرع شركة أخرى من المجموعة فاختر تلك الشركة في «الشركة الفعلية لمكان العمل»');
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Org structure (companies / administrations / branches / departments)
// ---------------------------------------------------------------------------

/**
 * Arabic 409 message listing what prevents deleting an org unit, or null when nothing does.
 * e.g. deletionBlockers('الشركة', [['موظف', 3], ['فرع', 0]]) -> "لا يمكن حذف الشركة لارتباطها بـ: 3 موظف. ..."
 */
export function deletionBlockers(
  entityLabel: string,
  counts: ReadonlyArray<readonly [label: string, count: number]>,
  feminine = true,
): string | null {
  const parts = counts.filter(([, n]) => n > 0).map(([label, n]) => `${n} ${label}`);
  if (parts.length === 0) return null;
  return `لا يمكن حذف ${entityLabel} ${feminine ? 'لارتباطها' : 'لارتباطه'} بـ: ${parts.join('، ')}. يرجى نقل هذه البيانات أو حذفها أولاً.`;
}

/** Nullable money: '' / null -> null (clears the column), missing -> unchanged. */
const zNullableMoney = z.preprocess((v) => (v === '' || v === null ? null : v), zMoney.nullable()).optional();
/** Nullable non-negative int: '' / null -> null, missing -> unchanged. */
const zNullableInt = z.preprocess((v) => (v === '' || v === null ? null : v), zInt.pipe(z.number().min(0)).nullable()).optional();

/**
 * Optional branch fields shared by POST /api/branches and PUT /api/branches/[id].
 * Every field is optional; '' clears nullable columns. Unknown keys are stripped.
 */
export const branchFieldsSchema = z.object({
  administrationId: z.preprocess((v) => (v === '' ? null : v), z.string().trim().max(100).nullable()).optional(),
  nameEnglish: zOptText(200),
  city: zOptText(200),
  district: zOptText(200),
  street: zOptText(300),
  branchCode: zOptText(50),
  munLicenseNum: zOptText(100),
  munLicenseStart: zOptDate,
  munLicenseExp: zOptDate,
  munLicenseUrl: zOptText(2000),
  munLicenseCost: zOptMoney,
  civilDefenseNum: zOptText(100),
  civilDefenseStart: zOptDate,
  civilDefenseExp: zOptDate,
  civilDefenseUrl: zOptText(2000),
  civilDefenseCost: zOptMoney,
  rentContractNum: zOptText(100),
  rentContractStart: zOptDate,
  rentContractExp: zOptDate,
  rentOwnerName: zOptText(200),
  rentOwnerPhone: zOptText(50),
  rentContractUrl: zOptText(20000),
  rentContractType: zOptText(100),
  rentContractAmount: zNullableMoney,
  rentPaymentType: zOptText(50),
  rentPaymentCount: zNullableInt,
  wasteContractNum: zOptText(100),
  wasteContractStart: zOptDate,
  wasteContractExp: zOptDate,
  wasteCompanyName: zOptText(200),
  wasteCompanyPhone: zOptText(50),
  wasteContractUrl: zOptText(2000),
  safetyContractNum: zOptText(100),
  safetyContractStart: zOptDate,
  safetyContractExp: zOptDate,
  safetyCompanyName: zOptText(200),
  safetyCompanyPhone: zOptText(50),
  safetyContractUrl: zOptText(2000),
  cameraContractNum: zOptText(100),
  cameraContractStart: zOptDate,
  cameraContractExp: zOptDate,
  cameraCompanyName: zOptText(200),
  cameraCompanyPhone: zOptText(50),
  cameraContractUrl: zOptText(2000),
  buildingLicenseUrl: zOptText(2000),
  blueprintsUrl: zOptText(2000),
  engineeringHandoverUrl: zOptText(2000),
  installationCompleteUrl: zOptText(2000),
  externalPhotosUrls: zOptText(20000),
  locationUrl: zOptText(2000),
});
