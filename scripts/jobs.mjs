#!/usr/bin/env node
/**
 * Radeef HRMS — background job runner (DEC-009). A CLI, never an HTTP endpoint: nginx proxies
 * every request from 127.0.0.1, so an "internal-only" route cannot be told apart from the internet.
 *
 *   node --env-file=/etc/radeef/<tenant>.env scripts/jobs.mjs <job> [--dry-run]
 *
 * Jobs
 *   expiry-digest          Counts of expired / expiring documents per category (same thresholds and
 *                          SystemSetting keys as src/lib/alerts.ts) and ONE NotificationOutbox row per
 *                          admin user per day: counts + a login link only — no names, no ID numbers.
 *                          idempotencyKey = expiry-digest:<userId>:<YYYY-MM-DD> (Asia/Riyadh day).
 *   deactivate-terminated  Deactivates (isActive=false, sessionVersion+1, audit row) the logins of
 *                          employees terminated at least `terminated_access_days` days ago
 *                          (SystemSetting, default 0 = immediately; same rule as src/lib/access.ts).
 *   outbox-dispatch        DRY RUN unless OUTBOX_SEND=true AND SMTP_HOST/SMTP_USER/SMTP_PASS/SMTP_FROM
 *                          are set. State machine: PENDING -> SENDING (lease) -> SENT | FAILED | UNKNOWN.
 *                          A lease that expires, or a send that times out, becomes UNKNOWN and is never
 *                          retried automatically (it may have been delivered). Only definite failures
 *                          (FAILED) are retried, up to OUTBOX_MAX_ATTEMPTS.
 *
 * Every run writes a JobRun row (RUNNING -> SUCCEEDED | FAILED, details = JSON summary without
 * personal data). A second run of the same job while one is RUNNING is skipped; RUNNING rows older
 * than 2 hours are marked FAILED ("abandoned"). The Prisma pool is capped at connection_limit=2.
 *
 * Exit codes: 0 ok (or skipped), 1 job failed, 2 usage error.
 *
 * NOTE on duplication: the date math and the threshold table below re-implement the minimal parts of
 * src/lib/dates.ts (todayKey / daysUntil in the Riyadh calendar, date-only values stored at UTC
 * midnight) and src/lib/alerts.ts (ALERT_THRESHOLD_SETTINGS, classifyExpiry). This script runs with
 * plain `node` from a release directory (no TypeScript toolchain), so it cannot import them. The
 * unit test src/lib/__tests__/x-ops-jobs.test.ts asserts the thresholds and the classification stay
 * identical to alerts.ts — keep both in sync.
 */
import { PrismaClient } from '@prisma/client';
import { pathToFileURL } from 'node:url';

export const JOB_NAMES = ['expiry-digest', 'deactivate-terminated', 'outbox-dispatch'];
export const JOB_CONNECTION_LIMIT = 2;
const DAY_MS = 24 * 60 * 60 * 1000;
const RIYADH_OFFSET_MS = 3 * 60 * 60 * 1000;
const STALE_RUN_MS = 2 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------------------------

/** Today's calendar day in Asia/Riyadh (UTC+3, no DST) as YYYY-MM-DD. Same as src/lib/dates.ts todayKey. */
export function riyadhTodayKey(now = new Date()) {
  return new Date(now.getTime() + RIYADH_OFFSET_MS).toISOString().slice(0, 10);
}

/** Whole days from today (Riyadh) to a date-only value stored at UTC midnight. Same as dates.ts daysUntil. */
export function daysUntil(date, now = new Date()) {
  if (date === null || date === undefined || date === '') return null;
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const key = d.toISOString().slice(0, 10);
  return Math.round((Date.parse(`${key}T00:00:00Z`) - Date.parse(`${riyadhTodayKey(now)}T00:00:00Z`)) / DAY_MS);
}

/**
 * 'expired' (daysLeft < 0), 'expiring' (0 <= daysLeft <= threshold) or null.
 * Mirrors alerts.ts classifyExpiry: expired < 0; critical and warning are both "expiring" here.
 */
