import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({ prisma: {} }));
import {
  collectReportPages,
  computeResidentDiff,
  fieldDiffs,
  isNameMismatch,
  isSyncField,
  MUQEEM_OPERATION_LABELS,
  muqeemDependentsCount,
  normalizeOccupation,
  SYNC_FIELDS,
  namesLooselyMatch,
  normalizeIqamaNumber,
  normalizePassportNumber,
  normalizePersonName,
  planEmployeeUpdate,
  type SyncEmployee,
  type SyncResident,
} from '@/lib/muqeem-sync';

const utc = (s: string) => new Date(`${s}T00:00:00.000Z`);
const CO = 'company-1';

function emp(over: Partial<SyncEmployee> = {}): SyncEmployee {
  return {
    id: 'e1',
    employeeCode: 'EMP-1',
    nameArabic: 'محمد خان',
    nameEnglish: 'Mohammed Khan',
    nationality: 'باكستاني',
    iqamaOrIdNumber: '2400000001',
    iqamaOrIdExp: utc('2027-03-15'),
    passportNumber: 'AB1234567',
    passportExp: utc('2029-01-10'),
    occupationName: 'محاسب',
    dependentsCount: null,
    isTerminated: false,
    legalCompanyId: CO,
    ...over,
  };
}

function res(over: Partial<SyncResident> = {}): SyncResident {
  return {
    iqamaNumber: '2400000001',
    name: 'محمد عبدالله خان',
    translatedName: 'MOHAMMED ABDULLAH KHAN',
    nationality: 'باكستان',
    occupation: 'محاسب',
    iqamaExpiry: utc('2027-03-15'),
    passportNumber: 'AB1234567',
    passportExpiry: utc('2029-01-10'),
    dependentsCount: null,
    ...over,
  };
}

describe('normalization', () => {
  it('iqama numbers: Arabic-Indic digits, spaces, dashes', () => {
    expect(normalizeIqamaNumber('٢٤٠٠٠٠٠٠٠١')).toBe('2400000001');
    expect(normalizeIqamaNumber(' 2400-000 001 ')).toBe('2400000001');
    expect(normalizeIqamaNumber(2400000001)).toBe('2400000001');
    expect(normalizeIqamaNumber('')).toBeNull();
    expect(normalizeIqamaNumber('24A')).toBeNull();
    expect(normalizeIqamaNumber(null)).toBeNull();
  });

  it('passport numbers compare case/space-insensitively', () => {
    expect(normalizePassportNumber(' ab 123-4567 ')).toBe('AB1234567');
    expect(normalizePassportNumber('')).toBeNull();
  });

  it('names: hamza / taa marbuta / diacritics / case', () => {
    expect(normalizePersonName('أحمد  محمودٌ السيدة')).toBe(normalizePersonName('احمد محمود السيده'));
    expect(normalizePersonName('JOSE Santos')).toBe('jose santos');
    expect(namesLooselyMatch('محمد خان', 'محمد عبدالله خان')).toBe(true); // first + last
    expect(namesLooselyMatch('محمد خان', 'أحمد خان')).toBe(false);
    expect(namesLooselyMatch('', 'x')).toBe(true);
  });

  it('isSyncField', () => {
    expect(isSyncField('passportExp')).toBe(true);
    expect(isSyncField('basicSalary')).toBe(false);
    expect(isSyncField('occupationName')).toBe(true);
    expect(isSyncField('dependentsCount')).toBe(true);
    expect([...SYNC_FIELDS]).toEqual(['iqamaOrIdExp', 'passportNumber', 'passportExp', 'occupationName', 'dependentsCount']);
  });

  it('every Muqeem operation has an Arabic label', async () => {
    const { MUQEEM_OPERATIONS } = await import('@/lib/muqeem/transactions');
    const ops: string[] = [...MUQEEM_OPERATIONS];
    for (const op of ops) expect(MUQEEM_OPERATION_LABELS[op], op).toMatch(/[؀-ۿ]/);
    expect(Object.keys(MUQEEM_OPERATION_LABELS).sort()).toEqual([...ops].sort());
  });
});

