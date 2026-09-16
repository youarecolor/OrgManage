import test from 'node:test';
import assert from 'node:assert/strict';
import {sealConfiguration,selectRoute} from '../../dist/core/src/routing.js';
import {parseMoney} from '../../dist/core/src/money.js';

const profile=(id,change={})=>sealConfiguration({id,version:'1',persona:'developer',model:id,effort:'low',promptVersion:'1',contextPolicyVersion:'1',tools:[],runtime:'standard',billingRoute:'test-only',capabilities:['text'],contextCapacity:4000,quality:90,expiresAt:10000,evidence:{kind:'controlled_comparison',ref:'fixture-comparison-1'},...change});
const observation=(p,change={})=>({digest:p.digest,observedAt:1000,expiresAt:5000,permitted:true,qualified:true,disclosureAllowed:true,quota:'available',verifiedNoExtraCharge:false,maximumYen:'100',expectedTotalYen:'80',expectedCompletionMs:2000,includesRework:true,evidenceRef:'synthetic-observation',...change});
const input=(pool,change={})=>({originalText:'元の要求を保持する',policyVersion:'policy-1',now:2000,minimumQuality:80,contextSize:1000,requiredCapabilities:['text'],availableYen:'100',nativeEnabled:true,standardDigest:pool[0].digest,current:null,reselect:false,observations:pool.map(p=>observation(p)),...change});

test('quality precedes price; output is a proposal and sealed fields remain separate',()=>{
  const pool=[profile('quality'),profile('cheap',{quality:50})];
  const i=input(pool,{observations:[observation(pool[0]),observation(pool[1],{maximumYen:'0',expectedTotalYen:'0'})]});
  const r=selectRoute(pool,i);assert.equal(r.digest,pool[0].digest);assert.equal(r.executionAuthorized,false);
  assert.equal(r.rejected[0].reason,'requirements_not_met');assert.notEqual(r.inputDigest,selectRoute(pool,{...i,originalText:'別の原文'}).inputDigest);
});
test('valid session continues despite a cheaper, faster alternative unless reselection is requested',()=>{
  const pool=[profile('existing'),profile('faster')];
  const i=input(pool,{current:{digest:pool[0].digest,policyVersion:'policy-1',valid:true,activeTurn:false},observations:[observation(pool[0]),observation(pool[1],{expectedTotalYen:'20',expectedCompletionMs:100})]});
  assert.equal(selectRoute(pool,i).kind,'continue');assert.equal(selectRoute(pool,{...i,reselect:true}).digest,pool[1].digest);
});
test('active turn is never rerouted, and a run cannot acquire a new policy silently',()=>{
  const pool=[profile('a')];const current={digest:pool[0].digest,policyVersion:'old',valid:true,activeTurn:true};
  assert.equal(selectRoute(pool,input(pool,{current})).kind,'wait');
  assert.equal(selectRoute(pool,input(pool,{current:{...current,activeTurn:false}})).reason,'run_policy_changed');
});
for(const [label,change,reason] of [
  ['denied',{permitted:false},'not_admitted'],['unqualified',{qualified:false},'not_admitted'],
  ['disclosure revoked',{disclosureAllowed:false},'not_admitted'],['stale',{expiresAt:2000},'expired'],
  ['future',{observedAt:2001},'expired'],['quota exhausted',{quota:'exhausted'},'quota_unavailable'],
  ['quota unknown',{quota:'unknown'},'quota_unavailable'],['no rework estimate',{includesRework:false},'total_estimate_missing'],
  ['unaffordable worst case',{maximumYen:'101'},'budget_unavailable']]){
  test(`refuses ${label} even on current session`,()=>{const p=profile('a'),i=input([p],{observations:[observation(p,change)],current:{digest:p.digest,policyVersion:'policy-1',valid:true,activeTurn:false}});const r=selectRoute([p],i);assert.equal(r.kind,'blocked');assert.equal(r.rejected[0].reason,reason);});
}
test('unknown quota exception requires verified zero additional charge and zero bound',()=>{
  const p=profile('a'),i=input([p],{observations:[observation(p,{quota:'unknown',verifiedNoExtraCharge:true,maximumYen:'0',expectedTotalYen:'0'})]});
  assert.equal(selectRoute([p],i).kind,'select');
  assert.equal(selectRoute([p],{...i,observations:[{...i.observations[0],maximumYen:'1'}]}).kind,'blocked');
});
test('native-disabled cannot select native even as the standard profile',()=>{
  const p=profile('a',{runtime:'native'});assert.equal(selectRoute([p],input([p],{nativeEnabled:false})).rejected[0].reason,'native_disabled');
});
test('tradeoffs and non-comparable evidence fall back to permitted standard, never arbitrary cheapest',()=>{
  const pool=[profile('standard'),profile('cheap',{evidence:{kind:'observed_selected_only',ref:'one-run'}})];
  const i=input(pool,{observations:[observation(pool[0]),observation(pool[1],{expectedTotalYen:'1',expectedCompletionMs:1})]});
  const r=selectRoute(pool,i);assert.equal(r.digest,pool[0].digest);assert.equal(r.reason,'standard_profile_under_uncertainty');
  const denied=selectRoute(pool,{...i,observations:[observation(pool[0],{permitted:false}),observation(pool[1])]});assert.equal(denied.digest,pool[1].digest);
});
test('ambiguous candidates without admitted standard block and list at most three',()=>{
  const pool=Array.from({length:6},(_,n)=>profile(String(n),{evidence:{kind:'teacher_prediction',ref:'prediction'}}));
  const i=input(pool,{observations:pool.map((p,n)=>observation(p,{permitted:n!==0}))});
  const r=selectRoute(pool,i);assert.equal(r.kind,'blocked');assert.equal(r.candidates.length,3);
});
test('profile tampering, duplicates, invalid amounts and NaN are rejected',()=>{
  const p=profile('a');assert.throws(()=>selectRoute([{...p,configuration:{...p.configuration,model:'other'}}],input([p])),/SEAL/);
  assert.throws(()=>selectRoute([p,p],input([p])),/POOL/);
  assert.throws(()=>selectRoute([p],input([p],{availableYen:'-1'})),/yen/);
  assert.throws(()=>selectRoute([p],input([p],{now:NaN})),/INPUT/);
  assert.throws(()=>selectRoute([p],input([p],{observations:[observation(p,{expectedTotalYen:'101'})]})),/ESTIMATE/);
});
test('USD routing compares nanos exactly and rejects mixed or double-labelled prices',()=>{
 const pool=[profile('a'),profile('b')],i=input(pool,{available:parseMoney('USD','1.000000001')});delete i.availableYen;
 i.observations=pool.map((p,n)=>{const o=observation(p,{maximum:parseMoney('USD','1.000000001'),expectedTotal:parseMoney('USD',n?'0.000000001':'0.000000002')});delete o.maximumYen;delete o.expectedTotalYen;return o;});
 assert.equal(selectRoute(pool,i).digest,pool[1].digest);
 assert.equal(selectRoute(pool,{...i,available:parseMoney('USD','1')}).kind,'blocked');
 for(const patch of [{maximum:parseMoney('JPY','1')},{maximumYen:'1'},{expectedTotal:undefined},{expectedTotalYen:'1'}])assert.throws(()=>selectRoute(pool,{...i,observations:[{...i.observations[0],...patch},i.observations[1]]}),/CURRENCY/);
 assert.throws(()=>selectRoute(pool,{...i,availableYen:'1'}),/CURRENCY/);
});