export function classifyForDigest(date, thresholdDays, now = new Date()) {
  const daysLeft = daysUntil(date, now);
  if (daysLeft === null || Number.isNaN(daysLeft)) return null;
  const threshold = Number.isFinite(thresholdDays) ? Math.max(0, thresholdDays) : 0;
  if (daysLeft < 0) return 'expired';
  if (daysLeft <= threshold) return 'expiring';
  return null;
}

/** Exclusive DB upper bound "expires within thresholdDays (or already expired)". Same as alerts.ts alertCutoffDate. */
export function alertCutoffDate(thresholdDays, now = new Date()) {
  const today = new Date(`${riyadhTodayKey(now)}T00:00:00.000Z`);
  return new Date(today.getTime() + (Math.max(0, Math.floor(thresholdDays)) + 1) * DAY_MS);
}

/** Subset of alerts.ts ALERT_THRESHOLD_SETTINGS used by the digest (same keys and defaults). */
export const DIGEST_THRESHOLDS = Object.freeze({
  iqama: { key: 'alert_iqama_days', days: 30 },
  passport: { key: 'alert_passport_days', days: 120 },
  healthCert: { key: 'alert_health_cert_days', days: 30 },
  medicalInsurance: { key: 'alert_medical_insurance_days', days: 30 },
  commercialReg: { key: 'alert_commercial_reg_days', days: 30 },
  trademark: { key: 'alert_trademark_days', days: 60 },
  municipalLicense: { key: 'alert_municipal_license_days', days: 30 },
  civilDefense: { key: 'alert_civil_defense_days', days: 30 },
  leaseContract: { key: 'alert_lease_contract_days', days: 60 },
  wasteContract: { key: 'alert_waste_contract_days', days: 30 },
  safetyContract: { key: 'alert_safety_contract_days', days: 30 },
  cameraContract: { key: 'alert_camera_contract_days', days: 30 },
  vehicleLicense: { key: 'alert_vehicle_license_days', days: 30 },
  vehicleInsurance: { key: 'alert_vehicle_insurance_days', days: 30 },
  vehicleInspection: { key: 'alert_vehicle_inspection_days', days: 30 },
  operatingCard: { key: 'alert_operating_card_days', days: 30 },
  driverCard: { key: 'alert_driver_card_days', days: 30 },
  drivingAuth: { key: 'alert_driving_auth_days', days: 30 },
  legalContract: { key: 'alert_legal_contract_days', days: 60 },
  agency: { key: 'alert_agency_days', days: 60 },
});

/** Arabic labels for the digest body (category names only; never record data). */
export const CATEGORY_LABELS = Object.freeze({
  iqama: 'الإقامات / الهويات',
  passport: 'جوازات السفر',
  healthCert: 'الشهادات الصحية',
  medicalInsurance: 'وثائق التأمين الطبي',
  commercialReg: 'مواعيد التأكيد السنوي للسجلات التجارية',
  trademark: 'العلامات التجارية',
  municipalLicense: 'رخص البلدية',
  civilDefense: 'شهادات الدفاع المدني',
  leaseContract: 'عقود إيجار الفروع',
  wasteContract: 'عقود النفايات للفروع',
  safetyContract: 'عقود صيانة السلامة للفروع',
  cameraContract: 'عقود صيانة الكاميرات للفروع',
  vehicleLicense: 'رخص سير المركبات',
  vehicleInsurance: 'تأمين المركبات',
  vehicleInspection: 'الفحص الدوري للمركبات',
  operatingCard: 'بطاقات التشغيل',
  driverCard: 'بطاقات السائقين',
  drivingAuth: 'تفويضات القيادة',
  legalContract: 'العقود القانونية',
  agency: 'الوكالات الشرعية',
});

/** Same parsing as alerts.ts parseThresholdValue: positive whole days (max 3650), else null. */
export function parseThresholdValue(value) {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(Math.floor(n), 3650);
}

/**
 * @param {ReadonlyArray<{ key: string, value: string | null }>} settingRows
 * @returns {Record<string, number>}
 */
export function digestThresholds(settingRows) {
  const byKey = new Map((settingRows || []).map((r) => [r.key, r.value]));
  /** @type {Record<string, number>} */
  const out = {};
  for (const [name, { key, days }] of Object.entries(DIGEST_THRESHOLDS)) {
    const parsed = parseThresholdValue(byKey.get(key));
    out[name] = parsed === null ? days : parsed;
  }
  return out;
}

