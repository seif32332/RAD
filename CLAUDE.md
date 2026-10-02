# Radeef: instructions for every session and agent

Radeef is an Arabic-first Saudi HRMS (Next.js 16 App Router, Prisma 5 / PostgreSQL, one database per customer, several legal companies per database).

## The architecture constitution is binding

Before designing or changing code, read `docs/architecture/README.md` and the document it points to for your change:

- `DOMAIN_MODEL.md`: FACT / REQUEST / PROJECTION, effective periods, `effectiveContext`, money
- `LIFECYCLE_MODEL.md`: transitions synchronous, side effects asynchronous through `DomainEvent`, idempotency
- `SOURCE_OF_TRUTH.md`: where each fact lives and its sole writer
- `ARCHITECTURE_INVARIANTS.md`: ARCH-001..018, INV-*, the `Discrepancy` model, the definition of done
- `DOMAIN_BOUNDARIES.md`: table ownership, dependency direction, company-scope contract per module

Precedence: law and counsel, then the constitution, then READY PeopleOS designs (`.claude/councils/people-os/outputs/workflows/`), then owner defaults. Do not change the constitution while doing a task; propose an ADR in `docs/architecture/decisions/` instead.

In every plan or PR description, answer the six questions from `docs/architecture/README.md`: owning module, source of truth, transition, temporal effect, affected invariants, scope contract.

The current code does not conform yet. Gaps are recorded in `AUDIT/`, and the plan to close them is `AUDIT/13_MASTER_PLAN.md`. Do not add new violations. The ratchet baseline, once it exists, may only shrink.

## Hard rules while the codebase migrates

- Never write money, employment state, salary, assignment or effective-period data with a direct `prisma.<model>.update/create`; use (or build) the owning module's transition function.
- Never add a second copy of an existing fact, a legal constant outside `RuleParameter`, or business rules inside `scripts/`.
- Side effects (mail, documents, integrations) never run inside the state-transition transaction.
- Every new state-changing operation is idempotent and has a double-call test.
- Every new or changed API route enforces the company scope and has a real (unmocked auth) allow, deny and other-company test.

## Working in this repository

- Several sessions edit this tree at the same time without committing. Commit only your own hunks. Expect citation drift.
- Migrations: letter scheme (`9q_…`), never `10+`, never edit an applied migration.
- Tests: `npx vitest run`. Typecheck: `npm run typecheck`. Lint: `npm run lint`.
- Owner decisions: every business rule is a per-company editable default (DEC-PO-116); ask the owner about scope and direction, not rule values.
