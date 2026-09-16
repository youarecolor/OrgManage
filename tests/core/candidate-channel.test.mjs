import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {CandidateChannelPort} from '../../dist/runner/src/candidate-channel.js';
import {createCandidateSnapshot,importCandidatePatch,candidateSnapshotBytes} from '../../dist/runner/src/candidate.js';
import {openCandidateTransfer} from '../../dist/runner/src/candidate-transfer.js';
const sha=v=>createHash('sha256').update(v).digest('hex'),bytes=v=>Buffer.from(JSON.stringify(v));
function fixture(){
  const target='apps/home/src/filter.ts',profileDigest='a'.repeat(64),evaluatorDigest='b'.repeat(64),isolationId=randomUUID();
  const b={principalId:randomUUID(),missionId:randomUUID(),commandId:randomUUID(),workspaceId:randomUUID(),leaseId:randomUUID(),generation:'2',profileDigest};
  const base=createCandidateSnapshot(b,[{path:target,text:'export const count=0;\n'}],[target]);
  const patch=bytes({version:'CANDIDATE-PATCH-v1',baseDigest:base.digest,changes:[{path:target,beforeDigest:base.files[0].digest,text:'throw Error("not executed by transport");'}]});
  const proposal=importCandidatePatch(base,patch),attemptId=randomUUID(),ownerId=randomUUID(),contractId=randomUUID();
  const body={version:'CANDIDATE-EVALUATION-PLAN-v1',id:randomUUID(),principalId:b.principalId,proposalId:randomUUID(),actorId:randomUUID(),missionId:b.missionId,commandId:b.commandId,contractId,leaseId:b.leaseId,workspaceId:b.workspaceId,generation:'2',baseDigest:base.digest,baseTreeDigest:base.treeDigest,writeSetDigest:sha(JSON.stringify(base.writeSet)),patchDigest:proposal.patchDigest,afterDigest:proposal.after.digest,afterTreeDigest:proposal.after.treeDigest,profileDigest,registrationDigest:'c'.repeat(64),evaluatorDigest,checkIds:['protected-test'],evidenceKind:'synthetic',authority:JSON.stringify({actorGeneration:'1',scopes:[{id:b.missionId,epoch:'1'}],contractId,ownerId,ownerEpoch:'1'}),createdAt:100};
  const plan={...body,digest:sha(JSON.stringify(body))};
  const binding={principalId:b.principalId,leaseId:b.leaseId,workspaceId:b.workspaceId,generation:'2',ownerId,ownerEpoch:'1',stopEpoch:'0',profileDigest,isolationId};
  const profile={principalId:b.principalId,isolationId,profileDigest,evaluatorDigest,evidenceKind:'synthetic'};
  const calls=[],fault={};
  const channel={async dispatch(r){calls.push(r);if(fault.reject)throw Error('Unknown transport');if(fault.delay)await fault.delay;
    const value={...r.binding,status:'stopped',kind:'synthetic',handlesSignaled:true,jobEmpty:true,writesStable:true,detail:{observed:'synthetic only'}};
    if(fault.field)value[fault.field]=fault.value;
    return fault.raw??bytes(value);
  },async collect(expected){calls.push({operation:'collect',expected});return fault.collected??candidateSnapshotBytes(proposal.after);}};
  const port=new CandidateChannelPort(profile,channel),stage=()=>port.stageCandidate(plan,proposal,attemptId,patch.toString('base64'));
  return {base,patch,proposal,attemptId,plan,binding,profile,channel,port,stage,calls,fault};
}
test('staging is inert and retains original patch bytes; only first start carries source',async()=>{
  const f=fixture();f.stage();f.stage();assert.equal(f.calls.length,0);
  await f.port.startExecutor(f.binding);
  const r=f.calls[0],opened=openCandidateTransfer(r.transfer,r.expected);assert.equal(opened.patchBase64,f.patch.toString('base64'));assert.equal(opened.proposal.after.digest,f.plan.afterDigest);
  r.transfer.fill(0);await f.port.inspect(f.binding);assert.equal(Object.hasOwn(f.calls[1],'transfer'),false);
  assert.deepEqual(await f.port.readCollected(f.plan,f.attemptId),candidateSnapshotBytes(f.proposal.after));
  await assert.rejects(f.port.startExecutor(f.binding),/RECONCILE_BEFORE_RETRY/);assert.equal(f.calls.filter(c=>c.operation==='start').length,1);
});
test('unknown start is never replayed even after staging the same attempt again',async()=>{
  const f=fixture();f.stage();f.fault.reject=true;await assert.rejects(f.port.startExecutor(f.binding),/Unknown/);
  f.stage();f.fault.reject=false;await assert.rejects(f.port.startExecutor(f.binding),/RECONCILE_BEFORE_RETRY/);
  await f.port.inspect(f.binding);await f.port.requestStop({...f.binding,stopEpoch:'1'});
  assert.deepEqual(f.calls.map(c=>c.operation),['start','inspect','stop']);
});
test('scope mutation after dispatch cannot retarget the request or its validation',async()=>{
  const f=fixture();f.stage();let release;f.fault.delay=new Promise(r=>{release=r;});
  const original={...f.binding},pending=f.port.startExecutor(f.binding);f.binding.stopEpoch='1';f.binding.ownerId=randomUUID();release();
  assert.equal(JSON.parse(await pending).ownerId,original.ownerId);assert.equal(f.calls[0].binding.stopEpoch,'0');
  assert.equal(Object.isFrozen(f.calls[0].binding),true);
});
for(const field of ['principalId','leaseId','workspaceId','generation','ownerId','ownerEpoch','stopEpoch','profileDigest','isolationId'])test('refuses foreign/stopped start '+field+' before transport',async()=>{
  const f=fixture();f.stage();const value=field==='generation'||field==='ownerEpoch'?'3':field==='stopEpoch'?'1':field==='profileDigest'?'0'.repeat(64):randomUUID();
  await assert.rejects(f.port.startExecutor({...f.binding,[field]:value}));assert.equal(f.calls.length,0);
});
for(const field of ['ownerId','stopEpoch','kind','handlesSignaled','extra'])test('refuses mismatched/malformed observation '+field,async()=>{
  const f=fixture();f.stage();f.fault.field=field;f.fault.value=field==='handlesSignaled'?'yes':field==='kind'?'fixed_guest_fixture':field==='stopEpoch'?'1':'unexpected';
  await assert.rejects(f.port.startExecutor(f.binding),/OBSERVATION/);assert.equal(f.calls.length,1);
});
test('preserves unknown status and false stop predicates rather than inferring success',async()=>{
  const f=fixture();f.stage();f.fault.raw=bytes({...f.binding,status:'unknown',kind:'synthetic',handlesSignaled:false,jobEmpty:false,writesStable:false,detail:null});
  const r=JSON.parse(await f.port.startExecutor(f.binding));assert.equal(r.status,'unknown');assert.equal(r.handlesSignaled,false);assert.equal(r.detail,null);
});
for(const raw of [Buffer.alloc(16385),new Uint8Array(new SharedArrayBuffer(1)),Buffer.from('{"status":"x","status":"y"}')])test('refuses oversize/shared/duplicate response',async()=>{
  const f=fixture();f.stage();f.fault.raw=raw;await assert.rejects(f.port.startExecutor(f.binding));
});
test('collection cannot substitute base bytes, another plan or another attempt',async()=>{
  const f=fixture();f.stage();f.fault.collected=candidateSnapshotBytes(f.base);
  await assert.rejects(f.port.readCollected(f.plan,f.attemptId));
  await assert.rejects(f.port.readCollected({...f.plan,digest:'0'.repeat(64)},f.attemptId),/NOT_STAGED/);
  await assert.rejects(f.port.readCollected(f.plan,randomUUID()),/NOT_STAGED/);
  assert.equal(f.calls.length,1);
});
test('profile pins and same-lease attempt cannot be replaced by staging',()=>{
  const f=fixture();f.stage();assert.throws(()=>f.port.stageCandidate({...f.plan,evaluatorDigest:'0'.repeat(64)},f.proposal,f.attemptId,f.patch.toString('base64')),/PROFILE/);
  assert.throws(()=>f.port.stageCandidate(f.plan,f.proposal,randomUUID(),f.patch.toString('base64')),/LEASE_CONFLICT/);
  assert.equal(f.calls.length,0);
});
test('no unstaged operations or default channel; caller cannot replace captured transport methods',async()=>{
  const f=fixture();assert.throws(()=>new CandidateChannelPort(f.profile,{}),/CHANNEL/);
  await assert.rejects(f.port.startExecutor(f.binding),/NOT_STAGED/);await assert.rejects(f.port.readCollected(f.plan,f.attemptId),/NOT_STAGED/);
  f.channel.dispatch=()=>{throw Error('Replaced method must not run');};f.stage();await f.port.startExecutor(f.binding);assert.equal(f.calls.length,1);
});
