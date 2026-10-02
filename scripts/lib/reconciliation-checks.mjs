// Read-only reconciliation checks (master plan P0-10): measures the first five invariants of
// docs/architecture/ARCHITECTURE_INVARIANTS.md on today's data, before the Discrepancy model and
// the gate exist (P1-FND-INV). Nothing here writes, blocks or notifies: every query is a findMany
// (a SELECT) and the verdicts are computed in memory, so the same rules can be unit-tested with a
// mocked Prisma client.
//
// Why this file lives in scripts/lib and not in src/lib: the report runs with plain `node` from a
// release (the Docker runtime image ships scripts/ but not src/, see Dockerfile), and plain node
// cannot import TypeScript. This is the single definition of the rules; the application imports it
// through the typed facade src/lib/reconciliation/checks.ts, so nothing is duplicated (same pattern
// as scripts/lib/document-chain.mjs). scripts/reconcile-report.mjs only calls runReconciliationReadOnly.
//
// Where an invariant names a table that does not exist yet (EmploymentStateChange, AssignmentPeriod,
// the payroll snapshot), the check measures the closest thing today's schema has and says so in
// `approximation` on every result.
import path from 'node:path';
import { readFile as fsReadFile } from 'node:fs/promises';
import { isStoredDocumentName, sha256Hex, verifyEventChain } from './document-chain.mjs';

export const SEVERITY = Object.freeze({ BLOCKING: 'BLOCKING', HIGH: 'HIGH', WARNING: 'WARNING', INFO: 'INFO' });
export const NO_COMPANY = '(none)';
export const SAMPLE_SIZE = 10;
const PAGE_SIZE = 5000;

/** Amount in halalas (integer), the unit every money comparison below uses. */
export const halalas = (v) => Math.round((Number(v) || 0) * 100);
/** Date-only key (values are stored at UTC midnight). */
const dayKey = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

/**
 * @typedef {Object} CheckResult
 * @property {string} invariant   INV-… id from ARCHITECTURE_INVARIANTS.md
 * @property {string} check       sub-check id, stable across runs
 * @property {'BLOCKING'|'HIGH'|'WARNING'|'INFO'} severity
 * @property {string} labelAr
 * @property {string} labelEn
 * @property {string|null} entityType  table of the reported rows (CHECK_ENTITY_TYPES)
 * @property {number} count       rows that violate (or, for INFO, rows that could not be measured)
 * @property {string[]} sampleIds first ids (no names, no amounts)
 * @property {Record<string, number>} byCompany  count per companyId ('(none)' when the row has none)
 * @property {Record<string, number>} detail     count per tag (e.g. payroll status, problem kind)
 * @property {string} note
 * @property {string|null} approximation  what was measured instead of the invariant's exact wording
 */

/**
 * The table whose row each sub-check reports (the `id` passed to `add`). The reconcile job of
 * P1-FND-INV (src/modules/platform/invariants) keys a Discrepancy on (invariant, check, entityType,
 * entityId, period); it reads the type from `result.entityType`, so the rule and its entity are
 * declared together here.
 */
export const CHECK_ENTITY_TYPES = Object.freeze({
  'terminated-without-date': 'Employee',
  'date-without-termination': 'Employee',
  'status-disagrees': 'Employee',
  'exit-reason-while-active': 'Employee',
  'settlement-not-projected': 'Employee',
  'terminated-without-settlement': 'Employee',
  'terminated-without-exit-reason': 'Employee',
  'projection-disagrees-fact': 'Employee',
  'no-state-fact': 'Employee',
  'department-not-in-branch': 'Employee',
  'branch-not-in-actual-company': 'Employee',
  'net-mismatch': 'Payroll',
  'deductions-breakdown-mismatch': 'Payroll',
  'negative-component': 'Payroll',
  'allowance-split-mismatch': 'Payroll',
  'legacy-no-breakdown': 'Payroll',
  'overtime-paid-twice': 'OvertimeRequest',
  'overtime-link-orphan': 'OvertimeRequest',
  'overtime-linked-not-approved': 'OvertimeRequest',
  'bonus-paid-without-line': 'Allowance',
  'bonus-link-orphan': 'Allowance',
  'deduction-linked-without-line': 'Deduction',
  'installment-without-line': 'LoanInstallment',
  'installment-link-orphan': 'LoanInstallment',
  'loan-total-mismatch': 'Payroll',
  'event-chain-broken': 'DocumentEvent',
  'file-hash-mismatch': 'IssuedDocument',
  'files-not-checked': 'IssuedDocument',
});

/**
 * Every violating row of a result (not only the first SAMPLE_SIZE ids), for the reconcile job.
 * Kept outside the result object so the JSON report stays counts and sample ids only.
 * @type {WeakMap<CheckResult, Array<{ id: string, companyId: string|null, tag: string|null, employeeId: string|null, period: string|null }>>}
 */
