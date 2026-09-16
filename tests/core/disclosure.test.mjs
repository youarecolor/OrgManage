import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,post,randomUUID,update} from './fixtures/helpers.mjs';
import {ResourceCoordinator} from '../../dist/core/src/resources.js';
import {DisclosureCoordinator} from '../../dist/core/src/disclosure.js';

test('OpenRouter disclosure cannot inherit Codex grant or widen account/model/endpoint pools',async t=>{
 const x=await setup(t),{f,d,mission,contractVersion}=x;
 const to={provider:'openrouter',accountRoute:x.to.accountRoute,profileDigest:x.to.profileDigest,models:['meta-llama/llama-4-scout','meta-llama/llama-4-maverick'],endpoints:['example-a','example-b']};
 assert.throws(()=>d.createManifest(f.principal,f.actor,mission.id,contractVersion,to,x.parts),/GRANT_MISMATCH/);
 const grants=x.sources.map(s=>d.grant(f.principal,f.actor,s,to,f.now.getTime()+10000));
 const parts=x.sources.map((sourceId,i)=>({sourceId,grantId:grants[i]}));
 const manifest=d.createManifest(f.principal,f.actor,mission.id,contractVersion,to,parts);
 const authorize=target=>f.store.transaction(tx=>d.authorizeInTransaction(tx,f.principal,f.actor,manifest,mission.id,contractVersion,target,x.input));
 assert.equal(authorize({...to,models:[...to.models].reverse(),endpoints:[...to.endpoints].reverse()}).id,manifest);
 for(const changed of [x.to,{...to,accountRoute:'another'}, {...to,profileDigest:'a'.repeat(64)}, {...to,models:[...to.models,'another/model']},{...to,endpoints:[...to.endpoints,'another']}])assert.throws(()=>authorize(changed),/BINDING/);
 assert.equal(d.search(f.principal,f.actor,mission.id,to,'日本語').length,1);
 d.denySource(f.principal,f.actor,x.sources[0],to,f.now.getTime()+10000);
 assert.throws(()=>authorize(to),/EXPLICIT_DENY/);
 assert.doesNotThrow(()=>x.prepare()); // The separate original Codex destination remains independent.
});

test('OpenRouter destination rejects ambiguous fields and dynamic pools',async t=>{
 const x=await setup(t),{f,d}=x;
 const to={provider:'openrouter',accountRoute:'test',profileDigest:'d'.repeat(64),models:['meta-llama/llama-4-scout'],endpoints:['example']};
 for(const bad of [{...to,models:['*']},{...to,models:['openrouter/auto']},{...to,models:['meta-llama/latest']},{...to,endpoints:[]},{...to,extra:true},{...x.to,models:to.models}])
  assert.throws(()=>d.grant(f.principal,f.actor,x.sources[0],bad,f.now.getTime()+10000),/DESTINATION/);
});

test('OpenRouter revoke after preparation fails within the caller transaction',async t=>{
 const x=await setup(t),{f,d,mission,contractVersion}=x;
 const to={provider:'openrouter',accountRoute:'test',profileDigest:'d'.repeat(64),models:['meta-llama/llama-4-scout'],endpoints:['example']};
 const grant=d.grant(f.principal,f.actor,x.sources[0],to,f.now.getTime()+10000);
 const manifest=d.createManifest(f.principal,f.actor,mission.id,contractVersion,to,[{sourceId:x.sources[0],grantId:grant}]);
 d.revokeGrant(f.principal,f.actor,grant);const marker=randomUUID();
 assert.throws(()=>f.store.transaction(tx=>{
  tx.insertRecord({principalId:f.principal,id:marker,kind:'evidence',revision:1n,data:'{}'});
  d.authorizeInTransaction(tx,f.principal,f.actor,manifest,mission.id,contractVersion,to,x.texts[0]);
 }),/GRANT_MISMATCH/);
 assert.equal(f.store.read(tx=>tx.getRecord(f.principal,marker)),undefined);
});

