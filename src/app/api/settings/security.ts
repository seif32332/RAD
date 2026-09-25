// Server-side reader for the security settings (login / password routes).
import 'server-only';
import { ZodError } from 'zod';
import { prisma } from '@/lib/prisma';
import { badRequest } from '@/lib/http';
import { SECURITY_SETTING_KEYS, parseSecurityPolicy, passwordLengthProblem, type SecurityPolicy } from './definitions';

export async function loadSecurityPolicy(): Promise<SecurityPolicy> {
  try {
    const rows = await prisma.systemSetting.findMany({
      where: { key: { in: Object.values(SECURITY_SETTING_KEYS) } },
      select: { key: true, value: true },
    });
    return parseSecurityPolicy(rows);
  } catch (err) {
    console.error('[security-policy] failed to read settings, using defaults:', err);
    return parseSecurityPolicy([]);
  }
}

/** Throws 400 when `password` is shorter than the configured minimum length. */
export async function assertPasswordLength(password: string | undefined | null): Promise<void> {
  if (!password) return;
  const { passwordMinLength } = await loadSecurityPolicy();
  const problem = passwordLengthProblem(password, passwordMinLength);
  if (problem) throw badRequest(problem);
}

const ARABIC = /[؀-ۿ]/;

/**
 * Turns a ZodError into a 400 whose message is the Arabic validation text itself
 * (e.g. "كلمة المرور يجب أن تحتوي على رقم") instead of a list of field names, so the page can
 * show it directly. Other errors are returned unchanged.
 */
export function friendlyValidationError(err: unknown): unknown {
  if (!(err instanceof ZodError)) return err;
  const issues = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  const arabic = Array.from(new Set(issues.map((i) => i.message).filter((m) => ARABIC.test(m))));
  if (arabic.length === 0) return err;
  return badRequest(arabic.join('، '), issues);
}