const ENTITIES = new WeakMap();

/**
 * The violating rows of one result: id, company ('(none)' is null here), tag, and when the rule
 * knows them the employee and the period (YYYY-MM) the row belongs to.
 * @param {CheckResult} result
 */
export function findingEntities(result) {
  return ENTITIES.get(result) ?? [];
}

/** YYYY-MM of a (year, month) pair, or null. */
const periodOf = (year, month) => (Number(year) > 0 && Number(month) >= 1 && Number(month) <= 12 ? `${Number(year)}-${String(Number(month)).padStart(2, '0')}` : null);

/**
 * One sub-check's accumulator.
 * @param {string} invariant
 * @param {string} check
 * @param {'BLOCKING'|'HIGH'|'WARNING'|'INFO'} severity
 * @param {string} labelAr
 * @param {string} labelEn
 * @param {string} note
 * @param {string|null} [approximation]
 * @returns {{ result: CheckResult, add: (id: unknown, companyId?: string|null, tag?: string, ref?: { employeeId?: string|null, period?: string|null }) => void }}
 */
function finding(invariant, check, severity, labelAr, labelEn, note, approximation = null) {
  const r = { invariant, check, severity, labelAr, labelEn, entityType: CHECK_ENTITY_TYPES[check] ?? null, count: 0, sampleIds: [], byCompany: {}, detail: {}, note, approximation };
  const entities = [];
  ENTITIES.set(r, entities);
  return {
    result: r,
    add(id, companyId, tag, ref = {}) {
      r.count += 1;
      if (r.sampleIds.length < SAMPLE_SIZE) r.sampleIds.push(String(id));
      const k = companyId || NO_COMPANY;
      r.byCompany[k] = (r.byCompany[k] || 0) + 1;
      if (tag) r.detail[tag] = (r.detail[tag] || 0) + 1;
      entities.push({ id: String(id), companyId: companyId || null, tag: tag ?? null, employeeId: ref.employeeId ?? null, period: ref.period ?? null });
    },
  };
}

/** Every row of a model, in id order, PAGE_SIZE at a time (SELECT only). */
export async function readAll(delegate, { where = {}, select }, pageSize = PAGE_SIZE) {
  const out = [];
  let last = null;
  for (;;) {
    const rows = await delegate.findMany({
      where: last === null ? where : { AND: [where, { id: { gt: last } }] },
      select: { ...select, id: true },
      orderBy: { id: 'asc' },
      take: pageSize,
    });
    out.push(...rows);
    if (rows.length < pageSize) return out;
    last = rows[rows.length - 1].id;
  }
}

// ---------------------------------------------------------------------------------------------
// Shared reads (one per run)
// ---------------------------------------------------------------------------------------------

async function employees(db, ctx) {
  if (!ctx.employees) {
    const rows = await readAll(db.employee, {
      select: {
        legalCompanyId: true, actualCompanyId: true, branchId: true, departmentId: true,
        isTerminated: true, terminationDate: true, employmentStatus: true, exitReason: true,
        employmentState: true, exitVoluntary: true,
      },
    });
    ctx.employees = new Map(rows.map((r) => [r.id, r]));
  }
  return ctx.employees;
}

const PAYROLL_SELECT = {
  employeeId: true, year: true, month: true, status: true,
  basicSalary: true, totalAllowances: true, overtimeCost: true, bonusAmount: true,
  housingAllowance: true, transportAllowance: true, otherAllowances: true,
  totalDeductions: true, netSalary: true,
  gosiEmployee: true, loansDeduction: true, violationsDeduction: true, leaveDeduction: true, otherDeductions: true,
};

async function payrolls(db, ctx) {
  if (!ctx.payrolls) {
    const rows = await readAll(db.payroll, { select: PAYROLL_SELECT });
    ctx.payrolls = new Map(rows.map((r) => [r.id, r]));
  }
  return ctx.payrolls;
}

/** Legal company of an employee today (payroll and documents are scoped by the legal company). */
const legalCompanyOf = (emps, employeeId) => emps.get(employeeId)?.legalCompanyId ?? null;

/** Sum of the stored deduction columns, in halalas. */
export function deductionBreakdown(p) {
  return halalas(p.gosiEmployee) + halalas(p.loansDeduction) + halalas(p.violationsDeduction) + halalas(p.leaveDeduction) + halalas(p.otherDeductions);
}

// ---------------------------------------------------------------------------------------------
// INV-LCY-01
// ---------------------------------------------------------------------------------------------

const LCY_APPROX =
  'Data-quality reading of the projections (isTerminated, terminationDate, employmentStatus, exitReason) and of the ' +
  'approved END_OF_SERVICE Settlement (OWNER_APPROVED or PAID, latest by createdAt). The exact rule of INV-LCY-01 ' +
  '(projection = latest EmploymentStateChange, DEC-PO-119) is the sub-check projection-disagrees-fact.';

