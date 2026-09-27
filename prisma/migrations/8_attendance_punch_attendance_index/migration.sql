-- Self attendance: index AttendancePunch.attendanceId.
-- Used by the "flagged punches still pending" count when HR reviews a punch, and by the
-- ON DELETE SET NULL foreign key when an Attendance row is deleted (no full scan of the log).
CREATE INDEX "AttendancePunch_attendanceId_idx" ON "AttendancePunch"("attendanceId");
