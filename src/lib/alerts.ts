// Document-expiry alerts: one definition of "days left", one set of thresholds, and the
// alert builders shared by the alert pages, the renewals queue and the dashboard so that
// every screen counts the same things.
//
// Everything above the "DB helpers" section is pure (no Prisma client import) so it can be
// unit-tested. "Today" is always the Riyadh calendar day (see src/lib/dates.ts).
import type { Prisma, PrismaClient } from '@prisma/client';
import { addDays, dateKey, daysBetween, daysUntil, riyadhDateKey, today, todayKey } from '@/lib/dates';
import { formatMoney } from '@/lib/money';

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type ExpiryLevel = 'expired' | 'critical' | 'warning' | 'ok';

export interface ExpiryStatus {
  /** Whole days until the expiry date (0 = expires today, negative = expired). */
  daysLeft: number;
  level: ExpiryLevel;
}

/** A still-valid document inside its alert window becomes "critical" in its last week. */
export const CRITICAL_DAYS = 7;

/**
 * Classify an expiry date against an alert window of `thresholdDays`.
 *  - expired : daysLeft < 0
 *  - critical: 0 <= daysLeft <= min(CRITICAL_DAYS, thresholdDays)
 *  - warning : daysLeft <= thresholdDays
 *  - ok      : outside the window
 * Returns null when there is no (valid) date.
 */
export function classifyExpiry(
  date: Date | string | null | undefined,
  thresholdDays: number,
  now: Date = new Date(),
): ExpiryStatus | null {
  const daysLeft = daysUntil(date, now);
  if (daysLeft === null || Number.isNaN(daysLeft)) return null;
  const threshold = Number.isFinite(thresholdDays) ? Math.max(0, thresholdDays) : 0;
  let level: ExpiryLevel;
  if (daysLeft < 0) level = 'expired';
  else if (daysLeft <= Math.min(CRITICAL_DAYS, threshold)) level = 'critical';
  else if (daysLeft <= threshold) level = 'warning';
  else level = 'ok';
  return { daysLeft, level };
}

/**
 * Should this status raise an alert? `expiredLookbackDays` optionally hides documents that
 * expired more than N days ago (used for probation, which is "expired" forever afterwards).
 */
export function isAlerting(status: ExpiryStatus | null, expiredLookbackDays?: number): status is ExpiryStatus {
  if (!status || status.level === 'ok') return false;
  if (status.level === 'expired' && expiredLookbackDays !== undefined && status.daysLeft < -expiredLookbackDays) return false;
  return true;
}

/** classifyExpiry + isAlerting in one call. Returns the status only when it should alert. */
export function expiryAlert(
  date: Date | string | null | undefined,
  thresholdDays: number,
  now: Date = new Date(),
  expiredLookbackDays?: number,
): ExpiryStatus | null {
  const status = classifyExpiry(date, thresholdDays, now);
  return isAlerting(status, expiredLookbackDays) ? status : null;
}

/**
 * Exclusive upper bound for a DB query "expires within thresholdDays (or already expired)":
 * `{ lt: alertCutoffDate(n) }` matches every stored date whose calendar day is <= today + n.
 */
export function alertCutoffDate(thresholdDays: number, now: Date = new Date()): Date {
  return addDays(today(now), Math.max(0, Math.floor(thresholdDays)) + 1);
}

/**
 * Level of a built alert: its `level` when set, else "expired" for *_EXPIRED types
 * (e.g. accident claims), else null (informational alerts such as lawsuits or summaries).
 */
export function alertLevel(a: { level?: ExpiryLevel; type: string }): ExpiryLevel | null {
  if (a.level) return a.level;
  return a.type.includes('EXPIRED') ? 'expired' : null;
}

/** Counts of alerts per urgency level (informational alerts without a level are not counted). */
export function countAlertLevels(alerts: ReadonlyArray<{ level?: ExpiryLevel; type: string }>): Record<Exclude<ExpiryLevel, 'ok'>, number> {
  const out = { expired: 0, critical: 0, warning: 0 };
  for (const a of alerts) {
    const lvl = alertLevel(a);
    if (lvl && lvl !== 'ok') out[lvl]++;
  }
  return out;
}

/** Counts per level (for "expired" vs "warning" summary badges). */
export function countByLevel(statuses: Array<Pick<ExpiryStatus, 'level'>>): Record<ExpiryLevel, number> {
  const out: Record<ExpiryLevel, number> = { expired: 0, critical: 0, warning: 0, ok: 0 };
  for (const s of statuses) out[s.level]++;
  return out;
}

// ---------------------------------------------------------------------------
// Thresholds (SystemSetting alert_* keys)
// ---------------------------------------------------------------------------

/** SystemSetting key and default number of days for every alert window. */
export const ALERT_THRESHOLD_SETTINGS = {
  iqama: { key: 'alert_iqama_days', days: 30 },
  passport: { key: 'alert_passport_days', days: 120 },
  healthCert: { key: 'alert_health_cert_days', days: 30 },
  contract: { key: 'alert_contract_days', days: 60 },
  probation: { key: 'alert_probation_days', days: 30 },
  annualLeave: { key: 'alert_annual_leave_days', days: 120 },
  medicalInsurance: { key: 'alert_medical_insurance_days', days: 30 },
  commercialReg: { key: 'alert_commercial_reg_days', days: 30 },
  municipalLicense: { key: 'alert_municipal_license_days', days: 30 },
  civilDefense: { key: 'alert_civil_defense_days', days: 30 },
  leaseContract: { key: 'alert_lease_contract_days', days: 60 },
  trademark: { key: 'alert_trademark_days', days: 60 },
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
  promissoryNote: { key: 'alert_promissory_note_days', days: 30 },
} as const;

export type AlertThresholdName = keyof typeof ALERT_THRESHOLD_SETTINGS;
export type AlertThresholds = Record<AlertThresholdName, number>;

const THRESHOLD_NAMES = Object.keys(ALERT_THRESHOLD_SETTINGS) as AlertThresholdName[];

export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = Object.fromEntries(
  THRESHOLD_NAMES.map((name) => [name, ALERT_THRESHOLD_SETTINGS[name].days]),
) as AlertThresholds;

/** Every SystemSetting key read by getAlertThresholds(). */
export const ALERT_SETTING_KEYS: string[] = THRESHOLD_NAMES.map((name) => ALERT_THRESHOLD_SETTINGS[name].key);

