// DomainEvent consumers of every module, registered with the platform dispatcher before the
// domain-events job runs (LIFECYCLE_MODEL §2.2). Add one side-effect import per module that has a
// consumers.ts, e.g.:
//   import '@/modules/payroll/consumers';
// A module whose index registers its consumers is imported and asked to register (a deep import of
// a module's consumers.ts would bypass its public interface, ARCH-001).
import { INV_SAL_01_ID, payProjectionCheck, registerCompensationConsumers } from '@/modules/compensation';
import { registerIamConsumers } from '@/modules/iam';
import { registerOffboardingConsumers } from '@/modules/offboarding';
import { INV_PAY_04_ID, employmentChangeCheck, registerPayrollConsumers } from '@/modules/payroll';
import { consumerRegistry, registerConsumer, registerInvariantCheck } from '@/modules/platform';
import { INV_RULE_02_ID, RULES_CONSUMERS, belowLegalOverrideCheck } from '@/modules/rules';
import { ensureWorkflowWiring } from '@/lib/workflow-wiring';
import { registerWorkflowConsumers } from '@/modules/workflow';

// WFE-002: the approval engine's ports (people lock, lifecycle state, org manager, calendar, leave availability),
// registered before any consumer can call the engine.
ensureWorkflowWiring();
// BL-WFE-003 (X-WFE-012): a change of a company's controls mode rechecks its RUNNING and BLOCKED approvals.
registerWorkflowConsumers();

// BL-PAY-005: iam queues the one-time credential link emails (reset, first attestation).
registerIamConsumers();

// P1-LCY: offboarding projects the exit reason of every employment.* event.
registerOffboardingConsumers();

// P1-PAY-B: compensation cancels the pay changes that would start after an employment ends (ARC-PAY-A2),
// and its INV-SAL-01 check compares the Employee pay projection with the facts.
registerCompensationConsumers();
registerInvariantCheck(INV_SAL_01_ID, payProjectionCheck);

// P1-PAY-A (BL-PAY-025): payroll regenerates an employee's draft on every employment.* event, and its
// INV-PAY-04 check reports the changes it could not apply (approved / paid lines, dead consumptions).
registerPayrollConsumers();
registerInvariantCheck(INV_PAY_04_ID, employmentChangeCheck);

// DEC-PO-126: the owner alert of an override outside the legal bound, and the INV-RULE-02 check that
// reconcile runs (the rules index is client-safe, so it does not register itself).
for (const c of RULES_CONSUMERS) if (!consumerRegistry.list().some((r) => r.name === c.name)) registerConsumer(c);
registerInvariantCheck(INV_RULE_02_ID, belowLegalOverrideCheck);
