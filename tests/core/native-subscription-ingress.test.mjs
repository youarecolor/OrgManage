import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeSubscription} from './fixtures/native-subscription.mjs';
import {importNativeSubscription} from '../../dist/core/src/native-subscription-ingress.js';
async function fixture(t){
 // Modeled provider metadata only; no VM, credentials or real qualification.
 const x=await nativeSubscription(t,{},undefined,'provider');
 const prepared=x.f.store.read(tx=>JSON.parse(tx.getRecordVersion(x.f.principal,x.sessionValue.preparationVersion).data));
 const account={format:'native_subscription_observation_v1',sessionId:prepared.sessionId,plan:'pro',accountType:'chatgpt',paidCreditsAvailable:false,unlimitedCredits:false,creditBalance:'0',creditObservedAt:prepared.observedAt,expiresAt:prepared.expiresAt};
 const connection={preparation:()=>structuredClone(prepared),subscriptionObservation:()=>structuredClone(account)};
 const run=(session=x.request.sessionEvidenceVersion,evidence=x.evidenceVersionId)=>importNativeSubscription(x.f.store,x.f.principal,x.f.actor,x.mission.id,x.request.contractVersion,session,evidence,connection,()=>x.f.now.getTime());
 return {...x,prepared,account,connection,run};
}
test('subscription ingress binds observed account to original session and explicit configuration evidence without sending',async t=>{
 const x=await fixture(t),id=x.run();
 const entitlement=x.f.store.read(tx=>JSON.parse(tx.getRecord(x.f.principal,id).data));
 assert.equal(entitlement.accountRoute,x.prepared.accountRoute);assert.equal(entitlement.observedAt,x.account.creditObservedAt);
 assert.equal(entitlement.noExtraChargeEvidenceVersion,x.evidenceVersionId);
 const source=x.f.store.read(tx=>JSON.parse(tx.getRecordVersion(x.f.principal,entitlement.accountEvidenceVersion).data));
 assert.equal(source.sessionVersion,x.request.sessionEvidenceVersion);assert.equal(source.sessionId,x.prepared.sessionId);
 assert.equal(entitlement.creditBalance,'0');assert.equal(entitlement.cashMode,'none');
});
test('subscription ingress rejects paid credits, foreign sessions, extra identity data and renewed expiry',async t=>{
 for(const mutate of [a=>a.paidCreditsAvailable=true,a=>a.sessionId='0'.repeat(64),a=>a.email='private@example.invalid',a=>a.expiresAt++]){
  const x=await fixture(t);mutate(x.account);assert.throws(()=>x.run());
 }
});
test('subscription ingress requires separate configuration evidence',async t=>{
 const x=await fixture(t);assert.throws(()=>x.run(undefined,'missing'));
});
test('subscription ingress refuses connection changes before observation commit',async t=>{
 const x=await fixture(t);let calls=0;
 x.connection.subscriptionObservation=()=>({...x.account,sessionId:++calls===1?x.account.sessionId:'0'.repeat(64)});
 assert.throws(()=>x.run());
});
test('subscription ingress refuses expired credit observation even when session is fresh',async t=>{
 const x=await fixture(t);x.account.creditObservedAt-=300001;assert.throws(()=>x.run());
});
test('subscription ingress cannot substitute different immutable preparation for the registered session',async t=>{
 const x=await fixture(t);x.prepared.helper.sourceDigest='f'.repeat(64);assert.throws(()=>x.run());
});