/** BR-LCY-013: the state of a row whose employmentState projection is still empty. */
const stateOf = (e) => e.employmentState ?? (e.isTerminated ? 'TERMINATED' : 'ACTIVE');

/** The latest EmploymentStateChange of every employee (highest seq), or null when the table is not there. */
async function latestStateFacts(db) {
  if (!db.employmentStateChange) return null;
  const rows = await readAll(db.employmentStateChange, {
    select: { employeeId: true, seq: true, toState: true, terminationDate: true, exitReason: true, exitVoluntary: true },
  });
  const latest = new Map();
  for (const r of rows) {
    const prev = latest.get(r.employeeId);
    if (!prev || BigInt(r.seq) > BigInt(prev.seq)) latest.set(r.employeeId, r);
  }
  return latest;
}

/** Which projection columns disagree with the fact (DEC-PO-119): '' when none. */
export function lcyFactMismatch(e, f) {
  const out = [];
  if (e.employmentState !== f.toState) out.push('STATE');
  if (Boolean(e.isTerminated) !== (f.toState === 'TERMINATED')) out.push('IS_TERMINATED');
  if (dayKey(e.terminationDate) !== dayKey(f.terminationDate)) out.push('DATE');
  if ((e.exitReason ?? null) !== (f.exitReason ?? null) || (e.exitVoluntary ?? null) !== (f.exitVoluntary ?? null)) out.push('EXIT_REASON');
  return out.join('+');
}

export async function checkLcy01(db, ctx = {}) {
  const emps = await employees(db, ctx);
  const facts = await latestStateFacts(db);
  const settlements = await readAll(db.settlement, {
    where: { type: 'END_OF_SERVICE', status: { in: ['OWNER_APPROVED', 'PAID'] } },
    select: { employeeId: true, type: true, status: true, lastWorkingDate: true, createdAt: true },
  });
  const latest = new Map();
  for (const s of settlements) {
    if (s.type !== 'END_OF_SERVICE' || (s.status !== 'OWNER_APPROVED' && s.status !== 'PAID')) continue;
    const prev = latest.get(s.employeeId);
    if (!prev || new Date(s.createdAt) > new Date(prev.createdAt)) latest.set(s.employeeId, s);
  }

  const I = 'INV-LCY-01';
  const drift = finding(I, 'projection-disagrees-fact', SEVERITY.HIGH, 'حالة التوظيف على ملف الموظف تخالف آخر تغيير حالة مسجل', 'Employment projection differs from the latest state change',
    'employmentState / isTerminated / terminationDate / exitReason / exitVoluntary on the employee differ from the latest EmploymentStateChange (DEC-PO-119). detail = the columns that differ. The exit reason is projected by the offboarding consumer of the employment.* events: a difference younger than the domain-events run is expected.');
  const noFact = finding(I, 'no-state-fact', SEVERITY.INFO, 'موظف بلا تغيير حالة مسجل بعد', 'Employee without a recorded state change yet',
    'No EmploymentStateChange: the opening (LCY-J1) has not run for this employee yet (hired since the last employment-state-opening run). Read with the BR-LCY-013 fallback until then.');
  const noDate = finding(I, 'terminated-without-date', SEVERITY.HIGH, 'منتهية خدمته بلا تاريخ إنهاء', 'Terminated without a termination date',
    'isTerminated = true and terminationDate is empty.', LCY_APPROX);
  const dateOnly = finding(I, 'date-without-termination', SEVERITY.HIGH, 'تاريخ إنهاء لموظف على رأس العمل', 'Termination date on an active employee',
    'The state is ACTIVE (not NOTICE, not TERMINATED) and terminationDate is set.', LCY_APPROX);
  const status = finding(I, 'status-disagrees', SEVERITY.HIGH, 'employmentStatus يخالف isTerminated', 'employmentStatus disagrees with isTerminated',
    'Two copies of the same fact (EV-12020): terminated but employmentStatus is not EXCLUDED, or EXCLUDED but not terminated. detail = the employmentStatus found.', LCY_APPROX);
  const exitActive = finding(I, 'exit-reason-while-active', SEVERITY.HIGH, 'سبب خروج لموظف على رأس العمل', 'Exit reason on an active employee',
    'exitReason is set while the state is ACTIVE.', LCY_APPROX);
  const fact = finding(I, 'settlement-not-projected', SEVERITY.HIGH, 'تصفية نهاية خدمة معتمدة لا تطابق ملف الموظف', 'Approved end-of-service settlement not reflected on the employee',
    'An approved END_OF_SERVICE settlement exists but the employee is ACTIVE (neither NOTICE nor TERMINATED), or terminationDate differs from the settlement lastWorkingDate. detail = kind.', LCY_APPROX);
  const noSettle = finding(I, 'terminated-without-settlement', SEVERITY.INFO, 'إنهاء بلا تصفية معتمدة', 'Terminated with no approved settlement',
    'Terminations made on the employee file or by absconding before a settlement is approved; counted for follow-up (INV-OFF-01 measures the exit files with P3-OFF).', LCY_APPROX);
  const noExit = finding(I, 'terminated-without-exit-reason', SEVERITY.INFO, 'إنهاء بلا سبب خروج', 'Terminated without an exit reason',
    'exitReason is part of the projection; empty on a terminated employee (older terminations predate the field).', LCY_APPROX);

  for (const [id, e] of emps) {
    const co = e.legalCompanyId;
    const me = { employeeId: id };
    const state = stateOf(e);
    if (facts) {
      const f = facts.get(id);
      if (!f) noFact.add(id, co, undefined, me);
      else {
        const diff = lcyFactMismatch(e, f);
        if (diff) drift.add(id, co, diff, me);
      }
    }
    if (e.isTerminated && !e.terminationDate) noDate.add(id, co, undefined, me);
    if (state === 'ACTIVE' && e.terminationDate) dateOnly.add(id, co, undefined, me);
    if (e.isTerminated ? e.employmentStatus !== 'EXCLUDED' : e.employmentStatus === 'EXCLUDED') status.add(id, co, String(e.employmentStatus), me);
    if (state === 'ACTIVE' && e.exitReason) exitActive.add(id, co, undefined, me);
    if (e.isTerminated && !e.exitReason) noExit.add(id, co, undefined, me);
    const s = latest.get(id);
    if (s) {
      if (state === 'ACTIVE') fact.add(id, co, 'NOT_TERMINATED', me);
      else if (s.lastWorkingDate && dayKey(s.lastWorkingDate) !== dayKey(e.terminationDate)) fact.add(id, co, 'DATE_DIFFERS', me);
    } else if (e.isTerminated) {
      noSettle.add(id, co, undefined, me);
    }
  }
  const measured = facts ? [drift, noFact] : [];
  return [...measured, noDate, dateOnly, status, exitActive, fact, noSettle, noExit].map((f) => f.result);
}