describe('fieldDiffs / isNameMismatch', () => {
  it('no differences when equal (dates by calendar day, passport normalized)', () => {
    expect(fieldDiffs(emp({ passportNumber: 'ab1234567' }), res())).toEqual([]);
  });

  it('reports each differing field with display values', () => {
    const d = fieldDiffs(emp({ iqamaOrIdExp: utc('2026-01-01'), passportNumber: null, passportExp: null }), res());
    expect(d.map((x) => [x.field, x.radeef, x.muqeem])).toEqual([
      ['iqamaOrIdExp', '2026-01-01', '2027-03-15'],
      ['passportNumber', null, 'AB1234567'],
      ['passportExp', null, '2029-01-10'],
    ]);
  });

  it('a missing Muqeem value is never a difference', () => {
    expect(fieldDiffs(emp(), res({ passportNumber: null, passportExpiry: null, iqamaExpiry: null }))).toEqual([]);
  });

  it('name mismatch only when neither Arabic nor English matches', () => {
    expect(isNameMismatch(emp(), res())).toBe(false);
    expect(isNameMismatch(emp({ nameArabic: 'علي حسن' }), res())).toBe(false); // English still matches
    expect(isNameMismatch(emp({ nameArabic: 'علي حسن', nameEnglish: 'Ali Hassan' }), res())).toBe(true);
    expect(isNameMismatch(emp({ nameArabic: 'علي حسن', nameEnglish: null }), res({ name: null }))).toBe(false); // nothing comparable
  });
});

describe('computeResidentDiff', () => {
  const residents: SyncResident[] = [
    res(), // matched
    res({ iqamaNumber: '2400000002', name: 'راجيش كومار', translatedName: 'RAJESH KUMAR', passportNumber: 'Z9876543' }), // mismatched passport
    res({ iqamaNumber: '2400000003', name: 'أحمد السيد', translatedName: null }), // only in Muqeem (unknown)
    res({ iqamaNumber: '2400000004', name: 'خوسيه' }), // terminated in Radeef
    res({ iqamaNumber: '2400000005', name: 'عبدالرحمن' }), // other company
    res({ iqamaNumber: '2400000006', name: 'سعودي' }), // Saudi in Radeef
    res({ iqamaNumber: '٢٤٠٠٠٠٠٠٠٧', name: 'علي حسن', translatedName: 'ALI HASSAN' }), // name mismatch only
    res(), // duplicate row
  ];
  const employees: SyncEmployee[] = [
    emp(),
    emp({ id: 'e2', employeeCode: 'EMP-2', nameArabic: 'راجيش كومار', nameEnglish: 'Rajesh Kumar', iqamaOrIdNumber: '2400000002', passportNumber: 'OLD111' }),
    emp({ id: 'e4', iqamaOrIdNumber: '2400000004', isTerminated: true }),
    emp({ id: 'e5', iqamaOrIdNumber: '2400000005', legalCompanyId: 'other' }),
    emp({ id: 'e6', iqamaOrIdNumber: '2400000006', nationality: 'سعودي' }),
    emp({ id: 'e7', nameArabic: 'عمر فاروق', nameEnglish: 'Omar Farooq', iqamaOrIdNumber: '2400000007' }),
    emp({ id: 'e8', employeeCode: 'EMP-8', nameArabic: 'بيتر بول', iqamaOrIdNumber: '2400000008' }), // only in Radeef
    emp({ id: 'e9', nationality: 'SAUDI', iqamaOrIdNumber: '1000000009' }), // Saudi, skipped
    emp({ id: 'e10', iqamaOrIdNumber: '2400000010', isTerminated: true }), // terminated, not in Muqeem: ignored
  ];
  const d = computeResidentDiff(CO, residents, employees);

  it('categorizes every resident and employee', () => {
    expect(d.counts).toEqual({
      residents: 7,
      radeefResidents: 4, // e1, e2, e7, e8 (e6 Saudi and e9 Saudi skipped, e4/e10 terminated, e5 other company)
      mismatched: 2,
      onlyInMuqeem: 4,
      onlyInRadeef: 1,
      matched: 1,
      skippedSaudi: 2,
      duplicateResidents: 1,
    });
  });

  it('(a) mismatched rows carry applicable diffs and name info', () => {
    const e2 = d.mismatched.find((m) => m.employeeId === 'e2');
    expect(e2?.diffs.map((x) => x.field)).toEqual(['passportNumber']);
    expect(e2?.nameMismatch).toBe(false);
    const e7 = d.mismatched.find((m) => m.employeeId === 'e7');
    expect(e7?.diffs).toEqual([]);
    expect(e7?.nameMismatch).toBe(true);
    expect(e7?.iqamaNumber).toBe('2400000007');
  });

  it('(b) only in Muqeem with hints', () => {
    const hints = Object.fromEntries(d.onlyInMuqeem.map((r) => [r.iqamaNumber, r.hint]));
    expect(hints).toEqual({
      '2400000003': null,
      '2400000004': 'TERMINATED_IN_RADEEF',
      '2400000005': 'OTHER_COMPANY',
      '2400000006': 'SAUDI_IN_RADEEF',
    });
    expect(d.onlyInMuqeem.find((r) => r.iqamaNumber === '2400000004')?.employee?.id).toBe('e4');
    expect(d.onlyInMuqeem.find((r) => r.iqamaNumber === '2400000003')?.iqamaExpiry).toBe('2027-03-15');
  });

  it('(c) only in Radeef: active non-Saudi employees of the company only', () => {
    expect(d.onlyInRadeef.map((r) => r.employeeId)).toEqual(['e8']);
  });

  it('prefers the employee of this company when an iqama is duplicated across companies', () => {
    const dd = computeResidentDiff(CO, [res()], [emp({ id: 'x', legalCompanyId: 'other' }), emp()]);
    expect(dd.counts.matched).toBe(1);
    expect(dd.onlyInMuqeem).toEqual([]);
  });

  it('empty report: every active resident employee is only in Radeef', () => {
    const dd = computeResidentDiff(CO, [], [emp(), emp({ id: 'e6', iqamaOrIdNumber: '1', nationality: 'سعودية' })]);
    expect(dd.onlyInRadeef.map((r) => r.employeeId)).toEqual(['e1']);
    expect(dd.counts.skippedSaudi).toBe(1);
  });
});

