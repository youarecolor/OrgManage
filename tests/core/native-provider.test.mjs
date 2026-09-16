import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import canonicalize from 'canonicalize';
import {nativeSubscription} from './fixtures/native-subscription.mjs';
import {committed,randomUUID,snap,LedgerStore,OrgManageCore} from './fixtures/helpers.mjs';
const fixture=t=>nativeSubscription(t,{},undefined,'provider');
function session(x,change){const id=randomUUID();x.f.store.transaction(tx=>{
 const value={...x.sessionValue,...change};
 if('expiresAt' in change){const source=JSON.parse(tx.getRecordVersion(x.f.principal,value.preparationVersion).data);source.expiresAt=change.expiresAt;const sourceId=randomUUID();tx.insertRecord({principalId:x.f.principal,id:sourceId,kind:'evidence',revision:1n,data:JSON.stringify(source)});value.preparationVersion=tx.getRecord(x.f.principal,sourceId).versionId;value.preparationDigest=createHash('sha256').update(canonicalize(source)).digest('hex');}
 tx.insertRecord({principalId:x.f.principal,id,kind:'evidence',revision:1n,data:JSON.stringify(value)});
 });x.request.sessionEvidenceVersion=x.f.store.read(tx=>tx.getRecord(x.f.principal,id).versionId);}