// ---------------------------------------------------------------------------------------------
// INV-ORG-01
// ---------------------------------------------------------------------------------------------

const ORG_APPROX =
  'AssignmentPeriod does not exist yet, so only the current assignment on the Employee row is measured ' +
  '(branchId, departmentId, actualCompanyId), not every historical period. Terminated employees are included.';

export async function checkOrg01(db, ctx = {}) {
  const emps = await employees(db, ctx);
  const branches = new Map((await readAll(db.branch, { select: { companyId: true } })).map((b) => [b.id, b]));
  const departments = new Map((await readAll(db.department, { select: { branchId: true } })).map((d) => [d.id, d]));
  const I = 'INV-ORG-01';
  const dept = finding(I, 'department-not-in-branch', SEVERITY.BLOCKING, 'القسم لا يتبع فرع الموظف', 'Department does not belong to the employee branch',
    'Employee.departmentId is set but the department belongs to another branch, or the employee has no branch. detail = kind.', ORG_APPROX);
  const branch = finding(I, 'branch-not-in-actual-company', SEVERITY.BLOCKING, 'الفرع لا يتبع الشركة الفعلية للموظف', 'Branch does not belong to the employee actual company',
    'Employee.branchId is set but Branch.companyId differs from Employee.actualCompanyId, or actualCompanyId is empty. Grouped by actualCompanyId. detail = kind.', ORG_APPROX);
  for (const [id, e] of emps) {
    if (e.departmentId) {
      const d = departments.get(e.departmentId);
      if (!d) dept.add(id, e.actualCompanyId, 'DEPARTMENT_MISSING', { employeeId: id });
      else if (!e.branchId) dept.add(id, e.actualCompanyId, 'NO_BRANCH', { employeeId: id });
      else if (d.branchId !== e.branchId) dept.add(id, e.actualCompanyId, 'OTHER_BRANCH', { employeeId: id });
    }
    if (e.branchId) {
      const b = branches.get(e.branchId);
      if (!b) branch.add(id, e.actualCompanyId, 'BRANCH_MISSING', { employeeId: id });
      else if (!e.actualCompanyId) branch.add(id, null, 'NO_ACTUAL_COMPANY', { employeeId: id });
      else if (b.companyId !== e.actualCompanyId) branch.add(id, e.actualCompanyId, 'OTHER_COMPANY', { employeeId: id });
    }
  }
  return [dept.result, branch.result];
}

// ---------------------------------------------------------------------------------------------
// INV-PAY-01
// ---------------------------------------------------------------------------------------------

const PAY01_APPROX =
  'There is no frozen payroll snapshot yet; the stored columns of each Payroll row are its only snapshot. ' +
  'Recomputed in halalas with the rule of src/lib/payroll-core.ts: gross = basic + totalAllowances + overtime, ' +
  'net = max(0, gross - totalDeductions), totalDeductions = gosi + loans + violations + leave + other. ' +
  'Company = the employee legal company today. detail = payroll status.';

