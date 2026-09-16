import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,post,randomUUID,LedgerStore} from './fixtures/helpers.mjs';
import {ResourceCoordinator} from '../../dist/core/src/resources.js';
import {CodexTurnCoordinator} from '../../dist/core/src/codex-turn.js';

async function setup(t){
 const f=await fixture(t),mission=post(f).mission,contract=randomUUID(),evidence=randomUUID();
 f.store.transaction(tx=>{
  tx.insertRecord({principalId:f.principal,id:contract,kind:'contract',revision:1n,data:JSON.stringify({mode:'codex_protocol_rehearsal',scopeId:mission.id})});
  tx.insertRecord({principalId:f.principal,id:evidence,kind:'evidence',revision:1n,data:'{"source":"synthetic"}'});
 });
 const start=f.now.getTime()-1,pool={kind:'quota',provider:'test',account:'shared-test',pool:'main',unit:'units',freshnessMs:300000,windows:[{id:'short',revision:'1',startsAt:start,resetsAt:start+600000},{id:'week',revision:'1',startsAt:start,resetsAt:start+1200000}]};
 const quota=new ResourceCoordinator(f.store,pool,()=>f.now.getTime());
 const observe=(n='10')=>quota.observe(f.principal,f.actor,pool.windows.map(w=>({windowId:w.id,revision:w.revision,remaining:n,observedAt:f.now.getTime(),evidenceId:evidence,reflectedHoldIds:[]})));
 observe();
 const request={mode:'synthetic',principalId:f.principal,actorId:f.actor,scopeId:mission.id,contractVersion:f.store.read(tx=>tx.getRecord(f.principal,contract).versionId),accountRoute:'shared-test',model:'fixture',effort:'low',input:'Synthetic only.',threadId:'fixture-thread',profileDigest:'c'.repeat(64),expiresAt:f.now.getTime()+60000};
 const prepare=(amount='2')=>f.core.codex.prepareWithResource(request,quota,{short:amount,week:amount});
 const state=result=>f.store.read(tx=>({attempt:tx.native.getAttempt(f.principal,result.attempt.id),hold:JSON.parse(tx.getRecord(f.principal,result.holdId).data),audits:tx.listAudit(f.principal).filter(a=>a.entityId===result.attempt.id)}));
 return {f,mission,pool,quota,request,prepare,state,observe};
}
test('native Run/Attempt and all-window reservation roll back together on capacity failure',async t=>{
 const x=await setup(t);const before=x.f.store.read(tx=>({runs:tx.listRecord(x.f.principal,'run').length,attempts:tx.listRecord(x.f.principal,'attempt').length,audits:tx.listAudit(x.f.principal).length}));
 assert.throws(()=>x.prepare('11'),/CAPACITY_EXCEEDED/);
 const after=x.f.store.read(tx=>({runs:tx.listRecord(x.f.principal,'run').length,attempts:tx.listRecord(x.f.principal,'attempt').length,audits:tx.listAudit(x.f.principal).length}));
 assert.deepEqual(after,before);assert.equal(x.f.store.read(tx=>tx.native.listAttempts(x.f.principal)).length,0);
 assert.equal(x.f.store.read(tx=>tx.listRecord(x.f.principal,'resource_hold')).length,0);
});
test('send_intent, audit and reservation roll back together when quota falls after prepare',async t=>{
 const x=await setup(t),r=x.prepare(),before=x.state(r);x.f.now=new Date(x.f.now.getTime()+1);x.observe('1');
 assert.throws(()=>x.f.core.codex.acquireStartWithResource(x.f.principal,r.attempt.id,x.quota,r.holdId),/CAPACITY_EXCEEDED/);
 assert.deepEqual(x.state(r),before);
});
test('quota-bound attempts cannot escape through the legacy unreserved send method',async t=>{
 const x=await setup(t),r=x.prepare();assert.throws(()=>x.f.core.codex.acquireStart(x.f.principal,r.attempt.id),/CODEX_TURN_DENIED/);
 assert.equal(x.state(r).attempt.state,'prepared');assert.equal(x.state(r).hold.state,'reserved');
});
test('one committed acquisition carries exact effect and rejects second acquisition after reopen',async t=>{
 const x=await setup(t),r=x.prepare(),wire=x.f.core.codex.acquireStartWithResource(x.f.principal,r.attempt.id,x.quota,r.holdId);
 assert.equal(wire.kind,'synthetic');assert.equal(wire.request.id,`start:${r.attempt.id}`);
 const s=x.state(r);assert.equal(s.attempt.state,'send_intent');assert.equal(s.hold.state,'send_acquired');assert.equal(s.hold.effectId,r.attempt.id);
 assert.equal(s.audits.filter(a=>a.kind==='codex.send_intent').length,1);
 assert.throws(()=>x.f.core.codex.acquireStartWithResource(x.f.principal,r.attempt.id,x.quota,r.holdId));
 await x.f.store.close();x.f.store=await LedgerStore.open(x.f.path);
 const core=new CodexTurnCoordinator(x.f.store,()=>x.f.now.getTime()),quota=new ResourceCoordinator(x.f.store,x.pool,()=>x.f.now.getTime());
 assert.equal(x.f.store.read(tx=>tx.native.getAttempt(x.f.principal,r.attempt.id)).state,'unknown');
 assert.throws(()=>core.acquireStartWithResource(x.f.principal,r.attempt.id,quota,r.holdId));
 assert.equal(JSON.parse(x.f.store.read(tx=>tx.getRecord(x.f.principal,r.holdId)).data).state,'send_acquired');
});
test('a valid reservation for a different Attempt cannot fund this send',async t=>{
 const x=await setup(t),other=randomUUID();x.f.store.transaction(tx=>tx.insertRecord({principalId:x.f.principal,id:other,kind:'attempt',revision:1n,data:JSON.stringify({scopeId:x.mission.id})}));
 const wrong=x.quota.reserve(x.f.principal,x.f.actor,x.mission.id,'attempt',other,{short:'1',week:'1'}),r=x.prepare(),before=x.state(r);
 assert.throws(()=>x.f.core.codex.acquireStartWithResource(x.f.principal,r.attempt.id,x.quota,wrong),/EFFECT_BINDING_MISMATCH/);
 assert.deepEqual(x.state(r),before);assert.equal(JSON.parse(x.f.store.read(tx=>tx.getRecord(x.f.principal,wrong)).data).state,'reserved');
});
test('different resource account/profile cannot replace the bound pool',async t=>{
 const x=await setup(t),r=x.prepare(),other=new ResourceCoordinator(x.f.store,{...x.pool,account:'other-account'},()=>x.f.now.getTime());
 assert.throws(()=>x.f.core.codex.acquireStartWithResource(x.f.principal,r.attempt.id,other,r.holdId),/CODEX_TURN_DENIED/);
 assert.equal(x.state(r).attempt.state,'prepared');
});
test('transaction composition rejects another store, reader and escaped callback',async t=>{
 const x=await setup(t),other=await fixture(t),r=x.prepare();
 const act=tx=>x.quota.acquireSendInTransaction(tx,x.f.principal,x.f.actor,r.holdId,{scopeId:x.mission.id,effectKind:'attempt',effectId:r.attempt.id});
 assert.throws(()=>other.store.transaction(act),/Active transaction/);
 assert.throws(()=>x.f.store.read(act),/Active transaction/);
 let escaped;x.f.store.transaction(tx=>{escaped=tx;});assert.throws(()=>act(escaped),/Active transaction/);
 assert.equal(x.state(r).hold.state,'reserved');
});
test('failed later transaction work rolls a quota acquisition back and keeps retry safe',async t=>{
 const x=await setup(t),r=x.prepare(),before=x.state(r);
 assert.throws(()=>x.f.store.transaction(tx=>{
  x.quota.acquireSendInTransaction(tx,x.f.principal,x.f.actor,r.holdId,{scopeId:x.mission.id,effectKind:'attempt',effectId:r.attempt.id});
  throw Error('injected downstream failure');
 }),/injected/);
 assert.deepEqual(x.state(r),before);assert.equal(x.f.core.codex.acquireStartWithResource(x.f.principal,r.attempt.id,x.quota,r.holdId).kind,'synthetic');
});
test('new atomic APIs still reject a live mode and never grant provider access',async t=>{
 const x=await setup(t);assert.throws(()=>x.f.core.codex.prepareWithResource({...x.request,mode:'live'},x.quota,{short:'1',week:'1'}),/CODEX_TURN_DENIED/);
 assert.equal(x.f.store.read(tx=>tx.native.listAttempts(x.f.principal)).length,0);
});