/** Parse a stored setting value: a positive whole number of days, else null. */
export function parseThresholdValue(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(Math.floor(n), 3650);
}

/** Build thresholds from SystemSetting rows; missing/invalid values fall back to the defaults. */
export function parseAlertThresholds(rows: ReadonlyArray<{ key: string; value: string | null }>): AlertThresholds {
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const out = { ...DEFAULT_ALERT_THRESHOLDS };
  for (const name of THRESHOLD_NAMES) {
    const parsed = parseThresholdValue(byKey.get(ALERT_THRESHOLD_SETTINGS[name].key));
    if (parsed !== null) out[name] = parsed;
  }
  return out;
}

/** Past-expiry windows (days) after which an expired item stops alerting. Absent = always alert. */
export const EXPIRED_LOOKBACK_DAYS = {
  /** Probation "expires" for every employee who passed it; only recent ends are relevant. */
  probation: 60,
} as const;

// ---------------------------------------------------------------------------
// Small pure helpers used by the renewals queue
// ---------------------------------------------------------------------------

/** Map key for (entityId, documentType) lookups. */
export function renewalKey(entityId: string, documentType: string): string {
  return `${entityId}|${documentType}`;
}

/** Arabic name of every document type handled by the renewals queue (/api/renewals). */
export const RENEWAL_DOCUMENT_LABELS: Readonly<Record<string, string>> = {
  IQAMA: 'الإقامة / الهوية',
  PASSPORT: 'جواز السفر',
  HEALTH_CERT: 'الشهادة الصحية',
  CONTRACT: 'عقد العمل',
  PROBATION: 'فترة التجربة',
  ANNUAL_LEAVE_DUE: 'استحقاق الإجازة السنوية',
  MEDICAL_INSURANCE: 'وثيقة تأمين طبي',
  COMMERCIAL_REG: 'التأكيد السنوي للسجل التجاري',
  TRADEMARK: 'العلامة التجارية',
  MUN_LICENSE: 'رخصة البلدية',
  CIVIL_DEFENSE: 'رخصة الدفاع المدني',
  RENT_CONTRACT: 'عقد الإيجار',
  WASTE_CONTRACT: 'عقد النفايات',
  SAFETY_CONTRACT: 'عقد صيانة السلامة',
  CAMERA_CONTRACT: 'عقد صيانة الكاميرات',
  VEHICLE_LICENSE: 'رخصة السير (الاستمارة)',
  VEHICLE_INSURANCE: 'تأمين المركبة',
  VEHICLE_INSPECTION: 'الفحص الدوري للمركبة',
  VEHICLE_OPERATING_CARD: 'كرت التشغيل',
  VEHICLE_DRIVER_CARD: 'بطاقة السائق',
  VEHICLE_DRIVING_AUTH: 'تفويض القيادة',
  LEGAL_CONTRACT: 'عقد قانوني',
  AGENCY: 'وكالة شرعية',
  UTILITY_METER: 'عداد خدمات',
};

/** Document types of the renewals queue that belong to the employee's entitlements, not to a document. */
export const EMPLOYEE_DUE_DOCUMENT_TYPES: ReadonlySet<string> = new Set(['ANNUAL_LEAVE_DUE', 'PROBATION']);

/**
 * Entity types whose dates are owned by the legal department: the renewals queue shows them
 * read-only with a link, and /api/renewals/action refuses to write them.
 */
export const LEGAL_MANAGED_RENEWALS: Readonly<Record<string, { manageUrl: string }>> = {
  LEGAL_CONTRACT: { manageUrl: '/legal/contracts' },
  AGENCY: { manageUrl: '/legal/agencies' },
};

export const LEGAL_MANAGED_MESSAGE = 'يُدار من الشؤون القانونية';

/**
 * Title of the payment request opened by a renewal: the document's Arabic name, then the
 * employee / branch / vehicle / company name, then the employee number or the company name.
 * e.g. «تجديد الإقامة / الهوية – أحمد علي (الرقم الوظيفي 1023)».
 */
export function renewalPaymentTitle(
  documentType: string,
  entity: { name: string | null | undefined; reference?: string | null } | null,
): string {
  const label = RENEWAL_DOCUMENT_LABELS[documentType] ?? 'وثيقة';
  // The commercial register is confirmed annually, not "renewed".
  const head = documentType === 'COMMERCIAL_REG' ? label : `تجديد ${label}`;
  const name = entity?.name?.trim();
  const reference = entity?.reference?.trim();
  if (!name) return head;
  return reference ? `${head} – ${name} (${reference})` : `${head} – ${name}`;
}

/**
 * A new expiry date that is today or earlier leaves the document expired (or expiring today):
 * the renewals action accepts it only with an explicit confirmation.
 */
export function isNewExpiryNotInFuture(newExpDate: Date | string | null | undefined, now: Date = new Date()): boolean {
  const key = dateKey(newExpDate);
  if (!key) return false;
  return key <= todayKey(now);
}

/** Map key for (entityId, documentType, calendar day of the expiry date). */
export function renewalDateKey(entityId: string, documentType: string, date: Date | string | null | undefined): string {
  return `${entityId}|${documentType}|${dateKey(date) ?? ''}`;
}

/**
 * Next annual-leave due date: one year after the accrual start (UTC calendar arithmetic),
 * unless it was postponed to `postponedTo`.
 */
export function nextAnnualLeaveDueDate(accrualStart: Date | string, postponedTo?: Date | string | null): Date | null {
  if (postponedTo) {
    const p = new Date(postponedTo);
    if (!Number.isNaN(p.getTime())) return p;
  }
  const start = new Date(accrualStart);
  if (Number.isNaN(start.getTime())) return null;
  const y = start.getUTCFullYear() + 1;
  const m = start.getUTCMonth();
  const d = start.getUTCDate();
  // Feb 29 -> Feb 28 of the following (non-leap) year instead of rolling into March.
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d, lastDay)));
}

/** Whole days since a timestamp (Riyadh calendar days). */
export function daysSince(timestamp: Date | string, now: Date = new Date()): number {
  const from = riyadhDateKey(timestamp);
  if (!from) return 0;
  const n = daysBetween(from, todayKey(now));
  return Number.isNaN(n) ? 0 : n;
}

