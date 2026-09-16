import { createHash, randomUUID } from 'node:crypto';
import canonicalize from 'canonicalize';
import {verifyNativeSessionPreparation} from './native-session-ingress.js';
import { strictJson } from '../../contracts/src/wire.js';
import type { LedgerStore, LedgerReader, LedgerTransaction, NativeAttempt } from '../../ledger/src/index.js';
import { boundedMessages, latestUsage, projectTextNotification, storedMessages, textMessage } from '../../native-codex/src/text-events.js';
import { CodexFrameStream } from '../../native-codex/src/stream.js';
import type { NativeAttemptView } from './model.js';
import type { ResourceCoordinator } from './resources.js';
import type { DisclosureCoordinator } from './disclosure.js';
import type { NativeCashCoordinator } from './native-cash.js';
import type { NativeAdmissionCoordinator } from './native-admission.js';
import type { NativeActionCoordinator } from './native-action.js';
import type { NativeSubscriptionCoordinator } from './native-subscription.js';

const hash=(v:unknown)=>createHash('sha256').update(canonicalize(v)!).digest('hex');
function check(v:unknown):asserts v {if(!v)throw new Error('CODEX_TURN_DENIED');}
function object(v:unknown):Record<string,unknown>{check(v&&typeof v==='object'&&!Array.isArray(v));return v as Record<string,unknown>;}
const text=(v:unknown,max=256):string=>{check(typeof v==='string'&&v.length>0&&Buffer.byteLength(v)<=max);return v;};
const terminal=(s:NativeAttempt['state'])=>['completed','interrupted','failed','discarded'].includes(s);
interface Binding {
  mode:'synthetic'|'provider'; provider:'codex'; accountRoute:string; model:string; effort:string;
  input:string; inputDigest:string; contractVersion:string; profileDigest:string;
  createdAt:number; expiresAt:number; authority:{membership:string;scopes:{id:string;epoch:string}[]};
  reconciliationId:string; jobId:string;
  resourceProfileDigest?:string;
  disclosure?:{id:string;digest:string};
  cashQuoteId?:string;
  admission?:{id:string;digest:string};
  actionApprovalId?:string;
  subscriptionEntitlementId?:string;
  providerSessionVersion?:string;
}
export interface CodexRehearsalRequest {
  principalId:string; actorId:string; scopeId:string; contractVersion:string;
  accountRoute:string; model:string; effort:string; input:string; threadId:string;
  profileDigest:string; expiresAt:number; mode:'synthetic';
}
export type CodexProviderRequest=Omit<CodexRehearsalRequest,'mode'>&{mode:'provider';sessionEvidenceVersion:string};
type TurnRequest=CodexRehearsalRequest|CodexProviderRequest;
type TurnWire=Readonly<{kind:'synthetic'|'provider';request:object}>;
type SubscriptionGuards={subscription:NativeSubscriptionCoordinator;entitlementId:string;maxDurationMs:number;disclosure:DisclosureCoordinator;manifestId:string;admission:NativeAdmissionCoordinator;profileId:string;actions:NativeActionCoordinator};
/** Durable native state. Provider preparation is protected host ingress only;
 * it requires all guards and a fresh connection-bound session receipt. No process is started here. */
