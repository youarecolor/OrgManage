import {createHash,randomUUID} from 'node:crypto';
import canonicalize from 'canonicalize';
import type {LedgerStore,LedgerRecord} from '../../ledger/src/index.js';
import {DisclosureCoordinator,type DisclosureDestination} from './disclosure.js';
import {ApiTrialBudget,usdUnits} from './api-trial-budget.js';
import {budgetMonth,yen} from './budget.js';
import {parseMoney,moneyUnits} from './money.js';
import {prepareOpenRouterRequest,type OpenRouterPolicy} from './openrouter-policy.js';
import type {ApprovalData,IntentData} from './model.js';
import type {OpenRouterResponseExpectation} from './openrouter-response.js';
import {KnowledgeCoordinator} from './knowledge.js';
import type {RoutingCoordinator} from './routing-ledger.js';
import {checkOpenRouterRoutingPool} from './openrouter-routing-pool.js';
import {confirmOpenRouterContinuation} from './openrouter-continuation.js';
const hash=(v:unknown)=>createHash('sha256').update(canonicalize(v)!).digest('hex');
function check(ok:unknown,why:string):asserts ok{if(!ok)throw Error(`OPENROUTER_PREPARATION_${why}`);}
export interface OpenRouterPreparationInput {
 routingProposalId?:string;
 routingPoolId?:string;
 continuationIntentId?:string;
 knowledgeUses?:readonly {useId:string;worker:string}[];
 mode:'synthetic'|'provider';missionId:string;contractVersion:string;manifestId:string;
 destination:DisclosureDestination;input:string;policy:OpenRouterPolicy;expected:OpenRouterResponseExpectation;
 maximumUsd:string;maximumYen?:string;priceEvidenceVersion:string;expiresAt:number;
}
/** Creates pending normal-Core ActionApproval, never its decision. Production
 * preparation remains closed until a real price/runtime qualification importer
 * is connected; synthetic evidence cannot opt into provider mode. */
