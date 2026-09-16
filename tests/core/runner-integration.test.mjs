import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,OrgManageCore,randomUUID,post,control,bytes,committed,snap} from './fixtures/helpers.mjs';

test('Home scope stop persists its Runner stop request in the same command transaction',async t=>{
  const f=await fixture(t);const mission=post(f).mission;
  const profile={principalId:f.principal,id:randomUUID(),revision:1n,digest:'d'.repeat(64),kind:'synthetic',isolationId:randomUUID(),ttlMs:1000};
  const stopped=b=>Buffer.from(JSON.stringify({...b,status:'stopped',kind:'synthetic',handlesSignaled:true,jobEmpty:true,writesStable:true,detail:{fixture:'core-stop'}}));
  f.core=new OrgManageCore(f.store,{...f.options,runnerProfiles:[{profile,port:{startExecutor:stopped,requestStop:stopped,inspect:stopped}}]});f.session=f.core.openSession(f.actor);
  const w=f.core.runner.prepare({principalId:f.principal,id:randomUUID(),profileId:profile.id,profileRevision:1n,profileDigest:profile.digest,snapshotDigest:'e'.repeat(64),writeSetDigest:'f'.repeat(64),isolationId:profile.isolationId});
  const l=f.core.runner.claim(f.principal,w.id,mission.id,f.actor);
  committed(f.core.command(f.session,bytes(control(f,mission.scope,'pause'))));
  assert.equal(f.store.read(tx=>tx.runner.getLease(f.principal,l.id)).state,'stop_requested');
  assert.equal(f.store.read(tx=>tx.runner.getLease(f.principal,l.id)).observationId,null);
  assert.equal(snap(f).missions.find(m=>m.id===mission.id).scope.state,'paused');
  await assert.rejects(f.core.runner.startExecutor(f.principal,l.id));
  assert.equal((await f.core.runner.reconcile(f.principal,l.id,true)).state,'released');
});

test('candidate profile cannot be registered through the fixed Runner constructor',async t=>{
  const f=await fixture(t);assert.throws(()=>new OrgManageCore(f.store,{...f.options,runnerProfiles:[{profile:{principalId:f.principal,id:randomUUID(),revision:1n,digest:'a'.repeat(64),kind:'candidate',isolationId:randomUUID(),ttlMs:1000},port:{}}]}),/Invalid fixed profile/);
});
