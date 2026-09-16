import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeGuards} from './fixtures/native-guards.mjs';
import {randomUUID,update,LedgerStore} from './fixtures/helpers.mjs';
import {NativeAdmissionCoordinator,requiredNativeCapabilities} from '../../dist/core/src/native-admission.js';
const nativeProfile={mode:'synthetic',provider:'codex',purpose:'native_text_generation',accountRoute:'test-account',project:'test-project',profileDigest:'d'.repeat(64),runnerDigest:'e'.repeat(64),adapterVersion:'test-adapter-1',cliVersion:'test-cli-1',osVersion:'test-os-1',operations:['read_permitted_input','generate_text']};
async function setup(t,options={}){
 const x=await nativeGuards(t),{f}=x,admission=new NativeAdmissionCoordinator(f.store,()=>f.now.getTime());
 const profile={...nativeProfile,...options.profile},profileId=admission.registerProfile(f.principal,f.actor,x.mission.id,profile),profileHash=admission.profileHash(f.principal,profileId),contractId=randomUUID();
 f.store.transaction(tx=>tx.insertRecord({principalId:f.principal,id:contractId,kind:'contract',revision:1n,data:JSON.stringify({mode:'codex_protocol_rehearsal',scopeId:x.mission.id,nativeProfileId:profileId})}));
 const contractVersion=f.store.read(tx=>tx.getRecord(f.principal,contractId).versionId);
 update(f,x.mission.id,v=>({...v,contractRef:contractVersion}));x.request.contractVersion=contractVersion;
 x.guards.manifestId=x.disclosure.createManifest(f.principal,f.actor,x.mission.id,contractVersion,nativeProfile,[{sourceId:x.source,grantId:x.grant}]);
 x.guards.quoteId=x.cash.recordQuote(f.principal,f.actor,x.mission.id,contractVersion,x.quote);
 x.guards.qualification={admission,profileId};
 const observation=capability=>({mode:profile.mode,profileHash,capability,status:'pass',observedAt:f.now.getTime(),expiresAt:f.now.getTime()+10000,evidenceVersionId:x.evidenceVersionId,inputDigest:'a'.repeat(64),expected:'protected synthetic expected',observed:'protected synthetic actual',limitations:'synthetic fixture only',invalidation:'any target revision or policy change'});
 const observe=(capability,changes={})=>admission.observe(f.principal,f.actor,profileId,{...observation(capability),...changes});
 const requirements=requiredNativeCapabilities(profile);for(const cap of requirements)if(cap!==options.omit)observe(cap);
 const send=r=>f.core.codex.acquireStartWithGuards(f.principal,r.attempt.id,{...x.guards,holdId:r.holdId,cashHoldId:r.cashHoldId,admission});
 return {...x,admission,profile,profileId,profileHash,observation,observe,requirements,send};
}
test('qualified rehearsal binds immutable complete receipts and all holds before send',async t=>{
 const x=await setup(t),r=x.prepare();const binding=JSON.parse(r.attempt.binding),record=x.f.store.read(tx=>tx.getRecord(x.f.principal,binding.admission.id));assert.equal(record.kind,'evidence');assert.equal(JSON.parse(record.data).receipts.length,20);
 assert.equal(x.send(r).kind,'synthetic');assert.equal(x.state(r).native.state,'send_intent');assert.equal(JSON.parse(x.state(r).cash.data).state,'send_acquired');
});
for(const omitted of ['approval_mapping','cost_enforcement','credential_separation','retention'])test(`missing ${omitted} prevents all reservations and Run creation`,async t=>{
 const x=await setup(t,{omit:omitted}),before=x.f.store.read(tx=>tx.listRecord(x.f.principal));assert.throws(x.prepare,/MISSING_CAPABILITY/);assert.deepEqual(x.f.store.read(tx=>tx.listRecord(x.f.principal)),before);
});
for(const status of ['fail','unknown','not_applicable'])test(`${status} after prepare invalidates existing admission without releasing or consuming holds`,async t=>{
 const x=await setup(t),r=x.prepare();x.observe('cancel_observation',{status});const before=x.state(r);assert.throws(()=>x.send(r),/CAPABILITY_NOT_PASSED/);assert.deepEqual(x.state(r),before);
});
test('new passing evidence still requires a fresh admission instead of rewriting the old receipt set',async t=>{
 const x=await setup(t),r=x.prepare();x.observe('authentication');const before=x.state(r);assert.throws(()=>x.send(r),/RECEIPT_CHANGED/);assert.deepEqual(x.state(r),before);
});
test('expiry before send leaves native, quota and money unchanged',async t=>{
 const x=await setup(t),r=x.prepare();x.f.now=new Date(x.f.now.getTime()+10001);const before=x.state(r);assert.throws(()=>x.send(r),/CAPABILITY_EXPIRED/);assert.deepEqual(x.state(r),before);
});
test('preparation rolls back admission evidence too if a later monetary check fails',async t=>{
 const x=await setup(t);x.guards.quoteId=x.cash.recordQuote(x.f.principal,x.f.actor,x.mission.id,x.request.contractVersion,{...x.quote,maximumYen:null});
 const before=x.f.store.read(tx=>tx.listRecord(x.f.principal));assert.throws(x.prepare,/PRICE_UNKNOWN/);assert.deepEqual(x.f.store.read(tx=>tx.listRecord(x.f.principal)),before);
});
test('all old send entrypoints reject an admission-bound attempt',async t=>{
 const x=await setup(t),r=x.prepare(),before=x.state(r),c=x.f.core.codex;
 assert.throws(()=>c.acquireStart(x.f.principal,r.attempt.id));
 assert.throws(()=>c.acquireStartWithResource(x.f.principal,r.attempt.id,x.resource,r.holdId));
 assert.throws(()=>c.acquireStartWithDisclosure(x.f.principal,r.attempt.id,x.resource,r.holdId,x.disclosure));
 assert.throws(()=>c.acquireStartWithGuards(x.f.principal,r.attempt.id,{...x.guards,holdId:r.holdId,cashHoldId:r.cashHoldId}));assert.deepEqual(x.state(r),before);
});
test('profile-bound Contract cannot be prepared via an unguarded API or an old Contract',async t=>{
 const x=await setup(t),old=x.contractVersion;assert.throws(()=>x.f.core.codex.prepare(x.request));assert.throws(()=>x.f.core.codex.prepare({...x.request,contractVersion:old}));
 const {qualification,...guards}=x.guards;assert.throws(()=>x.f.core.codex.prepareWithGuards(x.request,guards));assert.equal(x.f.store.read(tx=>tx.native.listAttempts(x.f.principal)).length,0);
});
test('updated Contract cannot reuse previous admission',async t=>{
 const x=await setup(t),r=x.prepare();update(x.f,x.mission.id,v=>({...v,contractRef:x.contractVersion}));const before=x.state(r);assert.throws(()=>x.send(r),/CONTRACT_CHANGED/);assert.deepEqual(x.state(r),before);
});
test('target revisions, operations and mode are part of the profile rather than provider-name qualification',async t=>{
 const x=await setup(t),a=x.admission,p=x.f.principal,actor=x.f.actor,scope=x.mission.id;
 for(const change of [{cliVersion:'new'},{osVersion:'new'},{adapterVersion:'new'},{accountRoute:'other'},{project:'other'},{profileDigest:'c'.repeat(64)},{runnerDigest:'c'.repeat(64)},{mode:'provider'}]){
  const id=a.registerProfile(p,actor,scope,{...x.profile,...change});assert.notEqual(a.profileHash(p,id),x.profileHash);assert.throws(()=>a.observe(p,actor,id,x.observation('authentication')),/OBSERVATION_BINDING/);
 }
 assert.throws(()=>a.registerProfile(p,actor,scope,{...x.profile,operations:['generate_text']}),/OPERATIONS/);
 assert.throws(()=>a.registerProfile(p,actor,scope,{...x.profile,purpose:'dialogue'}),/PURPOSE/);
});
test('candidate execution purpose requires additional snapshot, import, blob and same-version checks',async t=>{
 const x=await setup(t,{profile:{purpose:'native_candidate_execution',operations:['read_permitted_input','generate_text','apply_candidate','build','test','collect']},omit:'same_version_apply_verify_collect'});
 assert.equal(x.requirements.length,24);assert.throws(x.prepare,/MISSING_CAPABILITY/);
});
test('synthetic receipts and successful preparation never enable provider mode',async t=>{
 const x=await setup(t);assert.throws(()=>x.f.core.codex.prepareWithGuards({...x.request,mode:'provider'},x.guards),/TARGET/);
 const y=await setup(t,{profile:{mode:'provider'}});assert.throws(()=>y.f.core.codex.prepareWithGuards({...y.request,mode:'provider'},y.guards),/CODEX_TURN_DENIED/);
 assert.equal(y.f.store.read(tx=>tx.native.listAttempts(y.f.principal)).length,0);
});
test('foreign evidence, mode, unknown capability and stale observations are refused',async t=>{
 const x=await setup(t);for(const change of [{mode:'provider'},{profileHash:'f'.repeat(64)},{capability:'invented'}])assert.throws(()=>x.observe('authentication',change),/OBSERVATION_BINDING/);
 assert.throws(()=>x.observe('authentication',{evidenceVersionId:randomUUID()}),/EVIDENCE/);
 assert.throws(()=>x.observe('authentication',{observedAt:x.f.now.getTime()-1}),/STALE_OBSERVATION/);
 assert.throws(()=>x.observe('authentication',{observedAt:x.f.now.getTime()+1}),/EXPIRY/);
});
test('separate Store and escaped/read-only transactions cannot mint an admission',async t=>{
 const x=await setup(t),y=await nativeGuards(t);const before=x.f.store.read(tx=>tx.listRecord(x.f.principal));
 assert.throws(()=>x.f.core.codex.prepareWithGuards(x.request,{...x.guards,qualification:{admission:new NativeAdmissionCoordinator(y.f.store),profileId:x.profileId}}));
 const run=tx=>x.admission.prepareInTransaction(tx,x.f.principal,x.f.actor,x.mission.id,x.request.contractVersion,x.profileId,x.request);
 let escaped;x.f.store.transaction(tx=>{escaped=tx;});assert.throws(()=>run(escaped));assert.throws(()=>x.f.store.read(run));assert.deepEqual(x.f.store.read(tx=>tx.listRecord(x.f.principal)),before);
});
test('receipt supersession persists after SQLite reopen',async t=>{
 const x=await setup(t),r=x.prepare();x.observe('authentication',{status:'fail'});await x.f.store.close();x.f.store=await LedgerStore.open(x.f.path);
 const admission=new NativeAdmissionCoordinator(x.f.store,()=>x.f.now.getTime()),bound=JSON.parse(r.attempt.binding).admission;
 assert.throws(()=>x.f.store.transaction(tx=>admission.authorizeInTransaction(tx,x.f.principal,x.f.actor,x.mission.id,x.request.contractVersion,bound.id,x.request)),/CAPABILITY_NOT_PASSED/);
});
for(const kind of ['membership','ancestor_epoch','paused'])test(`${kind} changes invalidate qualification at send`,async t=>{
 const x=await setup(t),r=x.prepare();
 x.f.store.transaction(tx=>{
  if(kind==='membership')tx.putMembership({principalId:x.f.principal,actorId:x.f.actor,role:'owner',generation:2n});
  else{const scope=tx.getScope(x.mission.id),s=kind==='ancestor_epoch'?tx.getScope(scope.parentId):scope;tx.updateScope({...s,state:kind==='paused'?'paused':s.state,epoch:s.epoch+1n,revision:s.revision+1n},s.revision);}
 });
 const before=x.state(r);assert.throws(()=>x.send(r),/AUTHORITY_CHANGED|SCOPE_STOPPED/);assert.deepEqual(x.state(r),before);
});
