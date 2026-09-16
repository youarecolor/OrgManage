import {createHash,randomUUID} from 'node:crypto';
import canonicalize from 'canonicalize';
import type {LedgerStore,LedgerReader,LedgerTransaction,StoredLedgerRecord} from '../../ledger/src/index.js';
import {aggregate,budgetMonth,canReserve,yen} from './budget.js';
import type {BudgetAmounts} from './budget.js';
import type {PolicyData} from './model.js';

export interface NativePriceBound {
 mode:'synthetic'|'provider';provider:'codex';accountRoute:string;profileDigest:string;model:string;effort:string;inputDigest:string;
 maximumYen:string|null;currency:string;taxIncluded:boolean|null;observedAt:number;expiresAt:number;evidenceVersionId:string;
}
type Quote=NativePriceBound&{format:'native_price_bound_v1';scopeId:string;contractVersion:string;actorId:string;authority:string};
type CashHold=BudgetAmounts&{format:'native_cash_hold_v1';attemptId:string;scopeId:string;actorId:string;authority:string;quoteId:string;accountRoute:string;profileDigest:string;policyVersion:string;ownerId:string;ownerEpoch:string;pool:'normal';reservedYen:string;settled:boolean;state:'reserved'|'send_acquired'|'unknown'|'settled'|'unsent';evidenceVersionId:string|null};
const hash=(v:unknown)=>createHash('sha256').update(canonicalize(v)!).digest('hex');
const textHash=(v:string)=>createHash('sha256').update(v,'utf8').digest('hex');
const read=<T>(r:StoredLedgerRecord):T=>JSON.parse(r.data) as T;
function check(v:unknown,s:string):asserts v{if(!v)throw Error('NATIVE_CASH_'+s);}
/** Trusted monetary observation ingress and same-TX budget enforcement. A quote
 * does not grant provider access. Its evidence must come from the admitted adapter;
 * the current synthetic caller cannot turn a provider quote into live admission. */
