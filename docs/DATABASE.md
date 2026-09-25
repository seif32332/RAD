# Radeef HRMS — Database, migrations and seeding

> **`prisma db push` must never be used again — on any tenant, for any reason.**
> It bypasses the migration history, silently drops columns with `--accept-data-loss`, and is the
> reason the three live databases drifted apart. Schema changes reach production **only** through
> reviewed files in `prisma/migrations/` applied with `npm run db:migrate` (`prisma migrate deploy`),
> always preceded by a `pg_dump`. Also never run `prisma migrate dev` or `prisma migrate reset`
> against a production database (both can drop data).

Stack: PostgreSQL (>= 12 required), Prisma 5.22 (`prisma/schema.prisma`), one database per tenant
(`dar`, `rakan`, `radeef`). There is no `prisma.config.ts`; Prisma 5 reads `DATABASE_URL` from the
environment or `./.env`.

## Files

| Path | Purpose |
| --- | --- |
| `prisma/schema.prisma` | Current data model (source of truth for the generated client). |
| `prisma/migrations/migration_lock.toml` | Locks the migration history to `postgresql`. |
| `prisma/migrations/0_baseline/migration.sql` | Full `CREATE` script of the schema **as it was before production hardening** (what `dar` was last `db push`ed to). Never executed on the live tenants — it is marked as applied with `migrate resolve`. It runs normally on a brand-new empty database. |
| `prisma/migrations/0_baseline/baseline.schema.prisma.txt` | The Prisma schema that `0_baseline` was generated from. Used for drift detection below. Not read by Prisma automatically. |
| `prisma/migrations/1_production_hardening/migration.sql` | Additive hardening (see "What 1_production_hardening changes"). Re-runnable: uses `IF NOT EXISTS` / `DROP CONSTRAINT IF EXISTS`. |
| `prisma/seed.mjs` | Idempotent seed (`npm run db:seed`). |
| `scripts/create-admin.mjs` | Create a user or reset a password (`npm run admin:create`). |

npm scripts (in `package.json`):

```
npm run db:migrate      # prisma migrate deploy
npm run db:seed         # node prisma/seed.mjs      (also: npx prisma db seed)
npm run admin:create -- <email> [--role SUPER_ADMIN] [--name "الاسم"]
```

---

## One-time adoption of migrations on the 3 LIVE databases

Do the tenants **one at a time** (suggested order: `dar` — it is the closest to the baseline — then
`rakan`, then `radeef`). For each tenant run every step below from the tenant's application
directory, with that tenant's connection string exported. Stop at the first unexpected output.

Schedule a short maintenance window: step 6 re-creates 10 foreign keys and builds ~120 indexes;
on the current data sizes this takes seconds, but those statements take table locks.

### 0. Prepare

```bash
cd <tenant app dir>                         # e.g. /root/dar
export DATABASE_URL='postgresql://…/<tenant_db>'   # the tenant's real URL (from its .env)
git pull / copy the new release, then: npm ci && npx prisma generate
psql "$DATABASE_URL" -c 'select version();'  # must be PostgreSQL 12 or newer
```

Stop the tenant's app process (e.g. `pm2 stop <tenant>`) so nothing writes during the change.

### 1. Back up (mandatory)

```bash
mkdir -p /var/backups/radeef
pg_dump "$DATABASE_URL" --format=custom --no-owner \
  --file=/var/backups/radeef/<tenant>-pre-migrations-$(date +%Y%m%d-%H%M).dump
pg_restore --list /var/backups/radeef/<tenant>-pre-migrations-*.dump | head   # sanity check the file
```

Copy the dump off the server (or at least to a different disk) before continuing.
Restore, if ever needed: `pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" <file>.dump`.

### 2. Detect drift against the baseline

```bash
npx prisma migrate diff \
  --from-url "$DATABASE_URL" \
  --to-schema-datamodel prisma/migrations/0_baseline/baseline.schema.prisma.txt \
  --script > /tmp/<tenant>-drift.sql
cat /tmp/<tenant>-drift.sql
```

* Output `-- This is an empty migration.` → the database matches the baseline exactly. Go to step 4.
* Anything else is drift. `dar` should be (almost) empty because it was `db push`ed; `rakan` and
  `radeef` were never pushed by the deploy script and will usually be **missing columns/tables/enum
  values** that the application already uses.

### 3. Fix drift manually (only if step 2 was not empty)

Review `/tmp/<tenant>-drift.sql` line by line and keep **only additive statements**:

* KEEP: `CREATE TYPE`, `ALTER TYPE … ADD VALUE`, `CREATE TABLE`, `ALTER TABLE … ADD COLUMN`,
  `CREATE INDEX` / `CREATE UNIQUE INDEX`, `ADD CONSTRAINT … FOREIGN KEY`.
* DELETE (never run): any `DROP TABLE`, `DROP COLUMN`, `DROP TYPE`, `ALTER COLUMN … TYPE`,
  `ALTER COLUMN … SET NOT NULL` on a column that contains NULLs, `DROP INDEX` of a unique index
  you are not sure about. An object that exists in the database but not in the baseline is
  **left in place** — note it down and decide separately (it is harmless to Prisma).
