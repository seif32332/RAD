// Public API of the workflow module, the approval engine (WFE-002; DOMAIN_BOUNDARIES §5.1, §5.3). workflow imports
// platform and iam only; every other module may import it to register its adapters and ports. The engine decides
// (who approves, in which order, the outcome); each adapter applies the effect in its own module (G4, G10).
//
// Phase 2 (DEC-PO-139 / DEC-PO-145): no request type is activatable (activationBlockers), no pay effect (the
// payEffect 'NONE' literal, the runtime check, the DB CHECK), strict G1 / G1b everywhere (no single-operator
// exception before package C), and delegations are not read (package D).
import { activateWorkflowDefinition, retireWorkflowDefinition, saveWorkflowDefinitionDraft } from './transitions/definition';
import {
  cancelWorkflow,
  closeWorkflowExternally,
  pauseWorkflow,
  recheckWorkflow,
  restartWorkflowRound,
  resubmitWorkflow,
  resumeWorkflow,
  startWorkflow,
} from './transitions/instance';
import { actOnWorkflowTask } from './transitions/task';

export {
  startWorkflow,
  actOnWorkflowTask,
  cancelWorkflow,
  pauseWorkflow,
  resumeWorkflow,
  closeWorkflowExternally,
  recheckWorkflow,
  resubmitWorkflow,
  restartWorkflowRound,
  saveWorkflowDefinitionDraft,
  activateWorkflowDefinition,
  retireWorkflowDefinition,
};
export type { WorkflowResult } from './transitions/instance';
export type { ActInput } from './transitions/task';
export type { DefinitionResult } from './transitions/definition';

/** The facade of AUDIT/16 §3.1. */
export const workflow = Object.freeze({
  start: startWorkflow,
  act: actOnWorkflowTask,
  cancel: cancelWorkflow,
  pause: pauseWorkflow,
  resume: resumeWorkflow,
  closeExternally: closeWorkflowExternally,
  recheck: recheckWorkflow,
  resubmit: resubmitWorkflow,
  restartRound: restartWorkflowRound,
  saveDefinitionDraft: saveWorkflowDefinitionDraft,
  activateDefinition: activateWorkflowDefinition,
  retireDefinition: retireWorkflowDefinition,
});

export { registerWorkflowAdapter, registeredRequestTypes, CANCEL_REQUESTED, NO_CANDIDATE, REQUEST_TYPE_PATTERN, CODE_PATTERN } from './adapters';
export type {
  WorkflowAdapter,
  WfActor,
  ActorView,
  InstanceView,
  StageView,
  CandidateGuard,
  HookContext,
  Parties,
  FinalCheck,
  ExitPolicyDeclaration,
} from './adapters';

export { registerWorkflowPort, hasWorkflowPort, WORKFLOW_PORT_NAMES } from './ports';
export type {
  WorkflowPorts,
  WorkflowPortName,
  EmployeeLockPort,
  BeneficiaryStatePort,
  ManagerChainPort,
  AvailabilityPort,
  WorkingDaysPort,
  EmployeeStateRow,
} from './ports';

export { definitionProblems, definitionChecksum, canonicalJson, DEFINITION_LIMITS } from './definition';
export type { FieldCatalog, FieldSpec, FieldType, WorkflowDefinitionDoc, WfNode, StageNode, Expr, DefinitionSettings } from './definition';

export { DECISIONS_BY_KIND, TRANSITIONS, TERMINAL_STATUSES, OPEN_STATUSES } from './engine';
export type { WorkflowDecision, WfCommand } from './engine';

export { activationBlockers, ACTIVATION_BLOCKERS } from './activation';
export { WORKFLOW_EVENTS, WORKFLOW_AUDIT, WORKFLOW_AGGREGATE } from './events';
export type { WorkflowEventType } from './events';
export { WorkflowError, isWorkflowError, WORKFLOW_ERROR_STATUS } from './errors';
export type { WorkflowErrorCode } from './errors';

export { activeDefinitionFor, definitionsOf, instanceOf, instancesFor, tasksForUser, timelineOf, delegationsFor } from './queries';
export type { TimelineView } from './queries';
export { instanceWhere, delegationWhere, canWriteDelegations } from './scope';
