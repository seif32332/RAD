# Sub-processors and external data processors (المعالجون الفرعيون)

This list is the single source of truth for every third party that **receives tenant data**
(personal data of employees, documents, e-mail addresses, logs). A service that is not listed here
must not receive tenant data. Adding one needs the owner's written approval (DEC-008 / DEC-009) and,
where it applies, an update to the customers' DPA.

Current as of 2026-09-24. Nothing in this file is a statement about where production data is
hosted today: that is UNKNOWN until confirmed (DEC-008).

CI enforces the AI/OCR part: the job **"AI/OCR SDKs must be approved sub-processors"** in
`.github/workflows/ci.yml` fails when `package.json` gains an AI or OCR SDK (for example `openai`,
`@anthropic-ai/sdk`, `@google/generative-ai`, `tesseract.js`, `@aws-sdk/client-textract`) whose npm
package name is not listed in the table **Approved AI / OCR packages** below.

Status legend: `APPROVED` (owner signed off, in use), `PENDING` (proposed, not allowed to receive
data yet), `NONE`.

## Current processors

| Processor | Purpose | Data sent | Region | Status | Approved by / date |
|---|---|---|---|---|---|
| Hosting provider of the production VPS | Runs the app, PostgreSQL and file storage | Everything | UNKNOWN (to be confirmed, DEC-008) | In use — contract and region not yet documented | — |
| Transactional e-mail provider (SMTP) | Password resets, license reminders, document-expiry digests (counts only) | Recipient e-mail address, message text | — | NONE: not chosen yet (DEC-009). `SMTP_*` stay empty and `scripts/jobs.mjs outbox-dispatch` stays in dry-run until one is approved and listed here with SPF/DKIM/DMARC | — |
| Off-site backup target (`RCLONE_REMOTE` in `ops/backup.sh`) | Encrypted copies of database dumps and uploads | Everything | — | NONE until configured and listed here | — |

## Approved AI / OCR packages

AI features are **not approved**: DEC-006 (no LLM feature within 90 days; generated evaluations,
candidate ranking, NL-to-SQL and "AI" marketing are prohibited) and the DEC-002 DO_NOT list (chat
bot, automatic CV reading, cloud OCR). No AI or OCR SDK may be added to `package.json`.

| npm package | Vendor | Purpose | Data sent | Approved by / date |
|---|---|---|---|---|
| _none_ | | | | |

To approve one later: add a row with the exact npm package name in backticks in the first column
(for example `` `tesseract.js` `` for on-device OCR), the owner's approval reference and date, and
update the processor table above if the package sends data to a third party.

## Approved on-premise components

Components that process tenant data **on the tenant's own server**: no third party receives
anything. They still need the owner's written approval before the feature that uses them is
switched on (DEC-011). CI checks that every Python package in `services/face/requirements.txt` is
listed in the first column of this table.

| Package(s) | Component | Purpose | Data processed | Leaves the server? | Status | Approved by / date |
|---|---|---|---|---|---|---|
| `fastapi`, `uvicorn`, `python-multipart` | `services/face` (radeef-face, 127.0.0.1:8090) | HTTP layer of the internal face verification service | Selfie image, in memory only | No | APPROVED (DEC-011). Enable `self_attendance_enabled` only after the remaining DEC-011 steps | Owner: saif (seifmostafa@qiadah.sa), 2026-09-26 |
| `numpy`, `opencv-python-headless`, `onnxruntime` | `services/face` | Face detection (YuNet, MIT), 128-d embedding (SFace, Apache-2.0), passive liveness (MiniFASNet, Apache-2.0) | Selfie image, in memory only; returns an embedding that Radeef stores encrypted | No | APPROVED (DEC-011) | Owner: saif (seifmostafa@qiadah.sa), 2026-09-26 |

| Typst 0.15.1 (static binary, Apache-2.0; pinned in `services/render/typst.lock`) + IBM Plex Sans Arabic (SIL OFL 1.1; `services/render/fonts.lock`) | `services/render` (radeef-render, 127.0.0.1:8091) | Renders official documents (salary certificates, letters) to PDF; no runtime npm dependencies | Document data prepared by the tenant (names, IDs, amounts) and customer logos / signatures / stamps, in a per-request temp directory deleted after each render | No (no network: `IPAddressDeny=any`) | APPROVED (ADR-001 DOC-01, POC 2026-09-26) | Owner: saif (seifmostafa@qiadah.sa), 2026-09-26 |
Biometric data handling (PDPL: sensitive data):
- **Consent:** explicit and versioned (`FaceProfile.consentVersion`).
- **Templates:** encrypted with `DATA_ENCRYPTION_KEY`.
- **Evidence selfies:** kept only for rejected / flagged punches, for `attendance_selfie_retention_days` (default 90), and excluded from the uploads backups.
- **Deletion:**
  - Templates and reference photos are deleted when the employee withdraws consent, on an HR reset, and at termination (`scripts/jobs.mjs purge-attendance-biometrics`).
  - Pretrained models from InsightFace (buffalo_l / ArcFace) must not be used: non-commercial license.
