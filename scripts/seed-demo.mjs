#!/usr/bin/env node
/**
 * Radeef HRMS — synthetic DEMO tenant seed (DEC-010 item 9: "بيئة عرض ببذور اصطناعية فقط").
 *
 *   DATABASE_URL=postgresql://…/radeef_demo node scripts/seed-demo.mjs [--reset]
 *
 * Seeds, into the database given by DATABASE_URL:
 *   - 2 companies, 3 branches (each with a work schedule), 6 departments,
 *   - 30 employees (Saudi and non-Saudi, explicit nationality, GOSI regime set),
 *   - monthly allowances (housing counts toward GOSI, transport does not),
 *   - ~12 leaves (approved / pending / rejected, annual and sick),
 *   - 3 days of attendance, and ONE payroll month (the previous calendar month, APPROVED).
 *   - Optional: when DEMO_PASSWORD is set, login accounts demo-hr@demo.invalid (HR_MANAGER) and
 *     demo-employee@demo.invalid (EMPLOYEE, linked to DEMO-0001). Passwords are never hardcoded.
 *
 * Everything is deliberately, visibly FAKE so it can never be mistaken for real people:
 *   - employee numbers "DEMO-0001"…, last name "تجريبي", English name "Demo NN";
 *   - ID / iqama numbers start with 0 ("09xxxxxxxx"): real Saudi IDs start with 1 or 2;
 *   - IBANs use check digits "00" (SA00…), which fail the ISO 13616 mod-97 check by construction;
 *   - e-mails use the reserved ".invalid" TLD (RFC 2606); no mobile numbers are stored;
 *   - company registration numbers "DEMO-CR-…".
 *
 * Safety:
 *   - refuses to run when NODE_ENV=production;
 *   - refuses to run when the database already holds ANY employee whose number does not start
 *     with "DEMO-" (i.e. a real tenant);
 *   - without --reset it does nothing when demo data already exists; with --reset it deletes only
 *     rows that carry the demo markers above, then seeds again.
 *
 * Payroll GOSI shares use the GosiRate table of the target database (latest rate effective on the
 * payroll month for the employee regime); if no rate row applies the line is flagged needsReview.
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const DEMO_PREFIX = 'DEMO-';
const DEMO_EMAIL_DOMAIN = '@demo.invalid';
const BCRYPT_COST = 12;

function fail(msg) {
  console.error(`seed-demo: ${msg}`);
  process.exit(1);
}

if (process.env.NODE_ENV === 'production') fail('refusing to run with NODE_ENV=production.');
if (!process.env.DATABASE_URL) fail('DATABASE_URL is not set.');
const RESET = process.argv.includes('--reset');
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || '';
if (DEMO_PASSWORD && (DEMO_PASSWORD.length < 8 || !/[A-Za-z]/.test(DEMO_PASSWORD) || !/\d/.test(DEMO_PASSWORD))) {
  fail('DEMO_PASSWORD must be at least 8 characters with a letter and a digit.');
}

/** DATABASE_URL without the password, for the log line. */
function describeDb(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.username ? `${u.username}@` : ''}${u.host}${u.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
}

// ---------------------------------------------------------------------------------------------
// Deterministic pseudo-random generator: the same demo tenant on every run.
// ---------------------------------------------------------------------------------------------
let seed = 20240703;
function rand() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const pad = (n, w) => String(n).padStart(w, '0');
const round2 = (n) => Math.round(n * 100) / 100;

const DAY = 24 * 60 * 60 * 1000;
const now = new Date();
const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const addDays = (d, n) => new Date(d.getTime() + n * DAY);

/** Invalid-by-construction identifiers (see header). */
const fakeIdNumber = (i) => `09${pad(i, 8)}`;
const fakeIban = (i) => `SA00${pad(0, 2)}${pad(i, 18)}`; // 24 chars, check digits 00 never valid
const fakePassport = (i) => `DEMO-P-${pad(i, 4)}`;

