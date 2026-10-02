// Job expiry-digest (P1-FND-JOBS): once a day, ONE email per alert recipient with the COUNTS of
// expired / expiring documents per category, and a login link. No names, ID numbers, dates or amounts.
// idempotencyKey = expiry-digest:<userId>:<YYYY-MM-DD> (Riyadh day), so a rerun never mails twice.
//
// One definition of the rule: the thresholds, their SystemSetting keys and the classification are
// those of src/lib/alerts.ts (the alert pages), not a copy.
//
// Company scope (DOMAIN_BOUNDARIES §5.4): each recipient receives the counts of what HE may see — his
// own ScopedContext (iam resolveActor + scopedContext), applied to every query with scopeWhere. Owners
// and users without company rows see every company (the transitional rule of iam actorCompanies), so
// for them the counts are the tenant's; recipients with the same companies share one computation.
import 'server-only';
import type { PrismaClient } from '@prisma/client';
import { alertRecipients, type AlertRecipient } from '@/lib/access';
import { alertCutoffDate, classifyExpiry, getAlertThresholds, type AlertThresholdName, type AlertThresholds } from '@/lib/alerts';
import { todayKey } from '@/lib/dates';
import { ALL_COMPANIES, resolveActor, scopeWhere, scopedContext, type ScopeContext, type SystemContext } from '@/modules/iam';
import { enqueueEmails, type JobDefinition, type JobEnv, type JobSummary } from '@/modules/platform';

export const EXPIRY_DIGEST_JOB = 'expiry-digest';

/** The categories of the digest (a subset of the alert windows of alerts.ts) and their Arabic labels. */
export const DIGEST_CATEGORY_LABELS = {
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
} as const satisfies Partial<Record<AlertThresholdName, string>>;

export type DigestCategory = keyof typeof DIGEST_CATEGORY_LABELS;
export const DIGEST_CATEGORIES = Object.keys(DIGEST_CATEGORY_LABELS) as DigestCategory[];
export interface DigestCount {
  expired: number;
  expiring: number;
}
export type DigestCounts = Record<DigestCategory, DigestCount>;

/** alerts.ts classifyExpiry, folded for the digest: expired, or expiring (critical + warning), or null. */
export function digestLevel(date: Date | string | null | undefined, thresholdDays: number, now: Date = new Date()): 'expired' | 'expiring' | null {
  const s = classifyExpiry(date, thresholdDays, now);
  if (!s || s.level === 'ok') return null;
  return s.level === 'expired' ? 'expired' : 'expiring';
}

function countDates<R>(rows: readonly R[], pick: (r: R) => Date | null, threshold: number, now: Date): DigestCount {
  const out = { expired: 0, expiring: 0 };
  for (const r of rows) {
    const level = digestLevel(pick(r), threshold, now);
    if (level) out[level] += 1;
  }
  return out;
}

/** `where` AND the context's company filter (none for an unrestricted context or an unscoped model). */
function scoped<W extends object>(ctx: ScopeContext | null, model: string, where: W): W {
  const extra = ctx ? scopeWhere(ctx, model) : null;
  return (extra ? { AND: [where, extra] } : where) as W;
}

/**
 * Counts per category within the context's companies (null = the whole tenant). Only date columns are
 * selected: no name or number leaves the database.
 */
