// /api/calendar and /api/work-schedules (P1-CAL) against a real PostgreSQL (migrations applied,
// including 9z_calendar and 9za_rules). Opt-in: CAL_IT=1 with DATABASE_URL pointing at a THROWAWAY
// database.
//
// Authentication is real (CLAUDE.md, ARCH-016): each call carries a session token signed by
// src/lib/session.ts for a real User row and requireUser() verifies it against the database. Only
// `cookies()` of next/headers is replaced (no request scope in vitest). Covers allow, deny (no
// session, wrong role) and the other company, and the Idempotency-Key replay.
import { randomUUID } from 'crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const RUN = process.env.CAL_IT === '1';

const state = vi.hoisted(() => ({ token: undefined as string | undefined }));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (name === 'radeef_session' && state.token ? { name, value: state.token } : undefined),
  }),
}));

describe.skipIf(!RUN)('calendar routes: allow, deny, other company (P1-CAL)', { timeout: 120_000 }, async () => {
  const { prisma } = await import('@/lib/prisma');
  const { signSession } = await import('@/lib/session');
  const calendarRoute = await import('@/app/api/calendar/route');
  const schedulesRoute = await import('@/app/api/work-schedules/route');

  const tag = randomUUID().slice(0, 8);
  const co = { A: '', B: '' };
  const branch = { A: '', B: '' };
  const users: Record<'hrA' | 'hrB' | 'payA' | 'employee', { id: string; role: string }> = {
    hrA: { id: '', role: 'HR_MANAGER' },
    hrB: { id: '', role: 'HR_MANAGER' },
    payA: { id: '', role: 'PAYROLL_ADMIN' },
    employee: { id: '', role: 'EMPLOYEE' },
  };

  async function as(who: keyof typeof users | null) {
    state.token = who ? await signSession({ sub: users[who].id, role: users[who].role, passwordHash: 'x', sessionVersion: 0 }) : undefined;
  }
  const json = (body: unknown, key?: string) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
    body: JSON.stringify(body),
  });
  const getCalendar = (q = '') => calendarRoute.GET(new Request(`http://localhost/api/calendar${q}`));
  const postCalendar = (body: unknown, key?: string) => calendarRoute.POST(new Request('http://localhost/api/calendar', json(body, key)));
  const getSchedules = (q = '') => schedulesRoute.GET(new Request(`http://localhost/api/work-schedules${q}`));
  const putSchedules = (body: unknown) => schedulesRoute.PUT(new Request('http://localhost/api/work-schedules', { ...json(body), method: 'PUT' }));
  const postSchedule = (body: unknown, key?: string) => schedulesRoute.POST(new Request('http://localhost/api/work-schedules', json(body, key)));
  const deleteSchedule = (q: string) => schedulesRoute.DELETE(new Request(`http://localhost/api/work-schedules${q}`, { method: 'DELETE' }));

  beforeAll(async () => {
    for (const k of ['A', 'B'] as const) {
      const c = await prisma.company.create({ data: { nameArabic: `تقويم ${k} ${tag}`, commercialRegNum: `CALR-${k}-${tag}`, commercialRegExp: new Date('2035-01-01') } });
      co[k] = c.id;
      branch[k] = (await prisma.branch.create({ data: { companyId: c.id, nameArabic: `فرع ${k} ${tag}` } })).id;
    }
    for (const [key, u] of Object.entries(users)) {
      u.id = (await prisma.user.create({ data: { email: `cal-${key}-${tag}@example.test`, passwordHash: 'x', role: u.role as 'HR_MANAGER' } })).id;
    }
    await prisma.userCompanyScope.createMany({
      data: [
        { userId: users.hrA.id, companyId: co.A },
        { userId: users.payA.id, companyId: co.A },
        { userId: users.hrB.id, companyId: co.B },
      ],
    });
  });

  beforeEach(() => {
    state.token = undefined;
  });

  it('deny: no session -> 401; an employee -> 403; a payroll user may read but not manage (403)', async () => {
    expect((await getCalendar()).status).toBe(401);
    expect((await getSchedules()).status).toBe(401);
    await as('employee');
    expect((await getCalendar()).status).toBe(403);
    expect((await postCalendar({ action: 'saveHoliday', companyId: co.A, name: 'x', startDate: '2030-01-01' })).status).toBe(403);
    await as('payA');
    expect((await getCalendar()).status).toBe(200);
    expect((await postCalendar({ action: 'saveHoliday', companyId: co.A, name: 'x', startDate: '2030-01-01' })).status).toBe(403);
    expect((await putSchedules({ branchId: branch.A, schedules: [] })).status).toBe(403);
  });

  it('allow: HR of A adds a holiday, seeds the official holidays and sets Ramadan (default = the legal hours); reads only A', async () => {
    await as('hrA');
    const saved = await postCalendar({ action: 'saveHoliday', companyId: co.A, name: 'عيد الفطر', startDate: '2030-04-03', endDate: '2030-04-06' });
    expect(saved.status).toBe(200);
    expect((await postCalendar({ action: 'seedOfficial', companyId: co.A, year: 2030 })).status).toBe(200);
    const ramadan = await postCalendar({ action: 'saveRamadan', companyId: co.A, hijriYear: 1451, startDate: '2030-01-20', endDate: '2030-02-18' });
    expect(ramadan.status).toBe(200);
    expect(((await ramadan.json()) as { ramadan: { dailyHours: number } }).ramadan.dailyHours).toBe(6);
    const tooMany = await postCalendar({ action: 'saveRamadan', companyId: co.A, hijriYear: 1451, startDate: '2030-01-20', endDate: '2030-02-18', dailyHours: 7 });
    expect(tooMany.status).toBe(400);

    const res = await getCalendar('?year=2030');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { companies: { id: string }[]; holidays: { companyId: string; name: string }[]; ramadanPeriods: { companyId: string }[]; rules: Record<string, number>; canManage: boolean };
    expect(body.companies.map((c) => c.id)).toEqual([co.A]);
    expect(body.holidays.map((h) => h.name).sort()).toEqual(['اليوم الوطني', 'عيد الفطر', 'يوم التأسيس'].sort());
    expect(body.holidays.every((h) => h.companyId === co.A)).toBe(true);
    expect(body.ramadanPeriods.every((r) => r.companyId === co.A)).toBe(true);
    expect(body.rules.RAMADAN_WORK_HOURS_PER_DAY_MAX).toBe(6);
    expect(body.canManage).toBe(true);
  });

  it('other company: HR of B cannot read, add, cancel or remove anything of A (403), and does not see it', async () => {
    await as('hrA');
    const h = (await (await postCalendar({ action: 'saveHoliday', companyId: co.A, name: `خاص ${tag}`, startDate: '2030-05-01' })).json()) as { holiday: { id: string } };
    await as('hrB');
    expect((await getCalendar(`?companyId=${co.A}`)).status).toBe(403);
    expect((await postCalendar({ action: 'saveHoliday', companyId: co.A, name: 'y', startDate: '2030-01-01' })).status).toBe(403);
    expect((await postCalendar({ action: 'cancelHoliday', id: h.holiday.id })).status).toBe(403);
    expect((await postCalendar({ action: 'seedOfficial', companyId: co.A, year: 2031 })).status).toBe(403);
    const list = (await (await getCalendar('?year=2030')).json()) as { holidays: { id: string }[] };
    expect(list.holidays.map((x) => x.id)).not.toContain(h.holiday.id);
    expect((await prisma.holidayCalendar.findUniqueOrThrow({ where: { id: h.holiday.id } })).cancelledAt).toBeNull();
  });

  it('work schedules: HR of A replaces and archives the patterns of its branch; HR of B gets 403 and sees none of them', async () => {
    await as('hrA');
    const put = await putSchedules({
      branchId: branch.A,
      schedules: [
        { name: 'نهاري', shiftType: 'ONE_SHIFT', startTime: '08:00', endTime: '16:00', workDays: 'الأحد, الاثنين, الثلاثاء, الأربعاء, الخميس' },
        { name: 'مسائي', shiftType: 'ONE_SHIFT', startTime: '16:00', endTime: '23:00', workDays: 'الأحد-الخميس' },
      ],
    });
    expect(put.status).toBe(200);
    const ids = ((await put.json()) as { schedules: { id: string; name: string; workWeekdays: number[] }[] }).schedules;
    expect(ids.every((s) => s.workWeekdays.join() === '0,1,2,3,4')).toBe(true);
    const listed = (await (await getSchedules(`?branchId=${branch.A}`)).json()) as { id: string }[];
    expect(listed).toHaveLength(2);

    await as('hrB');
    expect((await putSchedules({ branchId: branch.A, schedules: [] })).status).toBe(403);
    expect((await deleteSchedule(`?id=${ids[0].id}`)).status).toBe(403);
    expect((await postSchedule({ branchId: branch.A, name: 'دخيل' })).status).toBe(403);
    expect(((await (await getSchedules(`?branchId=${branch.A}`)).json()) as unknown[]).length).toBe(0);

    await as('hrA');
    expect((await deleteSchedule(`?id=${ids[0].id}`)).status).toBe(200);
    const after = await prisma.workSchedule.findUniqueOrThrow({ where: { id: ids[0].id } });
    expect(after.archivedAt).not.toBeNull(); // archived, not deleted
    expect(((await (await getSchedules(`?branchId=${branch.A}`)).json()) as unknown[]).length).toBe(1);
  });

  it('Idempotency-Key: the same POST twice creates one pattern and answers the same (replayed)', async () => {
    await as('hrA');
    const key = randomUUID();
    const body = { branchId: branch.A, name: `مكرر ${tag}`, shiftType: 'FLEXIBLE', flexibleHours: 7 };
    const first = await postSchedule(body, key);
    const second = await postSchedule(body, key);
    expect([first.status, second.status]).toEqual([201, 201]);
    const a = (await first.json()) as { schedule: { id: string } };
    const b = (await second.json()) as { schedule: { id: string } };
    expect(b.schedule.id).toBe(a.schedule.id);
    expect(await prisma.workSchedule.count({ where: { branchId: branch.A, name: body.name } })).toBe(1);
  });
});