const FIRST_NAMES_M = ['أحمد', 'خالد', 'فهد', 'سعد', 'عمر', 'يوسف', 'ماجد', 'نايف', 'تركي', 'سلمان', 'راشد', 'بدر', 'حسن', 'علي', 'زياد', 'طارق', 'وليد', 'هشام'];
const FIRST_NAMES_F = ['نورة', 'سارة', 'ريم', 'هند', 'لمى', 'دانة', 'مها', 'أمل', 'جود', 'رهف', 'غادة', 'منى'];
const NON_SAUDI = ['مصري', 'هندي', 'باكستاني', 'فلبيني', 'بنجلاديشي', 'نيبالي'];
const JOB_TITLES = ['محاسب', 'مشرف مبيعات', 'أخصائي موارد بشرية', 'فني صيانة', 'مندوب مبيعات', 'كاشير', 'مدير فرع', 'أمين مستودع', 'سائق', 'مسؤول خدمة عملاء'];

const COMPANIES = [
  { key: 'C1', nameArabic: 'شركة رديف التجريبية للتجارة (بيانات تجريبية)', nameEnglish: 'Radeef Demo Trading Co. (DEMO)', cr: `${DEMO_PREFIX}CR-0001`, expDays: 20 },
  { key: 'C2', nameArabic: 'مؤسسة العرض التجريبية للخدمات (بيانات تجريبية)', nameEnglish: 'Demo Services Est. (DEMO)', cr: `${DEMO_PREFIX}CR-0002`, expDays: 300 },
];
const BRANCHES = [
  { key: 'B1', company: 'C1', nameArabic: 'فرع الرياض التجريبي', city: 'الرياض', munExpDays: 12 },
  { key: 'B2', company: 'C1', nameArabic: 'فرع جدة التجريبي', city: 'جدة', munExpDays: 200 },
  { key: 'B3', company: 'C2', nameArabic: 'فرع الدمام التجريبي', city: 'الدمام', munExpDays: 90 },
];
const DEPARTMENTS = ['المبيعات', 'العمليات'];

// ---------------------------------------------------------------------------------------------

const prisma = new PrismaClient();

async function assertSafeTarget() {
  const realEmployees = await prisma.employee.count({ where: { NOT: { employeeId: { startsWith: DEMO_PREFIX } } } });
  if (realEmployees > 0) {
    fail(`the target database already has ${realEmployees} non-demo employee(s). The demo seed only runs on an empty or demo-only database.`);
  }
}

async function removeDemoData() {
  const demoEmployees = await prisma.employee.findMany({ where: { employeeId: { startsWith: DEMO_PREFIX } }, select: { id: true } });
  const ids = demoEmployees.map((e) => e.id);
  const demoCompanies = await prisma.company.findMany({ where: { commercialRegNum: { startsWith: DEMO_PREFIX } }, select: { id: true } });
  const companyIds = demoCompanies.map((c) => c.id);
  await prisma.$transaction([
    prisma.payroll.deleteMany({ where: { employeeId: { in: ids } } }),
    prisma.leave.deleteMany({ where: { employeeId: { in: ids } } }),
    prisma.attendance.deleteMany({ where: { employeeId: { in: ids } } }),
    prisma.allowance.deleteMany({ where: { employeeId: { in: ids } } }),
    prisma.employee.updateMany({ where: { id: { in: ids } }, data: { directManagerId: null, userId: null } }),
    prisma.employee.deleteMany({ where: { id: { in: ids } } }),
    prisma.user.deleteMany({ where: { email: { endsWith: DEMO_EMAIL_DOMAIN } } }),
    prisma.department.deleteMany({ where: { branch: { companyId: { in: companyIds } } } }),
    prisma.workSchedule.deleteMany({ where: { branch: { companyId: { in: companyIds } } } }),
    prisma.branch.deleteMany({ where: { companyId: { in: companyIds } } }),
    prisma.company.deleteMany({ where: { id: { in: companyIds } } }),
  ]);
  console.log(`seed-demo: removed previous demo data (${ids.length} employees, ${companyIds.length} companies).`);
}

/** Latest GosiRate row effective on `onDate` for the regime / nationality, or null. */
function gosiRateFor(rates, regime, isSaudi, onDate) {
  const r = rates
    .filter((x) => x.regime === regime && x.isSaudi === isSaudi && x.effectiveFrom <= onDate)
    .sort((a, b) => b.effectiveFrom - a.effectiveFrom)[0];
  return r ?? null;
}

