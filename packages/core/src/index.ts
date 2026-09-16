import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';
import { decodeCommand, decodeSetup } from '../../contracts/src/index.js';
import type { Command, DeepReadonly } from '../../contracts/src/index.js';
import { LedgerBusyError, LedgerIntegrityError, LedgerOwnerError, RevisionConflictError } from '../../ledger/src/index.js';
import type { LedgerStore, LedgerReader, LedgerTransaction, LedgerRecord, Scope } from '../../ledger/src/index.js';
import { aggregate, budgetMonth, canReserve, yen } from './budget.js';
import {formatMoney,moneyUnits,parseMoney,type Money} from './money.js';
import {makeUsdBudgetPolicy,canReserveUsd} from './usd-budget.js';
import {isCash,cashBudgetRows,type CommonObligation} from './cash-obligation.js';
import { DEFAULT_FAKE_PROFILE } from './model.js';
import { isLocalFixtureIntent } from './local-fixture-boundary.js';
import { FixedRunnerCoordinator } from './runner.js';
import { CodexTurnCoordinator } from './codex-turn.js';
import { NativeActionCoordinator, NativeActionDenied } from './native-action.js';
import { CandidateCoordinator } from './candidate.js';
import { KnowledgeCoordinator, KnowledgeDenied } from './knowledge.js';
import { DisclosureCoordinator } from './disclosure.js';
export { RoutingCoordinator } from './routing-ledger.js';
import { routingViews } from './routing-ledger.js';
import { openrouterViews } from './openrouter-views.js';
import { ApiTrialBudget } from './api-trial-budget.js';
export { selectRoute, sealConfiguration } from './routing.js';
import { CandidateEvaluationCoordinator } from './candidate-evaluation.js';
import type { CandidateEvaluationRegistration } from './candidate-evaluation.js';
import type {ArtifactDecisionWitness} from './candidate-evaluation.js';
export { CandidateEvaluationCoordinator } from './candidate-evaluation.js';
export type { CandidateEvaluationRegistration, CandidateEvaluationPlan, CandidateEvaluationPort, CandidateEvaluationView } from './candidate-evaluation.js';
import type { FixedRunnerRegistration } from './runner.js';
export { FixedRunnerCoordinator, RunnerDeniedError } from './runner.js';
export type { FixedRunnerRegistration, FixedVerificationPort, RunnerBinding } from './runner.js';
import type { ApprovalData, ConversationData, CoreResult, FakeProfile, HomeSnapshot, IntentData, MissionData,
  ObligationData, OutcomeData, PolicyData, ReceiptView, ReconciliationData, ScopeView, ClientError, ObservationResult } from './model.js';
export * from './model.js';
export { aggregate, budgetMonth, canReserve, yen } from './budget.js';

declare const sessionBrand: unique symbol;
export interface CoreSession { readonly [sessionBrand]: true }
interface SessionState { actorId: string; principalId: string | null; generation: bigint; membershipGeneration: bigint | null }
export interface CoreOptions { clock?: () => Date; fakeProfile?: Partial<FakeProfile>; id?: () => string; runnerProfiles?: readonly FixedRunnerRegistration[]; runnerResponseTimeoutMs?: number; evaluationProfiles?:readonly CandidateEvaluationRegistration[]; collectionTimeoutMs?:number }
class Rejection extends Error { constructor(readonly code: string) { super(code); } }
function deny(code = 'DENIED'): never { throw new Rejection(code); }
const error = (code: string): ClientError => ({ ok: false, error: { code,
  retry: code === 'BUSY_NOT_COMMITTED' ? 'same_id' : code === 'OUTCOME_UNKNOWN' ? 'reconcile' : 'none' } });
const data = <T>(record: LedgerRecord): T => JSON.parse(record.data) as T;
const digest = (value: unknown): string => createHash('sha256').update(canonicalize(value)!).digest('hex');
const scopeView = (row: Scope): ScopeView => ({ id: row.id, kind: row.kind, revision: String(row.revision), epoch: String(row.epoch), state: row.state });

