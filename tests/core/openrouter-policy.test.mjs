import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareOpenRouterRequest,inspectOpenRouterIdentity} from '../../dist/core/src/openrouter-policy.js';
const p=()=>({mode:'auto',models:['meta-llama/llama-4-maverick','meta-llama/llama-4-scout'],providers:['example'],maxPromptUsdPerMillion:1,maxCompletionUsdPerMillion:2,maxOutputTokens:512,maxInputBytes:4096});
test('OpenRouter request preserves original and constrains both model and endpoint routing',()=>{
  const policy=p(),r=prepareOpenRouterRequest(policy,'原文\nそのまま');
  assert.equal(r.executionAuthorized,false);assert.equal(r.body.messages[0].content,'原文\nそのまま');
  assert.equal(r.body.model,'openrouter/auto');assert.deepEqual(r.body.plugins[0].allowed_models,policy.models);
  assert.equal(r.body.provider.allow_fallbacks,false);assert.equal(r.body.provider.zdr,true);
  assert.equal(r.body.provider.require_parameters,true);assert.equal(r.body.provider.data_collection,'deny');
  assert.deepEqual(r.body.provider.max_price,{prompt:1,completion:2,request:0});
  policy.models.push('unapproved/model');policy.providers.push('another');
  assert.equal(r.body.plugins[0].allowed_models.length,2);assert.deepEqual(r.body.provider.only,['example']);
});
test('continuation pins selected model rather than trusting Auto session stickiness',()=>{
  const r=prepareOpenRouterRequest(p(),'next','meta-llama/llama-4-scout');
  assert.equal(r.body.model,'meta-llama/llama-4-scout');assert.equal('plugins' in r.body,false);
  assert.throws(()=>prepareOpenRouterRequest(p(),'next','unapproved/model'),/CONTINUATION_MODEL/);
});
test('wildcards, dynamic routers, extra configuration and invalid limits fail closed',()=>{
  for(const models of [[],['meta-llama/*'],['openrouter/auto'],['meta-llama/latest'],['meta-llama/llama-4-scout:floor']])
    assert.throws(()=>prepareOpenRouterRequest({...p(),models},'x'));
  for(const change of [{providers:[]},{providers:['*']},{maxOutputTokens:Infinity},{maxInputBytes:0},{maxPromptUsdPerMillion:NaN},{maxCompletionUsdPerMillion:-1},{mode:'fixed'},{apiKey:'not-a-key'},{mode:'auto-beta'}])
    assert.throws(()=>prepareOpenRouterRequest({...p(),...change},'x'));
  assert.throws(()=>prepareOpenRouterRequest({...p(),maxInputBytes:2},'日'),/INPUT_LIMIT/);
});
test('fixed model and observed identity stay distinct from send permission',()=>{
  const policy={...p(),mode:'fixed',models:['meta-llama/llama-4-scout']};
  assert.equal(prepareOpenRouterRequest(policy,'x').body.model,policy.models[0]);
  const metadata={id:'gen-example',model:policy.models[0],provider:'example'};
  assert.equal(inspectOpenRouterIdentity(policy,metadata).generationId,'gen-example');
  for(const change of [{model:'unapproved/model'},{provider:'another'},{id:''},{secret:'no'}])
    assert.throws(()=>inspectOpenRouterIdentity(policy,{...metadata,...change}));
});
