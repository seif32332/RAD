# Radeef HRMS: system map

Audit date: 2026-09-27. Git HEAD `b556235` on `master`. The working tree was **dirty** during the audit
(uncommitted work on the document engine: `9p_transfer_decision` migration, `transfer-decision.typ`,
`prisma/demo-seed.mjs`, and edits under `src/lib/documents/*`, `scripts/jobs.mjs`). Findings describe the
working tree as it was, not a released build.

Evidence IDs `EV-0001`..`EV-0099` come from this discovery pass. See [12_AUDIT_EVIDENCE_LEDGER.md](12_AUDIT_EVIDENCE_LEDGER.md).

## Summary

| Layer | What exists | Evidence |
|---|---|---|
| Frontend | Next.js 16.1.6 App Router, React 19.2, Tailwind 4. 109 `page.tsx` files under `src/app`. Arabic-first UI. | EV-0001, EV-0002 |
| Backend | Same Next.js app. 153 `route.ts` API handlers under `src/app/api`; domain logic in `src/lib/*` (payroll-core, leave, attendance, settlement, termination, documents/*, workforce/*, muqeem/*). One server-actions file. | EV-0002, EV-0003 |
| Database | PostgreSQL through Prisma 5.22. `prisma/schema.prisma` = 2,679 lines, 91 models + enums. 27 migrations (`0_baseline` .. `9p_transfer_decision`). | EV-0004, EV-0005 |
| Authentication | Email + bcrypt password; HS256 JWT (jose) in cookie `radeef_session`, with credential-version (`cv`) and `sessionVersion` (`sv`) revocation. Edge proxy `src/proxy.ts` rejects unauthenticated pages/APIs except a public allow-list (`/login`, `/apply`, `/v`, `/offer`, `/api/auth/login|logout`, `/api/health`, `/api/apply`, `/api/upload`). | EV-0006, EV-0007 |
| Authorization | 11 roles (`enum Role`), role groups in `src/lib/constants.ts` (`ROLE_GROUPS`), enforced per handler with `requireUser(ROLE_GROUPS.X)` (`src/lib/auth.ts`). A `RolePermission` model exists. Company-level scoping through `UserCompanyScope`. | EV-0008, EV-0009, EV-0010 |
| Tenancy | **One deployment + one database + one upload directory per customer** (pm2 app per `/etc/radeef/<tenant>.env`, `ecosystem.config.js`). Inside a tenant, several `Company` rows (legal entities) share one database. | EV-0011 |
| Storage | Local disk, `UPLOAD_DIR` (default `<cwd>/uploads`), served through `/api/files/[...path]`; biometric files in `UPLOAD_DIR/.biometric`. | EV-0012 |
| Background jobs | `scripts/jobs.mjs` CLI (no HTTP endpoint): `expiry-digest`, `deactivate-terminated`, `outbox-dispatch`, `purge-attendance-biometrics`, `documents-retention`, `documents-integrity`, `apply-employee-changes`. Each run records a `JobRun` row. Scheduled from `ops/run-jobs.sh` (cron/systemd; see domain report 29). | EV-0013 |
| Queues | No queue broker. A transactional outbox table `NotificationOutbox` dispatched by `outbox-dispatch`; `DocumentRenderJob` table for document rendering. | EV-0013, EV-0014 |
| Notifications | E-mail only through SMTP (nodemailer, `src/lib/mailer.ts`); outbox is dry-run unless `OUTBOX_SEND=true`. No SMS / push / WhatsApp library in `package.json`. | EV-0014, EV-0015 |
| Integrations | Muqeem client (`src/lib/muqeem/*`, env `MUQEEM_*`, a mock server `scripts/muqeem-mock.mjs`). No Qiwa / GOSI / Mudad client libraries found at discovery (verified per domain in report 10). | EV-0016 |
| Sidecar services | `services/face` (Python, on-premise face detection/liveness/embedding, bearer token, 127.0.0.1). `services/render` (Node + pinned Typst binary, renders official PDFs, bearer token). | EV-0017 |
| AI | No LLM/AI SDK in `package.json`; CI job `ai-processors` blocks unapproved AI/OCR SDKs (DEC-006). Face service is the only ML component. | EV-0018 |
| Tenant management | `radeef-manage/` (Express + SQLite web panel + CLI) that runs commands over SSH on the production host. | EV-0019 |
| Infrastructure | `Dockerfile`, `docker-compose.yml`, `ecosystem.config.js` (pm2), `ops/*.sh` (deploy, backup, restore, new-tenant), nginx template, systemd units for the sidecars. | EV-0020 |
| CI | `.github/workflows/ci.yml`: typecheck, lint, vitest, build, migrations on empty Postgres 16 with drift check and idempotent seed, job dry-runs, render service tests, AI-SDK gate, gitleaks, Docker builds. Triggers on push to `main` and PRs; the working branch is `master` (see report 29). | EV-0021 |
| Tests | Vitest. 89 test files in `src/lib/__tests__` + `src/app/api/settings/__tests__`. Local run at audit time: **86 files passed, 3 skipped; 1,584 tests passed, 90 skipped**. Skipped suites need Postgres, the render service, or the Muqeem mock. No E2E/browser test framework in `package.json`. | EV-0022, EV-0023 |
| Observability | No Sentry/OpenTelemetry/pino/winston. pm2 log files per tenant; `/api/health`; `JobRun` rows. | EV-0024 |
| Prior audits in repo | `docs/council/*`, `docs/council-domain/*` (earlier councils). Treated as documentation (lowest evidence level); every claim is re-verified. | EV-0025 |

## Top-level folders

| Path | Role |
|---|---|
| `src/app/<module>/page.tsx` | UI pages (Arabic, RTL) |
| `src/app/api/<module>/**/route.ts` | JSON API |
| `src/lib/*` | Domain services and pure calculators |
| `src/components/*` | Shared UI (AppShell, DashboardLayout, ui/*) |
| `prisma/` | Schema, migrations, seeds (`seed.mjs`, `demo-seed.mjs` untracked) |
| `scripts/` | Jobs, admin tools, Muqeem mock, demo seeding |
| `services/face`, `services/render` | Sidecar services |
| `ops/` | Deployment, backup/restore, nginx, systemd |
| `radeef-manage/` | Tenant manager panel |
| `docs/` | ADRs, council reports, integration notes |
| `poc/` | Document renderer proof of concept |

## Modules visible in the UI (`src/app/*`)

admin-alerts, administrations, applications, apply (public), asset-request, assets, attendance, attendance-corrections,
branches, claims, companies, compliance, departments, dept-actions, dept-manager, documents, employees, evaluations,
gov-platforms, hr-alerts, incoming-requests, integrations, leaves, legal, legal-alerts, loans, logistics-alerts,
manager-portal, medical-insurance, my-documents, offer (public), overtimes, owner-portal, owner-reports, payments,
payrolls, penalties, portal (employee), recruitment, renewals, search, services, settings, settlements, transfers,
unified-alerts, v (public verification), vehicles, visas, workforce.

The existence of a page is **not** evidence of a capability; each is traced in the domain reports.

## Council structure used for this audit

| Group | Specialists covered | Model tier |
|---|---|---|
| A | 01 Core HR, 02 Organization, 03 Contracts | medium |
| B | 04 Documents, 05 Recruitment, 06 Onboarding | medium |
| C | 07 Attendance, 08 Leave | strongest (calculations) |
| D | 09 Payroll, 15 Benefits, 16 Employee finance, 18 Offboarding | strongest |
| E | 10 Saudi compliance, 22 Workforce planning | strongest |
| F | 11 ESS, 12 MSS, 26 Mobile, 27 Arabic/RTL, 30 UX | medium |
| G | 13 Performance, 14 Learning, 17 Assets, 21 Reporting | medium |
| H | 19 Workflow engine, 20 Notifications, 23 AI | medium |
| I | 24 Security, 25 Multi-tenancy | strongest |
| J | 28 Testing, 29 Infrastructure | medium |
| K | Database + API reality check | medium |
| X | Cross-domain lifecycle audit (after A–K) | strongest |
