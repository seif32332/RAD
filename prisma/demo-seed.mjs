#!/usr/bin/env node
/**
 * Radeef HRMS — DEMO tenant seed ("full demo data with every case in it").
 *
 *   DEMO_SEED=1 node --env-file=.env prisma/demo-seed.mjs
 *
 * Run it ONLY against an EMPTY tenant database, after `npx prisma migrate deploy` (and optionally
 * `npm run db:seed`, whose single SUPER_ADMIN is tolerated). It exists so HR workflow designs
 * (PeopleOS council) can be exercised on screen against every awkward case the data can hold.
 *
 * DEMO ONLY, NOT A BASELINE (DEC-PO-050): the numbers here are invented and must never be used to
 * measure anything (cycle times, error rates, KPIs). Amounts are plausible, not computed by the
 * payroll / settlement engines; open any DRAFT payroll or PENDING settlement in the app to
 * recalculate it.
 *
 * Safety (the script refuses with exit code 1 and prints why):
 *   - env DEMO_SEED must be exactly "1";
 *   - Employee count must be 0, Company count must be 0 and User count must be <= 1
 *     (the one bootstrap SUPER_ADMIN that prisma/seed.mjs may have created).
 *   It only INSERTS rows (one transaction: all or nothing). It never updates or deletes a row.
 *
 * Credentials: one random password is generated at run time (crypto.randomBytes), shared by every
 * demo user and printed ONCE at the end with the list of demo e-mails (@demo.radeef.test, a
 * reserved test domain). The schema has no "must change password" flag, so none is set.
 *
 * All dates are relative to "today" in Asia/Riyadh (computed at run time), so the cases stay valid
 * whenever the script is run. D+n / D-n below = n days after / before today.
 *
 * Cases seeded
 * ┌────┬────────────────────────────────────────────────────────────────────────────────────────┐
 * │ U  │ Users: SUPER_ADMIN (vendor bootstrap), COMPANY_ADMIN, HR_MANAGER x2 (one is also an     │
 * │    │ employee), FINANCE_MANAGER, PAYROLL_ADMIN, LEGAL_ADMIN, DEPT_MANAGER, EMPLOYEE users;   │
 * │    │ terminated employees' users are inactive (DEC-002), the notice-period one stays active  │
 * │ E1 │ Active normal employees, Saudi (NATIONAL_ID) and non-Saudi (IQAMA, passport, occupation)│
 * │ E2 │ Active, stale employmentStatus 'ON_LEAVE' with no current leave                         │
 * │ E3 │ isTerminated=true, terminationDate in the past (EOS PAID)                               │
 * │ E4 │ isTerminated=true, terminationDate in the FUTURE (notice) + SICK leave today + EOS      │
 * │    │ PENDING_APPROVAL                                                                         │
 * │ E5 │ isTerminated=true, terminationDate null (legacy row)                                    │
 * │ E6 │ isTerminated=false WITH a terminationDate (EOS REJECTED left the date behind)           │
 * │ E7 │ Absconder: exitReason ABSCONDING                                                         │
 * │ E8 │ Rehire candidate: resigned ~3 years ago                                                  │
 * │ E9 │ Employee who is also an HR_MANAGER user                                                  │
 * │ E10│ Employee on probation (probationEndDate in the future)                                   │
 * │ E11│ Extras: part-time, iqama expiring in 20 days, contract ending in 45 days, GOSI UNKNOWN   │
 * │ L1 │ Approved ANNUAL leave covering today                                                     │
 * │ L2 │ Approved leave with early return recorded (actualReturnDate set, isReturned=false)      │
 * │ L3 │ Overdue return (APPROVED, endDate in the past, not returned, outside KSA)               │
 * │ L4 │ Approved MATERNITY leave covering today                                                  │
 * │ L5 │ SICK leave covering today for the notice (future termination) employee                  │
 * │ L6 │ Pending leave request, rejected leave, completed past leave                             │
 * │ S1 │ END_OF_SERVICE PENDING_APPROVAL                                                          │
 * │ S2 │ END_OF_SERVICE OWNER_APPROVED, lastWorkingDate != employee.terminationDate,             │
 * │    │ PaymentRequest PENDING_FINANCE linked (entityType SETTLEMENT)                            │
 * │ S3 │ END_OF_SERVICE PAID + linked PaymentRequest PAID                                         │
 * │ S4 │ END_OF_SERVICE REJECTED (ownerNotes)                                                     │
 * │ S5 │ LEAVE_SETTLEMENT (PAID) with leave compensation and NO matching Leave row               │
 * │ M1 │ Loans: active partly paid (installments), active unpaid, forgiven, pending request      │
 * │ M2 │ Overtime: PENDING, APPROVED (unpaid), APPROVED paid in last month's payroll, REJECTED   │
 * │ M3 │ Monthly allowances (housing counts toward GOSI, transport); one-off bonus due this      │
 * │    │ month and one already paid last month                                                   │
 * │ M4 │ Deductions: one DEDUCTED this month, one PENDING_AMOUNT_APPROVAL                        │
 * │ M5 │ General PaymentRequest PENDING_OWNER (not linked)                                        │
 * │ P1 │ DRAFT payroll rows for the current month (one needsReview: GOSI regime UNKNOWN)        │
 * │ P2 │ APPROVED payroll rows for the previous month (loan installment linked)                  │
 * │ O  │ Parents: company, administration, 2 branches, 6 departments, work schedules,            │
 * │    │ attendance GPS locations, nationalities (same list as prisma/seed.mjs)                   │
 * └────┴────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * Environment: DATABASE_URL (required), DEMO_SEED=1 (required).
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { randomBytes, randomInt } from 'node:crypto';

const BCRYPT_COST = 12;
const DEMO_DOMAIN = 'demo.radeef.test';

/** Same list (and order) as prisma/seed.mjs NATIONALITIES. */
const NATIONALITIES = ['سعودي', 'مصري', 'هندي', 'باكستاني', 'بنجلاديشي', 'فلبيني', 'نيبالي'];
const SAUDI = 'سعودي';