// ---------------------------------------------------------------------------
// Alert builders (pure). Input rows are what the loaders below select.
// ---------------------------------------------------------------------------

type DateLike = Date | string | null;

export interface EmployeeAlertSource {
  id: string;
  employeeId: string;
  firstNameArabic: string | null;
  lastNameArabic: string | null;
  iqamaOrIdExp: DateLike;
  passportExp: DateLike;
  healthCertificateExp: DateLike;
  contractEndDate: DateLike;
  probationEndDate: DateLike;
  noticePeriodDays: number | null;
  branchId: string | null;
  legalCompanyId: string | null;
}

export interface HrAlert {
  id: string;
  employee: string;
  employeeId: string;
  branchId?: string | null;
  companyId?: string | null;
  type: string;
  level?: ExpiryLevel;
  daysLeft: number;
  dueDate: Date | string;
  message: string;
}

const fullName = (first: string | null | undefined, last: string | null | undefined) =>
  `${first ?? ''} ${last ?? ''}`.trim();

/** Employee document alerts (iqama, passport, health certificate, contract, probation). */
export function buildEmployeeDocumentAlerts(
  employees: ReadonlyArray<EmployeeAlertSource>,
  t: AlertThresholds,
  now: Date = new Date(),
): HrAlert[] {
  const alerts: HrAlert[] = [];
  for (const emp of employees) {
    const base = {
      employee: fullName(emp.firstNameArabic, emp.lastNameArabic),
      employeeId: emp.employeeId,
      branchId: emp.branchId,
      companyId: emp.legalCompanyId,
    };

    const iqama = expiryAlert(emp.iqamaOrIdExp, t.iqama, now);
    if (iqama && emp.iqamaOrIdExp) {
      const expired = iqama.level === 'expired';
      alerts.push({
        ...base,
        id: `${emp.id}-iqama${expired ? '-exp' : ''}`,
        type: expired ? 'IQAMA_EXPIRED' : 'IQAMA',
        level: iqama.level,
        daysLeft: iqama.daysLeft,
        dueDate: emp.iqamaOrIdExp,
        message: expired ? `انتهت الإقامة منذ ${Math.abs(iqama.daysLeft)} يوم` : `تنتهي الإقامة خلال ${iqama.daysLeft} يوم`,
      });
    }

    const passport = expiryAlert(emp.passportExp, t.passport, now);
    if (passport && emp.passportExp) {
      const expired = passport.level === 'expired';
      alerts.push({
        ...base,
        id: `${emp.id}-pass${expired ? '-exp' : ''}`,
        type: expired ? 'PASSPORT_EXPIRED' : 'PASSPORT',
        level: passport.level,
        daysLeft: passport.daysLeft,
        dueDate: emp.passportExp,
        message: expired
          ? `انتهى الجواز منذ ${Math.abs(passport.daysLeft)} يوم`
          : `ينتهي الجواز خلال ${passport.daysLeft} يوم (أقل من ${Math.ceil(t.passport / 30)} أشهر)`,
      });
    }

    const health = expiryAlert(emp.healthCertificateExp, t.healthCert, now);
    if (health && emp.healthCertificateExp) {
      const expired = health.level === 'expired';
      alerts.push({
        ...base,
        id: `${emp.id}-health${expired ? '-exp' : ''}`,
        type: expired ? 'HEALTH_CERT_EXPIRED' : 'HEALTH_CERT',
        level: health.level,
        daysLeft: health.daysLeft,
        dueDate: emp.healthCertificateExp,
        message: expired
          ? `انتهت الشهادة الصحية منذ ${Math.abs(health.daysLeft)} يوم`
          : `تنتهي الشهادة الصحية خلال ${health.daysLeft} يوم`,
      });
    }

    // Contract: alert window = notice period + contract threshold; expired contracts alert for
    // `contract` days after the end date (then the renewals queue owns them).
    if (emp.contractEndDate) {
      const noticeDays = emp.noticePeriodDays && emp.noticePeriodDays > 0 ? emp.noticePeriodDays : t.contract;
      const status = classifyExpiry(emp.contractEndDate, noticeDays + t.contract, now);
      if (status) {
        const { daysLeft } = status;
        if (daysLeft > noticeDays && daysLeft <= noticeDays + t.contract) {
          alerts.push({
            ...base,
            id: `${emp.id}-contract-pre`,
            type: 'CONTRACT_PRE_NOTICE',
            level: 'warning',
            daysLeft,
            dueDate: emp.contractEndDate,
            message: `تبدأ فترة الإشعار للعقد خلال ${daysLeft - noticeDays} يوم`,
          });
        } else if (daysLeft >= 0 && daysLeft <= noticeDays) {
          alerts.push({
            ...base,
            id: `${emp.id}-contract`,
            type: 'CONTRACT_NOTICE',
            level: daysLeft <= CRITICAL_DAYS ? 'critical' : 'warning',
            daysLeft,
            dueDate: emp.contractEndDate,
            message: `الموظف يمر بفترة الإشعار (ينتهي العقد نهائياً خلال ${daysLeft} يوم)`,
          });
        } else if (daysLeft < 0 && -daysLeft <= t.contract) {
          alerts.push({
            ...base,
            id: `${emp.id}-contract-exp`,
            type: 'CONTRACT_EXPIRED',
            level: 'expired',
            daysLeft,
            dueDate: emp.contractEndDate,
            message: `انتهى العقد ولم يتم تجديده بالنظام منذ ${Math.abs(daysLeft)} يوم`,
          });
        }
      }
    }

    const probation = expiryAlert(emp.probationEndDate, t.probation, now, EXPIRED_LOOKBACK_DAYS.probation);
    if (probation && emp.probationEndDate) {
      const expired = probation.level === 'expired';
      alerts.push({
        ...base,
        id: `${emp.id}-probation${expired ? '-exp' : ''}`,
        type: expired ? 'PROBATION_EXPIRED' : 'PROBATION',
        level: probation.level,
        daysLeft: probation.daysLeft,
        dueDate: emp.probationEndDate,
        message: expired
          ? `انتهت فترة التجربة منذ ${Math.abs(probation.daysLeft)} يوم!`
          : `تنتهي فترة التجربة خلال ${probation.daysLeft} يوم. التقييم مطلوب.`,
      });
    }
  }
  return alerts;
}