/** Verdicts for one stored payroll row (pure). */
export function payrollLineProblems(p) {
  const problems = [];
  const gross = halalas(p.basicSalary) + halalas(p.totalAllowances) + halalas(p.overtimeCost);
  const total = halalas(p.totalDeductions);
  if (halalas(p.netSalary) !== Math.max(0, gross - total)) problems.push('net-mismatch');
  const breakdown = deductionBreakdown(p);
  if (breakdown === 0 && total > 0) problems.push('legacy-no-breakdown');
  else if (breakdown !== total) problems.push('deductions-breakdown-mismatch');
  const parts = [p.basicSalary, p.totalAllowances, p.overtimeCost, p.bonusAmount, p.netSalary, p.totalDeductions,
    p.gosiEmployee, p.loansDeduction, p.violationsDeduction, p.leaveDeduction, p.otherDeductions,
    p.housingAllowance, p.transportAllowance, p.otherAllowances];
  if (parts.some((v) => v !== null && v !== undefined && halalas(v) < 0)) problems.push('negative-component');
  if (p.housingAllowance != null && p.transportAllowance != null && p.otherAllowances != null
    && halalas(p.housingAllowance) + halalas(p.transportAllowance) + halalas(p.otherAllowances) !== halalas(p.totalAllowances) - halalas(p.bonusAmount)) {
    problems.push('allowance-split-mismatch');
  }
  return problems;
}

export async function checkPay01(db, ctx = {}) {
  const emps = await employees(db, ctx);
  const rows = await payrolls(db, ctx);
  const I = 'INV-PAY-01';
  const f = {
    'net-mismatch': finding(I, 'net-mismatch', SEVERITY.BLOCKING, 'الصافي لا يساوي الإجمالي ناقص الخصومات', 'Net is not gross minus deductions',
      'netSalary != max(0, basic + allowances + overtime - totalDeductions) to the halala.', PAY01_APPROX),
    'deductions-breakdown-mismatch': finding(I, 'deductions-breakdown-mismatch', SEVERITY.BLOCKING, 'تفصيل الخصومات لا يساوي إجمالي الخصومات', 'Deduction columns do not add up to totalDeductions',
      'gosi + loans + violations + leave + other != totalDeductions (rows whose columns are all zero are counted under legacy-no-breakdown instead).', PAY01_APPROX),
    'negative-component': finding(I, 'negative-component', SEVERITY.BLOCKING, 'مبلغ سالب في سطر المسير', 'Negative amount on a payroll line',
      'Any stored amount below zero.', PAY01_APPROX),
    'allowance-split-mismatch': finding(I, 'allowance-split-mismatch', SEVERITY.WARNING, 'تفصيل البدلات لا يساوي البدلات المتكررة', 'Allowance split does not add up',
      'housing + transport + other != totalAllowances - bonusAmount (the payslip then prints one line).', PAY01_APPROX),
    'legacy-no-breakdown': finding(I, 'legacy-no-breakdown', SEVERITY.INFO, 'سطر قديم بلا تفصيل خصومات (لا يمكن إعادة حسابه)', 'Legacy line without a deduction breakdown (cannot be recomputed)',
      'Generated before the breakdown columns existed: totalDeductions cannot be recomputed, only net = gross - totalDeductions is checked.', PAY01_APPROX),
  };
  for (const [id, p] of rows) {
    for (const k of payrollLineProblems(p)) f[k].add(id, legalCompanyOf(emps, p.employeeId), String(p.status), { employeeId: p.employeeId, period: periodOf(p.year, p.month) });
  }
  return Object.values(f).map((x) => x.result);
}

// ---------------------------------------------------------------------------------------------
// INV-PAY-02
// ---------------------------------------------------------------------------------------------

const PAY02_APPROX =
  'No UNIQUE link table yet: measured on the existing link columns (OvertimeRequest.paidInPayrollId / ' +
  'paidInSettlementId, one-off Allowance.paidInPayrollId, Deduction.isLinkedToPayroll + payrollMonth, ' +
  'LoanInstallment.payrollId). Approved items never linked at all (still waiting for a payroll) are not ' +
  'counted: they can be legitimately pending. The link of settlement amounts other than overtime is not ' +
  'stored, so settlements are only checked as overtime targets. Company = the employee legal company today.';

