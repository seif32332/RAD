# 17 Assets / Custody

## Scope and method

Read `prisma/schema.prisma` models `Asset` (1344-1359), `TelecomSim` (1396-1419), `UtilityMeter`
(1422-1447+), `Vehicle` (1447+), `AssetRequest` (1942-1971); `src/app/api/assets/route.ts` (130
lines, full), `src/app/api/assets/_lib.ts` (163 lines, full), `src/app/api/assets/[id]/route.ts`
(208 lines, full), `src/app/assets/page.tsx` (638 lines, partially), `src/app/asset-request/page.tsx`
(136 lines), `src/app/api/incoming-requests/route.ts` (asset-request approval chain, ~lines 886-975),
`src/lib/__tests__/c2-logistics-access.test.ts` (asset section, lines 151-197), and
`src/app/employees/[id]/page.tsx` (termination modal + `unreturnedAssets`, lines 344, 686-724). Cross
checked termination against `src/app/api/employees/[id]/route.ts` (terminate action, lines 405-490)
and `src/lib/settlement.ts` / `src/lib/termination.ts` (grepped for `asset`, zero hits).

## Capability findings

### Asset (custody item) CRUD
Status: COMPLETE
Evidence: EV-7027
Files: src/app/api/assets/route.ts (GET/POST), src/app/api/assets/[id]/route.ts (PATCH), src/app/api/assets/_lib.ts:8-19 (status enum)
DB tables: Asset
API routes: GET/POST /api/assets, PATCH /api/assets/[id]
UI routes: /assets
Tests: c2-logistics-access.test.ts:151-197
Observed behavior: Real Prisma-backed CRUD, role-gated (`ROLE_GROUPS.LOGISTICS` for writes, `ROLE_GROUPS.ALL` scoped-to-self for reads), with an audit-logged transaction on every write.
Missing pieces: `Asset.assetType` is a free-text string, not a category/enum — no asset category taxonomy (no `AssetCategory` model, no condition field like NEW/GOOD/DAMAGED beyond the coarse `status` state).
Risk: Low.
Confidence: High.

### Custody assign / transfer / clear / damage actions
Status: COMPLETE
Evidence: EV-7028
Files: src/app/api/assets/[id]/route.ts:37-208; src/app/api/assets/_lib.ts:91-109 (`assetActionGuard`)
Functions/classes: `assetActionGuard`, `isValidDamageReason`, `holderSnapshot`
Tests: c2-logistics-access.test.ts:152-168 (damage reason length, schema requiring a reason only for `damage`)
Observed behavior: Each transition (`assign`, `transfer`, `clear`, `damage`, `edit`) is applied with an atomic `updateMany` state guard (`assetActionGuard`) plus a `count === 0` conflict check (409 `STATE_CHANGED`) to prevent a double-submit race; `assign`/`transfer` refuse a terminated employee via `ensureRefsExist(..., { activeOnly: true })`; `transfer` closes the old row (`TRANSFERRED`, keeps it as history) and creates a new `ACTIVE` row for the new holder, linked only through the audit log's `newAssetId` field, not a DB foreign key.
Missing pieces: no dedicated `AssetHistory`/`AssetHandover` table — the transfer/handover chain across holders is reconstructable only from `AuditLog` entries plus the trail of `TRANSFERRED` rows, not from a single queryable history relation.
Risk: Low-Medium (history exists but is harder to query/report on than a first-class table).
Confidence: High.

### Telecom SIM as custody item
Status: COMPLETE
Evidence: EV-7029
Files: src/app/api/assets/_lib.ts:134-156 (`simAsCustodyItem`); src/app/api/assets/[id]/route.ts:58-113 (SIM branch of PATCH)
DB tables: TelecomSim
Observed behavior: SIMs held by an employee are merged into the same custody list as `Asset` rows (assign/transfer/clear/damage share the same UI and API surface); the code explicitly notes the `TelecomSim` model has no status column, so "damage" on a SIM only detaches it from the employee — the line itself must be cancelled at the operator separately (a documented, not silently-lost, limitation).
Missing pieces: none beyond the documented SIM-has-no-status limitation.
Risk: Low.
Confidence: High.

