import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync,linkSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {materializeCandidateTransfer,inspectMaterializedCandidate} from '../../dist/runner/src/candidate-materialize.js';
import {createCandidateSnapshot,importCandidatePatch,candidateSnapshotBytes} from '../../dist/runner/src/candidate.js';
import {createCandidateTransfer,openCandidateTransfer,assertCandidateTransferBinding,CANDIDATE_TRANSFER_LIMIT} from '../../dist/runner/src/candidate-transfer.js';
const sha=x=>createHash('sha256').update(x).digest('hex');
function parent(){const root=join(process.cwd(),'.private','test-runs');mkdirSync(root,{recursive:true});return mkdtempSync(join(root,'materialize-test-'));}
function fixture(){
  const target='apps/home/src/filter.ts';
  const b={principalId:randomUUID(),missionId:randomUUID(),commandId:randomUUID(),workspaceId:randomUUID(),leaseId:randomUUID(),generation:'2',profileDigest:'d'.repeat(64)};
  const base=createCandidateSnapshot(b,[{path:target,text:'export const count = 0;\n'},{path:'tests/protected.mjs',text:'protected; never imported'}],[target]);
  const patch=Buffer.from(JSON.stringify({version:'CANDIDATE-PATCH-v1',baseDigest:base.digest,changes:[{path:target,beforeDigest:base.files.find(f=>f.path===target).digest,text:'export const count = 1;\n'}]},null,2)+'\n');
  const proposal=importCandidatePatch(base,patch),ownerId=randomUUID(),contractId=randomUUID(),isolationId=randomUUID(),attemptId=randomUUID();
  const body={version:'CANDIDATE-EVALUATION-PLAN-v1',id:randomUUID(),principalId:b.principalId,proposalId:randomUUID(),actorId:'S-1-5-21-1-2-3-1001',missionId:b.missionId,commandId:b.commandId,contractId,leaseId:b.leaseId,workspaceId:b.workspaceId,generation:'2',baseDigest:base.digest,baseTreeDigest:base.treeDigest,writeSetDigest:sha(JSON.stringify(base.writeSet)),patchDigest:proposal.patchDigest,afterDigest:proposal.after.digest,afterTreeDigest:proposal.after.treeDigest,profileDigest:b.profileDigest,registrationDigest:'c'.repeat(64),evaluatorDigest:'e'.repeat(64),checkIds:['build','protected-test','typecheck'],evidenceKind:'synthetic',authority:JSON.stringify({actorGeneration:'1',scopes:[{id:b.missionId,epoch:'1'}],contractId,ownerId,ownerEpoch:'3'}),createdAt:1000};
  const plan={...body,digest:sha(JSON.stringify(body))};
  const expected={planDigest:plan.digest,attemptId,profileDigest:plan.profileDigest,evaluatorDigest:plan.evaluatorDigest};
  const binding={principalId:b.principalId,leaseId:b.leaseId,workspaceId:b.workspaceId,generation:'2',ownerId,ownerEpoch:'3',stopEpoch:'0',profileDigest:b.profileDigest,isolationId};
  const wire=createCandidateTransfer(plan,proposal,attemptId,patch.toString('base64'));
  return {base,patch,proposal,plan,expected,binding,isolationId,wire};
}
test('exact original patch bytes survive transfer; verifier reconstructs the same sealed result',()=>{
  const f=fixture(),out=openCandidateTransfer(f.wire,f.expected);
  assert.deepEqual(Buffer.from(out.patchBase64,'base64'),f.patch);
  assert.deepEqual(out.proposal,f.proposal);
  assert.equal(out.proposal.status,'unverified');
  assert.equal(out.wireDigest,sha(f.wire));
  assertCandidateTransferBinding(out,f.binding,f.isolationId,'start');
  assert.equal(Object.isFrozen(out.plan),true);assert.equal(Object.isFrozen(out.plan.checkIds),true);
});
test('caller byte mutation after reopening cannot change the sealed transfer',()=>{
  const f=fixture(),out=openCandidateTransfer(f.wire,f.expected),digest=out.proposal.after.digest;
  f.wire.fill(0);assert.equal(out.proposal.after.digest,digest);assert.throws(()=>out.plan.checkIds.push('arbitrary'));
});
for(const key of ['planDigest','attemptId','profileDigest','evaluatorDigest'])test('reject independently expected '+key+' mismatch',()=>{
  const f=fixture();assert.throws(()=>openCandidateTransfer(f.wire,{...f.expected,[key]:key==='attemptId'?randomUUID():'0'.repeat(64)}));
});
for(const mode of ['plan-edit','extra-field','after-as-base','patch-reformatted','noncanonical-base64','unexpected-check'])test('reject transfer alteration '+mode,()=>{
  const f=fixture(),data=JSON.parse(f.wire);
  if(mode==='plan-edit')data.plan.generation='3';
  if(mode==='extra-field')data.command='cmd.exe';
  if(mode==='after-as-base')data.baseBase64=Buffer.from(candidateSnapshotBytes(f.proposal.after)).toString('base64');
  if(mode==='patch-reformatted')data.patchBase64=Buffer.from(JSON.stringify(JSON.parse(f.patch))).toString('base64');
  if(mode==='noncanonical-base64')data.patchBase64+='\n';
  if(mode==='unexpected-check')data.plan.checkIds=['attacker-oracle'];
  assert.throws(()=>openCandidateTransfer(Buffer.from(JSON.stringify(data)),f.expected));
});
test('wire bounds and duplicate keys are rejected before interpreting payload',()=>{
  const f=fixture();
  assert.throws(()=>openCandidateTransfer(Buffer.alloc(CANDIDATE_TRANSFER_LIMIT+1),f.expected),/SIZE/);
  assert.throws(()=>openCandidateTransfer(new Uint8Array(new SharedArrayBuffer(1)),f.expected),/SIZE/);
  assert.throws(()=>openCandidateTransfer(Buffer.from('{"version":"a","version":"b"}'),f.expected),/JSON/);
});
for(const key of ['principalId','leaseId','workspaceId','generation','ownerId','ownerEpoch','profileDigest','isolationId'])test('Runner cannot use transfer with another '+key,()=>{
  const f=fixture(),out=openCandidateTransfer(f.wire,f.expected);
  const different=key==='generation'||key==='ownerEpoch'?'4':key==='profileDigest'?'0'.repeat(64):randomUUID();
  assert.throws(()=>assertCandidateTransferBinding(out,{...f.binding,[key]:different},f.isolationId,'start'));
});
test('stop generation prevents start but allows read/stop for the same owner',()=>{
  const f=fixture(),out=openCandidateTransfer(f.wire,f.expected),stopped={...f.binding,stopEpoch:'1'};
  assert.throws(()=>assertCandidateTransferBinding(out,stopped,f.isolationId,'start'));
  assertCandidateTransferBinding(out,stopped,f.isolationId,'inspect');
  assertCandidateTransferBinding(out,stopped,f.isolationId,'stop');
});
test('candidate program remains text even if it would throw on execution',()=>{
  const f=fixture(),target=f.base.writeSet[0],file=f.base.files.find(x=>x.path===target);
  const patch=Buffer.from(JSON.stringify({version:'CANDIDATE-PATCH-v1',baseDigest:f.base.digest,changes:[{path:target,beforeDigest:file.digest,text:'throw new Error("MUST NEVER EXECUTE DURING TRANSFER");'}]}));
  const proposal=importCandidatePatch(f.base,patch);
  const {digest,...body}=f.plan;Object.assign(body,{patchDigest:proposal.patchDigest,afterDigest:proposal.after.digest,afterTreeDigest:proposal.after.treeDigest});
  const plan={...body,digest:sha(JSON.stringify(body))};
  const wire=createCandidateTransfer(plan,proposal,f.expected.attemptId,patch.toString('base64'));
  const out=openCandidateTransfer(wire,{...f.expected,planDigest:plan.digest});
  assert.match(out.proposal.after.files.find(x=>x.path===target).text,/MUST NEVER EXECUTE/);
});
test('materialize exact base/patch/after files, reopen independently, refuse duplicate attempt',()=>{
  const f=fixture(),root=parent(),receipt=materializeCandidateTransfer(root,f.wire,f.expected,1001);
  const opened=inspectMaterializedCandidate(root,f.expected);
  assert.deepEqual(opened.receipt,receipt);assert.equal(receipt.candidateExecuted,false);
  assert.equal(readFileSync(join(root,f.expected.attemptId,'base','apps','home','src','filter.ts'),'utf8'),'export const count = 0;\n');
  assert.equal(readFileSync(join(root,f.expected.attemptId,'after','apps','home','src','filter.ts'),'utf8'),'export const count = 1;\n');
  assert.throws(()=>materializeCandidateTransfer(root,f.wire,f.expected,1002),/EEXIST/);
});
for(const fault of ['changed-file','added-file','changed-snapshot','changed-receipt','hardlink'])test('materialized readback refuses '+fault,()=>{
  const f=fixture(),root=parent();materializeCandidateTransfer(root,f.wire,f.expected,1001);
  const target=join(root,f.expected.attemptId),file=join(target,'after','apps','home','src','filter.ts');
  if(fault==='changed-file')writeFileSync(file,'tampered');
  if(fault==='added-file')writeFileSync(join(target,'after','extra.txt'),'extra');
  if(fault==='changed-snapshot')writeFileSync(join(target,'after.snapshot.json'),'{}');
  if(fault==='changed-receipt')writeFileSync(join(target,'materialization.json'),'{}');
  if(fault==='hardlink')linkSync(file,join(root,'linked.ts'));
  assert.throws(()=>inspectMaterializedCandidate(root,f.expected));
});
test('invalid attempt cannot escape parent and earlier application time cannot create a directory',()=>{
  const f=fixture(),root=parent();
  assert.throws(()=>inspectMaterializedCandidate(root,{...f.expected,attemptId:'../outside'}),/ATTEMPT/);
  assert.throws(()=>materializeCandidateTransfer(root,f.wire,f.expected,999),/TIME_BEFORE_PLAN/);
  materializeCandidateTransfer(root,f.wire,f.expected,1001);
});
