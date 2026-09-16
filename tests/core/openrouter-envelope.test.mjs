import test from 'node:test';
import assert from 'node:assert/strict';
import {openrouterEnvelope} from '../../dist/core/src/openrouter-envelope.js';
const model='meta-llama/llama-4-maverick',now=1000000;
const policy={mode:'fixed',models:[model],providers:['example/fp8'],maxPromptUsdPerMillion:0.2,maxCompletionUsdPerMillion:0.7,maxOutputTokens:4096,maxInputBytes:4096};
function fixture(patch={}){const e={model_id:model,provider_name:'Example',tag:'example/fp8',status:0,context_length:128000,max_completion_tokens:16384,supported_parameters:['max_tokens'],pricing:{prompt:'0.0000001875',completion:'0.0000006525'},...patch};return {catalogs:[{model,bytes:Buffer.from(JSON.stringify({data:{id:model,endpoints:[e]}})),observedAt:now}],zdr:{bytes:Buffer.from(JSON.stringify({data:[e]})),observedAt:now}};}
test('envelope uses the full prompt capacity and capped prices, not original text length',()=>{
 const x=fixture(),a=openrouterEnvelope(policy,'x',x.catalogs,x.zdr,now),b=openrouterEnvelope(policy,'longer text',x.catalogs,x.zdr,now);
 assert.equal(a.maximumUsd,'0.0284672');assert.equal(a.maximumUsd,b.maximumUsd);assert.notEqual(a.requestDigest,b.requestDigest);assert.equal(a.executionAuthorized,false);assert.equal(a.jpyVerified,false);
});
test('unknown output limits, missing ZDR, broad provider prefix and stale evidence refuse envelopes',()=>{
 const x=fixture();
 for(const patch of [{max_completion_tokens:null},{max_completion_tokens:100},{status:-1},{pricing:{prompt:'0.1',completion:'0.1'}}]){const f=fixture(patch);assert.throws(()=>openrouterEnvelope(policy,'x',f.catalogs,f.zdr,now));}
 assert.throws(()=>openrouterEnvelope(policy,'x',x.catalogs,{bytes:Buffer.from('{"data":[]}'),observedAt:now},now));
 assert.throws(()=>openrouterEnvelope({...policy,providers:['example']},'x',x.catalogs,x.zdr,now));
 assert.throws(()=>openrouterEnvelope(policy,'x',x.catalogs,x.zdr,now+300000),/STALE/);
});
test('rounding is upward at nanodollar precision',()=>{
 const x=fixture({context_length:1,pricing:{prompt:'0',completion:'0'}});
 const r=openrouterEnvelope({...policy,maxPromptUsdPerMillion:0.000000001,maxCompletionUsdPerMillion:0,maxOutputTokens:1},'x',x.catalogs,x.zdr,now);
 assert.equal(r.maximumUsd,'0.000000001');
});

test('automatic model routing reserves the largest eligible request, not an average',()=>{
 const x=fixture(),second='meta-llama/llama-4-scout';
 const e={...JSON.parse(x.catalogs[0].bytes).data.endpoints[0],model_id:second,context_length:256000};
 const catalogs=[...x.catalogs,{model:second,bytes:Buffer.from(JSON.stringify({data:{id:second,endpoints:[e]}})),observedAt:now}];
 const zdr={bytes:Buffer.from(JSON.stringify({data:[...JSON.parse(x.zdr.bytes).data,e]})),observedAt:now};
 const r=openrouterEnvelope({...policy,mode:'auto',models:[model,second]},'x',catalogs,zdr,now);
 assert.equal(r.maximumUsd,'0.0540672');assert.equal(r.endpoints.length,2);
});
