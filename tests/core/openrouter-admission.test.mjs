import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import canonicalize from 'canonicalize';
import {fixture,post,randomUUID,update,saved,LedgerStore,snap,request,bytes,committed} from './fixtures/helpers.mjs';
import {OpenRouterPreparation} from '../../dist/core/src/openrouter-preparation.js';
import {OpenRouterTextExecutor} from '../../dist/host/src/openrouter-executor.js';
import {OpenRouterJournal} from '../../dist/core/src/openrouter-journal.js';
import {OpenRouterObservation} from '../../dist/core/src/openrouter-observation.js';
import {OpenRouterSettlement} from '../../dist/core/src/openrouter-settlement.js';
import {OpenRouterRecovery} from '../../dist/core/src/openrouter-recovery.js';
import {recoverOpenRouterGeneration} from '../../dist/host/src/openrouter-generation.js';
import {DisclosureCoordinator} from '../../dist/core/src/disclosure.js';
import {ApiTrialBudget} from '../../dist/core/src/api-trial-budget.js';
import {OpenRouterAdmission} from '../../dist/core/src/openrouter-admission.js';
import {prepareOpenRouterRequest} from '../../dist/core/src/openrouter-policy.js';
import {RoutingCoordinator} from '../../dist/core/src/routing-ledger.js';
import {sealConfiguration} from '../../dist/core/src/routing.js';
import {checkOpenRouterRoutingPool} from '../../dist/core/src/openrouter-routing-pool.js';
import {confirmOpenRouterContinuation} from '../../dist/core/src/openrouter-continuation.js';
import {parseMoney} from '../../dist/core/src/money.js';
async function setup(t,corePreparation=false,withKnowledge=false,withRouting=false,usd=false){
 const f=await fixture(t),mission=post(f).mission,clock=()=>f.now.getTime();
 if(usd){const p=snap(f).budgetPolicy;committed(f.core.command(f.session,bytes(request('budget.configure',p.id,p.revision,{currency:'USD',normal_limit:'8',reserve_limit:'16',autonomous_e_limit:'2'}))));}
 const contract=randomUUID();f.store.transaction(tx=>tx.insertRecord({principalId:f.principal,id:contract,kind:'contract',revision:1n,data:JSON.stringify({mode:'standard_api',scopeId:mission.id,synthetic:true})}));
 mission.contractRef=saved(f,contract).row.versionId;
 update(f,mission.id,v=>({...v,contractRef:mission.contractRef}));
 const d=new DisclosureCoordinator(f.store,clock),budget=new ApiTrialBudget(f.store,clock);
 const policy={mode:'fixed',models:['meta-llama/llama-4-scout'],providers:['example'],maxPromptUsdPerMillion:1,maxCompletionUsdPerMillion:2,maxOutputTokens:128,maxInputBytes:4096};
 if(withRouting==='auto'){policy.mode='auto';policy.models.push('meta-llama/llama-4-maverick');}
 const destination={provider:'openrouter',accountRoute:'synthetic-account',profileDigest:'a'.repeat(64),models:policy.models,endpoints:policy.providers};
 const source=d.registerSource(f.principal,f.actor,mission.id,'Synthetic source','original');
 const grant=d.grant(f.principal,f.actor,source,destination,clock()+10000);
 const manifest=d.createManifest(f.principal,f.actor,mission.id,mission.contractRef,destination,[{sourceId:source,grantId:grant}]);
 const evidence=randomUUID();f.store.transaction(tx=>tx.insertRecord({principalId:f.principal,id:evidence,kind:'evidence',revision:1n,data:'{"synthetic":true}'}));
 budget.configure(f.principal,f.actor,destination.accountRoute,'10',saved(f,evidence).row.versionId);
 let knowledgeUses,knowledge,revokeKnowledge;
 if(withKnowledge){
  const k=f.core.knowledge,origin=post(f,'知見の生成元・合成案件').mission,scope=snap(f).conversation.id;
  const criteria=['reproduction','prohibited_changes','holdout:1','holdout:2','holdout:3','nonregression:1','nonregression:2','nonregression:3'];
  const plan=k.preparePlan(f.principal,f.actor,scope,'generator','independent-evaluator',criteria);
  knowledge=k.propose(f.principal,f.actor,plan,origin.id,'developer','original',[saved(f,source).row.versionId]);
  const results=criteria.map(criterion=>{
   const id=randomUUID();f.store.transaction(tx=>tx.insertRecord({principalId:f.principal,id,kind:'evidence',revision:1n,data:JSON.stringify({format:'knowledge_check_v1',synthetic:true,criterion,status:'pass',candidateVersion:tx.getRecord(f.principal,knowledge).versionId,planVersion:tx.getRecord(f.principal,plan).versionId})}));
   return {criterion,status:'pass',evidenceVersion:saved(f,id).row.versionId};
  });
  const evaluation=k.recordEvaluation(f.principal,f.actor,knowledge,'independent-evaluator',results);
  const decide=(choice,ref)=>committed(f.core.command(f.session,bytes(request('knowledge.decide',knowledge,String(saved(f,knowledge).row.revision),{choice,candidate_ref:knowledge,evaluation_ref:ref,scope_ref:scope,comment:'合成試験'}))));
  decide('adopt',evaluation);revokeKnowledge=()=>decide('revoke',null);
  const use=k.use(f.principal,f.actor,knowledge,mission.id,'developer');knowledgeUses=[{useId:use.useId,worker:'developer'}];
 }
 if(corePreparation){
  const input={mode:'synthetic',missionId:mission.id,contractVersion:mission.contractRef,manifestId:manifest,destination,input:'original',policy,expected:{models:policy.models,providerNames:['Example']},maximumUsd:'1',maximumYen:'100',priceEvidenceVersion:saved(f,evidence).row.versionId,expiresAt:clock()+10000};
  if(usd)delete input.maximumYen;
  if(knowledgeUses)input.knowledgeUses=knowledgeUses;
  let router;
  if(withRouting){
   const c={id:'api-test',version:'1',persona:'developer',model:policy.models[0],effort:'provider-default',promptVersion:'1',contextPolicyVersion:'1',tools:[],runtime:'standard',billingRoute:'openrouter',capabilities:['text'],contextCapacity:4000,quality:90,expiresAt:clock()+10000,evidence:{kind:'observed_selected_only',ref:'synthetic'}};
   const profiles=policy.models.map((model,n)=>({...c,id:`api-test-${n}`,model}));
   router=new RoutingCoordinator(f.store,profiles,clock);const digest=sealConfiguration(profiles[0]).digest;
   const pv=f.store.read(tx=>tx.getRecord(f.principal,tx.getMeta(`policy:${f.principal}`)).versionId);
   input.routingProposalId=router.propose(f.principal,f.actor,mission.id,{policyVersion:pv,minimumQuality:80,contextSize:10,requiredCapabilities:['text'],...(usd?{available:parseMoney('USD','8')}:{availableYen:'1000'}),nativeEnabled:false,standardDigest:digest,current:null,reselect:false,observations:profiles.map((profile,n)=>({digest:sealConfiguration(profile).digest,observedAt:clock(),expiresAt:clock()+(n?2000:5000),permitted:true,qualified:true,disclosureAllowed:true,quota:'available',verifiedNoExtraCharge:false,...(usd?{maximum:parseMoney('USD','1'),expectedTotal:parseMoney('USD','0.5')}:{maximumYen:'100',expectedTotalYen:'100'}),expectedCompletionMs:1,includesRework:true,evidenceRef:saved(f,evidence).row.versionId}))}).id;
   if(withRouting==='auto'){input.routingPoolId=router.recordPool(f.principal,f.actor,input.routingProposalId).id;delete input.routingProposalId;}
  }
  const prep=new OpenRouterPreparation(f.store,clock,router),r=prep.prepare(f.principal,f.actor,input),i=saved(f,r.intentId).value;
  return {f,d,grant,id:r.intentId,approval:r.approvalId,obligation:i.obligationId,hold:i.trialHoldId,policy,requestDigest:r.requestDigest,admission:new OpenRouterAdmission(f.store,clock,router),prep,input,knowledge,revokeKnowledge};
 }
 const id=randomUUID(),obligation=randomUUID(),approval=randomUUID(),witness=randomUUID();let hold;
 const requestDigest=createHash('sha256').update(JSON.stringify(prepareOpenRouterRequest(policy,'original').body)).digest('hex');
 f.store.transaction(tx=>{
  const insert=(id,kind,value)=>tx.insertRecord({principalId:f.principal,id,kind,revision:1n,data:JSON.stringify(value)});
  const base={format:'openrouter_intent_v1',route:'openrouter',state:'prepared',cancellation:'not_requested',ownerId:f.store.ownerId,ownerEpoch:String(f.store.ownerEpoch),missionId:mission.id,accountRoute:destination.accountRoute,approvalId:approval,obligationId:obligation,requestDigest};
  insert(id,'intent',base);
  insert(obligation,'cost_obligation',{intentId:id,month:'2026-09',purpose:'production',pool:'normal',reservedYen:'100',heldYen:'100',bookedYen:'0',settled:false});
  hold=budget.reserveInTransaction(tx,f.principal,f.actor,destination.accountRoute,id,obligation,'1');
  const w={format:'openrouter_action_witness_v1',intentId:id,actorId:f.actor,requestDigest,missionId:mission.id,accountRoute:destination.accountRoute,approvalId:approval,obligationId:obligation,trialHoldId:hold,createdAt:clock(),expiresAt:clock()+10000,membershipGeneration:String(tx.getMembership(f.principal,f.actor).generation),policyVersion:tx.getRecord(f.principal,tx.getMeta(`policy:${f.principal}`)).versionId,obligationVersion:tx.getRecord(f.principal,obligation).versionId,trialHoldVersion:tx.getRecord(f.principal,hold).versionId,manifestId:manifest,contractVersion:mission.contractRef,destination,input:'original',requestPolicy:policy,explanation:{synthetic:true}};
  w.responseExpectation={models:policy.models,providerNames:['Example']};
  insert(witness,'evidence',w);
  insert(approval,'approval',{intentId:id,missionId:mission.id,state:'approved',actionDigest:createHash('sha256').update(canonicalize(w)).digest('hex'),explanationRevision:'1',expiresAt:new Date(w.expiresAt).toISOString(),explanation:w.explanation,decision:{actorId:f.actor,membershipGeneration:w.membershipGeneration}});
  const row=tx.getRecord(f.principal,id);tx.updateRecord({...row,revision:row.revision+1n,data:JSON.stringify({...base,trialHoldId:hold,witnessVersion:tx.getRecord(f.principal,witness).versionId})},row.revision);
 });
 return {f,d,grant,id,approval,obligation,hold,policy,requestDigest,admission:new OpenRouterAdmission(f.store,clock)};
}

