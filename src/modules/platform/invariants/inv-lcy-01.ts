// INV-LCY-01 (ARCHITECTURE_INVARIANTS §4.2.1): the employment projections equal the latest
// non-superseded EmploymentStateChange (DEC-PO-119). Rule: scripts/lib/reconciliation-checks.mjs
// checkLcy01 (single definition, see ./registry.ts for why it lives there).
import { checkLcy01 } from '@/lib/reconciliation/checks';
import type { InvariantDefinition } from './types';

export const INV_LCY_01: InvariantDefinition = {
  id: 'INV-LCY-01',
  titleAr: 'حالة التوظيف على ملف الموظف تطابق آخر تغيير حالة مسجل',
  owner: 'lifecycle',
  severity: 'HIGH',
  integrity: false,
  // "نعم للمسير": a payroll line is not approved, exported or paid on a contradicted employment state.
  blocks: ['payroll.approve', 'payroll.export', 'payroll.pay'],
  check: checkLcy01,
  note: 'P1-LCY: projection-disagrees-fact measures the rule exactly (latest EmploymentStateChange by seq); the other sub-checks are data-quality readings of the projections.',
};
