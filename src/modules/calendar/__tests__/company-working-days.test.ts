// addCompanyWorkingDays (the approval engine's WorkingDaysPort, WFE-002): the company calendar's default working
// weekdays (Sunday to Thursday) and the company's non-cancelled holidays, against a fake reader (no database).
import { describe, expect, it } from 'vitest';
import { addCompanyWorkingDays } from '@/modules/calendar';

type Holiday = { startDate: Date; endDate: Date };
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);

function fakeDb(holidays: Holiday[] = []) {
  const calls: { where: Record<string, unknown> }[] = [];
  const db = {
    holidayCalendar: {
      findMany: async (args: { where: Record<string, unknown> }) => {
        calls.push(args);
        return holidays;
      },
    },
  };
  return { db: db as never, calls };
}

// 2026-10-01 is a Thursday: Friday 10-02 and Saturday 10-03 are the weekend, Sunday 10-04 the next working day.
describe('addCompanyWorkingDays: weekends', () => {
  it('zero days returns the start day itself and reads nothing', async () => {
    const { db, calls } = fakeDb();
    expect(iso(await addCompanyWorkingDays(db, 'c1', day('2026-10-01'), 0))).toBe('2026-10-01');
    expect(calls).toHaveLength(0);
  });

  it('skips Friday and Saturday: from a Thursday, +1 is the Sunday, +3 the Tuesday, +6 the next Thursday', async () => {
    const { db } = fakeDb();
    expect(iso(await addCompanyWorkingDays(db, 'c1', day('2026-10-01'), 1))).toBe('2026-10-04');
    expect(iso(await addCompanyWorkingDays(db, 'c1', day('2026-10-01'), 3))).toBe('2026-10-06');
    expect(iso(await addCompanyWorkingDays(db, 'c1', day('2026-10-01'), 6))).toBe('2026-10-11');
  });

  it('counts after the start day (exclusive): from a Sunday, +1 is the Monday', async () => {
    const { db } = fakeDb();
    expect(iso(await addCompanyWorkingDays(db, 'c1', day('2026-10-04'), 1))).toBe('2026-10-05');
  });

  it('a start on the weekend still counts the next working days (Saturday +1 is the Sunday)', async () => {
    const { db } = fakeDb();
    expect(iso(await addCompanyWorkingDays(db, 'c1', day('2026-10-03'), 1))).toBe('2026-10-04');
  });

  it('honours other default weekdays (Monday to Friday): from a Thursday, +1 is the Friday, +2 the Monday', async () => {
    const { db } = fakeDb();
    const opts = { defaultWeekdays: [1, 2, 3, 4, 5] };
    expect(iso(await addCompanyWorkingDays(db, 'c1', day('2026-10-01'), 1, opts))).toBe('2026-10-02');
    expect(iso(await addCompanyWorkingDays(db, 'c1', day('2026-10-01'), 2, opts))).toBe('2026-10-05');
  });
});

describe('addCompanyWorkingDays: holidays', () => {
  it('a one-day holiday on a working day is skipped', async () => {
    const { db } = fakeDb([{ startDate: day('2026-10-04'), endDate: day('2026-10-04') }]);
    expect(iso(await addCompanyWorkingDays(db, 'c1', day('2026-10-01'), 1))).toBe('2026-10-05');
  });

  it('a multi-day holiday (both ends inclusive) is skipped entirely', async () => {
    const { db } = fakeDb([{ startDate: day('2026-10-04'), endDate: day('2026-10-06') }]);
    expect(iso(await addCompanyWorkingDays(db, 'c1', day('2026-10-01'), 1))).toBe('2026-10-07');
    expect(iso(await addCompanyWorkingDays(db, 'c1', day('2026-10-01'), 2))).toBe('2026-10-08');
  });

  it('a holiday that falls on the weekend changes nothing', async () => {
    const { db } = fakeDb([{ startDate: day('2026-10-02'), endDate: day('2026-10-03') }]);
    expect(iso(await addCompanyWorkingDays(db, 'c1', day('2026-10-01'), 1))).toBe('2026-10-04');
  });

  it('a holiday ending on the start day does not count (the count is after the start)', async () => {
    const { db } = fakeDb([{ startDate: day('2026-09-30'), endDate: day('2026-10-01') }]);
    expect(iso(await addCompanyWorkingDays(db, 'c1', day('2026-10-01'), 1))).toBe('2026-10-04');
  });

  it('two separate holidays are both skipped', async () => {
    const { db } = fakeDb([
      { startDate: day('2026-10-04'), endDate: day('2026-10-04') },
      { startDate: day('2026-10-06'), endDate: day('2026-10-06') },
    ]);
    expect(iso(await addCompanyWorkingDays(db, 'c1', day('2026-10-01'), 3))).toBe('2026-10-08');
  });

  it('asks only for the company non-cancelled holidays', async () => {
    const { db, calls } = fakeDb();
    await addCompanyWorkingDays(db, 'company-7', day('2026-10-01'), 2);
    expect(calls).toHaveLength(1);
    expect(calls[0].where).toMatchObject({ companyId: 'company-7', cancelledAt: null });
  });
});

describe('addCompanyWorkingDays: input', () => {
  it('refuses a negative or non-integer number of days', async () => {
    const { db } = fakeDb();
    await expect(addCompanyWorkingDays(db, 'c1', day('2026-10-01'), -1)).rejects.toThrow(RangeError);
    await expect(addCompanyWorkingDays(db, 'c1', day('2026-10-01'), 1.5)).rejects.toThrow(RangeError);
  });

  it('refuses a start that is not a date-only value', async () => {
    const { db } = fakeDb();
    await expect(addCompanyWorkingDays(db, 'c1', new Date('2026-10-01T10:00:00Z'), 1)).rejects.toThrow(/date-only/);
  });

  it('a calendar with no working weekday at all is a RangeError, not an endless loop', async () => {
    const { db } = fakeDb();
    await expect(addCompanyWorkingDays(db, 'c1', day('2026-10-01'), 1, { defaultWeekdays: [] })).rejects.toThrow(RangeError);
  });
});