test('USD API preparation uses common approval, acquires both USD holds and releases unsent via normal stop',async t=>{
 for(const acquire of [false,true]){
  const x=await setup(t,true,false,false,true),{f}=x,a=snap(f).approvals.find(a=>a.id===x.approval);
  assert.equal(a.explanation.maximum.currency,'USD');assert.equal(a.explanation.maximum.units,'1000000000');assert.equal(a.explanation.maximumYen,undefined);
  assert.equal(snap(f).budget.cash.held,'1');assert.equal(snap(f).apiAttempts[0].commonCash.held,'1');
  if(acquire){
   committed(f.core.command(f.session,bytes(request('approval.decide',a.id,a.revision,{action_digest:a.actionDigest,explanation_revision:a.explanationRevision,choice:'approve',comment:null}))));
   x.admission.acquire(f.principal,f.actor,x.id,x.requestDigest);x.admission.confirmAcquired(f.principal,f.actor,x.id,x.requestDigest);
   assert.equal(saved(f,x.id).value.wireClaimed,true);
  }else{
   const m=snap(f).missions.find(m=>m.id===a.missionId);committed(f.core.command(f.session,bytes(request('mission.control',m.id,m.scope.revision,{choice:'pause',comment:null}))));
   assert.equal(snap(f).budget.cash.held,'0');assert.equal(snap(f).apiAttempts[0].financialState,'released');
  }
 }
});