export interface MedicalInsuranceAlertSource {
  id: string;
  insuranceIssuer: string;
  policyNumber: string;
  expiryDate: Date | string;
  company: { nameArabic: string } | null;
}

export function buildMedicalInsuranceAlerts(
  rows: ReadonlyArray<MedicalInsuranceAlertSource>,
  t: AlertThresholds,
  now: Date = new Date(),
): HrAlert[] {
  const alerts: HrAlert[] = [];
  for (const ins of rows) {
    const s = expiryAlert(ins.expiryDate, t.medicalInsurance, now);
    if (!s) continue;
    const expired = s.level === 'expired';
    alerts.push({
      id: `med-ins-${expired ? 'exp-' : ''}${ins.id}`,
      employee: `التأمين الطبي: شركة ${ins.company?.nameArabic || 'غير محدد'}`,
      employeeId: ins.policyNumber,
      type: expired ? 'MEDICAL_INSURANCE_EXPIRED' : 'MEDICAL_INSURANCE',
      level: s.level,
      daysLeft: s.daysLeft,
      dueDate: ins.expiryDate,
      message: expired
        ? `وثيقة (${ins.insuranceIssuer}) انتهت منذ ${Math.abs(s.daysLeft)} يوم!`
        : `وثيقة (${ins.insuranceIssuer}) تنتهي خلال ${s.daysLeft} يوم`,
    });
  }
  return alerts;
}

export interface SettlementAlertSource {
  id: string;
  createdAt: Date | string;
  totalSettlement: number | null;
  employee: {
    firstNameArabic: string | null;
    lastNameArabic: string | null;
    employeeId: string;
    branchId: string | null;
    legalCompanyId: string | null;
  } | null;
}

/** Owner-approved settlements awaiting the finance transfer. */
export function buildSettlementAlerts(rows: ReadonlyArray<SettlementAlertSource>): HrAlert[] {
  return rows.map((s) => ({
    id: `settle-${s.id}`,
    employee: fullName(s.employee?.firstNameArabic, s.employee?.lastNameArabic),
    employeeId: s.employee?.employeeId ?? '',
    branchId: s.employee?.branchId ?? null,
    companyId: s.employee?.legalCompanyId ?? null,
    type: 'SETTLEMENT_PENDING',
    daysLeft: 0,
    dueDate: s.createdAt,
    message: `الموظف بانتظار تحويل مبلغ التصفية المقدر بـ ${formatMoney(s.totalSettlement)} ر.س`,
  }));
}

// --- Admin (companies, branches, legal contracts) ---------------------------

export interface AdminAlert {
  id: string;
  /** Id of the company / branch / legal contract the alert is about. */
  entityId: string;
  source: string;
  type: string;
  category: 'COMPANY' | 'BRANCH' | 'LEGAL';
  level: ExpiryLevel;
  daysLeft: number;
  dueDate: Date | string;
  message: string;
}

export interface AdminAlertSources {
  companies: ReadonlyArray<{ id: string; nameArabic: string; commercialRegExp: DateLike; trademarkExpDate: DateLike }>;
  branches: ReadonlyArray<{
    id: string;
    nameArabic: string;
    munLicenseExp: DateLike;
    civilDefenseExp: DateLike;
    rentContractExp: DateLike;
    wasteContractExp: DateLike;
    safetyContractExp: DateLike;
    cameraContractExp: DateLike;
    company: { nameArabic: string } | null;
  }>;
  contracts: ReadonlyArray<{ id: string; title: string; endDate: DateLike }>;
}

/** Every dated document of a branch: its column, alert threshold, admin-alert type and Arabic name. */
export const BRANCH_EXPIRY_DOCUMENTS = [
  { field: 'munLicenseExp', threshold: 'municipalLicense', type: 'MUN_LICENSE', label: 'رخصة البلدية' },
  { field: 'civilDefenseExp', threshold: 'civilDefense', type: 'CIVIL_DEFENSE', label: 'رخصة الدفاع المدني' },
  { field: 'rentContractExp', threshold: 'leaseContract', type: 'LEASE', label: 'عقد الإيجار' },
  { field: 'wasteContractExp', threshold: 'wasteContract', type: 'WASTE_CONTRACT', label: 'عقد النفايات' },
  { field: 'safetyContractExp', threshold: 'safetyContract', type: 'SAFETY_CONTRACT', label: 'عقد صيانة السلامة' },
  { field: 'cameraContractExp', threshold: 'cameraContract', type: 'CAMERA_CONTRACT', label: 'عقد صيانة الكاميرات' },
] as const satisfies ReadonlyArray<{ field: string; threshold: AlertThresholdName; type: string; label: string }>;

export type BranchExpiryField = (typeof BRANCH_EXPIRY_DOCUMENTS)[number]['field'];

export interface BranchDocumentAlert {
  branchId: string;
  type: (typeof BRANCH_EXPIRY_DOCUMENTS)[number]['type'];
  label: string;
  level: Exclude<ExpiryLevel, 'ok'>;
  daysLeft: number;
}

/** Branch documents inside their alert window (or expired), classified with classifyExpiry. */
export function branchDocumentAlerts(
  branch: { id: string } & Partial<Record<BranchExpiryField, DateLike | undefined>>,
  t: AlertThresholds,
  now: Date = new Date(),
): BranchDocumentAlert[] {
  const out: BranchDocumentAlert[] = [];
  for (const d of BRANCH_EXPIRY_DOCUMENTS) {
    const s = expiryAlert(branch[d.field] ?? null, t[d.threshold], now);
    if (s && s.level !== 'ok') out.push({ branchId: branch.id, type: d.type, label: d.label, level: s.level, daysLeft: s.daysLeft });
  }
  return out;
}

/**
 * The same list built from /api/admin/alerts rows (which use the thresholds configured in the
 * settings). Rows that are not branch documents are ignored.
 */
export function branchDocumentAlertsFromAdminAlerts(
  rows: ReadonlyArray<Pick<AdminAlert, 'category' | 'type' | 'level' | 'daysLeft'> & { entityId?: string | null }>,
): BranchDocumentAlert[] {
  const out: BranchDocumentAlert[] = [];
  for (const r of rows) {
    if (r.category !== 'BRANCH' || !r.entityId || r.level === 'ok') continue;
    const base = r.type.replace(/_EXPIRED$/, '');
    const doc = BRANCH_EXPIRY_DOCUMENTS.find((d) => d.type === base);
    if (!doc) continue;
    out.push({ branchId: r.entityId, type: doc.type, label: doc.label, level: r.level, daysLeft: r.daysLeft });
  }
  return out;
}

