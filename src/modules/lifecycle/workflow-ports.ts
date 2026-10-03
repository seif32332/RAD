// The approval engine's BeneficiaryStatePort (WFE-002, AUDIT/16 §3.2): for any employee (beneficiaries, managers) or
// any login, the legal company, the employment state and the last working day, read with the lifecycle readers
// (effectiveState / employmentEnd: the BR-LCY-013 reading stays inside lifecycle). The engine excludes a login whose
// employee is TERMINATED from every approval step (G9 "غير منفصل") and reads a beneficiary's login for G1 here.
import { employeesForLifecycle, employeesOfUsersForLifecycle, type EmployeeLifecycleRow } from '@/modules/people';
import { hasWorkflowPort, registerWorkflowPort, type EmployeeStateRow } from '@/modules/workflow';
import { effectiveState, employmentEnd } from './queries';

export function employmentStateRows(rows: readonly EmployeeLifecycleRow[]): EmployeeStateRow[] {
  return rows.map((e) => ({
    employeeId: e.id,
    userId: e.userId,
    companyId: e.legalCompanyId,
    employmentState: effectiveState(e),
    lastWorkingDay: employmentEnd(e),
  }));
}

/** Idempotent: a port is registered once. */
export function registerLifecycleWorkflowPorts(): void {
  if (hasWorkflowPort('BeneficiaryState')) return;
  registerWorkflowPort('BeneficiaryState', {
    employees: async (tx, ids) => employmentStateRows(await employeesForLifecycle(tx, ids)),
    employeesOfUsers: async (tx, userIds) => employmentStateRows(await employeesOfUsersForLifecycle(tx, userIds)),
  });
}
