-- 9s_on_leave_reset (P0-06 = BL-LCY-002 Release A)
-- DATA ONLY (no DDL). "On leave" is now computed from approved Leave rows covering the day
-- (BR-LCY-008, DEC-PO-030; src/lib/leave.ts onLeaveWhere / src/lib/leave-server.ts isOnLeave). The
-- code no longer writes or reads Employee.employmentStatus = 'ON_LEAVE'. The only writer was a paid
-- LEAVE_SETTLEMENT (finance.ts markSettlementPaid, EV-3017) and nothing ever cleared it, so every row
-- still holding it is stale (EV-3016, EV-3902).
--
--   Employee.employmentStatus 'ON_LEAVE' -> 'ACTIVE'
--       Same target as the LCY-J1 backfill map (lcy-to-be.md §17: ON_LEAVE -> ACTIVE). ACTIVE is the
--       schema default and the value every non-EXCLUDED employee holds. Termination is unaffected:
--       isTerminated / terminationDate are not touched. An employee really on leave today still shows
--       on leave, from the Leave rows.
--
-- Idempotent: only rows still holding 'ON_LEAVE' are touched, so a second run changes nothing. The
-- previous value is kept in AuditLog (one row per employee, deterministic id, ON CONFLICT DO NOTHING)
-- so the reset can be traced.

WITH reset AS (
  UPDATE "Employee"
  SET "employmentStatus" = 'ACTIVE', "updatedAt" = NOW()
  WHERE "employmentStatus" = 'ON_LEAVE'
  RETURNING "id"
)
INSERT INTO "AuditLog" ("id", "userId", "action", "entityType", "entityId", "details", "ipAddress", "createdAt")
SELECT
  'mig-9s-on-leave-reset-' || reset."id",
  NULL,
  'UPDATE',
  'Employee',
  reset."id",
  '{"event":"ON_LEAVE_RESET","migration":"9s_on_leave_reset","from":"ON_LEAVE","to":"ACTIVE","reason":"BL-LCY-002: on leave is computed from approved Leave rows"}',
  NULL,
  NOW()
FROM reset
ON CONFLICT ("id") DO NOTHING;