/**
 * Commercial register: the new Commercial Register Law replaced the expiry date with an annual
 * confirmation, so the stored commercialRegExp is read as "annual confirmation due date".
 * Never says the register "expired" / "expires".
 */
export function commercialRegMessage(daysLeft: number): string {
  if (daysLeft < 0) return `موعد التأكيد السنوي للسجل التجاري فات منذ ${Math.abs(daysLeft)} يوم`;
  if (daysLeft === 0) return 'موعد التأكيد السنوي للسجل التجاري اليوم';
  return `موعد التأكيد السنوي للسجل التجاري بعد ${daysLeft} يوم`;
}

export function buildAdminAlerts(src: AdminAlertSources, t: AlertThresholds, now: Date = new Date()): AdminAlert[] {
  const alerts: AdminAlert[] = [];
  const push = (
    date: DateLike,
    threshold: number,
    a: { idPrefix: string; expIdPrefix: string; entityId: string; source: string; type: string; category: AdminAlert['category'] },
    warnMsg: (d: number) => string,
    expMsg: (d: number) => string,
  ) => {
    const s = expiryAlert(date, threshold, now);
    if (!s || !date) return;
    const expired = s.level === 'expired';
    alerts.push({
      id: `${expired ? a.expIdPrefix : a.idPrefix}-${a.entityId}`,
      entityId: a.entityId,
      source: a.source,
      type: expired ? `${a.type}_EXPIRED` : a.type,
      category: a.category,
      level: s.level,
      daysLeft: s.daysLeft,
      dueDate: date,
      message: expired ? expMsg(Math.abs(s.daysLeft)) : warnMsg(s.daysLeft),
    });
  };

  for (const c of src.companies) {
    const base = { entityId: c.id, source: c.nameArabic, category: 'COMPANY' as const };
    push(c.commercialRegExp, t.commercialReg, { ...base, idPrefix: 'comp-cr', expIdPrefix: 'comp-cr-exp', type: 'CR' },
      (d) => commercialRegMessage(d), (d) => commercialRegMessage(-d));
    push(c.trademarkExpDate, t.trademark, { ...base, idPrefix: 'comp-tm', expIdPrefix: 'comp-tm-exp', type: 'TRADEMARK' },
      (d) => `تنتهي العلامة التجارية خلال ${d} يوم`, (d) => `انتهت الشهادة للعلامة التجارية منذ ${d} يوم`);
  }

  for (const b of src.branches) {
    const base = { entityId: b.id, source: `${b.nameArabic} - ${b.company?.nameArabic ?? ''}`, category: 'BRANCH' as const };
    push(b.munLicenseExp, t.municipalLicense, { ...base, idPrefix: 'br-lic', expIdPrefix: 'br-lic-exp', type: 'MUN_LICENSE' },
      (d) => `تنتهي رخصة البلدية للفرع خلال ${d} يوم`, (d) => `انتهت رخصة البلدية منذ ${d} يوم`);
    push(b.civilDefenseExp, t.civilDefense, { ...base, idPrefix: 'br-cd', expIdPrefix: 'br-cd-exp', type: 'CIVIL_DEFENSE' },
      (d) => `ينتهي ترخيص وشهادة الدفاع المدني خلال ${d} يوم`, (d) => `انتهت شهادة الدفاع المدني منذ ${d} يوم`);
    push(b.rentContractExp, t.leaseContract, { ...base, idPrefix: 'br-rent', expIdPrefix: 'br-rent-exp', type: 'LEASE' },
      (d) => `ينتهي عقد إيجار العقار خلال ${d} يوم`, (d) => `انتهى عقد إيجار هذا الفرع منذ ${d} يوم`);
    push(b.wasteContractExp, t.wasteContract, { ...base, idPrefix: 'br-waste', expIdPrefix: 'br-waste-exp', type: 'WASTE_CONTRACT' },
      (d) => `ينتهي عقد النفايات للفرع خلال ${d} يوم`, (d) => `انتهى عقد النفايات للفرع منذ ${d} يوم`);
    push(b.safetyContractExp, t.safetyContract, { ...base, idPrefix: 'br-safety', expIdPrefix: 'br-safety-exp', type: 'SAFETY_CONTRACT' },
      (d) => `ينتهي عقد صيانة السلامة للفرع خلال ${d} يوم`, (d) => `انتهى عقد صيانة السلامة للفرع منذ ${d} يوم`);
    push(b.cameraContractExp, t.cameraContract, { ...base, idPrefix: 'br-camera', expIdPrefix: 'br-camera-exp', type: 'CAMERA_CONTRACT' },
      (d) => `ينتهي عقد صيانة الكاميرات للفرع خلال ${d} يوم`, (d) => `انتهى عقد صيانة الكاميرات للفرع منذ ${d} يوم`);
  }

  for (const c of src.contracts) {
    push(c.endDate, t.legalContract, { entityId: c.id, source: `عقد: ${c.title}`, category: 'LEGAL', idPrefix: 'legal', expIdPrefix: 'legal-exp', type: 'LEGAL_CONTRACT' },
      (d) => `يشارف العقد القانوني على الانتهاء خلال ${d} يوم`,
      (d) => `انتهت الصلاحية وتاريخ نهاية هذا العقد من الناحية القانونية منذ ${d} يوم`);
  }

  return alerts.sort((a, b) => a.daysLeft - b.daysLeft);
}

// --- Logistics (vehicles, accident claims) ----------------------------------

export interface LogisticsAlert {
  id: string;
  source: string;
  type: string;
  level?: ExpiryLevel;
  daysLeft: number;
  dueDate: Date | string;
  message: string;
}

export interface VehicleAlertSource {
  id: string;
  brand: string;
  modelYear: string;
  plateNumber: string;
  licenseExpDate: DateLike;
  insuranceExpDate: DateLike;
  inspectionExpDate: DateLike;
  operatingCardExpDate: DateLike;
  driverCardExpDate: DateLike;
  drivingAuthExpDate: DateLike;
  driver: { firstNameArabic: string | null } | null;
}

