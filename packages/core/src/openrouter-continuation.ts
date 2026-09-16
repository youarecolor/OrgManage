import type {LedgerTransaction} from '../../ledger/src/index.js';
import {sealConfiguration} from './routing.js';
/** Historical continuity proof only. Caller still checks fresh routing,
 * disclosure, approval and both budgets in the same transaction. */
export function confirmOpenRouterContinuation(tx:LedgerTransaction,p:string,actor:string,id:string,missionId:string,accountRoute:string,model:string){
 const check=(ok:unknown,why:string)=>{if(!ok)throw Error(`OPENROUTER_CONTINUATION_${why}`);};
 check(tx.getMembership(p,actor)?.role==='owner','ACTOR');
 const row=tx.getRecord(p,id);check(row?.kind==='intent','INTENT');const i=JSON.parse(row!.data);
 check(i.format==='openrouter_intent_v1'&&i.route==='openrouter'&&i.missionId===missionId&&i.accountRoute===accountRoute,'BINDING');
 check(i.state==='completed'&&i.outputState==='completed'&&i.financialState==='settled'&&i.cancellation==='not_requested'&&i.wireClaimed===true,'UNRESOLVED');
 check(!tx.getMeta(`api-trial-conflict:openrouter:${accountRoute}`),'COST_CONFLICT');
 const observation=tx.getRecord(p,i.observationId);check(observation?.kind==='evidence'&&observation.revision===1n,'OBSERVATION');const o=JSON.parse(observation!.data);
 check(o.format==='openrouter_observation_v1'&&o.intentId===id&&o.witnessVersion===i.witnessVersion&&o.response.requestDigest===i.requestDigest&&o.response.outputState==='completed'&&o.response.model===model,'MODEL_BINDING');
 check(o.selectedConfiguration,'CONFIGURATION_REQUIRED');const selected=sealConfiguration(o.selectedConfiguration.configuration);
 check(selected.digest===o.selectedConfiguration.configurationDigest&&selected.configuration.model===model,'CONFIGURATION_CHANGED');
 return {intentId:id,intentVersion:row!.versionId,observationVersion:observation!.versionId,model,configurationDigest:selected.digest};
}
