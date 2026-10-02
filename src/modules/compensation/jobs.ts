// The scheduled job of compensation (P1-FND-JOBS; the job only selects and calls the module, ARCH-008).
//
//   apply-financial-changes  every day after midnight in Riyadh, one company at a time:
//     1. the legacy openings "until no empty row remains" (the pattern of LCY-J1): an employee written
//        outside the application (a seed script, a restored backup) with a salary / an IBAN on his row but
//        no CompensationPeriod / BankIdentityPeriod gets his LEGACY_OPENING from the single writer of 9zg
//        (a new hire of the application has no pay on his row until his financial change is applied, so he
//        is never opened here);
//     2. each EmployeeFinancialChange decided by a second person (PENDING_EFFECT) whose effective date has
//        come is applied through applyFinancialChange (the period opens, the projection follows), each
//        change in its own transaction. Key financialChange.apply:{id}: the job, the payroll run and a
//        retry share it, so a change is applied once.
import { todayKey } from '@/lib/dates';
import type { SystemContext } from '@/modules/iam';
import { audit, type JobDefinition, type JobSummary, type RootClient, type TxClient } from '@/modules/platform';
import { runCompensationTransaction } from './run';
import { callBackfillBankIdentities, callBackfillLegacyCompensation, callMissingOpenings, type LegacyOpeningRow } from './sql/opening';
import { applyFinancialChange } from './transitions/financial-change';

export const APPLY_FINANCIAL_CHANGES_JOB = 'apply-financial-changes';

/** The operation key of applying one change when its date comes (shared by every caller). */
export const dueApplyKey = (changeId: string) => `financialChange.apply:${changeId}`;

/**
 * Applies the decided changes whose effective date has come, of the given companies (null = every
 * company: the payroll run of one company passes its own). Failures are counted per change.
 */
export async function applyDueFinancialChanges(
  db: RootClient,
  companyIds: readonly string[] | null,
  opts: { now?: Date; dryRun?: boolean } = {},
): Promise<JobSummary & { due: number; applied: number; failed: number }> {
  const today = todayKey(opts.now ?? new Date());
  const due = await db.employeeFinancialChange.findMany({
    where: { status: 'PENDING_EFFECT', effectiveDate: { lte: new Date(`${today}T00:00:00.000Z`) }, ...(companyIds ? { companyId: { in: [...companyIds] } } : {}) },
    orderBy: [{ effectiveDate: 'asc' }, { decidedAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
    take: 1000,
  });
  const summary = { due: due.length, applied: 0, failed: 0, failures: [] as { changeId: string; error: string }[] };
  if (opts.dryRun) return { ...summary, dryRun: true };
  for (const c of due) {
    try {
      await runCompensationTransaction(db, (tx) => applyFinancialChange(tx, { changeId: c.id, operationKey: dueApplyKey(c.id), today }));
      summary.applied += 1;
    } catch (err) {
      summary.failed += 1;
      summary.failures.push({ changeId: c.id, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) });
    }
  }
  return summary;
}

/**
 * The legacy openings of one company (idempotent): only when an employee of the company has pay on his
 * row and no fact for it. Returns what was opened (nothing in the normal case).
 */
export async function openMissingCompensation(db: RootClient, companyId: string, opts: { dryRun?: boolean } = {}): Promise<{ missing: number; opened: LegacyOpeningRow[] }> {
  const missing = await callMissingOpenings(db as unknown as TxClient, [companyId]);
  if (!missing || opts.dryRun) return { missing, opened: [] };
  const actor = `job:${APPLY_FINANCIAL_CHANGES_JOB}`;
  const opened = await db.$transaction(
    async (tx) => {
      const rows = [...(await callBackfillLegacyCompensation(tx, [companyId], actor)), ...(await callBackfillBankIdentities(tx, [companyId], actor))];
      await audit(tx, {
        actor: { type: 'SYSTEM', id: APPLY_FINANCIAL_CHANGES_JOB },
        action: 'compensation.legacyOpenings.backfilled',
        entity: { type: 'Company', id: companyId, companyId },
        after: { rows },
        reason: 'Pay on an employee row without its fact (seed / restore): LEGACY_OPENING (ARC-SYS-A3)',
      });
      return rows;
    },
    { timeout: 120_000 },
  );
  return { missing, opened };
}

export const applyFinancialChangesJob: JobDefinition<SystemContext> = {
  name: APPLY_FINANCIAL_CHANGES_JOB,
  description: 'Opens the missing legacy pay facts, then applies the financial changes decided by a second person whose date has come (per company)',
  crossCompany: false,
  run: async (ctx) =>
    ctx.forEachCompany(async (_scope, companyId) => {
      const openings = await openMissingCompensation(ctx.db, companyId, { dryRun: ctx.dryRun });
      const r = await applyDueFinancialChanges(ctx.db, [companyId], { now: ctx.now, dryRun: ctx.dryRun });
      if (r.failed) throw Object.assign(new Error(`${r.failed} financial change(s) could not be applied`), { details: { ...r, openings } });
      return { ...r, openings };
    }),
};
