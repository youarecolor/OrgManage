import type {LedgerReader} from '../../ledger/src/index.js';
import type {OpenRouterView} from './model.js';
import {openrouterLineage} from './openrouter-lineage.js';
import {formatMoney,moneyUnits} from './money.js';
function usd(units:string):string{
 if(!/^[0-9]+$/.test(units))throw Error('OPENROUTER_VIEW_AMOUNT');
 const n=BigInt(units);return `${n/1000000000n}.${String(n%1000000000n).padStart(9,'0')}`.replace(/\.?0+$/,'');
}
/** Explicit projection only: no raw HTTP, account labels, credentials or headers. */
export function openrouterViews(tx:LedgerReader,p:string):OpenRouterView[]{
 const recovered=tx.listRecord(p,'evidence').filter(r=>r.revision===1n).map(r=>({row:r,value:JSON.parse(r.data)})).filter(r=>r.value.format==='openrouter_generation_recovery_v1');
 return tx.listRecord(p,'intent').flatMap(row=>{
  const intent=JSON.parse(row.data);if(intent.format!=='openrouter_intent_v1'||intent.route!=='openrouter')return [];
  const obligation=tx.getRecord(p,intent.obligationId),hold=tx.getRecord(p,intent.trialHoldId);
  if(obligation?.kind!=='cost_obligation'||hold?.kind!=='resource_hold')throw Error('OPENROUTER_VIEW_BINDING');
  const o=JSON.parse(obligation.data),h=JSON.parse(hold.data);
  const cash=o.format==='cash_obligation_v1';
  if(cash&&(o.held?.currency!=='USD'||o.booked?.currency!=='USD'))throw Error('OPENROUTER_VIEW_CURRENCY');
  if(o.intentId!==row.id||h.intentId!==row.id||h.format!=='api_trial_hold_v1')throw Error('OPENROUTER_VIEW_BINDING');
  if(typeof o.month!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(o.month))throw Error('OPENROUTER_VIEW_MONTH');
  const observation=intent.observationId?tx.getRecord(p,intent.observationId):undefined;
  const v=observation?.kind==='evidence'?JSON.parse(observation.data):null;
  const response=v?.format==='openrouter_observation_v1'&&v.intentId===row.id&&v.witnessVersion===intent.witnessVersion?v.response:null;
  const zero=cash?moneyUnits(o.held)===0n&&moneyUnits(o.booked)===0n:o.heldYen==='0'&&o.bookedYen==='0';
  const unsent=intent.state==='discarded'&&intent.wireClaimed!==true&&!intent.observationId&&h.state==='unsent'&&o.settled===true&&zero&&h.heldUnits==='0'&&h.bookedUnits==='0';
  const history=recovered.filter(({value:r})=>r.binding?.intentId===row.id&&r.binding.witnessVersion===intent.witnessVersion&&r.binding.requestDigest===intent.requestDigest&&r.binding.accountRoute===intent.accountRoute&&r.binding.observationVersion===observation?.versionId&&r.binding.generationId===response?.generationId)
   .map(({row:r,value:e})=>({id:r.id,observedAt:new Date(e.receivedAt).toISOString(),status:e.result.status==='observed'?'observed' as const:'unknown' as const,costCredits:e.result.status==='observed'?usd(e.result.totalCostCreditUnits):null}))
   .sort((a,b)=>b.observedAt.localeCompare(a.observedAt)||a.id.localeCompare(b.id));
  const recovery={count:history.length,costConflict:Boolean(tx.getMeta(`api-trial-conflict:openrouter:${intent.accountRoute}`))||new Set(history.filter(r=>r.costCredits!==null).map(r=>r.costCredits)).size>1,recent:history.slice(0,5)};
  return [{id:row.id,missionId:intent.missionId,month:o.month,recovery,sourceLineage:openrouterLineage(tx,p,row.id,intent),mode:intent.executionMode==='provider'?'provider':intent.executionMode==='synthetic'?'synthetic':'unverified',state:intent.state,
   outputState:unsent?'unsent':response?.outputState==='completed'?'completed':'unknown',financialState:unsent?'released':o.settled&&h.state==='settled'?'settled':'unsettled',
   model:typeof response?.model==='string'?response.model:null,provider:typeof response?.provider==='string'?response.provider:null,text:response?.outputState==='completed'&&typeof response.text==='string'?response.text:null,
   ...(cash?{commonCash:{currency:'USD' as const,held:formatMoney(o.held),booked:formatMoney(o.booked)}}:{heldYen:o.heldYen,bookedYen:o.bookedYen}),heldUsd:usd(h.heldUnits),bookedUsd:usd(h.bookedUnits)} satisfies OpenRouterView];
 });
}
