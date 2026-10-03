// Ports (ARC-WFE-A1, AUDIT/16 §3.2): the engine imports platform and iam only (DOMAIN_BOUNDARIES §5.3); what it
// needs from people, lifecycle, org, calendar and leave is registered here by those modules (or by the
// composition root, src/lib/workflow-wiring.ts). Fail closed: a missing required port is WFE_PORT_MISSING
// before any write, and a port name is registered once only (nothing can be overridden at run time).
import type { CompanySet } from '@/modules/iam';
import type { TxClient } from '@/modules/platform';
import { WorkflowError } from './errors';

/** ADR-0002 #2 / ARCH-019: the FIRST lock of every engine transaction (people.lockEmployees). */
export interface EmployeeLockPort {
  lockEmployees(tx: TxClient, employeeIds: readonly string[], companyIds: CompanySet): Promise<{ id: string; legalCompanyId: string | null }[]>;
}

export type EmploymentStateOfPort = 'ACTIVE' | 'NOTICE' | 'TERMINATED';

export interface EmployeeStateRow {
  employeeId: string;
  userId: string | null;
  /** The legal company. */
  companyId: string | null;
  employmentState: EmploymentStateOfPort;
  lastWorkingDay: Date | null;
}

/** lifecycle readers: any employee id (beneficiaries, managers), and the employee of a login. */
export interface BeneficiaryStatePort {
  employees(tx: TxClient, ids: readonly string[], asOf: Date): Promise<EmployeeStateRow[]>;
  /**
   * The employee (if any) linked to each login, with its state (G9 "غير منفصل": a login whose employee is
   * TERMINATED is never an approver). Logins without an employee are absent from the result.
   */
  employeesOfUsers(tx: TxClient, userIds: readonly string[], asOf: Date): Promise<EmployeeStateRow[]>;
}

/** org: the direct manager (employee id) in force on a day. */
export interface ManagerChainPort {
  managerOf(tx: TxClient, employeeId: string, asOf: Date): Promise<string | null>;
}

/** leave: employees unavailable (on leave) on a day (the Riyadh calendar day of the instant given). */
export interface AvailabilityPort {
  unavailable(tx: TxClient, employeeIds: readonly string[], day: Date): Promise<Set<string>>;
}

/** calendar: the date `days` working days after `from` in the company's calendar. */
export interface WorkingDaysPort {
  addWorkingDays(tx: TxClient, companyId: string, from: Date, days: number): Promise<Date>;
}

export interface WorkflowPorts {
  EmployeeLock: EmployeeLockPort;
  BeneficiaryState: BeneficiaryStatePort;
  ManagerChain: ManagerChainPort;
  Availability: AvailabilityPort;
  WorkingDays: WorkingDaysPort;
}
export type WorkflowPortName = keyof WorkflowPorts;

export const WORKFLOW_PORT_NAMES: readonly WorkflowPortName[] = Object.freeze(['EmployeeLock', 'BeneficiaryState', 'ManagerChain', 'Availability', 'WorkingDays']);

/** Required by every command, even without beneficiaries (§3.2). */
export const ALWAYS_REQUIRED_PORTS: readonly WorkflowPortName[] = Object.freeze(['EmployeeLock', 'BeneficiaryState']);

const METHODS: Record<WorkflowPortName, readonly string[]> = {
  EmployeeLock: ['lockEmployees'],
  BeneficiaryState: ['employees', 'employeesOfUsers'],
  ManagerChain: ['managerOf'],
  Availability: ['unavailable'],
  WorkingDays: ['addWorkingDays'],
};

const registry = new Map<WorkflowPortName, unknown>();

export function registerWorkflowPort<K extends WorkflowPortName>(name: K, impl: WorkflowPorts[K]): void {
  if (!WORKFLOW_PORT_NAMES.includes(name)) throw new WorkflowError('WFE_PORT_MISSING', `unknown port ${String(name)}`);
  if (registry.has(name)) throw new Error(`workflow port ${name} is already registered (a port is never overridden)`);
  for (const m of METHODS[name]) {
    if (typeof (impl as unknown as Record<string, unknown>)?.[m] !== 'function') throw new Error(`workflow port ${name}: missing method ${m}`);
  }
  registry.set(name, Object.freeze({ ...impl }));
}

export function hasWorkflowPort(name: WorkflowPortName): boolean {
  return registry.has(name);
}

/** The registered port, or WFE_PORT_MISSING. */
export function requirePort<K extends WorkflowPortName>(name: K): WorkflowPorts[K] {
  const p = registry.get(name);
  if (!p) throw new WorkflowError('WFE_PORT_MISSING', name);
  return p as WorkflowPorts[K];
}

/** Throws WFE_PORT_MISSING for the first missing name (called before any write). */
export function requirePorts(names: readonly WorkflowPortName[]): void {
  for (const n of names) requirePort(n);
}

/** testing.ts only. */
export function resetPortRegistry(): void {
  registry.clear();
}
