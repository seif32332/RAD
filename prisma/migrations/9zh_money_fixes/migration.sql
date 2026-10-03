-- 9zh_money_fixes (BL-PAY-027: money fixes that need no workflow engine; AUDIT/15_CTO_HANDOVER.md §8,
-- wfe-money-adapters.md F4 / F6 / F9 / RT-WFE-701 / 710 / 712)
--
-- Order: after 9zg_financial_change; letter 9zh (never 10+).
--
-- Settlement.leavePaidDays (offboarding, a FACT of the settlement): the number of annual-leave days the
-- settlement pays (SettlementBreakdown.leaveDaysToPay), stored when the settlement is created. Payroll
-- excludes the days a LEAVE_SETTLEMENT paid (settlementCoverage) by this count, no longer by dividing
-- leaveCompensation by TODAY's daily rate: after a raise the old division paid part of the leave twice,
-- after a cut it withheld days (AUDIT/15 §8, src/lib/payroll-core.ts settlementCoverage).
--
-- Backfill (idempotent: only NULL rows are touched):
--   no leave compensation             -> 0;
--   the daily rate at creation known  -> leaveCompensation / (workingDaysSalary / workingDaysInMonth),
--                                        both written by computeSettlement from the same daily rate
--                                        (2 decimals; settlementCoverage rounds to whole days as before);
--   otherwise                         -> NULL: a legacy row, settlementCoverage keeps the former formula for
--                                        it; the count is reported by RAISE NOTICE.
-- No other change is a schema change: OvertimeRequest.status (a money column of money.gateway), the
-- loan rejection, the payroll-hub operation keys, the bonus status filter, the settlement maker-checker
-- and the deduction referral are code (BL-PAY-027).
--
-- Rollback: the previous release ignores the column (expand only); drop it to undo.

ALTER TABLE "Settlement" ADD COLUMN IF NOT EXISTS "leavePaidDays" DOUBLE PRECISION;

UPDATE "Settlement"
SET "leavePaidDays" = CASE
  WHEN COALESCE("leaveCompensation", 0) <= 0 THEN 0
  ELSE round(("leaveCompensation" * "workingDaysInMonth" / "workingDaysSalary")::numeric, 2)::double precision
END
WHERE "leavePaidDays" IS NULL
  AND (
    COALESCE("leaveCompensation", 0) <= 0
    OR (COALESCE("workingDaysInMonth", 0) > 0 AND COALESCE("workingDaysSalary", 0) > 0)
  );

ALTER TABLE "Settlement" DROP CONSTRAINT IF EXISTS "Settlement_leavePaidDays_check";
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_leavePaidDays_check" CHECK ("leavePaidDays" IS NULL OR "leavePaidDays" >= 0);

DO $$
DECLARE
  legacy_leave integer;
  legacy_all integer;
BEGIN
  SELECT count(*) FILTER (WHERE "type" = 'LEAVE_SETTLEMENT'), count(*) INTO legacy_leave, legacy_all
  FROM "Settlement" WHERE "leavePaidDays" IS NULL;
  IF legacy_all > 0 THEN
    RAISE NOTICE '9zh_money_fixes: % settlement(s) without a derivable daily rate keep leavePaidDays NULL (% leave settlement(s) whose excluded days still use the former formula)', legacy_all, legacy_leave;
  END IF;
END $$;
