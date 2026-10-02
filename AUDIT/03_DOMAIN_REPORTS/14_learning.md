# 14 Learning

## Scope and method

Searched the whole repository (`src/app`, `src/lib`, `prisma/schema.prisma`, `docs/council*`) for the
Learning & Development domain: `grep -rniE "training|course|تدريب|دورة|certificate|enrollment|skill|competenc|learning path"`,
then manually inspected every hit to separate real matches from false positives (Arabic "دورة" is
ambiguous between "course" and "cycle"; every hit in the codebase turned out to be "دورة تقييم" =
evaluation *cycle*, part of Domain 13 Performance, not a training course). Cross-checked
`docs/council*`/`docs/council-domain*` for any prior claim of a learning module (none). No training
model exists in `prisma/schema.prisma` (2,679 lines fully scanned via `grep -n "^model"`), no
`src/app/api/training`, `src/app/api/courses`, or `src/app/training` directory exists, and no
training-related npm package (LMS integration) is in `package.json`.

## Capability findings

### Training / course catalog
Status: MISSING
Evidence: EV-7021 (negative search — no `Course`/`Training` model in prisma/schema.prisma; `find src/app -ipath "*train*" -o -ipath "*course*"` returns nothing; every "دورة"/"training" text hit resolves to `EvaluationCycle`/`EvaluationTemplate.evalType` = QUARTERLY training-unrelated cycle typing, or to the single free-text `RECOMMENDATIONS` enum value `'TRAINING'` in `src/app/api/evaluations/scoring.ts:26`, which is just a recommendation label with no linked course)
Risk: High — the brief lists this as a full sub-domain (catalog, requests, approvals, enrollment, attendance, certificates, skills, competencies, learning paths, cost, effectiveness, history); none of it exists.
Confidence: High.

### Training requests / approvals
Status: MISSING
Evidence: EV-7022 (same negative search as EV-7021; no request/approval model or route for training)
Risk: High.
Confidence: High.

### Enrollment / attendance tracking for courses
Status: MISSING
Evidence: EV-7023 (no enrollment model; `Attendance` model in schema is exclusively for daily work attendance, unrelated fields: punch times, GPS, face — not course sessions)
Risk: Medium.
Confidence: High.

### Certificates
Status: MISSING
Evidence: EV-7024 (negative search: `grep -rniE "certificate" prisma/schema.prisma` matches only unrelated legal/company constructs — none found for training certificates; UI-wide grep on "certificate" earlier in this audit pass matched files like `api/employees/gosi-review/route.ts` and `api/renewals/route.ts` by coincidence of the word "renewal"/"certified" contexts unrelated to training, confirmed by direct inspection: no training-certificate content in any of them)
Risk: Medium.
Confidence: High.

### Skills / competencies / learning paths
Status: MISSING
Evidence: EV-7025 (negative search: `grep -rniE "skill|competenc|learning path"` across `src/app`, `src/lib`, `prisma/schema.prisma` returns no hits tied to an employee skills taxonomy or learning path; the only near-miss is Domain 13's evaluation template items, which are per-template free-text titles, not a reusable, employee-linked skill/competency record)
Risk: Medium — this also means Performance (Domain 13) has no competency library to calibrate against, and Recruitment has no skill-matching data source (not independently re-verified here, out of scope).
Confidence: High.

### Training cost / effectiveness / history
Status: MISSING
Evidence: EV-7026 (no cost field, no effectiveness metric, no history table for training anywhere in the schema or reporting layer — confirmed by the same negative searches, and by the absence of any "training" key in `src/app/api/owner-reports/route.ts` or `src/app/api/dashboard/route.ts`, both read in full during the Reporting domain pass)
Risk: Medium (no cost visibility for a business function many Saudi HR products track under GOSI/Qiwa training-levy exemptions).
Confidence: Medium — did not independently re-verify Saudi compliance domain (10) for a training-levy-adjacent feature; flagged only from the Learning angle.

## Business rules

None found — no business rules exist because no learning/training capability exists in the codebase.

## Edge cases checked

Not applicable — there is no learning module to exercise edge cases against.

## Scorecard

| Domain | Total capabilities | Complete | Partial | UI_only | Backend_only | Missing | Broken | Mocked | Disconnected | Unsafe | Unknown | Critical gaps | Evidence confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 14 Learning | 6 | 0 | 0 | 0 | 0 | 6 | 0 | 0 | 0 | 0 | 0 | Entire domain is absent: no catalog, requests, enrollment, certificates, skills, or cost tracking | High |

## Adversarial verification

Verifier pass on group G findings (read-only). Evidence EV-7906..EV-7907 appended to `AUDIT/_work/ledger_G.md`.

### G-2 — Entire Learning & Development domain: CONFIRMED (MISSING, High)

Independent re-run of the negative search: `grep -n "^model"` over prisma/schema.prisma shows no Course/Training/Enrollment/Skill/Competency/Certificate model (the only "certif" model is `CertifiedAgency`, a legal agency record); no file or directory under `src` matches train/course/learn/skill/competen; the Arabic terms تدريب / دورة تدريبية / مهارات / كفاءات resolve only to the evaluation recommendation label `TRAINING` ("خطة تدريب", scoring.ts:26, evaluations/[id]/page.tsx:91, print page:54, documents/types.ts:1804), a free-text "skills" note on job applications (applications/page.tsx:420, apply/[jobRequestId]/page.tsx:328) and the phrase "استقطاب كفاءات" in recruitment (incoming-requests/route.ts:545). No migration adds such a table (latest is 9p_transfer_decision). EV-7907.

One correction to the scope note above: the council documents do mention the gap. docs/council-domain/PANELS.md:36 records "التدريب والأهداف" as Missing ("no models in schema.prisma, recommendations are only printed") and "not a launch priority". So the absence is known and deliberately deprioritized, not an oversight. Status and severity are unchanged for product-completeness scoring; the owner has accepted the gap for launch. EV-7906.

