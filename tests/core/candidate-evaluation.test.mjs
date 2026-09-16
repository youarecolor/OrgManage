import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fixture,post,randomUUID,OrgManageCore,LedgerStore,control,bytes,committed,update,request,outcome,denied} from './fixtures/helpers.mjs';
import {createCandidateSnapshot,candidateSnapshotBytes} from '../../dist/runner/src/candidate.js';
import {LedgerOwnerError} from '../../dist/ledger/src/index.js';
import {createNativeEditRequest} from '../../dist/runner/src/native-edit.js';
import {CandidateChannelPort} from '../../dist/runner/src/candidate-channel.js';
import {openCandidateTransfer} from '../../dist/runner/src/candidate-transfer.js';

const sha=x=>createHash('sha256').update(x).digest('hex');
async function setup(t,mode='normal',useChannel=false){
  const f=await fixture(t),posted=post(f,'未実装のfilter件数を候補として検証する');
  const profile={principalId:f.principal,id:randomUUID(),revision:1n,digest:'d'.repeat(64),kind:'synthetic',isolationId:randomUUID(),ttlMs:60000};
  let staged,attemptId,calls=0,reads=0,inspects=0,observed;
  const fault={mode,mutate:null};
  const details=()=>{
    const r={version:'CANDIDATE-EVALUATION-RECEIPT-v1',planDigest:staged.plan.digest,attemptId,
      application:{baseDigest:staged.plan.baseDigest,beforeTreeDigest:staged.plan.baseTreeDigest,writeSetDigest:staged.plan.writeSetDigest,patchDigest:staged.plan.patchDigest,treeDigest:staged.plan.afterTreeDigest,status:'applied',appliedAt:1,receiptDigest:'a'.repeat(64)},
      verification:{treeDigest:staged.plan.afterTreeDigest,evaluatorDigest:staged.plan.evaluatorDigest,checks:staged.plan.checkIds.map(id=>({id,status:fault.mode==='test-failed'&&id==='protected-test'?'failed':'passed',evidenceDigest:'b'.repeat(64)})),verifiedAt:2,receiptDigest:'c'.repeat(64)},
      collection:{snapshotDigest:staged.plan.afterDigest,treeDigest:staged.plan.afterTreeDigest,collectedAt:3,receiptDigest:'e'.repeat(64)}};
    if(fault.mode==='wrong-plan')r.planDigest='0'.repeat(64);
    if(fault.mode==='missing-check')r.verification.checks.pop();
    if(fault.mode==='duplicate-check')r.verification.checks[1]=r.verification.checks[0];
    if(fault.mode==='forged-evaluator')r.verification.evaluatorDigest='0'.repeat(64);
    if(fault.mode==='stale-apply')r.application.patchDigest='0'.repeat(64);
    if(fault.mode==='wrong-before-tree')r.application.beforeTreeDigest='0'.repeat(64);
    if(fault.mode==='wrong-write-set')r.application.writeSetDigest='0'.repeat(64);
    if(fault.mode==='not-applied')r.application.status='unknown';
    if(fault.mode==='time-reversal')r.verification.verifiedAt=0;
    if(fault.mode==='stale-verify')r.verification.treeDigest='0'.repeat(64);
    if(fault.mode==='stale-collect')r.collection.snapshotDigest='0'.repeat(64);
    return r;
  };
  const response=b=>bytes({...b,status:'stopped',kind:profile.kind,handlesSignaled:true,jobEmpty:fault.mode!=='job-not-empty',writesStable:true,detail:details()});
  const port={
    stageCandidate(plan,proposal,id,patchBase64){assert.equal(Object.isFrozen(plan),true);assert.equal(Object.isFrozen(plan.checkIds),true);assert.equal(sha(Buffer.from(patchBase64,'base64')),proposal.patchDigest);staged={plan,proposal};attemptId=id;},
    async startExecutor(b){calls++;observed=b;if(fault.mutate)fault.mutate();if(fault.mode==='transport-unknown')throw Error('Lost response');return response(b);},
    async inspect(b){inspects++;return response(b);},async requestStop(b){return response(b);},
    async readCollected(){reads++;if(fault.mode==='missing-object')throw Error('Object unavailable');if(fault.mode==='collect-timeout')return new Promise(()=>{});if(fault.mutateCollection)fault.mutateCollection();if(fault.mode==='changed-object')return candidateSnapshotBytes(staged.proposal.base);return candidateSnapshotBytes(staged.proposal.after);},
  };
  const makePort=()=>useChannel?new CandidateChannelPort({principalId:f.principal,isolationId:profile.isolationId,profileDigest:profile.digest,evaluatorDigest:'f'.repeat(64),evidenceKind:profile.kind},{
    async dispatch(request){
      if(request.operation==='start'){
        const opened=openCandidateTransfer(request.transfer,request.expected);
        port.stageCandidate(opened.plan,opened.proposal,opened.attemptId,opened.patchBase64);
        return port.startExecutor(request.binding);
      }
      assert.equal(Object.hasOwn(request,'transfer'),false);
      assert.equal(request.expected.planDigest,staged.plan.digest);assert.equal(request.expected.attemptId,attemptId);
      return request.operation==='inspect'?port.inspect(request.binding):port.requestStop(request.binding);
    },
    async collect(expected){assert.equal(expected.planDigest,staged.plan.digest);assert.equal(expected.attemptId,attemptId);return port.readCollected();},
  }):port;
  f.options.evaluationProfiles=[{profile,port:makePort(),evaluatorDigest:'f'.repeat(64),checkIds:['typecheck','build','protected-test']}];f.options.collectionTimeoutMs=15;
  f.core=new OrgManageCore(f.store,f.options);f.session=f.core.openSession(f.actor);
  const binding={principalId:f.principal,missionId:posted.mission.id,commandId:posted.input.command_id,workspaceId:randomUUID(),leaseId:randomUUID(),generation:'2',profileDigest:profile.digest};
  const native=mode==='native-text';
  const target=native?'apps/home/src/App.tsx':'apps/home/src/filter.ts',inputs=[{path:target,text:native?'function MissionList() { return null; }\nfunction ApprovalCard() { return null; }':'export const count = 0;\n'},{path:'tests/oracle.ts',text:'protected'}];
  const initial=createCandidateSnapshot(binding,inputs,[target]);
  f.core.runner.prepare({principalId:f.principal,id:binding.workspaceId,profileId:profile.id,profileRevision:1n,profileDigest:profile.digest,snapshotDigest:initial.treeDigest,writeSetDigest:sha(JSON.stringify(initial.writeSet)),isolationId:profile.isolationId});
  const lease=f.core.runner.claim(f.principal,binding.workspaceId,posted.mission.id,f.actor);
  const snapshot=createCandidateSnapshot({...binding,leaseId:lease.id,generation:String(lease.generation)},inputs,[target]);
  const base=f.core.candidate.capture(f.actor,snapshot),patch={version:'CANDIDATE-PATCH-v1',baseDigest:snapshot.digest,changes:[{path:target,beforeDigest:snapshot.files.find(x=>x.path===target).digest,text:'export const count = 1;\n'}]};
  const nativeRequest=native?createNativeEditRequest(inputs[0].text,'Synthetic edit only'):null;
  const proposal=native?f.core.candidate.importNativeEdit(f.actor,f.principal,base.id,bytes(nativeRequest),nativeRequest.digest,bytes({version:'NATIVE-TEXT-EDIT-v1',requestDigest:nativeRequest.digest,replacement:'function MissionList() { return "<img src=x onerror=alert(1)>"; }'})):f.core.candidate.importPatch(f.actor,f.principal,base.id,bytes(patch));
  const plan=f.core.candidateEvaluation.prepare(f.actor,f.principal,proposal.id);
  return {...f,original:f,posted,profile,lease,base,proposal,plan,fault,makePort,counts:()=>({calls,reads,inspects}),observed:()=>observed};
}
const run=f=>f.core.candidateEvaluation.execute(f.actor,f.principal,f.plan.id);
const reconcile=f=>f.core.candidateEvaluation.reconcile(f.actor,f.principal,f.plan.id);
async function presented(t){const f=await setup(t);await run(f);f.artifact=await f.core.candidateEvaluation.registerArtifact(f.actor,f.principal,f.plan.id);f.outcomeId=f.core.presentCandidateOutcome(f.actor,f.principal,f.artifact.record.id);return f;}
const decide=(f,choice='accepted')=>{const o=f.core.snapshot(f.session).outcomes.find(x=>x.id===f.outcomeId);return request('outcome.decide',o.id,o.revision,{artifact_revision_id:o.artifactId,explanation_revision:o.explanationRevision,choice,comment:null});};

