import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,post,randomUUID,request,bytes,committed,snap,saved,update,control} from './fixtures/helpers.mjs';
const criteria=['reproduction','prohibited_changes','holdout:1','holdout:2','holdout:3','nonregression:1','nonregression:2','nonregression:3'];
async function setup(t){
  const f=await fixture(t),origin=post(f).mission,scope=snap(f).conversation.id,source=randomUUID();
  f.store.transaction(tx=>tx.insertRecord({principalId:f.principal,id:source,kind:'source',revision:1n,data:JSON.stringify({scopeId:scope,text:'fixture evidence'})}));
  const sourceVersion=f.store.read(tx=>tx.getRecord(f.principal,source).versionId),k=f.core.knowledge;
  const plan=k.preparePlan(f.principal,f.actor,scope,'generator','independent-evaluator',criteria);
  const candidate=k.propose(f.principal,f.actor,plan,origin.id,'developer','評価済み手順を参照する',[sourceVersion]);
  const results=criteria.map(criterion=>{const id=randomUUID();f.store.transaction(tx=>tx.insertRecord({principalId:f.principal,id,kind:'evidence',revision:1n,data:JSON.stringify({format:'knowledge_check_v1',synthetic:true,criterion,status:'pass',candidateVersion:tx.getRecord(f.principal,candidate).versionId,planVersion:tx.getRecord(f.principal,plan).versionId})}));return {criterion,status:'pass',evidenceVersion:f.store.read(tx=>tx.getRecord(f.principal,id).versionId)};});
  const evaluate=(changes=results)=>k.recordEvaluation(f.principal,f.actor,candidate,'independent-evaluator',changes);
  const decide=(choice,evaluation_ref=null)=>f.core.command(f.session,bytes(request('knowledge.decide',candidate,String(saved(f,candidate).row.revision),{choice,candidate_ref:candidate,evaluation_ref,scope_ref:scope,comment:'合成試験の本人判断'})));
  return {f,k,scope,source,sourceVersion,plan,candidate,origin,results,evaluate,decide};
}
test('protected evaluation -> Home command adoption -> separate Mission use -> revoke preserves history',async t=>{
  const {f,k,candidate,origin,evaluate,decide}=await setup(t);
  assert.throws(()=>k.use(f.principal,f.actor,candidate,origin.id,'developer'),/NOT_ACTIVE/);
  committed(decide('adopt',evaluate()));
  assert.throws(()=>k.use(f.principal,f.actor,candidate,origin.id,'developer'),/SEPARATE_MISSION/);
  const other=post(f,'別案件').mission,use=k.use(f.principal,f.actor,candidate,other.id,'developer');
  assert.equal(use.text,'評価済み手順を参照する');assert.equal(saved(f,use.useId).value.missionId,other.id);
  committed(decide('revoke'));assert.throws(()=>k.use(f.principal,f.actor,candidate,other.id,'developer'),/NOT_ACTIVE/);
  assert.equal(saved(f,use.useId).value.knowledgeId,candidate);assert.equal(saved(f,candidate).value.state,'revoked');
});
test('unknown checks and generator-as-evaluator cannot adopt',async t=>{
  const {f,k,candidate,results,evaluate,decide}=await setup(t);
  assert.throws(()=>k.recordEvaluation(f.principal,f.actor,candidate,'generator',results),/INDEPENDENT/);
  assert.throws(()=>evaluate(results.map((r,n)=>n? r:{...r,status:'unknown'})),/EVIDENCE_BINDING/);
  const unknownId=randomUUID();f.store.transaction(tx=>{const previous=tx.getRecordVersion(f.principal,results[0].evidenceVersion);tx.insertRecord({principalId:f.principal,id:unknownId,kind:'evidence',revision:1n,data:JSON.stringify({...JSON.parse(previous.data),status:'unknown'})});});
  const unknownVersion=f.store.read(tx=>tx.getRecord(f.principal,unknownId).versionId);
  const response=decide('adopt',evaluate(results.map((r,n)=>n?r:{...r,status:'unknown',evidenceVersion:unknownVersion})));
  assert.notEqual(response.ok&&response.receipt.disposition==='committed',true);assert.equal(saved(f,candidate).value.state,'candidate');
});

test('prepared knowledge use is rechecked at dispatch after revocation or source revision',async t=>{
 for(const reason of ['revoke','source']){
  const {f,k,candidate,source,evaluate,decide}=await setup(t);committed(decide('adopt',evaluate()));
  const mission=post(f,'送信予定の別案件').mission,use=k.use(f.principal,f.actor,candidate,mission.id,'developer');
  const verify=()=>f.store.transaction(tx=>k.confirmUseInTransaction(tx,f.principal,f.actor,use.useId,mission.id,'developer'));
  assert.equal(verify().text,use.text);
  if(reason==='revoke')committed(decide('revoke'));else update(f,source,v=>({...v,text:'新版'}));
  assert.throws(verify,/NOT_ACTIVE|SOURCE_CHANGED/);
  assert.equal(saved(f,use.useId).value.knowledgeId,candidate);
 }
});
test('source revision invalidates reuse and emergency revoke works when dispatch is paused',async t=>{
  const {f,k,candidate,source,evaluate,decide}=await setup(t);committed(decide('adopt',evaluate()));
  const other=post(f,'別案件').mission;update(f,source,v=>({...v,text:'改版'}));
  assert.throws(()=>k.use(f.principal,f.actor,candidate,other.id,'developer'),/SOURCE_CHANGED/);
  committed(f.core.command(f.session,bytes(control(f,snap(f).application,'halt_dispatch'))));
  committed(decide('revoke'));
});
test('evaluation cannot omit mandatory criteria or cross worker scope',async t=>{
  const {f,k,scope,candidate,evaluate,decide}=await setup(t);
  assert.throws(()=>k.preparePlan(f.principal,f.actor,scope,'a','b',Array.from({length:8},(_,n)=>String(n))),/CRITERIA/);
  committed(decide('adopt',evaluate()));const other=post(f,'別案件').mission;
  assert.throws(()=>k.use(f.principal,f.actor,candidate,other.id,'other-worker'),/NOT_ACTIVE/);
});
test('knowledge cannot import a source from another project scope',async t=>{
  const {f,k,plan,origin}=await setup(t),other=randomUUID(),source=randomUUID();
  f.store.transaction(tx=>{
    tx.insertScope({id:other,principalId:f.principal,kind:'conversation',parentId:f.principal,revision:1n,epoch:1n,state:'active'});
    tx.insertRecord({principalId:f.principal,id:source,kind:'source',revision:1n,data:JSON.stringify({scopeId:other,text:'different project'})});
  });
  const version=f.store.read(tx=>tx.getRecord(f.principal,source).versionId);
  assert.throws(()=>k.propose(f.principal,f.actor,plan,origin.id,'developer','cross-project note',[version]),/SOURCE_SCOPE/);
});
