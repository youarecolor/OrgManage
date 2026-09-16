import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeOpenRouterCatalog,usdPerMillion,decodeOpenRouterZdr,matchOpenRouterZdr} from '../../dist/core/src/openrouter-catalog.js';
import * as catalogModule from '../../dist/core/src/openrouter-catalog.js';
const model='meta-llama/llama-4-maverick';
const entry=()=>({model_id:model,provider_name:'Example',tag:'example/fp8',status:0,context_length:128000,max_completion_tokens:16384,max_prompt_tokens:null,supported_parameters:['max_tokens'],pricing:{prompt:'0.0000001875',completion:'0.0000006525'}});
const bytes=endpoints=>Buffer.from(JSON.stringify({data:{id:model,endpoints}}));
test('ZDR observation matches model, endpoint tag and provider name without granting execution',()=>{
 const catalog=decodeOpenRouterCatalog(bytes([entry()]),model);
 for(const e of [entry(),{...entry(),tag:'example/other'},{...entry(),provider_name:'Different'},{...entry(),model_id:'other/model'}]){
  const preview=decodeOpenRouterZdr(Buffer.from(JSON.stringify({data:[e]})),model),r=matchOpenRouterZdr(catalog,preview)[0];
  assert.equal(r.zdrEligibilityObserved,e.tag===entry().tag&&e.provider_name===entry().provider_name&&e.model_id===model);assert.equal(r.executionAuthorized,false);assert.equal(r.retentionVerified,false);
 }
});
test('catalog keeps exact per-million prices and does not infer missing retention or request fee',()=>{
 const r=decodeOpenRouterCatalog(bytes([entry()]),model),e=r.endpoints[0];
 assert.equal(e.promptUsdPerMillion,'0.1875');assert.equal(e.completionUsdPerMillion,'0.6525');assert.equal(e.requestFeeKnown,false);assert.equal(e.retentionVerified,false);assert.equal(r.executionAuthorized,false);
 assert.equal(usdPerMillion('0.000000000000000001'),'0.000000000001');assert.equal(usdPerMillion('0'),'0');assert.equal(usdPerMillion(null),null);
});
test('catalog exposes exact per-request fee rather than only whether a fee was present',()=>{
 const e=decodeOpenRouterCatalog(bytes([{...entry(),pricing:{prompt:'0.0000001875',completion:'0.0000006525',request:'0.000001'}}]),model).endpoints[0];
 assert.equal(e.requestUsd,'0.000001');
 assert.equal(decodeOpenRouterCatalog(bytes([entry()]),model).endpoints[0].requestUsd,null);
 assert.throws(()=>usdPerMillion('0.0001\n'),/PRICE/);
});
test('ambiguous catalog identity, duplicate tags, malformed prices and wrong types fail closed',()=>{
 for(const endpoints of [[{...entry(),model_id:'another/model'}],[entry(),entry()],[{...entry(),pricing:{prompt:'1e-7'}}],[{...entry(),status:'0'}],[{...entry(),tag:'*'}]])assert.throws(()=>decodeOpenRouterCatalog(bytes(endpoints),model));
 for(const price of [-1,0.1,'-1','NaN','0.0000000000000000001'])assert.throws(()=>usdPerMillion(price));
 assert.throws(()=>decodeOpenRouterCatalog(Buffer.from('{"data":{},"data":{}}'),model));
});
test('price basis bounds the full prompt capacity plus output in USD and does not grant runtime authority',()=>{
 assert.equal(typeof catalogModule.deriveOpenRouterPriceBasis,'function','A price basis must be derived from bounded metadata instead of an arbitrary evidence reference');
 const e={...entry(),pricing:{...entry().pricing,request:'0'}};
 const policy={mode:'fixed',models:[model],providers:[e.tag],maxPromptUsdPerMillion:1,maxCompletionUsdPerMillion:2,maxOutputTokens:128,maxInputBytes:4096};
 const sample={model,catalogBytes:bytes([e]),zdrBytes:Buffer.from(JSON.stringify({data:[e]})),observedAt:1000};
 const q=catalogModule.deriveOpenRouterPriceBasis(policy,[sample],2000);
 assert.deepEqual(q.maximum,{format:'money_v1',currency:'USD',units:'128256000'});
 assert.ok(q.conditions.includes('per_token_price_caps_enforced'));
 assert.equal(q.endpoints[0].promptTokenBound,128000);assert.equal(q.endpoints[0].completionTokenBound,128);
 assert.equal(q.expiresAt,61000);assert.equal(q.executionAuthorized,false);
 assert.equal(q.runtimeQualified,false);assert.equal(q.endpoints[0].catalogDigest,decodeOpenRouterCatalog(sample.catalogBytes,model).evidenceDigest);
});
test('price basis preserves unknown fees and rejects stale, expanded or unmodeled charge evidence',()=>{
 const e={...entry(),pricing:{...entry().pricing,request:'0'}},policy={mode:'fixed',models:[model],providers:[e.tag],maxPromptUsdPerMillion:1,maxCompletionUsdPerMillion:2,maxOutputTokens:128,maxInputBytes:4096};
 const derive=(entryPatch={},samplePatch={},policyPatch={})=>{const changed={...e,...entryPatch};return catalogModule.deriveOpenRouterPriceBasis({...policy,...policyPatch},[{model,catalogBytes:bytes([changed]),zdrBytes:Buffer.from(JSON.stringify({data:[changed]})),observedAt:1000,...samplePatch}],2000);};
 for(const patch of [{pricing:{...e.pricing,request:'1'}},{pricing:{...e.pricing,web_search:'0.001'}},{status:1},{context_length:null},{max_completion_tokens:127},{supported_parameters:[]}])assert.throws(()=>derive(patch));
 for(const patch of [{observedAt:2001},{observedAt:-1},{observedAt:1},{zdrBytes:Buffer.from('{"data":[]}')},{catalogBytes:bytes([e,{...e,tag:e.tag+'/region'}])}]){
  if(patch.observedAt===1)assert.throws(()=>catalogModule.deriveOpenRouterPriceBasis(policy,[{model,catalogBytes:bytes([e]),zdrBytes:Buffer.from(JSON.stringify({data:[e]})),...patch}],60001),/EXPIRED/);
  else assert.throws(()=>derive({},patch));
 }
 assert.throws(()=>derive({}, {},{maxPromptUsdPerMillion:0.1}),/PRICE_CAP/);
 const cache=derive({pricing:{...e.pricing,input_cache_write:'0.0000005'}});assert.equal(cache.maximum.units,'128256000');
 const missing=derive({pricing:{...e.pricing,request:undefined,discount:0}});assert.equal(missing.endpoints[0].requestFeeKnown,false);assert.ok(missing.conditions.includes('request_price_cap_zero_enforced'));
 const tiny=derive({pricing:{prompt:'0.000000000000000001',completion:'0.000000000000000001',request:'0'}},{},{maxPromptUsdPerMillion:0.000000001,maxCompletionUsdPerMillion:0.000000001});assert.equal(tiny.maximum.units,'1');
});