/** Same rule as src/lib/access.ts terminatedAccessDays: finite > 0 -> min(floor, 90), else 0. */
export function parseGraceDays(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 90) : 0;
}

/**
 * Has the post-termination access window ended? With graceDays = 0 access ends immediately
 * (whatever the date). Otherwise access ends once `graceDays` whole Riyadh days have passed since
 * the termination date (terminated on day D with 3 days grace -> deactivated from day D+3).
 */
export function accessExpired(terminatedOn, graceDays, now = new Date()) {
  if (!graceDays) return true;
  const left = daysUntil(terminatedOn, now);
  if (left === null) return true; // no usable date: fail closed
  return -left >= graceDays;
}

export function digestIdempotencyKey(userId, dayKey) {
  return `expiry-digest:${userId}:${dayKey}`;
}

/** Set Prisma's connection_limit on a URL (replacing any existing value). */
export function withConnectionLimit(url, limit = JOB_CONNECTION_LIMIT) {
  if (!url) return url;
  const [base, query = ''] = url.split('?');
  const params = query.split('&').filter((p) => p && !p.startsWith('connection_limit='));
  params.push(`connection_limit=${limit}`);
  return `${base}?${params.join('&')}`;
}

/**
 * Plain-text digest: counts only + a login link. No names, numbers, dates or amounts of any record.
 * Returns null when every count is zero (nothing is sent on a quiet day).
 */
export function buildDigest(counts, { dayKey, loginUrl }) {
  const rows = Object.entries(counts).filter(([, c]) => c.expired > 0 || c.expiring > 0);
  if (rows.length === 0) return null;
  const totalExpired = rows.reduce((s, [, c]) => s + c.expired, 0);
  const totalExpiring = rows.reduce((s, [, c]) => s + c.expiring, 0);
  const lines = [
    'ملخص تنبيهات المستندات — نظام رديف',
    `التاريخ: ${dayKey}`,
    '',
    `منتهية: ${totalExpired} — تنتهي قريباً: ${totalExpiring}`,
    '',
    ...rows.map(([name, c]) => `- ${CATEGORY_LABELS[name] || name}: منتهية ${c.expired}، تنتهي قريباً ${c.expiring}`),
    '',
    'التفاصيل متاحة داخل النظام فقط بعد تسجيل الدخول.',
    loginUrl ? `تسجيل الدخول: ${loginUrl}` : 'سجّل الدخول إلى النظام للاطلاع على التفاصيل.',
    '',
    'هذه رسالة آلية تحتوي أعداداً فقط، ولا تتضمن أسماء أو أرقام هوية.',
  ];
  return {
    subject: `رديف: ${totalExpired} مستند منتهٍ و${totalExpiring} يقترب انتهاؤه (${dayKey})`,
    body: lines.join('\n'),
  };
}

/**
 * Outcome of a failed SMTP attempt: 'UNKNOWN' when the message may have been delivered (timeouts,
 * connection dropped after the transaction started) — never retried automatically; 'FAILED' when it
 * certainly was not (connection refused, DNS, auth, an SMTP rejection) — retried up to the limit.
 */
export function classifySendError(err) {
  const code = String((err && err.code) || '');
  const msg = String((err && err.message) || '');
  const command = String((err && err.command) || '');
  if (code === 'ETIMEDOUT' || /time(d)?[ -]?out/i.test(msg)) return 'UNKNOWN';
  if ((code === 'ECONNRESET' || code === 'EPIPE' || code === 'ESOCKET') && /DATA|MESSAGE/i.test(command)) return 'UNKNOWN';
  if (err && Number.isInteger(err.responseCode)) return 'FAILED';
  if (['ECONNREFUSED', 'EDNS', 'ENOTFOUND', 'EAUTH', 'EENVELOPE', 'ECONNECTION', 'ETLS'].includes(code)) return 'FAILED';
  return 'UNKNOWN';
}

