export type ScopeState = 'active' | 'paused' | 'closed';
export type MissionPhase = 'intake' | 'approval' | 'execution' | 'review' | 'exit';
export interface PrincipalView { id: string; kind: 'person' | 'organization'; displayName: string }
export interface ScopeView { id: string; kind: string; revision: string; epoch: string; state: ScopeState }
export interface MessageView { id: string; role: 'user' | 'system'; text: string; createdAt: string }
export interface MissionView {
  id: string; revision: string; title: string; phase: MissionPhase; conversationId: string;
  briefRef: string; contractRef: string; scope: ScopeView; outcomeId: string | null;
}
export interface ApprovalView {
  id: string; revision: string; missionId: string; actionDigest: string; explanationRevision: string;
  state: 'pending' | 'approved' | 'denied' | 'expired' | 'superseded'; expiresAt: string;
  explanation: { change: string; destination: string; account: string; route: string;
    maximumYen?: string; maximum?: import('./money.js').Money; month: string; estimateDifference: string; alternatives: string[];
    expectedBenefit: string; failureHandling: string; disclosure: string; retention: string;
    recovery: string; risk: string; dataClassification: string; additionalDisclosure: string };
}
export interface OutcomeView {
  id: string; revision: string; missionId: string; artifactId: string; explanationRevision: string;
  text: string; state: 'pending' | 'accepted' | 'revise' | 'hold' | 'close'; verification: 'local_fixture' | 'candidate_verified';
}
export interface IntentView {
  id: string; missionId: string; state: 'prepared' | 'send_intent' | 'completed' | 'unknown' | 'discarded';
  cancellation: 'not_requested' | 'requested' | 'observed'; heldYen?: string; bookedYen?: string;
  cash?:{currency:'USD';held:string;booked:string};
  reconciliationId: string | null;
}
export interface HomeSnapshot {
  budgetPolicy?:{id:string;revision:string;currency:'JPY'|'USD';normalLimit:string;reserveLimit:string|null;autonomousELimit:string};
  apiAttempts?: OpenRouterView[];
  knowledge?: KnowledgeView[];
  routing?: RoutingView[];
  candidateEvaluations: CandidateEvaluationSummary[];
  protocolVersion: 1; status: 'setup_required' | 'ready'; mode: 'local_fake';
  principal: PrincipalView | null; sessionGeneration: string; visibleCursor: string;
  application: ScopeView | null; principalScope: ScopeView | null; conversation: ScopeView | null;
  messages: MessageView[]; missions: MissionView[]; approvals: ApprovalView[];
  outcomes: OutcomeView[]; intents: IntentView[]; nativeAttempts:NativeAttemptView[];
  budget: { month: string; bookedYen: string; heldYen: string; limitYen: string; actualExternalCostYen: string; simulation: boolean;cash?:{currency:'USD';booked:string;held:string;limit:string;actualExternalCost:string} };
  pendingCount: number; oldestPendingAt: string | null; updatedAt: string;
}
export interface KnowledgeView {id:string;revision:string;scopeId:string;originMissionId:string;worker:string;text:string;state:'candidate'|'active'|'rejected'|'revoked';evaluationId:string|null;sourceVersions:readonly string[];useCount:number}
export interface OpenRouterView {
 recovery:{count:number;costConflict:boolean;recent:{id:string;observedAt:string;status:'observed'|'unknown';costCredits:string|null}[]};
 sourceLineage:{manifestId:string;inputDigest:string;sources:{id:string;version:string;digest:string}[]}|null;
 id:string;missionId:string;month:string;mode:'synthetic'|'provider'|'unverified';state:string;
 outputState:'completed'|'unknown'|'unsent';financialState:'settled'|'unsettled'|'released';
 model:string|null;provider:string|null;text:string|null;
 heldYen?:string;bookedYen?:string;heldUsd:string;bookedUsd:string;
 commonCash?:{currency:'USD';held:string;booked:string};
}
export interface RoutingView {id:string;missionId:string;kind:'continue'|'select'|'wait'|'blocked'|'pool';reason:string;model:string|null;candidateModels?:string[];effort:string|null;runtime:string|null;billingRoute:string|null;policyVersion:string;inputDigest:string}
export interface CandidateEvaluationSummary {
  id:string;missionId:string;proposalId:string;candidateDigest:string;
  status:'prepared'|'unknown'|'passed'|'failed'|'quarantined';evidenceKind:'synthetic'|'fixed_guest_fixture';checks:string[];
  review?:CandidateArtifactReview;
}
export type CandidateArtifactReview = {status:'unavailable'} | {
  status:'ready';artifactId:string;artifactDigest:string;beforeTreeDigest:string;afterTreeDigest:string;
  source:'unverified_text'|'unspecified';
  files:{path:string;before:string;after:string;beforeDigest:string;afterDigest:string}[];
};
export interface NativeAttemptView {
  sourceLineage?:{manifestId:string;inputDigest:string;sources:{id:string;version:string;digest:string}[]};
  id:string; scopeId:string; runId:string; mode:'synthetic'|'provider'; model:string; effort:string;
  state:'prepared'|'send_intent'|'running'|'completed'|'interrupted'|'failed'|'unknown'|'discarded';
  cancellation:'not_requested'|'requested'|'observed'; interruptionAcknowledged:boolean; quarantined:boolean;
  messages:{id:string;text:string}[];
  usage:import('../../native-codex/src/types.js').TextUsage|null;
}
export interface ClientError { ok: false; error: { code: string; retry: 'same_id' | 'reconcile' | 'none' } }
export interface ReceiptView {
  command_id: string; disposition: 'committed' | 'rejected'; visible_cursor: string;
  result_ref: string | null; error_code: string | null;
}
export interface CommandResult { ok: true; receipt: ReceiptView }
export type CoreResult = CommandResult | ClientError;
export interface FakeProfile {
  reservationUsd?:string; settledUsd?:string;
  reservationYen: string; settledYen: string; normalLimitYen: string; autonomousELimitYen: string;
  approvalLifetimeMs: number; outcome: 'success' | 'unknown';
}
export const DEFAULT_FAKE_PROFILE: Readonly<FakeProfile> = Object.freeze({
  reservationYen: '0', settledYen: '0', normalLimitYen: '1000', autonomousELimitYen: '100',
  approvalLifetimeMs: 15 * 60 * 1000, outcome: 'success',
});

