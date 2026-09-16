import {createHash,randomUUID} from 'node:crypto';
import canonicalize from 'canonicalize';
import type {LedgerStore,LedgerReader,LedgerTransaction} from '../../ledger/src/index.js';

/** G09 subscription exception, preserved by G11 19.4. No invented quota units. */
export interface SubscriptionEntitlement {
 mode:'synthetic'|'provider'; provider:'codex'; accountRoute:string; profileDigest:string;
 plan:'plus'|'pro'; accountType:'chatgpt'; cashMode:'none';
 additionalCharges:'verified_absent'|'unknown'; paidCreditsAvailable:boolean|null;
 unlimitedCredits:boolean|null; creditBalance:string|null; apiFallbackEnabled:boolean|null;
 purchaseOperationsEnabled:boolean|null; noExtraChargeEvidenceVersion:string;
 accountEvidenceVersion:string; configurationEvidenceVersion:string;
 observedAt:number; expiresAt:number;
}
type Hold={format:'native_subscription_hold_v1';attemptId:string;scopeId:string;actorId:string;accountRoute:string;profileDigest:string;mode:'synthetic'|'provider';entitlementId:string;ownerId:string;ownerEpoch:string;bindingDigest:string;cashMode:'none';quotaUnit:null;quotaAmount:null;remaining:'unknown';maxTurns:1;maxDurationMs:number;createdAt:number;expiresAt:number;state:'reserved'|'send_acquired'|'unknown'|'resolved'|'unsent';evidenceVersion:string|null};
const digest=(v:unknown)=>createHash('sha256').update(canonicalize(v)!).digest('hex');
function check(v:unknown,reason:string):asserts v{if(!v)throw Error('NATIVE_SUBSCRIPTION_'+reason);}
function hash(v:unknown):asserts v is string{check(typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),'HASH');}
/** Trusted host ingress; recording observations does not qualify their source.
 * The effective adapter must independently prove no-extra-charge configuration.
 * This coordinator cannot buy/reset credits, invoke a provider or grant access. */