test('USD API directly settles observed cost in both ledgers without FX and preserves exact duplicate identity',async t=>{
 const x=await setup(t,true,false,false,true),{f}=x,a=snap(f).approvals.find(a=>a.id===x.approval);
 committed(f.core.command(f.session,bytes(request('approval.decide',a.id,a.revision,{action_digest:a.actionDigest,explanation_revision:a.explanationRevision,choice:'approve',comment:null}))));
 x.admission.acquire(f.principal,f.actor,x.id,x.requestDigest);x.admission.confirmAcquired(f.principal,f.actor,x.id,x.requestDigest);
 new OpenRouterJournal(f.store).append(f.principal,f.actor,x.id,200,Buffer.from(JSON.stringify({id:'gen-usd',object:'chat.completion',model:x.policy.models[0],provider:'Example',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'synthetic'}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2,cost:11}})),'application/json');
 new OpenRouterObservation(f.store).collect(f.principal,f.actor,x.id);
 const charge={format:'openrouter_charge_v2',mode:'synthetic',intentId:x.id,accountRoute:'synthetic-account',currency:'USD',generationId:'gen-usd',amountUsd:'11',observationVersion:saved(f,saved(f,x.id).value.observationId).row.versionId};
 const insert=patch=>{const id=randomUUID();f.store.transaction(tx=>tx.insertRecord({principalId:f.principal,id,kind:'evidence',revision:1n,data:JSON.stringify({...charge,...patch})}));return saved(f,id).row.versionId;};
 const settlement=new OpenRouterSettlement(f.store),original=saved(f,x.obligation).row.data;
 for(const patch of [{amountUsd:'10'},{accountRoute:'other'},{generationId:'gen-other'},{observationVersion:randomUUID()},{currency:'JPY'},{mode:'provider'}]){
  assert.throws(()=>settlement.settle(f.principal,f.actor,x.id,insert(patch)));assert.equal(saved(f,x.obligation).row.data,original);
 }
 const version=insert({});assert.equal(settlement.settle(f.principal,f.actor,x.id,version),'recorded');
 assert.equal(saved(f,x.obligation).value.booked.units,'11000000000');assert.equal(saved(f,x.hold).value.bookedUnits,'11000000000');
 assert.equal(snap(f).apiAttempts[0].commonCash.booked,'11');assert.equal(snap(f).apiAttempts[0].financialState,'settled');
 assert.equal(snap(f).budget.cash.booked,'11');assert.equal(snap(f).budget.cash.actualExternalCost,'0');
 await f.store.close();f.store=await LedgerStore.open(f.path);
 assert.equal(new OpenRouterSettlement(f.store).settle(f.principal,f.actor,x.id,version),'duplicate');
});

test('USD Auto pool binds all model prices to the approval and rechecks expiry at wire',async t=>{
 for(const expired of [false,true]){
  const x=await setup(t,true,false,'auto',true),{f}=x,a=snap(f).approvals.find(a=>a.id===x.approval);
  assert.equal(a.explanation.maximum.units,'1000000000');assert.ok(a.explanation.route.includes(x.policy.models[1]));
  committed(f.core.command(f.session,bytes(request('approval.decide',a.id,a.revision,{action_digest:a.actionDigest,explanation_revision:a.explanationRevision,choice:'approve',comment:null}))));
  x.admission.acquire(f.principal,f.actor,x.id,x.requestDigest);
  if(expired){f.now=new Date(f.now.getTime()+2500);assert.throws(()=>x.admission.confirmAcquired(f.principal,f.actor,x.id,x.requestDigest),/POOL_EXPIRED/);assert.equal(saved(f,x.id).value.wireClaimed,false);assert.equal(snap(f).budget.cash.held,'1');}
  else{x.admission.confirmAcquired(f.principal,f.actor,x.id,x.requestDigest);assert.equal(saved(f,x.id).value.wireClaimed,true);}
 }
});
test('USD selected route preserves its price bound in common approval and wire validation',async t=>{
 const x=await setup(t,true,false,true,true),{f}=x,a=snap(f).approvals.find(v=>v.id===x.approval);
 committed(f.core.command(f.session,bytes(request('approval.decide',a.id,a.revision,{action_digest:a.actionDigest,explanation_revision:a.explanationRevision,choice:'approve',comment:null}))));
 x.admission.acquire(f.principal,f.actor,x.id,x.requestDigest);x.admission.confirmAcquired(f.principal,f.actor,x.id,x.requestDigest);
 assert.equal(saved(f,x.id).value.wireClaimed,true);
});
test('disclosure, approval and USD acquisition commit with one send marker and reject replay',async t=>{
 const x=await setup(t);assert.equal(x.admission.acquire(x.f.principal,x.f.actor,x.id,x.requestDigest),x.id);
 assert.equal(saved(x.f,x.id).value.state,'send_intent');assert.equal(saved(x.f,x.hold).value.state,'acquired');
 assert.throws(()=>x.admission.acquire(x.f.principal,x.f.actor,x.id,x.requestDigest),/STATE/);
});

test('Auto pool is sealed into ordinary approval and rechecked at acquisition and wire claim',async t=>{
 for(const phase of ['valid','acquire-expired','wire-expired']){
  const x=await setup(t,true,false,'auto'),{f}=x;
  const ir=saved(f,x.id).value,w=f.store.read(tx=>JSON.parse(tx.getRecordVersion(f.principal,ir.witnessVersion).data));
  assert.equal(w.routingPool.qualification.members.length,2);
  for(const model of x.policy.models)assert.ok(w.explanation.route.includes(model));
  assert.throws(()=>checkOpenRouterRoutingPool(w.routingPool,{...x.policy,models:[x.policy.models[0]]},'100'),/POOL_MISMATCH/);
  assert.throws(()=>checkOpenRouterRoutingPool(w.routingPool,x.policy,'99'),/POOL_MISMATCH/);
  assert.throws(()=>x.admission.acquire(f.principal,f.actor,x.id,x.requestDigest),/APPROVAL/);
  const a=snap(f).approvals.find(v=>v.id===x.approval);
  committed(f.core.command(f.session,bytes(request('approval.decide',a.id,a.revision,{action_digest:a.actionDigest,explanation_revision:a.explanationRevision,choice:'approve',comment:null}))));
  if(phase==='acquire-expired'){
   f.now=new Date(f.now.getTime()+2500);assert.throws(()=>x.admission.acquire(f.principal,f.actor,x.id,x.requestDigest),/POOL_EXPIRED/);assert.equal(saved(f,x.id).value.state,'prepared');
  }else{
   x.admission.acquire(f.principal,f.actor,x.id,x.requestDigest);
   if(phase==='wire-expired'){f.now=new Date(f.now.getTime()+2500);assert.throws(()=>x.admission.confirmAcquired(f.principal,f.actor,x.id,x.requestDigest),/POOL_EXPIRED/);assert.equal(saved(f,x.id).value.wireClaimed,false);}
   else{x.admission.confirmAcquired(f.principal,f.actor,x.id,x.requestDigest);assert.equal(saved(f,x.id).value.wireClaimed,true);}
  }
 }
});

