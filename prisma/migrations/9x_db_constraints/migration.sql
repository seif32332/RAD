-- 9x_db_constraints (P1-FND-DB; AUDIT/13_MASTER_PLAN.md phase 1, AUDIT/05_DATABASE_AUDIT.md K-2, EV-11016, EV-11021)
--
-- Owning module: platform (schema hygiene); every table keeps its owner (DOMAIN_BOUNDARIES 5.2).
-- Source of truth: unchanged. This migration adds no fact; it makes the database refuse values and
-- references the code already treats as impossible (ARCH-015, DOMAIN_MODEL 1.5).
-- Transition: none. Temporal effect: none. Scope contract: unchanged (company keys of JobRequest,
-- OnboardingRequest, MuqeemTransaction, HeadcountPlan now reference Company).
--
-- Safe on every tenant database (it runs on deploy):
--   * Status CHECKs are added NOT VALID (enforced for every new or updated row at once) and then
--     validated only when the existing rows already satisfy them (part 5). A tenant holding a value
--     outside the list keeps the CHECK NOT VALID and gets a NOTICE; the reconciliation job lists
--     those rows (P1-FND-INV). The allowed lists include the legacy values the code still reads
--     (Loan 'APPROVED', Deduction 'COMPLETED' / 'PENDING_HR_APPROVAL', Asset 'RETURNED',
--     Employee 'ON_LEAVE'), so no row the application understands is refused.
--   * New foreign keys: a nullable reference that points at nothing (orphan) is set to NULL first;
--     the old value is kept in AuditLog (one row per change, deterministic id) and counted in a
--     NOTICE. The one NOT NULL reference (TransferRequest.toBranchId) is never rewritten: its FK is
--     added NOT VALID and validated only when no orphan exists.
--   * Cascade -> Restrict on legal history: the FK is recreated with ON DELETE RESTRICT; no row changes.
--   * CompanyDocument (dead, DOMAIN_BOUNDARIES 5.2 "gov"): dropped only when empty; a tenant with
--     rows stops here with an explanation instead of losing data.
--
-- Idempotent in effect: every data step only touches rows still in the bad state.

-- ---------------------------------------------------------------------------------------------
-- 1. CompanyDocument: refuse to drop data, then drop the dead table.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  n integer;
BEGIN
  SELECT COUNT(*) INTO n FROM "CompanyDocument";
  IF n > 0 THEN
    RAISE EXCEPTION '9x_db_constraints: CompanyDocument holds % row(s). The table is dead (no code reads or writes it, AUDIT EV-11016) and is dropped by this migration. Export the rows (for example COPY "CompanyDocument" TO a CSV file), keep them with the company records, DELETE them, then run "prisma migrate resolve --rolled-back 9x_db_constraints" and deploy again.', n;
  END IF;
END $$;

DROP TABLE "CompanyDocument";

-- ---------------------------------------------------------------------------------------------
-- 2. Status columns get a closed list of values (ARCH-015). Allowed values come from the code that writes the column;
--    the source of each list is in the comment above it. NULL passes a CHECK, so optional columns
--    (Visa.ticketStatus, Deduction.objectionStatus) keep NULL.
-- ---------------------------------------------------------------------------------------------

-- Employee.employmentStatus: writers: leaves/[id]/action, finance.ts (EXCLUDED); default ACTIVE; ON_LEAVE legacy, reset by 9s, still documented
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_employmentStatus_check" CHECK ("employmentStatus" IN ('ACTIVE', 'ON_LEAVE', 'EXCLUDED')) NOT VALID;

-- TransferRequest.status: TRANSFER_STATUS (src/lib/constants.ts)
ALTER TABLE "TransferRequest" ADD CONSTRAINT "TransferRequest_status_check" CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED')) NOT VALID;

-- Attendance.status: ATTENDANCE_STATUS (src/lib/attendance.ts)
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_status_check" CHECK ("status" IN ('PRESENT', 'ABSENT')) NOT VALID;