async function main() {
  console.log(`seed-demo: target ${describeDb(process.env.DATABASE_URL)}`);
  await assertSafeTarget();

  const existingDemo = await prisma.employee.count({ where: { employeeId: { startsWith: DEMO_PREFIX } } });
  if (existingDemo > 0) {
    if (!RESET) {
      console.log(`seed-demo: demo data already present (${existingDemo} employees). Nothing to do (use --reset to rebuild it).`);
      return;
    }
    await removeDemoData();
  }

  // Nationality list used by the employee form (insert missing labels only).
  for (const label of ['سعودي', ...NON_SAUDI]) {
    await prisma.nationality.upsert({ where: { label }, update: {}, create: { label } });
  }

  // --- Companies, branches, schedules, departments ---------------------------------------
  const companyId = {};
  for (const c of COMPANIES) {
    const row = await prisma.company.create({
      data: {
        nameArabic: c.nameArabic,
        nameEnglish: c.nameEnglish,
        commercialRegNum: c.cr,
        commercialRegDate: addDays(todayUtc, -900),
        commercialRegExp: addDays(todayUtc, c.expDays),
        unifiedNumber: `${DEMO_PREFIX}700${c.key}`,
        molEstablishmentNumber: `${DEMO_PREFIX}MOL-${c.key}`,
        gosiEstablishmentNumber: `${DEMO_PREFIX}GOSI-${c.key}`,
      },
      select: { id: true },
    });
    companyId[c.key] = row.id;
  }

  const branchInfo = {};
  for (const b of BRANCHES) {
    const row = await prisma.branch.create({
      data: {
        companyId: companyId[b.company],
        nameArabic: b.nameArabic,
        nameEnglish: `Demo ${b.city}`,
        city: b.city,
        branchCode: `${DEMO_PREFIX}${b.key}`,
        munLicenseNum: `${DEMO_PREFIX}MUN-${b.key}`,
        munLicenseExp: addDays(todayUtc, b.munExpDays),
        civilDefenseExp: addDays(todayUtc, b.munExpDays + 60),
        workSchedules: {
          create: [{ name: 'دوام نهاري (تجريبي)', shiftType: 'ONE_SHIFT', startTime: '08:00', endTime: '17:00', workDays: 'الأحد-الخميس' }],
        },
        departments: { create: DEPARTMENTS.map((d) => ({ nameArabic: `${d} - ${b.city}` })) },
      },
      select: { id: true, departments: { select: { id: true } } },
    });
    branchInfo[b.key] = { id: row.id, companyKey: b.company, departments: row.departments.map((d) => d.id) };
  }

  // --- Employees -------------------------------------------------------------------------
  const branchKeys = Object.keys(branchInfo);
  const employees = [];
  for (let i = 1; i <= 30; i++) {
    const isSaudi = i % 3 !== 0; // two thirds Saudi
    const female = i % 4 === 0;
    const first = female ? pick(FIRST_NAMES_F) : pick(FIRST_NAMES_M);
    const branchKey = branchKeys[(i - 1) % branchKeys.length];
    const br = branchInfo[branchKey];
    // Join dates spread over 2019-2025 so both GOSI regimes appear among Saudis.
    const joinDate = addDays(new Date(Date.UTC(2019, 0, 6)), Math.floor(rand() * 2400));
    const gosiRegime = !isSaudi ? 'OLD' : joinDate < new Date(Date.UTC(2024, 6, 3)) ? 'OLD' : 'NEW';
    const basicSalary = Math.round((4000 + rand() * 11000) / 50) * 50;
    // A few documents inside the alert windows so the alert screens have content.
    const idExpDays = i <= 3 ? 10 + i * 5 : 120 + Math.floor(rand() * 600);
    const row = await prisma.employee.create({
      data: {
        employeeId: `${DEMO_PREFIX}${pad(i, 4)}`,
        firstNameArabic: first,
        lastNameArabic: 'تجريبي',
        firstNameEnglish: 'Demo',
        lastNameEnglish: pad(i, 2),
        nationality: isSaudi ? 'سعودي' : pick(NON_SAUDI),
        idType: isSaudi ? 'NATIONAL_ID' : 'IQAMA',
        iqamaOrIdNumber: fakeIdNumber(i),
        iqamaOrIdExp: addDays(todayUtc, idExpDays),
        passportNumber: isSaudi ? null : fakePassport(i),
        passportExp: isSaudi ? null : addDays(todayUtc, 400 + i * 10),
        healthCertificateExp: i % 5 === 0 ? addDays(todayUtc, 25) : null,
        dateOfBirth: new Date(Date.UTC(1980 + (i % 20), i % 12, 1 + (i % 27))),
        gender: female ? 'FEMALE' : 'MALE',
        maritalStatus: i % 2 === 0 ? 'متزوج' : 'أعزب',
        mobileNumber: null,
        email: `demo${pad(i, 2)}${DEMO_EMAIL_DOMAIN}`,
        ibanNumber: fakeIban(i),
        bankName: 'بنك تجريبي',
        salaryPaymentMethod: 'BANK_TRANSFER',
        legalCompanyId: companyId[br.companyKey],
        actualCompanyId: companyId[br.companyKey],
        branchId: br.id,
        departmentId: br.departments[i % br.departments.length],
        jobTitle: pick(JOB_TITLES),
        workSchedule: 'دوام نهاري (تجريبي)',
        joinDate,
        contractType: 'FULL_TIME',
        contractEndDate: i % 7 === 0 ? addDays(todayUtc, 45) : null,
        basicSalary,
        gosiRegime,
        gosiRegistrationSource: 'بيانات تجريبية (غير حقيقية)',
        gosiNumber: `${DEMO_PREFIX}G${pad(i, 6)}`,
        dataReviewNote: 'موظف تجريبي: الهوية والآيبان غير صالحين عمداً.',
        allowances: {
          create: [
            { name: 'بدل سكن', amount: round2(basicSalary * 0.25), isMonthly: true, countsTowardGosi: true },
            { name: 'بدل نقل', amount: round2(basicSalary * 0.1), isMonthly: true, countsTowardGosi: false },
          ],
        },
      },
      select: { id: true, employeeId: true, basicSalary: true, nationality: true, gosiRegime: true, allowances: { select: { amount: true, countsTowardGosi: true } } },
    });
    employees.push(row);
  }

  // Direct managers: the first employee of each branch manages the others of that branch.
  for (let b = 0; b < branchKeys.length; b++) {
    const members = employees.filter((_, idx) => idx % branchKeys.length === b);
    const [manager, ...rest] = members;
    if (manager && rest.length) {
      await prisma.employee.updateMany({ where: { id: { in: rest.map((e) => e.id) } }, data: { directManagerId: manager.id } });
    }
  }

  // --- Leaves ------------------------------------------------------------------------------
  const leaveSpecs = [
    { emp: 1, type: 'ANNUAL', start: -40, days: 10, status: 'APPROVED' },
    { emp: 2, type: 'SICK', start: -12, days: 3, status: 'APPROVED' },
    { emp: 4, type: 'ANNUAL', start: -1, days: 7, status: 'APPROVED' },
    { emp: 5, type: 'ANNUAL', start: 14, days: 5, status: 'PENDING' },
    { emp: 7, type: 'ANNUAL', start: 30, days: 12, status: 'PENDING' },
    { emp: 8, type: 'UNPAID', start: 20, days: 2, status: 'REJECTED' },
    { emp: 10, type: 'ANNUAL', start: -90, days: 15, status: 'APPROVED' },
    { emp: 11, type: 'SICK', start: -3, days: 2, status: 'APPROVED' },
    { emp: 13, type: 'ANNUAL', start: 45, days: 21, status: 'PENDING' },
    { emp: 16, type: 'DEDUCTED', start: -20, days: 1, status: 'APPROVED' },
    { emp: 19, type: 'ANNUAL', start: 5, days: 4, status: 'PENDING' },
    { emp: 22, type: 'ANNUAL', start: -60, days: 8, status: 'CANCELLED' },
  ];
  for (const l of leaveSpecs) {
    const e = employees[l.emp - 1];
    const startDate = addDays(todayUtc, l.start);
    const approved = l.status === 'APPROVED';
    await prisma.leave.create({
      data: {
        employeeId: e.id,
        leaveType: l.type,
        startDate,
        endDate: addDays(startDate, l.days - 1),
        totalDays: l.days,
        status: l.status,
        notes: 'إجازة تجريبية',
        isManagerApproved: approved,
        managerApprovedAt: approved ? addDays(startDate, -3) : null,
        isHrApproved: approved,
        hrApprovedAt: approved ? addDays(startDate, -2) : null,
        paidDays: l.type === 'UNPAID' ? 0 : l.days,
        unpaidDays: l.type === 'UNPAID' ? l.days : 0,
        totalDeduction: 0,
      },
    });
  }

  // --- Attendance: last 3 days, most employees present ----------------------------------------
  const attendanceRows = [];
  for (let d = 1; d <= 3; d++) {
    const date = addDays(todayUtc, -d);
    for (const [idx, e] of employees.entries()) {
      if ((idx + d) % 6 === 0) continue; // some absences / missing punches
      const late = (idx + d) % 5 === 0 ? 15 : 0;
      attendanceRows.push({
        employeeId: e.id,
        date,
        // 08:00 Riyadh = 05:00 UTC
        checkIn: new Date(date.getTime() + (5 * 60 + late) * 60 * 1000),
        checkOut: new Date(date.getTime() + 14 * 60 * 60 * 1000),
        status: 'PRESENT',
        lateMinutes: late,
      });
    }
  }
  await prisma.attendance.createMany({ data: attendanceRows, skipDuplicates: true });

  // --- One payroll month (previous calendar month) -----------------------------------------
  const pm = new Date(Date.UTC(todayUtc.getUTCFullYear(), todayUtc.getUTCMonth() - 1, 1));
  const month = pm.getUTCMonth() + 1;
  const year = pm.getUTCFullYear();
  const rates = await prisma.gosiRate.findMany();
  let flagged = 0;
  for (const e of employees) {
    const isSaudi = e.nationality === 'سعودي';
    const totalAllowances = round2(e.allowances.reduce((s, a) => s + a.amount, 0));
    const gosiBase = e.basicSalary + e.allowances.filter((a) => a.countsTowardGosi).reduce((s, a) => s + a.amount, 0);
    const rate = gosiRateFor(rates, e.gosiRegime, isSaudi, pm);
    const wage = rate ? Math.min(Math.max(gosiBase, rate.minWage), rate.maxWage) : 0;
    const gosiEmployee = rate ? round2((wage * rate.employeeRate) / 100) : 0;
    const gosiEmployer = rate ? round2((wage * rate.employerRate) / 100) : 0;
    if (!rate) flagged++;
    await prisma.payroll.create({
      data: {
        employeeId: e.id,
        month,
        year,
        basicSalary: e.basicSalary,
        totalAllowances,
        totalDeductions: gosiEmployee,
        overtimeCost: 0,
        netSalary: round2(e.basicSalary + totalAllowances - gosiEmployee),
        gosiEmployee,
        gosiEmployer,
        status: 'APPROVED',
        needsReview: !rate,
        reviewNote: rate
          ? `بيانات تجريبية${rate.isProvisional ? ' — نسبة التأمينات مؤقتة (بانتظار التأكيد)' : ''}`
          : 'بيانات تجريبية — لا توجد نسبة تأمينات مطبقة لهذا الشهر في جدول GosiRate',
      },
    });
  }

  // --- Optional demo logins ------------------------------------------------------------------
  let accounts = 'none (set DEMO_PASSWORD to create demo-hr / demo-employee logins)';
  if (DEMO_PASSWORD) {
    const hash = await bcrypt.hash(DEMO_PASSWORD, BCRYPT_COST);
    await prisma.user.create({ data: { email: `demo-hr${DEMO_EMAIL_DOMAIN}`, passwordHash: hash, role: 'HR_MANAGER', name: 'مسؤول موارد بشرية (تجريبي)' } });
    const empUser = await prisma.user.create({ data: { email: `demo-employee${DEMO_EMAIL_DOMAIN}`, passwordHash: hash, role: 'EMPLOYEE', name: 'موظف تجريبي' } });
    await prisma.employee.update({ where: { id: employees[0].id }, data: { userId: empUser.id } });
    accounts = `demo-hr${DEMO_EMAIL_DOMAIN}, demo-employee${DEMO_EMAIL_DOMAIN} (password from DEMO_PASSWORD)`;
  }

  console.log(
    [
      'seed-demo: done.',
      `  companies: ${COMPANIES.length}, branches: ${BRANCHES.length}, departments: ${BRANCHES.length * DEPARTMENTS.length}`,
      `  employees: ${employees.length} (DEMO-0001..DEMO-0030; IDs 09xxxxxxxx, IBANs SA00…: invalid on purpose)`,
      `  leaves: ${leaveSpecs.length}, attendance rows: ${attendanceRows.length}`,
      `  payroll: ${month}/${year} APPROVED, ${employees.length} lines${flagged ? `, ${flagged} flagged needsReview (no GOSI rate)` : ''}`,
      `  logins: ${accounts}`,
    ].join('\n'),
  );
}

main()
  .catch((err) => {
    console.error('seed-demo: failed:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
