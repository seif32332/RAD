import { describe, expect, it } from 'vitest';
import {
  isLegacyOvertime,
  isOvertimeUnpaid,
  legacyOvertimeDueInMonth,
  legacyOvertimeDueInSettlement,
  overtimeDueInMonth,
  overtimeDueInSettlement,
  overtimePayState,
  settlementCoversMonth,
  type FinalizedPayrollRef,
  type OvertimeHolderRef,
  type OvertimeLinkLike,
} from '@/lib/payroll-core';
import { overtimeDueInSettlement as reexported } from '@/lib/settlement';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);
const t = (s: string) => new Date(s);

/** Link columns added at this instant (rows approved before it and never linked are legacy). */
const CUTOFF = t('2030-06-01T00:00:00.000Z');
const NEW = t('2030-07-01T10:00:00.000Z'); // approval time of a post-cutoff row
const OLD = t('2030-01-10T10:00:00.000Z'); // approval time of a legacy row

const ot = (date: string, extra: Partial<OvertimeLinkLike> = {}): OvertimeLinkLike => ({
  date: d(date),
  updatedAt: NEW,
  paidInPayrollId: null,
  paidInSettlementId: null,
  ...extra,
});
const fin = (year: number, month: number, createdAt = '2030-12-31T00:00:00.000Z'): FinalizedPayrollRef => ({ year, month, createdAt: t(createdAt) });
const holders = (entries: Array<[string, OvertimeHolderRef]>) => new Map(entries);

describe('isLegacyOvertime', () => {
  it('unlinked rows approved before the cutoff are legacy, after it are not', () => {
    expect(isLegacyOvertime(ot('2030-01-05', { updatedAt: OLD }), CUTOFF)).toBe(true);
    expect(isLegacyOvertime(ot('2030-01-05', { updatedAt: NEW }), CUTOFF)).toBe(false);
  });
  it('a linked row is never legacy', () => {
    expect(isLegacyOvertime(ot('2030-01-05', { updatedAt: OLD, paidInPayrollId: 'p1' }), CUTOFF)).toBe(false);
    expect(isLegacyOvertime(ot('2030-01-05', { updatedAt: OLD, paidInSettlementId: 's1' }), CUTOFF)).toBe(false);
  });
  it('unknown cutoff (null): every unlinked row is legacy (conservative)', () => {
    expect(isLegacyOvertime(ot('2030-08-05', { updatedAt: NEW }), null)).toBe(true);
  });
});

describe('overtimeDueInMonth (payroll generation)', () => {
  const opts = { legacyCutoff: CUTOFF };

  it('pays unlinked overtime of this month and of earlier months', () => {
    expect(overtimeDueInMonth(ot('2030-08-05'), [], 2030, 8, opts)).toBe(true);
    expect(overtimeDueInMonth(ot('2030-07-20'), [fin(2030, 7)], 2030, 8, opts)).toBe(true);
  });
  it('never pays overtime of a later month', () => {
    expect(overtimeDueInMonth(ot('2030-09-01'), [], 2030, 8, opts)).toBe(false);
  });
  it('never pays overtime reserved by a settlement', () => {
    expect(overtimeDueInMonth(ot('2030-08-05', { paidInSettlementId: 's1' }), [], 2030, 8, opts)).toBe(false);
  });
  it('overtime held by another payroll row is not paid again', () => {
    expect(overtimeDueInMonth(ot('2030-08-05', { paidInPayrollId: 'p-other' }), [], 2030, 8, opts)).toBe(false);
  });
  it('regeneration: overtime held by a draft being replaced is due again', () => {
    const replacing = new Set(['p-old']);
    expect(overtimeDueInMonth(ot('2030-08-05', { paidInPayrollId: 'p-old' }), [], 2030, 8, { ...opts, replacing })).toBe(true);
    expect(overtimeDueInMonth(ot('2030-08-05', { paidInPayrollId: 'p-keep' }), [], 2030, 8, { ...opts, replacing })).toBe(false);
  });
  it('legacy unlinked row: timestamp inference (paid by a payroll generated after its approval)', () => {
    const legacy = ot('2030-01-05', { updatedAt: OLD });
    // January generated after the approval -> it paid it, February must not pay it again.
    expect(overtimeDueInMonth(legacy, [fin(2030, 1, '2030-02-01T00:00:00.000Z')], 2030, 2, opts)).toBe(false);
    // January generated before the approval -> carried over to February.
    expect(overtimeDueInMonth(legacy, [fin(2030, 1, '2030-01-05T00:00:00.000Z')], 2030, 2, opts)).toBe(true);
    expect(legacyOvertimeDueInMonth(legacy, [fin(2030, 1, '2030-01-05T00:00:00.000Z')], 2030, 2)).toBe(true);
  });
  it('a post-cutoff unlinked row ignores the timestamps (links are the only truth)', () => {
    // A finalized January generated after the approval would have marked a legacy row PAID.
    const row = ot('2030-01-05', { updatedAt: NEW });
    expect(overtimeDueInMonth(row, [fin(2030, 1, '2030-12-01T00:00:00.000Z')], 2030, 2, opts)).toBe(true);
  });
});

