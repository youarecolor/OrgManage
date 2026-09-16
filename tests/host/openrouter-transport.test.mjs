import test from 'node:test';
import assert from 'node:assert/strict';
import {OpenRouterTransport} from '../../dist/host/src/openrouter-transport.js';
const policy=()=>({mode:'fixed',models:['meta-llama/llama-4-scout'],providers:['example'],maxPromptUsdPerMillion:1,maxCompletionUsdPerMillion:2,maxOutputTokens:512,maxInputBytes:4096});
const expected={models:policy().models,providerNames:['Example']};
const raw=()=>({id:'gen-fixture',object:'chat.completion',model:expected.models[0],provider:'Example',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'done'}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2,cost:0}});
function fixture(overrides={},fetchOverride){
 const events=[];
 const ports={acquire:d=>{events.push('acquire');assert.match(d,/^[a-f0-9]{64}$/);return 'effect';},withKey:async consume=>{events.push('key');return consume('synthetic-provider-key');},journal:()=>events.push('journal'),observe:(_id,r)=>events.push(r.outputState),...overrides};
 const fetcher=fetchOverride??(async(url,init)=>{events.push('fetch');assert.equal(url,'https://openrouter.ai/api/v1/chat/completions');assert.equal(init.redirect,'error');assert.equal(JSON.parse(init.body).messages[0].content,'original');return new Response(JSON.stringify(raw()),{headers:{'content-type':'application/json'}});});
 return {events,transport:new OpenRouterTransport(ports,fetcher)};
}
test('transport acquires before secrets/send and journals before completion',async()=>{
 const x=fixture(),r=await x.transport.send(policy(),'original',expected,new AbortController().signal);
 assert.equal(r.state,'observed');assert.deepEqual(x.events,['acquire','key','fetch','journal','completed']);
 await assert.rejects(x.transport.send(policy(),'original',expected,new AbortController().signal),/CONSUMED/);
});
test('denied acquisition or pre-cancel creates no network operation',async()=>{
 const x=fixture({acquire:()=>{throw Error('denied');}});assert.equal((await x.transport.send(policy(),'original',expected,new AbortController().signal)).state,'not_sent');assert.deepEqual(x.events,[]);
 const y=fixture(),stop=new AbortController();stop.abort();assert.equal((await y.transport.send(policy(),'original',expected,stop.signal)).state,'not_sent');assert.deepEqual(y.events,[]);
});
test('uncooperative network timeout is unknown with no automatic retry',async()=>{
 let calls=0;const x=fixture({},async()=>{calls++;return new Promise(()=>{});});
 assert.equal((await x.transport.send(policy(),'original',expected,new AbortController().signal,10)).state,'unknown');assert.equal(calls,1);assert.equal(x.events.at(-1),'unknown');
});
test('HTTP error is journaled without reflecting provider secrets or retry',async()=>{
 const x=fixture({},async()=>new Response('private upstream error',{status:500}));const r=await x.transport.send(policy(),'original',expected,new AbortController().signal);
 assert.equal(r.state,'unknown');assert.deepEqual(x.events,['acquire','key','journal','unknown']);assert.equal(JSON.stringify(r).includes('private'),false);
});
test('journal failure cannot publish a successful completion',async()=>{
 const x=fixture({journal:()=>{throw Error('disk full');}});assert.equal((await x.transport.send(policy(),'original',expected,new AbortController().signal)).state,'unknown');assert.equal(x.events.includes('completed'),false);
});