test('Auto result continues on its fixed model only after settlement and fresh ordinary approval',async t=>{
 const x=await setup(t,true,false,'auto'),{f}=x,clock=()=>f.now.getTime();
 const approve=id=>{const a=snap(f).approvals.find(v=>v.id===id);committed(f.core.command(f.session,bytes(request('approval.decide',a.id,a.revision,{action_digest:a.actionDigest,explanation_revision:a.explanationRevision,choice:'approve',comment:null}))));};
 approve(x.approval);x.admission.acquire(f.principal,f.actor,x.id,x.requestDigest);x.admission.confirmAcquired(f.principal,f.actor,x.id,x.requestDigest);
 const model=x.policy.models[1];
 new OpenRouterJournal(f.store,clock).append(f.principal,f.actor,x.id,200,Buffer.from(JSON.stringify({id:'gen-continuation',object:'chat.completion',model,provider:'Example',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'candidate'}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2,cost:0.001}})),'application/json');
 const obs=new OpenRouterObservation(f.store,clock).collect(f.principal,f.actor,x.id);
 const confirm=(m=model,account=x.input.destination.accountRoute)=>f.store.transaction(tx=>confirmOpenRouterContinuation(tx,f.principal,f.actor,x.id,x.input.missionId,account,m));
 assert.throws(()=>confirm(),/UNRESOLVED/);
 const conversion=randomUUID();f.store.transaction(tx=>tx.insertRecord({principalId:f.principal,id:conversion,kind:'evidence',revision:1n,data:JSON.stringify({format:'openrouter_conversion_v1',mode:'synthetic',intentId:x.id,accountRoute:x.input.destination.accountRoute,generationId:'gen-continuation',sourceCurrency:'USD',targetCurrency:'JPY',taxIncluded:true,rounding:'ceil',amountUsd:'0.001',amountYen:'1',rateNumeratorYen:'1000',rateDenominatorUsd:'1'})}));
 const conversionVersion=saved(f,conversion).row.versionId;
 const charge=randomUUID();f.store.transaction(tx=>tx.insertRecord({principalId:f.principal,id:charge,kind:'evidence',revision:1n,data:JSON.stringify({format:'openrouter_charge_v1',intentId:x.id,accountRoute:x.input.destination.accountRoute,currency:'JPY',taxIncluded:true,generationId:'gen-continuation',amountUsd:'0.001',amountYen:'1',conversionEvidenceVersion:conversionVersion})}));
 new OpenRouterSettlement(f.store,clock).settle(f.principal,f.actor,x.id,saved(f,charge).row.versionId);
 assert.equal(confirm().model,model);assert.throws(()=>confirm(x.policy.models[0]),/MODEL_BINDING/);assert.throws(()=>confirm(model,'other'),/BINDING/);
 const configuration=saved(f,obs).value.selectedConfiguration.configuration,router=new RoutingCoordinator(f.store,[configuration],clock),digest=sealConfiguration(configuration).digest;
 const pv=f.store.read(tx=>tx.getRecord(f.principal,tx.getMeta(`policy:${f.principal}`)).versionId);
 const proposal=router.propose(f.principal,f.actor,x.input.missionId,{policyVersion:pv,minimumQuality:80,contextSize:10,requiredCapabilities:['text'],availableYen:'1000',nativeEnabled:false,standardDigest:digest,current:{digest,policyVersion:pv,valid:true,activeTurn:false},reselect:false,observations:[{digest,observedAt:clock(),expiresAt:clock()+5000,permitted:true,qualified:true,disclosureAllowed:true,quota:'available',verifiedNoExtraCharge:false,maximumYen:'100',expectedTotalYen:'100',expectedCompletionMs:1,includesRework:true,evidenceRef:x.input.priceEvidenceVersion}]});
 const destination={...x.input.destination,models:[model]},source=x.d.registerSource(f.principal,f.actor,x.input.missionId,'Continuation synthetic source','next original'),grant=x.d.grant(f.principal,f.actor,source,destination,clock()+10000);
 const manifest=x.d.createManifest(f.principal,f.actor,x.input.missionId,x.input.contractVersion,destination,[{sourceId:source,grantId:grant}]);
 const q={...x.input,continuationIntentId:x.id,routingProposalId:proposal.id,policy:{...x.policy,mode:'fixed',models:[model]},expected:{models:[model],providerNames:['Example']},destination,manifestId:manifest,input:'next original'};delete q.routingPoolId;
 const next=new OpenRouterPreparation(f.store,clock,router).prepare(f.principal,f.actor,q),admission=new OpenRouterAdmission(f.store,clock,router);
 assert.throws(()=>admission.acquire(f.principal,f.actor,next.intentId,next.requestDigest),/APPROVAL/);approve(next.approvalId);
 admission.acquire(f.principal,f.actor,next.intentId,next.requestDigest);
 update(f,x.id,v=>({...v,cancellation:'requested'}));
 assert.throws(()=>admission.confirmAcquired(f.principal,f.actor,next.intentId,next.requestDigest),/UNRESOLVED/);
 assert.equal(saved(f,next.intentId).value.wireClaimed,false);
});

test('Core preparation creates pending Home approval; ordinary approval command admits the same intent',async t=>{
 const x=await setup(t,true),{f}=x;
 assert.equal(snap(f).pendingCount,1);assert.throws(()=>x.admission.acquire(f.principal,f.actor,x.id,x.requestDigest),/APPROVAL/);
 const a=snap(f).approvals.find(v=>v.id===x.approval);assert.match(a.explanation.change,/合成/);
 committed(f.core.command(f.session,bytes(request('approval.decide',a.id,a.revision,{action_digest:a.actionDigest,explanation_revision:a.explanationRevision,choice:'approve',comment:null}))));
 assert.equal(x.admission.acquire(f.principal,f.actor,x.id,x.requestDigest),x.id);
 assert.equal(saved(f,x.hold).value.state,'acquired');
 assert.throws(()=>x.prep.prepare(f.principal,f.actor,{...x.input,mode:'provider'}),/QUALIFICATION_UNAVAILABLE/);
});

