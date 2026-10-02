// A module above platform hands down the check of an invariant it owns (registerInvariantCheck), and a
// check may report findings already explained by a recorded fact (DEC-PO-126, INV-RULE-02). Separate
// file: registration is process-wide, and the registry test expects the phase-0 measured list.
import { describe, expect, it } from 'vitest';
import type { ReconciliationResult } from '@/lib/reconciliation/checks';
import { findingsOf, invariantById, measuredInvariants, registerInvariantCheck, type InvariantCheck } from '@/modules/platform';

const explained = { category: 'ACKNOWLEDGED_BELOW_LEGAL', text: 'إقرار', ref: 'CompanyRuleOverride:o1', by: 'u1' };
const result = (invariant: string, severity: ReconciliationResult['severity']): ReconciliationResult => ({
  invariant,
  check: 'x',
  severity,
  labelAr: 'x',
  labelEn: 'x',
  entityType: 'CompanyRuleOverride',
  count: 1,
  sampleIds: ['o1'],
  byCompany: { c1: 1 },
  detail: {},
  note: '',
  approximation: null,
  entities: [{ id: 'o1', companyId: 'c1', tag: 'K=1', employeeId: null, period: null, explained }],
});

describe('registerInvariantCheck and explained findings', () => {
  it('registers the check of a defined, unmeasured invariant once; refuses unknown ids, measured ones and a second check', () => {
    const check: InvariantCheck = async () => [];
    expect(measuredInvariants().map((d) => d.id)).not.toContain('INV-RULE-02');
    registerInvariantCheck('INV-RULE-02', check);
    registerInvariantCheck('INV-RULE-02', check); // idempotent
    expect(measuredInvariants().map((d) => d.id)).toContain('INV-RULE-02');
    expect(invariantById('INV-RULE-02')?.check).toBe(check);
    expect(() => registerInvariantCheck('INV-RULE-02', async () => [])).toThrow(/already has a registered check/);
    expect(() => registerInvariantCheck('INV-NOPE-01', check)).toThrow(/unknown invariant/);
    expect(() => registerInvariantCheck('INV-ORG-01', check)).toThrow(/already has its check/);
  });

  it('a module-supplied entity list becomes the findings; explained only for a non-integrity, non-blocking invariant', () => {
    const [f] = findingsOf(invariantById('INV-RULE-02')!, [result('INV-RULE-02', 'WARNING')]);
    expect(f).toMatchObject({ ruleId: 'INV-RULE-02', entityId: 'o1', companyId: 'c1', severity: 'WARNING', blocking: false, explained });
    // An integrity invariant never takes a detection-time explanation (DEC-PO-120).
    const [g] = findingsOf(invariantById('INV-ORG-01')!, [result('INV-ORG-01', 'BLOCKING')]);
    expect(g.blocking).toBe(true);
    expect(g.explained).toBeNull();
  });
});