export async function computeExpiryCounts(db: PrismaClient, t: AlertThresholds, now: Date, ctx: ScopeContext | null = null): Promise<DigestCounts> {
  const lt = (name: DigestCategory) => ({ lt: alertCutoffDate(t[name], now) });
  const [employees, insurances, companies, branches, vehicles, contracts, agencies] = await Promise.all([
    db.employee.findMany({
      where: scoped(ctx, 'Employee', { isTerminated: false, OR: [{ iqamaOrIdExp: lt('iqama') }, { passportExp: lt('passport') }, { healthCertificateExp: lt('healthCert') }] }),
      select: { iqamaOrIdExp: true, passportExp: true, healthCertificateExp: true },
    }),
    db.medicalInsurance.findMany({ where: scoped(ctx, 'MedicalInsurance', { expiryDate: lt('medicalInsurance') }), select: { expiryDate: true } }),
    db.company.findMany({
      where: scoped(ctx, 'Company', { OR: [{ commercialRegExp: lt('commercialReg') }, { trademarkExpDate: lt('trademark') }] }),
      select: { commercialRegExp: true, trademarkExpDate: true },
    }),
    db.branch.findMany({
      where: scoped(ctx, 'Branch', {
        OR: [
          { munLicenseExp: lt('municipalLicense') },
          { civilDefenseExp: lt('civilDefense') },
          { rentContractExp: lt('leaseContract') },
          { wasteContractExp: lt('wasteContract') },
          { safetyContractExp: lt('safetyContract') },
          { cameraContractExp: lt('cameraContract') },
        ],
      }),
      select: { munLicenseExp: true, civilDefenseExp: true, rentContractExp: true, wasteContractExp: true, safetyContractExp: true, cameraContractExp: true },
    }),
    db.vehicle.findMany({
      where: scoped(ctx, 'Vehicle', {
        isArchived: false,
        OR: [
          { licenseExpDate: lt('vehicleLicense') },
          { insuranceExpDate: lt('vehicleInsurance') },
          { inspectionExpDate: lt('vehicleInspection') },
          { operatingCardExpDate: lt('operatingCard') },
          { driverCardExpDate: lt('driverCard') },
          { drivingAuthExpDate: lt('drivingAuth') },
        ],
      }),
      select: { licenseExpDate: true, insuranceExpDate: true, inspectionExpDate: true, operatingCardExpDate: true, driverCardExpDate: true, drivingAuthExpDate: true },
    }),
    db.legalContract.findMany({ where: scoped(ctx, 'LegalContract', { status: 'ACTIVE', endDate: { not: null, ...lt('legalContract') } }), select: { endDate: true } }),
    db.certifiedAgency.findMany({ where: scoped(ctx, 'CertifiedAgency', { status: 'ACTIVE', endDate: lt('agency') }), select: { endDate: true } }),
  ]);
  return {
    iqama: countDates(employees, (r) => r.iqamaOrIdExp, t.iqama, now),
    passport: countDates(employees, (r) => r.passportExp, t.passport, now),
    healthCert: countDates(employees, (r) => r.healthCertificateExp, t.healthCert, now),
    medicalInsurance: countDates(insurances, (r) => r.expiryDate, t.medicalInsurance, now),
    commercialReg: countDates(companies, (r) => r.commercialRegExp, t.commercialReg, now),
    trademark: countDates(companies, (r) => r.trademarkExpDate, t.trademark, now),
    municipalLicense: countDates(branches, (r) => r.munLicenseExp, t.municipalLicense, now),
    civilDefense: countDates(branches, (r) => r.civilDefenseExp, t.civilDefense, now),
    leaseContract: countDates(branches, (r) => r.rentContractExp, t.leaseContract, now),
    wasteContract: countDates(branches, (r) => r.wasteContractExp, t.wasteContract, now),
    safetyContract: countDates(branches, (r) => r.safetyContractExp, t.safetyContract, now),
    cameraContract: countDates(branches, (r) => r.cameraContractExp, t.cameraContract, now),
    vehicleLicense: countDates(vehicles, (r) => r.licenseExpDate, t.vehicleLicense, now),
    vehicleInsurance: countDates(vehicles, (r) => r.insuranceExpDate, t.vehicleInsurance, now),
    vehicleInspection: countDates(vehicles, (r) => r.inspectionExpDate, t.vehicleInspection, now),
    operatingCard: countDates(vehicles, (r) => r.operatingCardExpDate, t.operatingCard, now),
    driverCard: countDates(vehicles, (r) => r.driverCardExpDate, t.driverCard, now),
    drivingAuth: countDates(vehicles, (r) => r.drivingAuthExpDate, t.drivingAuth, now),
    legalContract: countDates(contracts, (r) => r.endDate, t.legalContract, now),
    agency: countDates(agencies, (r) => r.endDate, t.agency, now),
  };
}

/**
 * Plain-text digest: counts only + a login link. No names, numbers, dates or amounts of any record.
 * Returns null when every count is zero (nothing is sent on a quiet day).
 */
