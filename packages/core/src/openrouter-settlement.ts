import {randomUUID} from 'node:crypto';
import type {LedgerStore} from '../../ledger/src/index.js';
import {ApiTrialBudget,usdUnits} from './api-trial-budget.js';
import {yen} from './budget.js';
import {parseMoney,moneyUnits} from './money.js';
function check(ok:unknown,reason:string):asserts ok{if(!ok)throw Error(`OPENROUTER_SETTLEMENT_${reason}`);}

/** Trusted financial evidence ingress, not renderer/provider text input.
 * USD is direct; legacy JPY requires a separate conversion receipt. */
export class OpenRouterSettlement {
 constructor(readonly store:LedgerStore,readonly clock:()=>number=Date.now){}
 settle(p:string,actor:string,intentId:string,chargeVersion:string):'recorded'|'duplicate'{
  return this.store.transaction(tx=>{
   check(tx.getMembership(p,actor)?.role==='owner','ACTOR');
   const row=tx.getRecord(p,intentId);check(row?.kind==='intent','INTENT');const intent=JSON.parse(row.data);
   check(intent.format==='openrouter_intent_v1'&&intent.route==='openrouter'&&['unknown','completed'].includes(intent.state),'STATE');
   const evidence=tx.getRecordVersion(p,chargeVersion);check(evidence?.kind==='evidence','EVIDENCE');const charge=JSON.parse(evidence.data);
   const cash=charge.format==='openrouter_charge_v2';
   check((cash?charge.currency==='USD':charge.format==='openrouter_charge_v1'&&charge.currency==='JPY'&&charge.taxIncluded===true)&&charge.intentId===intentId&&charge.accountRoute===intent.accountRoute,'CHARGE');
   check(typeof charge.generationId==='string'&&/^gen-[A-Za-z0-9_-]{1,200}$/.test(charge.generationId),'GENERATION');
   const usd=usdUnits(charge.amountUsd);
   if(cash){
    // Only the registered synthetic producer exists so far. A provider flag
    // alone is not an authenticated real-cost receipt.
    check(intent.executionMode==='synthetic'&&charge.mode==='synthetic','USD_PRODUCER_UNQUALIFIED');
   }else{
   yen(charge.amountYen);
   const conversion=tx.getRecordVersion(p,charge.conversionEvidenceVersion);check(conversion?.kind==='evidence','CONVERSION_EVIDENCE');
   const fx=JSON.parse(conversion.data);
   // The currently registered producer is synthetic only. A real financial
   // producer needs its own authenticated source/purchase-allocation contract;
   // an arbitrary evidence FK or a caller's "verified" flag cannot replace it.
   check(intent.executionMode==='synthetic'&&fx.mode==='synthetic','CONVERSION_PRODUCER_UNQUALIFIED');
   check(conversion.revision===1n&&fx.format==='openrouter_conversion_v1'&&fx.intentId===intentId&&fx.accountRoute===intent.accountRoute&&fx.generationId===charge.generationId,'CONVERSION_BINDING');
   check(fx.sourceCurrency==='USD'&&fx.targetCurrency==='JPY'&&fx.taxIncluded===true&&fx.rounding==='ceil','CONVERSION_TERMS');
   check(usdUnits(fx.amountUsd)===usd&&fx.amountYen===charge.amountYen,'CONVERSION_AMOUNT');
   const denominator=usdUnits(fx.rateDenominatorUsd),numerator=yen(fx.rateNumeratorYen);
   check(denominator>0n&&numerator>0n,'CONVERSION_RATE');
   check((usd*numerator+denominator-1n)/denominator===yen(charge.amountYen),'CONVERSION_CALCULATION');
   }
   const observation=tx.getRecord(p,intent.observationId);check(observation?.kind==='evidence'&&observation.revision===1n,'OBSERVATION');const observed=JSON.parse(observation.data);
   check(observed.format==='openrouter_observation_v1'&&observed.intentId===intentId&&observed.witnessVersion===intent.witnessVersion&&observed.response.generationId===charge.generationId&&observed.response.requestDigest===intent.requestDigest,'OBSERVATION_BINDING');
   if(cash)check(observation.versionId===charge.observationVersion,'OBSERVATION_VERSION');
   check(observed.response.usage!==null&&observed.response.usage!==undefined&&usdUnits(String(observed.response.usage.costCredits))===usd,'USD_MISMATCH');
   const prior=tx.listPrincipal().flatMap(principal=>tx.listRecord(principal.id,'cost_event')).find(r=>{
    const v=JSON.parse(r.data);return ['openrouter_cost_event_v1','openrouter_cost_event_v2'].includes(v.format)&&v.accountRoute===charge.accountRoute&&v.generationId===charge.generationId;
   });
   if(prior){const v=JSON.parse(prior.data);check(prior.principalId===p&&v.intentId===intentId&&v.chargeVersion===chargeVersion&&(cash?v.format==='openrouter_cost_event_v2'&&v.amount?.currency==='USD'&&moneyUnits(v.amount)===usd:v.format==='openrouter_cost_event_v1'&&v.amountYen===charge.amountYen)&&usdUnits(v.amountUsd)===usd,'CONFLICT');return 'duplicate';}
   check(!tx.getMeta(`api-trial-conflict:openrouter:${intent.accountRoute}`),'RECOVERY_CONFLICT');
   const obligation=tx.getRecord(p,intent.obligationId);check(obligation?.kind==='cost_obligation','OBLIGATION');const o=JSON.parse(obligation.data);
   check(o.intentId===intentId&&o.settled===false,'OBLIGATION_STATE');
   check(cash?o.format==='cash_obligation_v1'&&o.reserved?.currency==='USD'&&o.held?.currency==='USD'&&o.booked?.currency==='USD':o.format!=='cash_obligation_v1','OBLIGATION_CURRENCY');
   // Do not clamp real overspend to the reservation. Both ledgers commit together.
   tx.updateRecord({...obligation,revision:obligation.revision+1n,data:JSON.stringify(cash?{...o,held:parseMoney('USD','0'),booked:parseMoney('USD',charge.amountUsd),settled:true}:{...o,heldYen:'0',bookedYen:charge.amountYen,settled:true})},obligation.revision);
   new ApiTrialBudget(this.store,this.clock).observeInTransaction(tx,p,intent.trialHoldId,chargeVersion,charge.amountUsd);
   const id=randomUUID();tx.insertRecord({principalId:p,id,kind:'cost_event',revision:1n,data:JSON.stringify({format:cash?'openrouter_cost_event_v2':'openrouter_cost_event_v1',intentId,obligationId:obligation.id,accountRoute:charge.accountRoute,generationId:charge.generationId,amountUsd:charge.amountUsd,...(cash?{amount:parseMoney('USD',charge.amountUsd),observationVersion:charge.observationVersion}:{amountYen:charge.amountYen,conversionEvidenceVersion:charge.conversionEvidenceVersion}),chargeVersion,correctionOf:null})});
   tx.updateRecord({...row,revision:row.revision+1n,data:JSON.stringify({...intent,financialState:'settled',state:intent.outputState==='completed'?'completed':'unknown',costEventId:id})},row.revision);
   tx.appendAudit({principalId:p,commandId:null,kind:'openrouter.cost_settled',entityId:id,createdAt:new Date(this.clock()).toISOString()});tx.setMeta(`feed:${p}`,randomUUID());return 'recorded';
  });
 }
}