export async function checkPay02(db, ctx = {}) {
  const emps = await employees(db, ctx);
  const lines = await payrolls(db, ctx);
  const settlements = new Map((await readAll(db.settlement, { select: { employeeId: true } })).map((s) => [s.id, s]));
  const I = 'INV-PAY-02';
  const mk = (check, labelAr, labelEn, note, sev = SEVERITY.BLOCKING) => finding(I, check, sev, labelAr, labelEn, note, PAY02_APPROX);

  const otTwice = mk('overtime-paid-twice', 'عمل إضافي مصروف في مسير وتصفية معاً', 'Overtime paid in both a payroll and a settlement',
    'OvertimeRequest has both paidInPayrollId and paidInSettlementId.');
  const otOrphan = mk('overtime-link-orphan', 'عمل إضافي مربوط بسطر غير موجود أو لموظف آخر', 'Overtime linked to a missing line or another employee',
    'paidInPayrollId / paidInSettlementId points to no row, or to a row of another employee. detail = kind.');
  const otNotApproved = mk('overtime-linked-not-approved', 'عمل إضافي غير معتمد مصروف', 'Overtime paid although not approved',
    'A linked OvertimeRequest whose status is not APPROVED. detail = status.');
  const bonusNoLine = mk('bonus-paid-without-line', 'مكافأة مصروفة بلا سطر مسير', 'Bonus marked paid without a payroll line',
    'One-off Allowance (isMonthly = false) with isPaid = true and no paidInPayrollId (older rows may predate the column).');
  const bonusOrphan = mk('bonus-link-orphan', 'مكافأة مربوطة بسطر غير موجود أو لموظف آخر', 'Bonus linked to a missing line or another employee',
    'paidInPayrollId points to no Payroll row, or to a row of another employee. detail = kind.');
  const dedOrphan = mk('deduction-linked-without-line', 'خصم مربوط بمسير بلا سطر لذلك الشهر', 'Deduction linked to payroll with no line that month',
    'Deduction.isLinkedToPayroll = true but payrollMonth is empty/invalid or the employee has no Payroll row for that month. detail = kind.');
  const instNoLine = mk('installment-without-line', 'قسط سلفة بلا سطر مسير', 'Loan installment without a payroll line',
    'LoanInstallment.payrollId is empty (its payroll was deleted or never linked).');
  const instOrphan = mk('installment-link-orphan', 'قسط سلفة مربوط بسطر غير موجود أو لموظف أو شهر آخر', 'Loan installment linked to a missing line, another employee or another month',
    'detail = kind.');
  const loanTotal = mk('loan-total-mismatch', 'خصم السلف في السطر لا يساوي أقساطه المربوطة', 'Payroll loan deduction differs from its linked installments',
    'Payroll.loansDeduction != sum of the LoanInstallment rows linked to it (a duplicated or missing installment). Legacy rows without a stored breakdown are skipped. detail = payroll status.');

  const overtime = await readAll(db.overtimeRequest, {
    where: { OR: [{ paidInPayrollId: { not: null } }, { paidInSettlementId: { not: null } }] },
    select: { employeeId: true, status: true, paidInPayrollId: true, paidInSettlementId: true },
  });
  for (const o of overtime) {
    if (!o.paidInPayrollId && !o.paidInSettlementId) continue;
    const co = legalCompanyOf(emps, o.employeeId);
    const linked = o.paidInPayrollId ? lines.get(o.paidInPayrollId) : null;
    const ref = { employeeId: o.employeeId, period: linked ? periodOf(linked.year, linked.month) : null };
    if (o.paidInPayrollId && o.paidInSettlementId) otTwice.add(o.id, co, undefined, ref);
    if (o.status !== 'APPROVED') otNotApproved.add(o.id, co, String(o.status), ref);
    if (o.paidInPayrollId) {
      const p = lines.get(o.paidInPayrollId);
      if (!p) otOrphan.add(o.id, co, 'PAYROLL_MISSING', ref);
      else if (p.employeeId !== o.employeeId) otOrphan.add(o.id, co, 'PAYROLL_OTHER_EMPLOYEE', ref);
    }
    if (o.paidInSettlementId) {
      const s = settlements.get(o.paidInSettlementId);
      if (!s) otOrphan.add(o.id, co, 'SETTLEMENT_MISSING', ref);
      else if (s.employeeId !== o.employeeId) otOrphan.add(o.id, co, 'SETTLEMENT_OTHER_EMPLOYEE', ref);
    }
  }

  const bonuses = await readAll(db.allowance, {
    where: { isMonthly: false, OR: [{ isPaid: true }, { paidInPayrollId: { not: null } }] },
    select: { employeeId: true, isMonthly: true, isPaid: true, paidInPayrollId: true },
  });
  for (const b of bonuses) {
    if (b.isMonthly) continue;
    const co = legalCompanyOf(emps, b.employeeId);
    const bLine = b.paidInPayrollId ? lines.get(b.paidInPayrollId) : null;
    const bRef = { employeeId: b.employeeId, period: bLine ? periodOf(bLine.year, bLine.month) : null };
    if (b.isPaid && !b.paidInPayrollId) bonusNoLine.add(b.id, co, undefined, bRef);
    if (b.paidInPayrollId) {
      const p = lines.get(b.paidInPayrollId);
      if (!p) bonusOrphan.add(b.id, co, 'PAYROLL_MISSING', bRef);
      else if (p.employeeId !== b.employeeId) bonusOrphan.add(b.id, co, 'PAYROLL_OTHER_EMPLOYEE', bRef);
    }
  }

  const lineByEmployeeMonth = new Set([...lines.values()].map((p) => `${p.employeeId}|${p.year}|${p.month}`));
  const deductions = await readAll(db.deduction, {
    where: { isLinkedToPayroll: true },
    select: { employeeId: true, isLinkedToPayroll: true, payrollMonth: true },
  });
  for (const d of deductions) {
    if (!d.isLinkedToPayroll) continue;
    const co = legalCompanyOf(emps, d.employeeId);
    const m = /^(\d{4})-(\d{2})$/.exec(d.payrollMonth ?? '');
    const month = m ? Number(m[2]) : 0;
    if (!m || month < 1 || month > 12) dedOrphan.add(d.id, co, 'NO_MONTH', { employeeId: d.employeeId });
    else if (!lineByEmployeeMonth.has(`${d.employeeId}|${Number(m[1])}|${month}`)) dedOrphan.add(d.id, co, 'NO_LINE', { employeeId: d.employeeId, period: periodOf(m[1], month) });
  }

  const installments = await readAll(db.loanInstallment, {
    select: { loanId: true, payrollId: true, year: true, month: true, amount: true, loan: { select: { employeeId: true } } },
  });
  const installmentSum = new Map();
  for (const i of installments) {
    const employeeId = i.loan?.employeeId ?? null;
    const co = legalCompanyOf(emps, employeeId);
    const iRef = { employeeId, period: periodOf(i.year, i.month) };
    if (!i.payrollId) {
      instNoLine.add(i.id, co, undefined, iRef);
      continue;
    }
    installmentSum.set(i.payrollId, (installmentSum.get(i.payrollId) || 0) + halalas(i.amount));
    const p = lines.get(i.payrollId);
    if (!p) instOrphan.add(i.id, co, 'PAYROLL_MISSING', iRef);
    else if (p.employeeId !== employeeId) instOrphan.add(i.id, co, 'PAYROLL_OTHER_EMPLOYEE', iRef);
    else if (p.year !== i.year || p.month !== i.month) instOrphan.add(i.id, co, 'PAYROLL_OTHER_MONTH', iRef);
  }
  for (const [id, p] of lines) {
    if (deductionBreakdown(p) !== halalas(p.totalDeductions)) continue; // legacy / already reported by INV-PAY-01
    if (halalas(p.loansDeduction) !== (installmentSum.get(id) || 0)) loanTotal.add(id, legalCompanyOf(emps, p.employeeId), String(p.status), { employeeId: p.employeeId, period: periodOf(p.year, p.month) });
  }

  return [otTwice, otOrphan, otNotApproved, bonusNoLine, bonusOrphan, dedOrphan, instNoLine, instOrphan, loanTotal].map((f) => f.result);
}

