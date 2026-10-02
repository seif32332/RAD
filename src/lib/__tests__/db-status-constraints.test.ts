// P1-FND-DB (migration 9x_db_constraints): the closed value lists the database enforces on the
// String status columns (ARCH-015) must match the constants the code writes. A value added in code
// without a migration would be refused by Postgres at run time; this test catches it first.
// It also guards the other structural changes of 9x (Restrict on legal history, CompanyDocument gone).
import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  ASSET_STATUS,
  ATTENDANCE_CORRECTION_STATUS,
  DEDUCTION_STATUS,
  LOAN_STATUS,
  SETTLEMENT_STATUS,
  TRANSFER_STATUS,
} from '@/lib/constants';
import { ATTENDANCE_STATUS } from '@/lib/attendance';
import { APPLICATION_STATUS, JOB_REQUEST_STATUS } from '@/app/api/recruitment/shared';
import { CYCLE_STATUS, EVAL_STATUS } from '@/app/api/evaluations/scoring';
import { RULE_INPUT_STATUSES } from '@/app/api/workforce/_lib/shared';
import { DECISION_INPUT_STATUSES } from '@/app/api/workforce/_lib/saudization-schemas';
import { NITAQAT_ROW_STATUSES } from '@/lib/workforce/nitaqat';
import { PLAN_STATUSES } from '@/lib/workforce/planning';

const ROOT = process.cwd();
const MIGRATION = readFileSync(path.join(ROOT, 'prisma/migrations/9x_db_constraints/migration.sql'), 'utf8');
const SCHEMA = readFileSync(path.join(ROOT, 'prisma/schema.prisma'), 'utf8');

/** "Table.column" -> allowed values, from `ADD CONSTRAINT "T_c_check" CHECK ("c" IN ('A', 'B'))`. */
function checkLists(sql: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const re = /ALTER TABLE "(\w+)" ADD CONSTRAINT "\w+" CHECK \("(\w+)" IN \(([^)]*)\)\)/g;
  for (const m of sql.matchAll(re)) out.set(`${m[1]}.${m[2]}`, [...m[3].matchAll(/'([^']*)'/g)].map((x) => x[1]));
  return out;
}
const CHECKS = checkLists(MIGRATION);
const allowed = (key: string): string[] => {
  const v = CHECKS.get(key);
  if (!v) throw new Error(`no CHECK list for ${key} in 9x_db_constraints`);
  return v;
};

/** Values the code no longer writes but still reads (legacy rows); the database must keep accepting them. */
const LEGACY: Record<string, string[]> = {
  'Loan.status': ['APPROVED'],
  'Deduction.status': ['COMPLETED', 'PENDING_HR_APPROVAL'],
  'Employee.employmentStatus': ['ON_LEAVE'],
};

const CODE: [string, readonly string[]][] = [
  ['TransferRequest.status', Object.values(TRANSFER_STATUS)],
  ['Attendance.status', Object.values(ATTENDANCE_STATUS)],
  ['AttendanceCorrection.status', Object.values(ATTENDANCE_CORRECTION_STATUS)],
  ['Deduction.status', Object.values(DEDUCTION_STATUS)],
  ['Loan.status', Object.values(LOAN_STATUS)],
  ['Settlement.status', Object.values(SETTLEMENT_STATUS)],
  ['Asset.status', Object.values(ASSET_STATUS)],
  ['JobRequest.status', Object.values(JOB_REQUEST_STATUS)],
  ['JobApplication.status', Object.values(APPLICATION_STATUS)],
  ['EmployeeEvaluation.status', Object.values(EVAL_STATUS)],
  ['EvaluationCycle.status', Object.values(CYCLE_STATUS)],
  ['RuleParameter.status', RULE_INPUT_STATUSES],
  ['NitaqatActivity.status', NITAQAT_ROW_STATUSES],
  ['NitaqatCurve.status', NITAQAT_ROW_STATUSES],
  ['HeadcountPlan.status', PLAN_STATUSES],
];

describe('9x_db_constraints: status CHECK lists match the code', () => {
  it('parses one CHECK list per status column of the ARCH-015 baseline (38)', () => {
    expect(CHECKS.size).toBe(38);
  });

  it.each(CODE)('%s: the CHECK list is exactly the code constant plus the documented legacy values', (key, values) => {
    expect([...allowed(key)].sort()).toEqual([...new Set([...values, ...(LEGACY[key] ?? [])])].sort());
  });

  it('LocalizationDecision.status also accepts AMBIGUOUS (written by scripts/seed-nitaqat.mjs)', () => {
    expect([...allowed('LocalizationDecision.status')].sort()).toEqual([...DECISION_INPUT_STATUSES, 'AMBIGUOUS'].sort());
  });

  it('every CHECK names a column that exists as a String in schema.prisma', () => {
    for (const key of CHECKS.keys()) {
      const [model, column] = key.split('.');
      const block = new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, 'm').exec(SCHEMA)?.[1] ?? '';
      expect(block, key).toMatch(new RegExp(`^\\s+${column}\\s+String\\??\\s`, 'm'));
    }
  });

  it('every constraint of 9x is added NOT VALID and validated only when the rows comply', () => {
    const added = [...MIGRATION.matchAll(/ADD CONSTRAINT "(\w+_(?:check|fkey))" (?:CHECK|FOREIGN KEY)[^;]*;/g)];
    const recreated = new Set([...MIGRATION.matchAll(/DROP CONSTRAINT "(\w+)"/g)].map((m) => m[1]));
    for (const m of added) {
      if (recreated.has(m[1])) continue; // Cascade -> Restrict: same FK, existing rows already comply
      expect(m[0], m[1]).toMatch(/NOT VALID;$/);
      expect(MIGRATION, m[1]).toContain(`'${m[1]}'`); // listed in the VALIDATE loop
    }
  });
});

describe('9x_db_constraints: legal history and dead tables', () => {
  const RESTRICTED = ['Attendance', 'AttendancePunch', 'Allowance', 'OvertimeRequest', 'WorkAssignment', 'AttendanceCorrection', 'SalaryChange', 'TransferRequest', 'Visa', 'EmployeeEvaluation'];

  it.each(RESTRICTED)('%s keeps its employee: onDelete Restrict, not Cascade', (model) => {
    const block = new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, 'm').exec(SCHEMA)?.[1] ?? '';
    const rel = /^\s+employee\s+Employee\s+@relation\(([^)]*)\)/m.exec(block)?.[1] ?? '';
    expect(rel).toContain('onDelete: Restrict');
    expect(MIGRATION).toContain(`ADD CONSTRAINT "${model}_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT`);
  });

  it('CompanyDocument is gone from the schema and the migration refuses to drop rows', () => {
    expect(SCHEMA).not.toMatch(/\bCompanyDocument\b/);
    const guard = MIGRATION.indexOf('RAISE EXCEPTION');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(MIGRATION.indexOf('DROP TABLE "CompanyDocument"'));
  });
});
