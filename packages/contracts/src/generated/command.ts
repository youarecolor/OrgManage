/* Generated from packages/contracts/schema/command.schema.json. DO NOT EDIT.
 * Shape declarations only; authorization and runtime refinement remain separate. */

/**
 * Trusted bundled contract profile 0.1. Shape validation alone grants no authority and proves no execution.
 */
export type Command =
  | BudgetConfigureCommand
  | ConversationPostCommand
  | MissionStartCommand
  | OutcomeDecideCommand
  | ApprovalDecideCommand
  | MissionControlCommand
  | KnowledgeDecideCommand
  | ApplicationControlCommand
  | ScopeControlCommand;
export type Id = string;
export type Revision = string;
export type UsdAmount = string;
/**
 * @minItems 0
 * @maxItems 32
 */
export type Refs =
  | []
  | [Id]
  | [Id, Id]
  | [Id, Id, Id]
  | [Id, Id, Id, Id]
  | [Id, Id, Id, Id, Id]
  | [Id, Id, Id, Id, Id, Id]
  | [Id, Id, Id, Id, Id, Id, Id]
  | [Id, Id, Id, Id, Id, Id, Id, Id]
  | [Id, Id, Id, Id, Id, Id, Id, Id, Id]
  | [Id, Id, Id, Id, Id, Id, Id, Id, Id, Id]
  | [Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id]
  | [Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id]
  | [Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id]
  | [Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id]
  | [Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id]
  | [Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id]
  | [Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id]
  | [Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id]
  | [Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id]
  | [Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id]
  | [Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id]
  | [Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id]
  | [Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id]
  | [Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id]
  | [Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id]
  | [Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id]
  | [Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id]
  | [Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id]
  | [Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id, Id]
  | [
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id
    ]
  | [
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id
    ]
  | [
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id,
      Id
    ];
export type Comment = string | null;
export type Hash = string;

export interface BudgetConfigureCommand {
  protocol_version: 1;
  command_id: Id;
  command_type: "budget.configure";
  target_id: Id;
  expected_revision: Revision;
  payload: {
    currency: "USD";
    normal_limit: UsdAmount;
    reserve_limit: UsdAmount;
    autonomous_e_limit: UsdAmount;
  };
}
export interface ConversationPostCommand {
  protocol_version: 1;
  command_id: Id;
  command_type: "conversation.post";
  target_id: Id;
  expected_revision: Revision;
  payload: {
    message_id: Id;
    raw_text: string;
    attachment_refs: Refs;
    relation_hint: "continue" | "new" | "unspecified";
  };
}
export interface MissionStartCommand {
  protocol_version: 1;
  command_id: Id;
  command_type: "mission.start";
  target_id: Id;
  expected_revision: Revision;
  payload: {
    brief_revision: Id;
    contract_revision: Id;
  };
}
export interface OutcomeDecideCommand {
  protocol_version: 1;
  command_id: Id;
  command_type: "outcome.decide";
  target_id: Id;
  expected_revision: Revision;
  payload: {
    artifact_revision_id: Id;
    choice: "accepted" | "revise" | "hold" | "close";
    comment: Comment;
    explanation_revision: Revision;
  };
}
export interface ApprovalDecideCommand {
  protocol_version: 1;
  command_id: Id;
  command_type: "approval.decide";
  target_id: Id;
  expected_revision: Revision;
  payload: {
    action_digest: Hash;
    choice: "approve" | "deny";
    comment: Comment;
    explanation_revision: Revision;
  };
}
export interface MissionControlCommand {
  protocol_version: 1;
  command_id: Id;
  command_type: "mission.control";
  target_id: Id;
  expected_revision: Revision;
  payload: {
    choice: "pause" | "resume" | "close";
    comment: Comment;
  };
}
export interface KnowledgeDecideCommand {
  protocol_version: 1;
  command_id: Id;
  command_type: "knowledge.decide";
  target_id: Id;
  expected_revision: Revision;
  payload: {
    choice: "adopt" | "reject" | "revoke";
    candidate_ref: Id;
    evaluation_ref: Id | null;
    scope_ref: Id;
    comment: Comment;
  };
}
export interface ApplicationControlCommand {
  protocol_version: 1;
  command_id: Id;
  command_type: "application.control";
  target_id: Id;
  expected_revision: Revision;
  payload: {
    choice: "quiesce" | "recover_readonly" | "halt_dispatch" | "resume_dispatch";
    comment: Comment;
  };
}
export interface ScopeControlCommand {
  protocol_version: 1;
  command_id: Id;
  command_type: "scope.control";
  target_id: Id;
  expected_revision: Revision;
  payload: {
    scope: "principal" | "conversation" | "mission" | "control_operation";
    choice: "pause" | "resume" | "close";
    comment: Comment;
  };
}