test('channel transfer -> protected observation -> collection -> Home decision survives coordinator restart',async t=>{
  const f=await setup(t,'normal',true);assert.equal((await run(f)).status,'passed');
  const collected=await f.core.candidateEvaluation.registerArtifact(f.actor,f.principal,f.plan.id);
  await f.store.close();f.store=await LedgerStore.open(f.path);f.original.store=f.store;
  f.options.evaluationProfiles[0].port=f.makePort();f.core=new OrgManageCore(f.store,f.options);f.session=f.core.openSession(f.actor);
  const artifact=await f.core.candidateEvaluation.registerArtifact(f.actor,f.principal,f.plan.id);
  assert.deepEqual(artifact,collected);
  f.outcomeId=f.core.presentCandidateOutcome(f.actor,f.principal,artifact.record.id);
  committed(f.core.command(f.session,bytes(decide(f))));
  assert.equal(f.core.snapshot(f.session).outcomes[0].state,'accepted');assert.equal(f.counts().calls,1);
  assert.equal(f.core.snapshot(f.session).candidateEvaluations[0].review.afterTreeDigest,f.plan.afterTreeDigest);
});
test('passed channel result without collected artifact cannot bypass owner change after restart',async t=>{
  const f=await setup(t,'normal',true);assert.equal((await run(f)).status,'passed');
  await f.store.close();f.store=await LedgerStore.open(f.path);f.original.store=f.store;
  f.options.evaluationProfiles[0].port=f.makePort();f.core=new OrgManageCore(f.store,f.options);f.session=f.core.openSession(f.actor);
  await assert.rejects(f.core.candidateEvaluation.registerArtifact(f.actor,f.principal,f.plan.id),/OWNER_CHANGED/);
  assert.equal(f.store.read(tx=>tx.listRecord(f.principal,'artifact')).length,0);assert.equal(f.counts().calls,1);
});
test('unknown channel start survives restart and only inspects the same attempt; no candidate resend',async t=>{
  const f=await setup(t,'transport-unknown',true);assert.equal((await run(f)).status,'unknown');assert.equal(f.counts().calls,1);
  await f.store.close();f.store=await LedgerStore.open(f.path);f.original.store=f.store;
  f.options.evaluationProfiles[0].port=f.makePort();f.core=new OrgManageCore(f.store,f.options);f.session=f.core.openSession(f.actor);f.fault.mode='normal';
  await assert.rejects(run(f),/RECONCILE_BEFORE_RETRY/);
  const result=await reconcile(f);assert.equal(result.status,'quarantined');assert.equal(f.counts().calls,1);assert.equal(f.counts().inspects,1);
  assert.equal(f.core.snapshot(f.session).outcomes.length,0);
});