describe('planEmployeeUpdate', () => {
  it('applies only the selected fields that differ, with Muqeem values', () => {
    const e = emp({ iqamaOrIdExp: utc('2026-01-01'), passportNumber: 'old', passportExp: utc('2020-01-01') });
    const plan = planEmployeeUpdate(e, res({ passportNumber: ' ab1234567 ' }), ['passportNumber', 'iqamaOrIdExp']);
    expect(plan.data).toEqual({ iqamaOrIdExp: utc('2027-03-15'), passportNumber: 'AB1234567' });
    expect(plan.changes).toEqual([
      { field: 'iqamaOrIdExp', before: '2026-01-01', after: '2027-03-15' },
      { field: 'passportNumber', before: 'old', after: 'AB1234567' },
    ]);
    expect(plan.data).not.toHaveProperty('passportExp');
  });

  it('reports unchanged fields (same value / no Muqeem value): nothing to write', () => {
    const plan = planEmployeeUpdate(emp(), res({ passportExpiry: null }), ['iqamaOrIdExp', 'passportExp']);
    expect(plan.data).toEqual({});
    expect(plan.changes).toEqual([]);
    expect(plan.unchanged).toEqual([
      { field: 'iqamaOrIdExp', reason: 'SAME_VALUE' },
      { field: 'passportExp', reason: 'NO_MUQEEM_VALUE' },
    ]);
  });

  it('is idempotent: planning again after applying yields no change', () => {
    const e = emp({ passportExp: utc('2020-01-01') });
    const first = planEmployeeUpdate(e, res(), ['passportExp']);
    const second = planEmployeeUpdate({ ...e, ...first.data }, res(), ['passportExp']);
    expect(first.changes).toHaveLength(1);
    expect(second.changes).toEqual([]);
  });
});

describe('collectReportPages', () => {
  const makeRows = (n: number, offset = 0) => Array.from({ length: n }, (_, i) => ({ id: String(offset + i) }));

  it('reads until a short page', async () => {
    const calls: number[] = [];
    const r = await collectReportPages(
      async (page, size) => {
        calls.push(page);
        const rows = page < 2 ? makeRows(size, page * size) : makeRows(3, page * size);
        return { rows, rawCount: rows.length, total: null };
      },
      { pageSize: 10, cap: 1000, keyOf: (x) => x.id },
    );
    expect(calls).toEqual([0, 1, 2]);
    expect(r.rows).toHaveLength(23);
    expect(r.truncated).toBe(false);
  });

  it('stops at the announced total without an extra call', async () => {
    const calls: number[] = [];
    const r = await collectReportPages(
      async (page, size) => {
        calls.push(page);
        return { rows: makeRows(size, page * size), rawCount: size, total: 20 };
      },
      { pageSize: 10, cap: 1000 },
    );
    expect(calls).toEqual([0, 1]);
    expect(r.rows).toHaveLength(20);
    expect(r.total).toBe(20);
  });

  it('caps and flags truncation', async () => {
    const r = await collectReportPages(async (page, size) => ({ rows: makeRows(size, page * size), rawCount: size, total: 100 }), { pageSize: 10, cap: 25 });
    expect(r.rows).toHaveLength(25);
    expect(r.truncated).toBe(true);
  });

  it('stops when the server ignores the page parameter', async () => {
    const r = await collectReportPages(async (_page, size) => ({ rows: makeRows(size), rawCount: size, total: null }), { pageSize: 10, cap: 1000, keyOf: (x) => x.id });
    expect(r.rows).toHaveLength(10);
    expect(r.pages).toBe(2);
  });

  it('counts raw rows (rows dropped by normalization do not end pagination early)', async () => {
    const calls: number[] = [];
    await collectReportPages(
      async (page, size) => {
        calls.push(page);
        return page === 0 ? { rows: makeRows(size - 1), rawCount: size, total: null } : { rows: [], rawCount: 0, total: null };
      },
      { pageSize: 10, cap: 1000 },
    );
    expect(calls).toEqual([0, 1]);
  });
});