describe('isOvertimeUnpaid', () => {
  it('approved with both links null = unpaid', () => {
    expect(isOvertimeUnpaid(ot('2030-08-05'), [], CUTOFF)).toBe(true);
  });
  it('linked to a payroll (draft or final) or a settlement = not unpaid', () => {
    expect(isOvertimeUnpaid(ot('2030-08-05', { paidInPayrollId: 'p1' }), [], CUTOFF)).toBe(false);
    expect(isOvertimeUnpaid(ot('2030-08-05', { paidInSettlementId: 's1' }), [], CUTOFF)).toBe(false);
  });
  it('legacy rows keep the timestamp inference', () => {
    const legacy = ot('2030-01-05', { updatedAt: OLD });
    expect(isOvertimeUnpaid(legacy, [fin(2030, 1, '2030-02-01T00:00:00.000Z')], CUTOFF)).toBe(false);
    expect(isOvertimeUnpaid(legacy, [], CUTOFF)).toBe(true);
    expect(overtimePayState(legacy, [fin(2030, 2, '2030-03-01T00:00:00.000Z')])).toBe('LEGACY_UNPROCESSED');
    expect(isOvertimeUnpaid(legacy, [fin(2030, 2, '2030-03-01T00:00:00.000Z')], CUTOFF)).toBe(false);
  });
});

