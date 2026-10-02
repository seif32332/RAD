// INV-PAY-02 (ARCHITECTURE_INVARIANTS §4.2.1): every approved money item is linked to exactly one line
// or one settlement: no orphan, no duplicate. Integrity invariant (DEC-PO-120). Rule: checkPay02 in
// scripts/lib/reconciliation-checks.mjs.
import { checkPay02 } from '@/lib/reconciliation/checks';
import type { InvariantDefinition } from './types';

export const INV_PAY_02: InvariantDefinition = {
  id: 'INV-PAY-02',
  titleAr: 'كل بند مالي معتمد مرتبط بسطر واحد أو تسوية واحدة',
  owner: 'payroll',
  severity: 'BLOCKING',
  integrity: true,
  blocks: ['payroll.approve', 'payroll.export', 'payroll.pay', 'settlement.pay'],
  check: checkPay02,
  note: 'Measured on the existing link columns until the UNIQUE link table exists (P1-PAY-A).',
};
