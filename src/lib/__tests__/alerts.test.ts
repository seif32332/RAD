import { describe, expect, it } from 'vitest';
import {
  alertCutoffDate,
  buildEmployeeDocumentAlerts,
  classifyExpiry,
  countByLevel,
  CRITICAL_DAYS,
  daysSince,
  DEFAULT_ALERT_THRESHOLDS,
  expiryAlert,
  isAlerting,
  nextAnnualLeaveDueDate,
  parseAlertThresholds,
  parseThresholdValue,
  renewalDateKey,
  renewalKey,
  type EmployeeAlertSource,
} from '@/lib/alerts';

const NOW = new Date('2026-09-23T10:00:00.000Z'); // 13:00 in Riyadh
const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe('classifyExpiry', () => {
  it('"expires today" is 0 days left and critical', () => {
    expect(classifyExpiry(d('2026-09-23'), 30, NOW)).toEqual({ daysLeft: 0, level: 'critical' });
  });

  it('yesterday is expired', () => {
    expect(classifyExpiry(d('2026-09-22'), 30, NOW)).toEqual({ daysLeft: -1, level: 'expired' });
  });

  it('classifies around the critical and warning thresholds', () => {
    expect(CRITICAL_DAYS).toBe(7);
    expect(classifyExpiry(d('2026-09-30'), 30, NOW)).toEqual({ daysLeft: 7, level: 'critical' });
    expect(classifyExpiry(d('2026-10-01'), 30, NOW)).toEqual({ daysLeft: 8, level: 'warning' });
    expect(classifyExpiry(d('2026-10-23'), 30, NOW)).toEqual({ daysLeft: 30, level: 'warning' });
    expect(classifyExpiry(d('2026-10-24'), 30, NOW)).toEqual({ daysLeft: 31, level: 'ok' });
  });

  it('a threshold shorter than a week caps the critical window', () => {
    expect(classifyExpiry(d('2026-09-26'), 3, NOW)?.level).toBe('critical');
    expect(classifyExpiry(d('2026-09-27'), 3, NOW)?.level).toBe('ok');
  });

  it('uses the Riyadh day near midnight', () => {
    const late = new Date('2026-09-23T21:30:00.000Z'); // already the 24th in Riyadh
    expect(classifyExpiry(d('2026-09-23'), 30, late)?.level).toBe('expired');
    expect(classifyExpiry(d('2026-09-24'), 30, late)?.daysLeft).toBe(0);
  });

  it('returns null without a valid date', () => {
    expect(classifyExpiry(null, 30, NOW)).toBeNull();
    expect(classifyExpiry('nope', 30, NOW)).toBeNull();
  });
});

describe('isAlerting / expiryAlert / countByLevel', () => {
  it('ok never alerts; expired alerts unless outside the look-back window', () => {
    expect(isAlerting({ daysLeft: 40, level: 'ok' })).toBe(false);
    expect(isAlerting({ daysLeft: -100, level: 'expired' })).toBe(true);
    expect(isAlerting({ daysLeft: -60, level: 'expired' }, 60)).toBe(true);
    expect(isAlerting({ daysLeft: -61, level: 'expired' }, 60)).toBe(false);
    expect(isAlerting(null)).toBe(false);
  });

  it('expiryAlert combines both', () => {
    expect(expiryAlert(d('2026-10-01'), 30, NOW)).toEqual({ daysLeft: 8, level: 'warning' });
    expect(expiryAlert(d('2026-12-01'), 30, NOW)).toBeNull();
    expect(expiryAlert(d('2026-06-01'), 30, NOW, 60)).toBeNull();
  });

  it('counts levels', () => {
    expect(countByLevel([{ level: 'expired' }, { level: 'warning' }, { level: 'warning' }])).toEqual({
      expired: 1,
      critical: 0,
      warning: 2,
      ok: 0,
    });
  });
});

describe('alertCutoffDate', () => {
  it('is the exclusive upper bound today + n + 1 (UTC midnight)', () => {
    expect(alertCutoffDate(30, NOW).toISOString()).toBe('2026-10-24T00:00:00.000Z');
    expect(alertCutoffDate(0, NOW).toISOString()).toBe('2026-09-24T00:00:00.000Z');
    expect(alertCutoffDate(-5, NOW).toISOString()).toBe('2026-09-24T00:00:00.000Z');
    // A document expiring on the last day of the window is included (< cutoff).
    expect(d('2026-10-23') < alertCutoffDate(30, NOW)).toBe(true);
  });
});

