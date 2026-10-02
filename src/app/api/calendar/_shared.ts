// Shared plumbing of the calendar routes (/api/calendar, /api/work-schedules): the caller's scope,
// the operation of a request, the HTTP form of the calendar errors, and the legal cap of the Ramadan
// hours. The cap is read here, in the route layer, because calendar sits on the same layer as rules
// (DOMAIN_BOUNDARIES §5.3) and cannot call rules.valueAt itself.
import { randomUUID } from 'crypto';
import { getClientIp } from '@/lib/auth';
import { badRequest, conflict, forbidden, notFound } from '@/lib/http';
import { ALL_COMPANIES, type ScopeContext } from '@/modules/iam';
import { valueAt } from '@/modules/rules';
import {
  CalendarConflictError,
  CalendarInputError,
  CalendarNotFoundError,
  CalendarScopeError,
  type CalendarCompanies,
  type CalendarOp,
} from '@/modules/calendar';

export const RAMADAN_MAX_DAILY_HOURS_KEY = 'RAMADAN_WORK_HOURS_PER_DAY_MAX';

export function companiesOf(ctx: ScopeContext): CalendarCompanies {
  return ctx.companies === ALL_COMPANIES ? 'ALL' : ctx.companies;
}

/** The operation of one request: the client's Idempotency-Key (a retry replays), else a fresh key. */
export function operationOf(req: Request, userId: string): CalendarOp {
  return {
    key: `calendar:${req.headers.get('idempotency-key')?.trim() || randomUUID()}`,
    actor: { type: 'USER', id: userId },
    ipAddress: getClientIp(req),
  };
}

/** Maps the calendar module's errors to HTTP errors (others are rethrown as they are). */
export function calendarHttpError(err: unknown): unknown {
  if (err instanceof CalendarScopeError) return forbidden('هذه الشركة خارج نطاق صلاحياتك');
  if (err instanceof CalendarNotFoundError) return notFound('العنصر المطلوب غير موجود');
  if (err instanceof CalendarConflictError) return conflict(err.message);
  if (err instanceof CalendarInputError) return badRequest(err.message);
  return err;
}

/**
 * The legal cap of the Ramadan daily hours on `at` (Labor Law Art. 98), from the rules module
 * (RuleParameter RAMADAN_WORK_HOURS_PER_DAY_MAX, P1-RULE). The company's own value is the
 * RamadanPeriod.dailyHours it saves (DEC-PO-116), so the legal value is read without override.
 */
export function ramadanLegalMaxDailyHours(at: Date): Promise<number> {
  return valueAt(RAMADAN_MAX_DAILY_HOURS_KEY, null, at);
}
