import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {nativeSubscription} from './fixtures/native-subscription.mjs';
import {NativeSessionIngress} from '../../dist/core/src/native-session-ingress.js';
import {committed} from './fixtures/helpers.mjs';

async function fixture(t){
 const x=await nativeSubscription(t,{},undefined,'provider');
 const source=x.f.store.read(tx=>JSON.parse(tx.getRecordVersion(x.f.principal,x.sessionValue.preparationVersion).data));source.sessionId='8'.repeat(64);
 const ingress=new NativeSessionIngress(x.f.store,()=>x.f.now.getTime());
 const insert=connection=>ingress.import(x.f.principal,x.f.actor,x.mission.id,connection??{preparation:()=>source});
 const records=()=>x.f.store.read(tx=>tx.listRecord(x.f.principal));
 return {...x,source,insert,records};
}
test('session import stores immutable raw preparation and owner projection together without granting admission',async t=>{
 const x=await fixture(t),before=x.records(),version=x.insert(),after=x.records();assert.equal(after.length,before.length+2);
 const value=x.f.store.read(tx=>JSON.parse(tx.getRecordVersion(x.f.principal,version).data));assert.equal(value.ownerId,x.f.store.ownerId);assert.equal(value.ownerEpoch,String(x.f.store.ownerEpoch));
 const raw=x.f.store.read(tx=>JSON.parse(tx.getRecordVersion(x.f.principal,value.preparationVersion).data));assert.deepEqual(raw,x.source);assert.match(value.preparationDigest,/^[a-f0-9]{64}$/);
 assert.equal(x.f.store.read(tx=>tx.native.listAttempts(x.f.principal)).length,0);assert.equal(after.filter(v=>v.kind==='resource_hold').length,0);
 x.request.sessionEvidenceVersion=version;const r=x.prepare();assert.equal(r.attempt.state,'prepared');assert.throws(()=>x.send(r),/NOT_APPROVED/);committed(x.decide(r));assert.equal(x.send(r).kind,'provider');
});
test('same session cannot be imported twice and failed import leaves no rows',async t=>{
 const x=await fixture(t);x.insert();const before=x.records();assert.throws(()=>x.insert());assert.deepEqual(x.records(),before);
});
for(const [name,modify] of [
 ['closed',v=>v.closed=true],['sent',v=>v.turnsSent=1],['unknown phase',v=>v.stage='completed'],['synthetic',v=>v.mode='synthetic'],
 ['tools',v=>v.toolsEnabled=true],['fallback',v=>v.apiFallbackEnabled=true],['purchase',v=>v.purchaseOperationsEnabled=true],['extra turn',v=>v.maxTurns=2],
 ['rounded ticks',v=>v.helper.startTicks=639249846085978400],['missing PID',v=>v.guest.processId=0],['missing pin',v=>v.helper.sourceDigest='unknown'],['expired',v=>v.expiresAt=v.observedAt-1],
 ['future',v=>v.observedAt=v.expiresAt-1],['too long',v=>v.expiresAt=v.observedAt+60001],['extra secret field',v=>v.credential='must not persist'],['extra nested field',v=>v.helper.token='must not persist'],['invalid VM identity',v=>v.guest.vmId='-'.repeat(36)]
])test(`session import refuses ${name}`,async t=>{const x=await fixture(t);modify(x.source);const before=x.records();assert.throws(()=>x.insert());assert.deepEqual(x.records(),before);});
test('closure or peer rebinding during atomic import rolls back raw evidence and claim',async t=>{
 const x=await fixture(t),before=x.records();let n=0;assert.throws(()=>x.insert({preparation:()=>++n===1?x.source:{...x.source,closed:true}}));assert.deepEqual(x.records(),before);
 n=0;assert.throws(()=>x.insert({preparation:()=>++n===1?x.source:{...x.source,helper:{...x.source.helper,processId:124}}}));assert.deepEqual(x.records(),before);
 assert.ok(x.insert());
});
test('Core refuses missing provenance and an altered projection at preparation and send',async t=>{
 const x=await fixture(t);
 for(const change of [{preparationVersion:undefined},{preparationDigest:'f'.repeat(64)},{expiresAt:x.sessionValue.expiresAt+1}]){
  const id=randomUUID();x.f.store.transaction(tx=>tx.insertRecord({principalId:x.f.principal,id,kind:'evidence',revision:1n,data:JSON.stringify({...x.sessionValue,...change})}));
  x.request.sessionEvidenceVersion=x.f.store.read(tx=>tx.getRecord(x.f.principal,id).versionId);const before=x.records();assert.throws(x.prepare);assert.deepEqual(x.records(),before);
 }
 x.request.sessionEvidenceVersion=x.insert();const r=x.prepare();committed(x.decide(r));x.f.now=new Date(x.source.expiresAt);assert.throws(()=>x.send(r));assert.equal(x.state(r).attempt.state,'prepared');
});
