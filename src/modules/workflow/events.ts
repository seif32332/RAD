// The DomainEvents of the engine (DOMAIN_BOUNDARIES §5.5; AUDIT/16 §3.7). Only these types exist; pause, resume,
// resubmit and restartRound write an AuditRecord only (a new type would need an ADR). Payloads carry ids, the
// company and the actor only (LIFECYCLE_MODEL §2.4). Keys: `${opKey}:${type}` per instance and
// `${opKey}:${type}:${taskId}` per task (ARCH-010).
export const WORKFLOW_EVENTS = Object.freeze({
  taskAssigned: 'workflow.task.assigned',
  taskNotRequired: 'workflow.task.notRequired',
  instanceDecided: 'workflow.instance.decided',
  instanceReturned: 'workflow.instance.returned',
  instanceBlocked: 'workflow.instance.blocked',
  instanceAwaitingRequirement: 'workflow.instance.awaitingRequirement',
  instanceEffectFailed: 'workflow.instance.effectFailed',
} as const);

export type WorkflowEventType = (typeof WORKFLOW_EVENTS)[keyof typeof WORKFLOW_EVENTS];

export const WORKFLOW_AGGREGATE = 'WorkflowInstance';

export function instanceEventKey(opKey: string, type: WorkflowEventType): string {
  return `${opKey}:${type}`;
}

export function taskEventKey(opKey: string, type: WorkflowEventType, taskId: string): string {
  return `${opKey}:${type}:${taskId}`;
}

/** Audit actions of the engine (entity WorkflowInstance / WorkflowDefinition). */
export const WORKFLOW_AUDIT = Object.freeze({
  started: 'workflow.instance.start',
  autoApproved: 'AUTO_APPROVED_BY_DEFINITION',
  requirementMet: 'REQUIREMENT_MET',
  acted: 'workflow.task.act',
  cancelled: 'workflow.instance.cancel',
  cancelRequested: 'workflow.instance.cancelRequest',
  paused: 'workflow.instance.pause',
  resumed: 'workflow.instance.resume',
  closedExternally: 'workflow.instance.closeExternally',
  rechecked: 'workflow.instance.recheck',
  resubmitted: 'workflow.instance.resubmit',
  roundRestarted: 'workflow.instance.restartRound',
  effectFailed: 'workflow.instance.effectFailed',
  definitionDraftSaved: 'workflow.definition.saveDraft',
  definitionActivated: 'workflow.definition.activate',
  definitionRetired: 'workflow.definition.retire',
} as const);
