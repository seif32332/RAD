// INV-DOC-01 (ARCHITECTURE_INVARIANTS §4.2.1): the document chain is intact and the stored files match
// their hashes. Integrity invariant (DEC-PO-120); it blocks issuing documents ("يوقف الإصدار"), not
// payroll. Rule: checkDoc01 in scripts/lib/reconciliation-checks.mjs (same checks as documents-integrity).
import { checkDoc01 } from '@/lib/reconciliation/checks';
import type { InvariantDefinition } from './types';

export const INV_DOC_01: InvariantDefinition = {
  id: 'INV-DOC-01',
  titleAr: 'سلسلة المستندات سليمة وبصمات الملفات مطابقة',
  owner: 'documents',
  severity: 'HIGH',
  integrity: true,
  blocks: ['document.issue'],
  check: checkDoc01,
};