test('normally adopted knowledge is bound to API approval and revocation blocks acquisition or wire claim',async t=>{
 for(const phase of ['valid','acquire','wire']){
  const x=await setup(t,true,true),{f}=x,a=snap(f).approvals.find(v=>v.id===x.approval);
  const witness=saved(f,x.id).value.witnessVersion,w=f.store.read(tx=>JSON.parse(tx.getRecordVersion(f.principal,witness).data));
  assert.equal(w.knowledgeUses[0].knowledgeVersion,saved(f,x.knowledge).row.versionId);
  committed(f.core.command(f.session,bytes(request('approval.decide',a.id,a.revision,{action_digest:a.actionDigest,explanation_revision:a.explanationRevision,choice:'approve',comment:null}))));
  if(phase==='acquire')x.revokeKnowledge();
  if(phase==='acquire')assert.throws(()=>x.admission.acquire(f.principal,f.actor,x.id,x.requestDigest),/NOT_ACTIVE/);
  else{
   x.admission.acquire(f.principal,f.actor,x.id,x.requestDigest);
   if(phase==='wire'){x.revokeKnowledge();assert.throws(()=>x.admission.confirmAcquired(f.principal,f.actor,x.id,x.requestDigest),/NOT_ACTIVE/);}
   else x.admission.confirmAcquired(f.principal,f.actor,x.id,x.requestDigest);
  }
  assert.equal(saved(f,x.hold).value.heldUnits,'1000000000');
  assert.equal(saved(f,x.id).value.wireClaimed===true,phase==='valid');
 }
});

test('selected API route is required again at dispatch and cannot outlive its observation',async t=>{
 for(const phase of ['valid','expired']){
  const x=await setup(t,true,false,true),{f}=x,a=snap(f).approvals.find(v=>v.id===x.approval);
  committed(f.core.command(f.session,bytes(request('approval.decide',a.id,a.revision,{action_digest:a.actionDigest,explanation_revision:a.explanationRevision,choice:'approve',comment:null}))));
  assert.throws(()=>new OpenRouterAdmission(f.store,()=>f.now.getTime()).acquire(f.principal,f.actor,x.id,x.requestDigest),/ROUTING_COORDINATOR_REQUIRED/);
  x.admission.acquire(f.principal,f.actor,x.id,x.requestDigest);
  if(phase==='expired'){f.now=new Date(f.now.getTime()+6000);assert.throws(()=>x.admission.confirmAcquired(f.principal,f.actor,x.id,x.requestDigest),/SELECTION_EXPIRED/);assert.equal(saved(f,x.id).value.wireClaimed,false);}
  else x.admission.confirmAcquired(f.principal,f.actor,x.id,x.requestDigest);
 }
});

test('API source lineage survives grant revocation without granting another send',async t=>{
 const x=await setup(t,true),{f}=x,initial=snap(f).apiAttempts[0].sourceLineage;
 assert.equal(initial.sources.length,1);assert.match(initial.inputDigest,/^[a-f0-9]{64}$/);
 assert.equal(JSON.stringify(initial).includes('original'),false);
 x.d.revokeGrant(f.principal,f.actor,x.grant);
 assert.deepEqual(snap(f).apiAttempts[0].sourceLineage,initial);
 const a=snap(f).approvals.find(v=>v.id===x.approval);
 committed(f.core.command(f.session,bytes(request('approval.decide',a.id,a.revision,{action_digest:a.actionDigest,explanation_revision:a.explanationRevision,choice:'approve',comment:null}))));
 assert.throws(()=>x.admission.acquire(f.principal,f.actor,x.id,x.requestDigest),/GRANT/);
 update(f,x.id,v=>({...v,actionDigest:'a'.repeat(64)}));
 assert.equal(snap(f).apiAttempts[0].sourceLineage,null);
});

test('normal rejection or expiry releases both currencies only while unsent',async t=>{
 for(const reason of ['deny','expire']){
  const x=await setup(t,true),{f}=x;
  if(reason==='deny'){
   const a=snap(f).approvals.find(v=>v.id===x.approval);
   committed(f.core.command(f.session,bytes(request('approval.decide',a.id,a.revision,{action_digest:a.actionDigest,explanation_revision:a.explanationRevision,choice:'deny',comment:null}))));
  }else{f.now=new Date(f.now.getTime()+11000);f.core.maintain();}
  assert.equal(saved(f,x.id).value.state,'discarded');assert.equal(saved(f,x.hold).value.state,'unsent');
  assert.equal(saved(f,x.hold).value.heldUnits,'0');assert.equal(saved(f,x.obligation).value.heldYen,'0');
  const api=snap(f).apiAttempts[0];assert.equal(api.outputState,'unsent');assert.equal(api.financialState,'released');
 }
});

test('ordinary Mission stop discards an unsent API request but only requests cancellation after acquisition',async t=>{
 for(const acquired of [false,true]){
  const x=await setup(t,true),{f}=x;
  if(acquired){const a=snap(f).approvals.find(v=>v.id===x.approval);committed(f.core.command(f.session,bytes(request('approval.decide',a.id,a.revision,{action_digest:a.actionDigest,explanation_revision:a.explanationRevision,choice:'approve',comment:null}))));x.admission.acquire(f.principal,f.actor,x.id,x.requestDigest);}
  const m=snap(f).missions[0];committed(f.core.command(f.session,bytes(request('mission.control',m.id,m.scope.revision,{choice:'pause',comment:null}))));
  const i=saved(f,x.id).value,h=saved(f,x.hold).value;
  assert.equal(i.state,acquired?'send_intent':'discarded');assert.equal(h.heldUnits,acquired?'1000000000':'0');
  const api=snap(f).apiAttempts[0];assert.equal(api.outputState,acquired?'unknown':'unsent');assert.equal(api.financialState,acquired?'unsettled':'released');
  if(acquired){assert.equal(i.cancellation,'requested');assert.throws(()=>x.admission.confirmAcquired(f.principal,f.actor,x.id,x.requestDigest),/STATE/);}
 }
});

test('discarded label alone cannot hide an acquired unknown charge',async t=>{
 const x=await setup(t),{f}=x;x.admission.acquire(f.principal,f.actor,x.id,x.requestDigest);
 update(f,x.id,v=>({...v,state:'discarded',executionMode:'provider'}));
 const home=snap(f),api=home.apiAttempts[0];
 assert.equal(api.outputState,'unknown');assert.equal(api.financialState,'unsettled');
 assert.equal(api.heldUsd,'1');assert.equal(home.budget.actualExternalCostYen,'unknown');
});

test('wire confirmation rechecks grant, cancellation and capacity while preserving acquired holds',async t=>{
 for(const reason of ['grant','cancel','capacity']){
  const x=await setup(t);x.admission.acquire(x.f.principal,x.f.actor,x.id,x.requestDigest);
  if(reason==='grant')x.d.revokeGrant(x.f.principal,x.f.actor,x.grant);
  if(reason==='cancel')update(x.f,x.id,v=>({...v,cancellation:'requested'}));
  if(reason==='capacity')x.f.store.transaction(tx=>tx.insertRecord({principalId:x.f.principal,id:randomUUID(),kind:'cost_obligation',revision:1n,data:JSON.stringify({month:'2026-09',purpose:'production',pool:'normal',bookedYen:'901',heldYen:'0',reservedYen:'901',settled:true})}));
  assert.throws(()=>x.admission.confirmAcquired(x.f.principal,x.f.actor,x.id,x.requestDigest));
  assert.equal(saved(x.f,x.id).value.wireClaimed,false);
  assert.equal(saved(x.f,x.hold).value.state,'acquired');assert.equal(saved(x.f,x.hold).value.heldUnits,'1000000000');
 }
});

