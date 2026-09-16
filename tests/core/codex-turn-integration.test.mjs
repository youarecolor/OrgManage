import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,randomUUID,post,control,bytes,committed,snap} from './fixtures/helpers.mjs';
async function nativeFixture(t){
  const f=await fixture(t),mission=post(f).mission,id=randomUUID();
  f.store.transaction(tx=>tx.insertRecord({principalId:f.principal,id,kind:'contract',revision:1n,data:JSON.stringify({mode:'codex_protocol_rehearsal',scopeId:mission.id})}));
  const a=f.core.codex.prepare({mode:'synthetic',principalId:f.principal,actorId:f.actor,scopeId:mission.id,contractVersion:f.store.read(tx=>tx.getRecord(f.principal,id).versionId),accountRoute:'test-account',model:'test-model',effort:'max',input:'Synthetic.',threadId:'test-thread',profileDigest:'a'.repeat(64),expiresAt:f.now.getTime()+1000});
  return {f,mission,a,read:()=>f.store.read(tx=>tx.native.getAttempt(f.principal,a.id))};
}
for(const scope of ['mission','application'])test(`Home ${scope} stop commits native cancellation without claiming provider stop`,async t=>{
  const {f,mission,a,read}=await nativeFixture(t);f.core.codex.acquireStart(f.principal,a.id);
  const target=scope==='mission'?mission.scope:snap(f).application;
  committed(f.core.command(f.session,bytes(control(f,target,scope==='mission'?'pause':'halt_dispatch'))));
  assert.equal(read().state,'send_intent');assert.equal(read().cancellation,'requested');assert.equal(read().turnId,null);
});
test('existing core maintenance also fences an expired unsent native attempt',async t=>{
  const {f,read}=await nativeFixture(t);f.now=new Date(f.now.getTime()+1001);f.core.maintain();assert.equal(read().state,'discarded');
});