const vehicleLabel = (v: { brand: string; modelYear: string; plateNumber: string; driver: { firstNameArabic: string | null } | null } | null) => {
  if (!v) return '';
  const driver = v.driver ? ` (سائق: ${v.driver.firstNameArabic ?? ''})` : '';
  return `${v.brand} ${v.modelYear} | اللوحة: ${v.plateNumber}${driver}`;
};

export function buildVehicleAlerts(
  vehicles: ReadonlyArray<VehicleAlertSource>,
  t: AlertThresholds,
  now: Date = new Date(),
): LogisticsAlert[] {
  const alerts: LogisticsAlert[] = [];
  for (const v of vehicles) {
    const source = vehicleLabel(v);
    const checks: Array<{ date: DateLike; days: number; idPart: string; type: string; warn: (d: number) => string; exp: (d: number) => string }> = [
      { date: v.licenseExpDate, days: t.vehicleLicense, idPart: 'lic', type: 'LICENSE',
        warn: (d) => `تشارف رخصة السير (الاستمارة) على الانتهاء خلال ${d} يوم`, exp: (d) => `انتهت رخصة السير (الاستمارة) منذ ${d} يوم (مخالفة مرورية!)` },
      { date: v.insuranceExpDate, days: t.vehicleInsurance, idPart: 'ins', type: 'INSURANCE',
        warn: (d) => `بوليصة التأمين على المركبة تنتهي خلال ${d} يوم`, exp: (d) => `انتهى تأمين المركبة منذ ${d} يوم (خطر مالي وقانوني!)` },
      { date: v.inspectionExpDate, days: t.vehicleInspection, idPart: 'insp', type: 'INSPECTION',
        warn: (d) => `شهادة الفحص الدوري تنتهي خلال ${d} يوم`, exp: (d) => `الفحص الدوري منتهي منذ ${d} يوم` },
      { date: v.operatingCardExpDate, days: t.operatingCard, idPart: 'op', type: 'OPERATING_CARD',
        warn: (d) => `كرت التشغيل للمركبة ينتهي خلال ${d} يوم`, exp: (d) => `انتهى كرت تشغيل المركبة منذ ${d} يوم (إيقاف من النقل!)` },
      { date: v.driverCardExpDate, days: t.driverCard, idPart: 'driver', type: 'DRIVER_CARD',
        warn: (d) => `بطاقة السائق المهنية تنتهي خلال ${d} يوم`, exp: (d) => `انتهت بطاقة السائق منذ ${d} يوم` },
      { date: v.drivingAuthExpDate, days: t.drivingAuth, idPart: 'auth', type: 'AUTHORIZATION',
        warn: (d) => `تفويض قيادة المركبة لهذا السائق ينتهي خلال ${d} يوم`, exp: (d) => `انتهى التفويض القيادي منذ ${d} يوم (مخالفة قيادة بدون تفويض!)` },
    ];
    for (const c of checks) {
      const s = expiryAlert(c.date, c.days, now);
      if (!s || !c.date) continue;
      const expired = s.level === 'expired';
      alerts.push({
        id: `veh-${c.idPart}${expired ? '-exp' : ''}-${v.id}`,
        source,
        type: expired ? `${c.type}_EXPIRED` : c.type,
        level: s.level,
        daysLeft: s.daysLeft,
        dueDate: c.date,
        message: expired ? c.exp(Math.abs(s.daysLeft)) : c.warn(s.daysLeft),
      });
    }
  }
  return alerts;
}

export interface ClaimAlertSource {
  id: string;
  status: string;
  createdAt: Date | string;
  vehicle: { brand: string; modelYear: string; plateNumber: string; driver: { firstNameArabic: string | null } | null } | null;
}

/** Open accident claims (PENDING_SUBMISSION / SUBMITTED). */
export function buildClaimAlerts(claims: ReadonlyArray<ClaimAlertSource>, now: Date = new Date()): LogisticsAlert[] {
  return claims.map((claim) => {
    const daysOpen = Math.abs(daysSince(claim.createdAt, now));
    const source = vehicleLabel(claim.vehicle);
    if (claim.status === 'PENDING_SUBMISSION') {
      return {
        id: `claim-${claim.id}`,
        source,
        type: 'CLAIM_EXPIRED',
        daysLeft: -daysOpen,
        dueDate: claim.createdAt,
        message: `مطالبة بانتظار التقديم منذ ${daysOpen} يوم - يرجى تقديمها لشركة التأمين!`,
      };
    }
    return {
      id: `claim-${claim.id}`,
      source,
      type: 'CLAIM',
      daysLeft: daysOpen,
      dueDate: claim.createdAt,
      message: `مطالبة حادث (تم التقديم) بانتظار التحويل (${daysOpen} يوم)`,
    };
  });
}

// --- Legal (promissory notes, contracts, lawsuits, agencies) ----------------

export interface LegalAlert {
  id: string;
  category: 'PROMISSORY_NOTE' | 'LEGAL_CONTRACT' | 'LAWSUIT' | 'AGENCY';
  type: string;
  /** Promissory notes only: is the company the creditor (owed to us) or the debtor (owed by us)? */
  companyRole?: PromissoryCompanyRole;
  level?: ExpiryLevel;
  daysLeft?: number;
  source: string;
  message: string;
  employeeId: string;
  employee: string;
  dueDate: Date | string;
}

export interface LegalAlertSources {
  notes: ReadonlyArray<PromissoryNoteAlertSource>;
  contracts: ReadonlyArray<{ id: string; title: string; firstParty: string; secondParty: string; endDate: DateLike }>;
  lawsuits: ReadonlyArray<{ id: string; defendant: string; plaintiff: string; lawFirmName: string | null; caseType: string; subject: string }>;
  agencies: ReadonlyArray<{ id: string; agencyNumber: string; principalName: string; agentName: string; endDate: DateLike }>;
}

export type PromissoryCompanyRole = 'CREDITOR' | 'DEBTOR';

export interface PromissoryNoteAlertSource {
  id: string;
  amount: number;
  creditorName: string;
  debtorName: string;
  /** PromissoryNote.companyRole: CREDITOR (the note is owed to the company) or DEBTOR (owed by it). */
  companyRole: string | null;
  dueDate: DateLike;
}

/** Stored companyRole -> CREDITOR | DEBTOR (the column defaults to CREDITOR). */
export function promissoryCompanyRole(value: string | null | undefined): PromissoryCompanyRole {
  return String(value ?? '').trim().toUpperCase() === 'DEBTOR' ? 'DEBTOR' : 'CREDITOR';
}