test('Home review uses collected after bytes and immutable original, excludes unchanged protected files',async t=>{
  const f=await presented(t),review=f.core.snapshot(f.session).candidateEvaluations[0].review;
  assert.equal(review.status,'ready');assert.equal(review.artifactId,f.artifact.record.id);assert.equal(review.artifactDigest,f.artifact.record.artifactDigest);
  assert.equal(review.beforeTreeDigest,f.plan.baseTreeDigest);assert.equal(review.afterTreeDigest,f.plan.afterTreeDigest);
  assert.deepEqual(review.files,[{path:'apps/home/src/filter.ts',before:'export const count = 0;\n',after:'export const count = 1;\n',beforeDigest:sha('export const count = 0;\n'),afterDigest:sha('export const count = 1;\n')}]);
  assert.equal(review.source,'unspecified');assert.equal(JSON.stringify(review).includes('tests/oracle.ts'),false);
  outcome(f,'accepted','Synthetic');assert.deepEqual(f.core.snapshot(f.session).candidateEvaluations[0].review,review);
  review.files[0].after='forged';assert.equal(f.core.snapshot(f.session).candidateEvaluations[0].review.files[0].after,'export const count = 1;\n');
  assert.equal(f.counts().calls,1);
});
test('native text review preserves literal source without claiming verified provider origin or exposing original exchange',async t=>{
  const f=await setup(t,'native-text');await run(f);await f.core.candidateEvaluation.registerArtifact(f.actor,f.principal,f.plan.id);
  const review=f.core.snapshot(f.session).candidateEvaluations[0].review;
  assert.equal(review.source,'unverified_text');assert.match(review.files[0].after,/<img src=x onerror=alert\(1\)>/);
  assert.equal(Object.hasOwn(review,'requestBase64'),false);assert.equal(Object.hasOwn(review,'responseBase64'),false);
  assert.equal(review.files.length,1);assert.equal(f.counts().calls,1);
});
test('preview unavailable on object corruption and acceptance refuses the stale pass',async t=>{
  const f=await presented(t),command=decide(f),db=new DatabaseSync(f.path);
  try{db.exec('DROP TRIGGER record_version_update');db.prepare("UPDATE record_versions SET data=json_set(data,'$.snapshot.files[0].text','altered') WHERE principal_id=? AND version_id=(SELECT current_version_id FROM record_heads WHERE principal_id=? AND id=?)").run(f.principal,f.principal,f.artifact.record.id);}finally{db.close();}
  assert.deepEqual(f.core.snapshot(f.session).candidateEvaluations[0].review,{status:'unavailable'});
  denied(f.core.command(f.session,bytes(command)),'ARTIFACT_NOT_READY');
  assert.equal(f.core.snapshot(f.session).outcomes[0].state,'pending');
});
test('preview is withheld until immutable collection and denies another actor/Principal',async t=>{
  const f=await setup(t);assert.equal(f.core.snapshot(f.session).candidateEvaluations[0].review,undefined);
  await run(f);assert.equal(f.core.snapshot(f.session).candidateEvaluations[0].review,undefined);
  await f.core.candidateEvaluation.registerArtifact(f.actor,f.principal,f.plan.id);
  assert.throws(()=>f.core.candidateEvaluation.artifactReview(randomUUID(),f.principal,f.plan.id),/ACTOR_DENIED/);
  assert.throws(()=>f.core.candidateEvaluation.artifactReview(f.actor,randomUUID(),f.plan.id),/ACTOR_DENIED/);
});