test('wire claim persists across coordinator replacement and real ledger reopen',async t=>{
 const x=await setup(t);x.admission.acquire(x.f.principal,x.f.actor,x.id,x.requestDigest);
 x.admission.confirmAcquired(x.f.principal,x.f.actor,x.id,x.requestDigest);
 assert.throws(()=>new OpenRouterAdmission(x.f.store,()=>x.f.now.getTime()).confirmAcquired(x.f.principal,x.f.actor,x.id,x.requestDigest),/STATE/);
 await x.f.store.close();x.f.store=await LedgerStore.open(x.f.path);
 assert.equal(saved(x.f,x.id).value.wireClaimed,true);
 assert.throws(()=>new OpenRouterAdmission(x.f.store).confirmAcquired(x.f.principal,x.f.actor,x.id,x.requestDigest),/STATE/);
});

test('standard executor reaches synthetic HTTP through real admission, budget, disclosure and durable journal',async t=>{
 for(const auto of [false,true]){
 const x=auto?await setup(t,true,false,'auto'):await setup(t),{f}=x,expected={models:x.policy.models,providerNames:['Example']};let sends=0;
 if(auto){const a=snap(f).approvals.find(v=>v.id===x.approval);committed(f.core.command(f.session,bytes(request('approval.decide',a.id,a.revision,{action_digest:a.actionDigest,explanation_revision:a.explanationRevision,choice:'approve',comment:null}))));}
 const actualModel=x.policy.models[auto?1:0];
 const j=new OpenRouterJournal(f.store,()=>f.now.getTime());
 const executor=new OpenRouterTextExecutor({
  acquire:d=>x.admission.acquire(f.principal,f.actor,x.id,d),
  confirmAcquired:(id,d)=>x.admission.confirmAcquired(f.principal,f.actor,id,d),
  withKey:async cb=>cb('synthetic-only-key'),
  journal:(id,status,bytes,mime)=>j.append(f.principal,f.actor,id,status,bytes,mime),
  observe:(id,r)=>{assert.equal(r.outputState,'completed');new OpenRouterObservation(f.store,()=>f.now.getTime()).collect(f.principal,f.actor,id);},progress:()=>{},
 },x.policy,expected,{maxSteps:1,maxInputBytes:8192,maxOutputBytes:8192,deadlineMs:1000,tools:[]},async(url,options)=>{
  sends++;assert.equal(saved(f,x.id).value.wireClaimed,true);assert.equal(saved(f,x.hold).value.state,'acquired');
  const body=JSON.parse(options.body);assert.equal(body.model,auto?'openrouter/auto':actualModel);
  if(auto)assert.deepEqual(body.plugins[0].allowed_models,x.policy.models);
  return new Response(JSON.stringify({id:'gen-integration',object:'chat.completion',model:actualModel,provider:'Example',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'candidate'}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2,cost:0.001}}),{headers:{'content-type':'application/json'}});
 });
 const result=await executor.run('original',new AbortController().signal);assert.equal(result.state,'completed');assert.equal(sends,1);
 assert.equal(j.recover(f.principal,f.actor,x.id,expected).text,'candidate');
 // A text result is not financial settlement or candidate adoption.
 assert.equal(saved(f,x.hold).value.state,'unknown');assert.equal(saved(f,x.id).value.outputState,'completed');
 assert.equal(saved(f,x.obligation).value.heldYen,'100');assert.equal(f.store.read(tx=>tx.listRecord(f.principal,'artifact').length),0);
 const observation=saved(f,x.id).value.observationId;
 assert.equal(new OpenRouterObservation(f.store).collect(f.principal,f.actor,x.id),observation);
 await f.store.close();f.store=await LedgerStore.open(f.path);
 assert.equal(new OpenRouterObservation(f.store).collect(f.principal,f.actor,x.id),observation);
 assert.equal(saved(f,x.hold).value.heldUnits,'1000000000');
 if(auto){const selected=saved(f,observation).value.selectedConfiguration;assert.equal(selected.configuration.model,actualModel);assert.equal(selected.executionAuthorized,false);assert.ok(selected.poolVersion);}
 else assert.equal(saved(f,observation).value.selectedConfiguration,null);
 }
});

test('late response after grant revocation is collected without restoring send authority or releasing costs',async t=>{
 const x=await setup(t),{f}=x;
 x.admission.acquire(f.principal,f.actor,x.id,x.requestDigest);x.admission.confirmAcquired(f.principal,f.actor,x.id,x.requestDigest);
 x.d.revokeGrant(f.principal,f.actor,x.grant);update(f,x.id,v=>({...v,cancellation:'requested'}));
 new OpenRouterJournal(f.store).append(f.principal,f.actor,x.id,500,Buffer.from('private upstream error'),'text/plain');
 const id=new OpenRouterObservation(f.store).collect(f.principal,f.actor,x.id);
 assert.equal(saved(f,x.id).value.state,'unknown');assert.equal(saved(f,x.id).value.cancellation,'requested');
 assert.equal(saved(f,x.hold).value.heldUnits,'1000000000');assert.equal(saved(f,x.obligation).value.heldYen,'100');
 assert.equal(JSON.stringify(saved(f,id).value).includes('private upstream error'),false);
 assert.throws(()=>x.admission.confirmAcquired(f.principal,f.actor,x.id,x.requestDigest),/STATE/);
});

test('observation and intent writes roll back when the linked budget cannot accept observation',async t=>{
 const x=await setup(t),{f}=x;x.admission.acquire(f.principal,f.actor,x.id,x.requestDigest);
 new OpenRouterJournal(f.store).append(f.principal,f.actor,x.id,500,Buffer.from('error'),'text/plain');
 update(f,x.hold,v=>({...v,state:'reserved'}));
 const count=f.store.read(tx=>tx.listRecord(f.principal,'evidence').length);
 assert.throws(()=>new OpenRouterObservation(f.store).collect(f.principal,f.actor,x.id),/HOLD_STATE/);
 assert.equal(f.store.read(tx=>tx.listRecord(f.principal,'evidence').length),count);
 assert.equal(saved(f,x.id).value.state,'send_intent');assert.equal(saved(f,x.id).value.observationId,undefined);
});

