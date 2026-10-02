// P0-10 read-only reconciliation checks: each check against a mocked Prisma client whose fixtures
// hold one violating row and one clean row. The mock only has findMany (and the two raw calls of
// the read-only transaction), so any attempted write fails the test with a TypeError.
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  checkDoc01,
  checkLcy01,
  checkOrg01,
  checkPay01,
  checkPay02,
  formatSummary,
  payrollLineProblems,
  runReconciliation,
  runReconciliationReadOnly,
  type ReconciliationResult,
} from '@/lib/reconciliation/checks';
import { eventHash, GENESIS_HASH } from '../../../scripts/lib/document-chain.mjs';

type Rows = Record<string, unknown[]>;

/** A Prisma-like client: every model returns its fixture rows from findMany, nothing else. */
function mockDb(rows: Rows) {
  const db: Record<string, unknown> = {};
  const models = ['employee', 'branch', 'department', 'settlement', 'payroll', 'overtimeRequest', 'allowance', 'deduction', 'loanInstallment', 'issuedDocument', 'employmentStateChange'];
  for (const m of models) db[m] = { findMany: vi.fn(async () => rows[m] ?? []) };
  // verifyEventChain pages with `seq > last`: return the chain once, then nothing.
  db.documentEvent = { findMany: vi.fn(async (args: { where?: Record<string, unknown> }) => (args.where && Object.keys(args.where).length ? [] : rows.documentEvent ?? [])) };
  return db;
}

const byCheck = (results: ReconciliationResult[], check: string) => {
  const r = results.find((x) => x.check === check);
  if (!r) throw new Error(`no result for ${check}`);
  return r;
};

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

const baseEmployee = {
  legalCompanyId: 'CO-L', actualCompanyId: 'CO-A', branchId: 'BR-1', departmentId: 'DP-1',
  isTerminated: false, terminationDate: null, employmentStatus: 'ACTIVE', exitReason: null,
};

