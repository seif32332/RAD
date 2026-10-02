// INV-RULE-02 (ARCHITECTURE_INVARIANTS §4.2.1; DEC-PO-126): every active company override outside the
// legal bound of its key is reported, as an EXPLAINED discrepancy (the company's recorded
// acknowledgement explains it) that blocks nothing. Policy invariant, severity WARNING.
//
// The check reads CompanyRuleOverride, owned by rules (ARCH-001): it lives in src/modules/rules
// (belowLegalOverrideCheck) and is handed down with registerInvariantCheck by the composition roots
// (src/jobs/consumers.ts for the reconcile job, the integrity route for a manual run).
import type { InvariantDefinition } from './types';

export const INV_RULE_02: InvariantDefinition = {
  id: 'INV-RULE-02',
  titleAr: 'كل قيمة شركة خارج الحد النظامي مُقرّة ومبلَّغ بها',
  owner: 'rules',
  severity: 'WARNING',
  integrity: false,
  blocks: [],
  expectedCategories: ['ACKNOWLEDGED_BELOW_LEGAL'],
  note: 'Check registered by the rules module (registerInvariantCheck); findings are recorded EXPLAINED by the acknowledgement.',
};
