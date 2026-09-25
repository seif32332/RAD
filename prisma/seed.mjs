#!/usr/bin/env node
/**
 * Radeef HRMS — idempotent database seed.
 *
 *   npm run db:seed          (or: node prisma/seed.mjs, or: npx prisma db seed)
 *
 * Safe to run any number of times against any tenant database. It only ever INSERTS rows that
 * are missing; it never updates or deletes existing data.
 *
 *   1. Nationality   — the default nationality list used by the employee form.
 *   2. SystemSetting — default values, only for keys that have no row yet. Existing values
 *                      (anything an admin saved from the settings page) are never overwritten.
 *   3. SUPER_ADMIN   — created only when NO active SUPER_ADMIN exists AND both ADMIN_EMAIL and
 *                      ADMIN_PASSWORD are set in the environment. Passwords are never hardcoded.
 *
 * RolePermission rows are intentionally NOT created: the UI falls back to built-in role defaults.
 *
 * Environment: DATABASE_URL (required), ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME (optional).
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const BCRYPT_COST = 12;

/** Same list (and order) as `defaultNationalities` in src/app/employees/new/page.tsx. */
const NATIONALITIES = ['سعودي', 'مصري', 'هندي', 'باكستاني', 'بنجلاديشي', 'فلبيني', 'نيبالي'];

/**
 * Default SystemSetting values. They mirror the defaults the application already applies in code
 * when a key is missing (src/app/api/settings/route.ts DEFAULT_SETTINGS, src/lib/alerts.ts
 * ALERT_THRESHOLD_SETTINGS, src/lib/payroll.ts DEFAULT_PAYROLL_SETTINGS, DEFAULT_EXIT_REENTRY_VISA_FEE
 * in src/lib/constants.ts), so seeding them does not change any calculation.
 *
 * Deliberately NOT seeded:
 *  - annual_leave_days: when the row is absent the leave engine uses the statutory 21/30-day
 *    entitlement; storing "30" would silently raise every employee under 5 years of service to 30.
 *  - org_name_arabic / org_name_english / org_logo_url / notification_email / notification_phone:
 *    placeholders or blanks that each tenant must fill in from the settings page.
 */
