// INV-SAL-01 check (ARCHITECTURE_INVARIANTS §4.2.1; ADR-0002 #9): the Employee pay projection equals the
// facts of compensation in force today:
//   - basicSalary = CompensationPeriod.basicSalary, and the recurring Allowance rows = its allowances;
//   - ibanNumber / salaryPaymentMethod = BankIdentityPeriod (by fingerprint and method).
// EXPECTED, category LEGACY_READY (DEC-PO-017, ADR-0002 #9): an employee still payrollReady from the
// launch without the fact (no compensation period because the file had no salary, or no bank identity
// because the file had no IBAN): recorded EXPLAINED, nothing to do until HR files his pay.
// Policy invariant, severity WARNING, blocks nothing (payroll does not read the projection, ARCH-011).
// compensation owns the tables (ARCH-001): the check is handed down to platform with
// registerInvariantCheck by the composition roots. Read only (the reconcile snapshot runs it inside a READ
// ONLY transaction).
import type { Prisma, PrismaClient } from '@prisma/client';
import { todayKey } from '@/lib/dates';
import { roundMoney, sumMoney } from '@/lib/money';
import type { CompensationAllowance, InvariantCheck } from '@/modules/platform';
import type { ReconciliationEntity, ReconciliationResult } from '@/lib/reconciliation/checks';
import { employeesInServiceForCompensation } from '@/modules/people';
import { ibanFingerprint } from './bank';

export const INV_SAL_01_ID = 'INV-SAL-01';
export const PAY_PROJECTION_CHECK = 'payProjection';
export const LEGACY_READY_CHECK = 'legacyReady';
export const LEGACY_READY_CATEGORY = 'LEGACY_READY';
const SAMPLE_SIZE = 20;
const NO_COMPANY = '(none)';

type Db = PrismaClient | Prisma.TransactionClient;

function result(check: string, labelAr: string, labelEn: string, entities: ReconciliationEntity[], detail: Record<string, number>, note: string): ReconciliationResult {
  const byCompany: Record<string, number> = {};
  for (const e of entities) byCompany[e.companyId ?? NO_COMPANY] = (byCompany[e.companyId ?? NO_COMPANY] ?? 0) + 1;
  return {
    invariant: INV_SAL_01_ID,
    check,
    severity: 'WARNING',
    labelAr,
    labelEn,
    entityType: 'Employee',
    count: entities.length,
    sampleIds: entities.slice(0, SAMPLE_SIZE).map((e) => e.id),
    byCompany,
    detail,
    note,
    approximation: null,
    entities,
  };
}

const allowanceKey = (a: { name: string; amount: number }) => `${a.name.trim()}|${roundMoney(a.amount)}`;

