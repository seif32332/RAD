// BL-PAY-004 acceptance (pay-to-be §25 x-security-financial-change): no single-person path writes a salary or
// an IBAN. The run-time proof is financial-change.it.test.ts (the gateway refuses every direct write; a
// request is decided by a second person). This static half pins WHO may put pay in force:
//   1. the writers of the facts (applyDecision / applyBankIdentity / applyFinancialChange / applyChangeOrderPay)
//      are called only by compensation itself and by the decision letters approved by two people
//      (src/lib/documents/change-orders.ts, BL-PAY-003 note) — never by a route or another module;
//   2. the routes that take pay values from a person (employee create / edit / import, onboarding approval,
//      the portal data update) go through requestFinancialChange and write no pay column;
//   3. the removed single-person writers (editEmployeePay, setInitialAllowances) are gone.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..', '..', '..');
const rel = (p: string) => relative(ROOT, p).replace(/\\/g, '/');
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === 'node_modules' || name.startsWith('.')) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}
const isTest = (p: string) => /\.test\.ts$/.test(p) || p.includes('/__tests__/') || p.startsWith('src/test/');
const CODE = walk(join(ROOT, 'src'))
  .map((p) => ({ path: rel(p), text: readFileSync(p, 'utf8') }))
  .filter((f) => !isTest(f.path));

describe('x-security-financial-change (BL-PAY-004): no single-person path puts pay in force', () => {
  it('the fact writers are called only by compensation and the two-person decision letters', () => {
    const writers = /\b(applyDecision|applyBankIdentity|applyFinancialChange|applyChangeOrderPay)\s*\(/;
    const callers = CODE.filter((f) => writers.test(f.text) && !f.path.startsWith('src/modules/compensation/')).map((f) => f.path);
    expect(callers).toEqual(['src/lib/documents/change-orders.ts']);
    expect(CODE.find((f) => f.path === 'src/lib/documents/change-orders.ts')?.text).not.toMatch(/\b(applyDecision|applyBankIdentity|applyFinancialChange)\s*\(/);
  });

  it('the routes that take pay from a person file a request (the gateway refuses any pay column they would write: financial-change.it)', () => {
    const routes = [
      'src/app/api/employees/route.ts',
      'src/app/api/employees/[id]/route.ts',
      'src/app/api/employees/import/route.ts',
      'src/app/api/incoming-requests/route.ts',
      'src/app/api/portal/correction/route.ts',
    ];
    for (const path of routes) {
      const text = CODE.find((f) => f.path === path)?.text ?? '';
      expect(text, path).toMatch(/\brequestFinancialChange\s*\(/);
    }
  });

  it('the single-person writers of P1-PAY-A are gone', () => {
    expect(CODE.filter((f) => /\b(editEmployeePay|setInitialAllowances)\b/.test(f.text)).map((f) => f.path)).toEqual([]);
  });

  it('a decision is never taken without the second-person rule: decideFinancialChange is the only door from PENDING', () => {
    const transitions = CODE.find((f) => f.path === 'src/modules/compensation/transitions/financial-change.ts')?.text ?? '';
    // Every move out of PENDING goes through runMoneyOperation with the second-person decision.
    expect(transitions).toMatch(/secondPersonDecision\(row, input\.actor, mode\)/);
    expect(transitions.match(/status: 'PENDING' \}/g)?.length ?? 0).toBeGreaterThan(0);
    const writesOutside = CODE.filter((f) => /employeeFinancialChange\.(create|update|updateMany|upsert|delete)/.test(f.text) && !f.path.startsWith('src/modules/compensation/transitions/')).map((f) => f.path);
    expect(writesOutside).toEqual([]);
  });
});