const DEFAULT_SETTINGS = {
  // General
  timezone: 'Asia/Riyadh',
  date_format: 'hijri',
  fiscal_year_start: '01-01',

  // HR alerts (days before expiry)
  alert_iqama_days: '30',
  alert_passport_days: '120',
  alert_health_cert_days: '30',
  alert_contract_days: '60',
  alert_probation_days: '30',
  alert_annual_leave_days: '120',
  alert_medical_insurance_days: '30',

  // Administrative alerts
  alert_commercial_reg_days: '30',
  alert_municipal_license_days: '30',
  alert_civil_defense_days: '30',
  alert_lease_contract_days: '60',
  alert_trademark_days: '60',
  alert_waste_contract_days: '30',
  alert_safety_contract_days: '30',
  alert_camera_contract_days: '30',

  // Logistics alerts
  alert_vehicle_license_days: '30',
  alert_vehicle_insurance_days: '30',
  alert_vehicle_inspection_days: '30',
  alert_operating_card_days: '30',
  alert_driver_card_days: '30',
  alert_driving_auth_days: '30',

  // Legal alerts
  alert_legal_contract_days: '60',
  alert_agency_days: '60',
  alert_promissory_note_days: '30',

  // Payroll
  overtime_rate_multiplier: '1.5',
  overtime_weekend_multiplier: '2.0',
  gosi_company_percentage: '11.75',
  gosi_employee_percentage: '9.75',
  gosi_employee_percentage_non_saudi: '0',
  default_work_hours_per_day: '8',
  default_work_days_per_week: '5',
  exit_reentry_visa_fee: '200',

  // Leave
  max_leave_carry_forward: '15',
  probation_period_days: '90',

  // Recruitment
  max_open_vacancies: '50',
  interview_reminder_hours: '24',

  // Security
  session_timeout_minutes: '720',
  max_login_attempts: '5',
  password_min_length: '8',
  require_2fa: 'false',

  // Notifications
  email_notifications: 'false',
  sms_notifications: 'false',

  // Backup
  auto_backup_enabled: 'false',
  backup_frequency: 'weekly',
  backup_retention_days: '30',
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Mirrors zPassword in src/lib/validation.ts. */
function passwordProblem(pw) {
  if (pw.length < 8) return 'must be at least 8 characters';
  if (pw.length > 128) return 'must be at most 128 characters';
  if (!/[A-Za-z]/.test(pw)) return 'must contain a letter';
  if (!/\d/.test(pw)) return 'must contain a digit';
  return null;
}

async function seedNationalities(prisma) {
  let created = 0;
  for (const label of NATIONALITIES) {
    // Sequential upserts keep createdAt order == list order (the API sorts by createdAt).
    const existing = await prisma.nationality.findUnique({ where: { label }, select: { id: true } });
    if (existing) continue;
    await prisma.nationality.upsert({ where: { label }, update: {}, create: { label } });
    created++;
  }
  console.log(`[seed] Nationality: ${created} created, ${NATIONALITIES.length - created} already present`);
}

async function seedSettings(prisma) {
  const data = Object.entries(DEFAULT_SETTINGS).map(([key, value]) => ({ key, value }));
  const { count } = await prisma.systemSetting.createMany({ data, skipDuplicates: true });
  console.log(`[seed] SystemSetting: ${count} created, ${data.length - count} already present (left unchanged)`);
}

async function seedSuperAdmin(prisma) {
  const activeAdmins = await prisma.user.count({ where: { role: 'SUPER_ADMIN', isActive: true } });
  if (activeAdmins > 0) {
    console.log(`[seed] SUPER_ADMIN: ${activeAdmins} active account(s) already exist — skipped`);
    return;
  }

  const email = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD ?? '';
  if (!email || !password) {
    console.warn(
      '[seed] SUPER_ADMIN: no active SUPER_ADMIN exists and ADMIN_EMAIL / ADMIN_PASSWORD are not set — skipped.\n' +
        '       Set both variables and re-run, or use: npm run admin:create -- <email> --role SUPER_ADMIN',
    );
    return;
  }
  if (!EMAIL_RE.test(email)) throw new Error('ADMIN_EMAIL is not a valid e-mail address');
  const problem = passwordProblem(password);
  if (problem) throw new Error(`ADMIN_PASSWORD ${problem}`);

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
  const existing = await prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { id: true, email: true },
  });

  if (existing) {
    // An inactive or lower-role account already uses this e-mail: promote and re-activate it.
    await prisma.user.update({
      where: { id: existing.id },
      data: { role: 'SUPER_ADMIN', isActive: true, passwordHash },
    });
    await audit(prisma, existing.id, 'UPDATE', { reason: 'seed: promoted to SUPER_ADMIN (none active)' });
    console.log(`[seed] SUPER_ADMIN: existing user ${existing.email} promoted, re-activated and password set`);
  } else {
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        role: 'SUPER_ADMIN',
        isActive: true,
        name: (process.env.ADMIN_NAME ?? '').trim() || 'مدير النظام',
      },
      select: { id: true },
    });
    await audit(prisma, user.id, 'CREATE', { reason: 'seed: initial SUPER_ADMIN' });
    console.log(`[seed] SUPER_ADMIN: created ${email}`);
  }
}

async function audit(prisma, userId, action, details) {
  try {
    await prisma.auditLog.create({
      data: { userId: null, action, entityType: 'User', entityId: userId, details: JSON.stringify(details), ipAddress: 'cli' },
    });
  } catch {
    // Audit logging must never make the seed fail.
  }
}

/** Load ./.env when present (Node >= 20.12); real environment variables always win. */
function loadDotEnv() {
  try {
    if (typeof process.loadEnvFile === 'function') process.loadEnvFile('.env');
  } catch {
    // No .env file — rely on the process environment.
  }
}

async function main() {
  loadDotEnv();
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set (export it or put it in .env)');
  }
  const prisma = new PrismaClient();
  try {
    await seedNationalities(prisma);
    await seedSettings(prisma);
    await seedSuperAdmin(prisma);
    console.log('[seed] done');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[seed] FAILED:', err instanceof Error ? err.message : err);
  process.exit(1);
});