/** @param {Record<string, string | undefined>} [env] */
export function outboxSendConfig(env = process.env) {
  const missing = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'].filter((k) => !env[k]);
  const enabled = env.OUTBOX_SEND === 'true';
  return {
    live: enabled && missing.length === 0,
    reason: !enabled ? 'OUTBOX_SEND is not "true"' : missing.length ? `SMTP not configured (${missing.join(', ')})` : null,
    batch: clampInt(env.OUTBOX_BATCH, 20, 1, 200),
    leaseSeconds: clampInt(env.OUTBOX_LEASE_SECONDS, 300, 60, 3600),
    maxAttempts: clampInt(env.OUTBOX_MAX_ATTEMPTS, 3, 1, 10),
  };
}

function clampInt(raw, fallback, min, max) {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

const EMAIL_RE = /^[^\s@"'<>]{1,64}@[^\s@"'<>]{1,253}\.[a-z]{2,63}$/i;

// ---------------------------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------------------------

function countDates(rows, field, threshold, now) {
  const out = { expired: 0, expiring: 0 };
  for (const r of rows) {
    const level = classifyForDigest(r[field], threshold, now);
    if (level) out[level] += 1;
  }
  return out;
}

/** Counts per category. Only date columns are selected: no names or numbers leave the database. */
export async function computeExpiryCounts(prisma, now = new Date()) {
  const settings = await prisma.systemSetting.findMany({
    where: { key: { in: Object.values(DIGEST_THRESHOLDS).map((t) => t.key) } },
    select: { key: true, value: true },
  });
  const t = digestThresholds(settings);
  const lt = (name) => ({ lt: alertCutoffDate(t[name], now) });

  const [employees, insurances, companies, branches, vehicles, contracts, agencies] = await Promise.all([
    prisma.employee.findMany({
      where: { isTerminated: false, OR: [{ iqamaOrIdExp: lt('iqama') }, { passportExp: lt('passport') }, { healthCertificateExp: lt('healthCert') }] },
      select: { iqamaOrIdExp: true, passportExp: true, healthCertificateExp: true },
    }),
    prisma.medicalInsurance.findMany({ where: { expiryDate: lt('medicalInsurance') }, select: { expiryDate: true } }),
    prisma.company.findMany({
      where: { OR: [{ commercialRegExp: lt('commercialReg') }, { trademarkExpDate: lt('trademark') }] },
      select: { commercialRegExp: true, trademarkExpDate: true },
    }),
    prisma.branch.findMany({
      where: {
        OR: [
          { munLicenseExp: lt('municipalLicense') },
          { civilDefenseExp: lt('civilDefense') },
          { rentContractExp: lt('leaseContract') },
          { wasteContractExp: lt('wasteContract') },
          { safetyContractExp: lt('safetyContract') },
          { cameraContractExp: lt('cameraContract') },
        ],
      },
      select: {
        munLicenseExp: true,
        civilDefenseExp: true,
        rentContractExp: true,
        wasteContractExp: true,
        safetyContractExp: true,
        cameraContractExp: true,
      },
    }),
    prisma.vehicle.findMany({
      where: {
        isArchived: false,
        OR: [
          { licenseExpDate: lt('vehicleLicense') },
          { insuranceExpDate: lt('vehicleInsurance') },
          { inspectionExpDate: lt('vehicleInspection') },
          { operatingCardExpDate: lt('operatingCard') },
          { driverCardExpDate: lt('driverCard') },
          { drivingAuthExpDate: lt('drivingAuth') },
        ],
      },
      select: { licenseExpDate: true, insuranceExpDate: true, inspectionExpDate: true, operatingCardExpDate: true, driverCardExpDate: true, drivingAuthExpDate: true },
    }),
    prisma.legalContract.findMany({ where: { status: 'ACTIVE', endDate: { not: null, ...lt('legalContract') } }, select: { endDate: true } }),
    prisma.certifiedAgency.findMany({ where: { status: 'ACTIVE', endDate: lt('agency') }, select: { endDate: true } }),
  ]);

  return {
    iqama: countDates(employees, 'iqamaOrIdExp', t.iqama, now),
    passport: countDates(employees, 'passportExp', t.passport, now),
    healthCert: countDates(employees, 'healthCertificateExp', t.healthCert, now),
    medicalInsurance: countDates(insurances, 'expiryDate', t.medicalInsurance, now),
    commercialReg: countDates(companies, 'commercialRegExp', t.commercialReg, now),
    trademark: countDates(companies, 'trademarkExpDate', t.trademark, now),
    municipalLicense: countDates(branches, 'munLicenseExp', t.municipalLicense, now),
    civilDefense: countDates(branches, 'civilDefenseExp', t.civilDefense, now),
    leaseContract: countDates(branches, 'rentContractExp', t.leaseContract, now),
    wasteContract: countDates(branches, 'wasteContractExp', t.wasteContract, now),
    safetyContract: countDates(branches, 'safetyContractExp', t.safetyContract, now),
    cameraContract: countDates(branches, 'cameraContractExp', t.cameraContract, now),
    vehicleLicense: countDates(vehicles, 'licenseExpDate', t.vehicleLicense, now),
    vehicleInsurance: countDates(vehicles, 'insuranceExpDate', t.vehicleInsurance, now),
    vehicleInspection: countDates(vehicles, 'inspectionExpDate', t.vehicleInspection, now),
    operatingCard: countDates(vehicles, 'operatingCardExpDate', t.operatingCard, now),
    driverCard: countDates(vehicles, 'driverCardExpDate', t.driverCard, now),
    drivingAuth: countDates(vehicles, 'drivingAuthExpDate', t.drivingAuth, now),
    legalContract: countDates(contracts, 'endDate', t.legalContract, now),
    agency: countDates(agencies, 'endDate', t.agency, now),
  };
}

/** Roles that receive the digest: SystemSetting expiry_digest_roles (comma list), default owners/admins. */
const DEFAULT_DIGEST_ROLES = ['SUPER_ADMIN', 'COMPANY_ADMIN'];
const KNOWN_ROLES = new Set([
  'SUPER_ADMIN', 'COMPANY_ADMIN', 'HR_MANAGER', 'FINANCE_MANAGER', 'PAYROLL_ADMIN', 'GOV_RELATIONS',
  'LEGAL_ADMIN', 'BRANCH_MANAGER', 'EMPLOYEE', 'DEPT_MANAGER', 'PURCHASING_AGENT',
]);

export function parseDigestRoles(value) {
  // Org-wide counts: never to EMPLOYEE, even if configured.
  const roles = String(value ?? '')
    .split(',')
    .map((r) => r.trim().toUpperCase())
    .filter((r) => KNOWN_ROLES.has(r) && r !== 'EMPLOYEE');
  return roles.length ? [...new Set(roles)] : DEFAULT_DIGEST_ROLES;
}

/** Active users with a digest role, excluding anyone linked to a terminated employee. */
async function digestRecipients(prisma) {
  const setting = await prisma.systemSetting.findUnique({ where: { key: 'expiry_digest_roles' }, select: { value: true } });
  const roles = parseDigestRoles(setting && setting.value);
  const users = await prisma.user.findMany({
    where: { isActive: true, role: { in: roles }, OR: [{ employeeProfile: { is: null } }, { employeeProfile: { is: { isTerminated: false } } }] },
    select: { id: true, email: true },
    orderBy: { createdAt: 'asc' },
  });
  return { roles, users: users.filter((u) => EMAIL_RE.test(u.email)) };
}

function loginUrl() {
  const base = String(process.env.APP_URL || process.env.NEXTAUTH_URL || '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s"'<>]+$/.test(base) ? `${base}/login` : null;
}

async function expiryDigest(prisma, { dryRun, now = new Date() }) {
  const dayKey = riyadhTodayKey(now);
  const counts = await computeExpiryCounts(prisma, now);
  const digest = buildDigest(counts, { dayKey, loginUrl: loginUrl() });
  const { roles, users } = await digestRecipients(prisma);
  const summary = { day: dayKey, roles, recipients: users.length, counts, enqueued: 0, alreadyQueued: 0 };
  if (!digest) return { ...summary, note: 'nothing expired or expiring: no digest' };
  if (dryRun) return { ...summary, dryRun: true, subject: digest.subject };
  const data = users.map((u) => ({
    idempotencyKey: digestIdempotencyKey(u.id, dayKey),
    channel: 'EMAIL',
    recipient: u.email,
    subject: digest.subject,
    body: digest.body,
  }));
  const res = data.length ? await prisma.notificationOutbox.createMany({ data, skipDuplicates: true }) : { count: 0 };
  return { ...summary, enqueued: res.count, alreadyQueued: data.length - res.count };
}

async function deactivateTerminated(prisma, { dryRun, now = new Date() }) {
  const setting = await prisma.systemSetting.findUnique({ where: { key: 'terminated_access_days' }, select: { value: true } });
  const graceDays = parseGraceDays(setting && setting.value);
  const candidates = await prisma.employee.findMany({
    where: { isTerminated: true, userId: { not: null }, user: { is: { isActive: true } } },
    select: { id: true, userId: true, terminationDate: true, updatedAt: true },
  });
  const due = candidates.filter((e) => accessExpired(e.terminationDate || e.updatedAt, graceDays, now));
  const summary = { graceDays, activeLoginsOfTerminated: candidates.length, due: due.length, deactivated: 0, stillInGrace: candidates.length - due.length };
  if (dryRun) return { ...summary, dryRun: true };
  for (const e of due) {
    const changed = await prisma.$transaction(async (tx) => {
      const res = await tx.user.updateMany({
        where: { id: e.userId, isActive: true },
        data: { isActive: false, sessionVersion: { increment: 1 } },
      });
      if (res.count > 0) {
        await tx.auditLog.create({
          data: {
            userId: null,
            action: 'UPDATE',
            entityType: 'User',
            entityId: e.userId,
            details: JSON.stringify({ field: 'isActive', to: false, reason: 'terminated_access_expired', employeeId: e.id, graceDays, job: 'deactivate-terminated' }),
          },
        });
      }
      return res.count;
    });
    summary.deactivated += changed;
  }
  return summary;
}

async function outboxDispatch(prisma, { dryRun = false, now = new Date(), env = process.env } = {}) {
  const cfg = outboxSendConfig(env);
  if (dryRun) Object.assign(cfg, { live: false, reason: '--dry-run' });
  const counts = Object.fromEntries(
    (await prisma.notificationOutbox.groupBy({ by: ['status'], _count: { _all: true } })).map((g) => [g.status, g._count._all]),
  );
  const expiredLeases = await prisma.notificationOutbox.count({ where: { status: 'SENDING', leaseUntil: { lt: now } } });
  const retryable = await prisma.notificationOutbox.count({ where: { status: 'FAILED', attempts: { lt: cfg.maxAttempts } } });
  if (!cfg.live) {
    // DRY RUN: no row is changed (not even expired leases).
    return { mode: 'dry-run', reason: cfg.reason, byStatus: counts, wouldSend: Math.min(cfg.batch, (counts.PENDING || 0) + retryable), expiredLeasesToMarkUnknown: expiredLeases };
  }

  // 1. SENDING rows whose lease ran out: outcome unknown (the process died mid-send). Never resent.
  const lost = await prisma.notificationOutbox.updateMany({
    where: { status: 'SENDING', leaseUntil: { lt: now } },
    data: { status: 'UNKNOWN', leaseUntil: null, lastError: 'lease expired during send: delivery unknown, not retried automatically' },
  });

  // 2. Claim a batch atomically (two dispatchers never take the same row).
  const leaseUntil = new Date(now.getTime() + cfg.leaseSeconds * 1000);
  const claimed = await prisma.$queryRaw`
    UPDATE "NotificationOutbox"
       SET "status" = 'SENDING', "leaseUntil" = ${leaseUntil}, "attempts" = "attempts" + 1, "updatedAt" = NOW()
     WHERE "id" IN (
       SELECT "id" FROM "NotificationOutbox"
        WHERE "channel" = 'EMAIL'
          AND ("status" = 'PENDING' OR ("status" = 'FAILED' AND "attempts" < ${cfg.maxAttempts}))
        ORDER BY "createdAt"
        LIMIT ${cfg.batch}
        FOR UPDATE SKIP LOCKED)
    RETURNING "id", "idempotencyKey", "recipient", "subject", "body"`;

  const nodemailer = (await import('nodemailer')).default;
  const port = parseInt(env.SMTP_PORT || '587', 10);
  const transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 30000,
  });
  const result = { mode: 'live', lostLeasesMarkedUnknown: lost.count, claimed: claimed.length, sent: 0, failed: 0, unknown: 0, skipped: 0 };
  for (const msg of claimed) {
    // Digest rows: re-check the recipient right before sending (deactivated / terminated since).
    const m = /^expiry-digest:([^:]+):/.exec(msg.idempotencyKey);
    if (m) {
      const user = await prisma.user.findUnique({ where: { id: m[1] }, select: { isActive: true, employeeProfile: { select: { isTerminated: true } } } });
      if (!user || !user.isActive || (user.employeeProfile && user.employeeProfile.isTerminated)) {
        await prisma.notificationOutbox.updateMany({
          where: { id: msg.id, status: 'SENDING' },
          data: { status: 'FAILED', attempts: cfg.maxAttempts, leaseUntil: null, lastError: 'recipient no longer active' },
        });
        result.skipped += 1;
        continue;
      }
    }
    try {
      await transporter.sendMail({ from: env.SMTP_FROM, to: msg.recipient, subject: msg.subject || 'رديف', text: msg.body });
      await prisma.notificationOutbox.updateMany({
        where: { id: msg.id, status: 'SENDING' },
        data: { status: 'SENT', sentAt: new Date(), leaseUntil: null, lastError: null },
      });
      result.sent += 1;
    } catch (err) {
      const status = classifySendError(err);
      await prisma.notificationOutbox.updateMany({
        where: { id: msg.id, status: 'SENDING' },
        data: { status, leaseUntil: null, lastError: String((err && err.message) || err).slice(0, 500) },
      });
      result[status === 'UNKNOWN' ? 'unknown' : 'failed'] += 1;
    }
  }
  return result;
}