describe('occupation and dependents count (workforce engine data)', () => {
  it('occupation compares after Arabic / spacing normalization; a missing Muqeem value is not a difference', () => {
    expect(normalizeOccupation(' فنّي  كهرباء ')).toBe(normalizeOccupation('فني كهرباء'));
    expect(fieldDiffs(emp({ occupationName: 'محاسب ' }), res())).toEqual([]);
    expect(fieldDiffs(emp({ occupationName: 'محاسب' }), res({ occupation: null }))).toEqual([]);
    expect(fieldDiffs(emp({ occupationName: null }), res(), ['occupationName'])).toEqual([
      { field: 'occupationName', label: 'المهنة', radeef: null, muqeem: 'محاسب' },
    ]);
    expect(fieldDiffs(emp({ occupationName: 'سائق' }), res({ occupation: '  فني   كهرباء ' }), ['occupationName'])[0]).toMatchObject({ radeef: 'سائق', muqeem: 'فني كهرباء' });
  });

  it('dependents count: 0 is a value, null / implausible counts are not', () => {
    expect(muqeemDependentsCount({ dependentsCount: 0 })).toBe(0);
    expect(muqeemDependentsCount({ dependentsCount: 3 })).toBe(3);
    expect(muqeemDependentsCount({ dependentsCount: null })).toBeNull();
    expect(muqeemDependentsCount({ dependentsCount: -1 })).toBeNull();
    expect(muqeemDependentsCount({ dependentsCount: 2.5 })).toBeNull();
    expect(muqeemDependentsCount({ dependentsCount: 31 })).toBeNull();
    expect(fieldDiffs(emp({ dependentsCount: null }), res({ dependentsCount: 0 }), ['dependentsCount'])).toEqual([
      { field: 'dependentsCount', label: 'عدد المرافقين', radeef: null, muqeem: '0' },
    ]);
    expect(fieldDiffs(emp({ dependentsCount: 2 }), res({ dependentsCount: 2 }))).toEqual([]);
    expect(fieldDiffs(emp({ dependentsCount: 2 }), res({ dependentsCount: null }))).toEqual([]);
    expect(fieldDiffs(emp({ dependentsCount: 2 }), res({ dependentsCount: 99 }))).toEqual([]);
  });

  it('computeResidentDiff lists the new fields as applicable diffs', () => {
    const d = computeResidentDiff(CO, [res({ occupation: 'مهندس', dependentsCount: 2 })], [emp()]);
    expect(d.counts.mismatched).toBe(1);
    expect(d.mismatched[0].diffs.map((x) => [x.field, x.radeef, x.muqeem])).toEqual([
      ['occupationName', 'محاسب', 'مهندس'],
      ['dependentsCount', null, '2'],
    ]);
  });

  it('planEmployeeUpdate writes only the selected new fields, with Muqeem values', () => {
    const e = emp({ occupationName: null, dependentsCount: 1 });
    const r = res({ occupation: ' مهندس  مدني ', dependentsCount: 3 });
    const onlyOccupation = planEmployeeUpdate(e, r, ['occupationName']);
    expect(onlyOccupation.data).toEqual({ occupationName: 'مهندس مدني' });
    expect(onlyOccupation.changes).toEqual([{ field: 'occupationName', before: null, after: 'مهندس مدني' }]);

    const both = planEmployeeUpdate(e, r, ['dependentsCount', 'occupationName']);
    expect(both.data).toEqual({ occupationName: 'مهندس مدني', dependentsCount: 3 });
    expect(both.changes.map((c) => c.field)).toEqual(['occupationName', 'dependentsCount']);

    // Idempotent once applied.
    expect(planEmployeeUpdate({ ...e, ...both.data }, r, ['dependentsCount', 'occupationName']).changes).toEqual([]);
  });

  it('reports unchanged new fields with the reason', () => {
    const plan = planEmployeeUpdate(emp({ dependentsCount: 0 }), res({ occupation: null, dependentsCount: 0 }), ['occupationName', 'dependentsCount']);
    expect(plan.data).toEqual({});
    expect(plan.unchanged).toEqual([
      { field: 'occupationName', reason: 'NO_MUQEEM_VALUE' },
      { field: 'dependentsCount', reason: 'SAME_VALUE' },
    ]);
  });
});