-- Visa.ticketStatus: settlements route (PENDING), visas/action (BOOKED); NULL allowed
ALTER TABLE "Visa" ADD CONSTRAINT "Visa_ticketStatus_check" CHECK ("ticketStatus" IN ('BOOKED', 'PENDING')) NOT VALID;

-- PromissoryNote.status: NOTE_STATUS (legal/promissory-notes/[id])
ALTER TABLE "PromissoryNote" ADD CONSTRAINT "PromissoryNote_status_check" CHECK ("status" IN ('ACTIVE', 'PAID', 'CANCELLED')) NOT VALID;

-- LegalContract.status: CONTRACT_STATUSES (legal/contracts/[id])
ALTER TABLE "LegalContract" ADD CONSTRAINT "LegalContract_status_check" CHECK ("status" IN ('ACTIVE', 'EXPIRED', 'TERMINATED')) NOT VALID;

-- Lawsuit.status: LAWSUIT_STATUS (legal/lawsuits)
ALTER TABLE "Lawsuit" ADD CONSTRAINT "Lawsuit_status_check" CHECK ("status" IN ('REFERRED', 'CLOSED')) NOT VALID;

-- OvertimeRequest.status: payroll-hub OvertimeStatusPayload, incoming-requests SIMPLE_STATUS
ALTER TABLE "OvertimeRequest" ADD CONSTRAINT "OvertimeRequest_status_check" CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED')) NOT VALID;

-- WorkAssignment.status: payroll-hub zod enum, manager-portal
ALTER TABLE "WorkAssignment" ADD CONSTRAINT "WorkAssignment_status_check" CHECK ("status" IN ('PENDING_EMPLOYEE', 'PENDING_HR', 'APPROVED', 'REJECTED')) NOT VALID;

-- Deduction.status: DEDUCTION_STATUS + legacy COMPLETED / PENDING_HR_APPROVAL still read (DEDUCTION_PAYABLE_STATUSES, DEDUCTION_PENDING_STATUSES)
ALTER TABLE "Deduction" ADD CONSTRAINT "Deduction_status_check" CHECK ("status" IN ('DEDUCTED', 'PENDING_AMOUNT_APPROVAL', 'PENDING_WAIVE_APPROVAL', 'WAIVED', 'PENDING_INVESTIGATION', 'UNDER_INVESTIGATION', 'OBJECTION_SUBMITTED', 'OBJECTION_REJECTED', 'REJECTED', 'COMPLETED', 'PENDING_HR_APPROVAL')) NOT VALID;

-- Deduction.objectionStatus: payroll-hub OBJECT / ResolveObjectionPayload; NULL allowed
ALTER TABLE "Deduction" ADD CONSTRAINT "Deduction_objectionStatus_check" CHECK ("objectionStatus" IN ('PENDING', 'ACCEPTED', 'REJECTED')) NOT VALID;

-- Investigation.status: INV_STATUS (legal/investigations)
ALTER TABLE "Investigation" ADD CONSTRAINT "Investigation_status_check" CHECK ("status" IN ('OPENED', 'IN_PROGRESS', 'SUSPENDED', 'COMPLETED_GUILTY', 'COMPLETED_INNOCENT', 'CLOSED')) NOT VALID;

-- Loan.status: LOAN_STATUS + legacy APPROVED still read (LOAN_DEDUCTIBLE_STATUSES)
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_status_check" CHECK ("status" IN ('PENDING', 'MANAGER_APPROVED', 'HR_APPROVED', 'FINANCE_APPROVED', 'FINANCE_TRANSFERRED', 'COMPLETED', 'FORGIVEN', 'REJECTED', 'APPROVED')) NOT VALID;

-- ComplianceViolation.status: VIOLATION_STATUS (compliance route)
ALTER TABLE "ComplianceViolation" ADD CONSTRAINT "ComplianceViolation_status_check" CHECK ("status" IN ('PENDING_PAYMENT', 'CORRECTED', 'PAID')) NOT VALID;

