import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fixture,post,randomUUID,OrgManageCore,LedgerStore,bytes,control,committed,update} from './fixtures/helpers.mjs';
import {createCandidateSnapshot} from '../../dist/runner/src/candidate.js';
import {createNativeEditRequest} from '../../dist/runner/src/native-edit.js';
import {prepareNativeCandidate,reopenNativeCandidateSource} from '../../dist/runner/src/native-candidate.js';

const sha=v=>createHash('sha256').update(v).digest('hex');
const target='apps/home/src/App.tsx';
const original='// unchanged prefix\nfunction MissionList() { return 0; }\n\nfunction ApprovalCard() { return 2; }\n';
const makeRequest=()=>createNativeEditRequest(original,'Show each filter count, including zero.');
const makeResponse=request=>({version:'NATIVE-TEXT-EDIT-v1',requestDigest:request.digest,replacement:'function MissionList() { throw Error("text only; must not execute"); }\n'});
const makeFiles=()=>[{path:target,text:original},{path:'tests/oracle.mjs',text:'protected independent oracle'}];
const binding={principalId:randomUUID(),missionId:randomUUID(),commandId:randomUUID(),workspaceId:randomUUID(),leaseId:randomUUID(),generation:'2',profileDigest:'d'.repeat(64)};
const base=()=>createCandidateSnapshot(binding,makeFiles(),[target]);

test('exact request/response -> bounded single-file patch preserves surrounding source and oracle',()=>{
  const request=makeRequest(),requestBytes=Buffer.from(JSON.stringify(request)+'\n'),responseBytes=Buffer.from(JSON.stringify(makeResponse(request),null,2)+'\n'),snapshot=base();
  const prepared=prepareNativeCandidate(snapshot,requestBytes,request.digest,responseBytes);
  assert.equal(prepared.status,'unverified');assert.equal(prepared.source.attribution,'unverified');
  assert.equal(Buffer.from(prepared.source.requestBase64,'base64').equals(requestBytes),true);
  assert.equal(Buffer.from(prepared.source.responseBase64,'base64').equals(responseBytes),true);
  assert.equal(prepared.source.responseDigest,sha(responseBytes));
  assert.deepEqual(prepared.proposal.changedPaths,[target]);
  assert.equal(prepared.proposal.after.files.find(f=>f.path===target).text,'// unchanged prefix\n'+makeResponse(request).replacement+'\nfunction ApprovalCard() { return 2; }\n');
  assert.deepEqual(prepared.proposal.after.files.find(f=>f.path==='tests/oracle.mjs'),snapshot.files.find(f=>f.path==='tests/oracle.mjs'));
  assert.equal(sha(Buffer.from(prepared.patchBase64,'base64')),prepared.proposal.patchDigest);
  requestBytes.fill(0);responseBytes.fill(0);
  assert.deepEqual(reopenNativeCandidateSource(snapshot,prepared.source,prepared.patchBase64),prepared.source);
  assert.throws(()=>{prepared.source.responseDigest='0'.repeat(64);});
});
for(const mode of ['source-changed','missing-target','target-not-writable','forged-base','foreign-request','foreign-response','shared-request','shared-response','oversize'])test('native candidate rejects '+mode,()=>{
  const request=makeRequest();let snapshot=base(),rq=bytes(request),rp=bytes(makeResponse(request)),digest=request.digest;
  if(mode==='source-changed')snapshot=createCandidateSnapshot(binding,[{path:target,text:original+' '},{path:'tests/oracle.mjs',text:'protected independent oracle'}],[target]);
  if(mode==='missing-target')snapshot=createCandidateSnapshot(binding,[{path:'apps/home/src/other.ts',text:'x'}],['apps/home/src/other.ts']);
  if(mode==='target-not-writable')snapshot=createCandidateSnapshot(binding,[...makeFiles(),{path:'apps/home/src/other.ts',text:'x'}],['apps/home/src/other.ts']);
  if(mode==='forged-base')snapshot=structuredClone(snapshot);
  if(mode==='foreign-request')digest='0'.repeat(64);
  if(mode==='foreign-response')rp=bytes({...makeResponse(request),requestDigest:'0'.repeat(64)});
  if(mode==='shared-request')rq=new Uint8Array(new SharedArrayBuffer(8));
  if(mode==='shared-response')rp=new Uint8Array(new SharedArrayBuffer(8));
  if(mode==='oversize')rp=Buffer.alloc(16385);
  assert.throws(()=>prepareNativeCandidate(snapshot,rq,digest,rp));
});
for(const mode of ['response-bytes','request-bytes','provider-claim','added-field','patch','base64-alias'])test('stored source refuses '+mode,()=>{
  const request=makeRequest(),snapshot=base(),p=prepareNativeCandidate(snapshot,bytes(request),request.digest,bytes(makeResponse(request)));
  const source=structuredClone(p.source);let patch=p.patchBase64;
  if(mode==='response-bytes')source.responseBase64=bytes({...makeResponse(request),replacement:'function MissionList() { return 3; }\n'}).toString('base64');
  if(mode==='request-bytes')source.requestBase64=bytes({...request,requirements:'changed'}).toString('base64');
  if(mode==='provider-claim')source.attribution='provider-confirmed';
  if(mode==='added-field')source.verified=true;
  if(mode==='patch')patch=Buffer.from(Buffer.from(p.patchBase64,'base64').toString()+' ').toString('base64');
  if(mode==='base64-alias')source.responseBase64+='\n';
  assert.throws(()=>reopenNativeCandidateSource(snapshot,source,patch));
});