export class NativeCashCoordinator {
 constructor(readonly store:LedgerStore,readonly clock:()=>number=Date.now){}
 #now(){const n=this.clock();check(Number.isSafeInteger(n)&&n>=0,'CLOCK');return n;}
 #authority(tx:LedgerReader,p:string,actor:string,scopeId:string){
  const member=tx.getMembership(p,actor);check(member?.role==='owner','ACTOR');let s=tx.getScope(scopeId);check(s?.principalId===p&&s.kind==='mission','SCOPE');const scopes:{id:string;epoch:string}[]=[];
  while(s){check(scopes.length<128&&!scopes.some(old=>old.id===s!.id)&&s.state==='active'&&(s.principalId===p||s.kind==='application'),'SCOPE_STOPPED');scopes.push({id:s.id,epoch:String(s.epoch)});if(s.parentId===null)break;s=tx.getScope(s.parentId);check(s,'ANCESTOR');}check(s.kind==='application','ROOT');return hash({member:String(member.generation),scopes});
 }
 #policy(tx:LedgerReader,p:string){const id=tx.getMeta(`policy:${p}`),r=id?tx.getRecord(p,id):undefined;check(r?.kind==='policy','POLICY');const v=read<Pick<PolicyData,'normalLimitYen'|'autonomousELimitYen'|'cash'>>(r);check(v.cash===undefined,'POLICY_CURRENCY');yen(v.normalLimitYen);yen(v.autonomousELimitYen);return {version:r.versionId,value:v};}
 #amounts(tx:LedgerReader,p:string){return tx.listRecord(p,'cost_obligation').map(r=>read<BudgetAmounts>(r));}
 #evidence(tx:LedgerReader,p:string,version:string){check(tx.getRecordVersion(p,version)?.kind==='evidence','EVIDENCE');}
 recordQuote(p:string,actor:string,scopeId:string,contractVersion:string,observation:NativePriceBound):string{
  check(observation&&['synthetic','provider'].includes(observation.mode)&&observation.provider==='codex','QUOTE_MODE');
  check(/^[A-Za-z0-9_.:-]{1,128}$/.test(observation.accountRoute)&&/^[a-f0-9]{64}$/.test(observation.profileDigest)&&/^[a-f0-9]{64}$/.test(observation.inputDigest),'QUOTE_BINDING');
  check([observation.model,observation.effort].every(v=>typeof v==='string'&&v.length>0&&v.length<=128),'MODEL');if(observation.maximumYen!==null)yen(observation.maximumYen);
  return this.store.transaction(tx=>{const now=this.#now(),authority=this.#authority(tx,p,actor,scopeId);this.#policy(tx,p);this.#evidence(tx,p,observation.evidenceVersionId);
   check(Number.isSafeInteger(observation.observedAt)&&observation.observedAt<=now&&observation.observedAt>=0&&Number.isSafeInteger(observation.expiresAt)&&observation.expiresAt>now&&observation.expiresAt-observation.observedAt<=300000,'QUOTE_TIME');
   const mission=tx.getRecord(p,scopeId);check(mission?.kind==='mission'&&JSON.parse(mission.data).contractRef===contractVersion&&tx.getRecordVersion(p,contractVersion)?.kind==='contract','CONTRACT');
   const id=randomUUID(),q:Quote={...observation,format:'native_price_bound_v1',scopeId,contractVersion,actorId:actor,authority};tx.insertRecord({principalId:p,id,kind:'evidence',revision:1n,data:JSON.stringify(q)});return id;
  });
 }
 #quote(tx:LedgerReader,p:string,actor:string,id:string,attemptId:string){
  const row=tx.getRecord(p,id),a=tx.native.getAttempt(p,attemptId);check(row?.kind==='evidence'&&row.revision===1n&&a,'QUOTE_OR_ATTEMPT');const q=read<Quote>(row),b=JSON.parse(a.binding),now=this.#now();
  check(q.format==='native_price_bound_v1'&&q.provider==='codex'&&q.mode===b.mode&&q.accountRoute===b.accountRoute&&q.model===b.model&&q.effort===b.effort&&q.profileDigest===b.profileDigest&&q.inputDigest===textHash(b.input)&&q.scopeId===a.scopeId&&q.actorId===actor&&q.contractVersion===b.contractVersion,'QUOTE_MISMATCH');
  check(q.maximumYen!==null&&q.currency==='JPY'&&q.taxIncluded===true,'PRICE_UNKNOWN');yen(q.maximumYen);
  check(now>=q.observedAt&&now<q.expiresAt,'QUOTE_EXPIRED');this.#evidence(tx,p,q.evidenceVersionId);
  check(q.authority===this.#authority(tx,p,actor,a.scopeId),'AUTHORITY_CHANGED');const mission=tx.getRecord(p,a.scopeId);check(mission?.kind==='mission'&&JSON.parse(mission.data).contractRef===q.contractVersion,'CONTRACT_CHANGED');
  return {q,a,maximum:q.maximumYen};
 }
 reserveInTransaction(tx:LedgerTransaction,p:string,actor:string,attemptId:string,quoteId:string):string{
  this.store.assertTransaction(tx);const {q,a,maximum}=this.#quote(tx,p,actor,quoteId,attemptId);check(a.state==='prepared'&&a.ownerId===this.store.ownerId&&a.ownerEpoch===String(this.store.ownerEpoch),'ATTEMPT_STATE');
  const holds=tx.listRecord(p,'cost_obligation');check(!holds.some(r=>{const v=JSON.parse(r.data);return v.format==='native_cash_hold_v1'&&v.attemptId===attemptId;}),'ALREADY_RESERVED');
  for(const other of tx.listPrincipal())if(other.id!==p)check(!tx.listRecord(other.id,'cost_obligation').some(r=>{const v=JSON.parse(r.data);return v.format==='native_cash_hold_v1'&&v.accountRoute===q.accountRoute;}),'SHARED_ACCOUNT_UNQUALIFIED');
  const now=this.#now(),month=budgetMonth(new Date(now)),policy=this.#policy(tx,p);check(canReserve(policy.value,this.#amounts(tx,p),month,maximum,'production'),'CAPACITY');
  const key=`native-cash-month:${p}:${month}`;
  if(!tx.getMeta(key)){const id=randomUUID();tx.insertRecord({principalId:p,id,kind:'budget_month',revision:1n,data:JSON.stringify({format:'native_cash_month_v1',month,policyVersion:policy.version,createdAt:now})});tx.setMeta(key,id);}
  const id=randomUUID(),hold:CashHold={format:'native_cash_hold_v1',attemptId,scopeId:a.scopeId,actorId:actor,authority:q.authority,quoteId,accountRoute:q.accountRoute,profileDigest:q.profileDigest,policyVersion:policy.version,ownerId:this.store.ownerId,ownerEpoch:String(this.store.ownerEpoch),month,purpose:'production',pool:'normal',reservedYen:maximum,heldYen:maximum,bookedYen:'0',settled:false,state:'reserved',evidenceVersionId:null};
  tx.insertRecord({principalId:p,id,kind:'cost_obligation',revision:1n,data:JSON.stringify(hold)});return id;
 }
 acquireInTransaction(tx:LedgerTransaction,p:string,actor:string,id:string,attemptId:string,quoteId:string):void{
  this.store.assertTransaction(tx);const row=tx.getRecord(p,id);check(row?.kind==='cost_obligation','HOLD');const h=read<CashHold>(row);
  check(h.format==='native_cash_hold_v1'&&h.attemptId===attemptId&&h.quoteId===quoteId&&h.actorId===actor&&h.state==='reserved'&&!h.settled&&h.heldYen===h.reservedYen&&h.ownerId===this.store.ownerId&&h.ownerEpoch===String(this.store.ownerEpoch),'HOLD_BINDING');
  const {a,maximum}=this.#quote(tx,p,actor,quoteId,attemptId),policy=this.#policy(tx,p);check(a.state==='send_intent'&&h.reservedYen===maximum&&h.policyVersion===policy.version&&h.month===budgetMonth(new Date(this.#now())),'POLICY_OR_MONTH_CHANGED');
  const totals=aggregate(this.#amounts(tx,p),h.month);check(totals.booked+totals.held<=yen(policy.value.normalLimitYen),'CAPACITY');
  tx.updateRecord({...row,revision:row.revision+1n,data:JSON.stringify({...h,state:'send_acquired'})},row.revision);
 }
 observe(p:string,id:string,state:'unknown'|'settled',evidenceVersionId:string,charge?:{key:string;amountYen:string}):'recorded'|'duplicate'{
  check(state==='unknown'||state==='settled','OBSERVATION_STATE');
  if(state==='settled'){check(charge&&/^[A-Za-z0-9_.:-]{1,192}$/.test(charge.key),'CHARGE');yen(charge.amountYen);}else check(charge===undefined,'UNKNOWN_AMOUNT');
  return this.store.transaction(tx=>{this.#evidence(tx,p,evidenceVersionId);const row=tx.getRecord(p,id);check(row?.kind==='cost_obligation','HOLD');const h=read<CashHold>(row);check(h.format==='native_cash_hold_v1'&&['send_acquired','unknown','settled'].includes(h.state),'OBSERVATION_BEFORE_SEND');
   if(state==='settled'){
    const prior=tx.listPrincipal().flatMap(principal=>tx.listRecord(principal.id,'cost_event')).find(r=>{const d=JSON.parse(r.data);return d.format==='native_cash_event_v1'&&d.accountRoute===h.accountRoute&&d.chargeKey===charge!.key;});
    if(prior){const d=JSON.parse(prior.data);check(prior.principalId===p&&d.obligationId===id&&d.amountYen===charge!.amountYen,'CHARGE_CONFLICT');return 'duplicate';}
    check(!h.settled,'ALREADY_SETTLED');const eventId=randomUUID();tx.insertRecord({principalId:p,id:eventId,kind:'cost_event',revision:1n,data:JSON.stringify({format:'native_cash_event_v1',obligationId:id,accountRoute:h.accountRoute,chargeKey:charge!.key,amountYen:charge!.amountYen,evidenceVersionId,correctionOf:null})});
    tx.updateRecord({...row,revision:row.revision+1n,data:JSON.stringify({...h,state:'settled',bookedYen:charge!.amountYen,heldYen:'0',settled:true,evidenceVersionId})},row.revision);
   }else{check(!h.settled,'FINAL_COST_ALREADY_KNOWN');tx.updateRecord({...row,revision:row.revision+1n,data:JSON.stringify({...h,state:'unknown',evidenceVersionId})},row.revision);}
   return 'recorded';
  });
 }
 cancelUnsent(p:string,actor:string,id:string):void{
  this.store.transaction(tx=>{const row=tx.getRecord(p,id);check(row?.kind==='cost_obligation','HOLD');const h=read<CashHold>(row),a=tx.native.getAttempt(p,h.attemptId);check(h.format==='native_cash_hold_v1'&&h.actorId===actor&&tx.getMembership(p,actor)?.role==='owner'&&h.state==='reserved'&&a?.state==='discarded','SEND_MAY_HAVE_OCCURRED');
   tx.updateRecord({...row,revision:row.revision+1n,data:JSON.stringify({...h,state:'unsent',heldYen:'0',settled:true})},row.revision);
  });
 }
}