-- AttendanceCorrection.status: ATTENDANCE_CORRECTION_STATUS
ALTER TABLE "AttendanceCorrection" ADD CONSTRAINT "AttendanceCorrection_status_check" CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED')) NOT VALID;

-- JobRequest.status: JOB_REQUEST_STATUS (recruitment/shared)
ALTER TABLE "JobRequest" ADD CONSTRAINT "JobRequest_status_check" CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED', 'FULFILLED')) NOT VALID;

-- JobApplication.status: APPLICATION_STATUS (recruitment/shared)
ALTER TABLE "JobApplication" ADD CONSTRAINT "JobApplication_status_check" CHECK ("status" IN ('APPLIED', 'INTERVIEW', 'OFFERED', 'HIRED', 'REJECTED')) NOT VALID;

-- OnboardingRequest.status: incoming-requests SIMPLE_STATUS
ALTER TABLE "OnboardingRequest" ADD CONSTRAINT "OnboardingRequest_status_check" CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED')) NOT VALID;

-- Asset.status: ASSET_STATUS (RETURNED legacy, still read)
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_status_check" CHECK ("status" IN ('ACTIVE', 'VACANT', 'RETURNED', 'DAMAGED', 'TRANSFERRED')) NOT VALID;

-- Settlement.status: SETTLEMENT_STATUS
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_status_check" CHECK ("status" IN ('PENDING_APPROVAL', 'OWNER_APPROVED', 'PAID', 'REJECTED')) NOT VALID;

-- TerminationRequest.status: incoming-requests SIMPLE_STATUS, portal/termination
ALTER TABLE "TerminationRequest" ADD CONSTRAINT "TerminationRequest_status_check" CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED')) NOT VALID;

-- CertifiedAgency.status: legal/agencies (ACTIVE) + documented set
ALTER TABLE "CertifiedAgency" ADD CONSTRAINT "CertifiedAgency_status_check" CHECK ("status" IN ('ACTIVE', 'EXPIRED', 'CANCELLED')) NOT VALID;

-- Circular.status: CIRCULAR_STATUSES (owner-portal/circulars)
ALTER TABLE "Circular" ADD CONSTRAINT "Circular_status_check" CHECK ("status" IN ('PUBLISHED', 'DRAFT')) NOT VALID;

-- OwnerRequest.status: OWNER_REQUEST_STATUSES + incoming-requests (REJECTED)
ALTER TABLE "OwnerRequest" ADD CONSTRAINT "OwnerRequest_status_check" CHECK ("status" IN ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'REJECTED')) NOT VALID;

-- EvaluationCycle.status: CYCLE_STATUS (evaluations/scoring)
ALTER TABLE "EvaluationCycle" ADD CONSTRAINT "EvaluationCycle_status_check" CHECK ("status" IN ('OPEN', 'IN_PROGRESS', 'CLOSED')) NOT VALID;

-- EmployeeEvaluation.status: EVAL_STATUS (evaluations/scoring)
ALTER TABLE "EmployeeEvaluation" ADD CONSTRAINT "EmployeeEvaluation_status_check" CHECK ("status" IN ('DRAFT', 'PENDING_MANAGER', 'PENDING_APPROVAL', 'RETURNED', 'PENDING_EMPLOYEE_ACK', 'CLOSED', 'CANCELLED')) NOT VALID;

-- AssetRequest.status: ASSET_REQUEST_STATUS (incoming-requests)
ALTER TABLE "AssetRequest" ADD CONSTRAINT "AssetRequest_status_check" CHECK ("status" IN ('PENDING_HR', 'PENDING_OWNER', 'PENDING_PURCHASING', 'COMPLETED', 'REJECTED')) NOT VALID;

-- JobRun.status: scripts/jobs.mjs runJob
ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_status_check" CHECK ("status" IN ('RUNNING', 'SUCCEEDED', 'FAILED')) NOT VALID;