describe('INV-LCY-01 (termination projections)', () => {
  it('flags each disagreement on the bad employee and nothing on the clean one', async () => {
    const db = mockDb({
      employee: [
        { id: 'E-OK', ...baseEmployee },
        { id: 'E-OK-TERM', ...baseEmployee, isTerminated: true, terminationDate: d('2026-05-31'), employmentStatus: 'EXCLUDED', exitReason: 'RESIGNATION' },
        { id: 'E-NODATE', ...baseEmployee, isTerminated: true, employmentStatus: 'EXCLUDED', exitReason: 'RESIGNATION' },
        { id: 'E-DATEONLY', ...baseEmployee, terminationDate: d('2026-01-01') },
        { id: 'E-STATUS', ...baseEmployee, isTerminated: true, terminationDate: d('2026-02-01'), employmentStatus: 'ACTIVE', exitReason: 'RESIGNATION' },
        { id: 'E-EXIT', ...baseEmployee, exitReason: 'RESIGNATION' },
        { id: 'E-SETTLED', ...baseEmployee, legalCompanyId: 'CO-2' },
      ],
      settlement: [
        { id: 'S-OK', employeeId: 'E-OK-TERM', type: 'END_OF_SERVICE', status: 'PAID', lastWorkingDate: d('2026-05-31'), createdAt: d('2026-06-01') },
        { id: 'S-BAD', employeeId: 'E-SETTLED', type: 'END_OF_SERVICE', status: 'OWNER_APPROVED', lastWorkingDate: d('2026-04-30'), createdAt: d('2026-05-01') },
        // Rejected settlements are not facts even if the mock returns them.
        { id: 'S-REJ', employeeId: 'E-OK', type: 'END_OF_SERVICE', status: 'REJECTED', lastWorkingDate: null, createdAt: d('2026-05-01') },
      ],
    });
    const r = await checkLcy01(db);
    expect(byCheck(r, 'terminated-without-date')).toMatchObject({ count: 1, sampleIds: ['E-NODATE'], severity: 'HIGH' });
    expect(byCheck(r, 'date-without-termination')).toMatchObject({ count: 1, sampleIds: ['E-DATEONLY'] });
    expect(byCheck(r, 'status-disagrees')).toMatchObject({ count: 1, sampleIds: ['E-STATUS'], detail: { ACTIVE: 1 } });
    expect(byCheck(r, 'exit-reason-while-active')).toMatchObject({ count: 1, sampleIds: ['E-EXIT'] });
    expect(byCheck(r, 'settlement-not-projected')).toMatchObject({ count: 1, sampleIds: ['E-SETTLED'], byCompany: { 'CO-2': 1 }, detail: { NOT_TERMINATED: 1 } });
    // Terminated with no approved settlement: E-NODATE and E-STATUS (E-OK-TERM has one).
    expect(byCheck(r, 'terminated-without-settlement')).toMatchObject({ count: 2, severity: 'INFO' });
    const exact = ['projection-disagrees-fact', 'no-state-fact'];
    expect(r.filter((x) => !exact.includes(x.check)).every((x) => x.approximation && x.approximation.includes('EmploymentStateChange'))).toBe(true);
    expect(r.filter((x) => exact.includes(x.check)).every((x) => x.approximation === null)).toBe(true);
    // No state fact in this fixture: every employee is "not opened yet" (INFO), nothing else on E-OK.
    expect(byCheck(r, 'no-state-fact')).toMatchObject({ count: 7, severity: 'INFO' });
    for (const x of r) if (x.check !== 'no-state-fact') expect(x.sampleIds).not.toContain('E-OK');
  });

  it('compares the projection with the latest EmploymentStateChange (DEC-PO-119), by seq', async () => {
    const db = mockDb({
      employee: [
        { id: 'E-OK', ...baseEmployee, employmentState: 'ACTIVE', exitVoluntary: null },
        { id: 'E-NOTICE', ...baseEmployee, employmentState: 'NOTICE', terminationDate: d('2026-12-31'), exitReason: 'RESIGNATION', exitVoluntary: true },
        { id: 'E-DRIFT', ...baseEmployee, employmentState: 'ACTIVE', exitVoluntary: null },
        { id: 'E-REASON', ...baseEmployee, employmentState: 'TERMINATED', isTerminated: true, employmentStatus: 'EXCLUDED', terminationDate: d('2026-05-31'), exitReason: null, exitVoluntary: null },
        { id: 'E-NEW', ...baseEmployee },
      ],
      employmentStateChange: [
        { id: 'C1', employeeId: 'E-OK', seq: BigInt(1), toState: 'ACTIVE', terminationDate: null, exitReason: null, exitVoluntary: null },
        { id: 'C2', employeeId: 'E-NOTICE', seq: BigInt(2), toState: 'ACTIVE', terminationDate: null, exitReason: null, exitVoluntary: null },
        { id: 'C3', employeeId: 'E-NOTICE', seq: BigInt(5), toState: 'NOTICE', terminationDate: d('2026-12-31'), exitReason: 'RESIGNATION', exitVoluntary: true },
        { id: 'C4', employeeId: 'E-DRIFT', seq: BigInt(3), toState: 'TERMINATED', terminationDate: d('2026-04-30'), exitReason: null, exitVoluntary: null },
        { id: 'C5', employeeId: 'E-REASON', seq: BigInt(4), toState: 'TERMINATED', terminationDate: d('2026-05-31'), exitReason: 'RESIGNATION', exitVoluntary: true },
      ],
    });
    const r = await checkLcy01(db);
    expect(byCheck(r, 'projection-disagrees-fact')).toMatchObject({ count: 2, severity: 'HIGH', detail: { 'STATE+IS_TERMINATED+DATE': 1, EXIT_REASON: 1 } });
    expect(byCheck(r, 'projection-disagrees-fact').sampleIds.sort()).toEqual(['E-DRIFT', 'E-REASON']);
    expect(byCheck(r, 'no-state-fact')).toMatchObject({ count: 1, sampleIds: ['E-NEW'] });
    // NOTICE carries its last working day legitimately: not a "date on an active employee".
    expect(byCheck(r, 'date-without-termination').count).toBe(0);
    expect(byCheck(r, 'exit-reason-while-active').count).toBe(0);
  });

  it('reports a settlement whose last working day differs from terminationDate', async () => {
    const db = mockDb({
      employee: [{ id: 'E1', ...baseEmployee, isTerminated: true, terminationDate: d('2026-05-15'), employmentStatus: 'EXCLUDED', exitReason: 'RESIGNATION' }],
      settlement: [{ id: 'S1', employeeId: 'E1', type: 'END_OF_SERVICE', status: 'PAID', lastWorkingDate: d('2026-05-31'), createdAt: d('2026-06-01') }],
    });
    expect(byCheck(await checkLcy01(db), 'settlement-not-projected')).toMatchObject({ count: 1, detail: { DATE_DIFFERS: 1 } });
  });
});

