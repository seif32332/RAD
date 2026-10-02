// INV-RULE-02 check (ARCHITECTURE_INVARIANTS §4.2.1; DEC-PO-126): every active company override the
// company accepted outside the legal bound (belowLegalAckAt set, not revoked, not ended) is a finding,
// already EXPLAINED by its recorded acknowledgement (reason, who, the legal value it departs from).
// Severity WARNING, blocks nothing. The definition sits in the platform registry; this module owns
// the table (ARCH-001), so the check is handed down with platform.registerInvariantCheck by the
// composition roots (src/jobs/consumers.ts, the integrity route).
//
// Read only: the reconcile snapshot runs it inside a READ ONLY transaction.
import type { InvariantCheck } from '@/modules/platform';
import type { ReconciliationEntity, ReconciliationResult } from '@/lib/reconciliation/checks';

export const INV_RULE_02_ID = 'INV-RULE-02';
export const BELOW_LEGAL_CHECK = 'belowLegalOverride';
export const BELOW_LEGAL_CATEGORY = 'ACKNOWLEDGED_BELOW_LEGAL';
const SAMPLE_SIZE = 20;
const NO_COMPANY = '(none)';

type OverrideDb = {
  companyRuleOverride: {
    findMany(args: unknown): Promise<
      Array<{ id: string; companyId: string; key: string; value: number; belowLegalAckById: string | null; belowLegalReason: string | null; belowLegalLegalValue: number | null }>
    >;
  };
};

/** The findings of INV-RULE-02 on `today` ('YYYY-MM-DD' of the run by default). */
export async function belowLegalOverrideResults(db: OverrideDb, today: Date = new Date()): Promise<ReconciliationResult[]> {
  const day = new Date(`${today.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const rows = await db.companyRuleOverride.findMany({
    where: { belowLegalAckAt: { not: null }, revokedAt: null, OR: [{ effectiveTo: null }, { effectiveTo: { gt: day } }] },
    select: { id: true, companyId: true, key: true, value: true, belowLegalAckById: true, belowLegalReason: true, belowLegalLegalValue: true },
    orderBy: { id: 'asc' },
  });
  const entities: ReconciliationEntity[] = rows.map((r) => ({
    id: r.id,
    companyId: r.companyId,
    // A new value is a new observation: reconcile records it again (still EXPLAINED by the new acknowledgement).
    tag: `${r.key}=${r.value}`,
    employeeId: null,
    period: null,
    explained: {
      category: BELOW_LEGAL_CATEGORY,
      text: `إقرار الشركة بقيمة ${r.value} خلافاً للقيمة النظامية ${r.belowLegalLegalValue ?? '?'} للقاعدة ${r.key}: ${r.belowLegalReason ?? ''}`.trim(),
      ref: `CompanyRuleOverride:${r.id}`,
      by: r.belowLegalAckById ?? 'system',
    },
  }));
  const byCompany: Record<string, number> = {};
  const detail: Record<string, number> = {};
  for (const r of rows) {
    const k = r.companyId || NO_COMPANY;
    byCompany[k] = (byCompany[k] ?? 0) + 1;
    detail[r.key] = (detail[r.key] ?? 0) + 1;
  }
  return [
    {
      invariant: INV_RULE_02_ID,
      check: BELOW_LEGAL_CHECK,
      severity: 'WARNING',
      labelAr: 'قيمة شركة نافذة خارج الحد النظامي بإقرار',
      labelEn: 'Active company override outside the legal bound, acknowledged',
      entityType: 'CompanyRuleOverride',
      count: rows.length,
      sampleIds: rows.slice(0, SAMPLE_SIZE).map((r) => r.id),
      byCompany,
      detail,
      note: 'DEC-PO-126: accepted with an acknowledgement; recorded EXPLAINED, blocks nothing.',
      approximation: null,
      entities,
    },
  ];
}

/** The InvariantCheck handed to platform.registerInvariantCheck(INV_RULE_02_ID, …). */
export const belowLegalOverrideCheck: InvariantCheck = (db) => belowLegalOverrideResults(db as OverrideDb);
