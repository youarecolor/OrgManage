import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {fetchOpenRouterMetadata} from '../../dist/host/src/openrouter-metadata.js';

const models=['meta-llama/llama-4-scout','openai/gpt-5.4'];
const startedAt=Date.parse('2026-09-15T00:00:00Z');
const jsonResponse=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});

test('reads only fixed public metadata URLs and returns private evidence without execution authority',async()=>{
 const calls=[];
 const result=await fetchOpenRouterMetadata(models,new AbortController().signal,async(url,init)=>{
  calls.push([url,init]);
  return jsonResponse({data:{url}});
 },()=>startedAt);
 assert.equal(result.state,'observed');
 assert.deepEqual(calls.map(([url])=>url),[
  'https://openrouter.ai/api/v1/models/meta-llama/llama-4-scout/endpoints',
  'https://openrouter.ai/api/v1/models/openai/gpt-5.4/endpoints',
  'https://openrouter.ai/api/v1/endpoints/zdr',
 ]);
 for(const [,init] of calls){
  assert.equal(init.method,'GET');assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');
  assert.equal(init.body,undefined);assert.equal('Authorization' in (init.headers??{}),false);
 }
 assert.equal(result.observations.length,3);
 assert.deepEqual(result.observations.map(o=>[o.kind,o.model]),[
  ['model_endpoints',models[0]],['model_endpoints',models[1]],['zdr_preview',undefined],
 ]);
 for(const observation of result.observations){
  assert.equal(observation.observedAt,startedAt);
  assert.equal(observation.bytes.buffer instanceof SharedArrayBuffer,false);
  assert.equal(observation.sha256,createHash('sha256').update(observation.bytes).digest('hex'));
 }
 assert.equal(result.runtimeQualified,false);assert.equal(result.executionAuthorized,false);
});

test('rejects malformed, duplicate, empty, and oversized model sets before HTTP',async()=>{
 const bad=[[],Array.from({length:17},(_,i)=>`author/model-${i}`),['author/model','author/model'],
  ['Author/model'],['author/../model'],['author/model?x'],['author/model/extra'],['author/%2e%2e'],
  ['author/model\n'],[`author/${'m'.repeat(194)}`]];
 for(const models of bad){
  const r=await fetchOpenRouterMetadata(models,new AbortController().signal,async()=>assert.fail('must not fetch'),()=>startedAt);
  assert.equal(r.state,'invalid_request');assert.deepEqual(r.observations,[]);
 }
});

test('rejects redirects, non-200 or non-JSON responses without retries or partial evidence',async()=>{
 const redirect=jsonResponse({data:[]});Object.defineProperty(redirect,'redirected',{value:true});
 for(const response of [redirect,new Response('{}',{status:503,headers:{'content-type':'application/json'}}),new Response('{}',{headers:{'content-type':'text/plain'}})]){
  let calls=0,cancelled=false;
  const body=response.body;
  if(body){const original=body.cancel.bind(body);body.cancel=async()=>{cancelled=true;return original();};}
  const r=await fetchOpenRouterMetadata([models[0]],new AbortController().signal,async()=>{calls++;return response;},()=>startedAt);
  assert.equal(r.state,'unavailable');assert.equal(calls,1);assert.deepEqual(r.observations,[]);assert.equal(cancelled,true);
 }
});

test('enforces the 4 MiB private-byte boundary and rejects shared-memory chunks',async()=>{
 const cases=[new Uint8Array(4*1024*1024+1),new Uint8Array(new SharedArrayBuffer(2))];
 for(const chunk of cases){
  const body=new ReadableStream({start(controller){controller.enqueue(chunk);controller.close();}});
  const response={status:200,redirected:false,headers:new Headers({'content-type':'application/json'}),body};
  const r=await fetchOpenRouterMetadata([models[0]],new AbortController().signal,async()=>response,()=>startedAt);
  assert.equal(r.state,'unavailable');assert.deepEqual(r.observations,[]);assert.equal(body.locked,false);
 }
});

test('copies source chunks before exposing raw evidence bytes',async()=>{
 const sources=[];
 const r=await fetchOpenRouterMetadata([models[0]],new AbortController().signal,async()=>{
  const source=Buffer.from('{"data":[]}');sources.push(source);
  return {status:200,redirected:false,headers:new Headers({'content-type':'application/json'}),body:new ReadableStream({start(c){c.enqueue(source);c.close();}})};
 },()=>startedAt);
 assert.equal(r.state,'observed');
 const before=r.observations.map(o=>Buffer.from(o.bytes).toString('utf8'));
 for(const source of sources)source.fill(0);
 assert.deepEqual(r.observations.map(o=>Buffer.from(o.bytes).toString('utf8')),before);
});

test('uses strict metadata JSON validation for duplicate keys and invalid UTF-8',async()=>{
 for(const raw of [Buffer.from('{"data":1,"data":2}'),Buffer.from([0xff])]){
  let calls=0;
  const response={status:200,redirected:false,headers:new Headers({'content-type':'application/json'}),body:new ReadableStream({start(c){c.enqueue(raw);c.close();}})};
  const r=await fetchOpenRouterMetadata([models[0]],new AbortController().signal,async()=>{calls++;return response;},()=>startedAt);
  assert.equal(r.state,'unavailable');assert.equal(calls,1);assert.deepEqual(r.observations,[]);
 }
});

test('caller cancellation releases a stalled reader and cannot retain partial success',async()=>{
 const stop=new AbortController();let cancelled=false,calls=0;
 const completed=jsonResponse({data:{id:models[0],endpoints:[]}});
 const stalledBody=new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;}});
 const stalled={status:200,redirected:false,headers:new Headers({'content-type':'application/json'}),body:stalledBody};
 const pending=fetchOpenRouterMetadata(models,stop.signal,async()=>++calls===1?completed:stalled,()=>startedAt);
 await new Promise(resolve=>setImmediate(resolve));stop.abort();
 const r=await pending;
 assert.equal(r.state,'interrupted');assert.deepEqual(r.observations,[]);assert.equal(calls,2);assert.equal(cancelled,true);assert.equal(stalledBody.locked,false);
});

test('an uncooperative late fetch is cancelled and never upgrades the interrupted result',async()=>{
 const stop=new AbortController();let finish,cancelled=false;
 const pending=fetchOpenRouterMetadata([models[0]],stop.signal,()=>new Promise(resolve=>{finish=resolve;}),()=>startedAt);
 stop.abort();const r=await pending;
 assert.equal(r.state,'interrupted');assert.deepEqual(r.observations,[]);
 const body=new ReadableStream({cancel(){cancelled=true;}});
 finish({status:200,redirected:false,headers:new Headers({'content-type':'application/json'}),body});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(cancelled,true);assert.equal(r.state,'interrupted');
});

test('the fixed total deadline interrupts an uncooperative fetch without retry',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0;
 const pending=fetchOpenRouterMetadata([models[0]],new AbortController().signal,()=>{calls++;return new Promise(()=>{});},()=>startedAt);
 t.mock.timers.tick(15000);
 const r=await pending;
 assert.equal(r.state,'interrupted');assert.equal(calls,1);assert.deepEqual(r.observations,[]);
});
