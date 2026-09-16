import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {fixture,post,snap,request,bytes,committed,saved,update,LedgerStore} from './fixtures/helpers.mjs';
import {DisclosureCoordinator} from '../../dist/core/src/disclosure.js';
import {ApiTrialBudget} from '../../dist/core/src/api-trial-budget.js';
import {OpenRouterPreparation} from '../../dist/core/src/openrouter-preparation.js';
import {OpenRouterAdmission} from '../../dist/core/src/openrouter-admission.js';
import {OpenRouterJournal} from '../../dist/core/src/openrouter-journal.js';
import {OpenRouterObservation} from '../../dist/core/src/openrouter-observation.js';
import {OpenRouterSettlement} from '../../dist/core/src/openrouter-settlement.js';
import {OpenRouterCandidateSource} from '../../dist/core/src/openrouter-candidate-source.js';

const sha=value=>createHash('sha256').update(value).digest('hex');
const responseText='untrusted patch text; data only';

async function setup(t){
  const f=await fixture(t),mission=post(f,'OpenRouter candidate source fixture').mission,clock=()=>f.now.getTime();
  const budgetPolicy=snap(f).budgetPolicy;
  committed(f.core.command(f.session,bytes(request('budget.configure',budgetPolicy.id,budgetPolicy.revision,{currency:'USD',normal_limit:'8',reserve_limit:'16',autonomous_e_limit:'2'}))));
  const contract=randomUUID();
  f.store.transaction(tx=>tx.insertRecord({principalId:f.principal,id:contract,kind:'contract',revision:1n,data:JSON.stringify({mode:'standard_api',scopeId:mission.id,synthetic:true})}));
  mission.contractRef=saved(f,contract).row.versionId;
  update(f,mission.id,value=>({...value,contractRef:mission.contractRef}));
  const policy={mode:'fixed',models:['meta-llama/llama-4-scout'],providers:['example'],maxPromptUsdPerMillion:1,maxCompletionUsdPerMillion:2,maxOutputTokens:128,maxInputBytes:4096};
  const destination={provider:'openrouter',accountRoute:'synthetic-account',profileDigest:'a'.repeat(64),models:policy.models,endpoints:policy.providers};
  const disclosure=new DisclosureCoordinator(f.store,clock),source=disclosure.registerSource(f.principal,f.actor,mission.id,'Synthetic source','original');
  const grant=disclosure.grant(f.principal,f.actor,source,destination,clock()+10000);
  const manifest=disclosure.createManifest(f.principal,f.actor,mission.id,mission.contractRef,destination,[{sourceId:source,grantId:grant}]);
  const price=randomUUID();
  f.store.transaction(tx=>tx.insertRecord({principalId:f.principal,id:price,kind:'evidence',revision:1n,data:'{"synthetic":true}'}));
  new ApiTrialBudget(f.store,clock).configure(f.principal,f.actor,destination.accountRoute,'10',saved(f,price).row.versionId);
  const preparation=new OpenRouterPreparation(f.store,clock).prepare(f.principal,f.actor,{mode:'synthetic',missionId:mission.id,contractVersion:mission.contractRef,manifestId:manifest,destination,input:'original',policy,expected:{models:policy.models,providerNames:['Example']},maximumUsd:'1',priceEvidenceVersion:saved(f,price).row.versionId,expiresAt:clock()+10000});
  const approval=snap(f).approvals.find(item=>item.id===preparation.approvalId);
  committed(f.core.command(f.session,bytes(request('approval.decide',approval.id,approval.revision,{action_digest:approval.actionDigest,explanation_revision:approval.explanationRevision,choice:'approve',comment:'candidate source fixture'}))));
  const admission=new OpenRouterAdmission(f.store,clock);
  admission.acquire(f.principal,f.actor,preparation.intentId,preparation.requestDigest);
  admission.confirmAcquired(f.principal,f.actor,preparation.intentId,preparation.requestDigest);
  const response=Buffer.from(JSON.stringify({id:'gen-candidate-source',object:'chat.completion',model:policy.models[0],provider:'Example',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:responseText}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2,cost:0.5}}));
  const journalId=new OpenRouterJournal(f.store,clock).append(f.principal,f.actor,preparation.intentId,200,response,'application/json');
  const observationId=new OpenRouterObservation(f.store,clock).collect(f.principal,f.actor,preparation.intentId);
  const observationVersion=saved(f,observationId).row.versionId;
  const charge=randomUUID();
  f.store.transaction(tx=>tx.insertRecord({principalId:f.principal,id:charge,kind:'evidence',revision:1n,data:JSON.stringify({format:'openrouter_charge_v2',mode:'synthetic',intentId:preparation.intentId,accountRoute:destination.accountRoute,currency:'USD',generationId:'gen-candidate-source',amountUsd:'0.5',observationVersion})}));
  new OpenRouterSettlement(f.store,clock).settle(f.principal,f.actor,preparation.intentId,saved(f,charge).row.versionId);
  return {f,mission,contractVersion:mission.contractRef,intentId:preparation.intentId,observationId,observationVersion,journalId,journalVersion:saved(f,journalId).row.versionId,grant,source,disclosure,clock};
}