async function setup(t,versionRef=false){
  const f=await fixture(t),posted=post(f,'Synthetic returned edit; no provider call');
  const profile={principalId:f.principal,id:randomUUID(),revision:1n,digest:'d'.repeat(64),kind:'synthetic',isolationId:randomUUID(),ttlMs:60000};
  const reject=()=>{throw Error('No execution permitted by text import');};
  f.options.evaluationProfiles=[{profile,port:{stageCandidate:reject,startExecutor:reject,inspect:reject,requestStop:reject,readCollected:reject},evaluatorDigest:'f'.repeat(64),checkIds:['typecheck','protected-ui']}];
  f.core=new OrgManageCore(f.store,f.options);f.session=f.core.openSession(f.actor);
  const b={...binding,principalId:f.principal,missionId:posted.mission.id,commandId:posted.input.command_id,workspaceId:randomUUID(),leaseId:randomUUID()};
  const initial=createCandidateSnapshot(b,makeFiles(),[target]);
  f.core.runner.prepare({principalId:f.principal,id:b.workspaceId,profileId:profile.id,profileRevision:1n,profileDigest:profile.digest,snapshotDigest:initial.treeDigest,writeSetDigest:sha(JSON.stringify(initial.writeSet)),isolationId:profile.isolationId});
  const lease=f.core.runner.claim(f.principal,b.workspaceId,posted.mission.id,f.actor);
  const snapshot=createCandidateSnapshot({...b,leaseId:lease.id,generation:String(lease.generation)},makeFiles(),[target]);
  if(versionRef){const c=f.store.read(tx=>tx.getRecord(f.principal,posted.mission.contractRef));update(f,posted.mission.id,v=>({...v,contractRef:c.versionId}));}
  const captured=f.core.candidate.capture(f.actor,snapshot),request=makeRequest();
  return {...f,original:f,posted,lease,snapshot,captured,request,response:bytes(makeResponse(request)),requestBytes:bytes(request)};
}
const importText=f=>f.core.candidate.importNativeEdit(f.actor,f.principal,f.captured.id,f.requestBytes,f.request.digest,f.response);
const rows=f=>f.store.read(tx=>({evidence:tx.listRecord(f.principal,'evidence').length,audit:tx.listAudit(f.principal).length}));
test('native immutable contract reference remains on the same Mission through candidate planning',async t=>{
 const f=await setup(t,true),row=importText(f),plan=f.core.candidateEvaluation.prepare(f.actor,f.principal,row.id);
 assert.equal(plan.missionId,f.posted.mission.id);assert.equal(plan.contractId,f.captured.contractId);
 const current=f.store.read(tx=>JSON.parse(tx.getRecord(f.principal,f.posted.mission.id).data).contractRef);
 assert.notEqual(current,plan.contractId);
 assert.equal(f.store.read(tx=>tx.getRecordVersion(f.principal,current).id),plan.contractId);
});
for(const versionRef of [false,true])test('changed immutable contract invalidates captured candidate '+versionRef,async t=>{
 const f=await setup(t,versionRef),row=importText(f),before=rows(f);
 const id=randomUUID();const contract=f.store.transaction(tx=>{tx.insertRecord({principalId:f.principal,id,kind:'contract',revision:1n,data:'{}'});return tx.getRecord(f.principal,id);});
 update(f,f.posted.mission.id,v=>({...v,contractRef:versionRef?contract.versionId:id}));
 assert.throws(()=>importText(f),/CONTRACT_CHANGED/);
 assert.throws(()=>f.core.candidateEvaluation.prepare(f.actor,f.principal,row.id),/CONTRACT_CHANGED/);
 assert.deepEqual(rows(f),before);
});