describe('INV-ORG-01 (department in branch, branch in actual company)', () => {
  it('flags the misplaced employee and passes the clean one', async () => {
    const db = mockDb({
      employee: [
        { id: 'E-OK', ...baseEmployee },
        { id: 'E-BAD', ...baseEmployee, branchId: 'BR-2', departmentId: 'DP-1' },
      ],
      branch: [{ id: 'BR-1', companyId: 'CO-A' }, { id: 'BR-2', companyId: 'CO-OTHER' }],
      department: [{ id: 'DP-1', branchId: 'BR-1' }],
    });
    const r = await checkOrg01(db);
    expect(byCheck(r, 'department-not-in-branch')).toMatchObject({ count: 1, sampleIds: ['E-BAD'], severity: 'BLOCKING', detail: { OTHER_BRANCH: 1 }, byCompany: { 'CO-A': 1 } });
    expect(byCheck(r, 'branch-not-in-actual-company')).toMatchObject({ count: 1, sampleIds: ['E-BAD'], detail: { OTHER_COMPANY: 1 } });
  });

  it('counts a branch with no actual company under (none)', async () => {
    const db = mockDb({
      employee: [{ id: 'E1', ...baseEmployee, actualCompanyId: null, departmentId: null }],
      branch: [{ id: 'BR-1', companyId: 'CO-A' }],
    });
    expect(byCheck(await checkOrg01(db), 'branch-not-in-actual-company')).toMatchObject({ count: 1, byCompany: { '(none)': 1 }, detail: { NO_ACTUAL_COMPANY: 1 } });
  });
});

const cleanLine = {
  employeeId: 'E1', year: 2026, month: 4, status: 'APPROVED',
  basicSalary: 5000, totalAllowances: 1500.5, overtimeCost: 200, bonusAmount: 500.5,
  housingAllowance: 700, transportAllowance: 300, otherAllowances: 0,
  totalDeductions: 850.1, netSalary: 5850.4,
  gosiEmployee: 450.1, loansDeduction: 400, violationsDeduction: 0, leaveDeduction: 0, otherDeductions: 0,
};

