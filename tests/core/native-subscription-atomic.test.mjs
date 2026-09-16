import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeSubscription} from './fixtures/native-subscription.mjs';
import {nativeGuards} from './fixtures/native-guards.mjs';
import {committed,denied,update,randomUUID,LedgerStore,OrgManageCore,snap} from './fixtures/helpers.mjs';
test('subscription prepare and ordinary Home decision acquire the same Run/Attempt without fake quota or cash',async t=>{
 const x=await nativeSubscription(t),r=x.prepare(),a=x.approval(r);assert.equal(a.state,'pending');assert.equal(a.explanation.maximumYen,'0');assert.ok(a.explanation.risk.includes('残枠は不明'));assert.ok(a.explanation.disclosure.endsWith(x.request.input));assert.equal(x.f.store.read(tx=>tx.listRecord(x.f.principal,'cost_obligation')).length,0);
 assert.throws(()=>x.send(r),/NOT_APPROVED/);committed(x.decide(r));assert.equal(x.send(r).kind,'synthetic');const s=x.state(r);assert.equal(s.attempt.state,'send_intent');assert.equal(JSON.parse(s.hold.data).state,'send_acquired');assert.equal(JSON.parse(s.mission.data).phase,'execution');assert.equal(snap(x.f).outcomes.length,0);assert.throws(()=>x.send(r));
});
for(const changes of [{additionalCharges:'unknown'},{paidCreditsAvailable:true},{apiFallbackEnabled:true}])test(`unqualified subscription rolls back qualification, Run and holds: ${JSON.stringify(changes)}`,async t=>{
 const x=await nativeSubscription(t,changes),before=x.f.store.read(tx=>tx.listRecord(x.f.principal));assert.throws(x.prepare,/NO_EXTRA_CHARGE_UNPROVEN/);assert.deepEqual(x.f.store.read(tx=>tx.listRecord(x.f.principal)),before);assert.equal(x.f.store.read(tx=>tx.native.listAttempts(x.f.principal)).length,0);
});
test('last-stage approval failure rolls back earlier native state and subscription hold',async t=>{
 const x=await nativeSubscription(t);const original=x.guards.actions.createSubscriptionInTransaction.bind(x.guards.actions);x.guards.actions.createSubscriptionInTransaction=(...args)=>{original(...args);throw Error('fixed last-stage failure');};
 const before=x.f.store.read(tx=>tx.listRecord(x.f.principal));assert.throws(x.prepare,/last-stage/);assert.deepEqual(x.f.store.read(tx=>tx.listRecord(x.f.principal)),before);
});
for(const fault of ['entitlement','disclosure','qualification','policy','other-hold'])test(`${fault} changes before send leave all state at the pre-send version`,async t=>{
 const x=await nativeSubscription(t),r=x.prepare();committed(x.decide(r));
 if(fault==='entitlement')x.f.now=new Date(x.f.now.getTime()+30001);
 if(fault==='disclosure')x.disclosure.revokeGrant(x.f.principal,x.f.actor,x.grant);
 if(fault==='qualification')x.admission.observe(x.f.principal,x.f.actor,x.profileId,{...x.observation('authentication'),status:'unknown'});
 if(fault==='policy'){const id=x.f.store.read(tx=>tx.getMeta(`policy:${x.f.principal}`));update(x.f,id,v=>({...v,normalLimitYen:'900'}));}
 const before=x.state(r);assert.throws(()=>x.send(fault==='other-hold'?{...r,holdId:randomUUID()}:r));assert.deepEqual(x.state(r),before);
});
test('failure after native and subscription acquisition rolls back both and Home phase',async t=>{
 const x=await nativeSubscription(t),r=x.prepare();committed(x.decide(r));const before=x.state(r),original=x.guards.actions.markSentInTransaction.bind(x.guards.actions);x.guards.actions.markSentInTransaction=(...args)=>{original(...args);throw Error('fixed after-acquire failure');};assert.throws(()=>x.send(r),/after-acquire/);assert.deepEqual(x.state(r),before);
});
test('old prepare/acquire entrypoints cannot bypass subscription, source, qualification or approval',async t=>{
 const x=await nativeSubscription(t),c=x.f.core.codex;assert.throws(()=>c.prepare(x.request));assert.throws(()=>c.prepare({...x.request,contractVersion:x.contractVersion}));assert.throws(()=>c.prepareWithGuards(x.request,{resource:x.resource,amounts:{short:'1'},disclosure:x.disclosure,manifestId:x.guards.manifestId,cash:x.cash,quoteId:x.quoteId,qualification:{admission:x.admission,profileId:x.profileId},actions:x.f.core.nativeActions}));
 const r=x.prepare();committed(x.decide(r));const before=x.state(r);assert.throws(()=>c.acquireStart(x.f.principal,r.attempt.id));assert.throws(()=>c.acquireStartWithResource(x.f.principal,r.attempt.id,x.resource,r.holdId));assert.throws(()=>c.acquireStartWithDisclosure(x.f.principal,r.attempt.id,x.resource,r.holdId,x.disclosure));assert.deepEqual(x.state(r),before);
});
test('ordinary denial and maintenance release unsent subscription holds without expecting a cash record',async t=>{
 const x=await nativeSubscription(t),r=x.prepare();committed(x.decide(r,'deny'));assert.equal(x.state(r).attempt.state,'discarded');assert.equal(JSON.parse(x.state(r).hold.data).state,'unsent');assert.equal(x.approval(r).state,'denied');
 const y=await nativeSubscription(t),s=y.prepare();y.f.now=new Date(y.f.now.getTime()+60001);y.f.core.maintain();assert.equal(y.approval(s).state,'expired');assert.equal(JSON.parse(y.state(s).hold.data).state,'unsent');
});
test('unknown send keeps the subscription hold after expiry and owner restart',async t=>{
 const x=await nativeSubscription(t),r=x.prepare();committed(x.decide(r));x.send(r);x.f.core.codex.transportLost(x.f.principal,r.attempt.id);x.subscription.observe(x.f.principal,r.holdId,'unknown',x.evidenceVersionId);x.f.now=new Date(x.f.now.getTime()+60001);x.f.core.maintain();assert.equal(JSON.parse(x.state(r).hold.data).state,'unknown');
 await x.f.store.close();x.f.store=await LedgerStore.open(x.f.path);x.f.core=new OrgManageCore(x.f.store,x.f.options);x.f.session=x.f.core.openSession(x.f.actor);x.f.core.maintain();assert.equal(x.state(r).attempt.state,'unknown');assert.equal(JSON.parse(x.state(r).hold.data).state,'unknown');
});
test('another Store cannot supply subscription authority and the route remains synthetic-only',async t=>{
 const x=await nativeSubscription(t),y=await nativeSubscription(t);assert.throws(()=>x.f.core.codex.prepareWithSubscription(x.request,{...x.guards,subscription:y.subscription}));assert.throws(()=>x.f.core.codex.prepareWithSubscription({...x.request,mode:'provider'},x.guards));assert.equal(x.f.store.read(tx=>tx.native.listAttempts(x.f.principal)).length,0);
 const plain=await nativeGuards(t),r=plain.prepare();assert.throws(()=>plain.f.core.codex.acquireStartWithSubscription(plain.f.principal,r.attempt.id,{...x.guards,holdId:r.holdId}));
});