/** Arabic label of the company's side of a promissory note. */
export const PROMISSORY_ROLE_LABELS: Record<PromissoryCompanyRole, string> = {
  CREDITOR: 'الشركة دائنة (مستحق لنا)',
  DEBTOR: 'الشركة مدينة (مستحق علينا)',
};

/**
 * Wording of a promissory-note alert, by the company's side of the note. It only describes the
 * due date and the payment status recorded in the system; it never claims that the note was
 * referred to execution (the system does not file execution requests).
 */
export function promissoryNoteAlertText(
  note: Pick<PromissoryNoteAlertSource, 'amount' | 'creditorName' | 'debtorName' | 'companyRole'>,
  daysLeft: number,
): { type: 'NOTE_EXPIRED' | 'NOTE_DUE' | 'NOTE_NOTICE'; companyRole: PromissoryCompanyRole; source: string; counterparty: string; message: string } {
  const role = promissoryCompanyRole(note.companyRole);
  const amount = `${formatMoney(note.amount)} ر.س`;
  const ours = role === 'CREDITOR';
  const counterparty = ours ? note.debtorName : note.creditorName;
  const source = ours ? `سند لصالح الشركة على ${note.debtorName}` : `سند على الشركة لصالح ${note.creditorName}`;
  const party = ours ? `على (${note.debtorName})` : `لصالح (${note.creditorName})`;

  if (daysLeft < 0) {
    const late = Math.abs(daysLeft);
    return {
      type: 'NOTE_EXPIRED',
      companyRole: role,
      source,
      counterparty,
      message: ours
        ? `مستحق لنا غير مسدد: سند بمبلغ ${amount} ${party} تجاوز تاريخ استحقاقه بـ ${late} يوم. تابع التحصيل مع المدين.`
        : `مستحق علينا، خطر تنفيذ: سند بمبلغ ${amount} ${party} تجاوز تاريخ استحقاقه بـ ${late} يوم دون سداد مسجل.`,
    };
  }
  if (daysLeft === 0) {
    // Due today: not overdue yet (same "0 days = expires today" rule as every other document).
    return {
      type: 'NOTE_DUE',
      companyRole: role,
      source,
      counterparty,
      message: ours
        ? `مستحق لنا اليوم: سند بمبلغ ${amount} ${party}. تابع التحصيل مع المدين.`
        : `مستحق علينا اليوم: سند بمبلغ ${amount} ${party}. رتّب السداد اليوم.`,
    };
  }
  return {
    type: 'NOTE_NOTICE',
    companyRole: role,
    source,
    counterparty,
    message: ours
      ? `مستحق لنا قريباً: سند بمبلغ ${amount} ${party} يستحق بعد ${daysLeft} يوم.`
      : `مستحق علينا قريباً: سند بمبلغ ${amount} ${party} يستحق بعد ${daysLeft} يوم. رتّب السداد قبل الموعد.`,
  };
}

export function buildLegalAlerts(src: LegalAlertSources, t: AlertThresholds, now: Date = new Date()): LegalAlert[] {
  const alerts: LegalAlert[] = [];
  const shortId = (id: string) => id.substring(0, 5);

  for (const note of src.notes) {
    const s = expiryAlert(note.dueDate, t.promissoryNote, now);
    if (!s || !note.dueDate) continue;
    const text = promissoryNoteAlertText(note, s.daysLeft);
    alerts.push({
      id: `note-${note.id}`,
      category: 'PROMISSORY_NOTE',
      type: text.type,
      companyRole: text.companyRole,
      source: text.source,
      message: text.message,
      employeeId: shortId(note.id),
      employee: text.counterparty,
      dueDate: note.dueDate,
      level: s.level,
      daysLeft: s.daysLeft,
    });
  }

  for (const c of src.contracts) {
    const s = expiryAlert(c.endDate, t.legalContract, now);
    if (!s || !c.endDate) continue;
    const expired = s.level === 'expired';
    alerts.push({
      id: `contract-${c.id}`,
      category: 'LEGAL_CONTRACT',
      type: expired ? 'CONTRACT_EXPIRED' : 'CONTRACT_NOTICE',
      level: s.level,
      daysLeft: s.daysLeft,
      source: `عقد: ${c.title}`,
      message: expired
        ? `عقد منتهي بين (${c.firstParty}) و (${c.secondParty}). يرجى اتخاذ الإجراء القانوني اللازم لتجديده أو إغلاقه.`
        : `تنبيه: العقد بين (${c.firstParty}) و (${c.secondParty}) سينتهي خلال ${s.daysLeft} يوم. (ضمن نطاق الـ ${t.legalContract} يوم)`,
      employeeId: shortId(c.id),
      employee: c.title,
      dueDate: c.endDate,
    });
  }

  const todayDate = today(now);
  for (const l of src.lawsuits) {
    alerts.push({
      id: `lawsuit-${l.id}`,
      category: 'LAWSUIT',
      type: 'LAWSUIT_ACTIVE',
      source: `تمثيل قانوني ضد: ${l.defendant}`,
      message: `يوجد نزاع قضائي قائم ومحال لمكتب المحاماة (${l.lawFirmName || 'غير محدد'}). تصنيف الدعوى: ${l.caseType} - الموضوع: ${l.subject}.`,
      employeeId: shortId(l.id),
      employee: l.plaintiff,
      dueDate: todayDate,
    });
  }

  for (const a of src.agencies) {
    const s = expiryAlert(a.endDate, t.agency, now);
    if (!s || !a.endDate) continue;
    const expired = s.level === 'expired';
    alerts.push({
      id: `agency-${a.id}`,
      category: 'AGENCY',
      type: expired ? 'AGENCY_EXPIRED' : 'AGENCY_NOTICE',
      level: s.level,
      daysLeft: s.daysLeft,
      source: `وكالة رَقْم: ${a.agencyNumber}`,
      message: expired
        ? `وكالة منتهية الصلاحية بين الموكل (${a.principalName}) والوكيل (${a.agentName}). يرجى اتخاذ الإجراء اللازم.`
        : `تنبيه: الوكالة الصادرة إلى (${a.agentName}) ستنتهي خلال ${s.daysLeft} يوم.`,
      employeeId: shortId(a.id),
      employee: a.principalName,
      dueDate: a.endDate,
    });
  }

  return alerts;
}