-- NotificationOutbox.status: scripts/jobs.mjs outbox dispatcher (EXPIRED from OUTBOX_TTL_HOURS)
ALTER TABLE "NotificationOutbox" ADD CONSTRAINT "NotificationOutbox_status_check" CHECK ("status" IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'UNKNOWN', 'EXPIRED')) NOT VALID;

-- MuqeemTransaction.status: MUQEEM_TX_STATUS (src/lib/muqeem/transactions.ts)
ALTER TABLE "MuqeemTransaction" ADD CONSTRAINT "MuqeemTransaction_status_check" CHECK ("status" IN ('PENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN')) NOT VALID;

-- RuleParameter.status: RULE_INPUT_STATUSES (workforce/_lib/shared)
ALTER TABLE "RuleParameter" ADD CONSTRAINT "RuleParameter_status_check" CHECK ("status" IN ('VERIFIED_PRIMARY', 'CORROBORATED_SECONDARY', 'PROVISIONAL', 'CONFLICTING', 'USER_INPUT')) NOT VALID;

-- DocumentRequest.status: src/lib/documents/service.ts
ALTER TABLE "DocumentRequest" ADD CONSTRAINT "DocumentRequest_status_check" CHECK ("status" IN ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'ISSUED', 'REJECTED', 'CANCELLED')) NOT VALID;

-- DocumentRenderJob.status: src/lib/documents/service.ts (BLOCKED when the renderer refuses)
ALTER TABLE "DocumentRenderJob" ADD CONSTRAINT "DocumentRenderJob_status_check" CHECK ("status" IN ('QUEUED', 'RENDERING', 'FAILED', 'DONE', 'BLOCKED')) NOT VALID;

-- IssuedDocument.status: src/lib/documents/service.ts
ALTER TABLE "IssuedDocument" ADD CONSTRAINT "IssuedDocument_status_check" CHECK ("status" IN ('ISSUED', 'REVOKED', 'SUPERSEDED')) NOT VALID;

-- NitaqatActivity.status: NITAQAT_ROW_STATUSES, scripts/seed-nitaqat.mjs
ALTER TABLE "NitaqatActivity" ADD CONSTRAINT "NitaqatActivity_status_check" CHECK ("status" IN ('VERIFIED_PRIMARY', 'AMBIGUOUS', 'PROVISIONAL', 'USER_INPUT')) NOT VALID;

-- NitaqatCurve.status: NITAQAT_ROW_STATUSES, scripts/seed-nitaqat.mjs
ALTER TABLE "NitaqatCurve" ADD CONSTRAINT "NitaqatCurve_status_check" CHECK ("status" IN ('VERIFIED_PRIMARY', 'AMBIGUOUS', 'PROVISIONAL', 'USER_INPUT')) NOT VALID;

-- LocalizationDecision.status: DECISION_INPUT_STATUSES + scripts/seed-nitaqat.mjs (AMBIGUOUS)
ALTER TABLE "LocalizationDecision" ADD CONSTRAINT "LocalizationDecision_status_check" CHECK ("status" IN ('VERIFIED_PRIMARY', 'PARTIAL', 'PROVISIONAL', 'USER_INPUT', 'AMBIGUOUS')) NOT VALID;

-- HeadcountPlan.status: PLAN_STATUSES (src/lib/workforce/planning.ts)
ALTER TABLE "HeadcountPlan" ADD CONSTRAINT "HeadcountPlan_status_check" CHECK ("status" IN ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'ARCHIVED')) NOT VALID;

