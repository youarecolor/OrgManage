import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fixture, post, randomUUID, OrgManageCore, LedgerStore, control, bytes, committed, update } from './fixtures/helpers.mjs';
import { createCandidateSnapshot } from '../../dist/runner/src/candidate.js';
import { LedgerOwnerError } from '../../dist/ledger/src/index.js';

const sha = v => createHash('sha256').update(v).digest('hex');
const target='apps/home/src/filter.ts';
async function setup(t) {
  const f=await fixture(t),posted=post(f,'各filterの件数を表示する合成fixture');
  const profile={principalId:f.principal,id:randomUUID(),revision:1n,digest:'d'.repeat(64),kind:'synthetic',isolationId:randomUUID(),ttlMs:60000};
  const reject=()=>{throw new Error('Candidate persistence must not start a Runner');};
  f.options.runnerProfiles=[{profile,port:{startExecutor:reject,inspect:reject,requestStop:reject}}];
  f.core=new OrgManageCore(f.store,f.options);f.session=f.core.openSession(f.actor);
  const binding={principalId:f.principal,missionId:posted.mission.id,commandId:posted.input.command_id,workspaceId:randomUUID(),leaseId:randomUUID(),generation:'2',profileDigest:profile.digest};
  const files=[{path:target,text:'export const count = 0;\n'},{path:'tests/protected.mjs',text:'protected oracle'}];
  const before=createCandidateSnapshot(binding,files,[target]);
  const workspace=f.core.runner.prepare({principalId:f.principal,id:binding.workspaceId,profileId:profile.id,profileRevision:1n,profileDigest:profile.digest,snapshotDigest:before.treeDigest,writeSetDigest:sha(JSON.stringify(before.writeSet)),isolationId:profile.isolationId});
  const lease=f.core.runner.claim(f.principal,workspace.id,posted.mission.id,f.actor);
  const snapshot=createCandidateSnapshot({...binding,leaseId:lease.id,generation:String(lease.generation)},files,[target]);
  const patch={version:'CANDIDATE-PATCH-v1',baseDigest:snapshot.digest,changes:[{path:target,beforeDigest:snapshot.files.find(f=>f.path===target).digest,text:'export const count = 1;\n'}]};
  return {...f,posted,profile,workspace,lease,snapshot,patch,original:f};
}
const capture=f=>f.core.candidate.capture(f.actor,f.snapshot);
const imported=(f,b)=>f.core.candidate.importPatch(f.actor,f.principal,b.id,bytes(f.patch));
const rows=f=>f.store.read(tx=>({evidence:tx.listRecord(f.principal,'evidence').length,audit:tx.listAudit(f.principal).length}));

