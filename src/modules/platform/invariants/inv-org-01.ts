// INV-ORG-01 (ARCHITECTURE_INVARIANTS §4.2.1): the department follows the branch and the branch the
// actual company, in every assignment period. Integrity invariant (DEC-PO-120). Rule: checkOrg01 in
// scripts/lib/reconciliation-checks.mjs.
import { checkOrg01 } from '@/lib/reconciliation/checks';
import type { InvariantDefinition } from './types';

export const INV_ORG_01: InvariantDefinition = {
  id: 'INV-ORG-01',
  titleAr: 'القسم يتبع الفرع والفرع يتبع الشركة الفعلية',
  owner: 'org',
  severity: 'BLOCKING',
  integrity: true,
  blocks: ['payroll.approve', 'payroll.export', 'payroll.pay', 'settlement.pay'],
  check: checkOrg01,
  note: 'Measured on the current Employee assignment until AssignmentPeriod readers exist (P3-ORG).',
};