-- ---------------------------------------------------------------------------------------------
-- 3. Legal history keeps its employee: ON DELETE CASCADE -> RESTRICT (DOMAIN_MODEL 1.5, EV-11007).
--    No code path deletes an employee; this makes the database refuse it too. FaceProfile keeps
--    CASCADE (biometric data must go with the person, PDPL).
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "Attendance" DROP CONSTRAINT "Attendance_employeeId_fkey";
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AttendancePunch" DROP CONSTRAINT "AttendancePunch_employeeId_fkey";
ALTER TABLE "AttendancePunch" ADD CONSTRAINT "AttendancePunch_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Allowance" DROP CONSTRAINT "Allowance_employeeId_fkey";
ALTER TABLE "Allowance" ADD CONSTRAINT "Allowance_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OvertimeRequest" DROP CONSTRAINT "OvertimeRequest_employeeId_fkey";
ALTER TABLE "OvertimeRequest" ADD CONSTRAINT "OvertimeRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "WorkAssignment" DROP CONSTRAINT "WorkAssignment_employeeId_fkey";
ALTER TABLE "WorkAssignment" ADD CONSTRAINT "WorkAssignment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AttendanceCorrection" DROP CONSTRAINT "AttendanceCorrection_employeeId_fkey";
ALTER TABLE "AttendanceCorrection" ADD CONSTRAINT "AttendanceCorrection_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SalaryChange" DROP CONSTRAINT "SalaryChange_employeeId_fkey";
ALTER TABLE "SalaryChange" ADD CONSTRAINT "SalaryChange_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TransferRequest" DROP CONSTRAINT "TransferRequest_employeeId_fkey";
ALTER TABLE "TransferRequest" ADD CONSTRAINT "TransferRequest_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Visa" DROP CONSTRAINT "Visa_employeeId_fkey";
ALTER TABLE "Visa" ADD CONSTRAINT "Visa_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "EmployeeEvaluation" DROP CONSTRAINT "EmployeeEvaluation_employeeId_fkey";
ALTER TABLE "EmployeeEvaluation" ADD CONSTRAINT "EmployeeEvaluation_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- 4. Textual references and actor columns become foreign keys (DOMAIN_MODEL 1.5).
-- 4a. Orphans of nullable references are set to NULL; the old value goes to AuditLog.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION "_9x_null_orphans"(tbl text, col text, parent text, rowkey text DEFAULT 't."id"') RETURNS void AS $fn$
DECLARE
  n integer;
BEGIN
  EXECUTE format(
    'WITH orphan AS (
       SELECT t.ctid AS row_ctid, %6$s AS row_key, t.%2$I AS old FROM %1$I t
        WHERE t.%2$I IS NOT NULL AND NOT EXISTS (SELECT 1 FROM %3$I p WHERE p."id" = t.%2$I)
     ), cleared AS (
       UPDATE %1$I t SET %2$I = NULL FROM orphan o WHERE t.ctid = o.row_ctid RETURNING 1
     ), logged AS (
       INSERT INTO "AuditLog" ("id", "userId", "action", "entityType", "entityId", "details", "ipAddress", "createdAt")
       SELECT %4$L || o.row_key, NULL, %5$L, %1$L, o.row_key,
              json_build_object(''event'', ''ORPHAN_REFERENCE_CLEARED'', ''migration'', ''9x_db_constraints'', ''column'', %2$L, ''references'', %3$L, ''from'', o.old, ''to'', NULL)::text,
              NULL, NOW()
         FROM orphan o
       ON CONFLICT ("id") DO NOTHING
       RETURNING 1
     )
     SELECT COUNT(*) FROM cleared',
    tbl, col, parent, 'mig-9x-orphan-' || tbl || '-' || col || '-', 'UPDATE', rowkey)
  INTO n;
  IF n > 0 THEN
    RAISE NOTICE '9x_db_constraints: %.% had % reference(s) to a missing % row, set to NULL (old values in AuditLog)', tbl, col, n, parent;
  END IF;
END;
$fn$ LANGUAGE plpgsql;

