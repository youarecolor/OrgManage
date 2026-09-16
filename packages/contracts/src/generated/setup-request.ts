/* Generated from packages/contracts/schema/setup-request.schema.json. DO NOT EDIT.
 * Shape declarations only; authorization and runtime refinement remain separate. */

export type Id = string;

/**
 * Trusted bundled contract profile 0.1. Shape validation alone grants no authority and proves no execution.
 */
export interface SetupRequest {
  protocol_version: 1;
  setup_command_id: Id;
  principal: {
    kind: "person" | "organization";
    display_name: string;
  };
  owner_binding_candidate: null;
}