for(const choice of ['accepted','revise','hold','close'])test('verified candidate -> Home outcome -> '+choice+' without update authority',async t=>{
  const f=await presented(t),before=f.core.snapshot(f.session);
  assert.equal(before.missions[0].phase,'review');assert.equal(before.outcomes[0].verification,'candidate_verified');assert.match(before.outcomes[0].text,/合成試験/);
  assert.equal(f.core.presentCandidateOutcome(f.actor,f.principal,f.artifact.record.id),f.outcomeId);
  const {input,receipt}=outcome(f,choice,'Explicit synthetic user decision');
  const view=f.core.snapshot(f.session);assert.equal(view.outcomes[0].state,choice);
  const artifact=f.core.candidateEvaluation.readArtifact(f.actor,f.principal,f.artifact.record.id);
  assert.equal(artifact.grantsExecution,false);assert.equal(Object.hasOwn(artifact,'adopted'),false);
  assert.equal(view.approvals.length,0);assert.equal(view.nativeAttempts.length,0);assert.equal(f.counts().calls,1);
  assert.deepEqual(committed(f.core.command(f.session,bytes(input))),receipt);
  assert.equal(f.store.read(tx=>tx.listRecord(f.principal,'artifact')).length,1);
  if(choice==='accepted')assert.equal(view.missions[0].phase,'exit');
  if(choice==='revise'){assert.equal(view.missions[0].phase,'intake');assert.notEqual(view.missions[0].contractRef,f.plan.contractId);}
  if(choice==='hold')assert.equal(view.missions[0].scope.state,'paused');
  if(choice==='close')assert.equal(view.missions[0].scope.state,'closed');
});
test('pending candidate outcome can be accepted after SQLite owner restart using the same immutable object',async t=>{
  const f=await presented(t),prior=f.core.snapshot(f.session).outcomes;
  await f.store.close();const store=await LedgerStore.open(f.path);f.original.store=store;f.store=store;
  f.core=new OrgManageCore(store,f.options);f.session=f.core.openSession(f.actor);
  assert.deepEqual(f.core.snapshot(f.session).outcomes,prior);
  committed(f.core.command(f.session,bytes(decide(f))));assert.equal(f.core.snapshot(f.session).outcomes[0].state,'accepted');
  assert.equal(f.counts().calls,1);
});
for(const mode of ['artifact','revision','explanation'])test('candidate outcome decision binds exact '+mode,async t=>{
  const f=await presented(t),command=decide(f);
  if(mode==='artifact')command.payload.artifact_revision_id=randomUUID();
  if(mode==='revision')command.expected_revision='2';
  if(mode==='explanation')command.payload.explanation_revision='2';
  denied(f.core.command(f.session,bytes(command)),'REVISION_CONFLICT');
  assert.equal(f.core.snapshot(f.session).outcomes[0].state,'pending');
});
for(const mode of ['scope-pause','scope-resume','contract','pending-contract','membership','workspace'])test('candidate acceptance refuses stale '+mode,async t=>{
  const f=await presented(t);
  if(mode==='scope-pause'||mode==='scope-resume'){
    committed(f.core.command(f.session,bytes(control(f,f.core.snapshot(f.session).missions[0].scope,'pause'))));
    if(mode==='scope-resume')committed(f.core.command(f.session,bytes(control(f,f.core.snapshot(f.session).missions[0].scope,'resume'))));
  }
  if(mode==='contract'||mode==='pending-contract'){
    const id=randomUUID();f.store.transaction(tx=>tx.insertRecord({principalId:f.principal,id,kind:'contract',revision:1n,data:'{}'}));
    update(f,f.posted.mission.id,m=>({...m,[mode==='contract'?'contractRef':'pendingContractRef']:id}));
  }
  if(mode==='membership'){f.store.transaction(tx=>{const m=tx.getMembership(f.principal,f.actor);tx.putMembership({...m,generation:m.generation+1n});});f.session=f.core.openSession(f.actor);}
  if(mode==='workspace')f.core.runner.claim(f.principal,f.lease.workspaceId,f.posted.mission.id,f.actor);
  const result=f.core.command(f.session,bytes(decide(f)));assert.ok(!result.ok||result.receipt.disposition==='rejected');
  assert.notEqual(f.core.snapshot(f.session).outcomes[0].state,'accepted');assert.equal(f.counts().calls,1);
});
test('candidate presentation refuses changed contract and cannot replace a pending outcome',async t=>{
  const f=await setup(t);await run(f);const artifact=await f.core.candidateEvaluation.registerArtifact(f.actor,f.principal,f.plan.id);
  update(f,f.posted.mission.id,m=>({...m,pendingContractRef:randomUUID()}));
  assert.throws(()=>f.core.presentCandidateOutcome(f.actor,f.principal,artifact.record.id),/CONTRACT_CHANGED/);
  assert.equal(f.core.snapshot(f.session).outcomes.length,0);
  update(f,f.posted.mission.id,m=>{const {pendingContractRef,...rest}=m;return rest;});
  const conflict=randomUUID();f.store.transaction(tx=>tx.insertRecord({principalId:f.principal,id:conflict,kind:'outcome',revision:1n,data:JSON.stringify({missionId:f.posted.mission.id,artifactId:artifact.record.id,explanationRevision:'1',state:'pending',verification:'candidate_verified',comment:null})}));
  update(f,f.posted.mission.id,m=>({...m,outcomeId:conflict}));
  assert.throws(()=>f.core.presentCandidateOutcome(f.actor,f.principal,artifact.record.id));
  assert.equal(f.store.read(tx=>tx.candidateArtifact.outcomeForArtifact(f.principal,artifact.record.id)),undefined);
});
test('artifact witness cannot be forged or reused for another actor/object',async t=>{
  const f=await presented(t),id=f.artifact.record.id,w=f.core.candidateEvaluation.prepareArtifactDecision(f.actor,f.principal,id);
  for(const [actor,target,witness] of [[f.actor,id,{}],[randomUUID(),id,w],[f.actor,randomUUID(),w]])assert.throws(()=>f.store.read(tx=>f.core.candidateEvaluation.assertArtifactDecision(tx,actor,f.principal,target,witness,true)),/ARTIFACT_WITNESS/);
  assert.equal(f.store.read(tx=>f.core.candidateEvaluation.assertArtifactDecision(tx,f.actor,f.principal,id,w,true)).id,f.plan.id);
});
test('outcome binding is immutable, same-Principal, and callback confined',async t=>{
  const f=await presented(t),binding=f.store.read(tx=>tx.candidateArtifact.outcome(f.principal,f.outcomeId));
  assert.equal(binding.artifactDigest,f.artifact.record.artifactDigest);
  assert.equal(f.store.read(tx=>tx.candidateArtifact.outcome(randomUUID(),f.outcomeId)),undefined);
  let api;f.store.read(tx=>{api=tx.candidateArtifact;assert.throws(()=>api.insertOutcome(binding),LedgerOwnerError);});assert.throws(()=>api.outcome(f.principal,f.outcomeId),LedgerOwnerError);
  const db=new DatabaseSync(f.path);try{assert.throws(()=>db.prepare('UPDATE candidate_outcomes SET artifact_digest=? WHERE id=?').run('0'.repeat(64),f.outcomeId));assert.throws(()=>db.prepare('DELETE FROM candidate_outcomes WHERE id=?').run(f.outcomeId));assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);}finally{db.close();}
});

