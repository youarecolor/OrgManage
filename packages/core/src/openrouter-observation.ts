import {randomUUID} from 'node:crypto';
import type {LedgerStore} from '../../ledger/src/index.js';
import {OpenRouterJournal} from './openrouter-journal.js';
import {ApiTrialBudget} from './api-trial-budget.js';
import {sealConfiguration,type ExecutionConfiguration} from './routing.js';
function check(ok:unknown,reason:string):asserts ok{if(!ok)throw Error(`OPENROUTER_OBSERVATION_${reason}`);}

/** Applies journal evidence, never caller-supplied model text or a claimed cost.
 * Provider USD observations are not a verified common-JPY settlement. */
export class OpenRouterObservation {
 constructor(readonly store:LedgerStore,readonly clock:()=>number=Date.now){}
 collect(p:string,actor:string,intentId:string):string{
  return this.store.transaction(tx=>{
   check(tx.getMembership(p,actor)?.role==='owner','ACTOR');
   const row=tx.getRecord(p,intentId);check(row?.kind==='intent','INTENT');const intent=JSON.parse(row.data);
   check(intent.format==='openrouter_intent_v1'&&intent.route==='openrouter'&&['send_intent','unknown','completed'].includes(intent.state),'STATE');
   const witness=tx.getRecordVersion(p,intent.witnessVersion);check(witness?.kind==='evidence','WITNESS');const w=JSON.parse(witness.data);
   check(w.format==='openrouter_action_witness_v1'&&w.intentId===intentId&&w.requestDigest===intent.requestDigest,'BINDING');
   const expected=w.responseExpectation;
   check(expected&&Array.isArray(expected.models)&&expected.models.length>0&&expected.models.every((m:unknown)=>w.destination.models.includes(m))&&Array.isArray(expected.providerNames)&&expected.providerNames.length>0&&expected.providerNames.every((n:unknown)=>typeof n==='string'&&n.length>0&&n.length<=128),'EXPECTATION');
   const response=new OpenRouterJournal(this.store,this.clock).recoverInTransaction(tx,p,actor,intentId,expected);
   const original=tx.getRecordVersion(p,response.intentVersion);check(original?.kind==='intent','ORIGINAL');
   check(JSON.parse(original.data).witnessVersion===intent.witnessVersion,'WITNESS_CHANGED');
   const key=`openrouter-observation:${p}:${intentId}:${response.evidenceVersion}`,prior=tx.getMeta(key);
   if(prior)return prior;
   let selectedConfiguration=null;
   if(w.routingPool&&response.outputState==='completed'&&'model' in response){
    const matches=(w.routingPool.configurations as ExecutionConfiguration[]).filter(c=>c.model===response.model);
    check(matches.length===1,'POOL_MODEL');const selected=sealConfiguration(matches[0]!);
    check(w.routingPool.qualification.members.some((m:{digest:string;model:string})=>m.digest===selected.digest&&m.model===selected.configuration.model),'POOL_CONFIGURATION');
    // Historical observation survives expiry/revocation; never restores permission.
    selectedConfiguration={poolVersion:w.routingPool.poolVersion,configuration:selected.configuration,configurationDigest:selected.digest,executionAuthorized:false};
   }
   if(w.routing&&response.outputState==='completed'&&'model' in response){
    const selected=sealConfiguration(w.routing.configuration);
    check(selected.digest===w.routing.configurationDigest&&selected.configuration.model===response.model,'SELECTED_MODEL');
    selectedConfiguration={poolVersion:null,configuration:selected.configuration,configurationDigest:selected.digest,executionAuthorized:false};
   }
   const id=randomUUID(),value={format:'openrouter_observation_v1',intentId,witnessVersion:intent.witnessVersion,response,selectedConfiguration,financialState:'unsettled',observedAt:this.clock()};
   tx.insertRecord({principalId:p,id,kind:'evidence',revision:1n,data:JSON.stringify(value)});
   // Unknown here means the complete external effect is unresolved; outputState
   // independently preserves a successfully received text for later evaluation.
   const hold=tx.getRecord(p,intent.trialHoldId);check(hold?.kind==='resource_hold','HOLD');
   check(['acquired','unknown'].includes(JSON.parse(hold.data).state),'HOLD_STATE');
   new ApiTrialBudget(this.store,this.clock).observeInTransaction(tx,p,intent.trialHoldId,tx.getRecord(p,id)!.versionId,null);
   tx.updateRecord({...row,revision:row.revision+1n,data:JSON.stringify({...intent,state:'unknown',outputState:response.outputState,observationId:id})},row.revision);
   tx.setMeta(key,id);tx.appendAudit({principalId:p,commandId:null,kind:'openrouter.response_collected',entityId:id,createdAt:new Date(this.clock()).toISOString()});tx.setMeta(`feed:${p}`,randomUUID());
   return id;
  });
 }
}