async function chargeFixture(t){
 const x=await setup(t),{f}=x;x.admission.acquire(f.principal,f.actor,x.id,x.requestDigest);
 update(f,x.id,v=>({...v,executionMode:'synthetic'}));
 new OpenRouterJournal(f.store).append(f.principal,f.actor,x.id,200,Buffer.from(JSON.stringify({id:'gen-charge',object:'chat.completion',model:x.policy.models[0],provider:'Example',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'candidate'}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2,cost:11}})),'application/json');
 new OpenRouterObservation(f.store).collect(f.principal,f.actor,x.id);
 const conversionValue={format:'openrouter_conversion_v1',mode:'synthetic',intentId:x.id,accountRoute:'synthetic-account',generationId:'gen-charge',sourceCurrency:'USD',targetCurrency:'JPY',taxIncluded:true,rounding:'ceil',amountUsd:'11',amountYen:'1500',rateNumeratorYen:'1500',rateDenominatorUsd:'11'};
 const conversion=randomUUID();f.store.transaction(tx=>tx.insertRecord({principalId:f.principal,id:conversion,kind:'evidence',revision:1n,data:JSON.stringify(conversionValue)}));
 const charge={format:'openrouter_charge_v1',intentId:x.id,accountRoute:'synthetic-account',currency:'JPY',taxIncluded:true,generationId:'gen-charge',amountUsd:'11',amountYen:'1500',conversionEvidenceVersion:saved(f,conversion).row.versionId};
 const insert=(patch={})=>{const id=randomUUID();f.store.transaction(tx=>tx.insertRecord({principalId:f.principal,id,kind:'evidence',revision:1n,data:JSON.stringify({...charge,...patch})}));return saved(f,id).row.versionId;};
 return {...x,insert,conversionValue,settlement:new OpenRouterSettlement(f.store)};
}

test('unrelated conversion evidence, wrong bindings and fabricated arithmetic cannot release either hold',async t=>{
 const x=await chargeFixture(t),{f}=x;
 const bad=[{format:'unrelated_price_document'},{intentId:randomUUID()},{accountRoute:'another'},{generationId:'gen-other'},{mode:'provider'},{taxIncluded:false},{sourceCurrency:'EUR'},{rounding:'floor'},{amountUsd:'10'},{amountYen:'1'},{rateNumeratorYen:'1'},{rateDenominatorUsd:'0'}];
 for(const patch of bad){
  const id=randomUUID();f.store.transaction(tx=>tx.insertRecord({principalId:f.principal,id,kind:'evidence',revision:1n,data:JSON.stringify({...x.conversionValue,...patch})}));
  assert.throws(()=>x.settlement.settle(f.principal,f.actor,x.id,x.insert({conversionEvidenceVersion:saved(f,id).row.versionId})));
  assert.equal(saved(f,x.obligation).value.heldYen,'100');assert.equal(saved(f,x.hold).value.heldUnits,'1000000000');
 }
 assert.equal(f.store.read(tx=>tx.listRecord(f.principal,'cost_event').length),0);
 update(f,x.id,v=>({...v,executionMode:'provider'}));
 assert.throws(()=>x.settlement.settle(f.principal,f.actor,x.id,x.insert()),/CONVERSION_PRODUCER_UNQUALIFIED/);
 assert.equal(saved(f,x.obligation).value.heldYen,'100');
});

test('generation recovery binds stored identity and survives reopen without releasing either hold',async t=>{
 const x=await chargeFixture(t),{f}=x,recovery=new OpenRouterRecovery(f.store),binding=recovery.prepare(f.principal,f.actor,x.id);
 const body=Buffer.from(JSON.stringify({data:{id:'gen-charge',model:x.policy.models[0],provider_name:'Example',is_byok:false,total_cost:11}}));
 assert.throws(()=>recovery.record(f.principal,f.actor,{...binding,accountRoute:'other'},200,body,'application/json'),/BINDING_CHANGED/);
 const lookup=await recoverOpenRouterGeneration(recovery,f.principal,f.actor,x.id,(account,use)=>{assert.equal(account,'synthetic-account');return use('synthetic-key');},async(url,options)=>{assert.match(url,/id=gen-charge$/);assert.equal(options.method,'GET');return new Response(body,{headers:{'content-type':'application/json'}});});
 const id=lookup.evidenceId;assert.equal(lookup.result.status,'observed');assert.ok(id);
 assert.equal(saved(f,id).value.result.status,'observed');assert.equal(saved(f,x.obligation).value.heldYen,'100');assert.equal(saved(f,x.hold).value.heldUnits,'1000000000');
 await f.store.close();f.store=await LedgerStore.open(f.path);
 assert.equal(new OpenRouterRecovery(f.store).record(f.principal,f.actor,binding,200,body,'application/json'),id);
 assert.equal(saved(f,x.id).value.state,'unknown');
 const failed=new OpenRouterRecovery(f.store).record(f.principal,f.actor,binding,404,Buffer.from('not found'),'text/plain');
 assert.equal(saved(f,failed).value.result.status,'unknown');assert.equal(saved(f,x.hold).value.heldUnits,'1000000000');
 const altered=Buffer.from(JSON.stringify({data:{id:'gen-charge',model:x.policy.models[0],provider_name:'Example',is_byok:false,total_cost:12}}));
 new OpenRouterRecovery(f.store).record(f.principal,f.actor,binding,200,altered,'application/json');
 // Reopen Core's session on its new store before projecting the recovered history.
 const {OrgManageCore}=await import('../../dist/core/src/index.js');
 const core=new OrgManageCore(f.store),session=core.openSession(f.actor),home=core.snapshot(session);
 assert.equal(home.status,'ready');const view=home.apiAttempts[0];
 assert.equal(view.recovery.count,3);assert.equal(view.recovery.costConflict,true);assert.equal(view.financialState,'unsettled');
 assert.equal(JSON.stringify(view.recovery).includes('synthetic-account'),false);assert.equal(JSON.stringify(view.recovery).includes('bodyBase64'),false);
 assert.throws(()=>new OpenRouterSettlement(f.store).settle(f.principal,f.actor,x.id,x.insert()),/RECOVERY_CONFLICT/);
 assert.equal(saved(f,x.obligation).value.heldYen,'100');assert.equal(saved(f,x.hold).value.heldUnits,'1000000000');
});

