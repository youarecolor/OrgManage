import {createHash,randomUUID} from 'node:crypto';
import canonicalize from 'canonicalize';
import type {LedgerStore,LedgerTransaction} from '../../ledger/src/index.js';
import {ApiTrialBudget} from './api-trial-budget.js';
import {DisclosureCoordinator,type DisclosureDestination} from './disclosure.js';
import {prepareOpenRouterRequest} from './openrouter-policy.js';
import {KnowledgeCoordinator} from './knowledge.js';
import type {RoutingCoordinator} from './routing-ledger.js';
import {checkOpenRouterRoutingPool} from './openrouter-routing-pool.js';
import {confirmOpenRouterContinuation} from './openrouter-continuation.js';
import {moneyUnits} from './money.js';

const digest=(value:unknown)=>createHash('sha256').update(canonicalize(value)!).digest('hex');
function check(ok:unknown,reason:string):asserts ok{if(!ok)throw Error(`OPENROUTER_ADMISSION_${reason}`);}
/** Acquires existing prepared records only. Preparation, price qualification and
 * human approval are separate; this class cannot invent or approve those records. */
export class OpenRouterAdmission {
 readonly #budget:ApiTrialBudget;
 readonly #disclosure:DisclosureCoordinator;
 constructor(readonly store:LedgerStore,readonly clock:()=>number=Date.now,readonly routing?:RoutingCoordinator){
  this.#budget=new ApiTrialBudget(store,clock);this.#disclosure=new DisclosureCoordinator(store,clock);
 }
 acquire(p:string,actor:string,id:string,requestDigest:string):string{
  return this.#transition(p,actor,id,requestDigest,false);
 }
 /** One-use durable wire claim; a crash after this point is never permission to resend. */
 confirmAcquired(p:string,actor:string,id:string,requestDigest:string):void{
  this.#transition(p,actor,id,requestDigest,true);
 }
 #transition(p:string,actor:string,id:string,requestDigest:string,wire:boolean):string{
  return this.store.transaction(tx=>{
   const row=tx.getRecord(p,id);check(row?.kind==='intent','INTENT');const intent=JSON.parse(row.data);
   check(intent.format==='openrouter_intent_v1'&&intent.route==='openrouter'&&intent.state===(wire?'send_intent':'prepared')&&intent.cancellation==='not_requested'&&intent.wireClaimed!==true,'STATE');
   check(intent.ownerId===this.store.ownerId&&intent.ownerEpoch===String(this.store.ownerEpoch),'OWNER');
   const witness=tx.getRecordVersion(p,intent.witnessVersion);check(witness?.kind==='evidence','WITNESS');const w=JSON.parse(witness.data);
   check(w.format==='openrouter_action_witness_v1'&&w.intentId===id&&w.actorId===actor&&w.requestDigest===requestDigest&&/^[a-f0-9]{64}$/.test(requestDigest),'BINDING');
   check(w.obligationId===intent.obligationId&&w.approvalId===intent.approvalId&&w.accountRoute===intent.accountRoute&&w.trialHoldId===intent.trialHoldId&&w.missionId===intent.missionId&&w.requestDigest===intent.requestDigest,'BINDING');
   const now=this.clock();check(Number.isSafeInteger(now)&&now>=w.createdAt&&now<w.expiresAt,'EXPIRED');
   const member=tx.getMembership(p,actor);check(member?.role==='owner'&&String(member.generation)===w.membershipGeneration,'ACTOR');
   const policyId=tx.getMeta(`policy:${p}`),policy=policyId?tx.getRecord(p,policyId):undefined;
   check(policy?.kind==='policy'&&policy.versionId===w.policyVersion,'POLICY_CHANGED');
   const approval=tx.getRecord(p,w.approvalId);check(approval?.kind==='approval','APPROVAL');const a=JSON.parse(approval.data);
   check(a.state==='approved'&&a.intentId===id&&a.missionId===w.missionId&&a.actionDigest===digest(w)&&a.explanationRevision==='1'&&a.expiresAt===new Date(w.expiresAt).toISOString()&&canonicalize(a.explanation)===canonicalize(w.explanation),'APPROVAL');
   const decider=a.decision&&tx.getMembership(p,a.decision.actorId);
   check(decider?.role==='owner'&&String(decider.generation)===a.decision.membershipGeneration,'APPROVAL_ACTOR');
   const obligation=tx.getRecord(p,w.obligationId);check(obligation?.kind==='cost_obligation'&&obligation.versionId===w.obligationVersion,'OBLIGATION_CHANGED');
   const hold=tx.getRecord(p,w.trialHoldId);check(hold?.kind==='resource_hold'&&hold.versionId===(wire?intent.acquiredHoldVersion:w.trialHoldVersion),'HOLD_CHANGED');
   const to=w.destination as DisclosureDestination;check(to.provider==='openrouter'&&to.accountRoute===w.accountRoute,'DESTINATION');
   const request=prepareOpenRouterRequest(w.requestPolicy,w.input);
   check(createHash('sha256').update(JSON.stringify(request.body)).digest('hex')===requestDigest,'REQUEST_CHANGED');
   check(canonicalize([...to.models].sort())===canonicalize([...w.requestPolicy.models].sort())&&canonicalize([...to.endpoints].sort())===canonicalize([...w.requestPolicy.providers].sort()),'DESTINATION_CHANGED');
   // Same transaction: a revoked source rolls back the send marker and USD hold.
   const disclosure=this.#disclosure.authorizeInTransaction(tx,p,actor,w.manifestId,w.missionId,w.contractVersion,to,w.input);
   if(w.disclosure)check(canonicalize(disclosure)===canonicalize(w.disclosure),'DISCLOSURE_CHANGED');
   for(const use of w.knowledgeUses??[]){
    const resolved=new KnowledgeCoordinator(this.store,this.clock).confirmUseInTransaction(tx,p,actor,use.useId,w.missionId,use.worker);
    check(resolved.knowledgeVersion===use.knowledgeVersion&&w.input.includes(resolved.text),'KNOWLEDGE_CHANGED');
   }
   if(w.routing){
    check(this.routing,'ROUTING_COORDINATOR_REQUIRED');
    const selection=this.routing.confirmInTransaction(tx,p,actor,w.routing.proposalId,w.missionId,w.contractVersion);
    check(canonicalize({proposalId:w.routing.proposalId,...selection})===canonicalize(w.routing),'ROUTING_CHANGED');
    const debt=JSON.parse(obligation.data);if(debt.format==='cash_obligation_v1')check(selection.maximum?.currency==='USD'&&debt.held?.currency==='USD'&&moneyUnits(debt.held)>=moneyUnits(selection.maximum),'ROUTING_PRICE_BOUND');
    const c=selection.configuration;check(w.requestPolicy.mode==='fixed'&&c.model===request.body.model&&c.runtime==='standard'&&c.billingRoute==='openrouter'&&c.tools.length===0&&c.effort==='provider-default','ROUTING_ADAPTER_MISMATCH');
   }
   check(w.requestPolicy.mode!=='auto'||w.routingPool,'ROUTING_POOL_REQUIRED');
   check(!(w.routing&&w.routingPool),'ROUTING_AMBIGUOUS');
   if(w.routingPool){
    check(this.routing,'ROUTING_COORDINATOR_REQUIRED');
    const pool=this.routing.confirmPoolInTransaction(tx,p,actor,w.routingPool.poolId,w.missionId,w.contractVersion);
    check(canonicalize({poolId:w.routingPool.poolId,...pool})===canonicalize(w.routingPool),'ROUTING_POOL_CHANGED');
    const debt=JSON.parse(obligation.data);checkOpenRouterRoutingPool(pool,w.requestPolicy,debt.format==='cash_obligation_v1'?debt.held:debt.heldYen);
   }
   if(w.continuation){
    check(w.requestPolicy.mode==='fixed'&&w.routing,'CONTINUATION_ROUTE_REQUIRED');
    const continuity=confirmOpenRouterContinuation(tx,p,actor,w.continuation.intentId,w.missionId,w.accountRoute,request.body.model!);
    check(canonicalize(continuity)===canonicalize(w.continuation),'CONTINUATION_CHANGED');
   }
   if(wire){
    this.#budget.confirmAcquiredInTransaction(tx,p,actor,w.trialHoldId);
    tx.updateRecord({...row,revision:row.revision+1n,data:JSON.stringify({...intent,wireClaimed:true})},row.revision);
    this.#audit(tx,p,id,'openrouter.wire_claimed');return id;
   }
   tx.updateRecord({...row,revision:row.revision+1n,data:JSON.stringify({...intent,state:'send_intent'})},row.revision);
   this.#budget.acquireInTransaction(tx,p,actor,w.trialHoldId);
   const acquired=tx.getRecord(p,id)!;
   tx.updateRecord({...acquired,revision:acquired.revision+1n,data:JSON.stringify({...JSON.parse(acquired.data),acquiredHoldVersion:tx.getRecord(p,w.trialHoldId)!.versionId,wireClaimed:false})},acquired.revision);
   this.#audit(tx,p,id);return id;
  });
 }
 #audit(tx:LedgerTransaction,p:string,id:string,kind='openrouter.send_acquired'){
  tx.appendAudit({principalId:p,commandId:null,kind,entityId:id,createdAt:new Date(this.clock()).toISOString()});tx.setMeta(`feed:${p}`,randomUUID());
 }
}
