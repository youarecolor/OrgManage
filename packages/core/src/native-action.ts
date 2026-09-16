import {createHash,randomUUID} from 'node:crypto';
import canonicalize from 'canonicalize';
import type {LedgerStore,LedgerReader,LedgerTransaction,NativeAttempt,StoredLedgerRecord} from '../../ledger/src/index.js';
import type {ApprovalView} from './model.js';
import {budgetMonth} from './budget.js';

const digest=(v:unknown)=>createHash('sha256').update(canonicalize(v)!).digest('hex');
export class NativeActionDenied extends Error {readonly code='DENIED';constructor(reason:string){super(`NATIVE_ACTION_${reason}`);}}
function check(v:unknown,reason:string):asserts v{if(!v)throw new NativeActionDenied(reason);}
type Approval=Omit<ApprovalView,'id'|'revision'>&{format:'native_action_approval_v1';attemptId:string;witnessVersion:string;createdAt:string;decision:{actorId:string;membershipGeneration:string;comment:string|null;decidedAt:string}|null};
type Witness={format:'native_action_witness_v1'|'native_action_witness_v2';approvalId:string;attemptId:string;actorId:string;scopeId:string;binding:string;ownerId:string;ownerEpoch:string;cashId:string|null;cashVersion:string|null;quotaId:string;quotaVersion:string;subscriptionPolicyVersion?:string;explanation:ApprovalView['explanation']};
/** Uses the ordinary approval.decide command and Home approval view. No decision
 * can be made by a candidate or provider port; those have no CoreSession. */