// ---------------------------------------------------------------------------------------------
// Dates (Asia/Riyadh = UTC+3, no DST). Every date is a UTC-midnight Date of a Riyadh calendar day.
// ---------------------------------------------------------------------------------------------
const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;
const riyadhNow = new Date(Date.now() + RIYADH_OFFSET_MS);
const TODAY = new Date(Date.UTC(riyadhNow.getUTCFullYear(), riyadhNow.getUTCMonth(), riyadhNow.getUTCDate()));
const DAY_MS = 24 * 60 * 60 * 1000;
/** D(n): today + n days. */
const D = (n) => new Date(TODAY.getTime() + n * DAY_MS);
/** Y(n): today + n years (same month/day). */
const Y = (n) => new Date(Date.UTC(TODAY.getUTCFullYear() + n, TODAY.getUTCMonth(), TODAY.getUTCDate()));
const CUR_MONTH = TODAY.getUTCMonth() + 1;
const CUR_YEAR = TODAY.getUTCFullYear();
const PREV_MONTH = CUR_MONTH === 1 ? 12 : CUR_MONTH - 1;
const PREV_YEAR = CUR_MONTH === 1 ? CUR_YEAR - 1 : CUR_YEAR;
const PREV2_MONTH = PREV_MONTH === 1 ? 12 : PREV_MONTH - 1;
const PREV2_YEAR = PREV_MONTH === 1 ? PREV_YEAR - 1 : PREV_YEAR;
const GOSI_NEW_REGIME_START = new Date(Date.UTC(2024, 6, 3));
const round2 = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------------------------
/** Random password that satisfies zPassword (8-128 chars, a letter and a digit). */
function generatePassword() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz';
  const body = randomBytes(12).toString('base64url');
  return `${letters[randomInt(letters.length)]}${body}${randomInt(10)}`;
}

