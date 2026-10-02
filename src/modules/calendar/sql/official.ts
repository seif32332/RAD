// Reviewed raw SQL of the calendar module (ARCH-009). The list of fixed-date official holidays lives
// in migration 9z_calendar as calendar_official_fixed_holidays(year) (a legal designation belongs in
// a migration, not in code: CLAUDE.md). It reads no table, so it takes no company scope; the
// transition that uses it writes the company's own rows.
import type { TxClient } from '@/modules/platform';

/** HolidayCalendar.source of the rows generated from calendar_official_fixed_holidays. */
export const OFFICIAL_SOURCE = 'OFFICIAL_FIXED_DATE';

export interface OfficialFixedHolidayRow {
  name: string;
  /** 'YYYY-MM-DD' */
  startDate: string;
  /** 'YYYY-MM-DD', inclusive */
  endDate: string;
}

export async function officialFixedHolidays(tx: TxClient, year: number): Promise<OfficialFixedHolidayRow[]> {
  return tx.$queryRaw<OfficialFixedHolidayRow[]>`
    SELECT "name", to_char("startDate", 'YYYY-MM-DD') AS "startDate", to_char("endDate", 'YYYY-MM-DD') AS "endDate"
      FROM "calendar_official_fixed_holidays"(${year}::int)
     ORDER BY "startDate", "name"`;
}