export class CodexTurnCoordinator {
  constructor(readonly store:LedgerStore,readonly clock:()=>number=()=>Date.now()){this.recover();}
  /** Wire-compatible local rehearsal; it cannot start a CLI or authorize a live request. */
  openStream(p:string,id:string):CodexFrameStream{
    this.store.read(tx=>{const a=this.#get(tx,p,id);check(a.state==='send_intent');});
    return new CodexFrameStream(frame=>{const a=this.observe(p,id,frame);if(a.state==='unknown')throw Error('CODEX_STREAM_QUARANTINED');},()=>this.transportLost(p,id),()=>{
      this.store.transaction(tx=>{const a=this.#get(tx,p,id);if(a.state!=='unknown')this.#unknown(tx,a,'stream_invalid');});
    });
  }
  views(tx:LedgerReader,p:string):NativeAttemptView[]{
    return tx.native.listAttempts(p).map(a=>{
      const b=this.#binding(a),events=tx.native.events(p,a.id),end=events.find(e=>e.eventKey==='terminal');
      const messages=end?(JSON.parse(end.payload) as {messages:{id:string;text:string}[]}).messages:storedMessages(events);
      return {id:a.id,scopeId:a.scopeId,runId:a.runId,mode:b.mode,model:b.model,effort:b.effort,state:a.state,cancellation:a.cancellation,
        messages,usage:latestUsage(events),interruptionAcknowledged:events.some(e=>e.eventKey==='interrupt_ack'),quarantined:a.state==='unknown'};
    });
  }

  #session(tx:LedgerReader,p:string,actor:string,scope:string,target:{accountRoute:string;profileDigest:string;model:string;effort:string},version:string,thread:string):void{
    const row=tx.getRecordVersion(p,version);check(row?.kind==='evidence');const d=object(JSON.parse(row.data)),now=this.#now();
    check(d.format==='native_provider_session_v1'&&d.actorId===actor&&d.scopeId===scope&&d.provider==='codex');
    for(const key of ['accountRoute','profileDigest','model','effort'] as const)check(d[key]===target[key]);
    check(d.threadId===thread&&typeof d.sessionId==='string'&&/^[a-f0-9]{64}$/.test(d.sessionId));
    check(d.ownerId===this.store.ownerId&&d.ownerEpoch===String(this.store.ownerEpoch));
    check(Number.isSafeInteger(d.observedAt)&&Number.isSafeInteger(d.expiresAt)&&Number(d.observedAt)<=now&&now<Number(d.expiresAt)&&Number(d.expiresAt)-Number(d.observedAt)<=60000);
    check(d.maxTurns===1&&d.toolsEnabled===false&&d.apiFallbackEnabled===false&&d.purchaseOperationsEnabled===false);
    verifyNativeSessionPreparation(tx,p,d,now);
  }
  #now():number{const n=this.clock();check(Number.isSafeInteger(n)&&n>=0);return n;}
  #get(tx:LedgerReader,p:string,id:string):NativeAttempt{const a=tx.native.getAttempt(p,id);check(a);return a;}
  #binding(a:NativeAttempt):Binding{return JSON.parse(a.binding) as Binding;}
  #authority(tx:LedgerReader,p:string,actor:string,id:string):Binding['authority']{
    const member=tx.getMembership(p,actor);check(member?.role==='owner');
    const scopes:{id:string;epoch:string}[]=[];let s=tx.getScope(id);check(s?.principalId===p);
    while(s){check(scopes.length<128&&!scopes.some(old=>old.id===s!.id)&&s.state==='active'&&(s.principalId===p||s.kind==='application'));scopes.push({id:s.id,epoch:String(s.epoch)});if(s.parentId===null)break;s=tx.getScope(s.parentId);check(s);}
    check(s?.kind==='application');return {membership:String(member.generation),scopes};
  }
  #update(tx:LedgerTransaction,a:NativeAttempt,change:Partial<NativeAttempt>):NativeAttempt{const next={...a,...change,revision:a.revision+1n};tx.native.updateAttempt(next,a.revision);return next;}
  #audit(tx:LedgerTransaction,a:NativeAttempt,kind:string):void{tx.appendAudit({principalId:a.principalId,commandId:null,kind:`codex.${kind}`,entityId:a.id,createdAt:new Date(this.#now()).toISOString()});}
  #unknown(tx:LedgerTransaction,a:NativeAttempt,reason:string):NativeAttempt{
    const b=this.#binding(a),prior=tx.getRecord(a.principalId,b.reconciliationId);
    if(!prior){
      tx.insertRecord({principalId:a.principalId,id:b.reconciliationId,kind:'reconciliation_case',revision:1n,data:JSON.stringify({mode:b.mode==='provider'?'codex_native_text':'codex_protocol_rehearsal',attemptId:a.id,runId:a.runId,accountRoute:b.accountRoute,state:'open',reason,costState:b.mode==='provider'?'subscription_no_extra':'not_applicable_synthetic',resourceState:b.mode==='provider'?'held_until_reconciled':'not_applicable_synthetic'})});
      tx.insertRecord({principalId:a.principalId,id:b.jobId,kind:'job',revision:1n,data:JSON.stringify({mode:b.mode==='provider'?'codex_native_text':'codex_protocol_rehearsal',kind:'reconciliation',targetId:b.reconciliationId,state:'waiting',automaticResend:false})});
    }else{const d=JSON.parse(prior.data);if(d.state!=='open'){tx.updateRecord({...prior,revision:prior.revision+1n,data:JSON.stringify({...d,state:'open',reason})},prior.revision);const job=tx.getRecord(a.principalId,b.jobId);if(job)tx.updateRecord({...job,revision:job.revision+1n,data:JSON.stringify({...JSON.parse(job.data),state:'waiting'})},job.revision);}}
    const next=this.#update(tx,a,{state:'unknown'});
    for(const other of tx.native.listAttempts(a.principalId))if(other.id!==a.id&&other.scopeId===a.scopeId&&!terminal(other.state))this.#stop(tx,other);
    this.#audit(tx,next,'unknown');return next;
  }
  prepare(request:CodexRehearsalRequest):NativeAttempt{
    return this.store.transaction(tx=>this.#prepare(tx,request));
  }
  /** Atomic foundation for a qualified route; still synthetic-only in this packet. */
  prepareWithResource(request:CodexRehearsalRequest,resource:ResourceCoordinator,amounts:Readonly<Record<string,string>>):Readonly<{attempt:NativeAttempt;holdId:string}>{
    check(resource.store===this.store);
    return this.store.transaction(tx=>{
      const attempt=this.#prepare(tx,request,resource.profileDigest);
      const holdId=resource.reserveInTransaction(tx,request.principalId,request.actorId,request.scopeId,'attempt',attempt.id,amounts);
      return {attempt,holdId};
    });
  }
  prepareWithDisclosure(request:CodexRehearsalRequest,resource:ResourceCoordinator,amounts:Readonly<Record<string,string>>,disclosure:DisclosureCoordinator,manifestId:string):Readonly<{attempt:NativeAttempt;holdId:string}>{
    check(resource.store===this.store&&disclosure.store===this.store);
    return this.store.transaction(tx=>{
      const manifest=disclosure.authorizeInTransaction(tx,request.principalId,request.actorId,manifestId,request.scopeId,request.contractVersion,{provider:'codex',accountRoute:request.accountRoute,profileDigest:request.profileDigest},request.input);
      const attempt=this.#prepare(tx,request,resource.profileDigest,{id:manifest.id,digest:manifest.digest});
      const holdId=resource.reserveInTransaction(tx,request.principalId,request.actorId,request.scopeId,'attempt',attempt.id,amounts);
      return {attempt,holdId};
    });
  }
  prepareWithGuards(request:CodexRehearsalRequest,guards:{resource:ResourceCoordinator;amounts:Readonly<Record<string,string>>;disclosure:DisclosureCoordinator;manifestId:string;cash:NativeCashCoordinator;quoteId:string;qualification?:{admission:NativeAdmissionCoordinator;profileId:string};actions?:NativeActionCoordinator}):Readonly<{attempt:NativeAttempt;holdId:string;cashHoldId:string}>{
    const {resource,amounts,disclosure,manifestId,cash,quoteId}=guards;
    check([resource.store,disclosure.store,cash.store].every(s=>s===this.store));
    if(guards.qualification)check(guards.qualification.admission.store===this.store);
    if(guards.actions)check(guards.actions.store===this.store);
    return this.store.transaction(tx=>{
      const qualification=guards.qualification;
      const admission=qualification?.admission.prepareInTransaction(tx,request.principalId,request.actorId,request.scopeId,request.contractVersion,qualification.profileId,request);
      const manifest=disclosure.authorizeInTransaction(tx,request.principalId,request.actorId,manifestId,request.scopeId,request.contractVersion,{provider:'codex',accountRoute:request.accountRoute,profileDigest:request.profileDigest},request.input);
      const approvalId=guards.actions?randomUUID():undefined;
      const attempt=this.#prepare(tx,request,resource.profileDigest,{id:manifest.id,digest:manifest.digest},quoteId,admission,approvalId);
      const holdId=resource.reserveInTransaction(tx,request.principalId,request.actorId,request.scopeId,'attempt',attempt.id,amounts);
      const cashHoldId=cash.reserveInTransaction(tx,request.principalId,request.actorId,attempt.id,quoteId);
      if(approvalId)guards.actions!.createInTransaction(tx,request.principalId,request.actorId,attempt.id,approvalId,cashHoldId,holdId);
      return {attempt,holdId,cashHoldId};
    });
  }
  prepareWithSubscription(request:CodexRehearsalRequest,guards:SubscriptionGuards){check(request.mode==='synthetic');return this.#prepareSubscription(request,guards);}
  prepareProviderWithSubscription(request:CodexProviderRequest,guards:SubscriptionGuards){check(request.mode==='provider');return this.#prepareSubscription(request,guards);}
  #prepareSubscription(request:TurnRequest,guards:SubscriptionGuards):Readonly<{attempt:NativeAttempt;holdId:string;approvalId:string}>{
    const {subscription,entitlementId,maxDurationMs,disclosure,manifestId,admission,profileId,actions}=guards;
    check([subscription.store,disclosure.store,admission.store,actions.store].every(s=>s===this.store));
    return this.store.transaction(tx=>{
      const qualification=admission.prepareInTransaction(tx,request.principalId,request.actorId,request.scopeId,request.contractVersion,profileId,request);
      const manifest=disclosure.authorizeInTransaction(tx,request.principalId,request.actorId,manifestId,request.scopeId,request.contractVersion,{provider:'codex',accountRoute:request.accountRoute,profileDigest:request.profileDigest},request.input);
      const approvalId=randomUUID(),attempt=this.#prepare(tx,request,undefined,{id:manifest.id,digest:manifest.digest},undefined,qualification,approvalId,entitlementId,request.mode==='provider'?request.sessionEvidenceVersion:undefined);
      const holdId=subscription.reserveInTransaction(tx,request.principalId,request.actorId,attempt.id,entitlementId,maxDurationMs);
      actions.createSubscriptionInTransaction(tx,request.principalId,request.actorId,attempt.id,approvalId,holdId);
      return {attempt,holdId,approvalId};
    });
  }
  #prepare(tx:LedgerTransaction,request:TurnRequest,resourceProfileDigest?:string,disclosure?:{id:string;digest:string},cashQuoteId?:string,admission?:{id:string;digest:string},actionApprovalId?:string,subscriptionEntitlementId?:string,providerSessionVersion?:string):NativeAttempt{
    this.store.assertTransaction(tx);
    check(request.mode==='synthetic'||request.mode==='provider'&&providerSessionVersion!==undefined&&subscriptionEntitlementId!==undefined&&admission!==undefined&&disclosure!==undefined&&actionApprovalId!==undefined);
    if(request.mode==='provider')this.#session(tx,request.principalId,request.actorId,request.scopeId,request,providerSessionVersion!,request.threadId);
    const now=this.#now();check(Number.isSafeInteger(request.expiresAt)&&request.expiresAt>now&&request.expiresAt-now<=60000);
    text(request.input,4096);text(request.accountRoute);text(request.model);text(request.threadId);
    check(['none','minimal','low','medium','high','xhigh','max'].includes(request.effort));
    check(/^[a-f0-9]{64}$/.test(request.profileDigest));
      const authority=this.#authority(tx,request.principalId,request.actorId,request.scopeId);
      check(!tx.native.listAttempts(request.principalId).some(a=>a.scopeId===request.scopeId&&['prepared','send_intent','running','unknown'].includes(a.state)));
      const contract=tx.getRecordVersion(request.principalId,request.contractVersion);check(contract?.kind==='contract');
      const contractData=object(JSON.parse(contract.data));check(contractData.scopeId===request.scopeId&&contractData.mode===(request.mode==='provider'?'codex_native_text':'codex_protocol_rehearsal'));
      check(contractData.nativeProfileId===undefined||admission!==undefined);
      check(contractData.nativeActionApprovalRequired!==true||actionApprovalId!==undefined);
      if(subscriptionEntitlementId!==undefined)check(contractData.nativeBudgetMode==='subscription_no_extra'&&contractData.nativeActionApprovalRequired===true&&admission!==undefined&&disclosure!==undefined&&actionApprovalId!==undefined&&resourceProfileDigest===undefined&&cashQuoteId===undefined);
      if(contractData.nativeBudgetMode==='subscription_no_extra')check(subscriptionEntitlementId!==undefined);
      const mission=tx.getRecord(request.principalId,request.scopeId);
      const currentContract=mission&&tx.getRecordVersion(request.principalId,JSON.parse(mission.data).contractRef);
      if(currentContract&&JSON.parse(currentContract.data).nativeProfileId!==undefined)check(currentContract.versionId===request.contractVersion&&admission!==undefined);
      if(currentContract&&JSON.parse(currentContract.data).nativeActionApprovalRequired===true)check(currentContract.versionId===request.contractVersion&&actionApprovalId!==undefined);
      if(currentContract&&JSON.parse(currentContract.data).nativeBudgetMode==='subscription_no_extra')check(currentContract.versionId===request.contractVersion&&subscriptionEntitlementId!==undefined);
      const runId=randomUUID(),id=randomUUID();
      const binding:Binding={mode:request.mode,provider:'codex',accountRoute:request.accountRoute,model:request.model,effort:request.effort,input:request.input,inputDigest:hash(request.input),contractVersion:request.contractVersion,profileDigest:request.profileDigest,createdAt:now,expiresAt:request.expiresAt,authority,reconciliationId:randomUUID(),jobId:randomUUID()};
      if(providerSessionVersion!==undefined)binding.providerSessionVersion=providerSessionVersion;
      if(resourceProfileDigest!==undefined)binding.resourceProfileDigest=resourceProfileDigest;
      if(disclosure!==undefined)binding.disclosure={...disclosure};
      if(cashQuoteId!==undefined)binding.cashQuoteId=cashQuoteId;
      if(admission!==undefined)binding.admission={...admission};
      if(actionApprovalId!==undefined)binding.actionApprovalId=actionApprovalId;
      if(subscriptionEntitlementId!==undefined)binding.subscriptionEntitlementId=subscriptionEntitlementId;
      tx.insertRecord({principalId:request.principalId,id:runId,kind:'run',revision:1n,data:JSON.stringify({mode:request.mode==='provider'?'codex_native_text':'codex_protocol_rehearsal',scopeId:request.scopeId,contractVersion:request.contractVersion,purpose:request.mode==='provider'?'native_text_generation':'protocol_validation',model:request.model,effort:request.effort})});
      tx.insertRecord({principalId:request.principalId,id,kind:'attempt',revision:1n,data:JSON.stringify({mode:request.mode==='provider'?'codex_native_text':'codex_protocol_rehearsal',runId,ordinal:'1',provider:'codex',accountRoute:request.accountRoute})});
      const a:NativeAttempt={principalId:request.principalId,id,runId,scopeId:request.scopeId,actorId:request.actorId,ownerId:this.store.ownerId,ownerEpoch:String(this.store.ownerEpoch),binding:JSON.stringify(binding),state:'prepared',cancellation:'not_requested',threadId:request.threadId,turnId:null,revision:1n};
      tx.native.insertAttempt(a);this.#audit(tx,a,'prepared');return a;
  }
  /** Serialized request is test data only. TX commits before it can leave this method. */
  acquireStart(p:string,id:string):TurnWire{
    return this.store.transaction(tx=>this.#acquireStart(tx,p,id));
  }
  acquireStartWithResource(p:string,id:string,resource:ResourceCoordinator,holdId:string):TurnWire{
    check(resource.store===this.store);
    return this.store.transaction(tx=>{
      const attempt=this.#get(tx,p,id);
      check(this.#binding(attempt).resourceProfileDigest===resource.profileDigest);
      const wire=this.#acquireStart(tx,p,id,resource.profileDigest);
      resource.acquireSendInTransaction(tx,p,attempt.actorId,holdId,{scopeId:attempt.scopeId,effectKind:'attempt',effectId:attempt.id});
      return wire;
    });
  }
  acquireStartWithDisclosure(p:string,id:string,resource:ResourceCoordinator,holdId:string,disclosure:DisclosureCoordinator):TurnWire{
    check(resource.store===this.store&&disclosure.store===this.store);
    return this.store.transaction(tx=>{
      const attempt=this.#get(tx,p,id),b=this.#binding(attempt);check(b.disclosure&&b.resourceProfileDigest===resource.profileDigest);
      const manifest=disclosure.authorizeInTransaction(tx,p,attempt.actorId,b.disclosure.id,attempt.scopeId,b.contractVersion,{provider:'codex',accountRoute:b.accountRoute,profileDigest:b.profileDigest},b.input);
      check(manifest.digest===b.disclosure.digest);
      const wire=this.#acquireStart(tx,p,id,resource.profileDigest,manifest.digest);
      resource.acquireSendInTransaction(tx,p,attempt.actorId,holdId,{scopeId:attempt.scopeId,effectKind:'attempt',effectId:attempt.id});
      return wire;
    });
  }
  acquireStartWithGuards(p:string,id:string,guards:{resource:ResourceCoordinator;holdId:string;disclosure:DisclosureCoordinator;cash:NativeCashCoordinator;cashHoldId:string;admission?:NativeAdmissionCoordinator;actions?:NativeActionCoordinator}):TurnWire{
    const {resource,holdId,disclosure,cash,cashHoldId}=guards;
    check([resource.store,disclosure.store,cash.store].every(s=>s===this.store));
    if(guards.admission)check(guards.admission.store===this.store);
    if(guards.actions)check(guards.actions.store===this.store);
    return this.store.transaction(tx=>{
      const attempt=this.#get(tx,p,id),b=this.#binding(attempt);check(b.disclosure&&b.cashQuoteId&&b.resourceProfileDigest===resource.profileDigest);
      check(Boolean(b.admission)===Boolean(guards.admission));
      const admission=b.admission&&guards.admission?.authorizeInTransaction(tx,p,attempt.actorId,attempt.scopeId,b.contractVersion,b.admission.id,b);
      check(admission?.digest===b.admission?.digest);
      check(Boolean(b.actionApprovalId)===Boolean(guards.actions));
      const approvalId=b.actionApprovalId&&guards.actions?.authorizeInTransaction(tx,p,id,b.actionApprovalId,cashHoldId,holdId);
      const manifest=disclosure.authorizeInTransaction(tx,p,attempt.actorId,b.disclosure.id,attempt.scopeId,b.contractVersion,{provider:'codex',accountRoute:b.accountRoute,profileDigest:b.profileDigest},b.input);
      check(manifest.digest===b.disclosure.digest);
      const wire=this.#acquireStart(tx,p,id,resource.profileDigest,manifest.digest,b.cashQuoteId,admission?.digest,approvalId);
      resource.acquireSendInTransaction(tx,p,attempt.actorId,holdId,{scopeId:attempt.scopeId,effectKind:'attempt',effectId:attempt.id});
      cash.acquireInTransaction(tx,p,attempt.actorId,cashHoldId,attempt.id,b.cashQuoteId);
      if(approvalId)guards.actions!.markSentInTransaction(tx,p,id,approvalId);
      return wire;
    });
  }
  acquireProviderStartWithSubscription(p:string,id:string,guards:Parameters<CodexTurnCoordinator['acquireStartWithSubscription']>[2]):TurnWire{return this.#acquireSubscription(p,id,guards,'provider');}
  acquireStartWithSubscription(p:string,id:string,guards:{subscription:NativeSubscriptionCoordinator;holdId:string;disclosure:DisclosureCoordinator;admission:NativeAdmissionCoordinator;actions:NativeActionCoordinator}):TurnWire{
    return this.#acquireSubscription(p,id,guards,'synthetic');
  }
  #acquireSubscription(p:string,id:string,guards:Parameters<CodexTurnCoordinator['acquireStartWithSubscription']>[2],mode:'synthetic'|'provider'):TurnWire{
    const {subscription,holdId,disclosure,admission,actions}=guards;check([subscription.store,disclosure.store,admission.store,actions.store].every(s=>s===this.store));
    return this.store.transaction(tx=>{
      const a=this.#get(tx,p,id),b=this.#binding(a);check(b.subscriptionEntitlementId&&b.disclosure&&b.admission&&b.actionApprovalId&&b.cashQuoteId===undefined&&b.resourceProfileDigest===undefined);
      const qualification=admission.authorizeInTransaction(tx,p,a.actorId,a.scopeId,b.contractVersion,b.admission.id,b);check(qualification.digest===b.admission.digest);
      const manifest=disclosure.authorizeInTransaction(tx,p,a.actorId,b.disclosure.id,a.scopeId,b.contractVersion,{provider:'codex',accountRoute:b.accountRoute,profileDigest:b.profileDigest},b.input);check(manifest.digest===b.disclosure.digest);
      const approvalId=actions.authorizeInTransaction(tx,p,id,b.actionApprovalId,null,holdId);
      const wire=this.#acquireStart(tx,p,id,undefined,manifest.digest,undefined,qualification.digest,approvalId,b.subscriptionEntitlementId,mode);
      subscription.acquireInTransaction(tx,p,a.actorId,holdId,id);actions.markSentInTransaction(tx,p,id,approvalId);return wire;
    });
  }
  #acquireStart(tx:LedgerTransaction,p:string,id:string,resourceProfileDigest?:string,disclosureDigest?:string,cashQuoteId?:string,admissionDigest?:string,actionApprovalId?:string,subscriptionEntitlementId?:string,mode:'synthetic'|'provider'='synthetic'):TurnWire{
      this.store.assertTransaction(tx);
      const a=this.#get(tx,p,id),b=this.#binding(a);
      check(b.mode===mode);
      if(mode==='provider'){check(b.providerSessionVersion);this.#session(tx,p,a.actorId,a.scopeId,b,b.providerSessionVersion,a.threadId!);}
      check(b.resourceProfileDigest===resourceProfileDigest);
      check(b.disclosure?.digest===disclosureDigest);
      check(b.cashQuoteId===cashQuoteId);
      check(b.admission?.digest===admissionDigest);
      check(b.actionApprovalId===actionApprovalId);
      check(b.subscriptionEntitlementId===subscriptionEntitlementId);
      check(a.state==='prepared'&&a.cancellation==='not_requested'&&a.ownerId===this.store.ownerId&&a.ownerEpoch===String(this.store.ownerEpoch));
      check(!tx.native.listAttempts(p).some(other=>other.id!==id&&other.scopeId===a.scopeId&&other.state==='unknown'));
      const now=this.#now();check(now>=b.createdAt&&now<b.expiresAt&&canonicalize(b.authority)===canonicalize(this.#authority(tx,p,a.actorId,a.scopeId)));
      this.#update(tx,a,{state:'send_intent'});this.#audit(tx,a,'send_intent');
      return {kind:b.mode,request:{id:`start:${id}`,method:'turn/start',params:{threadId:a.threadId,input:[{type:'text',text:b.input,text_elements:[]}],model:b.model,effort:b.effort,environments:[],approvalPolicy:'never'}}};
  }
  requestStop(p:string,id:string):void{this.store.transaction(tx=>{this.#stop(tx,this.#get(tx,p,id));});}
  #stop(tx:LedgerTransaction,a:NativeAttempt):void{
    if(terminal(a.state)||a.cancellation!=='not_requested')return;
    this.#update(tx,a,{state:a.state==='prepared'?'discarded':a.state,cancellation:'requested'});this.#audit(tx,a,'stop_requested');
  }
  stopDescendants(tx:LedgerTransaction,p:string,scopeId:string):void{
    for(const a of tx.native.listAttempts(p))if(this.#binding(a).authority.scopes.some(s=>s.id===scopeId))this.#stop(tx,a);
  }
  acquireInterrupt(p:string,id:string):TurnWire{
    return this.store.transaction(tx=>{
      const a=this.#get(tx,p,id);check(a.cancellation==='requested'&&!terminal(a.state)&&a.turnId&&a.threadId);
      check(a.ownerId===this.store.ownerId&&a.ownerEpoch===String(this.store.ownerEpoch));
      check(!tx.native.events(p,id).some(e=>e.eventKey==='interrupt_intent'));
      const operationId=randomUUID();tx.insertRecord({principalId:p,id:operationId,kind:'control_operation',revision:1n,data:JSON.stringify({mode:this.#binding(a).mode==='provider'?'codex_native_text':'codex_protocol_rehearsal',kind:'native_interrupt',attemptId:id,threadId:a.threadId,turnId:a.turnId,state:'send_intent',model:null})});
      tx.native.insertEvent({principalId:p,id:randomUUID(),attemptId:id,eventKey:'interrupt_intent',digest:hash({threadId:a.threadId,turnId:a.turnId}),payload:JSON.stringify({operationId,threadId:a.threadId,turnId:a.turnId})});
      return {kind:this.#binding(a).mode,request:{id:`interrupt:${id}`,method:'turn/interrupt',params:{threadId:a.threadId,turnId:a.turnId}}};
    });
  }
  transportLost(p:string,id:string):void{this.store.transaction(tx=>{const a=this.#get(tx,p,id);if(!terminal(a.state)&&a.state!=='prepared')this.#unknown(tx,a,'transport_lost');});}
  maintain():void{
    const now=this.#now();this.store.transaction(tx=>{for(const p of tx.listPrincipal())for(const a of tx.native.listAttempts(p.id)){
      if(terminal(a.state))continue;const b=this.#binding(a);let allowed=false;
      try{allowed=now>=b.createdAt&&now<b.expiresAt&&canonicalize(b.authority)===canonicalize(this.#authority(tx,p.id,a.actorId,a.scopeId));}catch{}
      if(!allowed)this.#stop(tx,a);
    }});
  }
  recover():void{
    this.store.transaction(tx=>{for(const p of tx.listPrincipal())for(const a of tx.native.listAttempts(p.id)){
      if(a.ownerId===this.store.ownerId&&a.ownerEpoch===String(this.store.ownerEpoch)||terminal(a.state))continue;
      if(a.state==='prepared')this.#update(tx,a,{state:'discarded'});else this.#unknown(tx,a,'owner_changed');
    }});
  }
  /** Accept only a frame delivered for this connection-bound attempt. Never trust a remote principal/id. */
  observe(p:string,id:string,bytes:Uint8Array):NativeAttempt{
    let frame:Record<string,unknown>;
    try {check(bytes.byteLength<=65536);const parsed=strictJson(bytes);check(parsed.ok);frame=object(parsed.value);}
    catch {this.transportLost(p,id);throw new Error('CODEX_FRAME_INVALID');}
    return this.store.transaction(tx=>this.#observeFrame(tx,p,id,frame));
  }
  /** Trusted recovery ingress: replay the complete verified batch atomically,
   * so a crash cannot commit an early terminal while omitting a conflicting tail.
   * Evidence provenance and process closure are checked by the owning host. */
  observeRecoveredFrames(p:string,id:string,frames:readonly Uint8Array[],evidenceVersion:string):NativeAttempt{
    try{
      check(frames.length<=4096);let total=0;
      const parsed=frames.map(bytes=>{total+=bytes.byteLength;check(bytes.byteLength<=65536&&total<=2*1024*1024);const value=strictJson(bytes);check(value.ok);return object(value.value);});
      return this.store.transaction(tx=>{
        const a=this.#get(tx,p,id),b=this.#binding(a),row=tx.getRecordVersion(p,evidenceVersion);check(b.mode==='provider'&&row?.kind==='evidence'&&['unknown','completed','failed','interrupted'].includes(a.state));
        const evidence=JSON.parse(row.data);check(evidence.format==='native_journal_recovery_v1'&&evidence.attemptId===id&&evidence.sealed===true&&evidence.processExitObserved===true&&evidence.providerSessionVersion===b.providerSessionVersion);
        let result=a;for(const frame of parsed)result=this.#observeFrame(tx,p,id,frame,true);
        this.#audit(tx,result,'journal_recovered');return result;
      });
    }catch(error){
      this.store.transaction(tx=>{const a=this.#get(tx,p,id);if(a.state!=='prepared'&&a.state!=='discarded')this.#unknown(tx,a,'journal_recovery_invalid');});
      throw error;
    }
  }
  #observeFrame(tx:LedgerTransaction,p:string,id:string,frame:Record<string,unknown>,strict=false):NativeAttempt{
      let a=this.#get(tx,p,id);check(a.state!=='prepared'&&a.state!=='discarded');
      const reject=(reason:string):NativeAttempt=>{if(strict)throw Error('CODEX_RECOVERY_'+reason);return this.#unknown(tx,a,reason);};
      if('id' in frame&&'method' in frame)return reject('server_request_not_allowed');
      if('error' in frame)return reject('rpc_error');
      let key:string,projection:object,turnId:string|null=a.turnId,next:NativeAttempt['state']=a.state;
      let cancellation=a.cancellation;
      try {
        if('method' in frame){
          const projected=projectTextNotification(frame,a.threadId,a.turnId,tx.native.events(p,id));
          if(projected===null)return a;
          if(projected){key=projected.key;projection=projected.projection;turnId=projected.turnId;}
          else {
          check(frame.method==='turn/started'||frame.method==='turn/completed');
          const params=object(frame.params),turn=object(params.turn);check(params.threadId===a.threadId);
          turnId=text(turn.id);check(!a.turnId||turnId===a.turnId);
          if(frame.method==='turn/started'){check(turn.status==='inProgress');key='turn_identity';projection={turnId};if(!terminal(a.state)&&a.state!=='unknown')next='running';}
          else {
            check(['completed','interrupted','failed'].includes(turn.status as string));
            check(Array.isArray(turn.items)&&turn.items.length<=64);
            const messages=turn.items.map(item=>{const i=object(item);check(i.type==='agentMessage'||i.type==='userMessage'||i.type==='reasoning');return i.type==='agentMessage'?textMessage(i):null;}).filter(i=>i!==null);
            boundedMessages(messages);
            for(const m of storedMessages(tx.native.events(p,id))){const same=messages.find(i=>i.id===m.id);check(!same||same.text===m.text);if(!same)messages.push(m);}
            boundedMessages(messages);
            key='terminal';projection={threadId:a.threadId,turnId,status:turn.status,messages};next=turn.status as NativeAttempt['state'];
            if(next==='interrupted')cancellation='observed';
          }
          }
        }else if(frame.id===`start:${id}`){
          const turn=object(object(frame.result).turn);turnId=text(turn.id);check(!a.turnId||turnId===a.turnId);check(turn.status==='inProgress');key='turn_identity';projection={turnId};if(!terminal(a.state)&&a.state!=='unknown')next='running';
        }else if(frame.id===`interrupt:${id}`){
          check(tx.native.events(p,id).some(e=>e.eventKey==='interrupt_intent'));check(Object.keys(object(frame.result)).length===0);key='interrupt_ack';projection={accepted:true};
        }else throw new Error();
      }catch{return reject('protocol_mismatch');}
      const digest=hash(key==='terminal'?frame:projection),events=tx.native.events(p,id),prior=events.filter(e=>e.eventKey===key);
      if(prior.some(e=>e.digest===digest))return a;
      if(events.length>=128)return reject('event_limit');
      tx.native.insertEvent({principalId:p,id:randomUUID(),attemptId:id,eventKey:key,digest,payload:JSON.stringify(projection)});
      if(prior.length)return reject('event_conflict');
      // A previous terminal conflict remains quarantined even if more events arrive.
      const conflict=events.some(e=>events.some(other=>other.eventKey===e.eventKey&&other.digest!==e.digest));
      if(conflict)return reject('unresolved_conflict');
      a=this.#update(tx,a,{turnId,state:next,cancellation});this.#audit(tx,a,'observation');
      const interrupt=events.find(e=>e.eventKey==='interrupt_intent');
      if(interrupt&&(key==='interrupt_ack'||key==='terminal')){
        const operation=tx.getRecord(p,JSON.parse(interrupt.payload).operationId);
        if(operation)tx.updateRecord({...operation,revision:operation.revision+1n,data:JSON.stringify({...JSON.parse(operation.data),state:key==='terminal'?'target_terminal_observed':'acknowledged',cancellationObserved:cancellation==='observed'})},operation.revision);
      }
      if(terminal(next)){
        const b=this.#binding(a),c=tx.getRecord(p,b.reconciliationId);
        if(c){const d=JSON.parse(c.data);tx.updateRecord({...c,revision:c.revision+1n,data:JSON.stringify({...d,state:'resolved',resolution:b.mode==='provider'?'provider_terminal_observed':'synthetic_terminal_observed'})},c.revision);const job=tx.getRecord(p,b.jobId);if(job)tx.updateRecord({...job,revision:job.revision+1n,data:JSON.stringify({...JSON.parse(job.data),state:'completed'})},job.revision);}
      }
      return a;
  }
}
