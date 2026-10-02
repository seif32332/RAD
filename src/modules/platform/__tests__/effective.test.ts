// P1-FND-EFF unit tests: the pure half of the effective-period primitive (no database).
// The database half (EXCLUDE, triggers, supersede, as-recorded reads, backfill) is effective.it.test.ts.
import { describe, expect, it } from 'vitest';
import { closePeriod, effectiveContext, NotInTransactionError, openLegacyPeriod, openPeriod, summarizeCompensation, supersedePeriod } from '@/modules/platform';
import { KIND_SPECS, kindSpec } from '../effective/kinds';
import { assertRange, assertSource, attrsToData, EffectivePeriodInputError, rangesOverlap, toDateOnly } from '../effective/shape';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe('date-only values', () => {
  it('accepts YYYY-MM-DD and UTC-midnight Dates', () => {
    expect(toDateOnly('2026-02-28').toISOString()).toBe('2026-02-28T00:00:00.000Z');
    expect(toDateOnly(d('2026-09-01')).toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('refuses impossible dates, other formats, and Dates with a time part (a Riyadh midnight would shift a day)', () => {
    expect(() => toDateOnly('2026-02-30')).toThrow(EffectivePeriodInputError);
    expect(() => toDateOnly('01/09/2026')).toThrow(EffectivePeriodInputError);
    expect(() => toDateOnly(new Date('2026-08-31T21:00:00.000Z'))).toThrow(/date-only/);
    expect(() => toDateOnly(new Date('nope'))).toThrow(EffectivePeriodInputError);
  });

  it('validTo is exclusive and after validFrom', () => {
    expect(() => assertRange(d('2026-01-01'), d('2026-01-01'))).toThrow(/exclusive/);
    expect(() => assertRange(d('2026-01-02'), d('2026-01-01'))).toThrow();
    expect(() => assertRange(d('2026-01-01'), d('2026-01-02'))).not.toThrow();
    expect(() => assertRange(d('2026-01-01'), null)).not.toThrow();
  });

  it('overlap of half-open ranges: adjacent periods do not overlap, open ends do', () => {
    expect(rangesOverlap(d('2026-01-01'), d('2026-02-01'), d('2026-02-01'), null)).toBe(false);
    expect(rangesOverlap(d('2026-01-01'), d('2026-02-02'), d('2026-02-01'), null)).toBe(true);
    expect(rangesOverlap(d('2026-01-01'), null, d('2030-01-01'), d('2030-02-01'))).toBe(true);
    expect(rangesOverlap(d('2026-03-01'), null, d('2026-01-01'), d('2026-03-01'))).toBe(false);
  });
});

describe('the kind registry', () => {
  it('names the owner of each table as DOMAIN_BOUNDARIES §5.2 does, and only EMPLOYMENT ends in place (ADR-0001 #9)', () => {
    expect(KIND_SPECS.EMPLOYMENT).toMatchObject({ model: 'EmploymentPeriod', owner: 'lifecycle', endInPlace: true });
    expect(KIND_SPECS.COMPENSATION).toMatchObject({ model: 'CompensationPeriod', owner: 'compensation', endInPlace: false });
    expect(KIND_SPECS.ASSIGNMENT).toMatchObject({ model: 'AssignmentPeriod', owner: 'org', endInPlace: false });
    expect(() => kindSpec('CONTRACT' as never)).toThrow(/Unknown period kind/);
  });
});

describe("the kind's own columns", () => {
  it('EMPLOYMENT has none', () => {
    expect(attrsToData('EMPLOYMENT', 'e1', {} as never)).toEqual({});
    expect(() => attrsToData('EMPLOYMENT', 'e1', { basicSalary: 1 } as never)).toThrow(/not a column/);
  });

  it('COMPENSATION: halala precision, non-negative, typed allowances; stored as 2-decimal strings', () => {
    const data = attrsToData('COMPENSATION', 'e1', {
      basicSalary: 5000.5,
      allowances: [{ name: 'بدل سكن', line: 'HOUSING', amount: 1250, countsTowardGosi: true }],
    });
    expect(data).toEqual({
      basicSalary: '5000.50',
      gosiBaseOverride: null,
      allowances: [{ name: 'بدل سكن', line: 'HOUSING', allowanceType: null, amount: 1250, countsTowardGosi: true, allowanceId: null }],
    });
    expect(() => attrsToData('COMPENSATION', 'e1', { basicSalary: 100.123, allowances: [] })).toThrow(/two decimals/);
    expect(() => attrsToData('COMPENSATION', 'e1', { basicSalary: -1, allowances: [] })).toThrow(/>= 0/);
    expect(() => attrsToData('COMPENSATION', 'e1', { basicSalary: 1, allowances: [{ name: 'x', line: 'FOOD', amount: 1, countsTowardGosi: false }] } as never)).toThrow(/line/);
    expect(() => attrsToData('COMPENSATION', 'e1', { basicSalary: 1 } as never)).toThrow(/allowances/);
  });

  it('ASSIGNMENT: the legal company is required and nobody manages themselves', () => {
    expect(attrsToData('ASSIGNMENT', 'e1', { legalCompanyId: 'c1', branchId: 'b1' })).toEqual({
      legalCompanyId: 'c1', actualCompanyId: null, branchId: 'b1', departmentId: null, managerId: null, workPatternId: null,
    });
    expect(() => attrsToData('ASSIGNMENT', 'e1', { legalCompanyId: '' })).toThrow(/legalCompanyId/);
    expect(() => attrsToData('ASSIGNMENT', 'e1', { legalCompanyId: 'c1', managerId: 'e1' })).toThrow(/own manager/);
    expect(() => attrsToData('ASSIGNMENT', 'e1', { legalCompanyId: 'c1', positionId: 'p' } as never)).toThrow(/not a column/);
  });

  it('a source is an UPPER_SNAKE decision reference, and LEGACY_OPENING is reserved to openLegacyPeriod (ARC-SYS-A3)', () => {
    expect(assertSource({ type: 'CHANGE_ORDER', id: 'x' })).toEqual({ type: 'CHANGE_ORDER', id: 'x' });
    expect(() => assertSource({ type: 'changeOrder', id: 'x' })).toThrow();
    expect(() => assertSource({ type: 'CHANGE_ORDER', id: ' ' })).toThrow();
    expect(() => assertSource({ type: 'LEGACY_OPENING', id: 'x' })).toThrow(/openLegacyPeriod/);
  });
});

describe('compensation summary', () => {
  it('totals by payslip line; the GOSI base is basic + the flagged allowances unless overridden', () => {
    const allowances = [
      { name: 'سكن', line: 'HOUSING' as const, amount: 1250, countsTowardGosi: true },
      { name: 'نقل', line: 'TRANSPORT' as const, amount: 500.1, countsTowardGosi: false },
      { name: 'جوال', line: 'OTHER' as const, amount: 100.2, countsTowardGosi: false },
      { name: 'طعام', line: 'OTHER' as const, amount: 0.1, countsTowardGosi: false },
    ];
    expect(summarizeCompensation(5000, allowances, null)).toEqual({ housing: 1250, transport: 500.1, otherAllowances: 100.3, gosiBase: 6250, gosiBaseOverridden: false });
    expect(summarizeCompensation(5000, allowances, 4000).gosiBase).toBe(4000);
  });
});

describe('writes need a transaction client', () => {
  // The root client has $transaction; the primitive refuses it (LIFECYCLE_MODEL §2.1).
  const root = { $transaction: async () => undefined } as never;
  const op = { key: 'k', actor: { type: 'SYSTEM' as const, id: 'unit' } };
  it('openPeriod, supersedePeriod, closePeriod and openLegacyPeriod refuse the root client', async () => {
    await expect(openPeriod(root, 'EMPLOYMENT', { employeeId: 'e', validFrom: '2026-01-01', source: { type: 'X', id: 'y' }, attrs: {} as never }, op)).rejects.toThrow(NotInTransactionError);
    await expect(supersedePeriod(root, 'EMPLOYMENT', 'p', { reason: 'VOID', source: { type: 'X', id: 'y' } }, op)).rejects.toThrow(NotInTransactionError);
    await expect(closePeriod(root, 'EMPLOYMENT', 'p', { validTo: '2026-02-01', source: { type: 'X', id: 'y' } }, op)).rejects.toThrow(NotInTransactionError);
    await expect(openLegacyPeriod(root, 'EMPLOYMENT', { employeeId: 'e', validFrom: '2026-01-01', attrs: {} as never }, op.actor)).rejects.toThrow(NotInTransactionError);
  });

  it('effectiveContext has no default company scope', async () => {
    await expect(effectiveContext({} as never, 'e', '2026-01-01', {} as never)).rejects.toThrow(/companyIds is required/);
  });
});