const JOBS = {
  'expiry-digest': expiryDigest,
  'deactivate-terminated': deactivateTerminated,
  'outbox-dispatch': outboxDispatch,
};

// ---------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------

export async function runJob(prisma, job, opts = {}) {
  await prisma.jobRun.updateMany({
    where: { job, status: 'RUNNING', startedAt: { lt: new Date(Date.now() - STALE_RUN_MS) } },
    data: { status: 'FAILED', finishedAt: new Date(), details: JSON.stringify({ error: 'abandoned (still RUNNING after 2h)' }) },
  });
  const running = await prisma.jobRun.findFirst({ where: { job, status: 'RUNNING' }, select: { id: true, startedAt: true } });
  if (running) return { skipped: true, reason: `another ${job} run is in progress (JobRun ${running.id})` };

  const run = await prisma.jobRun.create({ data: { job, status: 'RUNNING' } });
  try {
    const details = await JOBS[job](prisma, opts);
    await prisma.jobRun.update({ where: { id: run.id }, data: { status: 'SUCCEEDED', finishedAt: new Date(), details: JSON.stringify(details) } });
    return { jobRunId: run.id, status: 'SUCCEEDED', details };
  } catch (err) {
    const message = String((err && err.message) || err).slice(0, 1000);
    await prisma.jobRun
      .update({ where: { id: run.id }, data: { status: 'FAILED', finishedAt: new Date(), details: JSON.stringify({ error: message }) } })
      .catch(() => {});
    return { jobRunId: run.id, status: 'FAILED', error: message };
  }
}

function usage() {
  console.error(`usage: node --env-file=<tenant.env> scripts/jobs.mjs <${JOB_NAMES.join('|')}> [--dry-run]`);
}

async function main(argv) {
  const job = argv[0];
  const dryRun = argv.includes('--dry-run');
  if (!JOB_NAMES.includes(job)) {
    usage();
    return 2;
  }
  if (!process.env.DATABASE_URL) {
    console.error('[jobs] DATABASE_URL is not set (use node --env-file=/etc/radeef/<tenant>.env)');
    return 2;
  }
  const prisma = new PrismaClient({ datasources: { db: { url: withConnectionLimit(process.env.DATABASE_URL) } } });
  try {
    const result = await runJob(prisma, job, { dryRun });
    console.log(JSON.stringify({ job, at: new Date().toISOString(), ...result }, null, 2));
    return result.status === 'FAILED' ? 1 : 0;
  } finally {
    await prisma.$disconnect();
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error('[jobs] fatal:', err && err.message);
      process.exitCode = 1;
    },
  );
}
