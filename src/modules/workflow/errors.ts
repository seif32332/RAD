// WorkflowError: every refusal of the engine, with a stable code, mapped onto HttpError (src/lib/http.ts) so a
// route's handleApiError returns the right status without knowing the engine.
import { HttpError } from '@/lib/http';

export const WORKFLOW_ERROR_STATUS = {
  /** Unknown instance / task / definition, or one outside the context's companies (no existence leak). */
  WFE_NOT_FOUND: 404,
  /** The actor may not do this (not a candidate, not an editor, adapter permission refused). */
  WFE_FORBIDDEN: 403,
  /** G1 / G1b / G2b: the actor is the beneficiary, the requester, the first rejecter or a prior approver. */
  WFE_SELF_ACTION: 403,
  /** CAS lost against a concurrent write; retry with the fresh version (details.retryable). */
  WFE_CONFLICT: 409,
  /** The command is not allowed from the instance's current status (§11.1). */
  WFE_INVALID_STATE: 409,
  /** A required port is not registered (fail closed, before any write). */
  WFE_PORT_MISSING: 500,
  /** No adapter registered for the request type. */
  WFE_ADAPTER_MISSING: 500,
  /** registerWorkflowAdapter refused the adapter (DEC-PO-139, format, duplicate). */
  WFE_ADAPTER_INVALID: 500,
  /** No ACTIVE definition for the type (company, then tenant). */
  WFE_NO_ACTIVE_DEFINITION: 409,
  /** activationBlockers is not empty (phase 2: never activatable). */
  WFE_NOT_ACTIVATABLE: 409,
  /**
   * DEC-PO-146 / ADR-0011: the activator wrote the draft (its creator or last editor), or is not a counted approver
   * where the company is ENFORCED: a second person activates.
   */
  WFE_TWO_PERSON_REQUIRED: 403,
  /** §12.1: the version loosens a control; the editor shows the warnings and the activation must confirm them. */
  WFE_CONFIRMATION_REQUIRED: 409,
  /** Beneficiaries of more than one company, or of no known company (ARC-WFE-A7). */
  WFE_CROSS_COMPANY: 422,
  /** The definition fails the strict schema or the save-time checks (§12.3). */
  WFE_DEFINITION_INVALID: 422,
  /** validateSubmit / validateFinal / input refused. */
  WFE_VALIDATION: 422,
  /** DEFERRAL_DECISION until BL-WFE-011. */
  WFE_KIND_NOT_SUPPORTED: 422,
  /** DEC-PO-139: no pay effect on the engine in phase 2. */
  WFE_PAY_EFFECT_UNSUPPORTED: 422,
  /** A hook (onApproved) failed persistently: recorded in a separate transaction (§12.11). */
  WFE_EFFECT_FAILED: 422,
} as const;

export type WorkflowErrorCode = keyof typeof WORKFLOW_ERROR_STATUS;

const MESSAGES: Record<WorkflowErrorCode, string> = {
  WFE_NOT_FOUND: 'الطلب أو المهمة غير موجودة',
  WFE_FORBIDDEN: 'ليس لديك صلاحية لتنفيذ هذا الإجراء على الطلب',
  WFE_SELF_ACTION: 'لا يجوز لك التصرف في طلب أنت صاحبه أو المستفيد منه أو سبق لك التصرف فيه',
  WFE_CONFLICT: 'تغيّر الطلب منذ فتحته، أعد تحميله وحاول مرة أخرى',
  WFE_INVALID_STATE: 'لا يمكن تنفيذ هذا الإجراء في حالة الطلب الحالية',
  WFE_PORT_MISSING: 'محرك الموافقات غير مهيأ',
  WFE_ADAPTER_MISSING: 'نوع الطلب غير مسجل في محرك الموافقات',
  WFE_ADAPTER_INVALID: 'تسجيل نوع الطلب مرفوض',
  WFE_NO_ACTIVE_DEFINITION: 'لا يوجد مسار موافقة مفعّل لهذا النوع من الطلبات',
  WFE_NOT_ACTIVATABLE: 'مسار الموافقة لا يمكن تفعيله بعد',
  WFE_TWO_PERSON_REQUIRED: 'يفعّل مسار الموافقة شخص آخر غير من كتبه أو عدّله آخر مرة، ومُقرّ بهويته',
  WFE_CONFIRMATION_REQUIRED: 'هذا الإصدار يرخي ضابطاً قائماً: راجع التحذيرات وأكّد التفعيل',
  WFE_CROSS_COMPANY: 'المستفيدون من أكثر من شركة',
  WFE_DEFINITION_INVALID: 'تعريف مسار الموافقة غير صالح',
  WFE_VALIDATION: 'الطلب لا يستوفي الشروط',
  WFE_KIND_NOT_SUPPORTED: 'هذا النوع من المهام غير مدعوم بعد',
  WFE_PAY_EFFECT_UNSUPPORTED: 'الطلبات ذات الأثر المالي غير مدعومة في محرك الموافقات بعد',
  WFE_EFFECT_FAILED: 'تعذّر تنفيذ أثر القرار، وبقيت المهمة مفتوحة',
};

export class WorkflowError extends HttpError {
  readonly code: WorkflowErrorCode;
  constructor(code: WorkflowErrorCode, detail?: string, details?: Record<string, unknown>) {
    super(WORKFLOW_ERROR_STATUS[code], MESSAGES[code], { code, ...(detail ? { detail } : {}), ...(details ?? {}) });
    this.code = code;
    this.name = 'WorkflowError';
  }
}

export function isWorkflowError(err: unknown, code?: WorkflowErrorCode): err is WorkflowError {
  return err instanceof WorkflowError && (!code || err.code === code);
}

/** 409 from a lost CAS on an instance that is still open: the client re-reads and retries. */
export function retryableConflict(instanceId: string, version: number): WorkflowError {
  return new WorkflowError('WFE_CONFLICT', `instance ${instanceId} is at version ${version}`, { retryable: true, instanceId, version });
}
