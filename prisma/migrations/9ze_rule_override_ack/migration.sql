-- 9ze_rule_override_ack (DEC-PO-126: a company may set a rule below the legal minimum, with a warning
-- and a record)
--
-- A CompanyRuleOverride outside the legal bound of its key (below a MIN floor, above a MAX ceiling) is
-- accepted only with an explicit acknowledgement, recorded on the row by the sole writer
-- (src/modules/rules/transitions.ts setCompanyRuleOverride): when, by whom, why, and the legal value
-- it departs from. Readers (rules.ruleAt) then use the override and flag it `belowLegal`; without an
-- acknowledgement an override the law has overtaken is still held at the bound. FIXED keys are still
-- refused (no row is written). INV-RULE-02 reports each active acknowledged override as an EXPLAINED,
-- non-blocking discrepancy.
--
-- Expand only: nullable columns, nothing an earlier release reads changes.

ALTER TABLE "CompanyRuleOverride"
    ADD COLUMN "belowLegalAckAt" TIMESTAMP(3),
    ADD COLUMN "belowLegalAckById" TEXT,
    ADD COLUMN "belowLegalReason" TEXT,
    ADD COLUMN "belowLegalLegalValue" DOUBLE PRECISION;

-- An acknowledgement always carries its reason and the legal value it departs from.
ALTER TABLE "CompanyRuleOverride"
    ADD CONSTRAINT "CompanyRuleOverride_belowLegal_ack_check" CHECK (
        ("belowLegalAckAt" IS NULL AND "belowLegalReason" IS NULL AND "belowLegalLegalValue" IS NULL AND "belowLegalAckById" IS NULL)
        OR ("belowLegalAckAt" IS NOT NULL AND "belowLegalReason" IS NOT NULL AND "belowLegalLegalValue" IS NOT NULL)
    );
