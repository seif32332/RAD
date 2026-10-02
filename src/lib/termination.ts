// Last working day rules of an employee's own request to end the contract (resignation, mutual
// agreement, non-renewal), applied when HR approves it (src/app/api/incoming-requests).
import { catalogueValueAt } from '@/modules/rules';

/** A resignation may be withdrawn within this many days of its submission (owner decision 2026-09-26). */
export const RESIGNATION_WITHDRAWAL_DAYS = 7;

const riyadhDay = (d: Date, plusDays = 0) => new Date(d.getTime() + 3 * 3600e3 + plusDays * 86400e3).toISOString().slice(0, 10);

/**
 * Earliest allowed last working day (YYYY-MM-DD, Riyadh): the submission day, and for a resignation
 * the day after its withdrawal window (submission + 8 days), so the exit never happens while the
 * employee can still withdraw.
 */
export function earliestLastWorkingDay(submittedAt: Date, terminationType: string): string {
  return riyadhDay(submittedAt, terminationType === 'RESIGNATION' ? RESIGNATION_WITHDRAWAL_DAYS + 1 : 0);
}

/**
 * Suggested last working day: submission + the employee's notice period, never before the earliest.
 * Without a contractual notice period, the worker's statutory notice (art. 75, NOTICE_DAYS_EMPLOYEE:
 * pass the company's value from rules.valueAt; default: the catalogue's on the submission day).
 */
export function suggestedLastWorkingDay(submittedAt: Date, terminationType: string, noticePeriodDays: number | null, statutoryNoticeDays?: number): string {
  const byNotice = riyadhDay(submittedAt, noticePeriodDays ?? statutoryNoticeDays ?? catalogueValueAt('NOTICE_DAYS_EMPLOYEE', submittedAt));
  const earliest = earliestLastWorkingDay(submittedAt, terminationType);
  return byNotice < earliest ? earliest : byNotice;
}