// ---------------------------------------------------------------------------------------------
// INV-DOC-01
// ---------------------------------------------------------------------------------------------

const DOC_APPROX =
  'Same checks as the documents-integrity job (scripts/jobs.mjs), read-only: no JobRun row, no email. ' +
  'Every non-purged IssuedDocument is re-hashed (no per-run cap). Company = IssuedDocument.legalCompanyId.';

/**
 * @param {object} opts
 * @param {string} [opts.uploadDir]  UPLOAD_DIR; files are not checked without it
 * @param {(p: string) => Promise<Buffer>} [opts.readFile]  injectable for tests
 */
export async function checkDoc01(db, _ctx = {}, opts = {}) {
  const I = 'INV-DOC-01';
  const chain = finding(I, 'event-chain-broken', SEVERITY.HIGH, 'سلسلة أحداث المستندات مكسورة', 'Document event chain broken',
    'DocumentEvent hash chain walked from genesis; sampleIds = the first broken seq. detail.eventsChecked = events verified before the break (or all).', DOC_APPROX);
  const files = finding(I, 'file-hash-mismatch', SEVERITY.HIGH, 'ملف مستند مفقود أو لا يطابق بصمته', 'Issued document file missing or not matching its hash',
    'detail = kind (HASH_MISMATCH, FILE_MISSING, UNREADABLE, INVALID_STORED_NAME).', DOC_APPROX);
  const skipped = finding(I, 'files-not-checked', SEVERITY.INFO, 'ملفات لم تُفحص (UPLOAD_DIR غير مضبوط)', 'Files not checked (UPLOAD_DIR not set)',
    'Set UPLOAD_DIR in the tenant env file to re-hash the stored PDFs.', DOC_APPROX);

  const c = await verifyEventChain(db);
  chain.result.detail.eventsChecked = c.checked;
  if (c.brokenAtSeq !== null) chain.add(c.brokenAtSeq, null);

  const docs = await readAll(db.issuedDocument, {
    where: { purgedAt: null },
    select: { legalCompanyId: true, storedName: true, pdfSha256: true, purgedAt: true },
  });
  const uploadDir = String(opts.uploadDir || '').trim();
  const read = opts.readFile || fsReadFile;
  const dir = uploadDir ? path.join(path.resolve(uploadDir), '.documents') : null;
  let checked = 0;
  for (const d of docs) {
    if (d.purgedAt) continue;
    if (!dir) {
      skipped.add(d.id, d.legalCompanyId);
      continue;
    }
    checked += 1;
    if (!isStoredDocumentName(d.storedName)) {
      files.add(d.id, d.legalCompanyId, 'INVALID_STORED_NAME');
      continue;
    }
    try {
      const buf = await read(path.join(dir, ...d.storedName.split('/')));
      if (sha256Hex(buf) !== d.pdfSha256) files.add(d.id, d.legalCompanyId, 'HASH_MISMATCH');
    } catch (err) {
      files.add(d.id, d.legalCompanyId, err && err.code === 'ENOENT' ? 'FILE_MISSING' : 'UNREADABLE');
    }
  }
  files.result.detail.filesChecked = checked;
  return [chain.result, files.result, skipped.result];
}

