-- Recurring allowances split by kind when the payroll is generated (owner request 2026-09-26: the
-- payslip shows basic, housing, transport and other allowances). housing + transport + other =
-- totalAllowances - bonusAmount exactly. NULL = row generated before the split (one line).
ALTER TABLE "Payroll" ADD COLUMN     "housingAllowance" DOUBLE PRECISION,
ADD COLUMN     "otherAllowances" DOUBLE PRECISION,
ADD COLUMN     "transportAllowance" DOUBLE PRECISION;
