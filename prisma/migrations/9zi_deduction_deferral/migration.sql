-- 9zi_deduction_deferral (BL-PAY-030, RT-WFE-744: payroll recorded deductions larger than the available
-- pay as collected; wfe-money-adapters.md stays a frozen baseline, DEC-PO-139, nothing of it is built here)
--
-- Order: after 9zh_money_fixes; letter 9zi (never 10+).
--
-- Deduction.deferredPayrollMonth ('YYYY-MM', payroll's column): the latest payroll month whose generation
-- offered the deduction but could not fit it whole in the employee's line (src/lib/payroll-core.ts
-- takeDeductions). Such a deduction is not reserved (payrollMonth stays NULL), so the month's approval
-- never links it; the column keeps it eligible for the next generated month, past the filter that drops
-- deductions approved before their month's payroll was generated (src/lib/payroll.ts). NULL = never
-- deferred. Written only by payroll.month.generate / payroll.line.regenerate (money.gateway writes).
--
-- Backfill: none. Before this release no deduction was ever deferred (every reserved deduction was
-- linked on approval), so NULL is the true value for every existing row. Deductions an approved month
-- linked without taking them (the bug) are not repaired here: that is a data decision, not a schema one.
--
-- Rollback: the previous release ignores the column (expand only); drop it to undo.

ALTER TABLE "Deduction" ADD COLUMN IF NOT EXISTS "deferredPayrollMonth" TEXT;