export class OpenRouterPreparation {
 constructor(readonly store:LedgerStore,readonly clock:()=>number=Date.now,readonly routing?:RoutingCoordinator){}
 prepare(p:string,actor:string,input:OpenRouterPreparationInput){
  const q=structuredClone(input);check(q.mode==='synthetic','PROVIDER_QUALIFICATION_UNAVAILABLE');
  check(!(q.routingPoolId&&q.routingProposalId),'ROUTING_AMBIGUOUS');
  check(q.policy.mode!=='auto'||q.routingPoolId,'ROUTING_POOL_REQUIRED');
  check(q.destination.provider==='openrouter','DESTINATION');check(usdUnits(q.maximumUsd)>0n,'USD');
  const request=prepareOpenRouterRequest(q.policy,q.input),requestDigest=createHash('sha256').update(JSON.stringify(request.body)).digest('hex');
  check(q.expected.models.length>0&&q.expected.models.every(m=>q.policy.models.includes(m))&&q.expected.providerNames.length>0&&q.expected.providerNames.every(n=>typeof n==='string'&&n.length>0&&n.length<=128),'EXPECTATION');
  check(hash([...q.destination.models].sort())===hash([...q.policy.models].sort())&&hash([...q.destination.endpoints].sort())===hash([...q.policy.providers].sort()),'DESTINATION');
  return this.store.transaction(tx=>{
   const now=this.clock();check(Number.isSafeInteger(now)&&Number.isSafeInteger(q.expiresAt)&&q.expiresAt>now&&q.expiresAt-now<=600000,'EXPIRY');
   const member=tx.getMembership(p,actor);check(member?.role==='owner','ACTOR');
   const policyRef=tx.getMeta(`policy:${p}`),policy=policyRef?tx.getRecord(p,policyRef):undefined;check(policy?.kind==='policy','POLICY');
   const pv=JSON.parse(policy.data),cash=pv.cash!==undefined;
   if(cash){check(pv.cash.format==='usd_budget_policy_v1'&&q.maximumYen===undefined,'CURRENCY');}
   else{check(typeof q.maximumYen==='string','CURRENCY');yen(q.maximumYen);}
   const policyDigest=hash({mode:pv.mode,externalAllowed:pv.externalAllowed,normalLimitYen:pv.normalLimitYen,autonomousELimitYen:pv.autonomousELimitYen,...(cash?{cash:pv.cash}:{})});
   const mission=tx.getRecord(p,q.missionId);check(mission?.kind==='mission'&&JSON.parse(mission.data).contractRef===q.contractVersion,'CONTRACT');
   check(tx.getRecordVersion(p,q.priceEvidenceVersion)?.kind==='evidence','PRICE_EVIDENCE');
   check(!tx.listRecord(p,'intent').some(r=>{const v=JSON.parse(r.data);return v.missionId===q.missionId&&['prepared','send_intent','unknown'].includes(v.state);}),'UNRESOLVED');
   const scopes:{id:string;epoch:string}[]=[];let scope=tx.getScope(q.missionId);
   while(scope){check(scope.state==='active'&&scopes.length<128&&!scopes.some(s=>s.id===scope!.id),'SCOPE');scopes.push({id:scope.id,epoch:String(scope.epoch)});if(scope.parentId===null)break;scope=tx.getScope(scope.parentId);check(scope,'SCOPE');}
   check(scope?.kind==='application','SCOPE');
   const disclosure=new DisclosureCoordinator(this.store,this.clock).authorizeInTransaction(tx,p,actor,q.manifestId,q.missionId,q.contractVersion,q.destination,q.input);
   const uses=q.knowledgeUses??[];check(Array.isArray(uses)&&uses.length<=16&&new Set(uses.map(u=>u.useId)).size===uses.length,'KNOWLEDGE_USES');
   const knowledgeUses=uses.map(u=>{
    const resolved=new KnowledgeCoordinator(this.store,this.clock).confirmUseInTransaction(tx,p,actor,u.useId,q.missionId,u.worker);
    check(q.input.includes(resolved.text),'KNOWLEDGE_NOT_IN_DISCLOSURE');
    return {...u,knowledgeVersion:resolved.knowledgeVersion};
   });
   const selection=q.routingProposalId?this.routing?.confirmInTransaction(tx,p,actor,q.routingProposalId,q.missionId,q.contractVersion):undefined;
   check(!q.routingProposalId||selection,'ROUTING_COORDINATOR_REQUIRED');
   if(cash&&selection)check(selection.maximum?.currency==='USD'&&usdUnits(q.maximumUsd)>=moneyUnits(selection.maximum),'ROUTING_PRICE_BOUND');
   if(selection){const c=selection.configuration;check(q.policy.mode==='fixed'&&c.model===request.body.model&&c.runtime==='standard'&&c.billingRoute==='openrouter'&&c.tools.length===0&&c.effort==='provider-default','ROUTING_ADAPTER_MISMATCH');check(uses.every(u=>u.worker===c.persona),'ROUTING_WORKER_MISMATCH');}
   const pool=q.routingPoolId?this.routing?.confirmPoolInTransaction(tx,p,actor,q.routingPoolId,q.missionId,q.contractVersion):undefined;
   check(!q.routingPoolId||pool,'ROUTING_COORDINATOR_REQUIRED');
   if(pool){const c=checkOpenRouterRoutingPool(pool,q.policy,cash?parseMoney('USD',q.maximumUsd):q.maximumYen!);check(uses.every(u=>u.worker===c.persona),'ROUTING_WORKER_MISMATCH');}
   check(!q.continuationIntentId||(q.policy.mode==='fixed'&&selection),'CONTINUATION_ROUTE_REQUIRED');
   const continuation=q.continuationIntentId?confirmOpenRouterContinuation(tx,p,actor,q.continuationIntentId,q.missionId,q.destination.accountRoute,request.body.model!):undefined;
   const intentId=randomUUID(),approvalId=randomUUID(),obligationId=randomUUID(),runId=randomUUID(),attemptId=randomUUID(),witnessId=randomUUID(),month=budgetMonth(new Date(now));
   const insert=(id:string,kind:LedgerRecord['kind'],value:unknown)=>tx.insertRecord({principalId:p,id,kind,revision:1n,data:JSON.stringify(value)});
   insert(runId,'run',{scopeKind:'mission',missionId:q.missionId,conversationId:null,purpose:'production',mode:'standard_api',model:request.body.model});
   insert(attemptId,'attempt',{runId,ordinal:'1',state:'prepared',model:request.body.model,route:'openrouter'});
   const intent:IntentData={missionId:q.missionId,attemptId,approvalId,actionDigest:'pending',policyRef:policy.id,state:'prepared',cancellation:'not_requested',ownerId:this.store.ownerId,ownerEpoch:String(this.store.ownerEpoch),actorId:actor,membershipGeneration:String(member.generation),policyDigest,scopeEpochs:scopes,expiresAt:new Date(q.expiresAt).toISOString(),obligationId,reconciliationId:null};
   const base={...intent,format:'openrouter_intent_v1',route:'openrouter',executionMode:q.mode,accountRoute:q.destination.accountRoute,requestDigest};
   insert(intentId,'intent',base);insert(obligationId,'cost_obligation',cash?{format:'cash_obligation_v1',intentId,month,purpose:'production',pool:'normal',policyVersion:policy.versionId,reserved:parseMoney('USD',q.maximumUsd),held:parseMoney('USD',q.maximumUsd),booked:parseMoney('USD','0'),settled:false}:{intentId,month,purpose:'production',pool:'normal',reservedYen:q.maximumYen,heldYen:q.maximumYen,bookedYen:'0',settled:false});
   const trialHoldId=new ApiTrialBudget(this.store,this.clock).reserveInTransaction(tx,p,actor,q.destination.accountRoute,intentId,obligationId,q.maximumUsd);
   const explanation:ApprovalData['explanation']={change:'合成試験：標準Executorで返答を取得',destination:'OpenRouter（合成通信）',account:q.destination.accountRoute,route:`standard API / ${request.body.model}`,...(cash?{maximum:parseMoney('USD',q.maximumUsd)}:{maximumYen:q.maximumYen!}),month,estimateDifference:`合成拘束 ${q.maximumUsd} USD。実送信・課金の許可ではありません`,alternatives:['待つ','依頼を修正','終了'],expectedBenefit:'標準経路の接続確認',failureHandling:'不明時は再送せず照合',disclosure:q.input,retention:'合成台帳に保存',recovery:'未確認の応答と費用を保持',risk:'合成試験',dataClassification:'固定の合成入力',additionalDisclosure:'候補コード実行・採択・配備は別'};
   if(pool){explanation.route=`standard API / OpenRouter Auto / 候補: ${q.policy.models.join(', ')}`;explanation.risk='合成試験：候補内の実モデルは応答時に判明。候補追加はこの承認の対象外';}
   const w={format:'openrouter_action_witness_v1',intentId,actorId:actor,missionId:q.missionId,requestDigest,accountRoute:q.destination.accountRoute,approvalId,obligationId,trialHoldId,createdAt:now,expiresAt:q.expiresAt,membershipGeneration:String(member.generation),policyVersion:policy.versionId,obligationVersion:tx.getRecord(p,obligationId)!.versionId,trialHoldVersion:tx.getRecord(p,trialHoldId)!.versionId,manifestId:q.manifestId,contractVersion:q.contractVersion,destination:q.destination,input:q.input,requestPolicy:q.policy,responseExpectation:q.expected,priceEvidenceVersion:q.priceEvidenceVersion,explanation};
   const sealedWitness={...w,disclosure,knowledgeUses,...(selection?{routing:{proposalId:q.routingProposalId,...selection}}:{}),...(pool?{routingPool:{poolId:q.routingPoolId,...pool}}:{}),...(continuation?{continuation}:{})};
   insert(witnessId,'evidence',sealedWitness);const actionDigest=hash(sealedWitness);
   insert(approvalId,'approval',{missionId:q.missionId,intentId,actionDigest,explanationRevision:'1',state:'pending',expiresAt:intent.expiresAt,createdAt:new Date(now).toISOString(),requestKey:requestDigest,policyRef:policy.id,policyDigest,explanation,decision:null} satisfies ApprovalData);
   const ir=tx.getRecord(p,intentId)!;tx.updateRecord({...ir,revision:ir.revision+1n,data:JSON.stringify({...base,actionDigest,trialHoldId,witnessVersion:tx.getRecord(p,witnessId)!.versionId})},ir.revision);
   tx.registerApprovalBinding(p,approvalId,actionDigest);tx.bindIntentApproval(p,intentId,approvalId,actionDigest);
   tx.updateRecord({...mission,revision:mission.revision+1n,data:JSON.stringify({...JSON.parse(mission.data),phase:'approval'})},mission.revision);
   tx.appendAudit({principalId:p,commandId:null,kind:'openrouter.prepared',entityId:intentId,createdAt:new Date(now).toISOString()});tx.setMeta(`feed:${p}`,randomUUID());
   return {intentId,approvalId,requestDigest};
  });
 }
}
