import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeGuards} from './fixtures/native-guards.mjs';
import {NativeSubscriptionCoordinator} from '../../dist/core/src/native-subscription.js';
import {LedgerStore,randomUUID} from './fixtures/helpers.mjs';
async function setup(t,changes={}){
 const x=await nativeGuards(t),{f}=x,subscription=new NativeSubscriptionCoordinator(f.store,()=>f.now.getTime());
 const value={mode:'synthetic',provider:'codex',accountRoute:x.request.accountRoute,profileDigest:x.request.profileDigest,plan:'pro',accountType:'chatgpt',cashMode:'none',additionalCharges:'verified_absent',paidCreditsAvailable:false,unlimitedCredits:false,creditBalance:'0',apiFallbackEnabled:false,purchaseOperationsEnabled:false,noExtraChargeEvidenceVersion:x.evidenceVersionId,accountEvidenceVersion:x.evidenceVersionId,configurationEvidenceVersion:x.evidenceVersionId,observedAt:f.now.getTime(),expiresAt:f.now.getTime()+30000,...changes};
 const entitlement=subscription.recordEntitlement(f.principal,f.actor,x.mission.id,x.contractVersion,value),attempt=f.core.codex.prepare(x.request);
 const reserve=(duration=10000)=>f.store.transaction(tx=>subscription.reserveInTransaction(tx,f.principal,f.actor,attempt.id,entitlement,duration));
 const acquire=id=>f.store.transaction(tx=>subscription.acquireInTransaction(tx,f.principal,f.actor,id,attempt.id));
 const hold=id=>f.store.read(tx=>JSON.parse(tx.getRecord(f.principal,id).data));
 return {...x,subscription,value,entitlement,attempt,reserve,acquire,hold};
}
test('verified no-extra-charge subscription can retain an unknown allowance without inventing a quantity or JPY debt',async t=>{
 const x=await setup(t),id=x.reserve(),h=x.hold(id);assert.equal(h.quotaUnit,null);assert.equal(h.quotaAmount,null);assert.equal(h.remaining,'unknown');assert.equal(h.maxTurns,1);assert.equal(h.maxDurationMs,10000);assert.equal(h.cashMode,'none');
 assert.equal(x.f.store.read(tx=>tx.listRecord(x.f.principal,'cost_obligation')).length,0);x.f.core.codex.acquireStart(x.f.principal,x.attempt.id);x.acquire(id);assert.equal(x.hold(id).state,'send_acquired');
});
for(const change of [{additionalCharges:'unknown'},{paidCreditsAvailable:null},{paidCreditsAvailable:true},{unlimitedCredits:null},{unlimitedCredits:true},{creditBalance:null},{creditBalance:'1'},{apiFallbackEnabled:null},{apiFallbackEnabled:true},{purchaseOperationsEnabled:null},{purchaseOperationsEnabled:true}])test(`unproven/paid route refuses subscription exception: ${JSON.stringify(change)}`,async t=>{
 const x=await setup(t,change);assert.throws(x.reserve,/NO_EXTRA_CHARGE_UNPROVEN/);assert.equal(x.f.store.read(tx=>tx.listRecord(x.f.principal,'resource_hold')).length,0);
});
test('expiry never means a reset or permission to release an unknown effect',async t=>{
 const x=await setup(t),id=x.reserve();x.f.core.codex.acquireStart(x.f.principal,x.attempt.id);x.acquire(id);x.f.core.codex.transportLost(x.f.principal,x.attempt.id);x.subscription.observe(x.f.principal,id,'unknown',x.evidenceVersionId);x.f.now=new Date(x.f.now.getTime()+600000);
 assert.equal(x.hold(id).state,'unknown');assert.throws(()=>x.subscription.cancelUnsent(x.f.principal,x.f.actor,id));assert.throws(()=>x.subscription.observe(x.f.principal,id,'resolved',x.evidenceVersionId),/EFFECT_UNRESOLVED/);
 await x.f.store.close();x.f.store=await LedgerStore.open(x.f.path);assert.equal(x.f.store.read(tx=>JSON.parse(tx.getRecord(x.f.principal,id).data).state),'unknown');
});
test('only discarded-before-send is cancellable, and duration/duplicate/early acquisition are rejected',async t=>{
 const x=await setup(t);for(const n of [0,180001,Infinity])assert.throws(()=>x.reserve(n),/FINITE_DURATION/);const id=x.reserve();assert.throws(x.reserve,/UNRESOLVED_ACCOUNT/);assert.throws(()=>x.acquire(id),/SEND_BOUNDARY/);assert.throws(()=>x.subscription.cancelUnsent(x.f.principal,x.f.actor,id));
 x.f.core.codex.requestStop(x.f.principal,x.attempt.id);x.subscription.cancelUnsent(x.f.principal,x.f.actor,id);assert.equal(x.hold(id).state,'unsent');
});
test('entitlement expiry prevents acquisition and does not mutate an existing reservation',async t=>{
 const x=await setup(t),id=x.reserve();x.f.core.codex.acquireStart(x.f.principal,x.attempt.id);x.f.now=new Date(x.f.now.getTime()+30001);const before=x.hold(id);assert.throws(()=>x.acquire(id),/ENTITLEMENT_EXPIRED/);assert.deepEqual(x.hold(id),before);
});
test('terminal observation closes the operation, not a claim that allowance consumption is known',async t=>{
 const x=await setup(t),id=x.reserve();x.f.core.codex.acquireStart(x.f.principal,x.attempt.id);x.acquire(id);
 x.f.core.codex.observe(x.f.principal,x.attempt.id,Buffer.from(JSON.stringify({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed',items:[],error:null}}})));
 x.subscription.observe(x.f.principal,id,'resolved',x.evidenceVersionId);assert.equal(x.hold(id).state,'resolved');assert.equal(x.hold(id).remaining,'unknown');assert.equal(x.hold(id).quotaAmount,null);
});
test('missing protected evidence or different account cannot reserve',async t=>{
 const x=await setup(t,{accountRoute:'another'});assert.throws(x.reserve,/BINDING/);
 assert.throws(()=>x.subscription.recordEntitlement(x.f.principal,x.f.actor,x.mission.id,x.contractVersion,{...x.value,accountEvidenceVersion:randomUUID()}),/EVIDENCE/);
});
test('same account cannot receive a second unresolved reservation for a different Attempt',async t=>{
 const x=await setup(t),id=x.reserve();const other=randomUUID();
 // An already held slot in this real SQLite store is authoritative regardless of origin scope.
 x.f.store.transaction(tx=>{const a=tx.native.getAttempt(x.f.principal,x.attempt.id);tx.native.updateAttempt({...a,revision:a.revision+1n,state:'completed'},a.revision);});
 const attempt=x.f.core.codex.prepare({...x.request,threadId:other});
 assert.throws(()=>x.f.store.transaction(tx=>x.subscription.reserveInTransaction(tx,x.f.principal,x.f.actor,attempt.id,x.entitlement,10000)),/UNRESOLVED_ACCOUNT/);assert.equal(x.hold(id).state,'reserved');
});