export class NativeActionCoordinator{
 constructor(readonly store:LedgerStore,readonly clock:()=>number=Date.now){}
 #now(){const n=this.clock();check(Number.isSafeInteger(n)&&n>=0,'CLOCK');return n;}
 #row(tx:LedgerReader,p:string,id:string,kind:string){const row=tx.getRecord(p,id);check(row?.kind===kind,'RECORD');return row;}
 #update(tx:LedgerTransaction,row:StoredLedgerRecord,value:object){tx.updateRecord({...row,revision:row.revision+1n,data:JSON.stringify(value)},row.revision);}
 #audit(tx:LedgerTransaction,p:string,kind:string,id:string){tx.appendAudit({principalId:p,commandId:null,kind,entityId:id,createdAt:new Date(this.#now()).toISOString()});tx.setMeta(`feed:${p}`,randomUUID());}
 #authority(tx:LedgerReader,p:string,actor:string,a:NativeAttempt){
  const b=JSON.parse(a.binding),member=tx.getMembership(p,actor);check(member?.role==='owner'&&actor===a.actorId&&String(member.generation)===b.authority.membership,'AUTHORITY');
  const scopes:{id:string;epoch:string}[]=[];let s=tx.getScope(a.scopeId);check(s?.principalId===p&&s.kind==='mission','SCOPE');
  while(s){check(s.state==='active'&&scopes.length<128&&!scopes.some(v=>v.id===s!.id)&&(s.principalId===p||s.kind==='application'),'SCOPE');scopes.push({id:s.id,epoch:String(s.epoch)});if(s.parentId===null)break;s=tx.getScope(s.parentId);check(s,'SCOPE');}
  check(s.kind==='application'&&canonicalize(scopes)===canonicalize(b.authority.scopes),'AUTHORITY');
  const mission=this.#row(tx,p,a.scopeId,'mission');check(JSON.parse(mission.data).contractRef===b.contractVersion,'CONTRACT');
  return b;
 }
 createInTransaction(tx:LedgerTransaction,p:string,actor:string,attemptId:string,id:string,cashId:string,quotaId:string):string{
  this.store.assertTransaction(tx);const a=tx.native.getAttempt(p,attemptId);check(a&&a.state==='prepared'&&a.cancellation==='not_requested','ATTEMPT');const b=this.#authority(tx,p,actor,a);
  check(b.actionApprovalId===id&&a.ownerId===this.store.ownerId&&a.ownerEpoch===String(this.store.ownerEpoch),'BINDING');
  const cash=this.#row(tx,p,cashId,'cost_obligation'),quota=this.#row(tx,p,quotaId,'resource_hold'),h=JSON.parse(cash.data),q=JSON.parse(quota.data);
  check(h.format==='native_cash_hold_v1'&&h.attemptId===attemptId&&h.quoteId===b.cashQuoteId&&h.state==='reserved','CASH');
  check(q.format==='resource_hold_v1'&&q.effectKind==='attempt'&&q.effectId===attemptId&&q.scopeId===a.scopeId&&q.state==='reserved'&&q.profileDigest===b.resourceProfileDigest,'QUOTA');
  const simulated=b.mode==='synthetic',explanation:ApprovalView['explanation']={
   change:`${simulated?'合成試験：':''}Codexへ選択済みの入力を1回送信し、返答を保存`,destination:'Codex',account:b.accountRoute,route:`${simulated?'合成':'実'}native / ${b.model} / ${b.effort}`,
   maximumYen:h.reservedYen,month:h.month,estimateDifference:simulated?'この承認は合成試験専用。実送信・実支出はありません':'税込JPYの拘束上限。購読枠と金額予算は別に確認',alternatives:['待つ','依頼を修正する','今回は終了する'],
   expectedBenefit:'同じ契約と入力に対する返答を取得。成果の採択は別途判断',failureHandling:'結果不明では再送せず照合。未確定の金額・利用枠を保持',
   disclosure:`送信対象の原文（${Buffer.byteLength(b.input,'utf8')} bytes）:\n${b.input}`,retention:simulated?'合成試験の台帳へ保存。実サービスの保持を証明しません':'用途別資格の保持条件に従い、返答を共通台帳へ保存',
   recovery:'取消要求と停止確認を区別。未確認の結果は照合を継続',risk:simulated?'ローカル合成試験':'外部送信',dataClassification:'許可された入力manifestの同一原文',additionalDisclosure:'この承認で候補コードの実行・採択・配備は許可しない'
  };
  const witness:Witness={format:'native_action_witness_v1',approvalId:id,attemptId,actorId:actor,scopeId:a.scopeId,binding:a.binding,ownerId:a.ownerId,ownerEpoch:a.ownerEpoch,cashId,cashVersion:cash.versionId,quotaId,quotaVersion:quota.versionId,explanation};
  return this.#save(tx,p,a,witness);
 }
 createSubscriptionInTransaction(tx:LedgerTransaction,p:string,actor:string,attemptId:string,id:string,holdId:string):string{
  this.store.assertTransaction(tx);const a=tx.native.getAttempt(p,attemptId);check(a&&a.state==='prepared'&&a.cancellation==='not_requested','ATTEMPT');const b=this.#authority(tx,p,actor,a);
  check(b.actionApprovalId===id&&a.ownerId===this.store.ownerId&&a.ownerEpoch===String(this.store.ownerEpoch)&&b.cashQuoteId===undefined&&b.resourceProfileDigest===undefined,'BINDING');
  const quota=this.#row(tx,p,holdId,'resource_hold'),q=JSON.parse(quota.data);check(q.format==='native_subscription_hold_v1'&&q.attemptId===attemptId&&q.entitlementId===b.subscriptionEntitlementId&&q.state==='reserved'&&q.cashMode==='none'&&q.maxTurns===1,'SUBSCRIPTION');
  const policyId=tx.getMeta(`policy:${p}`);check(policyId,'POLICY');const policy=this.#row(tx,p,policyId,'policy'),policyValue=JSON.parse(policy.data) as {cash?:{format?:string}},simulated=b.mode==='synthetic';
  check(policyValue.cash===undefined||policyValue.cash.format==='usd_budget_policy_v1','POLICY');
  const maximum=policyValue.cash===undefined?{maximumYen:'0'}:{maximum:{format:'money_v1' as const,currency:'USD' as const,units:'0'}};
  const explanation:ApprovalView['explanation']={change:`${simulated?'合成試験：':''}購読経路で選択済みの入力を1回送信し、返答を保存`,destination:'Codex',account:b.accountRoute,route:`${simulated?'合成':'実'}native / ${b.model} / ${b.effort}`,...maximum,month:budgetMonth(new Date(this.#now())),
   estimateDifference:simulated?'合成試験専用。追加請求なしの証拠を模擬しています':'確認済みの追加請求なし購読経路。残枠は不明、無制限利用の許可ではありません',alternatives:['待つ','依頼を修正する','今回は終了する'],expectedBenefit:'同じ契約と入力への返答を取得。成果の採択は別途判断',failureHandling:'途中制限は待機。追加credits・APIへ切り替えず、不明な結果は再送しない',disclosure:`送信対象の原文（${Buffer.byteLength(b.input,'utf8')} bytes）:\n${b.input}`,retention:simulated?'合成試験台帳へ保存。実サービスの保持を証明しません':'用途別資格の保持条件に従い共通台帳へ保存',recovery:'取消要求と停止確認を区別。不明な結果は照合を継続',risk:`購読残枠は不明。1回・最大${q.maxDurationMs}msの処理に限定`,dataClassification:'許可された入力manifestの同一原文',additionalDisclosure:'新規購入・reset credit消費・候補コード実行・採択・配備の許可は含まない'};
  return this.#save(tx,p,a,{format:'native_action_witness_v2',approvalId:id,attemptId,actorId:actor,scopeId:a.scopeId,binding:a.binding,ownerId:a.ownerId,ownerEpoch:a.ownerEpoch,cashId:null,cashVersion:null,quotaId:holdId,quotaVersion:quota.versionId,subscriptionPolicyVersion:policy.versionId,explanation});
 }
 #save(tx:LedgerTransaction,p:string,a:NativeAttempt,witness:Witness):string{
  const id=witness.approvalId,attemptId=a.id,b=JSON.parse(a.binding),explanation=witness.explanation;
  const witnessId=randomUUID();tx.insertRecord({principalId:p,id:witnessId,kind:'evidence',revision:1n,data:JSON.stringify(witness)});
  const row:Approval={format:'native_action_approval_v1',attemptId,witnessVersion:tx.getRecord(p,witnessId)!.versionId,missionId:a.scopeId,actionDigest:digest(witness),explanationRevision:'1',state:'pending',expiresAt:new Date(b.expiresAt).toISOString(),createdAt:new Date(this.#now()).toISOString(),decision:null,explanation};
  tx.insertRecord({principalId:p,id,kind:'approval',revision:1n,data:JSON.stringify(row)});tx.registerApprovalBinding(p,id,row.actionDigest);
  const mission=this.#row(tx,p,a.scopeId,'mission');this.#update(tx,mission,{...JSON.parse(mission.data),phase:'approval'});this.#audit(tx,p,'approval.created',id);return id;
 }
 #witness(tx:LedgerReader,p:string,id:string){const row=this.#row(tx,p,id,'approval'),v=JSON.parse(row.data) as Approval;check(v.format==='native_action_approval_v1','FORMAT');
  const evidence=tx.getRecordVersion(p,v.witnessVersion);check(evidence?.kind==='evidence','WITNESS');const w=JSON.parse(evidence.data) as Witness;
  check(['native_action_witness_v1','native_action_witness_v2'].includes(w.format)&&w.approvalId===id&&w.attemptId===v.attemptId&&w.scopeId===v.missionId&&digest(w)===v.actionDigest&&canonicalize(w.explanation)===canonicalize(v.explanation)&&v.explanationRevision==='1','WITNESS_CHANGED');
  const a=tx.native.getAttempt(p,w.attemptId);check(a&&a.binding===w.binding&&JSON.parse(a.binding).actionApprovalId===id&&a.actorId===w.actorId&&a.scopeId===w.scopeId&&a.ownerId===w.ownerId&&a.ownerEpoch===w.ownerEpoch,'ATTEMPT_CHANGED');
  check(v.expiresAt===new Date(JSON.parse(a.binding).expiresAt).toISOString(),'EXPIRY_CHANGED');return {row,v,w,a};
 }
 #current(tx:LedgerReader,p:string,id:string){const found=this.#witness(tx,p,id),{v,w,a}=found,b=this.#authority(tx,p,w.actorId,a),now=this.#now();
  check(a.ownerId===this.store.ownerId&&a.ownerEpoch===String(this.store.ownerEpoch),'OWNER');check(now>=b.createdAt&&now<b.expiresAt,'EXPIRED');
  const cash=w.cashId===null?null:this.#row(tx,p,w.cashId,'cost_obligation'),quota=this.#row(tx,p,w.quotaId,'resource_hold');
  check((cash?.versionId??null)===w.cashVersion&&quota.versionId===w.quotaVersion,'HOLD_CHANGED');const h=cash?JSON.parse(cash.data):null,q=JSON.parse(quota.data);
  check(q.state==='reserved'&&(h===null||h.state==='reserved'),'SEND_MAY_HAVE_OCCURRED');
  if(h===null)check(w.format==='native_action_witness_v2'&&q.format==='native_subscription_hold_v1'&&q.cashMode==='none'&&q.entitlementId===b.subscriptionEntitlementId&&now<q.expiresAt,'SUBSCRIPTION');
  else check(w.format==='native_action_witness_v1','WITNESS_MODE');
  const policyId=tx.getMeta(`policy:${p}`),policy=policyId?tx.getRecord(p,policyId):undefined;check(policy?.kind==='policy'&&policy.versionId===(h?.policyVersion??w.subscriptionPolicyVersion),'POLICY_CHANGED');
  check(a.cancellation==='not_requested'&&a.state==='prepared','ATTEMPT_STATE');return found;
 }
 decideInTransaction(tx:LedgerTransaction,p:string,actor:string,id:string,revision:bigint,payload:{action_digest:string;explanation_revision:string;choice:'approve'|'deny';comment:string|null}):void{
  this.store.assertTransaction(tx);const {row,v,w}=this.#witness(tx,p,id);check(row.revision===revision&&v.state==='pending','REVISION');check(v.actionDigest===payload.action_digest&&v.explanationRevision===payload.explanation_revision,'DECISION_BINDING');
  const member=tx.getMembership(p,actor);check(member?.role==='owner','DECIDER');
  if(payload.choice==='approve')this.#current(tx,p,id);else check(payload.choice==='deny','CHOICE');
  this.#update(tx,row,{...v,state:payload.choice==='approve'?'approved':'denied',decision:{actorId:actor,membershipGeneration:String(member.generation),comment:payload.comment,decidedAt:new Date(this.#now()).toISOString()}});
  if(payload.choice==='deny')this.#discard(tx,p,w);this.#audit(tx,p,'approval.changed',id);
 }
 authorizeInTransaction(tx:LedgerTransaction,p:string,attemptId:string,id:string,cashId:string|null,quotaId:string):string{
  this.store.assertTransaction(tx);const {v,w}=this.#current(tx,p,id);check(w.attemptId===attemptId&&w.cashId===cashId&&w.quotaId===quotaId&&v.state==='approved','NOT_APPROVED');
  const member=v.decision&&tx.getMembership(p,v.decision.actorId);check(member?.role==='owner'&&String(member.generation)===v.decision?.membershipGeneration,'DECIDER_CHANGED');return id;
 }
 markSentInTransaction(tx:LedgerTransaction,p:string,attemptId:string,id:string):void{
  this.store.assertTransaction(tx);const {a,w,v}=this.#witness(tx,p,id);check(a.id===attemptId&&a.state==='send_intent'&&v.state==='approved','SEND_STATE');
  const mission=this.#row(tx,p,w.scopeId,'mission');this.#update(tx,mission,{...JSON.parse(mission.data),phase:'execution'});this.#audit(tx,p,'native_action.send_acquired',id);
 }
 #discard(tx:LedgerTransaction,p:string,w:Witness){
  const a=tx.native.getAttempt(p,w.attemptId);check(a,'ATTEMPT');
  if(a.state==='prepared')tx.native.updateAttempt({...a,revision:a.revision+1n,state:'discarded',cancellation:'requested'},a.revision);
  if(!['prepared','discarded'].includes(a.state))return; // No local release after a possible send.
  const cash=w.cashId===null?null:this.#row(tx,p,w.cashId,'cost_obligation'),quota=this.#row(tx,p,w.quotaId,'resource_hold'),h=cash?JSON.parse(cash.data):null,q=JSON.parse(quota.data);
  if(h===null){
   check(w.format==='native_action_witness_v2'&&q.format==='native_subscription_hold_v1'&&q.attemptId===w.attemptId,'SUBSCRIPTION');
   if(q.state==='reserved'){const evidenceId=randomUUID();tx.insertRecord({principalId:p,id:evidenceId,kind:'evidence',revision:1n,data:JSON.stringify({format:'native_subscription_unsent_v1',attemptId:a.id,approvalId:w.approvalId,holdVersion:quota.versionId,observedAt:this.#now()})});this.#update(tx,quota,{...q,state:'unsent',evidenceVersion:tx.getRecord(p,evidenceId)!.versionId});}
  }else if(cash&&h.state==='reserved'&&q.state==='reserved'){
   check(h.attemptId===w.attemptId&&q.effectId===w.attemptId,'HOLD_BINDING');const evidenceId=randomUUID();tx.insertRecord({principalId:p,id:evidenceId,kind:'evidence',revision:1n,data:JSON.stringify({format:'native_action_unsent_v1',attemptId:a.id,approvalId:w.approvalId,cashVersion:cash.versionId,quotaVersion:quota.versionId,observedAt:this.#now()})});
   this.#update(tx,cash,{...h,state:'unsent',heldYen:'0',settled:true,evidenceVersionId:tx.getRecord(p,evidenceId)!.versionId});this.#update(tx,quota,{...q,state:'unconsumed',evidenceId});
  }
  const mission=this.#row(tx,p,w.scopeId,'mission'),m=JSON.parse(mission.data);if(m.phase==='approval')this.#update(tx,mission,{...m,phase:'intake'});
 }
 maintainInTransaction(tx:LedgerTransaction,p:string):void{
  this.store.assertTransaction(tx);for(const row of tx.listRecord(p,'approval')){
   const v=JSON.parse(row.data);if(v.format!=='native_action_approval_v1'||!['pending','approved'].includes(v.state))continue;
   const {w,a}=this.#witness(tx,p,row.id);if(!['prepared','discarded'].includes(a.state))continue;
   let invalid=a.state==='discarded';if(!invalid)try{this.#current(tx,p,row.id);}catch(cause){if(cause instanceof NativeActionDenied)invalid=true;else throw cause;}
   if(invalid){this.#update(tx,row,{...v,state:this.#now()>=Date.parse(v.expiresAt)?'expired':'superseded'});this.#discard(tx,p,w);this.#audit(tx,p,'approval.invalidated',row.id);}
  }
 }
}