describe('overtimeDueInSettlement (END_OF_SERVICE)', () => {
  const last = d('2030-12-31');
  const base = { legacyCutoff: CUTOFF };

  it('is re-exported unchanged from src/lib/settlement.ts', () => {
    expect(reexported).toBe(overtimeDueInSettlement);
  });
  it('pays unlinked overtime of the last month', () => {
    expect(overtimeDueInSettlement(ot('2030-12-03'), [], last, base)).toBe(true);
  });
  it('leaves unlinked overtime of an earlier open month to payroll', () => {
    expect(overtimeDueInSettlement(ot('2030-11-03'), [], last, base)).toBe(false);
  });
  it('pays unlinked earlier overtime when every month up to the last one is finalized', () => {
    expect(overtimeDueInSettlement(ot('2030-10-03'), [fin(2030, 10), fin(2030, 11)], last, base)).toBe(true);
    expect(overtimeDueInSettlement(ot('2030-10-03'), [fin(2030, 10)], last, base)).toBe(false);
  });
  it('draft of the last month (dropped at approval) -> settlement pays; earlier draft -> payroll pays', () => {
    const h = holders([
      ['p-dec', { year: 2030, month: 12, status: 'DRAFT' }],
      ['p-nov', { year: 2030, month: 11, status: 'DRAFT' }],
      ['p-oct', { year: 2030, month: 10, status: 'APPROVED' }],
    ]);
    expect(overtimeDueInSettlement(ot('2030-12-03', { paidInPayrollId: 'p-dec' }), [], last, { ...base, holders: h })).toBe(true);
    expect(overtimeDueInSettlement(ot('2030-11-03', { paidInPayrollId: 'p-nov' }), [], last, { ...base, holders: h })).toBe(false);
    expect(overtimeDueInSettlement(ot('2030-10-03', { paidInPayrollId: 'p-oct' }), [], last, { ...base, holders: h })).toBe(false);
    // Unknown holder row: treated as paid (never pay twice).
    expect(overtimeDueInSettlement(ot('2030-12-03', { paidInPayrollId: 'gone' }), [], last, { ...base, holders: h })).toBe(false);
  });
  it('reserved by another settlement -> not due; reserved by this one -> still due (approval re-check)', () => {
    expect(overtimeDueInSettlement(ot('2030-12-03', { paidInSettlementId: 's-other' }), [], last, { ...base, settlementId: 's1' })).toBe(false);
    expect(overtimeDueInSettlement(ot('2030-12-03', { paidInSettlementId: 's1' }), [], last, { ...base, settlementId: 's1' })).toBe(true);
  });
  it('reserved by this settlement but its draft was approved meanwhile -> no longer due', () => {
    const h = holders([['p-dec', { year: 2030, month: 12, status: 'APPROVED' }]]);
    const row = ot('2030-12-03', { paidInSettlementId: 's1', paidInPayrollId: 'p-dec' });
    expect(overtimeDueInSettlement(row, [fin(2030, 12)], last, { ...base, holders: h, settlementId: 's1' })).toBe(false);
  });
  it('legacy unlinked rows use the former rule', () => {
    const legacy = ot('2030-12-03', { updatedAt: OLD });
    expect(overtimeDueInSettlement(legacy, [], last, base)).toBe(true);
    expect(legacyOvertimeDueInSettlement(legacy, [], last)).toBe(true);
    const paidLegacy = ot('2030-01-05', { updatedAt: OLD });
    expect(overtimeDueInSettlement(paidLegacy, [fin(2030, 1, '2030-02-01T00:00:00.000Z')], last, base)).toBe(false);
  });
  it('invalid dates are never due', () => {
    expect(overtimeDueInSettlement(ot('2030-12-03'), [], new Date('invalid'), base)).toBe(false);
    expect(overtimeDueInMonth({ ...ot('2030-12-03'), date: new Date('invalid') }, [], 2030, 12, base)).toBe(false);
  });
});

describe('settlementCoversMonth (stale draft check at payroll approval)', () => {
  const emp = { basicSalary: 3000, allowances: [] };
  const s = (type: string, last: string, extra: Partial<{ status: string; leaveCompensation: number }> = {}) => ({
    type,
    status: extra.status ?? 'PENDING_APPROVAL',
    lastWorkingDate: d(last),
    createdAt: t('2030-01-01T00:00:00.000Z'),
    salaryBasis: 'total',
    leaveCompensation: extra.leaveCompensation ?? 0,
  });
  it('no settlements -> false', () => {
    expect(settlementCoversMonth([], emp, 2030, 3)).toBe(false);
  });
  it('END_OF_SERVICE covers its last month and every later month, not earlier ones', () => {
    expect(settlementCoversMonth([s('END_OF_SERVICE', '2030-03-15')], emp, 2030, 3)).toBe(true);
    expect(settlementCoversMonth([s('END_OF_SERVICE', '2030-03-15')], emp, 2030, 4)).toBe(true);
    expect(settlementCoversMonth([s('END_OF_SERVICE', '2030-03-15')], emp, 2030, 2)).toBe(false);
  });
  it('LEAVE_SETTLEMENT covers the settled days (worked days of the month + compensated leave days)', () => {
    // 3000 / 30 = 100 per day; 3000 compensation = 30 leave days after 2030-03-20 -> until 2030-04-19.
    const leave = s('LEAVE_SETTLEMENT', '2030-03-20', { leaveCompensation: 3000 });
    expect(settlementCoversMonth([leave], emp, 2030, 3)).toBe(true);
    expect(settlementCoversMonth([leave], emp, 2030, 4)).toBe(true);
    expect(settlementCoversMonth([leave], emp, 2030, 5)).toBe(false);
  });
  it('rejected settlements never cover', () => {
    expect(settlementCoversMonth([s('END_OF_SERVICE', '2030-03-15', { status: 'REJECTED' })], emp, 2030, 3)).toBe(false);
  });
});
