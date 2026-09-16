import test from 'node:test';
import assert from 'node:assert/strict';
import {sealConfiguration,qualifyRoutingPool} from '../../dist/core/src/routing.js';
const profile=(id,patch={})=>sealConfiguration({id,version:'1',persona:'developer',model:`fixture/${id}`,effort:'provider-default',promptVersion:'1',contextPolicyVersion:'1',tools:[],runtime:'standard',billingRoute:'openrouter',capabilities:['text'],contextCapacity:4000,quality:90,expiresAt:10000,evidence:{kind:'controlled_comparison',ref:'fixture'},...patch});
function input(pool){return {originalText:'original',policyVersion:'p1',now:2000,minimumQuality:80,contextSize:1000,requiredCapabilities:['text'],availableYen:'100',nativeEnabled:false,standardDigest:pool[0].digest,current:null,reselect:false,observations:pool.map((p,i)=>({digest:p.digest,observedAt:1000,expiresAt:5000-i*100,permitted:true,qualified:true,disclosureAllowed:true,quota:'available',verifiedNoExtraCharge:false,maximumYen:String(50+i*20),expectedTotalYen:'20',expectedCompletionMs:1000,includesRework:true,evidenceRef:`e${i}`}))};}
test('all candidates qualify independently; maximum cost and earliest expiry cover the whole pool',()=>{
 const pool=[profile('a'),profile('b')],i=input(pool),r=qualifyRoutingPool(pool,i);
 assert.equal(r.kind,'eligible');assert.equal(r.members.length,2);assert.equal(r.maximumYen,'70');assert.equal(r.expiresAt,4900);assert.equal(r.executionAuthorized,false);
 assert.notEqual(r.poolDigest,qualifyRoutingPool(pool,{...i,originalText:'different'}).poolDigest);
 assert.notEqual(r.poolDigest,qualifyRoutingPool([pool[0]],input([pool[0]])).poolDigest);
});
test('one deficient member blocks the entire declared pool without lowering requirements',()=>{
 for(const patch of [{quality:20},{contextCapacity:500},{capabilities:[]},{expiresAt:2000}]){
  const pool=[profile('a'),profile('b',patch)],r=qualifyRoutingPool(pool,input(pool));assert.equal(r.kind,'blocked');assert.equal(r.maximumYen,null);assert.equal(r.rejected.length,1);
 }
 for(const patch of [{qualified:false},{disclosureAllowed:false},{quota:'unknown'},{maximumYen:'101'},{expiresAt:2000}]){
  const pool=[profile('a'),profile('b')],i=input(pool);Object.assign(i.observations[1],patch);assert.equal(qualifyRoutingPool(pool,i).kind,'blocked');
 }
});
test('model pool cannot silently change persona, depth, prompt, context, tools or billing',()=>{
 for(const patch of [{persona:'other'},{effort:'high'},{promptVersion:'2'},{contextPolicyVersion:'2'},{tools:['exec']},{billingRoute:'other'}]){
  const pool=[profile('a'),profile('b',patch)];assert.throws(()=>qualifyRoutingPool(pool,input(pool)),/PROFILE_MISMATCH/);
 }
});
test('active or valid sessions cannot be silently sent back through a dynamic router',()=>{
 const pool=[profile('a')],i=input(pool),current={digest:pool[0].digest,policyVersion:'p1',valid:true,activeTurn:false};
 assert.throws(()=>qualifyRoutingPool(pool,{...i,current}),/SESSION_PIN/);
 assert.throws(()=>qualifyRoutingPool(pool,{...i,current:{...current,activeTurn:true}}),/ACTIVE_TURN/);
 assert.equal(qualifyRoutingPool(pool,{...i,reselect:true,current:{...current,valid:false}}).kind,'eligible');
});
