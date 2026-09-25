// SystemSetting keys that the settings page can edit, with defaults and validation.
//
// PURE module (no Prisma / server-only imports): used by the settings API, the login and
// password routes, and the settings page itself.
//
// Only settings that something in the system actually reads are listed here. Every key has a
// consumer:
//   alert_*_days                    -> src/lib/alerts.ts (getAlertThresholds)
//   overtime_*, gosi_employee_*,
//   default_work_*                  -> src/lib/payroll-core.ts (parsePayrollSettings)
//   annual_leave_days               -> src/lib/leave.ts / settlement.ts (empty = statutory 21/30)
//   exit_reentry_visa_fee           -> src/lib/hr-workflows.ts / settlement.ts
//   leave_maternity_*, leave_paternity_*, leave_marriage_days, leave_bereavement_*,
//   leave_hajj_*                    -> src/lib/hr-workflows.ts (getStatutoryLeaveRules -> src/lib/leave.ts)
//   session_timeout_minutes         -> /api/auth/login (JWT + cookie lifetime)
//   max_login_attempts              -> /api/auth/login (per-account rate limit)
//   password_min_length             -> user creation / password change routes
import { ALERT_THRESHOLD_SETTINGS } from '@/lib/alerts';
import { DEFAULT_PAYROLL_SETTINGS, PAYROLL_SETTING_KEYS } from '@/lib/payroll-core';
import { DEFAULT_EXIT_REENTRY_VISA_FEE } from '@/lib/constants';
import { DEFAULT_STATUTORY_LEAVE_RULES, LEAVE_RULE_LIMITS, LEAVE_RULE_SETTING_KEYS } from '@/lib/leave';

export interface SettingDef {
  /** Default value ('' = not set). */
  defaultValue: string;
  min: number;
  max: number;
  integer: boolean;
  /** '' is accepted (means "use the built-in rule"). */
  optional?: boolean;
}

export const SECURITY_SETTING_KEYS = {
  sessionTimeoutMinutes: 'session_timeout_minutes',
  maxLoginAttempts: 'max_login_attempts',
  passwordMinLength: 'password_min_length',
} as const;

export interface SecurityPolicy {
  sessionTimeoutMinutes: number;
  maxLoginAttempts: number;
  passwordMinLength: number;
}

export const DEFAULT_SECURITY_POLICY: SecurityPolicy = {
  sessionTimeoutMinutes: 12 * 60,
  maxLoginAttempts: 5,
  passwordMinLength: 8,
};

const int = (defaultValue: number, min: number, max: number): SettingDef => ({ defaultValue: String(defaultValue), min, max, integer: true });
const num = (defaultValue: number, min: number, max: number): SettingDef => ({ defaultValue: String(defaultValue), min, max, integer: false });

const alertDefs: Record<string, SettingDef> = Object.fromEntries(
  Object.values(ALERT_THRESHOLD_SETTINGS).map((s) => [s.key, int(s.days, 1, 3650)]),
);

const P = PAYROLL_SETTING_KEYS;
const PD = DEFAULT_PAYROLL_SETTINGS;

const statutoryLeaveDefs: Record<string, SettingDef> = Object.fromEntries(
  (Object.keys(LEAVE_RULE_SETTING_KEYS) as Array<keyof typeof LEAVE_RULE_SETTING_KEYS>).map((field) => [
    LEAVE_RULE_SETTING_KEYS[field],
    int(DEFAULT_STATUTORY_LEAVE_RULES[field], LEAVE_RULE_LIMITS[field].min, LEAVE_RULE_LIMITS[field].max),
  ]),
);

/** Setting keys whose defaults are provisional (pending the legal / payroll counsel's confirmation). */
export const PROVISIONAL_SETTING_KEYS: readonly string[] = Object.values(LEAVE_RULE_SETTING_KEYS);

