import test from 'node:test';
import assert from 'node:assert/strict';
import {lookupOpenRouterGeneration} from '../../dist/host/src/openrouter-generation.js';
import {decodeOpenRouterGeneration} from '../../dist/core/src/openrouter-generation.js';
const expected={models:['model/a'],providerNames:['Example']};
const raw=patch=>Buffer.from(JSON.stringify({data:{id:'gen-old',model:'model/a',provider_name:'Example',is_byok:false,total_cost:0.000000001,cancelled:true,external_user:'private-user',...patch}}));
test('recovery performs only a fixed GET and journals before returning a restricted observation',async()=>{
 const order=[];
 const r=await lookupOpenRouterGeneration('gen-old',expected,{withKey:fn=>fn('test-only'),journal:()=>order.push('journal')},async(url,options)=>{
  assert.equal(url,'https://openrouter.ai/api/v1/generation?id=gen-old');assert.equal(options.method,'GET');assert.equal(options.body,undefined);assert.equal(options.redirect,'error');
  return new Response(raw(),{headers:{'content-type':'application/json'}});
 });
 assert.deepEqual(order,['journal']);assert.equal(r.status,'observed');assert.equal(r.totalCostCreditUnits,'1');
 assert.equal(r.outputRecovered,false);assert.equal(r.remoteStopObserved,false);assert.equal(r.settlementAuthorized,false);assert.equal(JSON.stringify(r).includes('private-user'),false);
});
test('foreign identity, missing cost, unsupported precision and BYOK stay unknown',()=>{
 for(const patch of [{id:'gen-other'},{model:'other'},{provider_name:'other'},{total_cost:null},{total_cost:0.0000000001},{is_byok:true}])assert.equal(decodeOpenRouterGeneration(raw(patch),'gen-old',expected).status,'unknown');
});
test('404, invalid MIME, transport and journal failure never become zero cost or retry',async()=>{
 for(const scenario of ['404','mime','transport','journal']){
  let calls=0;
  const r=await lookupOpenRouterGeneration('gen-old',expected,{withKey:fn=>fn('test-only'),journal:()=>{if(scenario==='journal')throw Error('disk');}},async()=>{calls++;if(scenario==='transport')throw Error('offline');return new Response(raw(),{status:scenario==='404'?404:200,headers:{'content-type':scenario==='mime'?'text/plain':'application/json'}});});
  assert.equal(calls,1);assert.equal(r.status,'unknown');assert.equal(r.totalCostCreditUnits,undefined);
 }
});
