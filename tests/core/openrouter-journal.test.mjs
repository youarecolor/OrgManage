import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,randomUUID,LedgerStore,update} from './fixtures/helpers.mjs';
import {OpenRouterJournal} from '../../dist/core/src/openrouter-journal.js';
import {OpenRouterTransport} from '../../dist/host/src/openrouter-transport.js';
const expected={models:['meta-llama/llama-4-scout'],providerNames:['Example']};
const body=()=>Buffer.from(JSON.stringify({id:'gen-test',object:'chat.completion',model:expected.models[0],provider:'Example',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'recovered'}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2,cost:0.01}}));
async function setup(t){const f=await fixture(t),intent=randomUUID();f.store.transaction(tx=>tx.insertRecord({principalId:f.principal,id:intent,kind:'intent',revision:1n,data:JSON.stringify({route:'openrouter',state:'send_intent',requestDigest:'a'.repeat(64)})}));return {f,intent,j:new OpenRouterJournal(f.store,()=>f.now.getTime())};}
test('response can be recovered after real database close/reopen without repeating a send',async t=>{
 const x=await setup(t),id=x.j.append(x.f.principal,x.f.actor,x.intent,200,body(),'application/json');
 update(x.f,x.intent,v=>({...v,state:'unknown'}));await x.f.store.close();x.f.store=await LedgerStore.open(x.f.path);x.j=new OpenRouterJournal(x.f.store);
 const r=x.j.recover(x.f.principal,x.f.actor,x.intent,expected);assert.equal(r.receiptId,id);assert.equal(r.outputState,'completed');assert.equal(r.text,'recovered');assert.equal(r.usage.costCredits,0.01);
 assert.equal(JSON.parse(x.f.store.read(tx=>tx.getRecord(x.f.principal,x.intent).data)).state,'unknown');
});
test('same receipt is idempotent and conflicting responses cannot overwrite it',async t=>{
 const {f,j,intent}=await setup(t),id=j.append(f.principal,f.actor,intent,200,body(),'application/json');assert.equal(j.append(f.principal,f.actor,intent,200,body(),'application/json'),id);
 assert.throws(()=>j.append(f.principal,f.actor,intent,200,body(),'text/plain'),/CONFLICT/);
 assert.throws(()=>j.append(f.principal,f.actor,intent,500,body()),/CONFLICT/);assert.equal(j.recover(f.principal,f.actor,intent,expected).outputState,'completed');
});
test('actor, request substitution, premature response and oversized input fail closed',async t=>{
 const {f,j,intent}=await setup(t);assert.throws(()=>j.append(f.principal,randomUUID(),intent,200,body()),/ACTOR/);
 assert.throws(()=>j.append(f.principal,f.actor,intent,200,new Uint8Array(262145)),/BODY_LIMIT/);
 j.append(f.principal,f.actor,intent,200,body());update(f,intent,v=>({...v,requestDigest:'b'.repeat(64)}));assert.throws(()=>j.recover(f.principal,f.actor,intent,expected),/BINDING/);
 update(f,intent,v=>({...v,state:'prepared'}));assert.throws(()=>j.append(f.principal,f.actor,intent,200,body()),/NOT_SENT/);
});
test('error and invalid JSON remain unknown and do not expose raw bodies',async t=>{
 for(const [status,raw] of [[500,'private upstream error'],[200,'{"duplicate":1,"duplicate":2}']]){
  const {f,j,intent}=await setup(t);j.append(f.principal,f.actor,intent,status,Buffer.from(raw),'application/json');const r=j.recover(f.principal,f.actor,intent,expected);
  assert.equal(r.outputState,'unknown');assert.equal(JSON.stringify(r).includes('private'),false);
  assert.equal(r.reason,status===500?'http_error':'invalid_response');
 }
});

test('transport projection failure still leaves a recoverable durable response',async t=>{
 const {f,intent,j}=await setup(t);let first=true,calls=0;
 const transport=new OpenRouterTransport({
  acquire:requestDigest=>{update(f,intent,v=>({...v,requestDigest}));return intent;},
  withKey:async callback=>callback('synthetic-only-api-key'),
  journal:(id,status,bytes,contentType)=>j.append(f.principal,f.actor,id,status,bytes,contentType),
  observe:()=>{if(first){first=false;throw Error('synthetic projection fault');}update(f,intent,v=>({...v,state:'unknown'}));},
 },async()=>{calls++;return new Response(body(),{headers:{'content-type':'application/json'}});});
 const p={mode:'fixed',models:expected.models,providers:['example'],maxPromptUsdPerMillion:1,maxCompletionUsdPerMillion:2,maxOutputTokens:128,maxInputBytes:4096};
 assert.equal((await transport.send(p,'original',expected,new AbortController().signal)).state,'unknown');assert.equal(calls,1);
 const r=j.recover(f.principal,f.actor,intent,expected);assert.equal(r.outputState,'completed');assert.equal(r.text,'recovered');
 assert.equal(JSON.parse(f.store.read(tx=>tx.getRecord(f.principal,intent).data)).state,'unknown');
});

test('live and reopened recovery agree on JSON MIME admission without another send',async t=>{
 for(const contentType of ['text/plain','application/jsonp','Application/JSON; charset=utf-8',null]){
  const {f,intent,j}=await setup(t);let calls=0;
  const transport=new OpenRouterTransport({
   acquire:d=>{update(f,intent,v=>({...v,requestDigest:d}));return intent;},
   withKey:async cb=>cb('synthetic-only-api-key'),
   journal:(id,status,bytes,mime)=>j.append(f.principal,f.actor,id,status,bytes,mime),
   observe:()=>{},
  },async()=>{calls++;return new Response(body(),{headers:contentType===null?{}:{'content-type':contentType}});});
  const p={mode:'fixed',models:expected.models,providers:['example'],maxPromptUsdPerMillion:1,maxCompletionUsdPerMillion:2,maxOutputTokens:128,maxInputBytes:4096};
  const live=await transport.send(p,'original',expected,new AbortController().signal);
  await f.store.close();f.store=await LedgerStore.open(f.path);
  const recovered=new OpenRouterJournal(f.store).recover(f.principal,f.actor,intent,expected);
  const accepted=contentType==='Application/JSON; charset=utf-8';
  assert.equal(live.state,accepted?'observed':'unknown');
  assert.equal(recovered.outputState,accepted?'completed':'unknown');assert.equal(calls,1);
 }
});

test('legacy receipt without MIME evidence remains unknown and cannot be silently upgraded',async t=>{
 const {f,intent,j}=await setup(t),id=randomUUID();
 const {createHash}=await import('node:crypto');
 f.store.transaction(tx=>{
  const original=tx.getRecord(f.principal,intent),bytes=body();
  tx.insertRecord({principalId:f.principal,id,kind:'evidence',revision:1n,data:JSON.stringify({format:'openrouter_response_v1',intentId:intent,intentVersion:original.versionId,requestDigest:'a'.repeat(64),status:200,bodyBase64:bytes.toString('base64'),bodyDigest:createHash('sha256').update(bytes).digest('hex'),receivedAt:f.now.getTime()})});
  tx.setMeta(`openrouter-response:${f.principal}:${intent}`,id);
 });
 const recovered=j.recover(f.principal,f.actor,intent,expected);
 assert.equal(recovered.outputState,'unknown');assert.equal(recovered.reason,'content_type_unverified');
 assert.throws(()=>j.append(f.principal,f.actor,intent,200,body(),'application/json'),/CONFLICT/);
});