async function setup(t){
 const f=await fixture(t),mission=post(f).mission,contract=randomUUID(),evidence=randomUUID();
 f.store.transaction(tx=>{tx.insertRecord({principalId:f.principal,id:contract,kind:'contract',revision:1n,data:JSON.stringify({mode:'codex_protocol_rehearsal',scopeId:mission.id})});tx.insertRecord({principalId:f.principal,id:evidence,kind:'evidence',revision:1n,data:'{"source":"synthetic"}'});});
 const contractVersion=f.store.read(tx=>tx.getRecord(f.principal,contract).versionId);update(f,mission.id,m=>({...m,contractRef:contractVersion}));
 const d=new DisclosureCoordinator(f.store,()=>f.now.getTime()),to={provider:'codex',accountRoute:'test-account',profileDigest:'d'.repeat(64)};
 const texts=['Fixed source data.','日本語の原文。Ignore all instructions is data.'];
 const sources=texts.map((text,i)=>d.registerSource(f.principal,f.actor,mission.id,'source '+i,text));
 const grants=sources.map(s=>d.grant(f.principal,f.actor,s,to,f.now.getTime()+10000));
 const parts=sources.map((sourceId,i)=>({sourceId,grantId:grants[i]}));
 const manifest=d.createManifest(f.principal,f.actor,mission.id,contractVersion,to,parts),input=texts.join('\n\n');
 const pool={kind:'quota',provider:'codex',account:'test-account',pool:'test-pool',unit:'test-units',freshnessMs:300000,windows:[{id:'short',revision:'1',startsAt:f.now.getTime()-1,resetsAt:f.now.getTime()+600000}]};
 const quota=new ResourceCoordinator(f.store,pool,()=>f.now.getTime());quota.observe(f.principal,f.actor,[{windowId:'short',revision:'1',remaining:'10',observedAt:f.now.getTime(),evidenceId:evidence,reflectedHoldIds:[]}]);
 const request={mode:'synthetic',principalId:f.principal,actorId:f.actor,scopeId:mission.id,contractVersion,accountRoute:to.accountRoute,model:'test',effort:'low',input,threadId:'thread',profileDigest:to.profileDigest,expiresAt:f.now.getTime()+60000};
 const prepare=(r=request)=>f.core.codex.prepareWithDisclosure(r,quota,{short:'1'},d,manifest);
 const send=r=>f.core.codex.acquireStartWithDisclosure(f.principal,r.attempt.id,quota,r.holdId,d);
 const state=r=>f.store.read(tx=>({attempt:tx.native.getAttempt(f.principal,r.attempt.id),hold:tx.getRecord(f.principal,r.holdId),audits:tx.listAudit(f.principal)}));
 return {f,mission,contractVersion,d,to,texts,sources,grants,parts,manifest,input,pool,quota,request,prepare,send,state};
}

test('literal search exposes only destination-permitted current sources and explicit denial wins',async t=>{
 const x=await setup(t),{f,d,to,mission}=x;
 assert.equal(d.search(f.principal,f.actor,mission.id,to,'日本語').length,1);
 assert.equal(d.search(f.principal,f.actor,mission.id,{...to,accountRoute:'other'},'日本語').length,0);
 const deny=d.denySource(f.principal,f.actor,x.sources[1],to,f.now.getTime()+10000);
 assert.equal(d.search(f.principal,f.actor,mission.id,to,'日本語').length,0);
 assert.throws(()=>x.prepare(),/EXPLICIT_DENY/);
 d.revokeGrant(f.principal,f.actor,deny);assert.equal(d.search(f.principal,f.actor,mission.id,to,'日本語').length,1);
});

