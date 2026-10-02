// Company calendar (P1-CAL): official and company holidays, and the Ramadan period with its hours.
//   GET  ?companyId&year   the holidays of the year and the Ramadan periods of the caller's companies,
//                          and the legal cap of the Ramadan hours (rules.valueAt)
//   POST { action, … }     saveHoliday | cancelHoliday | seedOfficial | saveRamadan | removeRamadan
// Thin route (DOMAIN_BOUNDARIES §5.1): validate, build the scope, call the calendar module.
// Scope: the caller's companies (UserCompanyScope); a row of another company is 403.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth';
import { ROLE_GROUPS } from '@/lib/constants';
import { badRequest, handleApiError, parseBody, parseQuery } from '@/lib/http';
import { zId } from '@/lib/validation';
import { authz, resolveActor, scopedContext, scopedPrisma } from '@/modules/iam';
import { cancelHoliday, listHolidays, listRamadanPeriods, removeRamadanPeriod, saveHoliday, saveRamadanPeriod, seedOfficialHolidays } from '@/modules/calendar';
import { todayKey } from '@/lib/dates';
import { RAMADAN_MAX_DAILY_HOURS_KEY, calendarHttpError, companiesOf, operationOf, ramadanLegalMaxDailyHours } from './_shared';

export const dynamic = 'force-dynamic';

const zDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'تاريخ غير صالح');

const QuerySchema = z.object({
  companyId: zId.optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
});

export async function GET(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.STAFF);
    const q = parseQuery(req, QuerySchema);
    const actor = await resolveActor(prisma, user);
    const ctx = q.companyId ? scopedContext(actor, [q.companyId]) : scopedContext(actor);
    authz.assert(ctx, 'calendar.read');
    const companyIds = companiesOf(ctx);
    const year = q.year ?? Number(todayKey().slice(0, 4));
    const today = new Date(`${todayKey()}T00:00:00.000Z`);
    const [companies, holidays, ramadanPeriods, legalMaxDailyHours] = await Promise.all([
      scopedPrisma(ctx).company.findMany({ select: { id: true, nameArabic: true }, orderBy: { nameArabic: 'asc' } }),
      listHolidays(prisma, { companyIds, from: `${year}-01-01`, to: `${year}-12-31`, includeCancelled: true }),
      listRamadanPeriods(prisma, { companyIds }),
      ramadanLegalMaxDailyHours(today),
    ]);
    return NextResponse.json({
      year,
      companies,
      holidays,
      ramadanPeriods,
      rules: { [RAMADAN_MAX_DAILY_HOURS_KEY]: legalMaxDailyHours },
      canManage: authz.can(ctx, 'calendar.manage'),
    });
  } catch (err) {
    return handleApiError(err, 'calendar:GET');
  }
}

const ActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('saveHoliday'), id: zId.optional(), companyId: zId, name: z.string().trim().min(1).max(200), startDate: zDay, endDate: zDay.optional() }),
  z.object({ action: z.literal('cancelHoliday'), id: zId }),
  z.object({ action: z.literal('seedOfficial'), companyId: zId, year: z.number().int().min(2000).max(2100) }),
  z.object({
    action: z.literal('saveRamadan'),
    companyId: zId,
    hijriYear: z.number().int().min(1400).max(1600),
    startDate: zDay,
    endDate: zDay,
    dailyHours: z.number().positive().max(24).optional(),
  }),
  z.object({ action: z.literal('removeRamadan'), id: zId }),
]);

export async function POST(req: Request) {
  try {
    const user = await requireUser(ROLE_GROUPS.HR);
    const body = await parseBody(req, ActionSchema);
    const actor = await resolveActor(prisma, user);
    const ctx = 'companyId' in body ? scopedContext(actor, [body.companyId]) : scopedContext(actor);
    authz.assert(ctx, 'calendar.manage', 'companyId' in body ? { companyId: body.companyId } : undefined);
    const companyIds = companiesOf(ctx);
    const op = operationOf(req, user.id);
    const outcome = await (async () => {
      switch (body.action) {
        case 'saveHoliday':
          return saveHoliday(prisma, { id: body.id, companyId: body.companyId, name: body.name, startDate: body.startDate, endDate: body.endDate ?? null, companyIds }, op);
        case 'cancelHoliday':
          return cancelHoliday(prisma, { id: body.id, companyIds }, op);
        case 'seedOfficial':
          return seedOfficialHolidays(prisma, { companyId: body.companyId, year: body.year, companyIds }, op);
        case 'saveRamadan': {
          const legalMax = await ramadanLegalMaxDailyHours(new Date(`${body.startDate}T00:00:00.000Z`));
          const dailyHours = body.dailyHours ?? legalMax;
          if (dailyHours === null || dailyHours === undefined) throw badRequest('حدد ساعات العمل اليومية في رمضان');
          return saveRamadanPeriod(
            prisma,
            { companyId: body.companyId, hijriYear: body.hijriYear, startDate: body.startDate, endDate: body.endDate, dailyHours, legalMaxDailyHours: legalMax, companyIds },
            op,
          );
        }
        case 'removeRamadan':
          return removeRamadanPeriod(prisma, { id: body.id, companyIds }, op);
      }
    })().catch((e) => {
      throw calendarHttpError(e);
    });
    return NextResponse.json({ ...outcome.result, replayed: outcome.replayed });
  } catch (err) {
    return handleApiError(err, 'calendar:POST');
  }
}
