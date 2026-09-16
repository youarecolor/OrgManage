import test from 'node:test';
import assert from 'node:assert/strict';
import {OpenRouterTextExecutor} from '../../dist/host/src/openrouter-executor.js';
const policy={mode:'fixed',models:['meta-llama/llama-4-scout'],providers:['example'],maxPromptUsdPerMillion:1,maxCompletionUsdPerMillion:2,maxOutputTokens:128,maxInputBytes:4096};
const expected={models:policy.models,providerNames:['Example']};
const limits={maxSteps:1,maxInputBytes:8192,maxOutputBytes:8192,deadlineMs:1000,tools:[]};
function setup(overrides={},rawOverrides={}){
 const events=[];let digest;
 const ports={
  acquire:d=>{digest=d;events.push('acquire');return 'same-effect';},
  confirmAcquired:(id,d)=>{assert.equal(id,'same-effect');assert.equal(d,digest);events.push('confirm');},
  withKey:async cb=>{events.push('key');return cb('synthetic-only-key');},
  journal:(id,status,bytes,mime)=>{assert.equal(id,'same-effect');assert.equal(mime,'application/json');events.push('journal');},
  observe:(id,r)=>{assert.equal(id,'same-effect');events.push(['provider',r.outputState,r.costState]);},
  progress:(id,state)=>{assert.equal(id,'same-effect');events.push(['executor',state]);},...overrides};
 const fetcher=async(_url,init)=>{events.push('send');assert.equal(JSON.parse(init.body).messages[0].content,'original');return new Response(JSON.stringify({id:'gen-test',object:'chat.completion',model:policy.models[0],provider:'Example',choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:'candidate'}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2,cost:0.001},...rawOverrides}),{headers:{'content-type':'application/json'}});};
 return {events,executor:new OpenRouterTextExecutor(ports,policy,expected,limits,fetcher)};
}
test('standard loop uses one acquired effect for wire, durable journal, provider cost and executor progress',async()=>{
 const x=setup(),r=await x.executor.run('original',new AbortController().signal);
 assert.deepEqual(r,{state:'completed',text:'candidate',steps:1});
 assert.deepEqual(x.events,['acquire','confirm','key','send','journal',['provider','completed','observed'],['executor','completed']]);
 await assert.rejects(x.executor.run('original',new AbortController().signal),/CONSUMED/);
});
test('guard revoked between acquisition and wire starts no network and retains unresolved executor state',async()=>{
 const x=setup({confirmAcquired:()=>{throw Error('revoked');}});
 assert.equal((await x.executor.run('original',new AbortController().signal)).state,'unknown');
 assert.deepEqual(x.events,['acquire',['executor','unknown']]);
});
test('unknown output does not become a final candidate; observed cost is still passed through',async()=>{
 const x=setup({}, {provider:'Unapproved'});
 assert.equal((await x.executor.run('original',new AbortController().signal)).state,'unknown');
 assert.deepEqual(x.events.slice(-2),[['provider','unknown','observed'],['executor','unknown']]);
});
test('pre-stop does not acquire or fetch',async()=>{
 const x=setup(),stop=new AbortController();stop.abort();
 assert.equal((await x.executor.run('original',stop.signal)).state,'stopped');assert.deepEqual(x.events,[]);
});