describe('INV-PAY-01 (net = recompute from the stored line, in halalas)', () => {
  it('passes a consistent line, including float sums that are exact only in halalas', () => {
    expect(payrollLineProblems(cleanLine)).toEqual([]);
    expect(payrollLineProblems({ ...cleanLine, basicSalary: 0.1, totalAllowances: 0.2, overtimeCost: 0, bonusAmount: 0, housingAllowance: null, totalDeductions: 0, netSalary: 0.3, gosiEmployee: 0, loansDeduction: 0 })).toEqual([]);
  });

  it('flags a line whose net is off by one halala and one with a broken breakdown', async () => {
    const db = mockDb({
      employee: [{ id: 'E1', ...baseEmployee }],
      payroll: [
        { id: 'P-OK', ...cleanLine },
        { id: 'P-NET', ...cleanLine, netSalary: 5850.41 },
        { id: 'P-BRK', ...cleanLine, status: 'DRAFT', gosiEmployee: 450 },
        { id: 'P-LEGACY', ...cleanLine, gosiEmployee: 0, loansDeduction: 0 },
        { id: 'P-NEG', ...cleanLine, otherDeductions: -1, gosiEmployee: 451.1 },
        { id: 'P-SPLIT', ...cleanLine, otherAllowances: 5 },
      ],
    });
    const r = await checkPay01(db);
    expect(byCheck(r, 'net-mismatch')).toMatchObject({ count: 1, sampleIds: ['P-NET'], severity: 'BLOCKING', byCompany: { 'CO-L': 1 }, detail: { APPROVED: 1 } });
    expect(byCheck(r, 'deductions-breakdown-mismatch')).toMatchObject({ count: 1, sampleIds: ['P-BRK'], detail: { DRAFT: 1 } });
    expect(byCheck(r, 'legacy-no-breakdown')).toMatchObject({ count: 1, sampleIds: ['P-LEGACY'], severity: 'INFO' });
    expect(byCheck(r, 'negative-component')).toMatchObject({ count: 1, sampleIds: ['P-NEG'] });
    expect(byCheck(r, 'allowance-split-mismatch')).toMatchObject({ count: 1, sampleIds: ['P-SPLIT'] });
    for (const x of r) expect(x.sampleIds).not.toContain('P-OK');
  });

  it('accepts net 0 when deductions exceed gross (max(0, …))', () => {
    expect(payrollLineProblems({ ...cleanLine, totalDeductions: 9000, gosiEmployee: 8600, netSalary: 0 })).toEqual([]);
  });
});

