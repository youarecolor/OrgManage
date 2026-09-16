import {randomUUID} from 'node:crypto';
import type {LedgerStore,LedgerTransaction} from '../../ledger/src/index.js';
import {aggregate,budgetMonth,yen} from './budget.js';
import {moneyUnits,parseMoney,type Money} from './money.js';
import {canReserveUsd,type CashBudgetRow} from './usd-budget.js';

function check(ok:unknown,why:string):asserts ok{if(!ok)throw Error(`API_TRIAL_${why}`);}
/** Exact decimal USD, never Number arithmetic. Unsupported precision is unknown. */
export function usdUnits(value:string):bigint{
 try{return moneyUnits(parseMoney('USD',value));}catch{throw Error('API_TRIAL_AMOUNT');}
}
type TrialHold={format:'api_trial_hold_v1';accountRoute:string;intentId:string;obligationId:string;limitVersion:string;reservedUnits:string;bookedUnits:string;heldUnits:string;state:'reserved'|'acquired'|'unknown'|'settled'|'unsent';ownerId:string;ownerEpoch:string;evidenceVersion?:string};
/** Supplementary USD trial envelope. Every hold references an already-created
 * versioned common USD obligation or explicit legacy JPY obligation in the same
 * transaction. This is not a dispatch port or a currency conversion. */
