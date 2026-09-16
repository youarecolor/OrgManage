/* Generated from packages/contracts/schema/command-receipt.schema.json. DO NOT EDIT.
 * Shape declarations only; authorization and runtime refinement remain separate. */

/**
 * Trusted bundled contract profile 0.1. Shape validation alone grants no authority and proves no execution.
 */
export type CommandReceipt = CommittedCommandReceipt | RejectedCommandReceipt;
export type Id = string;
export type VisibleCursor = string;

export interface CommittedCommandReceipt {
  command_id: Id;
  disposition: "committed";
  visible_cursor: VisibleCursor;
  result_ref: Id | null;
  error_code: null;
}
export interface RejectedCommandReceipt {
  command_id: Id;
  disposition: "rejected";
  visible_cursor: VisibleCursor;
  result_ref: Id | null;
  error_code:
    | "REVISION_CONFLICT"
    | "COMMAND_CONFLICT"
    | "ALREADY_INITIALIZED"
    | "DENIED"
    | "POLICY_EXPIRED"
    | "BUDGET_BLOCKED"
    | "CAPABILITY_UNVERIFIED"
    | "ARTIFACT_NOT_READY";
}
