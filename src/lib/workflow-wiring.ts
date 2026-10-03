// Composition root of the approval engine (WFE-002, AUDIT/16 §3.1 "Outside the module"). workflow imports platform
// and iam only (ARC-WFE-A1); the ports it needs are registered here, once, before the first command:
//   EmployeeLock      people.lockEmployees (the first lock of every engine transaction, ADR-0002 #2)
//   BeneficiaryState  lifecycle readers (state, last working day, the login of an employee)
//   ManagerChain      org: the manager of the assignment in force
//   WorkingDays       calendar: the company calendar (default weekdays + holidays)
//   Availability      legacy leave reader (no leave module yet, 14_PHASE2_PLAN.md:67)
// Called from src/jobs/consumers.ts and from every route that calls the engine (packages G and J). Idempotent.
// Port dates are instants; each port reads the Riyadh calendar day of it (src/lib/dates.ts today()).
// This path has no module mapping (test/architecture/config.ts), so it may import every module (ARCH-001.dir).
import { addCompanyWorkingDays } from '@/modules/calendar';
import { registerLifecycleWorkflowPorts } from '@/modules/lifecycle';
import { managerAt } from '@/modules/org';
import { registerPeopleWorkflowPorts } from '@/modules/people';
import { hasWorkflowPort, registerWorkflowPort } from '@/modules/workflow';
import { today } from '@/lib/dates';
import { onLeaveEmployeeIds } from '@/lib/leave-server';

export function ensureWorkflowWiring(): void {
  registerPeopleWorkflowPorts();
  registerLifecycleWorkflowPorts();
  if (!hasWorkflowPort('ManagerChain')) {
    registerWorkflowPort('ManagerChain', { managerOf: (tx, employeeId, asOf) => managerAt(tx, employeeId, today(asOf)) });
  }
  if (!hasWorkflowPort('WorkingDays')) {
    registerWorkflowPort('WorkingDays', { addWorkingDays: (tx, companyId, from, days) => addCompanyWorkingDays(tx, companyId, today(from), days) });
  }
  if (!hasWorkflowPort('Availability')) {
    registerWorkflowPort('Availability', { unavailable: (tx, employeeIds, day) => onLeaveEmployeeIds(tx, employeeIds, today(day)) });
  }
}