// ---------------------------------------------------------------------------
// DB helpers (thin; take the client as a parameter so this module never imports it)
// ---------------------------------------------------------------------------

export type AlertsDb = PrismaClient | Prisma.TransactionClient;

/** Reads the alert_* SystemSetting rows and applies defaults. */
export async function getAlertThresholds(db: AlertsDb): Promise<AlertThresholds> {
  const rows = await db.systemSetting.findMany({
    where: { key: { in: ALERT_SETTING_KEYS } },
    select: { key: true, value: true },
  });
  return parseAlertThresholds(rows);
}

export const employeeAlertSelect = {
  id: true,
  employeeId: true,
  firstNameArabic: true,
  lastNameArabic: true,
  iqamaOrIdExp: true,
  passportExp: true,
  healthCertificateExp: true,
  contractEndDate: true,
  probationEndDate: true,
  noticePeriodDays: true,
  branchId: true,
  legalCompanyId: true,
} satisfies Prisma.EmployeeSelect;

/** Active employees with their document dates (shared by HR alerts and the dashboard). */
export function loadEmployeeAlertSources(db: AlertsDb) {
  return db.employee.findMany({ where: { isTerminated: false }, select: employeeAlertSelect });
}

/** Companies, branches and active legal contracts inside their alert windows. */
export async function loadAdminAlertSources(db: AlertsDb, t: AlertThresholds, now: Date = new Date()): Promise<AdminAlertSources> {
  const [companies, branches, contracts] = await Promise.all([
    db.company.findMany({
      where: {
        OR: [
          { commercialRegExp: { lt: alertCutoffDate(t.commercialReg, now) } },
          { trademarkExpDate: { lt: alertCutoffDate(t.trademark, now) } },
        ],
      },
      select: { id: true, nameArabic: true, commercialRegExp: true, trademarkExpDate: true },
    }),
    db.branch.findMany({
      where: {
        OR: [
          { munLicenseExp: { lt: alertCutoffDate(t.municipalLicense, now) } },
          { civilDefenseExp: { lt: alertCutoffDate(t.civilDefense, now) } },
          { rentContractExp: { lt: alertCutoffDate(t.leaseContract, now) } },
          { wasteContractExp: { lt: alertCutoffDate(t.wasteContract, now) } },
          { safetyContractExp: { lt: alertCutoffDate(t.safetyContract, now) } },
          { cameraContractExp: { lt: alertCutoffDate(t.cameraContract, now) } },
        ],
      },
      select: {
        id: true,
        nameArabic: true,
        munLicenseExp: true,
        civilDefenseExp: true,
        rentContractExp: true,
        wasteContractExp: true,
        safetyContractExp: true,
        cameraContractExp: true,
        company: { select: { nameArabic: true } },
      },
    }),
    db.legalContract.findMany({
      where: { status: 'ACTIVE', endDate: { not: null, lt: alertCutoffDate(t.legalContract, now) } },
      select: { id: true, title: true, endDate: true },
    }),
  ]);
  return { companies, branches, contracts };
}

/**
 * Legal alert sources: unpaid promissory notes, active contracts and agencies inside their
 * alert windows, and lawsuits still referred to a law firm.
 */
export async function loadLegalAlertSources(db: AlertsDb, t: AlertThresholds, now: Date = new Date()): Promise<LegalAlertSources> {
  const [notes, contracts, lawsuits, agencies] = await Promise.all([
    db.promissoryNote.findMany({
      where: {
        status: { notIn: ['PAID', 'CANCELLED'] },
        dueDate: { not: null, lt: alertCutoffDate(t.promissoryNote, now) },
      },
      select: { id: true, amount: true, creditorName: true, debtorName: true, companyRole: true, dueDate: true },
      orderBy: { dueDate: 'asc' },
    }),
    db.legalContract.findMany({
      where: { status: 'ACTIVE', endDate: { not: null, lt: alertCutoffDate(t.legalContract, now) } },
      select: { id: true, title: true, firstParty: true, secondParty: true, endDate: true },
      orderBy: { endDate: 'asc' },
    }),
    db.lawsuit.findMany({
      where: { status: 'REFERRED' },
      select: { id: true, defendant: true, plaintiff: true, lawFirmName: true, caseType: true, subject: true },
      orderBy: { createdAt: 'desc' },
    }),
    db.certifiedAgency.findMany({
      where: { status: 'ACTIVE', endDate: { lt: alertCutoffDate(t.agency, now) } },
      select: { id: true, agencyNumber: true, principalName: true, agentName: true, endDate: true },
      orderBy: { endDate: 'asc' },
    }),
  ]);
  return { notes, contracts, lawsuits, agencies };
}

const vehicleLabelSelect = {
  brand: true,
  modelYear: true,
  plateNumber: true,
  driver: { select: { firstNameArabic: true } },
} satisfies Prisma.VehicleSelect;

/** Non-archived vehicles with at least one document inside its alert window. */
export function loadVehicleAlertSources(db: AlertsDb, t: AlertThresholds, now: Date = new Date()) {
  return db.vehicle.findMany({
    where: {
      isArchived: false,
      OR: [
        { licenseExpDate: { lt: alertCutoffDate(t.vehicleLicense, now) } },
        { insuranceExpDate: { lt: alertCutoffDate(t.vehicleInsurance, now) } },
        { inspectionExpDate: { lt: alertCutoffDate(t.vehicleInspection, now) } },
        { operatingCardExpDate: { lt: alertCutoffDate(t.operatingCard, now) } },
        { driverCardExpDate: { lt: alertCutoffDate(t.driverCard, now) } },
        { drivingAuthExpDate: { lt: alertCutoffDate(t.drivingAuth, now) } },
      ],
    },
    select: {
      id: true,
      ...vehicleLabelSelect,
      licenseExpDate: true,
      insuranceExpDate: true,
      inspectionExpDate: true,
      operatingCardExpDate: true,
      driverCardExpDate: true,
      drivingAuthExpDate: true,
    },
  });
}

/** Open accident claims. */
export function loadClaimAlertSources(db: AlertsDb) {
  return db.accidentClaim.findMany({
    where: { status: { in: ['PENDING_SUBMISSION', 'SUBMITTED'] } },
    select: { id: true, status: true, createdAt: true, vehicle: { select: vehicleLabelSelect } },
  });
}
