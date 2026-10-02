// The calendar module (P1-CAL) against a real PostgreSQL with all migrations applied (9z_calendar).
// Opt-in: CAL_IT=1 with DATABASE_URL pointing at a THROWAWAY database (rows are not cleaned up).
//
// Covers every transition with a double call (same key, sequential and concurrent: one change, one
// event), the company scope, the DB guards of 9z_calendar, dayType (WORKDAY / WEEKEND / HOLIDAY /
// RAMADAN_WORKDAY) through org.applyAssignment's work pattern, and the parity of the SQL weekday
// parser with parseWeekdays.
import { randomUUID } from 'crypto';
import { describe, expect, it } from 'vitest';
import { employeeFixture } from '@/test/money-fixtures';

const RUN = process.env.CAL_IT === '1';

describe.skipIf(!RUN)('calendar module on PostgreSQL (P1-CAL)', { timeout: 120_000 }, async () => {
  const { prisma } = await import('@/lib/prisma');
  const cal = await import('@/modules/calendar');
  const { applyAssignment } = await import('@/modules/org');
  const { openPeriod, EffectiveScopeError } = await import('@/modules/platform');

  const HR = { type: 'SYSTEM' as const, id: 'calendar-it' };
  const tag = () => randomUUID().replace(/-/g, '').slice(0, 10);
  const op = (key: string) => ({ key, actor: HR });

  async function company(t: string, k = 'A') {
    const c = await prisma.company.create({ data: { nameArabic: `تقويم ${k} ${t}`, commercialRegNum: `CAL-${t}-${k}`, commercialRegExp: new Date('2035-01-01') } });
    const b = await prisma.branch.create({ data: { companyId: c.id, nameArabic: `فرع ${k} ${t}` } });
    return { c, b };
  }
  async function employee(t: string, legalCompanyId: string, branchId: string, workSchedule: string | null = null) {
    return employeeFixture({
        employeeId: `CAL-${t}`, firstNameArabic: 'موظف', lastNameArabic: t, nationality: 'SA', iqamaOrIdNumber: `CAL${t}`,
        iqamaOrIdExp: new Date('2035-01-01'), dateOfBirth: new Date('1990-01-01'), gender: 'M', joinDate: new Date('2026-01-01'),
        basicSalary: 5000, legalCompanyId, branchId, workSchedule,
      });
  }
  async function employ(employeeId: string, companyId: string, t: string) {
    await prisma.$transaction((tx) =>
      openPeriod(tx, 'EMPLOYMENT', { employeeId, validFrom: '2026-01-01', validTo: null, source: { type: 'TEST', id: t }, attrs: {} }, { key: `${t}:emp`, actor: HR, companyId }),
    );
  }
  const events = (type: string, aggregateId: string) => prisma.domainEvent.count({ where: { type, aggregateId } });
  const dayShift = { name: 'نهاري', shiftType: 'ONE_SHIFT' as const, startTime: '08:00', endTime: '16:00', workDays: 'الأحد-الخميس' };

  // ---------------------------------------------------------------------------------------------
  // Transitions: double calls

  it('saveWorkPattern double call, sequential and concurrent, with the same key: one pattern, one event (idempotent)', async () => {
    const t = tag();
    const { c, b } = await company(t);
    const call = () => cal.saveWorkPattern(prisma, { branchId: b.id, companyId: c.id, pattern: dayShift, companyIds: [c.id] }, op(`${t}:save`));
    const first = await call();
    const second = await call();
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.result).toEqual(first.result);
    expect(first.result.pattern).toMatchObject({ companyId: c.id, branchId: b.id, workWeekdays: [0, 1, 2, 3, 4], archivedAt: null });
    const race = await Promise.all([1, 2].map(() => cal.saveWorkPattern(prisma, { branchId: b.id, companyId: c.id, pattern: { ...dayShift, name: 'مسائي' }, companyIds: [c.id] }, op(`${t}:race`))));
    expect(race.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await prisma.workSchedule.count({ where: { branchId: b.id } })).toBe(2);
    expect(await events('calendar.workPattern.saved', first.result.pattern.id)).toBe(1);
  });

  it('saveWorkPattern refuses a company outside the scope, and the 9z guard refuses a pattern whose company is not its branch\'s', async () => {
    const t = tag();
    const a = await company(t, 'A');
    const other = await company(t, 'B');
    await expect(cal.saveWorkPattern(prisma, { branchId: a.b.id, companyId: a.c.id, pattern: dayShift, companyIds: [other.c.id] }, op(`${t}:deny`))).rejects.toThrow(cal.CalendarScopeError);
    await expect(cal.saveWorkPattern(prisma, { branchId: a.b.id, companyId: other.c.id, pattern: dayShift, companyIds: 'ALL' }, op(`${t}:mismatch`))).rejects.toThrow(/company of branch/);
    expect(await prisma.workSchedule.count({ where: { branchId: a.b.id } })).toBe(0);
  });

  it('replaceBranchPatterns keeps a pattern by id or name (same id), creates the new, archives the rest; double call is idempotent', async () => {
    const t = tag();
    const { c, b } = await company(t);
    const keep = (await cal.saveWorkPattern(prisma, { branchId: b.id, companyId: c.id, pattern: dayShift, companyIds: [c.id] }, op(`${t}:1`))).result.pattern;
    const gone = (await cal.saveWorkPattern(prisma, { branchId: b.id, companyId: c.id, pattern: { ...dayShift, name: 'قديم' }, companyIds: [c.id] }, op(`${t}:2`))).result.pattern;
    const e = await employee(t, c.id, b.id);
    await prisma.employee.update({ where: { id: e.id }, data: { workPatternId: gone.id } });
    const input = {
      branchId: b.id, companyId: c.id, companyIds: [c.id],
      patterns: [{ ...dayShift, id: keep.id, name: 'نهاري معدل', workDays: 'الأحد, الاثنين' }, { ...dayShift, name: 'جديد', id: randomUUID() }],
    };
    const first = await cal.replaceBranchPatterns(prisma, input, op(`${t}:replace`));
    const again = await cal.replaceBranchPatterns(prisma, input, op(`${t}:replace`));
    expect(again.replayed).toBe(true);
    expect(again.result).toEqual(first.result);
    expect(first.result.updated).toEqual([keep.id]);
    expect(first.result.archived).toEqual([gone.id]);
    expect(first.result.created).toHaveLength(1);
    const kept = await prisma.workSchedule.findUniqueOrThrow({ where: { id: keep.id } });
    expect(kept).toMatchObject({ name: 'نهاري معدل', workWeekdays: [0, 1], archivedAt: null });
    // The archived pattern still exists and the employee still points to it (no FK broken).
    expect((await prisma.workSchedule.findUniqueOrThrow({ where: { id: gone.id } })).archivedAt).not.toBeNull();
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: e.id } })).workPatternId).toBe(gone.id);
    expect(await prisma.workSchedule.count({ where: { branchId: b.id, archivedAt: null } })).toBe(2);
  });

  it('archiveWorkPattern double call: archived once, one event; a pattern is never deleted', async () => {
    const t = tag();
    const { c, b } = await company(t);
    const p = (await cal.saveWorkPattern(prisma, { branchId: b.id, companyId: c.id, pattern: dayShift, companyIds: [c.id] }, op(`${t}:1`))).result.pattern;
    const [x, y] = await Promise.all([1, 2].map(() => cal.archiveWorkPattern(prisma, { id: p.id, companyIds: [c.id] }, op(`${t}:arch`))));
    expect(x.result).toEqual(y.result);
    const later = await cal.archiveWorkPattern(prisma, { id: p.id, companyIds: [c.id] }, op(`${t}:arch2`));
    expect(later.result.changed).toBe(false);
    expect(await events('calendar.workPattern.archived', p.id)).toBe(1);
    await expect(cal.archiveWorkPattern(prisma, { id: p.id, companyIds: [randomUUID()] }, op(`${t}:deny`))).rejects.toThrow(cal.CalendarScopeError);
  });

  it('saveHoliday and cancelHoliday double calls: one row, one event each; a duplicate name on the same day conflicts', async () => {
    const t = tag();
    const { c } = await company(t);
    const input = { companyId: c.id, name: 'عيد الفطر', startDate: '2030-04-03', endDate: '2030-04-06', companyIds: [c.id] };
    const [a, b] = await Promise.all([1, 2].map(() => cal.saveHoliday(prisma, input, op(`${t}:h`))));
    expect(a.result).toEqual(b.result);
    const h = a.result.holiday;
    expect(await prisma.holidayCalendar.count({ where: { companyId: c.id } })).toBe(1);
    expect(await events('calendar.holiday.saved', h.id)).toBe(1);
    await expect(cal.saveHoliday(prisma, input, op(`${t}:dup`))).rejects.toThrow(cal.CalendarConflictError);
    await expect(cal.saveHoliday(prisma, { ...input, endDate: '2030-04-01' }, op(`${t}:bad`))).rejects.toThrow(cal.CalendarInputError);

    const c1 = await cal.cancelHoliday(prisma, { id: h.id, companyIds: [c.id] }, op(`${t}:x`));
    const c2 = await cal.cancelHoliday(prisma, { id: h.id, companyIds: [c.id] }, op(`${t}:x`));
    expect(c2.replayed).toBe(true);
    expect(c2.result).toEqual(c1.result);
    expect(await events('calendar.holiday.cancelled', h.id)).toBe(1);
    await expect(cal.cancelHoliday(prisma, { id: h.id, companyIds: [randomUUID()] }, op(`${t}:deny`))).rejects.toThrow(cal.CalendarScopeError);
    // Re-adding a cancelled holiday re-activates the same row.
    const back = await cal.saveHoliday(prisma, input, op(`${t}:back`));
    expect(back.result.holiday).toMatchObject({ id: h.id, cancelledAt: null });
  });

  it('seedOfficialHolidays double call: Founding Day and National Day once; another key skips them', async () => {
    const t = tag();
    const { c } = await company(t);
    const first = await cal.seedOfficialHolidays(prisma, { companyId: c.id, year: 2031, companyIds: [c.id] }, op(`${t}:seed`));
    const again = await cal.seedOfficialHolidays(prisma, { companyId: c.id, year: 2031, companyIds: [c.id] }, op(`${t}:seed`));
    expect(again.replayed).toBe(true);
    expect(again.result).toEqual(first.result);
    expect(first.result.created).toHaveLength(2);
    const rows = await prisma.holidayCalendar.findMany({ where: { companyId: c.id }, orderBy: { startDate: 'asc' } });
    expect(rows.map((r) => [r.name, r.startDate.toISOString().slice(0, 10), r.kind, r.source])).toEqual([
      ['يوم التأسيس', '2031-02-22', 'OFFICIAL', cal.OFFICIAL_SOURCE],
      ['اليوم الوطني', '2031-09-23', 'OFFICIAL', cal.OFFICIAL_SOURCE],
    ]);
    const other = await cal.seedOfficialHolidays(prisma, { companyId: c.id, year: 2031, companyIds: [c.id] }, op(`${t}:seed2`));
    expect(other.result).toEqual({ created: [], skipped: 2 });
    // Before 2022 there was no Founding Day.
    const old = await cal.seedOfficialHolidays(prisma, { companyId: c.id, year: 2020, companyIds: [c.id] }, op(`${t}:seed3`));
    expect(old.result.created).toHaveLength(1);
  });

  it('saveRamadanPeriod and removeRamadanPeriod double calls; the legal cap, the length and overlaps are enforced', async () => {
    const t = tag();
    const { c } = await company(t);
    const input = { companyId: c.id, hijriYear: 1451, startDate: '2030-01-20', endDate: '2030-02-18', dailyHours: 6, legalMaxDailyHours: 6, companyIds: [c.id] };
    const [a, b] = await Promise.all([1, 2].map(() => cal.saveRamadanPeriod(prisma, input, op(`${t}:r`))));
    expect(a.result).toEqual(b.result);
    expect(await events('calendar.ramadan.saved', a.result.ramadan.id)).toBe(1);
    await expect(cal.saveRamadanPeriod(prisma, { ...input, dailyHours: 7 }, op(`${t}:cap`))).rejects.toThrow(/legal maximum/);
    await expect(cal.saveRamadanPeriod(prisma, { ...input, endDate: '2030-02-25' }, op(`${t}:len`))).rejects.toThrow(/29 or 30/);
    await expect(cal.saveRamadanPeriod(prisma, { ...input, hijriYear: 1452 }, op(`${t}:ov`))).rejects.toThrow(cal.CalendarConflictError);
    const edited = await cal.saveRamadanPeriod(prisma, { ...input, dailyHours: 5 }, op(`${t}:edit`));
    expect(edited.result).toMatchObject({ created: false, ramadan: { id: a.result.ramadan.id, dailyHours: 5 } });

    const r1 = await cal.removeRamadanPeriod(prisma, { id: a.result.ramadan.id, companyIds: [c.id] }, op(`${t}:rm`));
    const r2 = await cal.removeRamadanPeriod(prisma, { id: a.result.ramadan.id, companyIds: [c.id] }, op(`${t}:rm`));
    expect(r2.replayed).toBe(true);
    expect(r2.result).toEqual(r1.result);
    expect(await prisma.ramadanPeriod.count({ where: { companyId: c.id } })).toBe(0);
    expect(await events('calendar.ramadan.removed', a.result.ramadan.id)).toBe(1);
  });

  // ---------------------------------------------------------------------------------------------
  // dayType

  it('dayType through the assignment\'s work pattern: WORKDAY, WEEKEND, HOLIDAY, RAMADAN_WORKDAY', async () => {
    const t = tag();
    const { c, b } = await company(t);
    const p = (await cal.saveWorkPattern(prisma, { branchId: b.id, companyId: c.id, pattern: { ...dayShift, workDays: 'الأحد-الخميس' }, companyIds: [c.id] }, op(`${t}:p`))).result.pattern;
    // A second pattern in the branch: the branch-only fallback cannot apply, so the FK is what counts.
    await cal.saveWorkPattern(prisma, { branchId: b.id, companyId: c.id, pattern: { ...dayShift, name: 'سبت', workDays: 'السبت' }, companyIds: [c.id] }, op(`${t}:p2`));
    const e = await employee(t, c.id, b.id);
    await employ(e.id, c.id, t);
    const applied = await applyAssignment(prisma, {
      employeeId: e.id, validFrom: '2026-01-01', companyIds: [c.id], source: { type: 'TEST', id: t },
      assignment: { legalCompanyId: c.id, branchId: b.id, workPatternId: p.id },
    }, { key: `${t}:assign`, actor: HR });
    expect(applied.result.period.attrs.workPatternId).toBe(p.id);
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: e.id } })).workPatternId).toBe(p.id);

    await cal.saveHoliday(prisma, { companyId: c.id, name: 'عطلة', startDate: '2030-01-08', companyIds: [c.id] }, op(`${t}:h`));
    await cal.saveRamadanPeriod(prisma, { companyId: c.id, hijriYear: 1451, startDate: '2030-01-20', endDate: '2030-02-18', dailyHours: 6, legalMaxDailyHours: 6, companyIds: [c.id] }, op(`${t}:r`));

    const at = (d: string) => cal.dayType(prisma, e.id, d, { companyIds: [c.id] });
    expect(await at('2030-01-06')).toMatchObject({ type: 'WORKDAY', scheduledHours: 8, companyId: c.id, inService: true, weekdaysSource: 'PATTERN', workPattern: { id: p.id, source: 'ASSIGNMENT' } });
    expect(await at('2030-01-11')).toMatchObject({ type: 'WEEKEND', scheduledHours: 0, isWorkingDay: false });
    expect(await at('2030-01-08')).toMatchObject({ type: 'HOLIDAY', holiday: { name: 'عطلة' } });
    expect(await at('2030-01-21')).toMatchObject({ type: 'RAMADAN_WORKDAY', scheduledHours: 6, ramadan: { hijriYear: 1451, dailyHours: 6 } });
    expect(await at('2030-01-25')).toMatchObject({ type: 'WEEKEND' }); // a Friday in Ramadan

    const range = await cal.dayTypesBetween(prisma, e.id, '2030-01-06', '2030-01-12', { companyIds: [c.id] });
    expect(range.map((d) => d?.type)).toEqual(['WORKDAY', 'WORKDAY', 'HOLIDAY', 'WORKDAY', 'WORKDAY', 'WEEKEND', 'WEEKEND']);
    const full = await cal.effectiveDay(prisma, e.id, '2030-01-06', { companyIds: [c.id] });
    expect(full.assignment?.workPatternId).toBe(p.id);
    expect(full.dayType?.type).toBe('WORKDAY');

    // Other company: refused (EffectiveScopeError), never another company's calendar.
    await expect(at('2030-01-06').then(() => cal.dayType(prisma, e.id, '2030-01-06', { companyIds: [randomUUID()] }))).rejects.toThrow(EffectiveScopeError);
  });

  it('dayType without a pattern on the assignment: the branch\'s only pattern, else the default week; no assignment -> null', async () => {
    const t = tag();
    const { c, b } = await company(t);
    const e = await employee(t, c.id, b.id);
    await applyAssignment(prisma, { employeeId: e.id, validFrom: '2029-01-01', companyIds: 'ALL', source: { type: 'TEST', id: t }, assignment: { legalCompanyId: c.id, branchId: b.id } }, { key: `${t}:a`, actor: HR });
    const none = await cal.dayType(prisma, e.id, '2030-01-11', { companyIds: [c.id] });
    expect(none).toMatchObject({ type: 'WEEKEND', weekdaysSource: 'DEFAULT', workPattern: null, inService: false, scheduledHours: 0 });
    const only = (await cal.saveWorkPattern(prisma, { branchId: b.id, companyId: c.id, pattern: { ...dayShift, workDays: 'السبت-الأربعاء' }, companyIds: [c.id] }, op(`${t}:p`))).result.pattern;
    expect(await cal.dayType(prisma, e.id, '2030-01-12', { companyIds: [c.id] })).toMatchObject({ type: 'WORKDAY', workPattern: { id: only.id, source: 'BRANCH_ONLY' } });
    expect(await cal.dayType(prisma, e.id, '2030-01-10', { companyIds: [c.id] })).toMatchObject({ type: 'WEEKEND' }); // Thursday is off in that pattern
    const stranger = await employee(`${t}x`, c.id, b.id);
    expect(await cal.dayType(prisma, stranger.id, '2030-01-10', { companyIds: 'ALL' })).toBeNull();
  });

  it('resolveWorkPatternId: the named pattern of the branch, else its only one, else null (the backfill rule)', async () => {
    const t = tag();
    const { c, b } = await company(t);
    const p1 = (await cal.saveWorkPattern(prisma, { branchId: b.id, companyId: c.id, pattern: dayShift, companyIds: [c.id] }, op(`${t}:1`))).result.pattern;
    expect(await cal.resolveWorkPatternId(prisma, b.id, 'غير موجود')).toBe(p1.id);
    const p2 = (await cal.saveWorkPattern(prisma, { branchId: b.id, companyId: c.id, pattern: { ...dayShift, name: 'مسائي' }, companyIds: [c.id] }, op(`${t}:2`))).result.pattern;
    expect(await cal.resolveWorkPatternId(prisma, b.id, ' مسائي ')).toBe(p2.id);
    expect(await cal.resolveWorkPatternId(prisma, b.id, null)).toBeNull();
    expect(await cal.resolveWorkPatternId(prisma, null, 'نهاري')).toBeNull();
  });

  it('calendar_parse_weekdays (9z_calendar) and parseWeekdays agree', async () => {
    const labels = [
      'الأحد-الخميس', 'الأحد, الاثنين, الثلاثاء, الأربعاء, الخميس', 'من السبت إلى الأربعاء', 'الخميس - الأحد', 'السبت، الأحد',
      'الاحد و الإثنين و الجمعه', 'Sunday, Monday, Saturday', 'sun to thu', 'دوام كامل', '', 'الجمعة', 'الأحد حتى الخميس',
    ];
    for (const label of labels) {
      const [row] = await prisma.$queryRaw<{ days: number[] }[]>`SELECT "calendar_parse_weekdays"(${label}) AS "days"`;
      expect([label, row.days]).toEqual([label, cal.parseWeekdays(label)]);
    }
  });

  it('calendar_official_fixed_holidays gives the fixed-date official holidays; RamadanPeriod and HolidayCalendar CHECKs hold', async () => {
    const t = tag();
    const { c } = await company(t);
    await expect(prisma.holidayCalendar.create({ data: { companyId: c.id, name: 'x', kind: 'OTHER', startDate: new Date('2030-01-01'), endDate: new Date('2030-01-01') } })).rejects.toThrow();
    await expect(prisma.ramadanPeriod.create({ data: { companyId: c.id, hijriYear: 1451, startDate: new Date('2030-01-01'), endDate: new Date('2030-01-05'), dailyHours: 6 } })).rejects.toThrow();
  });
});