describe('INV-PAY-02 (every paid item on exactly one line)', () => {
  const rows = (): Rows => ({
    employee: [{ id: 'E1', ...baseEmployee }, { id: 'E2', ...baseEmployee, legalCompanyId: 'CO-2' }],
    payroll: [
      { id: 'P1', ...cleanLine },
      { id: 'P2', ...cleanLine, employeeId: 'E2', loansDeduction: 0, gosiEmployee: 850.1 },
      { id: 'P3', ...cleanLine, month: 5, loansDeduction: 400 },
    ],
    settlement: [{ id: 'S1', employeeId: 'E1' }],
    overtimeRequest: [
      { id: 'OT-OK', employeeId: 'E1', status: 'APPROVED', paidInPayrollId: 'P1', paidInSettlementId: null },
      { id: 'OT-TWICE', employeeId: 'E1', status: 'APPROVED', paidInPayrollId: 'P1', paidInSettlementId: 'S1' },
      { id: 'OT-OTHER', employeeId: 'E1', status: 'APPROVED', paidInPayrollId: 'P2', paidInSettlementId: null },
      { id: 'OT-REJ', employeeId: 'E1', status: 'REJECTED', paidInPayrollId: 'P1', paidInSettlementId: null },
    ],
    allowance: [
      { id: 'B-OK', employeeId: 'E1', isMonthly: false, isPaid: true, paidInPayrollId: 'P1' },
      { id: 'B-NOLINE', employeeId: 'E1', isMonthly: false, isPaid: true, paidInPayrollId: null },
      { id: 'B-GONE', employeeId: 'E1', isMonthly: false, isPaid: false, paidInPayrollId: 'P-DELETED' },
    ],
    deduction: [
      { id: 'D-OK', employeeId: 'E1', isLinkedToPayroll: true, payrollMonth: '2026-04' },
      { id: 'D-NOLINE', employeeId: 'E1', isLinkedToPayroll: true, payrollMonth: '2026-07' },
      { id: 'D-NOMONTH', employeeId: 'E1', isLinkedToPayroll: true, payrollMonth: null },
    ],
    loanInstallment: [
      { id: 'I-OK', loanId: 'L1', payrollId: 'P1', year: 2026, month: 4, amount: 400, loan: { employeeId: 'E1' } },
      { id: 'I-NOLINE', loanId: 'L1', payrollId: null, year: 2026, month: 6, amount: 400, loan: { employeeId: 'E1' } },
      { id: 'I-OTHER', loanId: 'L2', payrollId: 'P2', year: 2026, month: 4, amount: 100, loan: { employeeId: 'E1' } },
    ],
  });

  it('flags duplicates and orphans, passes the linked rows', async () => {
    const r = await checkPay02(mockDb(rows()));
    expect(byCheck(r, 'overtime-paid-twice')).toMatchObject({ count: 1, sampleIds: ['OT-TWICE'], severity: 'BLOCKING' });
    expect(byCheck(r, 'overtime-link-orphan')).toMatchObject({ count: 1, sampleIds: ['OT-OTHER'], detail: { PAYROLL_OTHER_EMPLOYEE: 1 } });
    expect(byCheck(r, 'overtime-linked-not-approved')).toMatchObject({ count: 1, sampleIds: ['OT-REJ'], detail: { REJECTED: 1 } });
    expect(byCheck(r, 'bonus-paid-without-line')).toMatchObject({ count: 1, sampleIds: ['B-NOLINE'] });
    expect(byCheck(r, 'bonus-link-orphan')).toMatchObject({ count: 1, sampleIds: ['B-GONE'], detail: { PAYROLL_MISSING: 1 } });
    expect(byCheck(r, 'deduction-linked-without-line')).toMatchObject({ count: 2, detail: { NO_LINE: 1, NO_MONTH: 1 } });
    expect(byCheck(r, 'installment-without-line')).toMatchObject({ count: 1, sampleIds: ['I-NOLINE'] });
    expect(byCheck(r, 'installment-link-orphan')).toMatchObject({ count: 1, sampleIds: ['I-OTHER'], detail: { PAYROLL_OTHER_EMPLOYEE: 1 } });
    // P1: 400 = I-OK. P2: 0 on the line but I-OTHER (100) linked. P3: 400 on the line, no installment.
    expect(byCheck(r, 'loan-total-mismatch')).toMatchObject({ count: 2, sampleIds: ['P2', 'P3'], byCompany: { 'CO-2': 1, 'CO-L': 1 } });
    for (const x of r) for (const id of ['OT-OK', 'B-OK', 'D-OK', 'I-OK', 'P1']) expect(x.sampleIds).not.toContain(id);
  });

  it('reports nothing on a clean dataset', async () => {
    const clean = rows();
    clean.payroll = [{ id: 'P1', ...cleanLine }];
    clean.overtimeRequest = [clean.overtimeRequest[0]];
    clean.allowance = [clean.allowance[0]];
    clean.deduction = [clean.deduction[0]];
    clean.loanInstallment = [clean.loanInstallment[0]];
    const r = await checkPay02(mockDb(clean));
    expect(r.map((x) => [x.check, x.count]).filter(([, n]) => n !== 0)).toEqual([]);
  });
});