// ---------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------

export const CHECKS = Object.freeze([
  { invariant: 'INV-LCY-01', run: checkLcy01 },
  { invariant: 'INV-ORG-01', run: checkOrg01 },
  { invariant: 'INV-PAY-01', run: checkPay01 },
  { invariant: 'INV-PAY-02', run: checkPay02 },
  { invariant: 'INV-DOC-01', run: checkDoc01 },
]);

/**
 * Runs every check (or only `opts.invariants`, a list of INV ids) against `db` (a PrismaClient or a
 * transaction client). Pure reads.
 * @returns {Promise<{ generatedAt: string, readOnlyTransaction: boolean, results: CheckResult[] }>}
 */
export async function runReconciliation(db, opts = {}) {
  const ctx = {};
  const results = [];
  for (const c of CHECKS) {
    if (Array.isArray(opts.invariants) && !opts.invariants.includes(c.invariant)) continue;
    results.push(...(await c.run(db, ctx, opts)));
  }
  return { generatedAt: (opts.now ?? new Date()).toISOString(), readOnlyTransaction: Boolean(opts.readOnlyTransaction), results };
}

/**
 * Same as runReconciliation inside one REPEATABLE READ, READ ONLY transaction: one consistent
 * snapshot, and PostgreSQL itself refuses any write. Verifies the mode before reading.
 */
export async function runReconciliationReadOnly(prisma, opts = {}) {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const mode = await tx.$queryRawUnsafe('SHOW transaction_read_only');
      if (!Array.isArray(mode) || mode[0]?.transaction_read_only !== 'on') throw new Error('reconciliation: the transaction is not READ ONLY; refusing to run');
      return runReconciliation(tx, { ...opts, readOnlyTransaction: true });
    },
    { maxWait: 60_000, timeout: opts.timeoutMs ?? 30 * 60_000 },
  );
}

/** Human-readable summary (Arabic / English), counts only: no names, no amounts. */
export function formatSummary(report) {
  const lines = [`Radeef reconciliation report / تقرير المصالحة — ${report.generatedAt}${report.readOnlyTransaction ? ' (READ ONLY)' : ''}`, ''];
  let invariant = null;
  for (const r of report.results) {
    if (r.invariant !== invariant) {
      invariant = r.invariant;
      lines.push(`== ${invariant}`);
      if (r.approximation) lines.push(`   approximation: ${r.approximation}`);
    }
    const mark = r.count === 0 ? 'OK ' : r.severity === SEVERITY.INFO ? 'i  ' : '!! ';
    lines.push(`${mark} [${r.severity}] ${r.check}: ${r.count}`);
    lines.push(`     ${r.labelAr} / ${r.labelEn}`);
    if (r.count > 0) {
      const byCo = Object.entries(r.byCompany).map(([k, v]) => `${k}=${v}`).join(', ');
      lines.push(`     by company: ${byCo}`);
      const det = Object.entries(r.detail).map(([k, v]) => `${k}=${v}`).join(', ');
      if (det) lines.push(`     detail: ${det}`);
      lines.push(`     sample ids: ${r.sampleIds.join(', ')}`);
    }
  }
  const failing = report.results.filter((r) => r.count > 0 && r.severity !== SEVERITY.INFO);
  lines.push('', `Violating checks / فحوص فيها مخالفات: ${failing.length} of ${report.results.filter((r) => r.severity !== SEVERITY.INFO).length}`);
  lines.push('Report only: nothing was blocked or written. / تقرير فقط: لم يُوقف شيء ولم يُكتب شيء.');
  return lines.join('\n');
}