export const SETTING_DEFS: Readonly<Record<string, SettingDef>> = {
  ...alertDefs,

  // Payroll
  [P.overtimeMultiplier]: num(PD.overtimeMultiplier, 1, 10),
  [P.overtimeWeekendMultiplier]: num(PD.overtimeWeekendMultiplier, 1, 10),
  [P.gosiEmployeePercentage]: num(PD.gosiEmployeePercentage, 0, 100),
  [P.gosiEmployeePercentageNonSaudi]: num(PD.gosiEmployeePercentageNonSaudi, 0, 100),
  [P.workHoursPerDay]: num(PD.workHoursPerDay, 1, 24),
  [P.workDaysPerWeek]: int(PD.workDaysPerWeek, 1, 7),

  // Leave / end of service: empty = statutory (21 days, 30 after 5 years of service).
  annual_leave_days: { defaultValue: '', min: 21, max: 365, integer: true, optional: true },
  exit_reentry_visa_fee: num(DEFAULT_EXIT_REENTRY_VISA_FEE, 0, 100_000),

  // Statutory leaves (DEC-003): PROVISIONAL defaults pending counsel confirmation.
  ...statutoryLeaveDefs,

  // Security
  [SECURITY_SETTING_KEYS.sessionTimeoutMinutes]: int(DEFAULT_SECURITY_POLICY.sessionTimeoutMinutes, 15, 7 * 24 * 60),
  [SECURITY_SETTING_KEYS.maxLoginAttempts]: int(DEFAULT_SECURITY_POLICY.maxLoginAttempts, 3, 20),
  [SECURITY_SETTING_KEYS.passwordMinLength]: int(DEFAULT_SECURITY_POLICY.passwordMinLength, 8, 64),
};

export const DEFAULT_SETTINGS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(SETTING_DEFS).map(([k, d]) => [k, d.defaultValue]),
);

export function isKnownSetting(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(SETTING_DEFS, key);
}

/** Normalises a submitted value ('  30 ' -> '30'). */
export function normalizeSettingValue(value: string): string {
  return value.trim();
}

/** Arabic error for an invalid value of a known setting, or null when valid. */
export function settingValueProblem(key: string, value: string): string | null {
  const def = SETTING_DEFS[key];
  if (!def) return null;
  const v = value.trim();
  if (v === '') return def.optional ? null : 'القيمة مطلوبة';
  const n = Number(v);
  if (!Number.isFinite(n)) return 'يجب أن تكون القيمة رقماً';
  if (def.integer && !Number.isInteger(n)) return 'يجب أن تكون القيمة رقماً صحيحاً';
  if (n < def.min || n > def.max) return `يجب أن تكون القيمة بين ${def.min} و ${def.max}`;
  return null;
}

function numericOr(raw: string | undefined, def: SettingDef): number {
  if (raw === undefined) return Number(def.defaultValue);
  const v = raw.trim();
  const n = Number(v);
  if (v === '' || !Number.isFinite(n) || n < def.min || n > def.max) return Number(def.defaultValue);
  return def.integer ? Math.floor(n) : n;
}

/** Security policy from SystemSetting rows; missing / invalid values fall back to defaults. */
export function parseSecurityPolicy(rows: ReadonlyArray<{ key: string; value: string }>): SecurityPolicy {
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const K = SECURITY_SETTING_KEYS;
  return {
    sessionTimeoutMinutes: numericOr(map.get(K.sessionTimeoutMinutes), SETTING_DEFS[K.sessionTimeoutMinutes]),
    maxLoginAttempts: numericOr(map.get(K.maxLoginAttempts), SETTING_DEFS[K.maxLoginAttempts]),
    passwordMinLength: numericOr(map.get(K.passwordMinLength), SETTING_DEFS[K.passwordMinLength]),
  };
}

/** Extra password rule on top of zPassword (letters + digits, min 8): the configured minimum length. */
export function passwordLengthProblem(password: string, minLength: number): string | null {
  return password.length < minLength ? `كلمة المرور يجب ألا تقل عن ${minLength} أحرف` : null;
}