test('passed candidate recollects the exact bytes into an immutable artifact and survives restart',async t=>{
  const f=await setup(t);await run(f);
  const artifact=await f.core.candidateEvaluation.registerArtifact(f.actor,f.principal,f.plan.id);
  assert.equal(artifact.snapshot.digest,f.plan.afterDigest);assert.equal(artifact.snapshot.treeDigest,f.plan.afterTreeDigest);
  assert.equal(artifact.evidenceKind,'synthetic');assert.equal(artifact.grantsExecution,false);
  assert.match(artifact.text,/合成試験/);assert.equal(f.core.snapshot(f.session).outcomes.length,0);
  assert.deepEqual(await f.core.candidateEvaluation.registerArtifact(f.actor,f.principal,f.plan.id),artifact);
  assert.deepEqual(f.counts(),{calls:1,reads:2,inspects:0});
  await f.store.close();const store=await LedgerStore.open(f.path);f.original.store=store;
  const core=new OrgManageCore(store,f.options);
  assert.deepEqual(core.candidateEvaluation.readArtifact(f.actor,f.principal,artifact.record.id),artifact);
  assert.deepEqual(await core.candidateEvaluation.registerArtifact(f.actor,f.principal,f.plan.id),artifact);
  assert.deepEqual(f.counts(),{calls:1,reads:2,inspects:0});
});
for(const mode of ['unexecuted','test-failed','transport-unknown'])test('artifact registration requires passed evaluation: '+mode,async t=>{
  const f=await setup(t,mode);if(mode!=='unexecuted')await run(f);
  await assert.rejects(f.core.candidateEvaluation.registerArtifact(f.actor,f.principal,f.plan.id),/ARTIFACT_NOT_VERIFIED/);
  assert.equal(f.store.read(tx=>tx.listRecord(f.principal,'artifact')).length,0);
});
for(const mode of ['changed-object','missing-object','collect-timeout'])test('artifact recollection refuses '+mode+' and may retry observation without execution',async t=>{
  const f=await setup(t);await run(f);f.fault.mode=mode;
  const audits=f.store.read(tx=>tx.listAudit(f.principal).length);
  await assert.rejects(f.core.candidateEvaluation.registerArtifact(f.actor,f.principal,f.plan.id));
  assert.equal(f.store.read(tx=>tx.candidateArtifact.forPlan(f.principal,f.plan.id)),undefined);
  assert.equal(f.store.read(tx=>tx.listRecord(f.principal,'artifact')).length,0);
  assert.equal(f.store.read(tx=>tx.listAudit(f.principal).length),audits);
  f.fault.mode='normal';await f.core.candidateEvaluation.registerArtifact(f.actor,f.principal,f.plan.id);
  assert.equal(f.counts().calls,1);
});
for(const mode of ['scope-stop','contract-change','membership-regrant','workspace-generation'])test('artifact recollection rechecks '+mode+' before commit',async t=>{
  const f=await setup(t);await run(f);
  f.fault.mutateCollection=()=>{
    if(mode==='scope-stop')committed(f.core.command(f.session,bytes(control(f,f.posted.mission.scope,'pause'))));
    if(mode==='contract-change'){const id=randomUUID();f.store.transaction(tx=>tx.insertRecord({principalId:f.principal,id,kind:'contract',revision:1n,data:'{}'}));update(f,f.posted.mission.id,m=>({...m,contractRef:id}));}
    if(mode==='membership-regrant')f.store.transaction(tx=>{const m=tx.getMembership(f.principal,f.actor);tx.putMembership({...m,generation:m.generation+1n});});
    if(mode==='workspace-generation')f.core.runner.claim(f.principal,f.lease.workspaceId,f.posted.mission.id,f.actor);
  };
  await assert.rejects(f.core.candidateEvaluation.registerArtifact(f.actor,f.principal,f.plan.id));
  assert.equal(f.store.read(tx=>tx.listRecord(f.principal,'artifact')).length,0);
  assert.equal(f.counts().calls,1);
});
test('artifact relations deny foreign reads, mutable or duplicate bindings and SQL escape',async t=>{
  const f=await setup(t);await run(f);const artifact=await f.core.candidateEvaluation.registerArtifact(f.actor,f.principal,f.plan.id);
  assert.throws(()=>f.core.candidateEvaluation.readArtifact(randomUUID(),f.principal,artifact.record.id),/ACTOR_DENIED/);
  assert.throws(()=>f.core.candidateEvaluation.readArtifact(f.actor,randomUUID(),artifact.record.id),/ACTOR_DENIED/);
  let api;f.store.read(tx=>{api=tx.candidateArtifact;assert.equal('query' in api,false);assert.equal('run' in api,false);assert.throws(()=>api.insert(artifact.record),LedgerOwnerError);});
  assert.throws(()=>api.get(f.principal,artifact.record.id),LedgerOwnerError);
  assert.throws(()=>update(f,artifact.record.id,v=>({...v,text:'tamper'})));
  for(const field of ['resultId','planId','snapshotDigest','treeDigest','artifactDigest']){
    const changed={...artifact.record,id:randomUUID(),[field]:field.endsWith('Id')?randomUUID():'0'.repeat(64)};
    assert.throws(()=>f.store.transaction(tx=>{
      const old=tx.getRecord(f.principal,artifact.record.id);tx.insertRecord({principalId:f.principal,id:changed.id,kind:'artifact',revision:1n,data:old.data});
      tx.candidateArtifact.insert(changed);
    }));
  }
  const db=new DatabaseSync(f.path,{enableForeignKeyConstraints:true});
  try{assert.throws(()=>db.prepare('DELETE FROM candidate_artifacts WHERE id=?').run(artifact.record.id));assert.throws(()=>db.prepare('UPDATE candidate_artifacts SET created_at=0 WHERE id=?').run(artifact.record.id));assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);}finally{db.close();}
  assert.equal(f.store.read(tx=>tx.listRecord(f.principal,'artifact')).length,1);
});
for(const mode of ['failed-result','snapshot-digest','tree-digest','record-digest'])test('SQL independently denies inconsistent artifact '+mode,async t=>{
  const f=await setup(t,mode==='failed-result'?'test-failed':'normal'),evaluation=await run(f);
  const after=f.core.candidate.readProposal(f.actor,f.principal,f.proposal.id).proposal.after;
  const snapshot=structuredClone(after);
  if(mode==='snapshot-digest')snapshot.digest='0'.repeat(64);
  if(mode==='tree-digest')snapshot.treeDigest='0'.repeat(64);
  const row={principalId:f.principal,id:randomUUID(),planId:f.plan.id,resultId:evaluation.result.id,snapshotDigest:snapshot.digest,treeDigest:snapshot.treeDigest,artifactDigest:'a'.repeat(64),createdAt:f.original.now.getTime()};
  const data=JSON.stringify({format:'candidate_artifact_v1',verification:'candidate_verified',planId:row.planId,resultId:row.resultId,snapshot,artifactDigest:mode==='record-digest'?'b'.repeat(64):row.artifactDigest});
  assert.throws(()=>f.store.transaction(tx=>{tx.insertRecord({principalId:f.principal,id:row.id,kind:'artifact',revision:1n,data});tx.candidateArtifact.insert(row);}));
  assert.equal(f.store.read(tx=>tx.listRecord(f.principal,'artifact')).length,0);
});
test('bound apply -> independent checks -> collected same snapshot -> durable result; no adoption',async t=>{
  const f=await setup(t);const result=await run(f);assert.equal(result.status,'passed');assert.equal(result.plan.evidenceKind,'synthetic');
  assert.equal(f.store.read(tx=>tx.runner.getLease(f.principal,f.lease.id)).state,'released');
  assert.deepEqual(await run(f),result);assert.deepEqual(f.counts(),{calls:1,reads:1,inspects:0});
  assert.equal(f.store.read(tx=>tx.listRecord(f.principal,'artifact')).length,0);assert.equal(f.store.read(tx=>tx.listRecord(f.principal,'approval')).length,0);
  await f.store.close();const reopened=await LedgerStore.open(f.path);f.original.store=reopened;const core=new OrgManageCore(reopened,f.options);
  assert.deepEqual(core.candidateEvaluation.read(f.actor,f.principal,f.plan.id),result);
});
for(const mode of ['wrong-plan','missing-check','duplicate-check','forged-evaluator','stale-apply','wrong-before-tree','wrong-write-set','not-applied','time-reversal','stale-verify','stale-collect','changed-object','missing-object','collect-timeout','job-not-empty'])test(`reject ${mode} without a passing result or resend`,async t=>{
  const f=await setup(t,mode);assert.equal((await run(f)).status,'unknown');await assert.rejects(run(f),/RECONCILE_BEFORE_RETRY/);assert.equal(f.counts().calls,1);
  assert.equal(f.store.read(tx=>tx.listRecord(f.principal,'artifact')).length,0);
});
test('known protected test failure is recorded, never collected or adopted',async t=>{const f=await setup(t,'test-failed');assert.equal((await run(f)).status,'failed');assert.equal(f.counts().reads,0);assert.equal((await reconcile(f)).status,'failed');assert.equal(f.counts().calls,1);});
test('unknown dispatch reconciles using inspection only; scope/stop generation remains quarantined',async t=>{
  const f=await setup(t,'transport-unknown');assert.equal((await run(f)).status,'unknown');f.fault.mode='normal';
  const result=await reconcile(f);assert.equal(result.status,'quarantined');assert.deepEqual(f.counts(),{calls:1,reads:1,inspects:1});
  const rows=f.store.read(tx=>tx.candidateEvaluation.results(f.principal,result.attemptId));assert.deepEqual(rows.map(r=>r.status),['unknown','quarantined']);
});
test('missing collection object may be read again without executing the candidate again',async t=>{
  const f=await setup(t,'missing-object');assert.equal((await run(f)).status,'unknown');f.fault.mode='normal';
  assert.equal((await reconcile(f)).status,'passed');assert.deepEqual(f.counts(),{calls:1,reads:2,inspects:0});
});
for(const mutation of ['scope-stop','contract-change','membership-regrant','workspace-generation'])test(`late success after ${mutation} is quarantined`,async t=>{
  const f=await setup(t);
  f.fault.mutateCollection=()=>{
    if(mutation==='scope-stop')committed(f.core.command(f.session,bytes(control(f,f.posted.mission.scope,'pause'))));
    if(mutation==='contract-change'){const id=randomUUID();f.store.transaction(tx=>tx.insertRecord({principalId:f.principal,id,kind:'contract',revision:1n,data:'{}'}));update(f,f.posted.mission.id,m=>({...m,contractRef:id}));}
    if(mutation==='membership-regrant')f.store.transaction(tx=>{const m=tx.getMembership(f.principal,f.actor);tx.putMembership({...m,generation:m.generation+1n});});
    if(mutation==='workspace-generation')f.core.runner.claim(f.principal,f.lease.workspaceId,f.posted.mission.id,f.actor);
  };
  assert.equal((await run(f)).status,'quarantined');
});
test('pre-dispatch expiry rejects with no effect',async t=>{
  const f=await setup(t);f.original.now=new Date(f.original.now.getTime()+60001);await assert.rejects(run(f),/LEASE_NOT_READY/);assert.equal(f.counts().calls,0);
});
test('no default evaluator admission, and changed protected evaluator cannot reuse an old plan',async t=>{
  const f=await setup(t);const unregistered=new OrgManageCore(f.store,{...f.options,evaluationProfiles:[]});
  await assert.rejects(unregistered.candidateEvaluation.execute(f.actor,f.principal,f.plan.id),/UNADMITTED_PROFILE/);
  const changed=new OrgManageCore(f.store,{...f.options,evaluationProfiles:f.options.evaluationProfiles.map(r=>({...r,evaluatorDigest:'0'.repeat(64)}))});
  await assert.rejects(changed.candidateEvaluation.execute(f.actor,f.principal,f.plan.id),/PROFILE_CHANGED/);assert.equal(f.counts().calls,0);
});
test('Home projection updates its opaque cursor and does not expose source or owner authority',async t=>{
  const f=await setup(t);const before=f.core.snapshot(f.session);assert.equal(before.candidateEvaluations[0].status,'prepared');
  await run(f);const after=f.core.snapshot(f.session);assert.notEqual(after.visibleCursor,before.visibleCursor);
  const projected=after.candidateEvaluations[0];assert.equal(projected.status,'passed');
  assert.deepEqual(Object.keys(projected).sort(),['id','missionId','proposalId','candidateDigest','status','evidenceKind','checks'].sort());
  assert.equal(after.outcomes.length,0);
});
test('unknown evaluation survives owner restart, cannot dispatch again, and reconciliation stays non-adopting',async t=>{
  const f=await setup(t,'transport-unknown');const before=await run(f);await f.store.close();
  const store=await LedgerStore.open(f.path);f.original.store=store;const core=new OrgManageCore(store,f.options);
  assert.equal(core.candidateEvaluation.read(f.actor,f.principal,f.plan.id).status,'unknown');
  await assert.rejects(core.candidateEvaluation.execute(f.actor,f.principal,f.plan.id),/RECONCILE_BEFORE_RETRY/);
  f.fault.mode='normal';const after=await core.candidateEvaluation.reconcile(f.actor,f.principal,f.plan.id);
  assert.equal(after.status,'quarantined');assert.equal(after.attemptId,before.attemptId);assert.equal(f.counts().calls,1);
});
test('foreign actor denied, schema relations immutable, callback SQL inaccessible',async t=>{
  const f=await setup(t);await assert.rejects(f.core.candidateEvaluation.execute(randomUUID(),f.principal,f.plan.id),/ACTOR_DENIED/);
  const result=await run(f);let access;
  f.store.read(tx=>{access=tx.candidateEvaluation;assert.equal('get' in access,false);assert.equal('run' in access,false);assert.throws(()=>access.insertPlan({}),LedgerOwnerError);});assert.throws(()=>access.getPlan(f.principal,f.plan.id),LedgerOwnerError);
  const db=new DatabaseSync(f.path,{enableForeignKeyConstraints:true});t.after(()=>db.close());
  assert.throws(()=>db.prepare('UPDATE candidate_evaluation_plans SET plan_digest=? WHERE id=?').run('0'.repeat(64),f.plan.id));
  assert.throws(()=>db.prepare('DELETE FROM candidate_evaluation_results WHERE id=?').run(result.result.id));
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});