SELECT "_9x_null_orphans"('PaymentRequest', 'requestedById', 'User');
SELECT "_9x_null_orphans"('PaymentRequest', 'approvedById', 'User');
SELECT "_9x_null_orphans"('PaymentRequest', 'paidById', 'User');
SELECT "_9x_null_orphans"('SalaryChange', 'createdById', 'User');
SELECT "_9x_null_orphans"('HeadcountPlan', 'createdById', 'User');
SELECT "_9x_null_orphans"('HeadcountPlan', 'decidedById', 'User');
SELECT "_9x_null_orphans"('AttendancePunch', 'reviewedById', 'User');
SELECT "_9x_null_orphans"('EvaluationApproval', 'approverId', 'User');
SELECT "_9x_null_orphans"('RuleParameter', 'createdById', 'User');
SELECT "_9x_null_orphans"('NitaqatCurve', 'createdById', 'User');
SELECT "_9x_null_orphans"('LocalizationDecision', 'createdById', 'User');
SELECT "_9x_null_orphans"('WorkforceCalculation', 'createdById', 'User');
SELECT "_9x_null_orphans"('WorkforceAssumption', 'updatedById', 'User');
SELECT "_9x_null_orphans"('UserCompanyScope', 'createdById', 'User', 't."userId" || '':'' || t."companyId"');
SELECT "_9x_null_orphans"('MuqeemTransaction', 'requestedById', 'User');
SELECT "_9x_null_orphans"('TransferRequest', 'requesterId', 'Employee');
SELECT "_9x_null_orphans"('OvertimeRequest', 'supervisorId', 'Employee');
SELECT "_9x_null_orphans"('WorkAssignment', 'supervisorId', 'Employee');
SELECT "_9x_null_orphans"('EmployeeEvaluation', 'managerId', 'Employee');
SELECT "_9x_null_orphans"('MuqeemTransaction', 'employeeId', 'Employee');
SELECT "_9x_null_orphans"('OnboardingRequest', 'directManagerId', 'Employee');
SELECT "_9x_null_orphans"('Allowance', 'paidInPayrollId', 'Payroll');
SELECT "_9x_null_orphans"('OvertimeRequest', 'paidInPayrollId', 'Payroll');
SELECT "_9x_null_orphans"('OvertimeRequest', 'paidInSettlementId', 'Settlement');
SELECT "_9x_null_orphans"('JobRequest', 'companyId', 'Company');
SELECT "_9x_null_orphans"('OnboardingRequest', 'companyId', 'Company');
SELECT "_9x_null_orphans"('MuqeemTransaction', 'companyId', 'Company');
SELECT "_9x_null_orphans"('HeadcountPlan', 'companyId', 'Company');
SELECT "_9x_null_orphans"('TransferRequest', 'fromBranchId', 'Branch');
SELECT "_9x_null_orphans"('OnboardingRequest', 'branchId', 'Branch');
SELECT "_9x_null_orphans"('OnboardingRequest', 'administrationId', 'Administration');
SELECT "_9x_null_orphans"('OnboardingRequest', 'departmentId', 'Department');
SELECT "_9x_null_orphans"('OnboardingRequest', 'jobApplicationId', 'JobApplication');
SELECT "_9x_null_orphans"('HeadcountPlan', 'basedOnId', 'HeadcountPlan');
SELECT "_9x_null_orphans"('AttendancePunch', 'locationId', 'AttendanceLocation');

DROP FUNCTION "_9x_null_orphans"(text, text, text, text);

-- The NOT NULL reference is never rewritten: count its orphans (the FK below stays NOT VALID then).
DO $$
DECLARE
  n integer;
BEGIN
  SELECT COUNT(*) INTO n FROM "TransferRequest" t WHERE NOT EXISTS (SELECT 1 FROM "Branch" b WHERE b."id" = t."toBranchId");
  IF n > 0 THEN
    RAISE NOTICE '9x_db_constraints: % TransferRequest row(s) point at a missing destination branch (toBranchId); the foreign key stays NOT VALID for reconciliation', n;
  END IF;
END $$;

-- ---------------------------------------------------------------------------------------------
-- 4b. The foreign keys (NOT VALID here, validated in part 5).
-- ---------------------------------------------------------------------------------------------