describe('INV-DOC-01 (event chain and file hashes)', () => {
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  function chain(n: number) {
    const out: Array<Record<string, unknown>> = [];
    let prev = GENESIS_HASH;
    for (let i = 1; i <= n; i++) {
      const row = { seq: BigInt(i), type: 'ISSUED', requestId: `R${i}`, documentId: `D${i}`, actorId: null, ip: null, metaJson: null, at: new Date(Date.UTC(2026, 0, i)) };
      const hash = eventHash(prev, row);
      out.push({ ...row, prevHash: prev, hash });
      prev = hash;
    }
    return out;
  }
  const files: Record<string, string> = { '2026/11111111-1111-1111-1111-111111111111.pdf': 'good pdf', '2026/22222222-2222-2222-2222-222222222222.pdf': 'tampered' };
  const readFile = vi.fn(async (p: string) => {
    const key = Object.keys(files).find((k) => p.replace(/\\/g, '/').endsWith(k));
    if (!key) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return Buffer.from(files[key]);
  });
  const docs = [
    { id: 'DOC-OK', legalCompanyId: 'CO-L', storedName: '2026/11111111-1111-1111-1111-111111111111.pdf', pdfSha256: sha('good pdf'), purgedAt: null },
    { id: 'DOC-BAD', legalCompanyId: 'CO-L', storedName: '2026/22222222-2222-2222-2222-222222222222.pdf', pdfSha256: sha('original'), purgedAt: null },
    { id: 'DOC-GONE', legalCompanyId: 'CO-2', storedName: '2026/33333333-3333-3333-3333-333333333333.pdf', pdfSha256: sha('x'), purgedAt: null },
  ];

  it('accepts an intact chain and flags the tampered and missing files', async () => {
    const r = await checkDoc01(mockDb({ documentEvent: chain(3), issuedDocument: docs }), {}, { uploadDir: '/srv/uploads', readFile });
    expect(byCheck(r, 'event-chain-broken')).toMatchObject({ count: 0, detail: { eventsChecked: 3 } });
    expect(byCheck(r, 'file-hash-mismatch')).toMatchObject({
      count: 2, sampleIds: ['DOC-BAD', 'DOC-GONE'], byCompany: { 'CO-L': 1, 'CO-2': 1 }, detail: { HASH_MISMATCH: 1, FILE_MISSING: 1, filesChecked: 3 },
    });
    expect(byCheck(r, 'files-not-checked').count).toBe(0);
  });

  it('reports the first broken seq of an altered chain', async () => {
    const events = chain(3);
    events[1] = { ...events[1], type: 'REVOKED' };
    const r = await checkDoc01(mockDb({ documentEvent: events, issuedDocument: [] }), {}, {});
    expect(byCheck(r, 'event-chain-broken')).toMatchObject({ count: 1, sampleIds: ['2'], severity: 'HIGH', detail: { eventsChecked: 1 } });
  });

  it('without UPLOAD_DIR counts the files as not checked instead of guessing a folder', async () => {
    const r = await checkDoc01(mockDb({ documentEvent: [], issuedDocument: docs }), {}, {});
    expect(byCheck(r, 'files-not-checked')).toMatchObject({ count: 3, severity: 'INFO' });
    expect(byCheck(r, 'file-hash-mismatch').count).toBe(0);
  });
});

describe('runner', () => {
  it('runs every invariant once and summarizes counts without amounts', async () => {
    const report = await runReconciliation(mockDb({ employee: [{ id: 'E1', ...baseEmployee, branchId: null, departmentId: null }] }), { now: new Date('2026-09-28T00:00:00Z') });
    expect([...new Set(report.results.map((r) => r.invariant))]).toEqual(['INV-LCY-01', 'INV-ORG-01', 'INV-PAY-01', 'INV-PAY-02', 'INV-DOC-01']);
    expect(report.results.filter((r) => r.severity !== 'INFO' && r.count > 0)).toEqual([]);
    const text = formatSummary(report);
    expect(text).toContain('INV-PAY-01');
    expect(text).toContain('تقرير فقط');
  });

  it('runs inside a READ ONLY transaction and refuses when the mode is not on', async () => {
    const tx = { ...mockDb({}), $executeRawUnsafe: vi.fn(async () => 0), $queryRawUnsafe: vi.fn(async () => [{ transaction_read_only: 'on' }]) };
    const prisma = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
    const report = await runReconciliationReadOnly(prisma);
    expect(tx.$executeRawUnsafe).toHaveBeenCalledWith('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    expect(report.readOnlyTransaction).toBe(true);

    tx.$queryRawUnsafe.mockResolvedValueOnce([{ transaction_read_only: 'off' }]);
    await expect(runReconciliationReadOnly(prisma)).rejects.toThrow(/not READ ONLY/);
  });
});
