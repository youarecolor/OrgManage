import test from 'node:test';
import assert from 'node:assert/strict';
import {readOpenRouterBody,decodeOpenRouterResponse} from '../../dist/core/src/openrouter-response.js';
const encode=v=>new TextEncoder().encode(JSON.stringify(v));
const expected={models:['meta-llama/llama-4-maverick'],providerNames:['Example Provider']};
const response=()=>({id:'gen-fixture',object:'chat.completion',model:expected.models[0],provider:expected.providerNames[0],choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'回答'}}],usage:{prompt_tokens:4,completion_tokens:2,total_tokens:6,cost:0.0001}});
test('response projection separates output from cost observation and retains evidence',()=>{
  const r=decodeOpenRouterResponse(encode(response()),expected);assert.equal(r.outputState,'completed');assert.equal(r.text,'回答');assert.equal(r.costState,'observed');assert.equal(r.responseDigest.length,64);
  const missing=response();delete missing.usage;const m=decodeOpenRouterResponse(encode(missing),expected);assert.equal(m.outputState,'completed');assert.equal(m.costState,'unknown');assert.equal(m.generationId,'gen-fixture');
});
test('wrong identity and truncated/tool outputs remain unresolved without losing charged usage',()=>{
  for(const change of [{model:'another/model'},{provider:'Unapproved'},{id:'invalid'}, {choices:[{index:0,finish_reason:'length',message:{role:'assistant',content:'partial'}}]}, {choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'text',tool_calls:[]}}]}]){
    const r=decodeOpenRouterResponse(encode({...response(),...change}),expected);assert.equal(r.outputState,'unknown');assert.equal(r.text,null);assert.equal(r.costState,'observed');
  }
});
test('missing or inconsistent cost is unknown, explicit zero is an observation',()=>{
  for(const usage of [null,{}, {...response().usage,cost:-1},{...response().usage,total_tokens:7}])assert.equal(decodeOpenRouterResponse(encode({...response(),usage}),expected).costState,'unknown');
  assert.equal(decodeOpenRouterResponse(encode({...response(),usage:{...response().usage,cost:0}}),expected).usage.costCredits,0);
});
test('strict response parser rejects duplicate keys, depth bombs and invalid UTF8',()=>{
  for(const bytes of [new TextEncoder().encode('{"id":"a","id":"b"}'),new Uint8Array([255]),new TextEncoder().encode('['.repeat(20)+'0'+']'.repeat(20))])assert.throws(()=>decodeOpenRouterResponse(bytes,expected));
});
test('body reader handles split UTF8 and cancels oversized input',async()=>{
  const bytes=encode(response());let i=0;const stream=new ReadableStream({pull(c){if(i===bytes.length)c.close();else c.enqueue(bytes.slice(i,i+=1));}});
  assert.deepEqual(await readOpenRouterBody(stream,new AbortController().signal),bytes);
  let cancelled=false;const oversized=new ReadableStream({pull(c){c.enqueue(new Uint8Array(3));},cancel(){cancelled=true;}});
  await assert.rejects(readOpenRouterBody(oversized,new AbortController().signal,2),/RESPONSE_LIMIT/);assert.equal(cancelled,true);
});
test('stalled reader aborts locally without waiting for remote cancellation',async()=>{
  let cancelled=false;const stream=new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;return new Promise(()=>{});}});
  const stop=new AbortController(),timer=setTimeout(()=>stop.abort(),10);
  try{await assert.rejects(readOpenRouterBody(stream,stop.signal),/READ_ABORTED/);assert.equal(cancelled,true);}finally{clearTimeout(timer);}
});