### Vehicles / utility meters as custody
Status: PARTIAL
Evidence: EV-7030
Files: prisma/schema.prisma (`Vehicle`, `UtilityMeter` models, ~1396-1450); src/app/api/owner-reports/route.ts:148-153 (vehicles, utility meters listed as company assets in the owner report, but not through the /api/assets custody workflow)
Observed behavior: Vehicles and utility meters exist as company property in their own domain (logistics / vehicles module, out of this report's primary scope) and are surfaced in owner reports as counts/expiries, but — unlike `TelecomSim` — they are not merged into the `/api/assets` custody list, so `assign`/`transfer`/`clear`/`damage`/`heldByTerminated` do not apply to them the way the brief implies ("vehicles/telecom SIM/utility meters as custody items").
Missing pieces: no unified custody view across all four physical-asset types; vehicles/meters live in a separate module with separate lifecycle rules (not audited in depth here — belongs primarily to Domain 22/Logistics).
Risk: Medium.
Confidence: Medium (vehicle/meter lifecycle itself not fully traced; only their absence from the assets custody surface is confirmed).

### Asset needs request (طلب احتياج عهدة) — 3-stage approval to fulfilment
Status: COMPLETE
Evidence: EV-7031, EV-7032
Files: prisma/schema.prisma:1942-1971 (AssetRequest); src/app/api/incoming-requests/route.ts:886-970 (ASSET_REQUEST handler)
DB tables: AssetRequest, Asset
API routes: PATCH /api/incoming-requests (approve/reject per stage)
UI routes: /asset-request, /incoming-requests
Observed behavior: PENDING_HR → PENDING_OWNER → PENDING_PURCHASING → COMPLETED, each stage gated by a distinct role group (`ASSET_STAGE_ROLES[current.status]`) and each transition guarded by `updateMany({ where: { id, status: current.status } })` + a `count===0` conflict check. On completion, purchasing either hands out an existing warehouse asset (`existingAssetId`, guarded to `VACANT`/`RETURNED` status) or a brand-new `Asset` row is created and immediately assigned — genuinely wired end to end, not a stub. `completing` also refuses a terminated `requestedFor` employee (`ensureRefsExist(..., activeOnly:true)`).
Missing pieces: none found; this is one of the stronger end-to-end flows in the codebase.
Risk: Low.
Confidence: High.

### Offboarding / termination integration ("does termination block on unreturned assets?")
Status: PARTIAL (verifier-adjusted from DISCONNECTED; see "Adversarial verification", EV-7900..EV-7905)
Evidence: EV-7033, EV-7034, EV-7035
Files: src/app/employees/[id]/page.tsx:344,686-724 (client-side `unreturnedAssets` warning + disabled submit copy in the termination modal); src/app/api/employees/[id]/route.ts:405-490 (server `action:'terminate'` handler — no `asset` or `Asset` reference anywhere in this function); src/lib/termination.ts and src/lib/settlement.ts (grepped for `asset|Asset|block|clearance`, zero matches in both files)
Observed behavior: The employee page's termination modal computes `unreturnedAssets` from the employee's loaded `assets` and shows "لا يمكن إتمام عملية الإنهاء" ("termination cannot be completed") with a red banner when there are unreturned assets or unpaid loans, and the confirm button is replaced with a dismiss-only "حسناً، فهمت" button — but this is a **client-side UI gate only**. The server-side `PATCH /api/employees/[id]` with `action:'terminate'` (route.ts:405-490) performs its own checks — reason length, protected-leave (maternity/sick) status, prior-termination guard — but never queries `Asset` or checks for unreturned custody before flipping `isTerminated: true`. Any caller that hits the API directly (a script, a different UI, a future admin tool, or simply a stale/failed client-side compute of `unreturnedAssets`) can terminate an employee with unrecovered custody items with no server-side objection.
Missing pieces: a server-side guard (equivalent to the existing `PROTECTED_LEAVE` conflict pattern already used for maternity/sick leave in the same function, route.ts:427-443) that blocks or requires an explicit override for unreturned assets, mirroring what the UI already promises the HR user.
Risk: Medium (verifier-adjusted from High/Critical) — the UI text is an explicit promise ("cannot complete") that the API does not enforce. However, not blocking on the server is a documented, deliberate decision (DOM-005, warn not block, Labor Law art. 88), the settlement preview warns server-side about open custody, and the clearance certificate (إخلاء طرف) is strictly refused server-side while any asset, SIM, vehicle or loan is open. The residual defect is the inconsistency between the UI banner and the server policy, plus no warning at all on the direct terminate action.
Confidence: High.

### Unpaid loans blocking termination (adjacent control, same finding)
Status: PARTIAL (verifier-adjusted from DISCONNECTED; the final settlement deducts the outstanding loan balance server-side and the clearance certificate refuses while a loan is open, EV-7902, EV-7903)
Evidence: EV-7036 (same evidence as EV-7033/7034: `unpaidLoans` is computed and shown in the identical client-only banner, src/app/employees/[id]/page.tsx:345,695-696; the server terminate handler has no loan check either)
Risk: Low-Medium (verifier-adjusted from High) — the loan balance is recovered through the settlement, not lost; the residual risk is an employee terminated via the direct action with no settlement ever created.
Confidence: High.

## Business rules

| Rule | Source of truth | Implementation location | Tests | Affected domains | Duplicated? |
|---|---|---|---|---|---|
| Assign/transfer refuses a terminated employee | `ensureRefsExist(..., {activeOnly:true})` | src/app/api/assets/[id]/route.ts (assign/transfer cases); src/app/api/incoming-requests/route.ts:919 | c2-logistics-access.test.ts:172 (`hasTerminatedEmployee`) | Assets, Offboarding | No (shared helper `ensureRefsExist`) |
| Damage/loss reason must be ≥5 visible characters | `isValidDamageReason`/`DAMAGE_REASON_MIN` | src/app/api/assets/_lib.ts:44-49 | c2-logistics-access.test.ts:152-159 | Assets | No |
| State transitions are atomic (no double-submit) | `assetActionGuard` + `updateMany`/count check | src/app/api/assets/[id]/route.ts (every action) | Not directly tested (guard function itself is, transitions are not integration-tested) | Assets | Same pattern reused across Payroll/Documents/Assets, each with its own guard — consistent style, not literal duplication |
| Termination should be blocked while custody or loans are outstanding | UI copy only (src/app/employees/[id]/page.tsx:689); server policy is DOM-005 "warn, do not block" | Not blocked server-side by design; warnings in settlement preview (settlements/route.ts:167-205,567-570); loans deducted in settlement (settlement.ts:324); clearance certificate strictly blocked (documents/types.ts:744-786) | c2-termination.test.ts:113 (open-obligation warnings); documents-pipeline.test.ts:420-421 (clearance skipped) | Assets, Offboarding, Payroll (loans) | UI rule contradicts server rule |

## Edge cases checked

- **Terminated employee still holding an asset (`heldByTerminated`)**: a dedicated, tested query flag surfaces exactly this list for back-office staff (`heldByTerminated=1`, src/app/api/assets/route.ts:34-49; tested in c2-logistics-access.test.ts:178-186). Finding: this view exists and is correct, but is a report you have to go look at — it does not itself stop termination from happening in the first place (see DISCONNECTED finding above). EV-7037.
- **Double-submit / concurrent custody action**: guarded via atomic `updateMany` + `count===0` → 409 `STATE_CHANGED` (src/app/api/assets/[id]/route.ts, every case). Finding: handled correctly. EV-7038.
- **Transfer to the same current holder**: explicitly rejected (`if (employeeId === asset.employeeId) throw badRequest(...)`, src/app/api/assets/[id]/route.ts, transfer case). Finding: handled. EV-7039.
- **SIM damage vs asset damage — different real-world meaning**: the code documents and returns a distinct message (`SIM_DAMAGE_MESSAGE`) reminding the operator that a "damaged" SIM line is still billable until cancelled with the telecom provider — a genuine domain nuance correctly captured, not glossed over. EV-7040.

## Scorecard

| Domain | Total capabilities | Complete | Partial | UI_only | Backend_only | Missing | Broken | Mocked | Disconnected | Unsafe | Unknown | Critical gaps | Evidence confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 17 Assets/Custody | 7 | 4 | 3 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | UI banner says termination cannot complete with open custody/loans, but the server (by DOM-005 design) only warns at settlement and blocks the clearance certificate; direct terminate action has no warning | High |

## Adversarial verification

Verifier pass on group G findings (read-only). Evidence EV-7900..EV-7905 appended to `AUDIT/_work/ledger_G.md`.

### G-1 — Termination blocked on unreturned assets / unpaid loans: ADJUSTED (DISCONNECTED/Critical -> PARTIAL/Medium)

Confirmed part: `PATCH /api/employees/[id]` with `action:'terminate'` (src/app/api/employees/[id]/route.ts:411-488) checks only reason, protected leave and prior termination; it never reads `Asset`, `TelecomSim`, `Vehicle` or `Loan`. The employee page banner "لا يمكن إتمام عملية الإنهاء" (page.tsx:686-724) is a client-side gate only, so the UI promise is not enforced.

Refuted/overstated parts:
- Not blocking on the server is a documented, deliberate decision, not a wiring gap: DOM-005 (docs/council-domain/DECISIONS.md:106-127) says settlement creation and payment are not blocked by custody, warnings are added server-side, the UI block stays until the owner decides; reason: Labor Law art. 88 requires settlement within one/two weeks, so a server block could withhold dues. The code comment at settlements/route.ts:567 repeats it ("nothing is blocked on the server"). EV-7900.
- Server-side open-obligation warnings exist: `loadOpenObligations` + `openObligationWarnings` (src/app/api/settlements/route.ts:153-205, used at 567-570) list active assets, SIMs, vehicles, future leaves, exit/re-entry visas and pending payments in the settlement preview; unit-tested in src/lib/__tests__/c2-termination.test.ts:113. EV-7901.
- Loans are not left uncollected: the final settlement deducts the outstanding loan balance server-side (`outstandingLoansForSettlement`, src/lib/settlement.ts:16,324,389; settlements/route.ts:379-381,430), and settlement approval pays the loans off (see 18_offboarding.md:59). A settlement can still be created for an employee already terminated through the direct action (DOM-004), and the preview warns when a terminated employee has no end-of-service settlement (settlements/route.ts:561-563). EV-7902.
- The clearance certificate (إخلاء طرف) is strictly blocked server-side (owner decision 2026-09-26): `CLEARANCE_CERTIFICATE.build` (src/lib/documents/types.ts:740-786) returns an error per open asset, SIM, vehicle and loan (`loadExitFacts`, src/lib/documents/facts.ts:17-45) and while the settlement is not PAID; present in committed HEAD, tested at documents-pipeline.test.ts:420-421. EV-7903.
- Assign/transfer/request fulfilment refuse a terminated holder (`TERMINATED_HOLDER_MESSAGE`, src/app/api/services/_lib.ts:15-53) and `heldByTerminated` surfaces leftovers (EV-7037). EV-7904.
- EV-7035 is misleading as cited: the grep looked for asset/clearance terms only; `src/lib/settlement.ts` does handle loans.

Residual defect (why still PARTIAL, Medium): the employee-page banner and the settlement page (`settlements/new/page.tsx:1176-1179`, save disabled unless `allowAssetsRetention`, EV-7905) are UI-only gates that contradict the server policy, and the direct terminate action gives no server warning at all about open custody or loans. Fix direction: either return DOM-005 open-obligation warnings from the terminate action and soften the banner wording to a warning, or, if the owner decides to block, enforce it server-side with an override like `PROTECTED_LEAVE`.

