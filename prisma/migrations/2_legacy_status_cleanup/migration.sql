-- 2_legacy_status_cleanup
-- DATA ONLY (no DDL): rewrites legacy workflow status values written by older code to the values
-- the current code writes (src/lib/constants.ts). Every statement is idempotent (it only touches
-- rows still holding a legacy value) and none changes how a row is treated:
--
--   Deduction  'PENDING_HR_APPROVAL' -> 'PENDING_AMOUNT_APPROVAL'
--       Both are in DEDUCTION_PENDING_STATUSES: HR approval (finance.ts approveDeduction) moves
--       either to DEDUCTED, rejection to REJECTED; payroll ignores both.
--   Deduction  'COMPLETED' -> 'DEDUCTED'
--       Both are in DEDUCTION_PAYABLE_STATUSES (payroll deducts them; isLinkedToPayroll, not the
--       status, prevents a second deduction). Objection / waive requests accept both.
--   Loan       'APPROVED' -> 'FINANCE_APPROVED'
--       Both are in LOAN_DEDUCTIBLE_STATUSES (installments deducted by payroll, forgivable,
--       paid off by settlements); the loans page lists both as active.
--   Loan       'PENDING' / 'MANAGER_APPROVED' with isFinanceTransferred = true -> 'FINANCE_TRANSFERRED'
--       Money already transferred (old flow never moved the status): markLoanTransferred refuses
--       them (isFinanceTransferred) and the final confirmation expects FINANCE_TRANSFERRED, so
--       they were stuck and never deducted. FINANCE_TRANSFERRED is deductible and can be confirmed.
--   Loan       'PENDING' / 'MANAGER_APPROVED' with isHrApproved = true -> 'HR_APPROVED'
--       markLoanTransferred already treats these legacy rows as HR_APPROVED; OWNER approval and
--       rejection accept both (LOAN_PENDING_STATUSES).
--   Loan       'PENDING' with isManagerApproved = true (HR not yet) -> 'MANAGER_APPROVED'
--       The HR stage accepts both PENDING and MANAGER_APPROVED; the page already shows the
--       manager step as done from the flag.
--   Settlement 'FINANCE_PROCESSING' -> 'OWNER_APPROVED'
--       Value written by old code after the owner approved (finance paying). The current code
--       only knows OWNER_APPROVED for that step (markSettlementPaid accepts it).

UPDATE "Deduction" SET "status" = 'PENDING_AMOUNT_APPROVAL', "updatedAt" = NOW()
WHERE "status" = 'PENDING_HR_APPROVAL';

UPDATE "Deduction" SET "status" = 'DEDUCTED', "updatedAt" = NOW()
WHERE "status" = 'COMPLETED';

UPDATE "Loan" SET "status" = 'FINANCE_APPROVED', "isFinanceApproved" = TRUE, "updatedAt" = NOW()
WHERE "status" = 'APPROVED';

UPDATE "Loan" SET "status" = 'FINANCE_TRANSFERRED', "updatedAt" = NOW()
WHERE "status" IN ('PENDING', 'MANAGER_APPROVED') AND "isFinanceTransferred" = TRUE;

UPDATE "Loan" SET "status" = 'HR_APPROVED', "updatedAt" = NOW()
WHERE "status" IN ('PENDING', 'MANAGER_APPROVED') AND "isHrApproved" = TRUE AND "isFinanceTransferred" = FALSE;

UPDATE "Loan" SET "status" = 'MANAGER_APPROVED', "updatedAt" = NOW()
WHERE "status" = 'PENDING' AND "isManagerApproved" = TRUE AND "isHrApproved" = FALSE AND "isFinanceTransferred" = FALSE;

UPDATE "Settlement" SET "status" = 'OWNER_APPROVED', "updatedAt" = NOW()
WHERE "status" = 'FINANCE_PROCESSING';