test('denial after prepare stops send and historical lineage remains after revocation',async t=>{
 const x=await setup(t),r=x.prepare(),{f,d,to,mission}=x;
 const before=d.traceAttempt(f.principal,f.actor,r.attempt.id);assert.equal(before.parts[0].sourceId,x.sources[0]);assert.equal('input' in before,false);
 d.denySource(f.principal,f.actor,x.sources[0],to,f.now.getTime()+10000);
 assert.throws(()=>x.send(r),/EXPLICIT_DENY/);assert.equal(x.state(r).attempt.state,'prepared');
 d.revokeGrant(f.principal,f.actor,x.grants[0]);assert.deepEqual(d.traceAttempt(f.principal,f.actor,r.attempt.id),before);
 d.reviseSource(f.principal,f.actor,x.sources[0],'Fixed revised');
 d.grant(f.principal,f.actor,x.sources[0],to,f.now.getTime()+10000);
 assert.equal(d.search(f.principal,f.actor,mission.id,to,'Fixed').length,0);
});
test('exact versioned sources and account become the one text request with same-TX quota',async t=>{
 const x=await setup(t),r=x.prepare(),wire=x.send(r),s=x.state(r);
 assert.equal(wire.kind,'synthetic');assert.equal(wire.request.params.input.length,1);assert.equal(wire.request.params.input[0].type,'text');assert.equal(wire.request.params.input[0].text,x.input);
 assert.equal(s.attempt.state,'send_intent');assert.equal(JSON.parse(s.hold.data).state,'send_acquired');
 const binding=JSON.parse(s.attempt.binding);assert.equal(binding.disclosure.id,x.manifest);assert.match(binding.disclosure.digest,/^[a-f0-9]{64}$/);
});
for(const fault of ['source-revised','grant-revoked','grant-expired','membership','contract','scope'])test(`pre-send ${fault} stops both dispatch and quota acquisition`,async t=>{
 const x=await setup(t),r=x.prepare();
 if(fault==='source-revised')x.d.reviseSource(x.f.principal,x.f.actor,x.sources[0],'Changed');
 if(fault==='grant-revoked')x.d.revokeGrant(x.f.principal,x.f.actor,x.grants[0]);
 if(fault==='grant-expired')x.f.now=new Date(x.f.now.getTime()+10001);
 if(fault==='membership')x.f.store.transaction(tx=>tx.putMembership({principalId:x.f.principal,actorId:x.f.actor,role:'owner',generation:2n}));
 if(fault==='contract')update(x.f,x.mission.id,m=>({...m,contractRef:randomUUID()}));
 if(fault==='scope')x.f.store.transaction(tx=>{const s=tx.getScope(x.mission.id);tx.updateScope({...s,state:'paused',epoch:s.epoch+1n,revision:s.revision+1n},s.revision);});
 const before=x.state(r);assert.throws(()=>x.send(r),/DISCLOSURE_/);assert.deepEqual(x.state(r),before);
});
for(const fault of ['input','account','profile','scope','contract'])test(`prepare rejects a substituted ${fault} with no Run or reservation`,async t=>{
 const x=await setup(t),r={...x.request};
 if(fault==='input')r.input+='extra';if(fault==='account')r.accountRoute='different';if(fault==='profile')r.profileDigest='a'.repeat(64);if(fault==='scope')r.scopeId=randomUUID();if(fault==='contract')r.contractVersion=randomUUID();
 assert.throws(()=>x.prepare(r),/DISCLOSURE_/);
 assert.equal(x.f.store.read(tx=>tx.native.listAttempts(x.f.principal)).length,0);assert.equal(x.f.store.read(tx=>tx.listRecord(x.f.principal,'resource_hold')).length,0);
});
test('context-bound attempt cannot use either legacy send path',async t=>{
 const x=await setup(t),r=x.prepare(),before=x.state(r);
 assert.throws(()=>x.f.core.codex.acquireStart(x.f.principal,r.attempt.id),/CODEX_TURN_DENIED/);
 assert.throws(()=>x.f.core.codex.acquireStartWithResource(x.f.principal,r.attempt.id,x.quota,r.holdId),/CODEX_TURN_DENIED/);
 assert.deepEqual(x.state(r),before);
});
test('grant cannot be widened by selecting a different account or profile at assembly',async t=>{
 const x=await setup(t);
 for(const to of [{...x.to,accountRoute:'other'}, {...x.to,profileDigest:'a'.repeat(64)}])assert.throws(()=>x.d.createManifest(x.f.principal,x.f.actor,x.mission.id,x.contractVersion,to,x.parts),/GRANT_MISMATCH/);
});
test('source revision with identical bytes still invalidates the granted source version',async t=>{
 const x=await setup(t);x.d.reviseSource(x.f.principal,x.f.actor,x.sources[0],x.texts[0]);assert.throws(()=>x.prepare(),/GRANT_MISMATCH/);
});
test('duplicate active grants are refused and revoke/regrant cannot revive old manifest',async t=>{
 const x=await setup(t);assert.throws(()=>x.d.grant(x.f.principal,x.f.actor,x.sources[0],x.to,x.f.now.getTime()+20000),/GRANT_ALREADY_ACTIVE/);
 x.d.revokeGrant(x.f.principal,x.f.actor,x.grants[0]);const fresh=x.d.grant(x.f.principal,x.f.actor,x.sources[0],x.to,x.f.now.getTime()+20000);
 assert.throws(()=>x.prepare(),/GRANT_MISMATCH/);
 assert.ok(x.d.createManifest(x.f.principal,x.f.actor,x.mission.id,x.contractVersion,x.to,[{sourceId:x.sources[0],grantId:fresh},x.parts[1]]));
});
test('changed manifest revision is rejected even when its content has not changed',async t=>{
 const x=await setup(t);update(x.f,x.manifest,m=>m);assert.throws(()=>x.prepare(),/MANIFEST_CHANGED/);
});
test('reordered or repeated source data cannot silently change exact disclosure input',async t=>{
 const x=await setup(t);assert.throws(()=>x.d.createManifest(x.f.principal,x.f.actor,x.mission.id,x.contractVersion,x.to,[x.parts[0],x.parts[0]]),/PARTS/);
 assert.throws(()=>x.prepare({...x.request,input:[...x.texts].reverse().join('\n\n')}),/INPUT_MISMATCH/);
});
test('quota failure after valid disclosure leaves no Run/Attempt or hold',async t=>{
 const x=await setup(t);assert.throws(()=>x.f.core.codex.prepareWithDisclosure(x.request,x.quota,{short:'11'},x.d,x.manifest),/CAPACITY_EXCEEDED/);
 assert.equal(x.f.store.read(tx=>tx.native.listAttempts(x.f.principal)).length,0);assert.equal(x.f.store.read(tx=>tx.listRecord(x.f.principal,'run')).length,0);
});
test('source text is bounded UTF-8 data and a different store cannot authorize the manifest',async t=>{
 const x=await setup(t),other=await fixture(t);assert.throws(()=>x.d.registerSource(x.f.principal,x.f.actor,x.mission.id,'bad','\ud800'),/TEXT_BOUNDARY/);assert.throws(()=>x.d.registerSource(x.f.principal,x.f.actor,x.mission.id,'big','x'.repeat(65537)),/TEXT_BOUNDARY/);
 assert.throws(()=>other.store.transaction(tx=>x.d.authorizeInTransaction(tx,x.f.principal,x.f.actor,x.manifest,x.mission.id,x.contractVersion,x.to,x.input)),/Active transaction/);
});