export async function payProjectionResults(db: Db, now: Date = new Date()): Promise<ReconciliationResult[]> {
  const day = new Date(`${todayKey(now)}T00:00:00.000Z`);
  const inForce = { supersededAt: null, validFrom: { lte: day }, OR: [{ validTo: null }, { validTo: { gt: day } }] };
  const [employees, recurring, comps, banks, counts] = await Promise.all([
    employeesInServiceForCompensation(db),
    db.allowance.findMany({ where: { isMonthly: true, employee: { isTerminated: false } }, select: { employeeId: true, name: true, amount: true } }),
    db.compensationPeriod.findMany({ where: inForce, select: { employeeId: true, basicSalary: true, allowances: true } }),
    db.bankIdentityPeriod.findMany({ where: inForce, select: { employeeId: true, paymentMethod: true, ibanFingerprint: true, ibanEncrypted: true } }),
    db.compensationPeriod.groupBy({ by: ['employeeId'], where: { supersededAt: null }, _count: { _all: true } }),
  ]);
  const allowancesOf = new Map<string, Array<{ name: string; amount: number }>>();
  for (const a of recurring) allowancesOf.set(a.employeeId, [...(allowancesOf.get(a.employeeId) ?? []), a]);
  const compOf = new Map(comps.map((c) => [c.employeeId, c]));
  const bankOf = new Map(banks.map((b) => [b.employeeId, b]));
  const hasAnyComp = new Set(counts.map((c) => c.employeeId));

  const mismatches: ReconciliationEntity[] = [];
  const legacy: ReconciliationEntity[] = [];
  const detail: Record<string, number> = {};
  const legacyDetail: Record<string, number> = {};
  const add = (kind: string) => (detail[kind] = (detail[kind] ?? 0) + 1);
  for (const e of employees) {
    const comp = compOf.get(e.id);
    const bank = bankOf.get(e.id);
    const tags: string[] = [];
    if (comp) {
      if (roundMoney(e.basicSalary) !== roundMoney(Number(comp.basicSalary))) tags.push('BASIC');
      const items = (comp.allowances ?? []) as unknown as CompensationAllowance[];
      const fact = items.map(allowanceKey).sort().join(',');
      const rows = allowancesOf.get(e.id) ?? [];
      const proj = rows.map((a) => allowanceKey(a)).sort().join(',');
      if (fact !== proj || sumMoney(items.map((a) => a.amount)) !== sumMoney(rows.map((a) => a.amount))) tags.push('ALLOWANCES');
    } else if (!hasAnyComp.has(e.id) && e.payrollReady) {
      legacy.push({ id: e.id, companyId: e.legalCompanyId, tag: 'NO_COMPENSATION_PERIOD', employeeId: e.id, period: null, explained: legacyExplained('لا فترة أجر مسجلة (الملف بلا راتب عند الإطلاق)') });
      legacyDetail.NO_COMPENSATION_PERIOD = (legacyDetail.NO_COMPENSATION_PERIOD ?? 0) + 1;
    }
    if (bank) {
      if (bank.paymentMethod !== e.salaryPaymentMethod) tags.push('PAYMENT_METHOD');
      const projected = e.ibanNumber ? ibanFingerprint(e.ibanNumber) : null;
      if (bank.ibanFingerprint && projected !== bank.ibanFingerprint) tags.push('IBAN');
      if (!bank.ibanEncrypted && e.ibanNumber) tags.push('IBAN');
    } else if (e.payrollReady && e.salaryPaymentMethod !== 'CASH') {
      legacy.push({ id: `${e.id}:bank`, companyId: e.legalCompanyId, tag: 'NO_BANK_IDENTITY', employeeId: e.id, period: null, explained: legacyExplained('لا هوية بنكية مسجلة (الملف بلا آيبان عند الإطلاق)') });
      legacyDetail.NO_BANK_IDENTITY = (legacyDetail.NO_BANK_IDENTITY ?? 0) + 1;
    }
    if (tags.length) {
      const tag = [...new Set(tags)].join('+');
      for (const t of new Set(tags)) add(t);
      mismatches.push({ id: e.id, companyId: e.legalCompanyId, tag, employeeId: e.id, period: null });
    }
  }
  return [
    result(
      PAY_PROJECTION_CHECK,
      'الراتب أو الآيبان في ملف الموظف يخالف فترة الأجر أو الهوية البنكية النافذة اليوم',
      'Employee pay or bank columns differ from the compensation / bank identity in force today',
      mismatches,
      detail,
      'INV-SAL-01: the projection is written by compensation only; a difference means a direct edit (before P1-PAY-B) or a failed projection. HR files a financial change; payroll reads the period (ARCH-011).',
    ),
    result(
      LEGACY_READY_CHECK,
      'موظف قائم جاهز للصرف بلا فترة أجر أو هوية بنكية (متوقع: LEGACY_READY)',
      'Existing employee ready for pay without a compensation period or bank identity (EXPECTED: LEGACY_READY)',
      legacy,
      legacyDetail,
      'ADR-0002 #9, DEC-PO-017: recorded EXPLAINED until HR files the employee\'s pay or IBAN through a financial change.',
    ),
  ];
}

function legacyExplained(text: string) {
  return { category: LEGACY_READY_CATEGORY, text: `${text} (DEC-PO-017، ADR-0002 #9)`, ref: 'DEC-PO-017', by: 'system' };
}

/** The InvariantCheck handed to platform.registerInvariantCheck(INV_SAL_01_ID, …). */
export const payProjectionCheck: InvariantCheck = (db) => payProjectionResults(db as Db);