test('actual charge over both reservations is booked atomically, with restart duplicate suppression',async t=>{
 const x=await chargeFixture(t),{f}=x,version=x.insert();
 assert.equal(x.settlement.settle(f.principal,f.actor,x.id,version),'recorded');
 assert.equal(saved(f,x.obligation).value.bookedYen,'1500');assert.equal(saved(f,x.obligation).value.heldYen,'0');
 assert.equal(saved(f,x.hold).value.bookedUnits,'11000000000');assert.equal(saved(f,x.hold).value.heldUnits,'0');assert.equal(saved(f,x.id).value.state,'completed');
 await f.store.close();f.store=await LedgerStore.open(f.path);
 assert.equal(new OpenRouterSettlement(f.store).settle(f.principal,f.actor,x.id,version),'duplicate');
 assert.equal(f.store.read(tx=>tx.listRecord(f.principal,'cost_event').length),1);
});

test('missing tax, foreign charge, unknown conversion or inconsistent USD preserve both holds',async t=>{
 const x=await chargeFixture(t),{f}=x;
 for(const patch of [{taxIncluded:null},{accountRoute:'another'},{generationId:'gen-other'},{conversionEvidenceVersion:randomUUID()},{amountUsd:'0'}]){
  assert.throws(()=>x.settlement.settle(f.principal,f.actor,x.id,x.insert(patch)));
  assert.equal(saved(f,x.obligation).value.heldYen,'100');assert.equal(saved(f,x.hold).value.heldUnits,'1000000000');
 }
 assert.equal(f.store.read(tx=>tx.listRecord(f.principal,'cost_event').length),0);
});

test('USD settlement failure rolls back JPY settlement and cost event',async t=>{
 const x=await chargeFixture(t),{f}=x,version=x.insert();update(f,x.hold,v=>({...v,state:'reserved'}));
 assert.throws(()=>x.settlement.settle(f.principal,f.actor,x.id,version),/OBSERVATION_STATE/);
 assert.equal(saved(f,x.obligation).value.settled,false);assert.equal(saved(f,x.obligation).value.heldYen,'100');
 assert.equal(f.store.read(tx=>tx.listRecord(f.principal,'cost_event').length),0);
});

test('Home projects output and financial state independently and never reports unresolved API cost as zero',async t=>{
 const x=await chargeFixture(t),{f}=x;
 update(f,x.id,v=>({...v,executionMode:undefined}));
 let home=snap(f),api=home.apiAttempts[0];
 assert.equal(api.mode,'unverified');assert.equal(api.text,'candidate');assert.equal(api.outputState,'completed');assert.equal(api.financialState,'unsettled');
 assert.equal(api.heldUsd,'1');assert.equal(api.bookedUsd,'0');assert.equal(home.budget.actualExternalCostYen,'unknown');
 assert.equal(JSON.stringify(api).includes('bodyBase64'),false);assert.equal(JSON.stringify(api).includes('accountRoute'),false);
 update(f,x.id,v=>({...v,executionMode:'synthetic'}));
 x.settlement.settle(f.principal,f.actor,x.id,x.insert());
 update(f,x.id,v=>({...v,executionMode:undefined}));
 home=snap(f);assert.equal(home.apiAttempts[0].financialState,'settled');assert.equal(home.budget.actualExternalCostYen,'unknown');
 update(f,x.id,v=>({...v,executionMode:'provider'}));home=snap(f);
 assert.equal(home.budget.actualExternalCostYen,'1500');assert.equal(home.budget.simulation,false);
 assert.equal(home.apiAttempts[0].bookedUsd,'11');assert.equal(home.apiAttempts[0].heldUsd,'0');
});
test('JST month rollover excludes prior API charges but retains late settlement and unresolved attempts',async t=>{
 const x=await chargeFixture(t),{f}=x;
 update(f,x.id,v=>({...v,executionMode:'provider'}));
 f.now=new Date('2026-09-30T14:59:59.999Z');
 assert.equal(snap(f).budget.month,'2026-09');assert.equal(snap(f).budget.actualExternalCostYen,'unknown');
 f.now=new Date('2026-09-30T15:00:00.000Z');
 let home=snap(f);
 assert.equal(home.budget.month,'2026-10');assert.equal(home.budget.actualExternalCostYen,'0');
 assert.equal(home.apiAttempts[0].month,'2026-09');assert.equal(home.apiAttempts[0].financialState,'unsettled');
 assert.equal(home.apiAttempts[0].heldUsd,'1');assert.equal(home.apiAttempts[0].heldYen,'100');
 // Financial ingestion stays synthetic; provider mode below is a projection
 // fixture only, not evidence of qualified real settlement.
 update(f,x.id,v=>({...v,executionMode:'synthetic'}));
 x.settlement.settle(f.principal,f.actor,x.id,x.insert());
 update(f,x.id,v=>({...v,executionMode:'provider'}));home=snap(f);
 assert.equal(home.budget.actualExternalCostYen,'0');assert.equal(home.budget.bookedYen,'0');
 assert.equal(home.apiAttempts[0].financialState,'settled');assert.equal(home.apiAttempts[0].bookedYen,'1500');
 assert.equal(saved(f,x.obligation).value.month,'2026-09');
 f.now=new Date('2026-09-30T14:59:59.999Z');
 assert.equal(snap(f).budget.actualExternalCostYen,'1500');
});

test('revoked disclosure, approval, wrong input or budget changes cannot partially acquire',async t=>{
 for(const reason of ['grant','approval','request','budget','capacity']){
  const x=await setup(t);
  if(reason==='grant')x.d.revokeGrant(x.f.principal,x.f.actor,x.grant);
  if(reason==='approval')update(x.f,x.approval,v=>({...v,state:'denied'}));
  if(reason==='budget')update(x.f,x.obligation,v=>({...v,heldYen:'1001'}));
  if(reason==='capacity')x.f.store.transaction(tx=>tx.insertRecord({principalId:x.f.principal,id:randomUUID(),kind:'cost_obligation',revision:1n,data:JSON.stringify({month:'2026-09',purpose:'production',pool:'normal',bookedYen:'901',heldYen:'0',reservedYen:'901',settled:true})}));
  assert.throws(()=>x.admission.acquire(x.f.principal,x.f.actor,x.id,reason==='request'?'b'.repeat(64):x.requestDigest));
  assert.equal(saved(x.f,x.id).value.state,'prepared',reason);assert.equal(saved(x.f,x.hold).value.state,'reserved',reason);
  assert.equal(x.f.store.read(tx=>tx.listAudit(x.f.principal).filter(v=>v.kind==='openrouter.send_acquired').length),0);
 }
});
