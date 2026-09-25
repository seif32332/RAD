import { describe, expect, it } from 'vitest';
import { checkCreateRole, checkUserChange } from '../users/shared';
import {
  DEFAULT_SETTINGS,
  SETTING_DEFS,
  parseSecurityPolicy,
  passwordLengthProblem,
  settingValueProblem,
} from '../definitions';
import { ALERT_THRESHOLD_SETTINGS } from '@/lib/alerts';
import {
  SESSION_MAX_SECONDS,
  SESSION_MIN_SECONDS,
  clampSessionSeconds,
  credentialVersion,
  sessionMatchesCredentials,
  signSession,
  verifySession,
} from '@/lib/session';

const superA = { id: 'a', role: 'SUPER_ADMIN' };
const company = { id: 'c', role: 'COMPANY_ADMIN' };

describe('checkUserChange', () => {
  it('refuses to delete, demote or deactivate the last active SUPER_ADMIN', () => {
    const target = { id: 'b', role: 'SUPER_ADMIN', isActive: true };
    expect(checkUserChange(superA, target, { isDelete: true }, 1)?.status).toBe(409);
    expect(checkUserChange(superA, target, { nextRole: 'HR_MANAGER' }, 1)?.status).toBe(409);
    expect(checkUserChange(superA, target, { nextActive: false }, 1)?.status).toBe(409);
    expect(checkUserChange(superA, target, { isDelete: true }, 2)).toBeNull();
  });

  it('protects the actor from locking themselves out', () => {
    const self = { id: 'a', role: 'SUPER_ADMIN', isActive: true };
    expect(checkUserChange(superA, self, { isDelete: true }, 5)?.status).toBe(403);
    expect(checkUserChange(superA, self, { nextRole: 'EMPLOYEE' }, 5)?.status).toBe(403);
    expect(checkUserChange(superA, self, { nextActive: false }, 5)?.status).toBe(403);
    expect(checkUserChange(superA, self, { nextRole: 'SUPER_ADMIN', nextActive: true }, 5)).toBeNull();
  });

  it('keeps SUPER_ADMIN accounts out of COMPANY_ADMIN reach', () => {
    const target = { id: 'b', role: 'SUPER_ADMIN', isActive: true };
    expect(checkUserChange(company, target, { nextActive: false }, 3)?.status).toBe(403);
    expect(checkUserChange(company, { id: 'e', role: 'EMPLOYEE', isActive: true }, { nextRole: 'SUPER_ADMIN' }, 3)?.status).toBe(403);
    expect(checkUserChange(company, { id: 'e', role: 'EMPLOYEE', isActive: true }, { nextRole: 'HR_MANAGER' }, 3)).toBeNull();
    expect(checkCreateRole(company, 'SUPER_ADMIN')?.status).toBe(403);
    expect(checkCreateRole(superA, 'SUPER_ADMIN')).toBeNull();
  });
});

describe('settings definitions', () => {
  it('exposes every alert threshold with its alerts.ts default', () => {
    for (const s of Object.values(ALERT_THRESHOLD_SETTINGS)) expect(DEFAULT_SETTINGS[s.key]).toBe(String(s.days));
  });

  it('defaults annual_leave_days to empty (statutory 21/30)', () => {
    expect(DEFAULT_SETTINGS.annual_leave_days).toBe('');
    expect(settingValueProblem('annual_leave_days', '')).toBeNull();
    expect(settingValueProblem('annual_leave_days', '20')).not.toBeNull();
    expect(settingValueProblem('annual_leave_days', '30')).toBeNull();
  });

  it('validates numbers, integers and ranges', () => {
    expect(settingValueProblem('alert_iqama_days', '0')).not.toBeNull();
    expect(settingValueProblem('alert_iqama_days', '')).not.toBeNull();
    expect(settingValueProblem('alert_iqama_days', '12.5')).not.toBeNull();
    expect(settingValueProblem('alert_iqama_days', ' 45 ')).toBeNull();
    expect(settingValueProblem('overtime_rate_multiplier', '1.75')).toBeNull();
    expect(settingValueProblem('overtime_rate_multiplier', 'abc')).not.toBeNull();
    expect(settingValueProblem('session_timeout_minutes', '5')).not.toBeNull();
    expect(settingValueProblem('unknown_key', 'anything')).toBeNull();
    for (const [key, def] of Object.entries(SETTING_DEFS)) expect(settingValueProblem(key, def.defaultValue)).toBeNull();
  });

  it('parses the security policy with fallbacks', () => {
    expect(parseSecurityPolicy([])).toEqual({ sessionTimeoutMinutes: 720, maxLoginAttempts: 5, passwordMinLength: 8 });
    expect(
      parseSecurityPolicy([
        { key: 'session_timeout_minutes', value: '60' },
        { key: 'max_login_attempts', value: '1' },
        { key: 'password_min_length', value: '12' },
      ]),
    ).toEqual({ sessionTimeoutMinutes: 60, maxLoginAttempts: 5, passwordMinLength: 12 });
    expect(passwordLengthProblem('Abcdef123', 10)).not.toBeNull();
    expect(passwordLengthProblem('Abcdef1234', 10)).toBeNull();
  });
});

describe('session credential version', () => {
  it('changes with the password hash and is checked by sessionMatchesCredentials', async () => {
    const v1 = await credentialVersion('$2b$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const v2 = await credentialVersion('$2b$12$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(v1).not.toBe(v2);
    expect(v1).not.toContain('$2b$');

    const token = await signSession({ sub: 'u1', role: 'EMPLOYEE', passwordHash: 'hash-1' }, 3600);
    const session = await verifySession(token);
    expect(session?.cv).toBe(await credentialVersion('hash-1'));
    expect(await sessionMatchesCredentials(session!, 'hash-1')).toBe(true);
    expect(await sessionMatchesCredentials(session!, 'hash-2')).toBe(false);
    // tokens without a cv claim (issued before it existed) stay valid until they expire
    expect(await sessionMatchesCredentials({}, 'hash-2')).toBe(true);
  });

  it('clamps the configured session lifetime', () => {
    expect(clampSessionSeconds(60)).toBe(SESSION_MIN_SECONDS);
    expect(clampSessionSeconds(10 ** 9)).toBe(SESSION_MAX_SECONDS);
    expect(clampSessionSeconds(Number.NaN)).toBe(12 * 3600);
    expect(clampSessionSeconds(3600)).toBe(3600);
  });
});