// ---------------------------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------------------------
async function refusalReason(db) {
  if (process.env.DEMO_SEED !== '1') return 'DEMO_SEED=1 is not set. This script writes demo data; set DEMO_SEED=1 to confirm.';
  const [employees, users, companies] = await Promise.all([db.employee.count(), db.user.count(), db.company.count()]);
  if (employees > 0) return `the database already has ${employees} employee(s). The demo seed only runs on an EMPTY tenant database.`;
  if (users > 1) return `the database already has ${users} users (at most 1 bootstrap SUPER_ADMIN is allowed). The demo seed only runs on an EMPTY tenant database.`;
  if (companies > 0) return `the database already has ${companies} company row(s). The demo seed only runs on an EMPTY tenant database.`;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Demo data definitions
// ---------------------------------------------------------------------------------------------

/** Demo users. `emp` = key of the linked employee (Employee.userId). `active:false` = deactivated login. */
const USERS = [
  { key: 'super', email: 'vendor.superadmin', role: 'SUPER_ADMIN', name: 'مدير النظام (المورّد)' },
  { key: 'owner', email: 'owner', role: 'COMPANY_ADMIN', name: 'صالح بن عبدالعزيز الراشد' },
  { key: 'hr1', email: 'hr.manager', role: 'HR_MANAGER', name: 'نورة الشهري', emp: 'E02' },
  { key: 'hr2', email: 'hr.manager2', role: 'HR_MANAGER', name: 'ريم العتيبي' },
  { key: 'finance', email: 'finance', role: 'FINANCE_MANAGER', name: 'خالد الدوسري', emp: 'E04' },
  { key: 'payroll', email: 'payroll', role: 'PAYROLL_ADMIN', name: 'محمد عبدالرحمن', emp: 'E05' },
  { key: 'legal', email: 'legal', role: 'LEGAL_ADMIN', name: 'فيصل الزهراني', emp: 'E06' },
  { key: 'dept', email: 'dept.manager', role: 'DEPT_MANAGER', name: 'سلطان الحربي', emp: 'E07' },
  { key: 'u08', email: 'emp.fahad', role: 'EMPLOYEE', name: 'فهد المطيري', emp: 'E08' },
  { key: 'u09', email: 'emp.yousef', role: 'EMPLOYEE', name: 'يوسف الغامدي', emp: 'E09' },
  { key: 'u12', email: 'emp.maria', role: 'EMPLOYEE', name: 'ماريا سانتوس', emp: 'E12' },
  { key: 'u15', email: 'emp.ahmed', role: 'EMPLOYEE', name: 'أحمد السيد', emp: 'E15' },
  { key: 'u16', email: 'emp.ram', role: 'EMPLOYEE', name: 'رام بهادور', emp: 'E16', active: false },
  { key: 'u22', email: 'emp.sara', role: 'EMPLOYEE', name: 'سارة القرني', emp: 'E22' },
  { key: 'u23', email: 'emp.jose', role: 'EMPLOYEE', name: 'خوسيه رييس', emp: 'E23' },
];

/**
 * Employees. branch/dept keys refer to the org section. housing/transport = monthly allowances.
 * Every row sets only real Employee columns (see prisma/schema.prisma model Employee).
 */
const EMPLOYEES = [
  // --- E1: active normal (senior staff / managers) ---
  { key: 'E01', first: 'عبدالله', last: 'القحطاني', firstEn: 'Abdullah', lastEn: 'Alqahtani', nat: SAUDI, gender: 'MALE', marital: 'MARRIED', dob: Y(-48), join: Y(-9), branch: 'HQ', dept: 'ADMIN', title: 'المدير العام', titleEn: 'General Manager', basic: 30000, housing: 7500, transport: 3000, medical: 'VIP' },
  // --- E9: employee who is also an HR_MANAGER user (hr.manager) ---
  { key: 'E02', first: 'نورة', last: 'الشهري', firstEn: 'Noura', lastEn: 'Alshehri', nat: SAUDI, gender: 'FEMALE', marital: 'MARRIED', dob: Y(-36), join: Y(-5), branch: 'HQ', dept: 'HR', title: 'مديرة الموارد البشرية', titleEn: 'HR Manager', manager: 'E01', basic: 16000, housing: 4000, transport: 1500, medical: 'A+' },
  { key: 'E03', first: 'محمود', last: 'عبدالفتاح', firstEn: 'Mahmoud', lastEn: 'Abdelfattah', nat: 'مصري', gender: 'MALE', marital: 'MARRIED', dob: Y(-40), join: Y(-4), branch: 'HQ', dept: 'HR', title: 'أخصائي موارد بشرية', titleEn: 'HR Specialist', manager: 'E02', basic: 7000, housing: 1750, transport: 700, medical: 'B', occupation: 'أخصائي موارد بشرية' },
  { key: 'E04', first: 'خالد', last: 'الدوسري', firstEn: 'Khalid', lastEn: 'Aldosari', nat: SAUDI, gender: 'MALE', marital: 'MARRIED', dob: Y(-42), join: Y(-7), branch: 'HQ', dept: 'FIN', title: 'المدير المالي', titleEn: 'Finance Manager', manager: 'E01', basic: 18000, housing: 4500, transport: 1500, medical: 'A+' },
  { key: 'E05', first: 'محمد', last: 'عبدالرحمن', firstEn: 'Mohamed', lastEn: 'Abdelrahman', nat: 'مصري', gender: 'MALE', marital: 'MARRIED', dob: Y(-35), join: Y(-3), branch: 'HQ', dept: 'FIN', title: 'محاسب رواتب', titleEn: 'Payroll Accountant', manager: 'E04', basic: 8000, housing: 2000, transport: 800, medical: 'B', occupation: 'محاسب' },
  { key: 'E06', first: 'فيصل', last: 'الزهراني', firstEn: 'Faisal', lastEn: 'Alzahrani', nat: SAUDI, gender: 'MALE', marital: 'SINGLE', dob: Y(-33), join: Y(-2), branch: 'HQ', dept: 'LEGAL', title: 'مستشار قانوني', titleEn: 'Legal Counsel', manager: 'E01', basic: 14000, housing: 3500, transport: 1200, medical: 'A' },
  { key: 'E07', first: 'سلطان', last: 'الحربي', firstEn: 'Sultan', lastEn: 'Alharbi', nat: SAUDI, gender: 'MALE', marital: 'MARRIED', dob: Y(-39), join: Y(-6), branch: 'JED', dept: 'OPS', title: 'مدير العمليات', titleEn: 'Operations Manager', manager: 'E01', basic: 15000, housing: 3750, transport: 1500, medical: 'A' },
  { key: 'E08', first: 'فهد', last: 'المطيري', firstEn: 'Fahad', lastEn: 'Almutairi', nat: SAUDI, gender: 'MALE', marital: 'SINGLE', dob: Y(-28), join: Y(-3), branch: 'JED', dept: 'SALES', title: 'مندوب مبيعات', titleEn: 'Sales Representative', manager: 'E07', basic: 6500, housing: 1625, transport: 650, medical: 'B' },
  // --- E10: employee on probation ---
  { key: 'E09', first: 'يوسف', last: 'الغامدي', firstEn: 'Yousef', lastEn: 'Alghamdi', nat: SAUDI, gender: 'MALE', marital: 'SINGLE', dob: Y(-24), join: D(-40), probationEnd: D(50), branch: 'HQ', dept: 'IT', title: 'مطوّر برمجيات', titleEn: 'Software Developer', manager: 'E01', basic: 9000, housing: 2250, transport: 900, medical: 'B' },
  // --- E2: active with stale employmentStatus ON_LEAVE and no current leave ---
  { key: 'E10', first: 'راجيش', last: 'كومار', firstEn: 'Rajesh', lastEn: 'Kumar', nat: 'هندي', gender: 'MALE', marital: 'MARRIED', dob: Y(-37), join: Y(-6), branch: 'JED', dept: 'OPS', title: 'فني صيانة', titleEn: 'Maintenance Technician', manager: 'E07', basic: 3500, housing: 875, transport: 350, medical: 'C', occupation: 'فني صيانة', status: 'ON_LEAVE', dataReviewNote: 'الحالة "في إجازة" ولا توجد إجازة قائمة: يلزم تصحيح حالة التوظيف' },
  // --- S5: LEAVE_SETTLEMENT paid with no Leave row (markSettlementPaid set ON_LEAVE) ---
  { key: 'E11', first: 'عمران', last: 'خان', firstEn: 'Imran', lastEn: 'Khan', nat: 'باكستاني', gender: 'MALE', marital: 'MARRIED', dob: Y(-41), join: Y(-4), branch: 'JED', dept: 'OPS', title: 'سائق', titleEn: 'Driver', manager: 'E07', basic: 3000, housing: 750, transport: 0, medical: 'C', occupation: 'سائق', status: 'ON_LEAVE' },
  // --- L1: approved ANNUAL leave covering today ---
  { key: 'E12', first: 'ماريا', last: 'سانتوس', firstEn: 'Maria', lastEn: 'Santos', nat: 'فلبيني', gender: 'FEMALE', marital: 'SINGLE', dob: Y(-31), join: Y(-3), branch: 'HQ', dept: 'ADMIN', title: 'سكرتيرة تنفيذية', titleEn: 'Executive Secretary', manager: 'E01', basic: 5000, housing: 1250, transport: 500, medical: 'B', occupation: 'سكرتير' },
  // --- E3: terminated, terminationDate in the past (EOS PAID) ---
  { key: 'E13', first: 'رحيم', last: 'الدين', firstEn: 'Rahim', lastEn: 'Uddin', nat: 'بنجلاديشي', gender: 'MALE', marital: 'MARRIED', dob: Y(-45), join: Y(-8), branch: 'JED', dept: 'OPS', title: 'عامل مستودع', titleEn: 'Warehouse Worker', manager: 'E07', basic: 2500, housing: 625, transport: 250, medical: 'C', occupation: 'عامل', terminated: true, termDate: D(-60), status: 'EXCLUDED', exitReason: 'CONTRACT_END', exitVoluntary: false },
  // --- E5: terminated with terminationDate null (legacy row) ---
  { key: 'E14', first: 'تركي', last: 'السبيعي', firstEn: 'Turki', lastEn: 'Alsubaie', nat: SAUDI, gender: 'MALE', marital: 'SINGLE', dob: Y(-30), join: Y(-4), branch: 'JED', dept: 'SALES', title: 'مندوب مبيعات', titleEn: 'Sales Representative', manager: 'E07', basic: 6000, housing: 1500, transport: 600, medical: 'B', terminated: true, termDate: null, status: 'EXCLUDED', dataReviewNote: 'منتهية خدمته بدون تاريخ انتهاء خدمة (سجل قديم)' },
  // --- E4: notice case: terminated=true, terminationDate in the FUTURE; SICK leave today; EOS pending ---
  { key: 'E15', first: 'أحمد', last: 'السيد', firstEn: 'Ahmed', lastEn: 'Elsayed', nat: 'مصري', gender: 'MALE', marital: 'MARRIED', dob: Y(-38), join: Y(-6), branch: 'HQ', dept: 'IT', title: 'مهندس شبكات', titleEn: 'Network Engineer', manager: 'E01', basic: 11000, housing: 2750, transport: 1100, medical: 'A', occupation: 'مهندس شبكات', terminated: true, termDate: D(20), status: 'ACTIVE', exitReason: 'RESIGNATION', exitVoluntary: true },
  // --- S2: OWNER_APPROVED EOS; employee.terminationDate (D-10) != settlement.lastWorkingDate (D-14) ---
  { key: 'E16', first: 'رام', last: 'بهادور', firstEn: 'Ram', lastEn: 'Bahadur', nat: 'نيبالي', gender: 'MALE', marital: 'MARRIED', dob: Y(-34), join: Y(-5), branch: 'JED', dept: 'OPS', title: 'حارس أمن', titleEn: 'Security Guard', manager: 'E07', basic: 2800, housing: 700, transport: 280, medical: 'C', occupation: 'حارس أمن', terminated: true, termDate: D(-10), status: 'EXCLUDED', exitReason: 'EMPLOYER_TERMINATION', exitVoluntary: false },
  // --- E6: isTerminated=false WITH a terminationDate (the EOS was REJECTED, date left behind) ---
  { key: 'E17', first: 'ماجد', last: 'العنزي', firstEn: 'Majed', lastEn: 'Alanazi', nat: SAUDI, gender: 'MALE', marital: 'MARRIED', dob: Y(-35), join: Y(-4), branch: 'JED', dept: 'SALES', title: 'مشرف مبيعات', titleEn: 'Sales Supervisor', manager: 'E07', basic: 9000, housing: 2250, transport: 900, medical: 'A', terminated: false, termDate: D(-5), status: 'ACTIVE' },
  // --- E7: absconder ---
  { key: 'E18', first: 'كريم', last: 'مياه', firstEn: 'Karim', lastEn: 'Miah', nat: 'بنجلاديشي', gender: 'MALE', marital: 'SINGLE', dob: Y(-29), join: Y(-2), branch: 'JED', dept: 'OPS', title: 'عامل نظافة', titleEn: 'Cleaner', manager: 'E07', basic: 1800, housing: 450, transport: 180, medical: 'C', occupation: 'عامل نظافة', terminated: true, termDate: D(-25), status: 'EXCLUDED', exitReason: 'ABSCONDING', dataReviewNote: 'انقطاع عن العمل: يلزم التحقق من شروط المادة 80 وبلاغ التغيب' },
  // --- E8: rehire candidate (resigned ~3 years ago) ---
  { key: 'E19', first: 'عبدالعزيز', last: 'الشمري', firstEn: 'Abdulaziz', lastEn: 'Alshammari', nat: SAUDI, gender: 'MALE', marital: 'MARRIED', dob: Y(-37), join: Y(-7), branch: 'HQ', dept: 'FIN', title: 'محاسب', titleEn: 'Accountant', manager: 'E04', basic: 8500, housing: 2125, transport: 850, medical: 'B', terminated: true, termDate: Y(-3), status: 'EXCLUDED', exitReason: 'RESIGNATION', exitVoluntary: true },
  // --- L2: early return recorded, awaiting confirmation ---
  { key: 'E20', first: 'سوريش', last: 'ناير', firstEn: 'Suresh', lastEn: 'Nair', nat: 'هندي', gender: 'MALE', marital: 'MARRIED', dob: Y(-43), join: Y(-5), branch: 'HQ', dept: 'IT', title: 'مسؤول دعم فني', titleEn: 'IT Support', manager: 'E01', basic: 6000, housing: 1500, transport: 600, medical: 'B', occupation: 'فني دعم' },
  // --- L3: overdue return (outside KSA) ---
  { key: 'E21', first: 'شاهد', last: 'أقبال', firstEn: 'Shahid', lastEn: 'Iqbal', nat: 'باكستاني', gender: 'MALE', marital: 'MARRIED', dob: Y(-39), join: Y(-4), branch: 'JED', dept: 'OPS', title: 'كهربائي', titleEn: 'Electrician', manager: 'E07', basic: 3200, housing: 800, transport: 320, medical: 'C', occupation: 'كهربائي' },
  // --- L4: approved MATERNITY leave covering today ---
  { key: 'E22', first: 'سارة', last: 'القرني', firstEn: 'Sara', lastEn: 'Alqarni', nat: SAUDI, gender: 'FEMALE', marital: 'MARRIED', dob: Y(-30), join: Y(-3), branch: 'HQ', dept: 'HR', title: 'أخصائية توظيف', titleEn: 'Recruitment Specialist', manager: 'E02', basic: 8000, housing: 2000, transport: 800, medical: 'A' },
  // --- E1: active normal (overtime / bonus / deduction cases) ---
  { key: 'E23', first: 'خوسيه', last: 'رييس', firstEn: 'Jose', lastEn: 'Reyes', nat: 'فلبيني', gender: 'MALE', marital: 'MARRIED', dob: Y(-36), join: Y(-3), branch: 'JED', dept: 'OPS', title: 'مشرف مستودع', titleEn: 'Warehouse Supervisor', manager: 'E07', basic: 4500, housing: 1125, transport: 450, medical: 'B', occupation: 'مشرف مستودع' },
  // --- E11: part-time Saudi, GOSI regime UNKNOWN (payroll needsReview) ---
  { key: 'E24', first: 'ليان', last: 'العمري', firstEn: 'Layan', lastEn: 'Alamri', nat: SAUDI, gender: 'FEMALE', marital: 'SINGLE', dob: Y(-22), join: D(-200), branch: 'HQ', dept: 'IT', title: 'مصممة واجهات (دوام جزئي)', titleEn: 'UI Designer (part-time)', manager: 'E01', basic: 4000, housing: 0, transport: 400, medical: 'C', contract: 'PART_TIME', partTimeHours: 20, gosi: 'UNKNOWN' },
  // --- E11: iqama expiring in 20 days, fixed-term contract ending in 45 days ---
  { key: 'E25', first: 'حسن', last: 'إبراهيم', firstEn: 'Hassan', lastEn: 'Ibrahim', nat: 'مصري', gender: 'MALE', marital: 'MARRIED', dob: Y(-44), join: Y(-2), branch: 'JED', dept: 'SALES', title: 'محاسب مبيعات', titleEn: 'Sales Accountant', manager: 'E07', basic: 6500, housing: 1625, transport: 650, medical: 'B', occupation: 'محاسب', iqamaExp: D(20), contractEnd: D(45) },
];

const empByKey = new Map(EMPLOYEES.map((e) => [e.key, e]));
const isSaudi = (e) => e.nat === SAUDI;

function gosiRegimeFor(e) {
  if (e.gosi) return e.gosi;
  return e.join < GOSI_NEW_REGIME_START ? 'OLD' : 'NEW';
}
/** Employee share: 9.75% of (basic + housing) for Saudis, 0 otherwise (demo approximation). */
const gosiEmployeeOf = (e) => (isSaudi(e) ? round2((e.basic + e.housing) * 0.0975) : 0);
/** Employer share: 11.75% for Saudis, 2% (occupational hazards) for non-Saudis (demo approximation). */
const gosiEmployerOf = (e) => round2((e.basic + e.housing) * (isSaudi(e) ? 0.1175 : 0.02));
/** Rough EOS (art. 84): half a month per year for the first 5 years, a full month after, on basic+housing+transport. */
function eosFull(e, lastDay) {
  const years = (lastDay.getTime() - e.join.getTime()) / (365 * DAY_MS);
  const wage = e.basic + e.housing + e.transport;
  const amount = years <= 5 ? years * wage * 0.5 : 5 * wage * 0.5 + (years - 5) * wage;
  return { years: round2(years), amount: round2(amount) };
}

// ---------------------------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------------------------
async function seed(tx, passwordHash) {
  const summary = {};
  const bump = (k, n = 1) => (summary[k] = (summary[k] ?? 0) + n);

  // --- O: nationalities (same list as prisma/seed.mjs; rows seed.mjs already created are skipped) ---
  const nat = await tx.nationality.createMany({ data: NATIONALITIES.map((label) => ({ label })), skipDuplicates: true });
  bump('Nationality', nat.count);

  // --- O: company, administration, branches, departments, work schedules, GPS locations ---
  const company = await tx.company.create({
    data: {
      nameArabic: 'شركة رديف التجريبية للتجارة',
      nameEnglish: 'Radeef Demo Trading Co.',
      unifiedNumber: '7000000001',
      commercialRegNum: '1010999001',
      commercialRegDate: Y(-10),
      commercialRegExp: D(200),
      taxNumber: '300000000000003',
      molEstablishmentNumber: '9-9999999',
      gosiEstablishmentNumber: '999999999',
      nationalAddress: 'RDMA1234',
      trademarkNumber: '1449000001',
      trademarkRegDate: Y(-5),
      trademarkExpDate: D(50),
    },
  });
  bump('Company');
  const administration = await tx.administration.create({
    data: { companyId: company.id, nameArabic: 'الإدارة العامة', nameEnglish: 'General Administration' },
  });
  bump('Administration');

  const branches = {};
  for (const b of [
    { key: 'HQ', nameArabic: 'المركز الرئيسي - الرياض', nameEnglish: 'Head Office - Riyadh', city: 'الرياض', district: 'العليا', branchCode: 'RUH-01', lat: 24.7136, lng: 46.6753 },
    { key: 'JED', nameArabic: 'فرع جدة', nameEnglish: 'Jeddah Branch', city: 'جدة', district: 'الروضة', branchCode: 'JED-01', lat: 21.5433, lng: 39.1728 },
  ]) {
    branches[b.key] = await tx.branch.create({
      data: {
        companyId: company.id,
        administrationId: administration.id,
        nameArabic: b.nameArabic,
        nameEnglish: b.nameEnglish,
        city: b.city,
        district: b.district,
        branchCode: b.branchCode,
        munLicenseNum: `MUN-${b.branchCode}`,
        munLicenseStart: Y(-1),
        munLicenseExp: b.key === 'JED' ? D(25) : D(300), // Jeddah licence inside the 30-day alert window
        civilDefenseNum: `CD-${b.branchCode}`,
        civilDefenseExp: D(180),
        rentContractNum: `RENT-${b.branchCode}`,
        rentContractStart: Y(-1),
        rentContractExp: D(120),
      },
    });
    bump('Branch');
    await tx.workSchedule.create({
      data: { branchId: branches[b.key].id, companyId: company.id, name: 'دوام نهاري منتظم', shiftType: 'ONE_SHIFT', startTime: '08:00', endTime: '16:00', workDays: 'الأحد-الخميس', workWeekdays: [0, 1, 2, 3, 4] },
    });
    bump('WorkSchedule');
    await tx.attendanceLocation.create({
      data: { branchId: branches[b.key].id, name: `بوابة ${b.nameArabic}`, latitude: b.lat, longitude: b.lng, radiusM: 150 },
    });
    bump('AttendanceLocation');
  }

  const departments = {};
  for (const d of [
    { key: 'ADMIN', branch: 'HQ', nameArabic: 'الإدارة العليا', nameEnglish: 'Executive Office' },
    { key: 'HR', branch: 'HQ', nameArabic: 'الموارد البشرية', nameEnglish: 'Human Resources' },
    { key: 'FIN', branch: 'HQ', nameArabic: 'المالية', nameEnglish: 'Finance' },
    { key: 'LEGAL', branch: 'HQ', nameArabic: 'الشؤون القانونية', nameEnglish: 'Legal' },
    { key: 'IT', branch: 'HQ', nameArabic: 'تقنية المعلومات', nameEnglish: 'IT' },
    { key: 'OPS', branch: 'JED', nameArabic: 'العمليات', nameEnglish: 'Operations' },
    { key: 'SALES', branch: 'JED', nameArabic: 'المبيعات', nameEnglish: 'Sales' },
  ]) {
    departments[d.key] = await tx.department.create({
      data: { branchId: branches[d.branch].id, nameArabic: d.nameArabic, nameEnglish: d.nameEnglish },
    });
    bump('Department');
  }

  // --- U: users (all share the one generated demo password) ---
  const users = {};
  for (const u of USERS) {
    users[u.key] = await tx.user.create({
      data: {
        email: `${u.email}@${DEMO_DOMAIN}`,
        passwordHash,
        role: u.role,
        isActive: u.active !== false,
        name: u.name,
        // BL-PAY-005: a vendor script writes the identity of its accounts explicitly (demo people: vendor identity).
        isVendorStaff: true,
        identityStatus: 'VENDOR_BOOTSTRAP',
      },
    });
    bump('User');
  }
  const userForEmp = new Map(USERS.filter((u) => u.emp).map((u) => [u.emp, users[u.key]]));

  // --- E1..E11: employees (managers first, so directManagerId can be set on create) ---
  const emps = {};
  let seq = 0;
  let saudiIdSeq = 1099000000;
  let iqamaSeq = 2499000000;
  for (const e of EMPLOYEES) {
    seq++;
    const saudi = isSaudi(e);
    const code = `EMP-${String(seq).padStart(4, '0')}`;
    emps[e.key] = await tx.employee.create({
      data: {
        userId: userForEmp.get(e.key)?.id ?? null,
        employeeId: code,
        biometricId: `BIO-${String(seq).padStart(4, '0')}`,
        firstNameArabic: e.first,
        lastNameArabic: e.last,
        firstNameEnglish: e.firstEn,
        lastNameEnglish: e.lastEn,
        nationality: e.nat,
        dataReviewNote: e.dataReviewNote ?? null,
        iqamaOrIdNumber: String(saudi ? ++saudiIdSeq : ++iqamaSeq),
        iqamaOrIdExp: e.iqamaExp ?? (saudi ? Y(6) : D(150 + seq * 7)),
        iqamaRenewalCost: saudi ? 0 : 650,
        passportNumber: saudi ? null : `P${String(7000000 + seq)}`,
        passportExp: saudi ? null : Y(3),
        dateOfBirth: e.dob,
        gender: e.gender,
        maritalStatus: e.marital,
        mobileNumber: `05${String(50000000 + seq * 1234).slice(0, 8)}`,
        email: `${e.firstEn.toLowerCase()}.${e.lastEn.toLowerCase()}@${DEMO_DOMAIN}`,
        bankName: saudi ? 'مصرف الراجحي' : 'البنك الأهلي السعودي',
        salaryPaymentMethod: 'WPS',
        legalCompanyId: company.id,
        actualCompanyId: company.id,
        administrationId: administration.id,
        branchId: branches[e.branch].id,
        departmentId: departments[e.dept].id,
        jobTitle: e.title,
        jobTitleEnglish: e.titleEn,
        directManagerId: e.manager ? emps[e.manager].id : null,
        workSchedule: 'دوام نهاري منتظم',
        accommodationType: saudi ? 'OUTSIDE_COMPANY' : 'INSIDE_COMPANY',
        joinDate: e.join,
        contractType: e.contract ?? 'FULL_TIME',
        contractEndDate: e.contractEnd ?? null,
        probationEndDate: e.probationEnd ?? new Date(e.join.getTime() + 90 * DAY_MS),
        noticePeriodDays: 30,
        leaveAccrualStartDate: e.join,
        basicSalary: e.basic,
        gosiDeduction: gosiEmployeeOf(e),
        gosiRegime: gosiRegimeFor(e),
        gosiNumber: `G${String(100000000 + seq)}`,
        idType: saudi ? 'NATIONAL_ID' : 'IQAMA',
        isTerminated: e.terminated === true,
        terminationDate: e.termDate ?? null,
        employmentStatus: e.status ?? 'ACTIVE',
        occupationName: e.occupation ?? e.title,
        dependentsCount: saudi ? null : e.marital === 'MARRIED' ? 2 : 0,
        dependentsFeePaidBy: saudi ? null : 'EMPLOYEE',
        partTimeWeeklyHours: e.partTimeHours ?? null,
        qiwaContractDocumented: true,
        qiwaContractDocumentedAt: e.join,
        medicalInsuranceClass: e.medical,
        exitReason: e.exitReason ?? null,
        exitVoluntary: e.exitVoluntary ?? null,
      },
    });
    bump('Employee');
  }
  // BL-PAY-005: every access link (Employee.userId) has its UserEmployeeLink row; a vendor script's link is
  // LEGACY_LINKED (not a confirmed two-step link).
  const demoLinks = Object.values(emps).filter((e) => e.userId).map((e) => ({ userId: e.userId, employeeId: e.id, status: 'LEGACY_LINKED', legacy: true }));
  if (demoLinks.length) await tx.userEmployeeLink.createMany({ data: demoLinks });

  // --- M3: monthly allowances (housing counts toward GOSI; transport) ---
  for (const e of EMPLOYEES) {
    if (e.housing > 0) {
      await tx.allowance.create({ data: { employeeId: emps[e.key].id, name: 'بدل سكن', amount: e.housing, isMonthly: true, countsTowardGosi: true, allowanceType: 'HOUSING' } });
      bump('Allowance');
    }
    if (e.transport > 0) {
      await tx.allowance.create({ data: { employeeId: emps[e.key].id, name: 'بدل نقل', amount: e.transport, isMonthly: true, countsTowardGosi: false, allowanceType: 'TRANSPORT' } });
      bump('Allowance');
    }
  }

  // --- P2: APPROVED payroll for the previous month (created first so paid items can link to it) ---
  const PREV_PAYROLL_KEYS = ['E01', 'E02', 'E04', 'E05', 'E07', 'E08', 'E23'];
  const prevPayroll = {};
  // Previous-month extras: E08 loan installment 1000, E23 approved overtime 450 paid + one-off bonus 1000 paid.
  const prevExtras = { E08: { loans: 1000 }, E23: { overtime: 450, bonus: 1000 } };
  for (const k of PREV_PAYROLL_KEYS) {
    prevPayroll[k] = await tx.payroll.create({ data: payrollData(empByKey.get(k), emps[k].id, PREV_MONTH, PREV_YEAR, 'APPROVED', prevExtras[k]) });
    bump('Payroll (APPROVED, previous month)');
  }

  // --- P1: DRAFT payroll for the current month (active, not terminated employees) ---
  const DRAFT_KEYS = ['E01', 'E02', 'E03', 'E04', 'E05', 'E06', 'E07', 'E08', 'E09', 'E12', 'E20', 'E22', 'E23', 'E24', 'E25'];
  const draftExtras = {
    E08: { loans: 1000 },
    E23: { bonus: 1500, other: 150 },
    E24: { needsReview: true, reviewNote: 'نظام التأمينات غير مؤكد (UNKNOWN): يلزم تأكيد الموارد البشرية' },
  };
  const draftPayroll = {};
  for (const k of DRAFT_KEYS) {
    draftPayroll[k] = await tx.payroll.create({ data: payrollData(empByKey.get(k), emps[k].id, CUR_MONTH, CUR_YEAR, 'DRAFT', draftExtras[k]) });
    bump('Payroll (DRAFT, current month)');
  }

  // --- M3: one-off bonuses: one already paid last month, one due in this month's payroll ---
  await tx.allowance.create({
    data: { employeeId: emps.E23.id, name: 'مكافأة تميز (لمرة واحدة)', amount: 1000, isMonthly: false, allowanceType: 'OTHER', payrollMonth: PREV_MONTH, payrollYear: PREV_YEAR, isPaid: true, paidInPayrollId: prevPayroll.E23.id },
  });
  await tx.allowance.create({
    data: { employeeId: emps.E23.id, name: 'مكافأة جرد المستودع (لمرة واحدة)', amount: 1500, isMonthly: false, allowanceType: 'OTHER', payrollMonth: CUR_MONTH, payrollYear: CUR_YEAR, isPaid: false },
  });
  bump('Allowance', 2);

  // --- M1: loans ---
  // Active, partly paid: 6000 at 1000/month, two installments collected (2 months ago + last month's
  // APPROVED payroll), this month's installment reserved on the DRAFT payroll (not yet collected).
  const loanActive = await tx.loan.create({
    data: {
      employeeId: emps.E08.id, amount: 6000, reason: 'ظروف عائلية', monthlyInstallment: 1000, remainingAmount: 4000,
      status: 'FINANCE_TRANSFERRED', isManagerApproved: true, managerApprovedAt: D(-75), isHrApproved: true, hrApprovedAt: D(-74),
      isFinanceApproved: true, financeApprovedAt: D(-73), isFinanceTransferred: true, financeTransferredAt: D(-72),
    },
  });
  await tx.loanInstallment.createMany({
    data: [
      { loanId: loanActive.id, payrollId: null, month: PREV2_MONTH, year: PREV2_YEAR, amount: 1000 },
      { loanId: loanActive.id, payrollId: prevPayroll.E08.id, month: PREV_MONTH, year: PREV_YEAR, amount: 1000 },
      { loanId: loanActive.id, payrollId: draftPayroll.E08.id, month: CUR_MONTH, year: CUR_YEAR, amount: 1000 },
    ],
  });
  bump('LoanInstallment', 3);
  // Active, nothing collected yet (approved by finance, not transferred).
  await tx.loan.create({
    data: {
      employeeId: emps.E23.id, amount: 3000, reason: 'رسوم دراسية', monthlyInstallment: 500, remainingAmount: 3000,
      status: 'FINANCE_APPROVED', isManagerApproved: true, managerApprovedAt: D(-6), isHrApproved: true, hrApprovedAt: D(-5),
      isFinanceApproved: true, financeApprovedAt: D(-4),
    },
  });
  // Forgiven (one installment collected before the company forgave the rest).
  const loanForgiven = await tx.loan.create({
    data: {
      employeeId: emps.E10.id, amount: 2000, reason: 'علاج', monthlyInstallment: 500, remainingAmount: 0, isForgiven: true,
      status: 'FORGIVEN', isManagerApproved: true, managerApprovedAt: D(-150), isHrApproved: true, hrApprovedAt: D(-149),
      isFinanceApproved: true, financeApprovedAt: D(-148), isFinanceTransferred: true, financeTransferredAt: D(-147),
    },
  });
  await tx.loanInstallment.create({ data: { loanId: loanForgiven.id, payrollId: null, month: PREV2_MONTH, year: PREV2_YEAR, amount: 500 } });
  bump('LoanInstallment');
  // Pending request (awaiting the direct manager).
  await tx.loan.create({ data: { employeeId: emps.E20.id, amount: 1500, reason: 'سلفة طارئة', monthlyInstallment: 500, remainingAmount: 1500, status: 'PENDING' } });
  bump('Loan', 4);

  // --- M2: overtime requests ---
  await tx.overtimeRequest.createMany({
    data: [
      { employeeId: emps.E23.id, supervisorId: emps.E07.id, date: D(-3), type: 'HOURS', hours: 4, reason: 'جرد نهاية الشهر', status: 'PENDING' },
      { employeeId: emps.E08.id, supervisorId: emps.E07.id, date: D(-8), type: 'HOURS', hours: 3, reason: 'معرض تجاري', status: 'APPROVED' },
      { employeeId: emps.E25.id, supervisorId: emps.E07.id, date: D(-12), type: 'LUMP_SUM', hours: 0, amount: 600, reason: 'إقفال حسابات الربع', status: 'APPROVED' },
      { employeeId: emps.E23.id, supervisorId: emps.E07.id, date: D(-40), type: 'HOURS', hours: 6, amount: 450, reason: 'استلام شحنة', status: 'APPROVED', paidInPayrollId: prevPayroll.E23.id },
      { employeeId: emps.E21.id, supervisorId: emps.E07.id, date: D(-30), type: 'HOURS', hours: 5, reason: 'صيانة طارئة', status: 'REJECTED' },
    ],
  });
  bump('OvertimeRequest', 5);

  // --- M4: deductions ---
  await tx.deduction.create({
    data: {
      employeeId: emps.E23.id, date: D(-7), amount: 150, reason: 'تأخير متكرر عن الدوام', status: 'DEDUCTED', category: 'ATTENDANCE', violationType: 'LATE_ARRIVAL',
      occurrenceNumber: 2, severity: 'LOW', deductionDays: 0, isLinkedToPayroll: true, payrollMonth: `${CUR_YEAR}-${String(CUR_MONTH).padStart(2, '0')}`,
      issuedBy: 'سلطان الحربي', approvedBy: 'نورة الشهري', approvedAt: D(-6),
    },
  });
  await tx.deduction.create({
    data: { employeeId: emps.E21.id, date: D(-2), amount: 320, reason: 'غياب بدون عذر', status: 'PENDING_AMOUNT_APPROVAL', category: 'ATTENDANCE', violationType: 'ABSENCE', severity: 'MEDIUM', deductionDays: 1, dailySalary: 106.67, issuedBy: 'سلطان الحربي' },
  });
  bump('Deduction', 2);

  // --- L1..L6: leaves ---
  const leave = (k, data) => tx.leave.create({ data: { employeeId: emps[k].id, ...data } }).then(() => bump('Leave'));
  const approved = (start) => ({ status: 'APPROVED', isManagerApproved: true, managerApprovedAt: D(-(Math.abs(start) + 7)), isHrApproved: true, hrApprovedAt: D(-(Math.abs(start) + 6)) });
  // L1: approved ANNUAL leave covering today.
  await leave('E12', { leaveType: 'ANNUAL', startDate: D(-5), endDate: D(9), totalDays: 15, ...approved(-5), availableBalance: 21, paidDays: 15, unpaidDays: 0 });
  // L2: approved leave, early return recorded (actualReturnDate set) but not yet confirmed (isReturned=false).
  await leave('E20', { leaveType: 'ANNUAL', startDate: D(-10), endDate: D(5), totalDays: 16, ...approved(-10), availableBalance: 30, paidDays: 16, unpaidDays: 0, actualReturnDate: D(-2), isReturned: false, notes: 'عاد مبكراً: بانتظار تأكيد الموارد البشرية' });
  // L3: overdue return: APPROVED, ended 3 days ago, outside KSA, not returned.
  await leave('E21', { leaveType: 'ANNUAL', startDate: D(-24), endDate: D(-3), totalDays: 22, ...approved(-24), availableBalance: 30, paidDays: 22, unpaidDays: 0, isOutsideKSA: true, exitReentryVisaCost: 200, flightTicketOption: 'company_provided', isReturned: false });
  // L4: approved MATERNITY leave covering today (12 weeks).
  await leave('E22', { leaveType: 'MATERNITY', startDate: D(-30), endDate: D(53), totalDays: 84, ...approved(-30), paidDays: 84, unpaidDays: 0 });
  // L5: SICK leave covering today for the notice-period employee (E15, terminationDate D+20).
  await leave('E15', { leaveType: 'SICK', startDate: D(-2), endDate: D(4), totalDays: 7, ...approved(-2), paidDays: 7, unpaidDays: 0, notes: 'إجازة مرضية خلال فترة الإشعار' });
  // L6: completed past leave (the stale ON_LEAVE employee's last leave), a pending request, a rejected one.
  await leave('E10', { leaveType: 'ANNUAL', startDate: D(-120), endDate: D(-91), totalDays: 30, ...approved(-120), status: 'COMPLETED', paidDays: 30, unpaidDays: 0, isReturned: true, actualReturnDate: D(-90) });
  await leave('E23', { leaveType: 'ANNUAL', startDate: D(14), endDate: D(20), totalDays: 7, status: 'PENDING', availableBalance: 18 });
  await leave('E08', { leaveType: 'EMERGENCY', startDate: D(-15), endDate: D(-14), totalDays: 2, status: 'REJECTED', notes: 'رُفضت لتزامنها مع المعرض' });

  // --- S1..S5: settlements (and the PaymentRequests the app links to them) ---
  const settlement = (k, data) => tx.settlement.create({ data: { employeeId: emps[k].id, salaryBasis: 'total', ...data } }).then((s) => (bump('Settlement'), s));
  const eosRow = (k, lastDay, reason, factor, status, extra = {}) => {
    const e = empByKey.get(k);
    const { years, amount } = eosFull(e, lastDay);
    const eos = round2(amount * factor);
    const dayRate = (e.basic + e.housing + e.transport) / 30;
    const daysWorked = lastDay.getUTCDate();
    const workingDaysSalary = round2(dayRate * daysWorked);
    const unusedLeaveDays = 12;
    const leaveCompensation = round2(dayRate * unusedLeaveDays);
    return settlement(k, {
      type: 'END_OF_SERVICE', terminationReason: reason, lastWorkingDate: lastDay, workingDaysInMonth: daysWorked, workingDaysSalary,
      yearsOfService: years, endOfServiceAmount: eos, unusedLeaveDays, leaveCompensation, loansDeduction: 0, overtimeAmount: 0,
      totalSettlement: round2(eos + workingDaysSalary + leaveCompensation), status, ...extra,
    });
  };
  // S1: PENDING_APPROVAL (notice employee resigned; last day = his future terminationDate). 6 years: 2/3 of the award.
  await eosRow('E15', D(20), 'RESIGNATION', 2 / 3, 'PENDING_APPROVAL');
  // S2: OWNER_APPROVED; lastWorkingDate D-14 while Employee.terminationDate is D-10.
  const sApproved = await eosRow('E16', D(-14), 'COMPANY_TERMINATION', 1, 'OWNER_APPROVED', { ownerNotes: 'معتمد' });
  // S3: PAID.
  const sPaid = await eosRow('E13', D(-60), 'CONTRACT_EXPIRY', 1, 'PAID', { transferReceiptUrl: null, ownerNotes: 'معتمد' });
  // S4: REJECTED (employee stays active, the terminationDate was left on the file).
  await eosRow('E17', D(-5), 'COMPANY_TERMINATION', 1, 'REJECTED', { ownerNotes: 'مرفوض: لم يُستكمل الإشعار النظامي (المادة 75)' });
  // S5: LEAVE_SETTLEMENT PAID with leave compensation and NO Leave row for it.
  const e11 = empByKey.get('E11');
  const e11Comp = round2(((e11.basic + e11.housing) / 30) * 30);
  const sLeave = await settlement('E11', {
    type: 'LEAVE_SETTLEMENT', lastWorkingDate: D(-4), unusedLeaveDays: 30, leaveCompensation: e11Comp,
    additionalEntitlements: 0, additionalDeductions: 0, loansDeduction: 0, overtimeAmount: 0, totalSettlement: e11Comp, status: 'PAID',
    additionalNotes: 'تصفية إجازة سنوية قبل السفر (لا يوجد طلب إجازة مسجّل)',
  });

  // M5 / S2 / S3 / S5: PaymentRequests linked to settlements (entityType 'SETTLEMENT', as approveSettlement writes them).
  const payFor = (s, k, status, extra = {}) => {
    const e = empByKey.get(k);
    return tx.paymentRequest.create({
      data: {
        title: `تصفية مستحقات - ${e.first} ${e.last}`,
        reason: `اعتماد تصفية مستحقات. رقم الموظف: ${emps[k].employeeId}`,
        amount: Math.max(0, s.totalSettlement ?? 0),
        accountNumber: `تحويل بنكي | بنك: ${emps[k].bankName || '-'} | آيبان: -`,
        status,
        requestedById: users.owner.id,
        approvedById: users.owner.id,
        entityId: s.id,
        entityType: 'SETTLEMENT',
        ...extra,
      },
    }).then(() => bump('PaymentRequest'));
  };
  await payFor(sApproved, 'E16', 'PENDING_FINANCE');
  await payFor(sPaid, 'E13', 'PAID', { paidById: users.finance.id });
  await payFor(sLeave, 'E11', 'PAID', { paidById: users.finance.id });
  // M5: general payment request awaiting the owner (not linked to any entity).
  await tx.paymentRequest.create({
    data: { title: 'فاتورة التأمينات الاجتماعية', reason: `اشتراكات شهر ${PREV_MONTH}/${PREV_YEAR}`, amount: 18750.5, accountNumber: 'سداد: 0000000000', status: 'PENDING_OWNER', requestedById: users.finance.id },
  });
  bump('PaymentRequest');

  // --- Audit trail entry for the whole demo seed ---
  await tx.auditLog.create({
    data: { userId: null, action: 'CREATE', entityType: 'DemoSeed', entityId: company.id, details: JSON.stringify({ reason: 'demo-seed: demo tenant data (DEC-PO-050, not a baseline)', counts: summary }), ipAddress: 'cli' },
  });

  return summary;
}

/** Payroll row data (demo approximation; the app recalculates DRAFT rows). */
function payrollData(e, employeeId, month, year, status, x = {}) {
  const totalAllowances = round2(e.housing + e.transport);
  const gosiEmployee = gosiEmployeeOf(e);
  const loansDeduction = x.loans ?? 0;
  const otherDeductions = x.other ?? 0;
  const overtimeCost = x.overtime ?? 0;
  const bonusAmount = x.bonus ?? 0;
  const totalDeductions = round2(gosiEmployee + loansDeduction + otherDeductions);
  return {
    employeeId,
    month,
    year,
    basicSalary: e.basic,
    totalAllowances,
    totalDeductions,
    overtimeCost,
    netSalary: round2(e.basic + totalAllowances + overtimeCost + bonusAmount - totalDeductions),
    gosiEmployee,
    gosiEmployer: gosiEmployerOf(e),
    loansDeduction,
    violationsDeduction: 0,
    leaveDeduction: 0,
    otherDeductions,
    bonusAmount,
    needsReview: x.needsReview === true,
    reviewNote: x.reviewNote ?? null,
    status,
  };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('[demo-seed] REFUSED: DATABASE_URL is not set (use: DEMO_SEED=1 node --env-file=.env prisma/demo-seed.mjs)');
    process.exit(1);
  }
  const prisma = new PrismaClient();
  try {
    const refusal = await refusalReason(prisma);
    if (refusal) {
      console.error(`[demo-seed] REFUSED: ${refusal}`);
      process.exitCode = 1;
      return;
    }

    const password = generatePassword();
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

    const summary = await prisma.$transaction(
      async (tx) => {
        // Re-check inside the transaction so nothing slipped in between.
        const again = await refusalReason(tx);
        if (again) throw new Error(`REFUSED: ${again}`);
        return seed(tx, passwordHash);
      },
      { maxWait: 10_000, timeout: 120_000 },
    );

    console.log('[demo-seed] created:');
    for (const [k, n] of Object.entries(summary)) console.log(`  ${k.padEnd(36)} ${n}`);
    console.log(`\n[demo-seed] demo users (today = ${TODAY.toISOString().slice(0, 10)}, Asia/Riyadh):`);
    for (const u of USERS) {
      const note = [u.emp ? `employee ${u.emp}` : null, u.active === false ? 'INACTIVE (terminated)' : null].filter(Boolean).join(', ');
      console.log(`  ${u.role.padEnd(16)} ${`${u.email}@${DEMO_DOMAIN}`.padEnd(38)} ${note}`);
    }
    console.log(`\n[demo-seed] password for ALL demo users (shown once, not stored anywhere): ${password}`);
    console.log('[demo-seed] done. DEMO DATA ONLY: not a measurement baseline (DEC-PO-050).');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[demo-seed] FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
