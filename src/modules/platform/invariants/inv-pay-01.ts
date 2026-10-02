// INV-PAY-01 (ARCHITECTURE_INVARIANTS §4.2.1): the net of every line recomputes from its snapshot to
// the halala. Integrity invariant (DEC-PO-120). Rule: checkPay01 in scripts/lib/reconciliation-checks.mjs.
import { checkPay01 } from '@/lib/reconciliation/checks';
import type { InvariantDefinition } from './types';

export const INV_PAY_01: InvariantDefinition = {
  id: 'INV-PAY-01',
  titleAr: 'صافي كل سطر مسير يساوي إعادة حسابه بالهللة',
  owner: 'payroll',
  severity: 'BLOCKING',
  integrity: true,
  blocks: ['payroll.approve', 'payroll.export', 'payroll.pay', 'settlement.pay'],
  check: checkPay01,
  note: 'The stored Payroll columns are the only snapshot until PayrollSnapshot exists (P1-PAY-A).',
};