test('Home command -> native text import -> evaluation plan persists across SQLite reopen without execution',async t=>{
  const f=await setup(t),row=importText(f),stored=f.core.candidate.readProposal(f.actor,f.principal,row.id);
  assert.deepEqual(importText(f),row);
  const plan=f.core.candidateEvaluation.prepare(f.actor,f.principal,row.id);
  assert.equal(plan.commandId,f.posted.input.command_id);assert.equal(plan.patchDigest,stored.proposal.patchDigest);
  assert.equal(plan.afterDigest,stored.proposal.after.digest);assert.equal(plan.evidenceKind,'synthetic');
  assert.deepEqual(plan.checkIds,['protected-ui','typecheck']);
  assert.equal(stored.textSource.attribution,'unverified');assert.equal(stored.status,'unverified');
  assert.equal(f.store.read(tx=>tx.runner.getLease(f.principal,f.lease.id)).dispatched,false);
  assert.equal(f.store.read(tx=>tx.listRecord(f.principal,'artifact')).length,0);
  assert.equal(f.core.candidateEvaluation.read(f.actor,f.principal,plan.id).status,'prepared');
  await f.store.close();const reopened=await LedgerStore.open(f.path);f.original.store=reopened;
  const core=new OrgManageCore(reopened,f.options);
  assert.deepEqual(core.candidate.readProposal(f.actor,f.principal,row.id),stored);
  assert.equal(core.candidateEvaluation.read(f.actor,f.principal,plan.id).plan.digest,plan.digest);
});
test('same patch with different original response bytes conflicts without replacing provenance',async t=>{
  const f=await setup(t),row=importText(f),before=rows(f);
  f.response=Buffer.from(f.response.toString()+'\n');
  assert.throws(()=>importText(f),/SOURCE_CONFLICT/);assert.deepEqual(rows(f),before);
  assert.notEqual(f.core.candidate.readProposal(f.actor,f.principal,row.id).textSource.responseDigest,sha(f.response));
});
for(const mode of ['bad-response','expired','stopped','member-regrant','contract-change','foreign-actor'])test('atomic native import rechecks '+mode,async t=>{
  const f=await setup(t);
  if(mode==='bad-response')f.response=bytes({...makeResponse(f.request),path:'tests/oracle.mjs'});
  if(mode==='expired')f.original.now=new Date(f.original.now.getTime()+60001);
  if(mode==='stopped')committed(f.core.command(f.session,bytes(control(f,f.posted.mission.scope,'pause'))));
  if(mode==='member-regrant')f.store.transaction(tx=>tx.putMembership({principalId:f.principal,actorId:f.actor,role:'owner',generation:3n}));
  if(mode==='contract-change'){
    const id=randomUUID();f.store.transaction(tx=>tx.insertRecord({principalId:f.principal,id,kind:'contract',revision:1n,data:'{}'}));
    update(f,f.posted.mission.id,v=>({...v,contractRef:id}));
  }
  if(mode==='foreign-actor')f.actor=randomUUID();
  const before=rows(f);assert.throws(()=>importText(f));assert.deepEqual(rows(f),before);
  assert.equal(f.store.read(tx=>tx.candidate.proposalForBase(f.principal,f.captured.id)),undefined);
});
test('persisted source is protected by the existing immutable evidence boundary',async t=>{
  const f=await setup(t),row=importText(f);
  assert.throws(()=>update(f,row.id,v=>({...v,textSource:{...v.textSource,responseDigest:'0'.repeat(64)}})));
  assert.equal(f.core.candidate.readProposal(f.actor,f.principal,row.id).textSource.responseDigest,sha(f.response));
});