/** Trusted local service. Session creation is a host integration port, never a renderer command. */
export class OrgManageCore {
  readonly context: DisclosureCoordinator;
  readonly knowledge: KnowledgeCoordinator;
  readonly candidateEvaluation: CandidateEvaluationCoordinator;
  readonly candidate: CandidateCoordinator;
  readonly codex: CodexTurnCoordinator;
  readonly nativeActions: NativeActionCoordinator;
  readonly runner: FixedRunnerCoordinator;
  readonly #sessions = new WeakMap<CoreSession, SessionState>();
  readonly #clock: () => Date;
  readonly #id: () => string;
  readonly #profile: FakeProfile;
  constructor(readonly store: LedgerStore, options: CoreOptions = {}) {
    this.#clock = options.clock ?? (() => new Date());
    this.#id = options.id ?? randomUUID;
    this.knowledge = new KnowledgeCoordinator(store,()=>this.#clock().getTime());
    this.context = new DisclosureCoordinator(store,()=>this.#clock().getTime());
    this.candidate = new CandidateCoordinator(store, () => this.#clock().getTime());
    this.#profile = { ...DEFAULT_FAKE_PROFILE, ...options.fakeProfile };
    for (const amount of [this.#profile.reservationYen, this.#profile.settledYen, this.#profile.normalLimitYen, this.#profile.autonomousELimitYen]) yen(amount);
    parseMoney('USD',this.#profile.reservationUsd??'0');parseMoney('USD',this.#profile.settledUsd??'0');
    if (!Number.isSafeInteger(this.#profile.approvalLifetimeMs) || this.#profile.approvalLifetimeMs < 1 || this.#profile.approvalLifetimeMs > 86_400_000) throw new RangeError('Invalid finite approval lifetime');
    this.#recoverOldOwner();
    this.codex = new CodexTurnCoordinator(store, () => this.#clock().getTime());
    this.nativeActions = new NativeActionCoordinator(store, () => this.#clock().getTime());
    this.runner = new FixedRunnerCoordinator(store, [...options.runnerProfiles ?? [], ...options.evaluationProfiles ?? []], () => this.#clock().getTime(), options.runnerResponseTimeoutMs ?? 15000);
    this.candidateEvaluation = new CandidateEvaluationCoordinator(store,this.candidate,this.runner,options.evaluationProfiles??[],()=>this.#clock().getTime(),options.collectionTimeoutMs??15000);
  }

  openSession(actorId: string): CoreSession {
    if (!actorId || actorId.length > 256) throw new Error('Host identity required');
    const session = Object.freeze({}) as CoreSession;
    const selected = this.store.read(tx => tx.listPrincipal().find(p => {
      const membership = tx.getMembership(p.id, actorId); return membership && membership.role !== 'revoked';
    }));
    const membership = selected ? this.store.read(tx => tx.getMembership(selected.id, actorId)) : undefined;
    this.#sessions.set(session, { actorId, principalId: selected?.id ?? null, generation: 1n, membershipGeneration: membership?.generation ?? null });
    return session;
  }

  selectPrincipal(session: CoreSession, principalId: string): CoreSession | ClientError {
    try {
      const state = this.#session(session);
      const member = this.store.read(tx => tx.getMembership(principalId, state.actorId));
      if (!member || member.role === 'revoked') return error('DENIED');
      const next = Object.freeze({}) as CoreSession;
      this.#sessions.delete(session);
      this.#sessions.set(next, { actorId: state.actorId, principalId, generation: state.generation + 1n, membershipGeneration: member.generation });
      return next;
    } catch (cause) { return this.#failure(cause); }
  }

  setup(session: CoreSession, bytes: Uint8Array): CoreResult {
    const parsed = decodeSetup(bytes); if (!parsed.ok) return error(parsed.error.code);
    try {
      const state = this.#session(session), request = parsed.value;
      const result = this.store.transaction(tx => {
        const initialized = tx.getMeta('bootstrap');
        if (initialized) {
          const prior = JSON.parse(initialized) as { actorId: string; principalId: string; commandId: string; digest: string; receipt: ReceiptView };
          if (prior.actorId !== state.actorId) return error('DENIED');
          const member = tx.getMembership(prior.principalId, state.actorId);
          if (!member || member.role !== 'owner') return error('DENIED');
          if (prior.commandId !== request.setup_command_id) return error('ALREADY_INITIALIZED');
          if (prior.digest !== parsed.digest) return error('COMMAND_CONFLICT');
          state.principalId = prior.principalId; state.membershipGeneration = member.generation;
          return { ok: true as const, receipt: prior.receipt };
        }
        if (tx.listPrincipal().length) throw new LedgerIntegrityError('Partial bootstrap must not be reset');
        const principalId = this.#id(), applicationId = this.#id(), conversationId = this.#id(), policyId = this.#id();
        tx.insertPrincipal({ id: principalId, kind: request.principal.kind, displayName: request.principal.display_name });
        tx.putMembership({ principalId, actorId: state.actorId, role: 'owner', generation: 1n });
        tx.insertScope({ id: applicationId, principalId: null, kind: 'application', parentId: null, revision: 1n, epoch: 1n, state: 'active' });
        tx.insertScope({ id: principalId, principalId, kind: 'principal', parentId: applicationId, revision: 1n, epoch: 1n, state: 'active' });
        tx.insertScope({ id: conversationId, principalId, kind: 'conversation', parentId: principalId, revision: 1n, epoch: 1n, state: 'active' });
        this.#insert(tx, principalId, conversationId, 'conversation', { messageIds: [], missionIds: [] } satisfies ConversationData);
        this.#insert(tx, principalId, policyId, 'policy', { mode: 'local_fake', externalAllowed: false,
          normalLimitYen: this.#profile.normalLimitYen, autonomousELimitYen: this.#profile.autonomousELimitYen } satisfies PolicyData);
        tx.setMeta('application_scope', applicationId);
        tx.setMeta(`policy:${principalId}`, policyId);
        tx.setMeta('cursor_key', randomBytes(32).toString('hex'));
        tx.setMeta(`feed:${principalId}`, randomBytes(24).toString('base64url'));
        tx.appendAudit({ principalId, commandId: request.setup_command_id, kind: 'bootstrap.committed', entityId: principalId, createdAt: this.#now() });
        const receipt: ReceiptView = { command_id: request.setup_command_id, disposition: 'committed',
          visible_cursor: this.#cursorFor(tx, { ...state, principalId, membershipGeneration: 1n }), result_ref: conversationId, error_code: null };
        tx.insertCommand({ principalId, commandId: request.setup_command_id, actorId: state.actorId, digest: parsed.digest, receipt: JSON.stringify(receipt) });
        tx.setMeta('bootstrap', JSON.stringify({ actorId: state.actorId, principalId, commandId: request.setup_command_id, digest: parsed.digest, receipt }));
        return { ok: true as const, receipt, principalId };
      });
      // Session state changes only after the bootstrap transaction commits.
      if (result.ok && 'principalId' in result) { state.principalId = result.principalId; state.membershipGeneration = 1n; }
      return result.ok ? { ok: true, receipt: result.receipt } : result;
    } catch (cause) { return this.#failure(cause); }
  }

  command(session: CoreSession, bytes: Uint8Array): CoreResult {
    const parsed = decodeCommand(bytes); if (!parsed.ok) return error(parsed.error.code);
    try {
      const state = this.#session(session);
      let artifactWitness:ArtifactDecisionWitness|undefined;
      if(parsed.value.command_type==='outcome.decide'){
        const command=parsed.value;
        const candidate=this.store.read(tx=>{
          const p=this.#authorize(tx,state,false);
          if(tx.getCommand(p,command.command_id))return undefined;
          return tx.candidateArtifact.get(p,command.payload.artifact_revision_id);
        });
        if(candidate){try{artifactWitness=this.candidateEvaluation.prepareArtifactDecision(state.actorId,candidate.principalId,candidate.id);}catch{deny('ARTIFACT_NOT_READY');}}
      }
      return this.store.transaction(tx => {
        const principalId = this.#authorize(tx, state, true);
        const command = parsed.value;
        const prior = tx.getCommand(principalId, command.command_id);
        if (prior) {
          if (prior.actorId !== state.actorId) return error('DENIED');
          if (prior.digest !== parsed.digest) return error('COMMAND_CONFLICT');
          return { ok: true as const, receipt: JSON.parse(prior.receipt) as ReceiptView };
        }
        // Handler preconditions run before mutations; rejection must not commit half an action.
        const resultRef = this.#execute(tx, state, principalId, command,artifactWitness);
        const receipt = this.#receipt(tx, state, command.command_id, resultRef, null);
        tx.insertCommand({ principalId, commandId: command.command_id, actorId: state.actorId, digest: parsed.digest, receipt: JSON.stringify(receipt) });
        return { ok: true as const, receipt };
      });
    } catch (cause) {
      // Rejected business commands get a separate atomic terminal receipt after all handler writes roll back.
      if (cause instanceof Rejection || cause instanceof NativeActionDenied || cause instanceof RevisionConflictError) {
        return this.#recordRejection(session, parsed.value.command_id, parsed.digest,
          cause instanceof RevisionConflictError ? 'REVISION_CONFLICT' : cause.code);
      }
      return this.#failure(cause);
    }
  }

  receipt(session: CoreSession, commandId: string): CoreResult {
    try {
      return this.store.read(tx => {
        const state = this.#session(session), principalId = this.#authorize(tx, state, false);
        const record = tx.getCommand(principalId, commandId);
        if (!record || record.actorId !== state.actorId) return error('DENIED');
        return { ok: true, receipt: JSON.parse(record.receipt) as ReceiptView };
      });
    } catch (cause) { return this.#failure(cause); }
  }

  snapshot(session: CoreSession): HomeSnapshot | ClientError {
    try {
      const snapshot=this.store.read<HomeSnapshot>(tx => {
        const state = this.#session(session), now = this.#now(), month = budgetMonth(new Date(now));
        if (!tx.getMeta('bootstrap')) return { protocolVersion: 1, status: 'setup_required', mode: 'local_fake', principal: null,
          sessionGeneration: String(state.generation), visibleCursor: '', application: null, principalScope: null, conversation: null,
          messages: [], missions: [], approvals: [], outcomes: [], intents: [], nativeAttempts:[], candidateEvaluations:[], budget: { month, bookedYen: '0', heldYen: '0', limitYen: '0', actualExternalCostYen: '0', simulation: true },
          pendingCount: 0, oldestPendingAt: null, updatedAt: now };
        const principalId = this.#authorize(tx, state, false);
        const principal = tx.getPrincipal(principalId)!;
        const scopes = tx.listScope(principalId), conversation = scopes.find(row => row.kind === 'conversation')!;
        const rows = tx.listRecord(principalId);
        const records = (kind: string) => rows.filter(row => row.kind === kind);
        const approvalOrder = tx.listAudit(principalId).filter(row => row.kind === 'approval.created').map(row => row.entityId);
        const approvals = records('approval').sort((a, b) => approvalOrder.indexOf(a.id) - approvalOrder.indexOf(b.id)).map(row => {
          const value = data<ApprovalData>(row);
          return { id: row.id, revision: String(row.revision), missionId: value.missionId, actionDigest: value.actionDigest,
            explanationRevision: value.explanationRevision, state: value.state, expiresAt: value.expiresAt, explanation: value.explanation, createdAt: value.createdAt };
        });
        const cashRows=records('cost_obligation').map(row=>JSON.parse(row.data));
        const obligations = cashRows.filter(v=>v.format!=='cash_obligation_v1') as ObligationData[];
        const sums = aggregate(obligations, month), policyState = this.#policy(tx, principalId),policy=policyState.value;
        const policyRow=this.#record(tx,principalId,policyState.ref,'policy');
        let cash:HomeSnapshot['budget']['cash'];
        if(policy.cash){
          let booked=0n,held=0n,external=0n,legacyUnknown=false,externalUnknown=false;
          for(const v of cashRows.filter(v=>v.month===month)){
            if(v.format!=='cash_obligation_v1'){if(!v.settled||yen(v.heldYen)!==0n||yen(v.bookedYen)!==0n)legacyUnknown=true;continue;}
            if(v.booked?.currency!=='USD'||v.held?.currency!=='USD')throw new LedgerIntegrityError('Cash currency mismatch');
            booked+=moneyUnits(v.booked);held+=moneyUnits(v.held);
            const ir=tx.getRecord(principalId,v.intentId),iv=ir?JSON.parse(ir.data):null;
            if(iv&&(iv.executionMode==='synthetic'||isLocalFixtureIntent(tx,principalId,iv)))continue;
            if(iv?.executionMode!=='provider'||!v.settled)externalUnknown=true;else external+=moneyUnits(v.booked);
          }
          const amount=(n:bigint)=>formatMoney({format:'money_v1',currency:'USD',units:String(n)});
          cash={currency:'USD',booked:legacyUnknown?'unknown':amount(booked),held:legacyUnknown?'unknown':amount(held),limit:formatMoney(policy.cash.normal),actualExternalCost:legacyUnknown||externalUnknown?'unknown':amount(external)};
        }
        const timeline = data<ConversationData>(this.#record(tx, principalId, conversation.id, 'conversation'));
        const missions = timeline.missionIds.map(id => this.#record(tx, principalId, id, 'mission')).map(row => { const value = data<MissionData>(row); return {
          id: row.id, revision: String(row.revision), title: value.title, phase: value.phase, conversationId: value.conversationId,
          briefRef: value.briefRef, contractRef: value.pendingContractRef ?? value.contractRef, outcomeId: value.outcomeId, scope: scopeView(tx.getScope(row.id)!),
        }; });
        const outcomes = records('outcome').map(row => { const value = data<OutcomeData>(row);
          const artifact = this.#record(tx, principalId, value.artifactId, 'artifact');
          return { ...value, id: row.id, revision: String(row.revision), text: data<{ text: string }>(artifact).text };
        });
        const intents = records('intent').map(row => { const value = data<IntentData>(row);
          const obligation = data<CommonObligation>(this.#record(tx, principalId, value.obligationId, 'cost_obligation'));
          return { id: row.id, missionId: value.missionId, state: value.state, cancellation: value.cancellation,
            ...(isCash(obligation)?{cash:{currency:'USD' as const,held:formatMoney(obligation.held),booked:formatMoney(obligation.booked)}}:{heldYen: obligation.heldYen, bookedYen: obligation.bookedYen}), reconciliationId: value.reconciliationId };
        });
        const pending = approvals.filter(row => row.state === 'pending');
        const apiAttempts=openrouterViews(tx,principalId),externalApi=apiAttempts.filter(v=>v.mode!=='synthetic'&&v.month===month);
        const apiCost=externalApi.some(v=>v.commonCash||v.mode==='unverified'||v.financialState==='unsettled'||v.recovery.costConflict)?'unknown':String(externalApi.reduce((n,v)=>n+BigInt(v.bookedYen!),0n));
        return { protocolVersion: 1, status: 'ready', mode: 'local_fake', principal,
          knowledge:this.knowledge.views(tx,principalId),
          routing:routingViews(tx,principalId),apiAttempts,
          budgetPolicy:{id:policyRow.id,revision:String(policyRow.revision),currency:policy.cash?'USD':'JPY',normalLimit:policy.cash?formatMoney(policy.cash.normal):policy.normalLimitYen,reserveLimit:policy.cash?formatMoney(policy.cash.reserve):null,autonomousELimit:policy.cash?formatMoney(policy.cash.autonomousE):policy.autonomousELimitYen},
          sessionGeneration: String(state.generation), visibleCursor: this.#cursorFor(tx, state),
          application: scopeView(tx.getScope(tx.getMeta('application_scope')!)!), principalScope: scopeView(tx.getScope(principalId)!), conversation: scopeView(conversation),
          messages: timeline.messageIds.map(id => this.#record(tx, principalId, id, 'message')).map(row => ({ id: row.id, ...data<{ role: 'user' | 'system'; text: string; createdAt: string }>(row) })),
          missions, approvals, outcomes, intents, nativeAttempts:this.codex.views(tx,principalId), candidateEvaluations:this.candidateEvaluation.views(tx,principalId), budget: { month, bookedYen: String(sums.booked), heldYen: String(sums.held), limitYen: policy.normalLimitYen, actualExternalCostYen: apiCost, simulation: externalApi.length===0,...(cash?{cash}:{}) },
          pendingCount: pending.length, oldestPendingAt: pending.map(row => row.createdAt).sort()[0] ?? null, updatedAt: now,
        };
      });
      // Immutable source/Artifact hashes are checked after closing the read transaction.
      if(snapshot.principal){
        const actor=this.#session(session).actorId,p=snapshot.principal.id;
        snapshot.nativeAttempts=snapshot.nativeAttempts.map(attempt=>{
          try{const lineage=this.context.traceAttempt(p,actor,attempt.id);return {...attempt,sourceLineage:{manifestId:lineage.manifestId,inputDigest:lineage.inputDigest,sources:lineage.parts.map(part=>({id:part.sourceId,version:part.sourceVersion,digest:part.sourceDigest}))}};}
          catch(cause){if(cause instanceof Error&&cause.message==='DISCLOSURE_NO_DISCLOSURE_LINEAGE')return attempt;throw cause;}
        });
        snapshot.candidateEvaluations=snapshot.candidateEvaluations.map(e=>{
          try{const review=this.candidateEvaluation.artifactReview(actor,p,e.id);return review?{...e,review}:e;}
          catch{return {...e,review:{status:'unavailable' as const}};}
        });
      }
      return snapshot;
    } catch (cause) { return this.#failure(cause); }
  }

  #execute(tx: LedgerTransaction, state: SessionState, p: string, command: DeepReadonly<Command>,artifactWitness?:ArtifactDecisionWitness): string | null {
    const now = this.#now();
    switch (command.command_type) {
      case 'budget.configure': {
        if(tx.getMembership(p,state.actorId)?.role!=='owner'||tx.getMeta(`policy:${p}`)!==command.target_id)deny();
        const row=this.#record(tx,p,command.target_id,'policy',command.expected_revision),value=data<PolicyData>(row);
        let limits;try{limits=makeUsdBudgetPolicy(command.payload.normal_limit,command.payload.reserve_limit,command.payload.autonomous_e_limit);}catch{deny('BUDGET_E_NOT_SUBSET');}
        if(value.cash===undefined){
          for(const obligation of tx.listRecord(p,'cost_obligation')){
            const v=JSON.parse(obligation.data);
            // Migrating the basis must never reset unresolved or current-month
            // nonzero JPY spending. An explicit FX migration is a separate path.
            if(v.format==='cash_obligation_v1'||v.settled!==true||yen(v.heldYen)!==0n||v.month===budgetMonth(new Date(now))&&yen(v.bookedYen)!==0n)deny('BUDGET_MIGRATION_UNRESOLVED');
          }
          if(tx.listRecord(p,'intent').some(r=>{const v=JSON.parse(r.data);return ['prepared','send_intent','running','unknown'].includes(v.state);}))deny('BUDGET_MIGRATION_UNRESOLVED');
        }
        this.#update(tx,row,{...value,cash:{format:'usd_budget_policy_v1',...limits}});
        this.#audit(tx,state,'budget.configured',row.id,command.command_id);return row.id;
      }
      case 'conversation.post': {
        const scope = this.#scope(tx, p, command.target_id, 'conversation', command.expected_revision);
        const record = this.#record(tx, p, scope.id, 'conversation');
        const value = data<ConversationData>(record);
        if (tx.getRecord(p, command.payload.message_id)) deny('COMMAND_CONFLICT');
        // Attachments require the later registered-source broker; UUID syntax alone cannot grant access.
        if (command.payload.attachment_refs.length) deny('CAPABILITY_UNVERIFIED');
        this.#insert(tx, p, command.payload.message_id, 'message', { role: 'user', text: command.payload.raw_text, createdAt: now });
        const missionId = this.#id(), briefId = this.#id(), contractId = this.#id();
        const current = [...value.missionIds].reverse().map(id => tx.getRecord(p, id)).find(row => row && data<MissionData>(row).phase === 'intake' && tx.getScope(row.id)?.state !== 'closed');
        let selectedMission: string;
        if (current && command.payload.relation_hint === 'continue') {
          const mission = data<MissionData>(current);
          this.#insert(tx, p, briefId, 'brief', { missionId: current.id, original: mission.originalRequest, revisionRequest: command.payload.raw_text });
          this.#insert(tx, p, contractId, 'contract', { missionId: current.id, briefRef: briefId, kind: 'work', mode: 'local_fake', externalAllowed: false });
          this.#update(tx, current, { ...mission, briefRef: briefId, pendingContractRef: contractId });
          selectedMission = current.id;
        } else {
          this.#insert(tx, p, briefId, 'brief', { missionId, original: command.payload.raw_text });
          this.#insert(tx, p, contractId, 'contract', { missionId, briefRef: briefId, kind: 'work', mode: 'local_fake', externalAllowed: false });
          tx.insertScope({ id: missionId, principalId: p, kind: 'mission', parentId: scope.id, revision: 1n, epoch: 1n, state: 'active' });
          this.#insert(tx, p, missionId, 'mission', { title: command.payload.raw_text.slice(0, 80) || '新しい依頼', phase: 'intake', conversationId: scope.id,
            briefRef: briefId, contractRef: contractId, outcomeId: null, originalRequest: command.payload.raw_text } satisfies MissionData);
          value.missionIds.push(missionId); selectedMission = missionId;
        }
        value.messageIds.push(command.payload.message_id); this.#update(tx, record, value);
        tx.updateScope({ ...scope, revision: scope.revision + 1n }, scope.revision);
        this.#audit(tx, state, 'conversation.changed', scope.id, command.command_id);
        return selectedMission;
      }
      case 'mission.start': {
        const scope = this.#scope(tx, p, command.target_id, 'mission', command.expected_revision);
        this.#activeAncestors(tx, scope.id);
        const row = this.#record(tx, p, scope.id, 'mission'), mission = data<MissionData>(row);
        if (mission.phase !== 'intake') deny('DENIED');
        if (tx.listRecord(p, 'intent').some(record => {
          const intent = data<IntentData>(record);
          return intent.missionId === scope.id && ['prepared', 'send_intent', 'unknown'].includes(intent.state);
        })) deny('DENIED');
        const confirmedContractRef = mission.pendingContractRef ?? mission.contractRef;
        if (mission.briefRef !== command.payload.brief_revision || confirmedContractRef !== command.payload.contract_revision) deny('REVISION_CONFLICT');
        this.#record(tx, p, mission.briefRef, 'brief');
        const contract = this.#record(tx, p, confirmedContractRef, 'contract');
        if (data<{ briefRef: string; missionId: string }>(contract).briefRef !== mission.briefRef || data<{ missionId: string }>(contract).missionId !== scope.id) deny('REVISION_CONFLICT');
        const policy = this.#policy(tx, p), amount = this.#profile.reservationYen, month = budgetMonth(new Date(now));
        const cashAmount=policy.value.cash?parseMoney('USD',this.#profile.reservationUsd??'0'):null;
        const obligations = tx.listRecord(p, 'cost_obligation').map(row => data<CommonObligation>(row));
        if(cashAmount&&policy.value.cash){
          if(!canReserveUsd(policy.value.cash,cashBudgetRows(obligations),month,cashAmount,'production','normal'))deny('BUDGET_BLOCKED');
        }else if(obligations.some(isCash)||!canReserve(policy.value, obligations as ObligationData[], month, amount, 'production')) deny('BUDGET_BLOCKED');
        const approvalId = this.#id(), intentId = this.#id(), obligationId = this.#id(), runId = this.#id(), attemptId = this.#id();
        const actionDigest = digest({ mode: 'local_fake', mission: scope.id, contract: confirmedContractRef, amount:cashAmount??amount, route: 'local-fixture', policy: policy.digest });
        const expiresAt = new Date(new Date(now).getTime() + this.#profile.approvalLifetimeMs).toISOString();
        this.#insert(tx, p, runId, 'run', { scopeKind: 'mission', missionId: scope.id, conversationId: null, purpose: 'production', mode: 'local_fake', model: null });
        this.#insert(tx, p, attemptId, 'attempt', { runId, ordinal: '1', state: 'prepared', model: null, route: 'local-fixture' });
        const approval: ApprovalData = { missionId: scope.id, actionDigest, explanationRevision: '1', state: 'pending', expiresAt,
          requestKey: digest({ effect: intentId, contract: confirmedContractRef, policy: policy.digest }), intentId, policyRef: policy.ref, policyDigest: policy.digest, createdAt: now, decision: null,
          explanation: { change: '保存した依頼からローカル検証用の下書きを作成', destination: 'このOrgManage内', account: '外部アカウントなし', route: 'local-fixture',
            ...(cashAmount?{maximum:cashAmount}:{maximumYen:amount}), month, estimateDifference: '模擬予約。外部費用は発生しません', alternatives: ['待つ', '依頼を修正する', '今回は終了する'],
            expectedBenefit: '画面と台帳の動作確認。AIの品質改善を示すものではありません', failureHandling: '結果不明は再送せず照合待ち',
            disclosure: '入力はローカルDB内。外部送信なし', retention: 'ローカル検証DBに保持', recovery: '再起動後も台帳から参照。実7日回収は未検証',
            risk: 'ローカル検証', dataClassification: 'このHomeに入力した原文', additionalDisclosure: 'なし' } };
        this.#insert(tx, p, approvalId, 'approval', approval);
        this.#insert(tx, p, obligationId, 'cost_obligation', cashAmount?{format:'cash_obligation_v1',intentId,month,purpose:'production',pool:'normal',policyVersion:policy.versionId,reserved:cashAmount,held:cashAmount,booked:parseMoney('USD','0'),settled:false}: { intentId, month, purpose: 'production', pool: 'normal', reservedYen: amount, heldYen: amount, bookedYen: '0', settled: false } satisfies ObligationData);
        this.#insert(tx, p, intentId, 'intent', { missionId: scope.id, attemptId, approvalId, actionDigest, policyRef: policy.ref,
          state: 'prepared', cancellation: 'not_requested', ownerId: this.store.ownerId, ownerEpoch: String(this.store.ownerEpoch), actorId: state.actorId, membershipGeneration: String(state.membershipGeneration), policyDigest: policy.digest,
          scopeEpochs: this.#activeAncestors(tx, scope.id).map(s => ({ id: s.id, epoch: String(s.epoch) })),
          expiresAt, obligationId, reconciliationId: null } satisfies IntentData);
        tx.registerApprovalBinding(p, approvalId, actionDigest); tx.bindIntentApproval(p, intentId, approvalId, actionDigest);
        const { pendingContractRef: _confirmedCandidate, ...missionBase } = mission;
        this.#update(tx, row, { ...missionBase, contractRef: confirmedContractRef, phase: 'approval' });
        tx.updateScope({ ...scope, revision: scope.revision + 1n }, scope.revision);
        this.#audit(tx, state, 'approval.created', approvalId, command.command_id); return approvalId;
      }
      case 'approval.decide': {
        const row = this.#record(tx, p, command.target_id, 'approval', command.expected_revision), value = data<ApprovalData>(row);
        if(data<{format?:string}>(row).format==='native_action_approval_v1'){
          this.nativeActions.decideInTransaction(tx,p,state.actorId,row.id,row.revision,command.payload);
          this.#audit(tx,state,'approval.changed',row.id,command.command_id);return row.id;
        }
        if (value.state !== 'pending') deny('DENIED');
        if (value.actionDigest !== command.payload.action_digest || value.explanationRevision !== command.payload.explanation_revision) deny('REVISION_CONFLICT');
        if (new Date(value.expiresAt).getTime() <= new Date(now).getTime()) deny('POLICY_EXPIRED');
        if (value.policyDigest !== this.#policy(tx, p).digest) deny('POLICY_EXPIRED');
        if (command.payload.choice === 'approve') this.#activeAncestors(tx, value.missionId);
        this.#update(tx, row, { ...value, state: command.payload.choice === 'approve' ? 'approved' : 'denied',
          decision: { actorId: state.actorId, membershipGeneration: String(state.membershipGeneration), comment: command.payload.comment, decidedAt: now } });
        if (command.payload.choice === 'deny') this.#discard(tx, this.#record(tx, p, value.intentId, 'intent'));
        this.#audit(tx, state, 'approval.changed', row.id, command.command_id); return row.id;
      }
      case 'scope.control': case 'mission.control': case 'application.control': {
        const kind = command.command_type === 'application.control' ? 'application' : command.command_type === 'mission.control' ? 'mission' : command.payload.scope;
        const scope = this.#scope(tx, p, command.target_id, kind, command.expected_revision);
        const choice = command.payload.choice;
        if (choice === 'recover_readonly') deny('CAPABILITY_UNVERIFIED');
        const next = choice === 'resume' || choice === 'resume_dispatch' ? 'active' : choice === 'close' ? 'closed' : 'paused';
        if (scope.state === 'closed' && next !== 'closed') deny('DENIED');
        if (scope.state !== next) {
          tx.updateScope({ ...scope, state: next, revision: scope.revision + 1n, epoch: scope.epoch + 1n, reason: command.payload.comment, actorId: state.actorId, changedAt: now }, scope.revision);
          if (next !== 'active') {
            for (const principalId of kind === 'application' ? tx.listPrincipal().map(principal => principal.id) : [p]) this.#stopDescendants(tx, principalId, scope.id);
          }
          if (kind === 'mission' && next === 'active') {
            const row = this.#record(tx, p, scope.id, 'mission'), value = data<MissionData>(row);
            const unresolved = tx.listRecord(p, 'intent').some(record => {
              const intent = data<IntentData>(record);
              return intent.missionId === scope.id && ['send_intent', 'unknown'].includes(intent.state);
            });
            if (!unresolved && value.phase === 'approval') this.#update(tx, row, { ...value, phase: 'intake' });
            if (!unresolved && value.phase === 'review' && value.outcomeId) {
              const held = this.#record(tx, p, value.outcomeId, 'outcome'), outcome = data<OutcomeData>(held);
              if (outcome.state === 'hold') {
                this.#update(tx, held, { ...outcome, state: 'pending' }); this.#systemAudit(tx, p, 'outcome.reopened', held.id);
              }
            }
          }
        }
        this.#audit(tx, state, 'scope.changed', scope.id, command.command_id); return scope.id;
      }
      case 'outcome.decide': {
        const row = this.#record(tx, p, command.target_id, 'outcome', command.expected_revision), value = data<OutcomeData>(row);
        if (value.state !== 'pending' || value.artifactId !== command.payload.artifact_revision_id || value.explanationRevision !== command.payload.explanation_revision) deny('REVISION_CONFLICT');
        const artifact = this.#record(tx, p, value.artifactId, 'artifact');
        const verification=data<{verification:string}>(artifact).verification;
        if(verification==='candidate_verified'){
          const bound=tx.candidateArtifact.outcome(p,row.id);
          if(!bound||bound.artifactId!==artifact.id||bound.missionId!==value.missionId||value.verification!=='candidate_verified'||!artifactWitness)deny('ARTIFACT_NOT_READY');
          try{this.candidateEvaluation.assertArtifactDecision(tx,state.actorId,p,artifact.id,artifactWitness,command.payload.choice==='accepted');}catch{deny('ARTIFACT_NOT_READY');}
        }else if(verification!=='local_fixture'||value.verification!=='local_fixture')deny('ARTIFACT_NOT_READY');
        const missionRow = this.#record(tx, p, value.missionId, 'mission'), mission = data<MissionData>(missionRow), scope = tx.getScope(value.missionId)!;
        if(verification==='candidate_verified'&&mission.outcomeId!==row.id)deny('REVISION_CONFLICT');
        if (scope.state === 'closed') deny('DENIED');
        const choice = command.payload.choice;
        if (choice === 'accepted') this.#activeAncestors(tx, scope.id);
        this.#update(tx, row, { ...value, state: choice, comment: command.payload.comment });
        if (choice === 'revise') {
          const briefId = this.#id(), contractId = this.#id();
          this.#insert(tx, p, briefId, 'brief', { missionId: scope.id, original: mission.originalRequest, artifactRef: artifact.id, revisionRequest: command.payload.comment, organized: false });
          this.#insert(tx, p, contractId, 'contract', { missionId: scope.id, briefRef: briefId, kind: 'work', mode: 'local_fake', externalAllowed: false, predecessorRef: mission.contractRef });
          this.#update(tx, missionRow, { ...mission, phase: 'intake', briefRef: briefId, pendingContractRef: contractId });
          tx.updateScope({ ...scope, revision: scope.revision + 1n }, scope.revision);
        } else this.#update(tx, missionRow, { ...mission, phase: choice === 'accepted' ? 'exit' : mission.phase });
        if (choice === 'hold' || choice === 'close') {
          tx.updateScope({ ...scope, state: choice === 'hold' ? 'paused' : 'closed', revision: scope.revision + 1n, epoch: scope.epoch + 1n, reason: command.payload.comment, actorId: state.actorId, changedAt: now }, scope.revision);
          this.#stopDescendants(tx, p, scope.id);
        }
        this.#audit(tx, state, 'outcome.changed', row.id, command.command_id); return row.id;
      }
      case 'knowledge.decide': {
        if(command.payload.candidate_ref!==command.target_id)deny('COMMAND_CONFLICT');
        try{this.knowledge.decideInTransaction(tx,p,state.actorId,command.target_id,BigInt(command.expected_revision),command.payload.choice,command.payload.evaluation_ref,command.payload.scope_ref,command.payload.comment);}
        catch(cause){if(cause instanceof KnowledgeDenied)deny('KNOWLEDGE_'+cause.code);throw cause;}
        this.#audit(tx,state,'knowledge.changed',command.target_id,command.command_id);
        return command.target_id;
      }
    }
  }

  /** TX2 only. admissionAllowed is a trusted, synchronous, side-effect-free host lease check. */
  acquireDispatch(principalId: string, intentId: string, admissionAllowed: () => boolean = () => true): { ok: true; intentId: string } | ClientError {
    try {
      return this.store.transaction(tx => {
        const row = this.#record(tx, principalId, intentId, 'intent'), intent = data<IntentData>(row);
        if (!isLocalFixtureIntent(tx, principalId, intent)) deny('DENIED');
        if (intent.state !== 'prepared') deny('DENIED');
        const approval = data<ApprovalData>(this.#record(tx, principalId, intent.approvalId, 'approval'));
        if (approval.state !== 'approved' || approval.actionDigest !== intent.actionDigest || approval.intentId !== row.id) deny('DENIED');
        if (intent.ownerId !== this.store.ownerId || intent.ownerEpoch !== String(this.store.ownerEpoch) || intent.policyDigest !== this.#policy(tx, principalId).digest) deny('POLICY_EXPIRED');
        const initiator = tx.getMembership(principalId, intent.actorId);
        const decider = approval.decision && tx.getMembership(principalId, approval.decision.actorId);
        if (!initiator || initiator.role !== 'owner' || String(initiator.generation) !== intent.membershipGeneration
          || !decider || decider.role !== 'owner' || String(decider.generation) !== approval.decision?.membershipGeneration) deny('DENIED');
        if (new Date(intent.expiresAt).getTime() <= this.#clock().getTime()) deny('POLICY_EXPIRED');
        const currentScopes = this.#activeAncestors(tx, intent.missionId);
        if (currentScopes.length !== intent.scopeEpochs.length || intent.scopeEpochs.some(old => !currentScopes.some(current => current.id === old.id && String(current.epoch) === old.epoch))) deny('POLICY_EXPIRED');
        const obligation = data<CommonObligation>(this.#record(tx, principalId, intent.obligationId, 'cost_obligation'));
        const policy=this.#policy(tx,principalId),all=tx.listRecord(principalId,'cost_obligation').map(r=>data<CommonObligation>(r));
        if(isCash(obligation)){
          if(!policy.value.cash||obligation.policyVersion!==policy.versionId||obligation.month!==budgetMonth(this.#clock())||obligation.pool!=='normal'
            ||obligation.reserved.currency!=='USD'||obligation.held.currency!=='USD'||obligation.booked.currency!=='USD'
            ||obligation.settled||moneyUnits(obligation.held)!==moneyUnits(obligation.reserved)
            ||!canReserveUsd(policy.value.cash,cashBudgetRows(all),obligation.month,parseMoney('USD','0'),obligation.purpose,'normal'))deny('BUDGET_BLOCKED');
        }else{
          if(policy.value.cash||all.some(isCash))deny('BUDGET_BLOCKED');
          const sum = aggregate(all as ObligationData[], obligation.month);
          if (sum.booked + sum.held > yen(policy.value.normalLimitYen)) deny('BUDGET_BLOCKED');
          if (obligation.settled || yen(obligation.heldYen) !== yen(obligation.reservedYen)) deny('BUDGET_BLOCKED');
        }
        // Recheck after BEGIN IMMEDIATE waits and all other admission reads. This
        // predicate must not quiesce or enter the Store again from this transaction.
        if (admissionAllowed() !== true) deny('POLICY_EXPIRED');
        this.#update(tx, row, { ...intent, state: 'send_intent' });
        const mission = this.#record(tx, principalId, intent.missionId, 'mission'); this.#update(tx, mission, { ...data<MissionData>(mission), phase: 'execution' });
        this.#systemAudit(tx, principalId, 'intent.send_acquired', row.id); return { ok: true as const, intentId };
      });
    } catch (cause) { return this.#failure(cause); }
  }

  /** Finite trusted local adapter; no provider, shell, credentials, or candidate code. */
  executeFake(principalId: string, intentId: string, admissionAllowed: () => boolean = () => true): ObservationResult {
    const acquired = this.acquireDispatch(principalId, intentId, admissionAllowed); if (!acquired.ok) return acquired;
    return this.finishFakeObservation(principalId, intentId);
  }

  /** Retry only the local observation write, never the send/acquire boundary. */
  finishFakeObservation(principalId: string, intentId: string): ObservationResult {
    try{
      const cash=this.store.read(tx=>{const intent=data<IntentData>(this.#record(tx,principalId,intentId,'intent'));return isCash(data<CommonObligation>(this.#record(tx,principalId,intent.obligationId,'cost_obligation')));});
      return cash?this.observeFakeCash(principalId,intentId,this.#profile.outcome,`fake:${intentId}:1`,parseMoney('USD',this.#profile.settledUsd??'0'))
        :this.observeFake(principalId, intentId, this.#profile.outcome, `fake:${intentId}:1`, this.#profile.settledYen);
    }catch(cause){return this.#failure(cause);}
  }

  /** Trusted local scheduler terminal handling; not a renderer command or provider retry. */
  exhaustFakeRetry(principalId: string, intentId: string): { ok: true } | ClientError {
    try {
      return this.store.transaction(tx => {
        const row = this.#record(tx, principalId, intentId, 'intent'), value = data<IntentData>(row);
        if (!isLocalFixtureIntent(tx, principalId, value)) deny('DENIED');
        if (value.state === 'prepared') this.#discard(tx, row);
        else if (value.state === 'send_intent') this.#unknown(tx, row, 'Local observation write retry limit reached');
        return { ok: true as const };
      });
    } catch (cause) { return this.#failure(cause); }
  }

  observeFake(principalId: string, intentId: string, outcome: 'success' | 'unknown', eventKey: string, settledYen: string): ObservationResult {
    try{return this.#observeFake(principalId,intentId,outcome,eventKey,parseMoney('JPY',settledYen));}catch(cause){return this.#failure(cause);}
  }
  /** Explicit currency prevents legacy callers from reinterpreting yen as dollars. */
  observeFakeCash(principalId:string,intentId:string,outcome:'success'|'unknown',eventKey:string,amount:Money):ObservationResult{
    try{if(amount.currency!=='USD')deny('DENIED');moneyUnits(amount);return this.#observeFake(principalId,intentId,outcome,eventKey,amount);}catch(cause){return this.#failure(cause);}
  }
  #observeFake(principalId:string,intentId:string,outcome:'success'|'unknown',eventKey:string,amount:Money):ObservationResult{
    try {
      return this.store.transaction(tx => {
        const row = this.#record(tx, principalId, intentId, 'intent'), intent = data<IntentData>(row);
        if (!isLocalFixtureIntent(tx, principalId, intent)) deny('DENIED');
        const obligation=this.#record(tx,principalId,intent.obligationId,'cost_obligation'),debt=data<CommonObligation>(obligation),cash=isCash(debt);
        if((cash?'USD':'JPY')!==amount.currency)deny('DENIED');
        const cost=cash?{amount}:{settledYen:formatMoney(amount)};
        const charge=cash?{amount}:{amountYen:formatMoney(amount)};
        const key = `fake-event:${principalId}:${intentId}:${digest(eventKey)}`, content = digest({ outcome, ...cost });
        const prior = tx.getMeta(key);
        if (prior) {
          if (prior !== content) {
            const conflictKey = `${key}:conflict:${content}`;
            if (!tx.getMeta(conflictKey)) {
              const conflictRef = this.#id();
              this.#insert(tx, principalId, conflictRef, 'evidence', { intentId, route: 'local-fixture', eventKey, outcome, ...cost, contentDigest: content, conflictsWith: prior, observedAt: this.#now() });
              tx.setMeta(conflictKey, conflictRef);
            }
            this.#retainConflictHold(tx, principalId, intent.obligationId, amount);
            this.#unknown(tx, row, 'Conflicting observation', this.#intentEvidence(tx, principalId, intentId)); return error('OUTCOME_UNKNOWN');
          }
          return { ok: true as const, result: { intentId, outcomeId: null, duplicate: true } };
        }
        if (!['send_intent', 'unknown', 'completed'].includes(intent.state)) deny('DENIED');
        tx.setMeta(key, content);
        const evidenceId = this.#id(); this.#insert(tx, principalId, evidenceId, 'evidence', { intentId, route: 'local-fixture', eventKey, outcome, ...cost, observedAt: this.#now() });
        this.#systemAudit(tx, principalId, 'observation.recorded', evidenceId);
        const settlementKey = `fake-settlement:${principalId}:${intentId}`;
        if (tx.getMeta(settlementKey)) {
          const settled = JSON.parse(tx.getMeta(settlementKey)!) as { amountYen?: string;amount?:Money; outcomeId: string };
          const matches=cash?settled.amount?.currency==='USD'&&moneyUnits(settled.amount)===moneyUnits(amount):settled.amountYen===formatMoney(amount);
          if (intent.state === 'completed' && outcome === 'success' && matches) return { ok: true as const, result: { intentId, outcomeId: settled.outcomeId, duplicate: true } };
          this.#retainConflictHold(tx, principalId, intent.obligationId, amount);
          this.#unknown(tx, row, 'Observation needs explicit financial reconciliation', this.#intentEvidence(tx, principalId, intentId));
          return error('OUTCOME_UNKNOWN');
        }
        if (outcome === 'unknown') { this.#unknown(tx, row, 'Local fixture has no confirmed result', [evidenceId]); return error('OUTCOME_UNKNOWN'); }
        this.#update(tx, obligation, cash?{...debt,held:parseMoney('USD','0'),booked:amount,settled:true}:{...debt,heldYen:'0',bookedYen:formatMoney(amount),settled:true});
        this.#insert(tx, principalId, this.#id(), 'cost_event', { obligationId: obligation.id, evidenceRef: evidenceId, chargeKey: settlementKey, ...charge, correctionOf: null });
        const missionRow = this.#record(tx, principalId, intent.missionId, 'mission'), mission = data<MissionData>(missionRow);
        const artifactId = this.#id(), outcomeId = this.#id();
        this.#insert(tx, principalId, artifactId, 'artifact', { missionId: missionRow.id, contractRef: mission.contractRef, verification: 'local_fixture',
          text: `ローカル検証用の下書き\n\n${mission.originalRequest}\n\n入力の保存、承認、実行記録、成果判断の接続を確認するための出力です。AIによる作成や稼働アプリへの適用は行っていません。` });
        this.#insert(tx, principalId, outcomeId, 'outcome', { missionId: missionRow.id, artifactId, explanationRevision: '1', state: 'pending', verification: 'local_fixture', comment: null } satisfies OutcomeData);
        tx.setMeta(settlementKey, JSON.stringify({ ...charge, outcomeId }));
        this.#update(tx, missionRow, { ...mission, phase: 'review', outcomeId });
        this.#update(tx, row, { ...intent, state: 'completed' });
        if (intent.reconciliationId) {
          const c = this.#record(tx, principalId, intent.reconciliationId, 'reconciliation_case');
          this.#update(tx, c, { ...data<ReconciliationData>(c), state: 'resolved', evidenceRefs: [...new Set([...data<ReconciliationData>(c).evidenceRefs, evidenceId])] });
        }
        this.#systemAudit(tx, principalId, 'artifact.stored', artifactId);
        return { ok: true as const, result: { intentId, outcomeId, duplicate: false } };
      });
    } catch (cause) { return this.#failure(cause); }
  }

  /** Trusted presentation port. Does not accept the result or authorize app updates. */
  presentCandidateOutcome(actor:string,p:string,artifactId:string):string{
    const artifact=this.candidateEvaluation.readArtifact(actor,p,artifactId);
    const prior=this.store.read(tx=>tx.candidateArtifact.outcomeForArtifact(p,artifactId));
    if(prior)return prior.id;
    const witness=this.candidateEvaluation.prepareArtifactDecision(actor,p,artifactId);
    return this.store.transaction(tx=>{
      const plan=this.candidateEvaluation.assertArtifactDecision(tx,actor,p,artifactId,witness,true);
      const existing=tx.candidateArtifact.outcomeForArtifact(p,artifactId);if(existing)return existing.id;
      const missionRow=this.#record(tx,p,plan.missionId,'mission'),mission=data<MissionData>(missionRow);
      if(mission.outcomeId&&data<OutcomeData>(this.#record(tx,p,mission.outcomeId,'outcome')).state!=='revise')deny('OUTCOME_CONFLICT');
      const now=this.#clock().getTime();if(!Number.isSafeInteger(now)||now<artifact.record.createdAt)deny('ARTIFACT_NOT_READY');
      const outcomeId=this.#id();
      this.#insert(tx,p,outcomeId,'outcome',{missionId:plan.missionId,artifactId,explanationRevision:'1',state:'pending',verification:'candidate_verified',comment:null} satisfies OutcomeData);
      tx.candidateArtifact.insertOutcome({principalId:p,id:outcomeId,artifactId,missionId:plan.missionId,artifactDigest:artifact.record.artifactDigest,createdAt:now});
      this.#update(tx,missionRow,{...mission,phase:'review',outcomeId});
      this.#systemAudit(tx,p,'candidate.outcome_presented',outcomeId);return outcomeId;
    });
  }

  maintain(): void {
    this.codex.maintain();
    this.runner.maintain();
    this.store.transaction(tx => {
      for (const p of tx.listPrincipal()) this.nativeActions.maintainInTransaction(tx,p.id);
      for (const p of tx.listPrincipal()) for (const row of tx.listRecord(p.id, 'approval')) {
        if(data<{format?:string}>(row).format==='native_action_approval_v1')continue;
        const value = data<ApprovalData>(row);
        if (!['pending', 'approved'].includes(value.state)) continue;
        const expired = new Date(value.expiresAt).getTime() <= this.#clock().getTime();
        const superseded = value.policyDigest !== this.#policy(tx, p.id).digest;
        if (!expired && !superseded) continue;
        this.#update(tx, row, { ...value, state: expired ? 'expired' : 'superseded' });
        const intent = this.#record(tx, p.id, value.intentId, 'intent');
        if (data<IntentData>(intent).state === 'prepared') this.#discard(tx, intent);
        else if (['send_intent', 'unknown'].includes(data<IntentData>(intent).state)) this.#unknown(tx, intent, 'Approval expired after send boundary', [], true);
        this.#systemAudit(tx, p.id, 'approval.invalidated', row.id);
      }
    });
  }

  #session(session: CoreSession): SessionState { const state = this.#sessions.get(session); if (!state) deny(); return state; }
  #authorize(tx: LedgerReader, state: SessionState, write: boolean): string {
    if (!state.principalId) deny();
    const member = tx.getMembership(state.principalId, state.actorId);
    if (!member || member.role === 'revoked' || member.generation !== state.membershipGeneration || (write && member.role !== 'owner')) deny();
    return state.principalId;
  }
  #now(): string { return this.#clock().toISOString(); }
  #record(tx: LedgerReader, p: string, id: string, kind: string, revision?: string): LedgerRecord {
    const row = tx.getRecord(p, id); if (!row || row.kind !== kind) deny();
    if (revision !== undefined && String(row.revision) !== revision) deny('REVISION_CONFLICT'); return row;
  }
  #scope(tx: LedgerReader, p: string, id: string, kind: string, revision?: string): Scope {
    const row = tx.getScope(id); if (!row || row.kind !== kind || (kind !== 'application' && row.principalId !== p)) deny();
    if (kind === 'application' && id !== tx.getMeta('application_scope')) deny();
    if (revision !== undefined && String(row.revision) !== revision) deny('REVISION_CONFLICT'); return row;
  }
  #activeAncestors(tx: LedgerReader, id: string): Scope[] {
    const rows: Scope[] = [], visited = new Set<string>(); let current: string | null = id;
    while (current !== null) { if (visited.has(current) || rows.length > 5) throw new LedgerIntegrityError('Cyclic scope hierarchy'); visited.add(current);
      const row = tx.getScope(current); if (!row || row.state !== 'active') deny('DENIED'); rows.push(row); current = row.parentId; }
    return rows;
  }
  #policy(tx: LedgerReader, p: string): { ref: string;versionId:string; value: PolicyData; digest: string } {
    const ref = tx.getMeta(`policy:${p}`); if (!ref) deny();
    const row=this.#record(tx,p,ref,'policy'),value = data<PolicyData>(row);
    if(!row.versionId)throw new LedgerIntegrityError('Policy version missing');
    if (value.mode !== 'local_fake' || value.externalAllowed !== false) deny('CAPABILITY_UNVERIFIED');
    return { ref,versionId:row.versionId, value, digest: digest({ mode: value.mode, externalAllowed: value.externalAllowed, normalLimitYen: value.normalLimitYen, autonomousELimitYen: value.autonomousELimitYen,...(value.cash!==undefined?{cash:value.cash}:{}) }) };
  }
  #insert(tx: LedgerTransaction, p: string, id: string, kind: LedgerRecord['kind'], value: unknown): void { tx.insertRecord({ principalId: p, id, kind, revision: 1n, data: JSON.stringify(value) }); }
  #update(tx: LedgerTransaction, row: LedgerRecord, value: unknown): void {
    const { versionId: _previousVersion, ...identity } = row;
    tx.updateRecord({ ...identity, revision: row.revision + 1n, data: JSON.stringify(value) }, row.revision);
  }
  #touch(tx: LedgerTransaction, p: string): void { tx.setMeta(`feed:${p}`, randomBytes(24).toString('base64url')); }
  #audit(tx: LedgerTransaction, state: SessionState, kind: string, entityId: string, commandId: string): void {
    tx.appendAudit({ principalId: state.principalId!, commandId, kind, entityId, createdAt: this.#now() }); this.#touch(tx, state.principalId!);
  }
  #systemAudit(tx: LedgerTransaction, p: string, kind: string, entityId: string): void { tx.appendAudit({ principalId: p, commandId: null, kind, entityId, createdAt: this.#now() }); this.#touch(tx, p); }
  #cursorFor(tx: LedgerReader, state: SessionState): string {
    return createHmac('sha256', tx.getMeta('cursor_key')!).update(JSON.stringify({ p: state.principalId, actor: state.actorId,
      memberGeneration: String(state.membershipGeneration), generation: String(state.generation), feed: tx.getMeta(`feed:${state.principalId}`) })).digest('base64url');
  }
  #receipt(tx: LedgerTransaction, state: SessionState, commandId: string, resultRef: string | null, code: string | null): ReceiptView {
    if (code) this.#audit(tx, state, 'command.rejected', commandId, commandId);
    return { command_id: commandId, disposition: code ? 'rejected' : 'committed', visible_cursor: this.#cursorFor(tx, state), result_ref: resultRef, error_code: code };
  }
  #recordRejection(session: CoreSession, commandId: string, contentDigest: string, code: string): CoreResult {
    try { return this.store.transaction(tx => { const state = this.#session(session), p = this.#authorize(tx, state, true);
      const prior = tx.getCommand(p, commandId); if (prior) return prior.actorId === state.actorId && prior.digest === contentDigest ? { ok: true as const, receipt: JSON.parse(prior.receipt) as ReceiptView } : error('COMMAND_CONFLICT');
      const receipt = this.#receipt(tx, state, commandId, null, code);
      tx.insertCommand({ principalId: p, commandId, actorId: state.actorId, digest: contentDigest, receipt: JSON.stringify(receipt) }); return { ok: true as const, receipt };
    }); } catch (cause) { return this.#failure(cause); }
  }
  #discard(tx: LedgerTransaction, row: LedgerRecord): void {
    const value = data<IntentData>(row); if (value.state !== 'prepared') return;
    this.#update(tx, row, { ...value, state: 'discarded' });
    const obligation = this.#record(tx, row.principalId, value.obligationId, 'cost_obligation');
    const debt=data<CommonObligation>(obligation);
    this.#update(tx, obligation, isCash(debt)?{...debt,held:parseMoney('USD','0'),settled:true}:{ ...debt, heldYen: '0', settled: true });
    const api=data<{format?:string;trialHoldId?:string}>(row);
    if(api.format==='openrouter_intent_v1'&&api.trialHoldId)new ApiTrialBudget(this.store,()=>this.#clock().getTime()).releaseDiscardedInTransaction(tx,row.principalId,api.trialHoldId);
    const approval = this.#record(tx, row.principalId, value.approvalId, 'approval'), a = data<ApprovalData>(approval);
    if (a.state === 'pending' || a.state === 'approved') {
      this.#update(tx, approval, { ...a, state: 'superseded' }); this.#systemAudit(tx, row.principalId, 'approval.superseded', approval.id);
    }
    const mission = this.#record(tx, row.principalId, value.missionId, 'mission'), m = data<MissionData>(mission);
    if (m.phase === 'approval') {
      this.#update(tx, mission, { ...m, phase: 'intake' }); this.#systemAudit(tx, row.principalId, 'mission.returned_to_intake', mission.id);
    }
    this.#systemAudit(tx, row.principalId, 'intent.discarded', row.id);
  }
  #intentEvidence(tx: LedgerReader, p: string, intentId: string): string[] {
    return tx.listRecord(p, 'evidence').filter(row => data<{ intentId?: string }>(row).intentId === intentId).map(row => row.id);
  }
  #retainConflictHold(tx: LedgerTransaction, p: string, obligationId: string, claimed: Money): void {
    const row = this.#record(tx, p, obligationId, 'cost_obligation'), value = data<CommonObligation>(row);
    if(isCash(value)){
      const booked=moneyUnits(value.booked),total=[moneyUnits(value.reserved),moneyUnits(claimed),booked+moneyUnits(value.held)].reduce((a,b)=>a>b?a:b);
      this.#update(tx,row,{...value,held:{format:'money_v1',currency:'USD',units:String(total-booked)},settled:false});
    }else{
      const booked = yen(value.bookedYen), total = [yen(value.reservedYen), moneyUnits(claimed), booked + yen(value.heldYen)].reduce((a, b) => a > b ? a : b);
      this.#update(tx, row, { ...value, heldYen: String(total - booked), settled: false });
    }
  }
  #stopDescendants(tx: LedgerTransaction, p: string, scopeId: string): void {
    this.codex.stopDescendants(tx, p, scopeId);
    this.runner.stopDescendants(tx, p, scopeId);
    for (const row of tx.listRecord(p, 'intent')) {
      const value = data<IntentData>(row); if (!value.scopeEpochs.some(scope => scope.id === scopeId)) continue;
      if (value.state === 'prepared') this.#discard(tx, row);
      else if (value.state === 'send_intent' || value.state === 'unknown') this.#update(tx, row, { ...value, cancellation: 'requested' });
    }
  }
  #unknown(tx: LedgerTransaction, row: LedgerRecord, reason: string, evidenceRefs: string[] = [], requestCancellation = false): void {
    const value = data<IntentData>(row), p = row.principalId;
    const reconciliationId = value.reconciliationId ?? this.#id();
    if (!value.reconciliationId) {
      this.#insert(tx, p, reconciliationId, 'reconciliation_case', { intentId: row.id, state: 'open', reason, evidenceRefs } satisfies ReconciliationData);
      this.#insert(tx, p, this.#id(), 'job', { kind: 'reconciliation', targetId: reconciliationId, attempts: '0', maxAttempts: '3', state: 'waiting', mode: 'local_fake' });
    } else {
      const caseRow = this.#record(tx, p, reconciliationId, 'reconciliation_case'), previous = data<ReconciliationData>(caseRow);
      this.#update(tx, caseRow, { ...previous, state: 'open', reason, evidenceRefs: [...new Set([...previous.evidenceRefs, ...evidenceRefs])] });
    }
    this.#update(tx, row, { ...value, state: 'unknown', reconciliationId, cancellation: requestCancellation ? 'requested' : value.cancellation }); this.#systemAudit(tx, p, 'intent.unknown', row.id);
  }
  #recoverOldOwner(): void {
    const initialized = this.store.read(tx => {
      const marker = tx.getMeta('bootstrap');
      if (!marker) { if (tx.listPrincipal().length || tx.listScope(null).length) throw new LedgerIntegrityError('Incomplete business bootstrap'); return false; }
      let bootstrap: { principalId: string; actorId: string; commandId: string };
      try { bootstrap = JSON.parse(marker) as typeof bootstrap; } catch { throw new LedgerIntegrityError('Corrupt bootstrap marker'); }
      const p = tx.getPrincipal(bootstrap.principalId), owner = tx.getMembership(bootstrap.principalId, bootstrap.actorId);
      const app = tx.getScope(tx.getMeta('application_scope') ?? ''), policy = tx.getMeta(`policy:${bootstrap.principalId}`);
      if (!p || !owner || !app || app.kind !== 'application' || !policy || !tx.getRecord(p.id, policy)
        || !tx.getCommand(p.id, bootstrap.commandId) || !tx.getMeta('cursor_key')
        || !tx.listScope(p.id).some(scope => scope.kind === 'conversation' && tx.getRecord(p.id, scope.id)?.kind === 'conversation')) throw new LedgerIntegrityError('Incomplete business bootstrap');
      return true;
    });
    if (!initialized) return;
    this.store.transaction(tx => {
      for (const p of tx.listPrincipal()) for (const row of tx.listRecord(p.id, 'intent')) {
        const value = data<IntentData>(row); if (value.ownerId === this.store.ownerId && value.ownerEpoch === String(this.store.ownerEpoch)) continue;
        if (value.state === 'prepared') this.#discard(tx, row);
        if (value.state === 'send_intent') this.#unknown(tx, row, 'Previous owner ended after send boundary');
      }
    });
  }
  #failure(cause: unknown): ClientError {
    if (cause instanceof Rejection || cause instanceof NativeActionDenied) return error(cause.code);
    if (cause instanceof LedgerBusyError) return error('BUSY_NOT_COMMITTED');
    if (cause instanceof RevisionConflictError) return error('REVISION_CONFLICT');
    if (cause instanceof LedgerOwnerError || cause instanceof LedgerIntegrityError) return error('RECOVERY_REQUIRED');
    throw cause;
  }
}