export class NativeSubscriptionCoordinator{
 constructor(readonly store:LedgerStore,readonly clock:()=>number=Date.now){}
 #now(){const n=this.clock();check(Number.isSafeInteger(n)&&n>=0,'CLOCK');return n;}
 #evidence(tx:LedgerReader,p:string,id:string){const r=tx.getRecordVersion(p,id);check(r?.kind==='evidence','EVIDENCE');}
 recordEntitlement(p:string,actor:string,scopeId:string,contractVersion:string,observation:SubscriptionEntitlement):string{
  const value=structuredClone(observation);return this.store.transaction(tx=>{
   const now=this.#now();check(tx.getMembership(p,actor)?.role==='owner','ACTOR');const s=tx.getScope(scopeId);check(s?.principalId===p&&s.kind==='mission'&&s.state==='active','SCOPE');
   check(value.provider==='codex'&&['synthetic','provider'].includes(value.mode)&&['plus','pro'].includes(value.plan)&&value.accountType==='chatgpt'&&value.cashMode==='none','ROUTE');
   check(typeof value.accountRoute==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(value.accountRoute),'ACCOUNT');hash(value.profileDigest);
   check(['verified_absent','unknown'].includes(value.additionalCharges),'CHARGES');
   check(Number.isSafeInteger(value.observedAt)&&value.observedAt>=0&&value.observedAt<=now&&Number.isSafeInteger(value.expiresAt)&&value.expiresAt>now&&value.expiresAt-value.observedAt<=300000,'EXPIRY');
   for(const id of [value.noExtraChargeEvidenceVersion,value.accountEvidenceVersion,value.configurationEvidenceVersion])this.#evidence(tx,p,id);
   const mission=tx.getRecord(p,scopeId),contract=tx.getRecordVersion(p,contractVersion);check(mission?.kind==='mission'&&JSON.parse(mission.data).contractRef===contractVersion&&contract?.kind==='contract','CONTRACT');
   const id=randomUUID();tx.insertRecord({principalId:p,id,kind:'evidence',revision:1n,data:JSON.stringify({format:'native_subscription_entitlement_v1',actorId:actor,scopeId,contractVersion,...value})});return id;
  });
 }
 #entitlement(tx:LedgerReader,p:string,actor:string,id:string,attemptId:string){
  const row=tx.getRecord(p,id);check(row?.kind==='evidence','ENTITLEMENT');const v=JSON.parse(row.data),a=tx.native.getAttempt(p,attemptId);check(v.format==='native_subscription_entitlement_v1'&&a&&a.actorId===actor&&v.actorId===actor&&v.scopeId===a.scopeId,'BINDING');
  const b=JSON.parse(a.binding);check(v.contractVersion===b.contractVersion&&v.mode===b.mode&&v.accountRoute===b.accountRoute&&v.profileDigest===b.profileDigest,'BINDING');
  check(v.additionalCharges==='verified_absent'&&v.paidCreditsAvailable===false&&v.unlimitedCredits===false&&v.creditBalance==='0'&&v.apiFallbackEnabled===false&&v.purchaseOperationsEnabled===false,'NO_EXTRA_CHARGE_UNPROVEN');
  const now=this.#now();check(now>=v.observedAt&&now<v.expiresAt,'ENTITLEMENT_EXPIRED');for(const e of [v.noExtraChargeEvidenceVersion,v.accountEvidenceVersion,v.configurationEvidenceVersion])this.#evidence(tx,p,e);
  const member=tx.getMembership(p,actor);check(member?.role==='owner'&&String(member.generation)===b.authority.membership,'AUTHORITY');
  const scopes:{id:string;epoch:string}[]=[];let s=tx.getScope(a.scopeId);
  while(s){check(scopes.length<128&&!scopes.some(v=>v.id===s!.id)&&s.state==='active'&&(s.principalId===p||s.kind==='application'),'SCOPE');scopes.push({id:s.id,epoch:String(s.epoch)});if(s.parentId===null)break;s=tx.getScope(s.parentId);check(s,'ANCESTOR');}
  check(s?.kind==='application'&&canonicalize(scopes)===canonicalize(b.authority.scopes),'AUTHORITY');
  const mission=tx.getRecord(p,a.scopeId);check(mission?.kind==='mission'&&JSON.parse(mission.data).contractRef===b.contractVersion,'CONTRACT');
  return {v,a};
 }
 reserveInTransaction(tx:LedgerTransaction,p:string,actor:string,attemptId:string,entitlementId:string,maxDurationMs:number):string{
  this.store.assertTransaction(tx);const {v,a}=this.#entitlement(tx,p,actor,entitlementId,attemptId),now=this.#now();
  check(a.state==='prepared'&&a.ownerId===this.store.ownerId&&a.ownerEpoch===String(this.store.ownerEpoch),'ATTEMPT');
  check(Number.isSafeInteger(maxDurationMs)&&maxDurationMs>0&&maxDurationMs<=180000,'FINITE_DURATION');
  const holds=tx.listPrincipal().flatMap(principal=>tx.listRecord(principal.id,'resource_hold')).map(r=>JSON.parse(r.data));
  check(!holds.some(h=>h.format==='native_subscription_hold_v1'&&(h.attemptId===attemptId||h.accountRoute===v.accountRoute&&['reserved','send_acquired','unknown'].includes(h.state))),'UNRESOLVED_ACCOUNT');
  const id=randomUUID(),hold:Hold={format:'native_subscription_hold_v1',attemptId,scopeId:a.scopeId,actorId:actor,accountRoute:v.accountRoute,profileDigest:v.profileDigest,mode:v.mode,entitlementId,ownerId:a.ownerId,ownerEpoch:a.ownerEpoch,bindingDigest:digest(a.binding),cashMode:'none',quotaUnit:null,quotaAmount:null,remaining:'unknown',maxTurns:1,maxDurationMs,createdAt:now,expiresAt:Math.min(v.expiresAt,JSON.parse(a.binding).expiresAt),state:'reserved',evidenceVersion:null};
  tx.insertRecord({principalId:p,id,kind:'resource_hold',revision:1n,data:JSON.stringify(hold)});return id;
 }
 acquireInTransaction(tx:LedgerTransaction,p:string,actor:string,id:string,attemptId:string):void{
  this.store.assertTransaction(tx);const row=tx.getRecord(p,id);check(row?.kind==='resource_hold','HOLD');const h=JSON.parse(row.data) as Hold;
  check(h.format==='native_subscription_hold_v1'&&h.attemptId===attemptId&&h.actorId===actor&&h.state==='reserved'&&h.ownerId===this.store.ownerId&&h.ownerEpoch===String(this.store.ownerEpoch),'HOLD_BINDING');
  const {a}=this.#entitlement(tx,p,actor,h.entitlementId,attemptId);check(a.state==='send_intent'&&digest(a.binding)===h.bindingDigest&&this.#now()<h.expiresAt,'SEND_BOUNDARY');
  tx.updateRecord({...row,revision:row.revision+1n,data:JSON.stringify({...h,state:'send_acquired'})},row.revision);
 }
 observe(p:string,id:string,status:'unknown'|'resolved',evidenceVersion:string):void{
  check(status==='unknown'||status==='resolved','STATUS');this.store.transaction(tx=>{this.#evidence(tx,p,evidenceVersion);const row=tx.getRecord(p,id);check(row?.kind==='resource_hold','HOLD');const h=JSON.parse(row.data) as Hold;check(h.format==='native_subscription_hold_v1'&&['send_acquired','unknown'].includes(h.state),'OBSERVATION');
   const a=tx.native.getAttempt(p,h.attemptId);check(a,'ATTEMPT');if(status==='resolved')check(['completed','interrupted','failed'].includes(a.state),'EFFECT_UNRESOLVED');
   tx.updateRecord({...row,revision:row.revision+1n,data:JSON.stringify({...h,state:status,evidenceVersion})},row.revision);
  });
 }
 cancelUnsent(p:string,actor:string,id:string):void{
  this.store.transaction(tx=>{check(tx.getMembership(p,actor)?.role==='owner','ACTOR');const row=tx.getRecord(p,id);check(row?.kind==='resource_hold','HOLD');const h=JSON.parse(row.data) as Hold,a=tx.native.getAttempt(p,h.attemptId);check(h.format==='native_subscription_hold_v1'&&h.actorId===actor&&h.state==='reserved'&&a?.state==='discarded','SEND_MAY_HAVE_OCCURRED');tx.updateRecord({...row,revision:row.revision+1n,data:JSON.stringify({...h,state:'unsent'})},row.revision);});
 }
}