export class ApiTrialBudget {
 constructor(readonly store:LedgerStore,readonly clock:()=>number=Date.now){}
 #owner(tx:LedgerTransaction,p:string,actor:string){check(tx.getMembership(p,actor)?.role==='owner','ACTOR');}
 configure(p:string,actor:string,accountRoute:string,limitUsd:string,evidenceVersion:string):string{
  check(/^[A-Za-z0-9_.:-]{1,128}$/.test(accountRoute),'ACCOUNT');const limit=usdUnits(limitUsd);check(limit>0n,'LIMIT');
  return this.store.transaction(tx=>{
   this.#owner(tx,p,actor);check(tx.getRecordVersion(p,evidenceVersion)?.kind==='evidence','EVIDENCE');
   const key=`api-trial:openrouter:${accountRoute}`;check(!tx.getMeta(key),'ALREADY_CONFIGURED');
   const id=randomUUID();tx.insertRecord({principalId:p,id,kind:'evidence',revision:1n,data:JSON.stringify({format:'api_trial_limit_v1',provider:'openrouter',accountRoute,limitUnits:String(limit),actor,evidenceVersion})});tx.setMeta(key,JSON.stringify({principal:p,id}));return id;
  });
 }
 #limit(tx:LedgerTransaction,p:string,account:string){
  check(!tx.getMeta(`api-trial-conflict:openrouter:${account}`),'RECOVERY_CONFLICT');
  const raw=tx.getMeta(`api-trial:openrouter:${account}`);check(raw,'LIMIT_MISSING');const binding=JSON.parse(raw);
  check(binding.principal===p,'SHARED_ACCOUNT');const row=tx.getRecord(p,binding.id);check(row?.kind==='evidence'&&row.revision===1n,'LIMIT_CHANGED');
  const value=JSON.parse(row.data);check(value.format==='api_trial_limit_v1'&&value.accountRoute===account,'LIMIT_CHANGED');
  return {version:row.versionId,units:BigInt(value.limitUnits)};
 }
 #holds(tx:LedgerTransaction,p:string,account:string){return tx.listRecord(p,'resource_hold').map(r=>JSON.parse(r.data) as TrialHold).filter(h=>h.format==='api_trial_hold_v1'&&h.accountRoute===account);}
 #binding(tx:LedgerTransaction,p:string,intentId:string,obligationId:string){
  const ir=tx.getRecord(p,intentId),o=tx.getRecord(p,obligationId);check(ir?.kind==='intent'&&o?.kind==='cost_obligation','COMMON_RECORD');
  const intent=JSON.parse(ir.data),obligation=JSON.parse(o.data);
  check(intent.obligationId===obligationId&&obligation.intentId===intentId&&intent.route==='openrouter','COMMON_BINDING');
  return {intent,obligation};
 }
 #capacity(tx:LedgerTransaction,p:string,obligation:{month:string;heldYen?:string;settled:boolean;format?:string;policyVersion?:string;held?:Money;reserved?:Money;booked?:Money;pool?:'normal'|'reserve';purpose?:'production'|'autonomous_e'},minimumUnits:bigint){
  const id=tx.getMeta(`policy:${p}`),policy=id?tx.getRecord(p,id):undefined;check(policy?.kind==='policy','POLICY');
  const policyData=JSON.parse(policy.data);
  if(policyData.cash!==undefined){
   check(policyData.cash.format==='usd_budget_policy_v1','COMMON_POLICY');
   check(obligation.format==='cash_obligation_v1','COMMON_CURRENCY');
   check(obligation.policyVersion===policy.versionId,'COMMON_POLICY_CHANGED');
   check(!obligation.settled&&obligation.held?.currency==='USD'&&moneyUnits(obligation.held)>0n&&obligation.month===budgetMonth(new Date(this.clock())),'COMMON_HOLD');
   check(obligation.reserved?.currency==='USD'&&moneyUnits(obligation.reserved)>=minimumUnits&&moneyUnits(obligation.held)>=minimumUnits,'COMMON_USD_UNDERSIZED');
   check(obligation.pool==='normal'&&['production','autonomous_e'].includes(obligation.purpose!),'COMMON_SCOPE');
   const rows:CashBudgetRow[]=tx.listRecord(p,'cost_obligation').map(r=>{
    const v=JSON.parse(r.data);if(v.format==='cash_obligation_v1')return v;
    check(v.settled===true,'LEGACY_UNRESOLVED');
    const booked=parseMoney('JPY',v.bookedYen),held=parseMoney('JPY',v.heldYen);
    // Exact zero requires no FX. Preserve the original row and currency.
    return {...v,pool:v.pool??'normal',booked:moneyUnits(booked)===0n?parseMoney('USD','0'):booked,held:moneyUnits(held)===0n?parseMoney('USD','0'):held};
   });
   check(canReserveUsd(policyData.cash,rows,obligation.month,parseMoney('USD','0'),obligation.purpose!,obligation.pool),'COMMON_USD_CAPACITY');return;
  }
  check(obligation.format!=='cash_obligation_v1','COMMON_CURRENCY');
  check(!obligation.settled&&yen(obligation.heldYen!)>0n&&obligation.month===budgetMonth(new Date(this.clock())),'COMMON_HOLD');
  const amounts=aggregate(tx.listRecord(p,'cost_obligation').map(r=>JSON.parse(r.data)),obligation.month);
  check(amounts.booked+amounts.held<=yen(JSON.parse(policy.data).normalLimitYen),'JPY_CAPACITY');
 }
 reserveInTransaction(tx:LedgerTransaction,p:string,actor:string,account:string,intentId:string,obligationId:string,maximumUsd:string):string{
  this.store.assertTransaction(tx);this.#owner(tx,p,actor);const maximum=usdUnits(maximumUsd),limit=this.#limit(tx,p,account);
  const {intent,obligation}=this.#binding(tx,p,intentId,obligationId);check(intent.state==='prepared','INTENT_STATE');check(intent.accountRoute===account,'ACCOUNT_BINDING');this.#capacity(tx,p,obligation,maximum);
  const holds=this.#holds(tx,p,account);check(!holds.some(h=>h.intentId===intentId),'DUPLICATE_HOLD');
  check(holds.reduce((n,h)=>n+BigInt(h.bookedUnits)+BigInt(h.heldUnits),0n)+maximum<=limit.units,'USD_CAPACITY');
  const id=randomUUID(),h:TrialHold={format:'api_trial_hold_v1',accountRoute:account,intentId,obligationId,limitVersion:limit.version,reservedUnits:String(maximum),heldUnits:String(maximum),bookedUnits:'0',state:'reserved',ownerId:this.store.ownerId,ownerEpoch:String(this.store.ownerEpoch)};
  tx.insertRecord({principalId:p,id,kind:'resource_hold',revision:1n,data:JSON.stringify(h)});return id;
 }
 acquireInTransaction(tx:LedgerTransaction,p:string,actor:string,id:string){
  this.store.assertTransaction(tx);this.#owner(tx,p,actor);const row=tx.getRecord(p,id);check(row?.kind==='resource_hold','HOLD');const h=JSON.parse(row.data) as TrialHold;
  check(h.format==='api_trial_hold_v1'&&h.state==='reserved'&&h.ownerId===this.store.ownerId&&h.ownerEpoch===String(this.store.ownerEpoch),'HOLD_STATE');
  const limit=this.#limit(tx,p,h.accountRoute);check(limit.version===h.limitVersion,'LIMIT_CHANGED');
  const {intent,obligation}=this.#binding(tx,p,h.intentId,h.obligationId);check(intent.state==='send_intent','INTENT_STATE');check(intent.accountRoute===h.accountRoute,'ACCOUNT_BINDING');this.#capacity(tx,p,obligation,BigInt(h.reservedUnits));
  check(this.#holds(tx,p,h.accountRoute).reduce((n,v)=>n+BigInt(v.bookedUnits)+BigInt(v.heldUnits),0n)<=limit.units,'USD_CAPACITY');
  tx.updateRecord({...row,revision:row.revision+1n,data:JSON.stringify({...h,state:'acquired'})},row.revision);
 }
 observeInTransaction(tx:LedgerTransaction,p:string,id:string,evidenceVersion:string,costUsd:string|null){
  this.store.assertTransaction(tx);check(tx.getRecordVersion(p,evidenceVersion)?.kind==='evidence','EVIDENCE');
  const row=tx.getRecord(p,id);check(row?.kind==='resource_hold','HOLD');const h=JSON.parse(row.data) as TrialHold;
  check(h.format==='api_trial_hold_v1','HOLD');
  const {obligation}=this.#binding(tx,p,h.intentId,h.obligationId);
  if(costUsd!==null&&obligation.format==='cash_obligation_v1')check(obligation.settled===true&&obligation.held?.currency==='USD'&&moneyUnits(obligation.held)===0n&&obligation.booked?.currency==='USD'&&moneyUnits(obligation.booked)===usdUnits(costUsd),'COMMON_USD_NOT_SETTLED');
  if(h.state==='settled'){
   check(costUsd!==null&&h.bookedUnits===String(usdUnits(costUsd))&&h.evidenceVersion===evidenceVersion,'OBSERVATION_CONFLICT');return 'duplicate' as const;
  }
  if(h.state==='unknown'&&costUsd===null&&h.evidenceVersion===evidenceVersion)return 'duplicate' as const;
  check(['acquired','unknown'].includes(h.state),'OBSERVATION_STATE');
  // Caller settles the common side in this transaction. USD equality was checked
  // above; legacy JPY still needs its separate conversion producer. Actual overage
  // is recorded, never clipped to the approved maximum.
  if(costUsd!==null&&obligation.format!=='cash_obligation_v1')check(obligation.settled===true&&obligation.heldYen==='0','JPY_NOT_SETTLED');
  const next=costUsd===null?{...h,state:'unknown'}:{...h,state:'settled',heldUnits:'0',bookedUnits:String(usdUnits(costUsd))};
  tx.updateRecord({...row,revision:row.revision+1n,data:JSON.stringify({...next,evidenceVersion})},row.revision);
  return 'recorded' as const;
 }
 /** Read-only revalidation inside the durable wire-claim transaction. */
 confirmAcquiredInTransaction(tx:LedgerTransaction,p:string,actor:string,id:string){
  this.store.assertTransaction(tx);this.#owner(tx,p,actor);const row=tx.getRecord(p,id);check(row?.kind==='resource_hold','HOLD');const h=JSON.parse(row.data) as TrialHold;
  check(h.format==='api_trial_hold_v1'&&h.state==='acquired'&&h.ownerId===this.store.ownerId&&h.ownerEpoch===String(this.store.ownerEpoch),'HOLD_STATE');
  const limit=this.#limit(tx,p,h.accountRoute);check(limit.version===h.limitVersion,'LIMIT_CHANGED');
  const {intent,obligation}=this.#binding(tx,p,h.intentId,h.obligationId);
  check(intent.state==='send_intent'&&intent.accountRoute===h.accountRoute,'ACCOUNT_BINDING');this.#capacity(tx,p,obligation,BigInt(h.reservedUnits));
  check(this.#holds(tx,p,h.accountRoute).reduce((n,v)=>n+BigInt(v.bookedUnits)+BigInt(v.heldUnits),0n)<=limit.units,'USD_CAPACITY');
 }
 /** Called with the common intent discard and unsent cash release in one TX.
  * An acquired/unknown request cannot use this path, even after owner restart. */
 releaseUnsentInTransaction(tx:LedgerTransaction,p:string,actor:string,id:string){
  this.store.assertTransaction(tx);this.#owner(tx,p,actor);return this.releaseDiscardedInTransaction(tx,p,id);
 }
 /** Core-only cleanup after its authorized discard, including owner recovery. */
 releaseDiscardedInTransaction(tx:LedgerTransaction,p:string,id:string){
  this.store.assertTransaction(tx);const row=tx.getRecord(p,id);check(row?.kind==='resource_hold','HOLD');const h=JSON.parse(row.data) as TrialHold;
  check(h.format==='api_trial_hold_v1'&&(h.state==='reserved'||h.state==='unsent'),'SEND_MAY_HAVE_OCCURRED');
  const {intent,obligation}=this.#binding(tx,p,h.intentId,h.obligationId);
  const zero=obligation.format==='cash_obligation_v1'
   ?obligation.held?.currency==='USD'&&moneyUnits(obligation.held)===0n&&obligation.booked?.currency==='USD'&&moneyUnits(obligation.booked)===0n
   :obligation.heldYen==='0'&&obligation.bookedYen==='0';
  check(intent.state==='discarded'&&intent.accountRoute===h.accountRoute&&obligation.settled===true&&zero,'COMMON_NOT_UNSENT');
  if(h.state==='unsent')return 'duplicate' as const;
  tx.updateRecord({...row,revision:row.revision+1n,data:JSON.stringify({...h,state:'unsent',heldUnits:'0'})},row.revision);return 'recorded' as const;
 }
}