const port=x=>new OpenRouterCandidateSource(x.f.store,x.clock);
const capture=x=>port(x).capture(x.f.principal,x.f.actor,x.mission.id,x.contractVersion,x.intentId);
const evidenceCount=x=>x.f.store.read(tx=>tx.listRecord(x.f.principal,'evidence').filter(row=>JSON.parse(row.data).format==='openrouter_candidate_source_v1').length);

test('settled completed journal response becomes one immutable unverified data source across restart',async t=>{
  const x=await setup(t),result=capture(x);
  assert.equal(result.text,responseText);
  assert.equal(result.evidence.format,'openrouter_candidate_source_v1');
  assert.equal(result.evidence.intentId,x.intentId);
  assert.equal(result.evidence.missionId,x.mission.id);
  assert.equal(result.evidence.contractVersion,x.contractVersion);
  assert.equal(result.evidence.observationVersion,x.observationVersion);
  assert.equal(result.evidence.journalVersion,x.journalVersion);
  assert.equal(result.evidence.textDigest,sha(responseText));
  assert.equal(result.status,'unverified');
  assert.equal(result.executionAuthorized,false);
  assert.equal(evidenceCount(x),1);
  assert.deepEqual(capture(x),result);
  assert.equal(evidenceCount(x),1);
  assert.throws(()=>{result.evidence.requestDigest='0'.repeat(64);},TypeError);
  assert.equal(x.f.store.read(tx=>tx.listRecord(x.f.principal,'artifact').length),0);
  await x.f.store.close();x.f.store=await LedgerStore.open(x.f.path);
  const reopened=new OpenRouterCandidateSource(x.f.store,x.clock);
  assert.deepEqual(reopened.capture(x.f.principal,x.f.actor,x.mission.id,x.contractVersion,x.intentId),result);
  assert.deepEqual(reopened.read(x.f.principal,x.f.actor,x.mission.id,x.contractVersion,result.id),result);
  assert.equal(evidenceCount(x),1);
});

test('capture rejects unresolved, foreign Mission, contract, or actor without writing evidence',async t=>{
  const x=await setup(t),settled=saved(x.f,x.intentId).value;
  update(x.f,x.intentId,value=>({...value,state:'unknown',financialState:'unsettled'}));
  assert.throws(()=>capture(x),/STATE/);
  update(x.f,x.intentId,()=>settled);
  assert.throws(()=>port(x).capture(x.f.principal,x.f.actor,randomUUID(),x.contractVersion,x.intentId),/MISSION/);
  assert.throws(()=>port(x).capture(x.f.principal,x.f.actor,x.mission.id,randomUUID(),x.intentId),/CONTRACT/);
  const anotherOwner=randomUUID();x.f.store.transaction(tx=>tx.putMembership({principalId:x.f.principal,actorId:anotherOwner,role:'owner',generation:1n}));
  assert.throws(()=>port(x).capture(x.f.principal,anotherOwner,x.mission.id,x.contractVersion,x.intentId),/ACTOR/);
  assert.equal(evidenceCount(x),0);
});

test('read revalidates disclosure, active scope, current contract and cancellation while retaining history',async t=>{
  for(const mode of ['grant-revoked','scope-stopped','contract-changed','cancellation-requested']){
    const x=await setup(t),result=capture(x);
    if(mode==='grant-revoked')x.disclosure.revokeGrant(x.f.principal,x.f.actor,x.grant);
    if(mode==='scope-stopped')x.f.store.transaction(tx=>{const scope=tx.getScope(x.mission.id);tx.updateScope({...scope,state:'paused',revision:scope.revision+1n,epoch:scope.epoch+1n},scope.revision);});
    if(mode==='contract-changed'){
      const id=randomUUID();x.f.store.transaction(tx=>tx.insertRecord({principalId:x.f.principal,id,kind:'contract',revision:1n,data:'{}'}));
      const nextVersion=saved(x.f,id).row.versionId;
      update(x.f,x.mission.id,value=>({...value,contractRef:nextVersion}));
    }
    if(mode==='cancellation-requested')update(x.f,x.intentId,value=>({...value,cancellation:'requested'}));
    assert.throws(()=>port(x).read(x.f.principal,x.f.actor,x.mission.id,x.contractVersion,result.id));
    assert.equal(evidenceCount(x),1);
    assert.ok(saved(x.f,result.id));
  }
});

test('read rejects changed intent references and immutable source evidence cannot be overwritten',async t=>{
  const x=await setup(t),result=capture(x),intent=saved(x.f,x.intentId).value;
  assert.throws(()=>update(x.f,result.id,value=>({...value,responseDigest:'0'.repeat(64)})));
  update(x.f,x.intentId,value=>({...value,requestDigest:'0'.repeat(64)}));
  assert.throws(()=>port(x).read(x.f.principal,x.f.actor,x.mission.id,x.contractVersion,result.id),/BINDING/);
  update(x.f,x.intentId,()=>intent);
  x.f.store.transaction(tx=>tx.setMeta(`openrouter-response:${x.f.principal}:${x.intentId}`,result.id));
  assert.throws(()=>port(x).read(x.f.principal,x.f.actor,x.mission.id,x.contractVersion,result.id),/JOURNAL/);
  assert.equal(evidenceCount(x),1);
});
