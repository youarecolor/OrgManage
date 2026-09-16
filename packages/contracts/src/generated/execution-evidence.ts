/* Generated from packages/contracts/schema/execution-evidence.schema.json. DO NOT EDIT.
 * Shape declarations only; authorization and runtime refinement remain separate. */

export type Id = string;

/**
 * Trusted bundled contract profile 0.1. Shape validation alone grants no authority and proves no execution.
 */
export interface ExecutionEvidence {
  cancellation: CancellationNotRequested | CancellationRequested | CancellationObserved;
  effect: UnknownEffect | NotSentEffect | AcceptedEffect | CompletedEffect | FailedEffect;
}
export interface CancellationNotRequested {
  kind: "not_requested";
}
export interface CancellationRequested {
  kind: "requested";
  request_ref: Id;
}
export interface CancellationObserved {
  kind: "observed";
  request_ref: Id;
  observation_ref: Id;
}
export interface UnknownEffect {
  kind: "unknown";
  reconciliation_ref: Id;
}
export interface NotSentEffect {
  kind: "not_sent";
  evidence_ref: Id;
}
export interface AcceptedEffect {
  kind: "accepted";
  evidence_ref: Id;
}
export interface CompletedEffect {
  kind: "completed";
  evidence_ref: Id;
}
export interface FailedEffect {
  kind: "failed";
  evidence_ref: Id;
}