* A `ADD COLUMN … NOT NULL` **without** `DEFAULT` fails on a non-empty table. Either add a
  sensible `DEFAULT` for the backfill, or add it nullable, backfill with `UPDATE`, then
  `SET NOT NULL`.
* A `CREATE UNIQUE INDEX` can fail on duplicate live data: find duplicates first
  (`select col, count(*) from "T" group by col having count(*) > 1;`), clean them, then retry.
* A `ADD CONSTRAINT … FOREIGN KEY` can fail on orphan rows: find them with a `LEFT JOIN … WHERE parent.id IS NULL`,
  fix them, then retry.

Apply the edited file in a single transaction:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f /tmp/<tenant>-drift.sql
```

Then repeat step 2 until it prints `-- This is an empty migration.` (the only acceptable remaining
lines are `DROP …` statements for extra objects you deliberately decided to keep — in that case
continue, but record them in the tenant's change log).

### 4. Mark the baseline as already applied

```bash
npx prisma migrate resolve --applied 0_baseline
```

This only inserts a row into `_prisma_migrations`; it does not execute `0_baseline/migration.sql`.

### 5. Apply the pending migrations

```bash
npm run db:migrate          # = prisma migrate deploy  → applies 1_production_hardening
npx prisma migrate status   # must say: Database schema is up to date!
```

### 6. Verify the database now matches the application schema

```bash
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script
# expected: -- This is an empty migration.
```

### 7. Seed

```bash
# Optional: only used when the tenant has NO active SUPER_ADMIN.
# Read the password without leaving it in shell history:
export ADMIN_EMAIL='admin@<tenant-domain>'
read -rs ADMIN_PASSWORD && export ADMIN_PASSWORD
npm run db:seed
unset ADMIN_PASSWORD
```

The seed inserts only missing rows (nationalities, default settings, first SUPER_ADMIN) and never
modifies existing data, so it is safe to re-run on every deploy.

### 8. Restart and smoke-test

`pm2 start <tenant>` (or the tenant's process manager), open `/api/health`, log in, open the
employees, payroll and renewals pages. Keep the step-1 dump for at least 30 days.

---

## Every deploy after adoption

```bash
pg_dump "$DATABASE_URL" --format=custom --no-owner --file=/var/backups/radeef/<tenant>-$(date +%Y%m%d-%H%M).dump
npm ci && npx prisma generate
npm run db:migrate
npm run db:seed
# build + restart the app
```

`prisma migrate deploy` only runs migrations that are not yet recorded in `_prisma_migrations`, in
folder-name order, and refuses to run if an applied migration file was edited (checksum mismatch).
Never edit a migration that has been applied anywhere — add a new one instead.

## Creating a new migration (developers)

1. Edit `prisma/schema.prisma`.
2. Against a **local/dev** database (never production):
   `npx prisma migrate dev --create-only --name <short_description>`
   — or, without a dev database but with a throw-away shadow database:
   `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url <scratch db url> --script > prisma/migrations/<N>_<name>/migration.sql`
3. Review the SQL: no `DROP COLUMN` / `DROP TABLE` / destructive type change without an explicit,
   reviewed data-migration plan; every new `NOT NULL` column has a `DEFAULT` or a backfill.
4. Commit the migration folder together with the schema change; `npx prisma generate`.

## Recovering admin access

```bash
npm run admin:create -- someone@example.com --role SUPER_ADMIN
# or with a chosen password:
NEW_ADMIN_PASSWORD='…' npm run admin:create -- someone@example.com
```

Creates the user if missing, otherwise resets the password and re-activates the account (the role
changes only when `--role` is passed). With no `NEW_ADMIN_PASSWORD` a random 16-character password
is printed once. Passwords are hashed with bcrypt (cost 12) — the same as the login route.

---

## What `1_production_hardening` changes

Additive only — no table or column is dropped or retyped (money columns stay `DOUBLE PRECISION`,
status columns stay `TEXT`), no new unique constraint on existing columns.

**Carried over from the lead's schema changes:** `LeaveStatus` += `CANCELLED`, `COMPLETED`;
`Company.taxCertificateUrl`; `Allowance.payrollMonth/payrollYear/isPaid/paidInPayrollId/createdAt`;
new table `LoanInstallment` (unique `loanId+month+year`, FK to `Loan` RESTRICT and to `Payroll` SET NULL).

**Timestamps** (`NOT NULL DEFAULT CURRENT_TIMESTAMP`, maintained by Prisma `@updatedAt`):
`updatedAt` on Nationality, WorkSchedule, Department, CompanyDocument, Leave, Allowance,
OvertimeRequest, Deduction, Loan, LoanInstallment, Asset, TelecomSim, UtilityMeter, Vehicle,
Settlement, Circular, EvaluationTemplateSection, EvaluationTemplateItem, EvaluationItemScore;
`createdAt` on Department, SystemSetting, Circular, EvaluationItemScore. (Append-only logs
`AuditLog`, `RenewalArchive`, `EvaluationApproval` intentionally have no `updatedAt`.)

**Delete rules changed from CASCADE to RESTRICT** (deleting the parent now fails with Prisma
`P2003`, which the API maps to HTTP 409, instead of silently erasing history):

| Child → parent | Why |
| --- | --- |
| Leave, Deduction, Investigation, Loan, Settlement, TerminationRequest → Employee | financial / legal history |
| AccidentClaim → Vehicle | insurance claims |
| Administration → Company, Branch → Company | organisation structure |
| Department → Branch | organisation structure |

`WorkSchedule → Branch` deliberately stays CASCADE: schedules are branch configuration (employees
reference them by name, not by FK) and the branch DELETE route relies on removing them with the branch.
Payroll → Employee was already RESTRICT.

**Indexes** (PostgreSQL does not index FK columns automatically):

* AuditLog: `userId`; `(entityType, entityId)`; `createdAt`
* Company: `commercialRegExp`; `trademarkExpDate`
* Administration: `companyId`
* Branch: `companyId`; `administrationId`; `munLicenseExp`; `civilDefenseExp`; `rentContractExp`
* WorkSchedule: `branchId` · Department: `branchId`
* Employee: `legalCompanyId`; `actualCompanyId`; `administrationId`; `branchId`; `departmentId`;
  `directManagerId`; `(isTerminated, employmentStatus)`; `iqamaOrIdExp`; `passportExp`;
  `healthCertificateExp`; `contractEndDate`
* TransferRequest: `employeeId`; `status`
* CompanyDocument: `companyId`; `expirationDate`
* Attendance: `date` (the `(employeeId, date)` unique already covers `employeeId`)
* Leave: `(employeeId, status)`; `status`; `(startDate, endDate)`
* Visa: `employeeId`; `status`
* Allowance: `employeeId`; `(payrollYear, payrollMonth)`; `paidInPayrollId`
* Payroll: `(year, month)`; `status` (unique `(employeeId, month, year)` covers `employeeId`)
* LoanInstallment: `payrollId`; `(year, month)`
* PromissoryNote: `status`; `dueDate` · LegalContract: `status`; `endDate` · Lawsuit: `status`
* OvertimeRequest: `employeeId`; `status`; `date` · WorkAssignment: `employeeId`; `status`
* Deduction: `(employeeId, date)`; `investigationId`; `status`; `payrollMonth`
* Investigation: `employeeId`; `status` · Loan: `employeeId`; `status`
* ComplianceViolation: `companyId`; `branchId`; `status`
* AttendanceCorrection: `employeeId`; `status`
* JobRequest: `departmentId`; `requesterId`; `status` · JobApplication: `jobRequestId`; `status`
* OnboardingRequest: `requesterId`; `status` · Asset: `employeeId`; `status`
* MedicalInsurance: `companyId`; `expiryDate`
* TelecomSim: `companyId`; `branchId`; `employeeId`
* UtilityMeter: `branchId`; `legalCompanyId`; `actualCompanyId`
* Vehicle: `legalCompanyId`; `actualCompanyId`; `driverId`; `isArchived`; `licenseExpDate`;
  `insuranceExpDate`; `inspectionExpDate`; `operatingCardExpDate`; `driverCardExpDate`; `drivingAuthExpDate`
* AccidentClaim: `vehicleId`; `status` · Settlement: `employeeId`; `status`
* RenewalArchive: `(entityId, documentType)`; `(action, documentType)`; `(entityType, entityId)`
* TerminationRequest: `employeeId`; `status` · CertifiedAgency: `status`; `endDate`
* PaymentRequest: `status`; `(entityId, documentType)`; `(entityType, entityId)`
* Circular: `(status, datePublished)` · OwnerRequest: `status`
* EvaluationTemplateSection: `templateId` · EvaluationTemplateItem: `sectionId`
* EvaluationCycle: `templateId`; `status`
* EmployeeEvaluation: `cycleId`; `employeeId`; `managerId`; `status`
* EvaluationItemScore: `evaluationId`; `itemId` · EvaluationApproval: `evaluationId`
* AssetRequest: `requesterId`; `requestedForId`; `status`

## What the seed writes

* **Nationality**: سعودي، مصري، هندي، باكستاني، بنجلاديشي، فلبيني، نيبالي (same list as the
  new-employee form), only the ones missing.
* **SystemSetting**: default values for alert thresholds, payroll parameters
  (`overtime_rate_multiplier`, `gosi_employee_percentage`, `exit_reentry_visa_fee`, …) and general
  settings, only for keys with no row. The values equal the defaults the code already applies when a
  key is missing, so seeding does not change any calculation. `annual_leave_days` is **not** seeded:
  without it the leave engine applies the statutory 21/30 days; a stored `30` would grant 30 days to
  everyone. Organisation name/logo/notification contacts are left for each tenant to fill in.
* **SUPER_ADMIN**: only when no active SUPER_ADMIN exists **and** `ADMIN_EMAIL` + `ADMIN_PASSWORD`
  are set (password must be >= 8 chars with a letter and a digit). If that e-mail already belongs to a
  user, that user is promoted, re-activated and given the password.
* **RolePermission**: never seeded — the UI uses built-in role defaults until an admin saves a matrix.
