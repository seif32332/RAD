-- 4_cancel_visas_of_cancelled_leaves
-- DATA ONLY. Older code left the auto-created exit/re-entry visa of a CANCELLED leave in
-- PENDING_PAYMENT (VisaStatus had no CANCELLED value). Those rows now block new outside-KSA
-- leaves for the employee. Mark them CANCELLED when every payment request for the visa was
-- withdrawn (RETURNED). Idempotent: only touches rows still in PENDING_PAYMENT.
UPDATE "Visa" v SET "status" = 'CANCELLED', "updatedAt" = now()
WHERE v."visaType" = 'خروج وعودة' AND v."status" = 'PENDING_PAYMENT'
  AND EXISTS (SELECT 1 FROM "PaymentRequest" p WHERE p."entityType" = 'VISA' AND p."entityId" = v."id")
  AND NOT EXISTS (SELECT 1 FROM "PaymentRequest" p WHERE p."entityType" = 'VISA' AND p."entityId" = v."id" AND p."status" <> 'RETURNED')
  AND EXISTS (SELECT 1 FROM "Leave" l WHERE l."status" = 'CANCELLED' AND v."deductedFrom" LIKE '%' || l."id" || '%');