export interface ConversationData { messageIds: string[]; missionIds: string[] }
export interface MissionData {
  title: string; phase: MissionPhase; conversationId: string; briefRef: string; contractRef: string;
  outcomeId: string | null; originalRequest: string; pendingContractRef?: string;
}
export interface ApprovalData extends Omit<ApprovalView, 'id' | 'revision'> {
  requestKey: string; intentId: string; policyRef: string; policyDigest: string; createdAt: string;
  decision: { actorId: string; membershipGeneration: string; comment: string | null; decidedAt: string } | null;
}
export interface IntentData {
  missionId: string; attemptId: string; approvalId: string; actionDigest: string; policyRef: string;
  state: IntentView['state']; cancellation: IntentView['cancellation'];
  ownerId: string; ownerEpoch: string; actorId: string; membershipGeneration: string; policyDigest: string;
  scopeEpochs: { id: string; epoch: string }[]; expiresAt: string;
  obligationId: string; reconciliationId: string | null;
}
export interface ObligationData {
  intentId: string; month: string; purpose: 'production' | 'autonomous_e'; pool: 'normal';
  reservedYen: string; heldYen: string; bookedYen: string; settled: boolean;
}
export interface CashObligationData {
  format:'cash_obligation_v1';intentId:string;month:string;purpose:'production'|'autonomous_e';pool:'normal'|'reserve';policyVersion:string;
  reserved:import('./money.js').Money;held:import('./money.js').Money;booked:import('./money.js').Money;settled:boolean;
}
export interface OutcomeData extends Omit<OutcomeView, 'id' | 'revision' | 'text'> { comment: string | null }
export interface PolicyData { mode: 'local_fake'; externalAllowed: false; normalLimitYen: string; autonomousELimitYen: string; cash?:import('./usd-budget.js').UsdBudgetPolicy&{format:'usd_budget_policy_v1';sourceEvidenceVersion?:string} }
export interface ReconciliationData { intentId: string; state: 'open' | 'investigation_closed' | 'resolved'; reason: string | null; evidenceRefs: string[] }
export type ObservationResult = { ok: true; result: { intentId: string; outcomeId: string | null; duplicate: boolean } } | ClientError;