export function buildDigest(counts: Partial<Record<DigestCategory, DigestCount>>, opts: { dayKey: string; loginUrl: string | null }): { subject: string; body: string } | null {
  const rows = (Object.entries(counts) as [DigestCategory, DigestCount][]).filter(([, c]) => c.expired > 0 || c.expiring > 0);
  if (rows.length === 0) return null;
  const totalExpired = rows.reduce((s, [, c]) => s + c.expired, 0);
  const totalExpiring = rows.reduce((s, [, c]) => s + c.expiring, 0);
  const lines = [
    'ملخص تنبيهات المستندات — نظام رديف',
    `التاريخ: ${opts.dayKey}`,
    '',
    `منتهية: ${totalExpired} — تنتهي قريباً: ${totalExpiring}`,
    '',
    ...rows.map(([name, c]) => `- ${DIGEST_CATEGORY_LABELS[name] || name}: منتهية ${c.expired}، تنتهي قريباً ${c.expiring}`),
    '',
    'التفاصيل متاحة داخل النظام فقط بعد تسجيل الدخول.',
    opts.loginUrl ? `تسجيل الدخول: ${opts.loginUrl}` : 'سجّل الدخول إلى النظام للاطلاع على التفاصيل.',
    '',
    'هذه رسالة آلية تحتوي أعداداً فقط، ولا تتضمن أسماء أو أرقام هوية.',
  ];
  return {
    subject: `رديف: ${totalExpired} مستند منتهٍ و${totalExpiring} يقترب انتهاؤه (${opts.dayKey})`,
    body: lines.join('\n'),
  };
}

export function digestIdempotencyKey(userId: string, dayKey: string): string {
  return `expiry-digest:${userId}:${dayKey}`;
}

/** The login page of the tenant (APP_URL, else NEXTAUTH_URL), or null when not configured. */
export function loginUrl(env: JobEnv = process.env): string | null {
  const base = String(env.APP_URL || env.NEXTAUTH_URL || '').trim().replace(/\/+$/, '');
  return /^https?:\/\/[^\s"'<>]+$/.test(base) ? `${base}/login` : null;
}

/** Recipients grouped by the companies they may see ('ALL' or a sorted id list). */
async function recipientScopes(db: PrismaClient, users: readonly AlertRecipient[]): Promise<Map<string, { ctx: ScopeContext; users: AlertRecipient[] }>> {
  const groups = new Map<string, { ctx: ScopeContext; users: AlertRecipient[] }>();
  for (const u of users) {
    const ctx = scopedContext(await resolveActor(db, { id: u.id, role: u.role, employeeId: u.employeeId }));
    const key = ctx.companies === ALL_COMPANIES ? ALL_COMPANIES : [...ctx.companies].sort().join(',');
    const g = groups.get(key);
    if (g) g.users.push(u);
    else groups.set(key, { ctx, users: [u] });
  }
  return groups;
}

export async function runExpiryDigest(db: PrismaClient, opts: { dryRun?: boolean; now?: Date; env?: JobEnv } = {}): Promise<JobSummary> {
  const now = opts.now ?? new Date();
  const dayKey = todayKey(now);
  const thresholds = await getAlertThresholds(db);
  const { roles, users } = await alertRecipients(db);
  const groups = await recipientScopes(db, users);
  const login = loginUrl(opts.env);
  const scopes: JobSummary[] = [];
  let enqueued = 0;
  let queued = 0;
  for (const [key, { ctx, users: members }] of groups) {
    const counts = await computeExpiryCounts(db, thresholds, now, ctx.companies === ALL_COMPANIES ? null : ctx);
    const digest = buildDigest(counts, { dayKey, loginUrl: login });
    scopes.push({ companies: key === ALL_COMPANIES ? ALL_COMPANIES : ctx.companies.length, recipients: members.length, counts, digest: !!digest });
    if (!digest || opts.dryRun) continue;
    const rows = members.map((u) => ({ idempotencyKey: digestIdempotencyKey(u.id, dayKey), recipient: u.email, subject: digest.subject, body: digest.body }));
    queued += rows.length;
    enqueued += await enqueueEmails(db, rows);
  }
  return { day: dayKey, roles, recipients: users.length, scopes, ...(opts.dryRun ? { dryRun: true } : { enqueued, alreadyQueued: queued - enqueued }) };
}

/**
 * Not cross-company and not per company either: every recipient's counts are computed in his own
 * ScopedContext (above), so the job never needs a SystemContext over every company.
 */
export const expiryDigestJob: JobDefinition<SystemContext> = {
  name: EXPIRY_DIGEST_JOB,
  description: 'Daily counts of expired / expiring documents to the alert recipients (counts and a login link only)',
  crossCompany: false,
  run: (ctx) => runExpiryDigest(ctx.db, { dryRun: ctx.dryRun, now: ctx.now, env: ctx.env }),
};
