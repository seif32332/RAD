import { describe, expect, it } from 'vitest';
import { earliestLastWorkingDay, suggestedLastWorkingDay } from '@/lib/termination';

describe('last working day of an employee request to end the contract', () => {
  const submitted = new Date('2026-09-01T20:30:00Z'); // 2026-09-01 23:30 Riyadh

  it('resignation: not before submission + 8 days (7-day withdrawal window); other types: the submission day', () => {
    expect(earliestLastWorkingDay(submitted, 'RESIGNATION')).toBe('2026-09-09');
    expect(earliestLastWorkingDay(submitted, 'MUTUAL_AGREEMENT')).toBe('2026-09-01');
    expect(earliestLastWorkingDay(new Date('2026-09-01T21:30:00Z'), 'RESIGNATION')).toBe('2026-09-10'); // already 2 Sept in Riyadh
  });

  it('suggestion: submission + notice period, raised to the earliest when the notice is shorter', () => {
    expect(suggestedLastWorkingDay(submitted, 'RESIGNATION', 30)).toBe('2026-10-01');
    expect(suggestedLastWorkingDay(submitted, 'RESIGNATION', 0)).toBe('2026-09-09');
    expect(suggestedLastWorkingDay(submitted, 'END_OF_CONTRACT', null)).toBe('2026-10-01');
  });
});