test('Home source command -> bound snapshot -> patch persists across restart without execution or adoption',async t=>{
  const f=await setup(t),b=capture(f),p=imported(f,b);
  assert.equal(b.commandId,f.posted.input.command_id);assert.equal(b.contractId,f.posted.mission.contractRef);
  assert.deepEqual(capture(f),b);assert.deepEqual(imported(f,b),p);
  const result=f.core.candidate.readProposal(f.actor,f.principal,p.id);
  assert.equal(result.status,'unverified');assert.equal(result.proposal.after.files.find(f=>f.path===target).text,f.patch.changes[0].text);
  assert.equal(f.store.read(tx=>tx.runner.getLease(f.principal,f.lease.id)).dispatched,false);
  assert.equal(f.store.read(tx=>tx.listRecord(f.principal,'artifact')).length,0);
  await f.store.close();const reopened=await LedgerStore.open(f.path);f.original.store=reopened;
  const core=new OrgManageCore(reopened,f.options);
  assert.deepEqual(core.candidate.readProposal(f.actor,f.principal,p.id),result);
  assert.equal(reopened.read(tx=>tx.runner.getLease(f.principal,f.lease.id)).state,'quarantined');
  assert.throws(()=>core.candidate.importPatch(f.actor,f.principal,b.id,bytes(f.patch)),/LEASE_DENIED/);
});
test('conflicting patch and rejected source leave neither evidence or audit orphans',async t=>{
  const f=await setup(t),b=capture(f),p=imported(f,b),old=rows(f);
  const other=structuredClone(f.patch);other.changes[0].text='export const count = 2;\n';
  assert.throws(()=>f.core.candidate.importPatch(f.actor,f.principal,b.id,bytes(other)),/PATCH_CONFLICT/);
  const protectedPatch=structuredClone(f.patch);protectedPatch.changes[0].path='tests/protected.mjs';
  assert.throws(()=>f.core.candidate.importPatch(f.actor,f.principal,b.id,bytes(protectedPatch)));
  assert.deepEqual(rows(f),old);assert.equal(f.core.candidate.readProposal(f.actor,f.principal,p.id).record.id,p.id);
});
for(const reason of ['deadline','scope-stop','membership-regrant','contract-revision','dispatched'])test(`candidate import rechecks ${reason}`,async t=>{
  const f=await setup(t),b=capture(f),before=rows(f);
  if(reason==='deadline')f.original.now=new Date(f.original.now.getTime()+60001);
  if(reason==='scope-stop')committed(f.core.command(f.session,bytes(control(f,f.posted.mission.scope,'pause'))));
  if(reason==='membership-regrant')f.store.transaction(tx=>tx.putMembership({principalId:f.principal,actorId:f.actor,role:'owner',generation:3n}));
  if(reason==='contract-revision'){
    const contract=randomUUID();f.store.transaction(tx=>tx.insertRecord({principalId:f.principal,id:contract,kind:'contract',revision:1n,data:'{}'}));
    update(f,f.posted.mission.id,m=>({...m,contractRef:contract}));
  }
  if(reason==='dispatched')f.store.transaction(tx=>tx.runner.updateLease({...f.lease,dispatched:true,revision:2n},1n));
  const current=rows(f);
  assert.throws(()=>imported(f,b));assert.deepEqual(rows(f),current);
  assert.equal(current.evidence,before.evidence);
});
test('foreign actor, source command and forged snapshot cannot capture a base',async t=>{
  const f=await setup(t);
  assert.throws(()=>f.core.candidate.capture(randomUUID(),f.snapshot),/ACTOR_DENIED/);
  assert.throws(()=>f.core.candidate.capture(f.actor,structuredClone(f.snapshot)),/UNSEALED_BASE/);
  const other=post(f),foreign=createCandidateSnapshot({...f.snapshot.binding,commandId:other.input.command_id},f.snapshot.files,f.snapshot.writeSet);
  assert.throws(()=>f.core.candidate.capture(f.actor,foreign),/SOURCE_COMMAND_MISMATCH/);
  assert.equal(f.store.read(tx=>tx.candidate.listBases(f.principal,f.posted.mission.id)).length,0);
});
test('SQL relations reject foreign lease, wrong generation and immutable link updates; callbacks confined',async t=>{
  const f=await setup(t),b=capture(f),p=imported(f,b);
  let api;f.store.read(tx=>{api=tx.candidate;assert.equal('run' in api,false);assert.equal('get' in api,false);assert.throws(()=>api.insertBase(b),LedgerOwnerError);});
  assert.throws(()=>api.getBase(f.principal,b.id),LedgerOwnerError);
  const raw=new DatabaseSync(f.path,{enableForeignKeyConstraints:true});t.after(()=>raw.close());
  assert.throws(()=>raw.prepare('UPDATE candidate_bases SET generation=generation+1 WHERE id=?').run(b.id));
  assert.throws(()=>raw.prepare('DELETE FROM candidate_proposals WHERE id=?').run(p.id));
  for(const field of ['generation','workspaceId','leaseId','profileDigest','contractId']){
    const changed={...b,id:randomUUID()};changed[field]=field==='generation'?b.generation+1n:field==='profileDigest'?'0'.repeat(64):randomUUID();
    assert.throws(()=>f.store.transaction(tx=>{
      const old=tx.getRecord(f.principal,b.id);tx.insertRecord({principalId:f.principal,id:changed.id,kind:'evidence',revision:1n,data:old.data});tx.candidate.insertBase(changed);
    }));
  }
  assert.equal(raw.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(),[]);
});
test('another Principal cannot attach a proposal or read its private snapshot',async t=>{
  const f=await setup(t),b=capture(f),p=imported(f,b),foreign=randomUUID();
  assert.throws(()=>f.core.candidate.readProposal(f.actor,foreign,p.id),/ACTOR_DENIED/);
  assert.throws(()=>f.core.candidate.readProposal(randomUUID(),f.principal,p.id),/ACTOR_DENIED/);
  assert.throws(()=>f.store.transaction(tx=>tx.candidate.insertProposal({...p,principalId:foreign,id:randomUUID()})));
});