describe('thresholds', () => {
  it('parseThresholdValue accepts positive whole days only', () => {
    expect(parseThresholdValue('45')).toBe(45);
    expect(parseThresholdValue('45.7')).toBe(45);
    expect(parseThresholdValue(' 10 ')).toBe(10);
    expect(parseThresholdValue('0')).toBeNull();
    expect(parseThresholdValue('-3')).toBeNull();
    expect(parseThresholdValue('abc')).toBeNull();
    expect(parseThresholdValue(null)).toBeNull();
    expect(parseThresholdValue(99999)).toBe(3650);
  });

  it('parseAlertThresholds falls back to defaults', () => {
    const t = parseAlertThresholds([
      { key: 'alert_iqama_days', value: '45' },
      { key: 'alert_passport_days', value: 'x' },
      { key: 'unrelated', value: '5' },
    ]);
    expect(t.iqama).toBe(45);
    expect(t.passport).toBe(DEFAULT_ALERT_THRESHOLDS.passport);
    expect(t.contract).toBe(60);
  });
});

describe('small helpers', () => {
  it('renewal keys', () => {
    expect(renewalKey('e1', 'IQAMA')).toBe('e1|IQAMA');
    expect(renewalDateKey('e1', 'IQAMA', d('2026-09-23'))).toBe('e1|IQAMA|2026-09-23');
    expect(renewalDateKey('e1', 'IQAMA', null)).toBe('e1|IQAMA|');
  });

  it('nextAnnualLeaveDueDate adds one year; 29 Feb becomes 28 Feb', () => {
    expect(nextAnnualLeaveDueDate(d('2025-03-10'))?.toISOString()).toBe('2026-03-10T00:00:00.000Z');
    expect(nextAnnualLeaveDueDate(d('2024-02-29'))?.toISOString()).toBe('2025-02-28T00:00:00.000Z');
    expect(nextAnnualLeaveDueDate(d('2025-03-10'), d('2026-05-01'))?.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(nextAnnualLeaveDueDate('garbage')).toBeNull();
  });

  it('daysSince counts Riyadh calendar days', () => {
    expect(daysSince('2026-09-20T22:00:00.000Z', NOW)).toBe(2); // 21st in Riyadh
    expect(daysSince('2026-09-23T08:00:00.000Z', NOW)).toBe(0);
    expect(daysSince('garbage', NOW)).toBe(0);
  });
});

describe('buildEmployeeDocumentAlerts', () => {
  const emp = (over: Partial<EmployeeAlertSource>): EmployeeAlertSource => ({
    id: 'e1',
    employeeId: 'EMP-0001',
    firstNameArabic: 'محمد',
    lastNameArabic: 'العمري',
    iqamaOrIdExp: null,
    passportExp: null,
    healthCertificateExp: null,
    contractEndDate: null,
    probationEndDate: null,
    noticePeriodDays: null,
    branchId: 'b1',
    legalCompanyId: 'c1',
    ...over,
  });

  it('raises iqama alerts inside the window and flags expired documents', () => {
    const alerts = buildEmployeeDocumentAlerts(
      [emp({ iqamaOrIdExp: d('2026-10-03'), passportExp: d('2026-09-20'), healthCertificateExp: d('2027-09-23') })],
      DEFAULT_ALERT_THRESHOLDS,
      NOW,
    );
    const iqama = alerts.find((a) => a.type === 'IQAMA');
    expect(iqama).toMatchObject({ id: 'e1-iqama', daysLeft: 10, level: 'warning', employee: 'محمد العمري' });
    const passport = alerts.find((a) => a.type === 'PASSPORT_EXPIRED');
    expect(passport).toMatchObject({ daysLeft: -3, level: 'expired' });
    expect(alerts.some((a) => a.type.startsWith('HEALTH_CERT'))).toBe(false);
  });

  it('an iqama expiring today is a critical alert with 0 days left', () => {
    const alerts = buildEmployeeDocumentAlerts([emp({ iqamaOrIdExp: d('2026-09-23') })], DEFAULT_ALERT_THRESHOLDS, NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ type: 'IQAMA', daysLeft: 0, level: 'critical' });
  });

  it('no dates, no alerts', () => {
    expect(buildEmployeeDocumentAlerts([emp({})], DEFAULT_ALERT_THRESHOLDS, NOW)).toEqual([]);
  });
});