ALTER TABLE "PaymentRequest" ADD CONSTRAINT "PaymentRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "PaymentRequest" ADD CONSTRAINT "PaymentRequest_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "PaymentRequest" ADD CONSTRAINT "PaymentRequest_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "SalaryChange" ADD CONSTRAINT "SalaryChange_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "HeadcountPlan" ADD CONSTRAINT "HeadcountPlan_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "HeadcountPlan" ADD CONSTRAINT "HeadcountPlan_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "AttendancePunch" ADD CONSTRAINT "AttendancePunch_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "EvaluationApproval" ADD CONSTRAINT "EvaluationApproval_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "RuleParameter" ADD CONSTRAINT "RuleParameter_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "NitaqatCurve" ADD CONSTRAINT "NitaqatCurve_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "LocalizationDecision" ADD CONSTRAINT "LocalizationDecision_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "WorkforceCalculation" ADD CONSTRAINT "WorkforceCalculation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "WorkforceAssumption" ADD CONSTRAINT "WorkforceAssumption_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "UserCompanyScope" ADD CONSTRAINT "UserCompanyScope_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "MuqeemTransaction" ADD CONSTRAINT "MuqeemTransaction_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "TransferRequest" ADD CONSTRAINT "TransferRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "OvertimeRequest" ADD CONSTRAINT "OvertimeRequest_supervisorId_fkey" FOREIGN KEY ("supervisorId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "WorkAssignment" ADD CONSTRAINT "WorkAssignment_supervisorId_fkey" FOREIGN KEY ("supervisorId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "EmployeeEvaluation" ADD CONSTRAINT "EmployeeEvaluation_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "MuqeemTransaction" ADD CONSTRAINT "MuqeemTransaction_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "OnboardingRequest" ADD CONSTRAINT "OnboardingRequest_directManagerId_fkey" FOREIGN KEY ("directManagerId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "Allowance" ADD CONSTRAINT "Allowance_paidInPayrollId_fkey" FOREIGN KEY ("paidInPayrollId") REFERENCES "Payroll"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "OvertimeRequest" ADD CONSTRAINT "OvertimeRequest_paidInPayrollId_fkey" FOREIGN KEY ("paidInPayrollId") REFERENCES "Payroll"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "OvertimeRequest" ADD CONSTRAINT "OvertimeRequest_paidInSettlementId_fkey" FOREIGN KEY ("paidInSettlementId") REFERENCES "Settlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "JobRequest" ADD CONSTRAINT "JobRequest_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "OnboardingRequest" ADD CONSTRAINT "OnboardingRequest_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "MuqeemTransaction" ADD CONSTRAINT "MuqeemTransaction_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "HeadcountPlan" ADD CONSTRAINT "HeadcountPlan_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "TransferRequest" ADD CONSTRAINT "TransferRequest_fromBranchId_fkey" FOREIGN KEY ("fromBranchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "TransferRequest" ADD CONSTRAINT "TransferRequest_toBranchId_fkey" FOREIGN KEY ("toBranchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "OnboardingRequest" ADD CONSTRAINT "OnboardingRequest_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "OnboardingRequest" ADD CONSTRAINT "OnboardingRequest_administrationId_fkey" FOREIGN KEY ("administrationId") REFERENCES "Administration"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "OnboardingRequest" ADD CONSTRAINT "OnboardingRequest_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "OnboardingRequest" ADD CONSTRAINT "OnboardingRequest_jobApplicationId_fkey" FOREIGN KEY ("jobApplicationId") REFERENCES "JobApplication"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "HeadcountPlan" ADD CONSTRAINT "HeadcountPlan_basedOnId_fkey" FOREIGN KEY ("basedOnId") REFERENCES "HeadcountPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;
ALTER TABLE "AttendancePunch" ADD CONSTRAINT "AttendancePunch_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "AttendanceLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE NOT VALID;


-- ---------------------------------------------------------------------------------------------
-- 5. Validate every constraint of this migration whose existing rows already comply. A constraint
--    that some legacy row violates stays NOT VALID (still enforced for new and updated rows) and is
--    reported; the reconciliation job lists the rows so HR can correct them.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  pending integer := 0;
BEGIN
  FOR r IN
    SELECT c.conname, cl.relname
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN pg_namespace ns ON ns.oid = cl.relnamespace
     WHERE ns.nspname = current_schema()
       AND NOT c.convalidated
       AND c.conname = ANY (ARRAY[
         'Employee_employmentStatus_check',
         'TransferRequest_status_check',
         'Attendance_status_check',
         'Visa_ticketStatus_check',
         'PromissoryNote_status_check',
         'LegalContract_status_check',
         'Lawsuit_status_check',
         'OvertimeRequest_status_check',
         'WorkAssignment_status_check',
         'Deduction_status_check',
         'Deduction_objectionStatus_check',
         'Investigation_status_check',
         'Loan_status_check',
         'ComplianceViolation_status_check',
         'AttendanceCorrection_status_check',
         'JobRequest_status_check',
         'JobApplication_status_check',
         'OnboardingRequest_status_check',
         'Asset_status_check',
         'Settlement_status_check',
         'TerminationRequest_status_check',
         'CertifiedAgency_status_check',
         'Circular_status_check',
         'OwnerRequest_status_check',
         'EvaluationCycle_status_check',
         'EmployeeEvaluation_status_check',
         'AssetRequest_status_check',
         'JobRun_status_check',
         'NotificationOutbox_status_check',
         'MuqeemTransaction_status_check',
         'RuleParameter_status_check',
         'DocumentRequest_status_check',
         'DocumentRenderJob_status_check',
         'IssuedDocument_status_check',
         'NitaqatActivity_status_check',
         'NitaqatCurve_status_check',
         'LocalizationDecision_status_check',
         'HeadcountPlan_status_check',
         'PaymentRequest_requestedById_fkey',
         'PaymentRequest_approvedById_fkey',
         'PaymentRequest_paidById_fkey',
         'SalaryChange_createdById_fkey',
         'HeadcountPlan_createdById_fkey',
         'HeadcountPlan_decidedById_fkey',
         'AttendancePunch_reviewedById_fkey',
         'EvaluationApproval_approverId_fkey',
         'RuleParameter_createdById_fkey',
         'NitaqatCurve_createdById_fkey',
         'LocalizationDecision_createdById_fkey',
         'WorkforceCalculation_createdById_fkey',
         'WorkforceAssumption_updatedById_fkey',
         'UserCompanyScope_createdById_fkey',
         'MuqeemTransaction_requestedById_fkey',
         'TransferRequest_requesterId_fkey',
         'OvertimeRequest_supervisorId_fkey',
         'WorkAssignment_supervisorId_fkey',
         'EmployeeEvaluation_managerId_fkey',
         'MuqeemTransaction_employeeId_fkey',
         'OnboardingRequest_directManagerId_fkey',
         'Allowance_paidInPayrollId_fkey',
         'OvertimeRequest_paidInPayrollId_fkey',
         'OvertimeRequest_paidInSettlementId_fkey',
         'JobRequest_companyId_fkey',
         'OnboardingRequest_companyId_fkey',
         'MuqeemTransaction_companyId_fkey',
         'HeadcountPlan_companyId_fkey',
         'TransferRequest_fromBranchId_fkey',
         'TransferRequest_toBranchId_fkey',
         'OnboardingRequest_branchId_fkey',
         'OnboardingRequest_administrationId_fkey',
         'OnboardingRequest_departmentId_fkey',
         'OnboardingRequest_jobApplicationId_fkey',
         'HeadcountPlan_basedOnId_fkey',
         'AttendancePunch_locationId_fkey'
       ])
     ORDER BY cl.relname, c.conname
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %I VALIDATE CONSTRAINT %I', r.relname, r.conname);
    EXCEPTION WHEN check_violation OR foreign_key_violation THEN
      pending := pending + 1;
      RAISE NOTICE '9x_db_constraints: % on % left NOT VALID: existing rows violate it (%)', r.conname, r.relname, SQLERRM;
    END;
  END LOOP;
  IF pending > 0 THEN
    RAISE NOTICE '9x_db_constraints: % constraint(s) left NOT VALID; see the reconciliation report', pending;
  END IF;
END $$;
