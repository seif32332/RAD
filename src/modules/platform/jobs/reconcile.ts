// reconcile: the scheduled run of the invariant engine (P1-FND-INV; ARCHITECTURE_INVARIANTS §4.3
// rule 1), as the header of ../invariants/reconcile.ts prescribes: ONE read-only snapshot, then the
// results recorded company by company (the runner's forEachCompany: one SystemContext per company),
// then the tenant-level pass (findings without a company). A company whose recording fails does not
// stop the others (the run is then FAILED). Dry run: the snapshot only, nothing is written.
import { recordInvariantResults, takeInvariantSnapshot, TENANT_LEVEL } from '../invariants/reconcile';
import type { JobDefinition, JobSummary } from './runner';

export const RECONCILE_JOB = 'reconcile';

export function createReconcileJob<S>(): JobDefinition<S> {
  return {
    name: RECONCILE_JOB,
    description: 'Runs every measured invariant in one read-only snapshot and records the discrepancies company by company',
    crossCompany: false,
    async run(ctx): Promise<JobSummary> {
      const snap = await takeInvariantSnapshot(ctx.db, { trigger: 'SCHEDULED', uploadDir: ctx.env.UPLOAD_DIR });
      const failedInvariants = snap.outcomes.filter((o) => o.status === 'FAILED').map((o) => o.ruleId);
      const findingsByCompany: Record<string, number> = {};
      for (const f of snap.outcomes.flatMap((o) => o.findings)) {
        const key = f.companyId ?? TENANT_LEVEL;
        findingsByCompany[key] = (findingsByCompany[key] ?? 0) + 1;
      }
      const base = { runId: snap.runId, invariants: snap.outcomes.length, failedInvariants, findings: Object.values(findingsByCompany).reduce((a, b) => a + b, 0) };
      if (ctx.dryRun) return { ...base, dryRun: true, findingsByCompany };

      const byCompany = await ctx.forEachCompany((_scope, companyId) => recordInvariantResults(ctx.db, snap, { companyId }));
      const tenantLevel = await recordInvariantResults(ctx.db, snap, { companyId: null });
      const counts = (r: { found: number; opened: number; reopened: number; autoClosed: number }) => ({ found: r.found, opened: r.opened, reopened: r.reopened, autoClosed: r.autoClosed });
      const summary = {
        ...base,
        companies: Object.keys(byCompany).length,
        byCompany: Object.fromEntries(Object.entries(byCompany).map(([id, r]) => [id, counts(r)])),
        [TENANT_LEVEL]: counts(tenantLevel),
      };
      // A check that could not run is recorded (InvariantRun FAILED) and fails the job, so ops see it.
      if (failedInvariants.length) throw new Error(`invariant checks failed: ${failedInvariants.join(', ')} (results of the others are recorded, run ${snap.runId})`);
      return summary;
    },
  };
}
