// The activation gate (AUDIT/16 §3.8): phase 2 is un-activatable by construction. activateWorkflowDefinition and
// startWorkflow refuse while the list is not empty. The blockers are compile-time constants; tests replace this
// file with vi.mock (there is no production seam). The other layers: the DB CHECK hasPayEffect = false, the
// payEffect: 'NONE' literal type and runtime check, and the strict settings schema (DEC-PO-139).
//
// BL-PAY-005 (named by the spec) has landed (502b62a); what still blocks:
//   WFE-003    package C: the single-operator exception, G9 attestation and the owner digest of engine acts;
//   FIRST-TYPE the owner activates the first request type (no type is activated by package B). Not lifted before
//              the two-person activation of DEC-PO-146 / ADR-0011 exists (package C).
import { adapterOf } from './adapters';

export const ACTIVATION_BLOCKERS: readonly string[] = Object.freeze(['WFE-003', 'FIRST-TYPE']);

export function activationBlockers(requestType: string): string[] {
  const out = [...ACTIVATION_BLOCKERS];
  const a = adapterOf(requestType);
  if (!a) out.push('NO-ADAPTER');
  else if ((a as { payEffect?: unknown }).payEffect !== 'NONE') out.push('DEC-PO-139');
  return out;
}