const frame=v=>Buffer.from(JSON.stringify(v));
test('protected provider preparation creates real-mode Run and Attempt before returning the send envelope',async t=>{
 const x=await fixture(t),r=x.prepare();const records=x.f.store.read(tx=>tx.listRecord(x.f.principal));
 assert.equal(JSON.parse(records.find(v=>v.id===r.attempt.runId).data).mode,'codex_native_text');assert.equal(JSON.parse(r.attempt.binding).mode,'provider');assert.equal(x.state(r).attempt.state,'prepared');
 assert.equal(snap(x.f).nativeAttempts[0].mode,'provider');assert.match(x.approval(r).explanation.route,/実native/);assert.doesNotMatch(x.approval(r).explanation.estimateDifference,/合成/);
 assert.throws(()=>x.send(r),/NOT_APPROVED/);committed(x.decide(r));const wire=x.send(r);assert.equal(wire.kind,'provider');assert.equal(wire.request.params.threadId,x.request.threadId);assert.equal(wire.request.params.effort,'low');assert.equal(x.state(r).attempt.state,'send_intent');assert.throws(()=>x.send(r));
});
for(const change of [{threadId:'other'},{accountRoute:'other'},{profileDigest:'f'.repeat(64)},{model:'other'},{effort:'high'},{ownerEpoch:'999'},{sessionId:'bad'},{toolsEnabled:true},{apiFallbackEnabled:true},{purchaseOperationsEnabled:true},{maxTurns:2},{format:'other'}])test(`provider session mismatch refuses all preparation: ${JSON.stringify(change)}`,async t=>{
 const x=await fixture(t);session(x,change);const before=x.f.store.read(tx=>tx.listRecord(x.f.principal));assert.throws(x.prepare);assert.deepEqual(x.f.store.read(tx=>tx.listRecord(x.f.principal)),before);assert.equal(x.f.store.read(tx=>tx.native.listAttempts(x.f.principal)).length,0);
});
test('expired session cannot be prepared or sent even while other evidence remains valid',async t=>{
 const x=await fixture(t);session(x,{expiresAt:x.f.now.getTime()+100});const r=x.prepare();committed(x.decide(r));x.f.now=new Date(x.f.now.getTime()+101);const before=x.state(r);assert.throws(()=>x.send(r));assert.deepEqual(x.state(r),before);
 const y=await fixture(t);session(y,{expiresAt:y.f.now.getTime()-1});assert.throws(y.prepare);
});
test('provider and rehearsal entrypoints cannot relabel each other or bypass mandatory guards',async t=>{
 const x=await fixture(t),c=x.f.core.codex;assert.throws(()=>c.prepare(x.request));assert.throws(()=>c.prepareWithSubscription(x.request,x.guards));assert.throws(()=>c.prepareProviderWithSubscription({...x.request,sessionEvidenceVersion:undefined},x.guards));
 const r=x.prepare();committed(x.decide(r));const before=x.state(r);assert.throws(()=>c.acquireStart(x.f.principal,r.attempt.id));assert.throws(()=>c.acquireStartWithSubscription(x.f.principal,r.attempt.id,{...x.guards,holdId:r.holdId}));assert.deepEqual(x.state(r),before);
 const y=await nativeSubscription(t),q=y.prepare();committed(y.decide(q));assert.throws(()=>y.f.core.codex.acquireProviderStartWithSubscription(y.f.principal,q.attempt.id,{...y.guards,holdId:q.holdId}));assert.throws(()=>y.f.core.codex.prepareProviderWithSubscription(y.request,y.guards));
});
test('provider notification stream and usage remain bound to the same Attempt and Run',async t=>{
 const x=await fixture(t),r=x.prepare();committed(x.decide(r));x.send(r);const stream=x.f.core.codex.openStream(x.f.principal,r.attempt.id);
 for(const v of [{id:`start:${r.attempt.id}`,result:{turn:{id:'turn-test',status:'inProgress'}}},{method:'turn/completed',params:{threadId:x.request.threadId,turn:{id:'turn-test',status:'completed',items:[{type:'agentMessage',id:'answer',text:'Untrusted candidate data'}]}}}])stream.push(Buffer.concat([frame(v),Buffer.from('\n')]));
 stream.finish();assert.equal(x.state(r).attempt.state,'completed');assert.equal(snap(x.f).nativeAttempts[0].messages[0].text,'Untrusted candidate data');assert.equal(snap(x.f).outcomes.length,0);assert.equal(snap(x.f).nativeAttempts[0].usage,null);
});
test('provider unknown persists through restart with correct reconciliation semantics and no resend',async t=>{
 const x=await fixture(t),r=x.prepare();committed(x.decide(r));x.send(r);x.f.core.codex.transportLost(x.f.principal,r.attempt.id);x.subscription.observe(x.f.principal,r.holdId,'unknown',x.evidenceVersionId);
 await x.f.store.close();x.f.store=await LedgerStore.open(x.f.path);x.f.core=new OrgManageCore(x.f.store,x.f.options);x.f.session=x.f.core.openSession(x.f.actor);
 assert.equal(x.state(r).attempt.state,'unknown');assert.equal(JSON.parse(x.state(r).hold.data).state,'unknown');const rec=x.f.store.read(tx=>tx.listRecord(x.f.principal,'reconciliation_case'));assert.equal(JSON.parse(rec[0].data).mode,'codex_native_text');assert.equal(JSON.parse(rec[0].data).resourceState,'held_until_reconciled');assert.throws(()=>x.send(r));
 x.f.core.codex.observe(x.f.principal,r.attempt.id,frame({method:'turn/completed',params:{threadId:x.request.threadId,turn:{id:'observed-later',status:'completed',items:[]}}}));assert.equal(x.state(r).attempt.state,'completed');assert.equal(JSON.parse(x.f.store.read(tx=>tx.getRecord(x.f.principal,rec[0].id)).data).resolution,'provider_terminal_observed');
});
test('foreign provider thread is quarantined, not accepted as a completed candidate',async t=>{
 const x=await fixture(t),r=x.prepare();committed(x.decide(r));x.send(r);x.f.core.codex.observe(x.f.principal,r.attempt.id,frame({method:'turn/completed',params:{threadId:'foreign',turn:{id:'turn',status:'completed',items:[]}}}));assert.equal(x.state(r).attempt.state,'unknown');assert.equal(snap(x.f).outcomes.length,0);
});
