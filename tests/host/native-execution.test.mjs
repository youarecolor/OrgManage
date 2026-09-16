import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {nativeSubscription} from '../core/fixtures/native-subscription.mjs';
import {committed} from '../core/fixtures/helpers.mjs';
import {NativeExecution} from '../../dist/host/src/native-execution.js';

async function fixture(t){
 // Entire provider and capability observations here are modeled, not live proof.
 const x=await nativeSubscription(t,{},undefined,'provider',{adapterVersion:'a'.repeat(64),runnerDigest:'b'.repeat(64)});
 const prepared=x.f.store.read(tx=>JSON.parse(tx.getRecordVersion(x.f.principal,x.sessionValue.preparationVersion).data));
 prepared.sessionId='8'.repeat(64);
 const account={format:'native_subscription_observation_v1',sessionId:prepared.sessionId,plan:'pro',accountType:'chatgpt',paidCreditsAvailable:false,unlimitedCredits:false,creditBalance:'0',creditObservedAt:prepared.observedAt,expiresAt:prepared.expiresAt};
 const calls=[];let disconnected=false;
 const connection={preparation(){if(disconnected)throw Error('closed');return structuredClone(prepared);},subscriptionObservation:()=>structuredClone(account),disconnect(){disconnected=true;},async exchange(r){
  calls.push(r);
  if(r.operation==='write'){
   const frame=JSON.parse(r.frame),id=frame.id.slice('start:'.length);
   const a=x.f.store.read(tx=>tx.native.getAttempt(x.f.principal,id));
   assert.equal(a.state,'send_intent');assert.ok(a.runId);
   assert.equal(frame.params.input[0].text,x.request.input);assert.equal(frame.params.effort,'low');
   return {sessionId:r.sessionId,sequence:r.sequence,closed:false,processExitObserved:false,frames:[JSON.stringify({id:frame.id,result:{turn:{id:'turn-model',status:'inProgress'}}}),JSON.stringify({method:'turn/completed',params:{threadId:prepared.threadId,turn:{id:'turn-model',status:'completed',items:[{id:'answer',type:'agentMessage',text:'modeled candidate'}]}}})]};
  }
  return {sessionId:r.sessionId,sequence:r.sequence,closed:true,processExitObserved:true,frames:[]};
 }};
 const scope={principalId:x.f.principal,actorId:x.f.actor,scopeId:x.mission.id,contractVersion:x.request.contractVersion,profileId:x.profileId,noExtraChargeEvidenceVersion:x.evidenceVersionId,sources:[{sourceId:x.source,grantId:x.grant}],input:x.request.input,maxDurationMs:10000};
 const execution=new NativeExecution(x.f.core,scope,connection);
 return {...x,execution,prepared,calls,connection,scope,disconnected:()=>disconnected};
}
test('integrated native execution imports observations, awaits approval, commits before write and resolves on terminal plus exit',async t=>{
 const x=await fixture(t),r=x.execution.prepare();assert.equal(x.calls.length,0);
 assert.throws(()=>x.execution.prepare());committed(x.decide(r));x.execution.start();
 const deadline=Date.now()+2000;while(!x.execution.state.dispatch?.channelClosed&&Date.now()<deadline)await delay(10);
 assert.equal(x.execution.state.dispatch.channelClosed,true);assert.equal(x.execution.state.dispatch.faulted,false);
 assert.deepEqual(x.calls.map(r=>r.operation),['write','end']);assert.equal(x.disconnected(),true);
 assert.equal(x.state(r).attempt.state,'completed');assert.equal(JSON.parse(x.state(r).hold.data).state,'resolved');assert.throws(()=>x.execution.start());
});
test('integrated execution without ActionApproval never writes',async t=>{
 const x=await fixture(t);x.execution.prepare();assert.throws(()=>x.execution.start());
 assert.equal(x.calls.filter(r=>r.operation==='write').length,0);assert.equal(x.disconnected(),true);
});
test('revoked disclosure between preparation and send stops acquisition',async t=>{
 const x=await fixture(t),r=x.execution.prepare();committed(x.decide(r));x.disclosure.revokeGrant(x.f.principal,x.f.actor,x.grant);
 assert.throws(()=>x.execution.start());assert.equal(x.calls.filter(r=>r.operation==='write').length,0);
});
test('missing capability is not manufactured by integrated preparation',async t=>{
 const x=await fixture(t);x.admission.observe(x.f.principal,x.f.actor,x.profileId,{...x.observation('retention'),status:'unknown'});
 assert.throws(()=>x.execution.prepare());assert.equal(x.calls.length,0);assert.equal(x.disconnected(),true);
 assert.equal(x.f.store.read(tx=>tx.native.listAttempts(x.f.principal).length),0);
});
test('substituted connection after approval cannot send',async t=>{
 const x=await fixture(t),r=x.execution.prepare();committed(x.decide(r));x.prepared.guest.processId++;
 assert.throws(()=>x.execution.start());assert.equal(x.calls.length,0);
});
test('previous helper qualification cannot admit a changed helper or runner',async t=>{
 for(const change of [p=>p.helper.sourceDigest='f'.repeat(64),p=>p.guest.runnerDigest='f'.repeat(64)]){
  const x=await fixture(t);change(x.prepared);assert.throws(()=>x.execution.prepare(),/PROFILE_SOURCE_CHANGED/);
  assert.equal(x.calls.length,0);assert.equal(x.f.store.read(tx=>tx.native.listAttempts(x.f.principal).length),0);
 }
});
