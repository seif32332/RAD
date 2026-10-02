# 29 Infrastructure

## Scope and method

Read `Dockerfile`, `docker-compose.yml`, `ecosystem.config.js`, all of `ops/*.sh` and `ops/lib/common.sh`,
`ops/systemd/*.service`, `.github/workflows/ci.yml`, `docs/RUNBOOK.md` (сode fences and section headers),
`docs/DATABASE.md` headers, `scripts/jobs.mjs` header/locking comments, and the `JobRun`/`NotificationOutbox`/
`MuqeemTransaction` Prisma models for idempotency evidence. Ran `git branch -a`, `git remote -v` to verify the
CI branch-trigger mismatch. Did not run any deploy/backup/restore script, did not touch a database or Docker.

## Capability findings

### Deployment (Dockerfile / docker-compose / pm2)
Capability: repeatable, safe multi-tenant deploys with rollback.
Status: COMPLETE
Evidence: EV-10101, EV-10102, EV-10103
Files: `Dockerfile`, `docker-compose.yml:1-70`, `ecosystem.config.js:1-60`, `ops/deploy.sh`
Observed behavior: Two supported deploy modes (pm2 on a VPS, Docker per-tenant). `docker-compose.yml` hardens each app container: `read_only: true` root filesystem with only `/tmp` and `.next/cache` writable, `cap_drop: ALL`, `no-new-privileges`, `pull_policy: never` (image tags are only ever created locally by `deploy.sh`, so a plain `docker compose up -d` can never silently change a tenant's running version), a `healthcheck` against `/api/health`, and per-container memory limit (1g). `deploy.sh` (per its own header, referenced from RUNBOOK §3.1) sequences backup → migrate → canary health check → traffic switch. `ecosystem.config.js` for pm2 mode reads one `/etc/radeef/<tenant>.env` per tenant, skips (does not crash on) a malformed tenant entry so one bad tenant cannot break the reload of all others (DEC-004, comment at file top), and documents log rotation via `pm2-logrotate`.
Missing pieces: none identified from static reading; `deploy.sh`/`new-tenant.sh` were not executed, so runtime correctness (vs. documented intent) is UNKNOWN beyond what CI's shell-syntax check (`bash -n`) verifies.
Risk: Low.
Confidence: Medium (static read only, scripts not executed)

### CI/CD pipeline
Capability: automated typecheck/lint/test/build/migration/security gating before deploy.
Status: UNSAFE (branch mismatch means the safety net does not run on ordinary development)
Evidence: EV-10104, EV-10105, EV-10106
Files: `.github/workflows/ci.yml:5-8`
Observed behavior: `on: push: branches: [main]`. `git branch -a` shows only `master` and `remotes/origin/master` (EV-10105); `git remote -v` shows `origin git@github.com:seif32332/RAD.git` (EV-10106) — there is no `main` branch in this repository, locally or on the remote. This means **a direct push to `master` (the repository's only and default branch) never triggers CI** — the `build`, `migrations`, `render-service`, `ai-processors`, `secret-scan`, and `docker` jobs all live under this same `on:` block and are all skipped for a push to master. The `pull_request:` trigger (no branch filter, so it fires for a PR against any base branch including `master`) and `workflow_dispatch:` (manual) are the only ways this CI currently runs. If commits are pushed straight to `master` — which the git log in this session shows is exactly how this repository is being worked (`b556235`, `e5792fa`, `7dc214e`, `c0b64c3`, `74ebe77` are all direct commits on `master`, not merge commits from PRs) — none of typecheck, lint, `vitest`, `prisma migrate deploy` drift-check, secret scanning, or Docker image build actually ran for any of those commits via GitHub Actions.
Missing pieces: `on.push.branches` should read `[master]` (or drop the branch filter) to match the actual default branch.
Risk: Critical for a repo whose real workflow is direct pushes to master, as the git log indicates — the CI safety net described in the system map (typecheck/lint/vitest/migration-drift/gitleaks/Docker build) has likely not executed on recent history via automation; only whatever the developer ran locally caught issues.
Confidence: High

### Migrations (CI-verified)
Capability: every migration applies cleanly to an empty database, matches `schema.prisma` exactly (no drift), and the seed is idempotent.
Status: COMPLETE (as a CI job — see branch-trigger caveat above for whether it runs on ordinary pushes)
Evidence: EV-10107
Files: `.github/workflows/ci.yml` job `migrations` (lines ~70-140): spins up Postgres 16 service container, `prisma migrate deploy`, `prisma migrate diff --exit-code` against `schema.prisma`, seeds twice and diffs row counts to assert idempotency, then dry-runs `expiry-digest`/`deactivate-terminated`/`outbox-dispatch` and `tenant-stats.mjs` against the migrated schema.
Observed behavior: this is a strong, well-designed check (DEC-004 referenced in the file) — but per the branch-mismatch finding above, it is gated by the same `on.push.branches: [main]` trigger and therefore does not run on pushes to `master`.
Missing pieces: same branch-trigger issue.
Risk: High (same root cause as CI finding above).
Confidence: High

### Backups
Capability: automated daily database + uploads backup per tenant, tiered retention, optional offsite copy.
Status: PARTIAL
Evidence: EV-10108, EV-10109, EV-10110, EV-10111
Files: `ops/backup.sh:1-140`
Observed behavior: `pg_dump --format=custom` + `tar.gz` of the uploads dir (excluding `.biometric`, explicitly for PDPL data-minimization reasons per the inline comment at `ops/backup.sh:~99`), `sha256sum` manifest per backup set, daily/weekly(Sun)/monthly(1st) tiers with configurable retention (`KEEP_DAILY=7`, `KEEP_WEEKLY=4`, `KEEP_MONTHLY=6`, default), a `flock`-based lock file preventing concurrent runs, per-tenant failure isolation (one tenant failing does not stop others), and an optional healthcheck ping (`BACKUP_PING_URL`) plus optional `rclone` offsite copy (`RCLONE_REMOTE`, documented as recommended to be an rclone `crypt` remote — RUNBOOK §"خارج السيرفر", line ~287).
Missing pieces / gaps: (1) **Offsite copy is optional and not default** — `RCLONE_REMOTE` is empty unless explicitly configured per tenant in `/etc/radeef/backup.conf`; if never configured, backups exist only on the same host as the data they protect, i.e. "the local copies die with the disk" (the script's own header comment, `ops/backup.sh:~11`). (2) **No independent encryption of the backup files themselves at rest** — `pg_dump`/`tar` output is written to local disk with `umask 077` (owner-only file permissions) but is not separately encrypted (no `gpg`/`openssl enc`/`age` call anywhere in `backup.sh`); the only encryption mentioned is the rclone-crypt *offsite* remote, which is itself optional, and column-level `DATA_ENCRYPTION_KEY` encryption inside the database for specific sensitive fields (government-platform passwords, per `docs/RUNBOOK.md:104`) — that column encryption does travel with the dump, but the bulk of the database dump (employee PII, salary data, attendance) is not encrypted at rest in the local backup files, only protected by filesystem permissions. (3) Retention values are configurable but there is no enforcement that `RCLONE_REMOTE` or `BACKUP_PING_URL` are actually set for production tenants — a misconfigured or unconfigured tenant silently gets local-only, unmonitored backups with no error.
Risk: High — a host compromise, disk failure, or ransomware event without an offsite/encrypted copy configured would be unrecoverable, and the script gives no forcing function (no check/warning that `RCLONE_REMOTE` is unset) to prevent that misconfiguration per tenant.
Confidence: High (static reading of full script)

### Restore
Capability: restore a tenant from backup, safely and reproducibly.
Status: PARTIAL
Evidence: EV-10112, EV-10113
Files: `ops/restore.sh:1-90`
Observed behavior: validates the dump (`pg_restore --list`) and uploads archive (`tar -tzf`) before doing anything destructive; takes a safety "pre-restore" dump of the current database first; stops the app; requires interactive typed confirmation of the tenant name unless `--yes`; restarts and waits for `/api/health`. This is a well-built, safety-conscious script.
Missing pieces: the script's own header comment states "Test restores regularly into a scratch tenant/database... a backup that was never restored is not a backup" (`ops/restore.sh:~18`) — this is advice in a comment, not automation. There is no CI job, cron job, or scheduled task anywhere in the repo (`ci.yml`, `run-jobs.sh`, RUNBOOK cron/systemd examples) that actually performs a scheduled test restore. Restore capability is therefore **untested by any automated process** — it is exercised only if/when an operator manually runs it, which cannot be verified from the repository.
Risk: High — an unverified restore path is a classic disaster-recovery failure mode (a backup that "should" work but has never been proven to).
Confidence: High

### Scheduled background jobs
Capability: `scripts/jobs.mjs` CLI jobs run automatically per tenant on a schedule.
Status: PARTIAL (corrected from COMPLETE by adversarial verification, J-9: even the documented systemd enable command leaves 3 of 7 job timers disabled, EV-10908; no script installs job timers, EV-10909)
Evidence: EV-10114, EV-10115, EV-10116
Files: `ops/run-jobs.sh:1-100`, `docs/RUNBOOK.md` lines 358-444 and 610-620
Observed behavior: `ops/run-jobs.sh` accepts one of 7 jobs via a regex (`expiry-digest|deactivate-terminated|outbox-dispatch|purge-attendance-biometrics|documents-retention|documents-integrity|apply-employee-changes`, `ops/run-jobs.sh:31`) though its own usage comment/header only documents the first 3 explicitly (`ops/run-jobs.sh:8-9` lists only `expiry-digest | deactivate-terminated | outbox-dispatch` — the other 4 job names accepted by the regex are undocumented in the script's own usage text, though they are documented in RUNBOOK). It iterates every `/etc/radeef/<tenant>.env` plus a `jobs-extra.list`, skips tenants with `RADEEF_JOBS=off`, supports pm2 or docker execution mode, applies a jitter delay, and isolates per-tenant failures (one failing tenant does not stop the others; overall exit code is 1 if any failed). `docs/RUNBOOK.md` gives concrete systemd timer units (preferred) for all 7 jobs with specific `OnCalendar` schedules (deactivate-terminated 03:30, apply-employee-changes 00:15 daily, documents-integrity 04:30 daily, documents-retention weekly Friday 05:00, expiry-digest 03:55, outbox-dispatch 04:30 after the digest, purge-attendance-biometrics 04:50) and an alternative cron block for a subset (`/etc/cron.d/radeef-jobs`, RUNBOOK line 442-444, which only lists 3 of the 7 jobs — `deactivate-terminated`, `expiry-digest`, `outbox-dispatch` — not the document-engine or biometric-purge jobs).
Missing pieces: **no systemd unit files or crontab are actually present in the repository** (`find . -iname "*.timer" -o -iname "crontab*"` under the repo returns nothing, EV-10117) — the schedule exists only as copy-paste instructions in RUNBOOK, meaning whether any given production host actually has these timers/cron entries installed and enabled cannot be verified from the codebase; it is an operational/runbook matter, not something CI or the repo enforces. The cron alternative in RUNBOOK is also incomplete relative to the systemd version (missing 4 of 7 jobs), which — if an operator followed the cron path instead of systemd — would silently leave `purge-attendance-biometrics`, `apply-employee-changes`, `documents-integrity`, and `documents-retention` unscheduled.
Risk: Medium — the job-running mechanism (`run-jobs.sh`) is solid and CI dry-runs 3 of the 7 jobs against a migrated schema (EV-10107), but actual production scheduling is entirely runbook-driven with no enforcement, and the documented cron fallback is incomplete.
Confidence: Medium

### Job idempotency / concurrency safety
Capability: a job cannot run twice concurrently for one tenant and does not double-process on retry.
Status: COMPLETE
Evidence: EV-10118, EV-10119, EV-10120
Files: `prisma/schema.prisma` `JobRun` model (line 2025), `NotificationOutbox` model (line 2037, `idempotencyKey String @unique`, `leaseUntil`, `attempts`), `MuqeemTransaction` model (line 2056, `idempotencyKey String @unique`), `scripts/jobs.mjs` header comment (line ~37: "abandoned" jobs older than 2h marked FAILED, Prisma pool capped at `connection_limit=2`)
Observed behavior: every job run is recorded as a `JobRun` row (RUNNING/SUCCEEDED/FAILED); the notification outbox and Muqeem integration both use a unique `idempotencyKey` plus a lease (`leaseUntil`) pattern, which is a correct design for at-least-once delivery without duplicate side effects.
Missing pieces: none identified structurally; whether `jobs.mjs` actually enforces "refuses to run twice at once per database" (claimed in `ops/run-jobs.sh` header comment) was not verified by reading `scripts/jobs.mjs` end-to-end (out of the 29-Infrastructure read budget) — flagged as an assumption carried from the script's own comment, not independently re-derived from the locking code.
Risk: Low.
Confidence: Medium (schema-level evidence is direct; the locking claim is sourced from a comment, not re-derived from code)

### Logging / monitoring / observability
Capability: structured logs, error tracking, metrics, tracing, uptime alerting.
Status: PARTIAL
Evidence: EV-10121, EV-10122, EV-10123
Files: `src/app/api/health/route.ts`, `docker-compose.yml:44-49` (json-file logging driver, `max-size: 20m`, `max-file: 5`), `docs/RUNBOOK.md` §3.3 "السجلات والمراقبة" (line 275) recommending an external uptime monitor (UptimeRobot / Better Stack) polling `/api/health`
Observed behavior: `/api/health` does a real `SELECT 1` against Prisma and returns 503 on DB failure (liveness+readiness combined) — used by both the Docker healthcheck and the documented external uptime monitor. Docker/pm2 give basic log rotation. No application code dependency on Sentry, OpenTelemetry, pino, winston, or any APM/tracing library (`package.json` dependency list, EV-0024 from SYSTEM_MAP, re-confirmed: no such package present).
Missing pieces: no centralized log aggregation, no error-tracking service, no distributed tracing, no metrics/dashboards beyond `pm2 logs`/`docker logs` and the `JobRun` table. This is a reasonable minimum for a single-VPS-per-tenant deployment but is a real gap for diagnosing production issues beyond "is the DB reachable."
Risk: Medium — acceptable for current scale, but no way to see error rates, latency distributions, or trace a request across the app + render + face sidecars without SSHing in and grepping log files.
Confidence: High

### Rate limiting
Capability: protect sensitive/public endpoints from abuse.
Status: PARTIAL
Evidence: EV-10124, EV-10125
Files: `src/lib/rate-limit.ts` (in-memory fixed-window limiter, its own top comment: "Good enough for a single instance per tenant; use Redis if you scale horizontally")
Observed behavior: applied at 18 call sites (`grep -rln "rate-limit'" src/app src/lib`) including `auth/login`, `upload`, `portal/attendance/punch`, `portal/face`, public `offer/[token]`, public `v/[token]` (document verification), Muqeem integration routes, and workforce report/exports.
Missing pieces: the limiter is per-Node-process, in-memory, with no persistence — a pm2 restart or a horizontally-scaled deployment (more than one instance per tenant, which `ecosystem.config.js` deliberately avoids via cluster-mode-with-one-instance for zero-downtime reload) resets or fragments the counters. This is an accepted, documented tradeoff for the current single-instance-per-tenant architecture, not a hidden bug, but it means rate limiting would silently stop being effective if the deployment model ever changed to multiple instances per tenant without also moving to Redis.
Risk: Low under the current single-instance model; would become Medium-High if horizontally scaled without also changing the limiter.
Confidence: High

### Disaster recovery / RUNBOOK / DATABASE docs
Capability: documented recovery procedures for common failure modes.
Status: COMPLETE (as documentation)
Evidence: EV-10126
Files: `docs/RUNBOOK.md` (Arabic, ~700+ lines: SSH hardening, Postgres role setup, per-tenant secrets, upload migration, backup/restore, day-2 ops, rollback, background jobs, self-attendance/face service setup and biometric data purge, document-renderer setup), `docs/DATABASE.md` (~270 lines: migration adoption procedure for the 3 live databases, drift detection/fix, seeding, admin recovery, what `1_production_hardening` changes, what the seed writes)
Observed behavior: both documents are detailed, step-by-step, with copy-pasteable commands, and reference specific script/file names that were independently verified to exist (`ops/backup.sh`, `ops/restore.sh`, `ops/run-jobs.sh`, `scripts/encrypt-gov-passwords.mjs`). This is strong operational documentation.
Missing pieces: as noted above, the documentation is not enforced or verified by automation (no CI check that the systemd/cron examples in RUNBOOK match what `run-jobs.sh` actually accepts, and indeed a discrepancy was found: RUNBOOK's cron fallback lists only 3 of 7 jobs). Docs are lowest evidence tier per audit rules; treated here only as "documented," not as proof the described state exists on any real server.
Risk: Low (as documentation quality) / Medium (as a claim about production reality, which cannot be verified from the repo).
Confidence: Medium

## Business rules

| Rule | Source of truth | Implementation location | Tests | Affected domains | Duplicated? |
|---|---|---|---|---|---|
| CI runs typecheck/lint/vitest/build/migration-drift/secret-scan/docker-build before merge | `.github/workflows/ci.yml` | GitHub Actions | N/A (CI is the test) | All | No |
| Migrations must apply to empty DB with zero drift from `schema.prisma`; seed idempotent | `.github/workflows/ci.yml` `migrations` job | `prisma migrate deploy` + `prisma migrate diff --exit-code` + double-seed row-count diff | CI job itself | Database, all domains | No |
| Backups: daily/weekly/monthly retention, checksum manifest, `.biometric` excluded (PDPL minimization) | `ops/backup.sh` | pg_dump + tar + sha256sum | None (not tested by CI) | Attendance (biometric), all data domains | No |
| Job cannot double-run per tenant; outbox/Muqeem calls are idempotent by key | `prisma/schema.prisma` `JobRun`/`NotificationOutbox`/`MuqeemTransaction` | `scripts/jobs.mjs` + lease pattern | CI `migrations` job dry-runs 3 of 7 jobs | Notifications, Muqeem integration, documents | No |
| No unapproved AI/OCR SDK may be added | `docs/processors.md` "Approved AI / OCR packages" section | `.github/workflows/ci.yml` `ai-processors` job (parses `package.json` + `docs/processors.md`) | CI job itself | All (governance control) | No |

## Edge cases checked

- **CI trigger vs. actual branch**: confirmed via `git branch -a` / `git remote -v` (EV-10105, EV-10106) that `master` is the only branch, while `ci.yml` triggers push-CI only on `main`. Finding: UNSAFE — direct pushes to `master` (the workflow this repo's own commit history shows, EV-10104) bypass typecheck/lint/test/build/migration-drift/secret-scan/docker-build entirely; only `pull_request` or manual `workflow_dispatch` runs CI.
- **Offsite/encrypted backups not default**: `RCLONE_REMOTE` empty unless a per-tenant `/etc/radeef/backup.conf` sets it; no encryption of the local dump/tar files themselves beyond filesystem permissions (EV-10108-10111).
- **Restore never automated-tested**: script says to test restores regularly, but nothing in the repo (CI or scheduled job) does so (EV-10112, EV-10113).
- **Cron fallback incomplete vs. systemd fallback**: RUNBOOK's `/etc/cron.d/radeef-jobs` example (line 442-444) covers 3 of the 7 jobs `run-jobs.sh` supports; an operator following only the cron path would leave 4 jobs (including both document-engine jobs and biometric purge) unscheduled (EV-10115, EV-10116).
- **Documents-engine dirty working tree**: migration `9p_transfer_decision`, `scripts/jobs.mjs`, and `src/lib/documents/*` are uncommitted per `git status` (task context) — not evaluated for infra risk beyond noting that whatever `scripts/jobs.mjs` changes are on disk (not yet in a commit) would not be what `ops/run-jobs.sh` runs in production today, only what a future deploy would run once committed and released.

## Scorecard

| Domain | Total capabilities | Complete | Partial | UI_only | Backend_only | Missing | Broken | Mocked | Disconnected | Unsafe | Unknown | Critical gaps | Evidence confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 29 Infrastructure | 10 | 4 | 5 | 0 | 0 | 0 | 0 | 0 | 0 | 1 | 0 | CI push-trigger targets nonexistent `main` branch (bypasses all automated checks on direct pushes to `master`); backups not offsite/encrypted by default; restore never automated-tested | High |

## Adversarial verification

Verifier re-opened every cited file and searched for missed mechanisms (git hooks, radeef-manage panel, setup scripts, docs). Evidence EV-10900..EV-10913 is in `AUDIT/_work/ledger_J.md`.

| ID | Verdict | Final status / severity | Reason and new evidence |
|---|---|---|---|
| J-1 | ADJUSTED | UNSAFE / High | The facts are confirmed: `on.push.branches: [main]`, the only local and remote-tracking branch is `master`, the last 12 commits are single-parent direct commits, and there are no `.husky`, `.githooks` or `core.hooksPath` hooks that could stand in for CI (EV-10903). Severity is lowered from Critical to High. `pull_request:` (unfiltered) and `workflow_dispatch:` still work, and the defect is a one-line trigger fix that exposes no data by itself. The effect is still that regressions ship ungated in a direct-to-master workflow. GitHub Actions run history could not be checked, because there was no network access. |
| J-4 | ADJUSTED | PARTIAL / High | The gap is real and wider than stated. `docs/processors.md:25` lists the off-site target as "NONE until configured" (EV-10904). The radeef-manage panel has a second, node-cron backup path (`server.js:523-534`, `lib/ops.js:842-866`) that is also local-only and unencrypted, with no rclone (EV-10905). Only secrets, seal keys, tokens and face embeddings are field-encrypted; national ID, IBAN and salary are plaintext in the dump (EV-10906). Severity is lowered from Critical to High, matching this report's own Risk line. Local dumps under `umask 077` on the same host as the live database add little exposure beyond the database itself. The material risk is disk loss or ransomware with no off-site copy. |
| J-5 | ADJUSTED | PARTIAL / High | No automated full restore exists. However, `ops/backup.sh:99` runs `pg_restore --list` on every dump before accepting it (archive integrity), and `docs/RUNBOOK.md:295-298` documents a manual scratch-database restore drill. The readiness items for a monthly restore test (`PRODUCTION_READINESS_PLAN.md:205,247`) are still unchecked (EV-10907). Restore is unproven, not untestable. Severity lowered from Critical to High. |
| J-9 | ADJUSTED | PARTIAL / High | The gap is stronger than claimed. The RUNBOOK systemd block defines timers for 6 jobs (purge is at 610), but its `systemctl enable --now` command (line 435) enables only deactivate-terminated, expiry-digest and outbox-dispatch. So an operator who follows the preferred path exactly never enables apply-employee-changes, documents-integrity or documents-retention (EV-10908). The cron fallback is missing 4 jobs, including apply-employee-changes, which the claim did not mention. `render-setup.sh` and `face-setup.sh` install and enable their own services, but no script installs job timers (EV-10909). Mitigation: apply-employee-changes also runs in-app on the documents list and before payroll (EV-10910). The capability status was corrected from COMPLETE to PARTIAL. |

Status changes applied: Scheduled background jobs COMPLETE -> PARTIAL (capability block now matches `matrix_J.md` and the finding). Scorecard recounted to 10 capabilities (4 complete, 5 partial, 1 unsafe) to match the matrix; the previous row said 9.
