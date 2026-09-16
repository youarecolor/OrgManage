import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,randomUUID,LedgerStore} from './fixtures/helpers.mjs';
import {ApiTrialBudget,usdUnits} from '../../dist/core/src/api-trial-budget.js';
import {makeUsdBudgetPolicy} from '../../dist/core/src/usd-budget.js';
import {parseMoney} from '../../dist/core/src/money.js';
async function setup(t){
 const f=await fixture(t),budget=new ApiTrialBudget(f.store,()=>f.now.getTime()),evidence=randomUUID();
 f.store.transaction(tx=>tx.insertRecord({principalId:f.principal,id:evidence,kind:'evidence',revision:1n,data:'{"synthetic":true}'}));
 const ev=f.store.read(tx=>tx.getRecord(f.principal,evidence).versionId);budget.configure(f.principal,f.actor,'synthetic-account','10',ev);
 const create=(usd='4',yen='100')=>f.store.transaction(tx=>{
  const intent=randomUUID(),obligation=randomUUID();
  tx.insertRecord({principalId:f.principal,id:intent,kind:'intent',revision:1n,data:JSON.stringify({state:'prepared',route:'openrouter',accountRoute:'synthetic-account',obligationId:obligation})});
  tx.insertRecord({principalId:f.principal,id:obligation,kind:'cost_obligation',revision:1n,data:JSON.stringify({intentId:intent,month:'2026-09',purpose:'production',bookedYen:'0',heldYen:yen,settled:false})});
  const hold=budget.reserveInTransaction(tx,f.principal,f.actor,'synthetic-account',intent,obligation,usd);return {intent,obligation,hold};
 });
 const acquire=x=>f.store.transaction(tx=>{const row=tx.getRecord(f.principal,x.intent);tx.updateRecord({...row,revision:row.revision+1n,data:JSON.stringify({...JSON.parse(row.data),state:'send_intent'})},row.revision);budget.acquireInTransaction(tx,f.principal,f.actor,x.hold);});
 return {f,budget,ev,create,acquire};
}
test('USD parser preserves decimal amounts without floating point',()=>{
 assert.equal(usdUnits('0.000000001'),1n);assert.equal(usdUnits('10'),10000000000n);
 for(const v of ['1e-9','0.0000000001','-1','01','NaN',0.1])assert.throws(()=>usdUnits(v));
});
test('line-terminated USD limits are rejected without creating a trial configuration',async t=>{
 for(const [label,suffix] of [['LF','\n'],['CR','\r'],['CRLF','\r\n'],['line separator','\u2028'],['paragraph separator','\u2029']]){
  await t.test(label,async t=>{
   const x=await setup(t);
   assert.throws(()=>x.budget.configure(x.f.principal,x.f.actor,'format-check',`10${suffix}`,x.ev),/API_TRIAL_AMOUNT/);
   // The rejected input must leave the account available for a valid setup.
   assert.doesNotThrow(()=>x.budget.configure(x.f.principal,x.f.actor,'format-check','10',x.ev));
  });
 }
});

test('trial and common JPY limits both constrain the same transaction',async t=>{
 const x=await setup(t);x.create('6');
 const before=x.f.store.read(tx=>tx.listRecord(x.f.principal,'intent').length);
 assert.throws(()=>x.create('4.000000001'),/USD_CAPACITY/);
 assert.equal(x.f.store.read(tx=>tx.listRecord(x.f.principal,'intent').length),before);
 assert.throws(()=>x.create('1','901'),/JPY_CAPACITY/);x.create('4');
 assert.throws(()=>x.budget.configure(x.f.principal,x.f.actor,'synthetic-account','100',x.ev),/ALREADY_CONFIGURED/);
});

async function setupUsd(t){
 const x=await setup(t),{f}=x;let policyVersion;
 f.store.transaction(tx=>{const r=tx.getRecord(f.principal,tx.getMeta(`policy:${f.principal}`));tx.updateRecord({...r,revision:r.revision+1n,data:JSON.stringify({...JSON.parse(r.data),cash:{format:'usd_budget_policy_v1',...makeUsdBudgetPolicy('8','16','2')}})},r.revision);policyVersion=tx.getRecord(f.principal,r.id).versionId;});
 const create=amount=>f.store.transaction(tx=>{
  const intent=randomUUID(),obligation=randomUUID();
  tx.insertRecord({principalId:f.principal,id:intent,kind:'intent',revision:1n,data:JSON.stringify({state:'prepared',route:'openrouter',accountRoute:'synthetic-account',obligationId:obligation})});
  tx.insertRecord({principalId:f.principal,id:obligation,kind:'cost_obligation',revision:1n,data:JSON.stringify({format:'cash_obligation_v1',intentId:intent,month:'2026-09',purpose:'production',pool:'normal',policyVersion,reserved:parseMoney('USD',amount),held:parseMoney('USD',amount),booked:parseMoney('USD','0'),settled:false})});
  const hold=x.budget.reserveInTransaction(tx,f.principal,f.actor,'synthetic-account',intent,obligation,amount);return {intent,obligation,hold};
 });
 return {...x,create};
}
test('versioned common USD reservation needs no JPY amount and is checked again before wire',async t=>{
 const x=await setupUsd(t),{f,create}=x;
 let a;assert.doesNotThrow(()=>{a=create('6');});
 assert.throws(()=>create('2.000000001'),/COMMON_USD_CAPACITY/);
 assert.doesNotThrow(()=>x.acquire(a));
 f.store.transaction(tx=>x.budget.confirmAcquiredInTransaction(tx,f.principal,f.actor,a.hold));
 f.store.transaction(tx=>{const r=tx.getRecord(f.principal,tx.getMeta(`policy:${f.principal}`));tx.updateRecord({...r,revision:r.revision+1n,data:JSON.stringify({...JSON.parse(r.data),cash:{format:'usd_budget_policy_v1',...makeUsdBudgetPolicy('5','16','2')}})},r.revision);});
 assert.throws(()=>f.store.transaction(tx=>x.budget.confirmAcquiredInTransaction(tx,f.principal,f.actor,a.hold)),/COMMON_POLICY_CHANGED/);
 assert.equal(JSON.parse(f.store.read(tx=>tx.getRecord(f.principal,a.hold).data)).state,'acquired');
});

test('USD unsent release and exact settlement preserve common/trial equality without conversion',async t=>{
 const x=await setupUsd(t),{f}=x,a=x.create('6');
 const patch=(tx,id,value)=>{const r=tx.getRecord(f.principal,id);tx.updateRecord({...r,revision:r.revision+1n,data:JSON.stringify({...JSON.parse(r.data),...value})},r.revision);};
 assert.doesNotThrow(()=>f.store.transaction(tx=>{
  patch(tx,a.intent,{state:'discarded'});patch(tx,a.obligation,{settled:true,held:parseMoney('USD','0'),booked:parseMoney('USD','0')});
  x.budget.releaseUnsentInTransaction(tx,f.principal,f.actor,a.hold);
 }));
 const b=x.create('8');x.acquire(b);
 f.store.transaction(tx=>x.budget.observeInTransaction(tx,f.principal,b.hold,x.ev,null));
 const settle=(common,trial)=>f.store.transaction(tx=>{
  patch(tx,b.obligation,{settled:true,held:parseMoney('USD','0'),booked:parseMoney('USD',common)});
  return x.budget.observeInTransaction(tx,f.principal,b.hold,x.ev,trial);
 });
 assert.throws(()=>settle('1','2'),/COMMON_USD_NOT_SETTLED/);
 assert.equal(JSON.parse(f.store.read(tx=>tx.getRecord(f.principal,b.obligation).data)).held.units,'8000000000');
 assert.equal(settle('11','11'),'recorded');
 assert.equal(JSON.parse(f.store.read(tx=>tx.getRecord(f.principal,b.hold).data)).bookedUnits,'11000000000');
 assert.throws(()=>x.create('0.1'),/COMMON_USD_CAPACITY/);
 await f.store.close();f.store=await LedgerStore.open(f.path);x.budget=new ApiTrialBudget(f.store,()=>f.now.getTime());
 assert.equal(f.store.transaction(tx=>x.budget.observeInTransaction(tx,f.principal,b.hold,x.ev,'11')),'duplicate');
});
test('unknown keeps USD held, settlement requires common JPY settlement and records overage',async t=>{
 const x=await setup(t),a=x.create('6');x.acquire(a);
 x.f.store.transaction(tx=>x.budget.observeInTransaction(tx,x.f.principal,a.hold,x.ev,null));
 assert.throws(()=>x.create('5'),/USD_CAPACITY/);
 assert.throws(()=>x.f.store.transaction(tx=>x.budget.observeInTransaction(tx,x.f.principal,a.hold,x.ev,'11')),/JPY_NOT_SETTLED/);
 x.f.store.transaction(tx=>{
  const row=tx.getRecord(x.f.principal,a.obligation);tx.updateRecord({...row,revision:row.revision+1n,data:JSON.stringify({...JSON.parse(row.data),settled:true,heldYen:'0',bookedYen:'500'})},row.revision);
  x.budget.observeInTransaction(tx,x.f.principal,a.hold,x.ev,'11');
 });
 assert.equal(JSON.parse(x.f.store.read(tx=>tx.getRecord(x.f.principal,a.hold).data)).bookedUnits,'11000000000');
 assert.throws(()=>x.create('0.01'),/USD_CAPACITY/);
});
test('acquire refuses repeat or a changed month and rolls back send intent',async t=>{
 const x=await setup(t),a=x.create();x.f.now=new Date('2026-10-01T01:00:00Z');
 assert.throws(()=>x.acquire(a),/COMMON_HOLD/);
 assert.equal(JSON.parse(x.f.store.read(tx=>tx.getRecord(x.f.principal,a.intent).data)).state,'prepared');
 x.f.now=new Date('2026-09-12T01:00:00Z');x.acquire(a);assert.throws(()=>x.acquire(a),/HOLD_STATE/);
});

test('unsent release requires both common records, is idempotent, and cannot release acquired budget',async t=>{
 const x=await setup(t),a=x.create('10');
 assert.throws(()=>x.f.store.transaction(tx=>x.budget.releaseUnsentInTransaction(tx,x.f.principal,x.f.actor,a.hold)),/COMMON_NOT_UNSENT/);
 const discard=()=>x.f.store.transaction(tx=>{
  for(const [id,patch] of [[a.intent,{state:'discarded'}],[a.obligation,{heldYen:'0',bookedYen:'0',settled:true}]]){
   const row=tx.getRecord(x.f.principal,id);tx.updateRecord({...row,revision:row.revision+1n,data:JSON.stringify({...JSON.parse(row.data),...patch})},row.revision);
  }
  return x.budget.releaseUnsentInTransaction(tx,x.f.principal,x.f.actor,a.hold);
 });
 assert.equal(discard(),'recorded');assert.equal(discard(),'duplicate');const b=x.create('10');x.acquire(b);
 assert.throws(()=>x.f.store.transaction(tx=>x.budget.releaseUnsentInTransaction(tx,x.f.principal,x.f.actor,b.hold)),/SEND_MAY_HAVE_OCCURRED/);
});

test('reopened unknown reservation persists and duplicate settlement does not add a charge',async t=>{
 const x=await setup(t),a=x.create('10');x.acquire(a);
 x.f.store.transaction(tx=>x.budget.observeInTransaction(tx,x.f.principal,a.hold,x.ev,null));
 await x.f.store.close();x.f.store=await LedgerStore.open(x.f.path);x.budget=new ApiTrialBudget(x.f.store,()=>x.f.now.getTime());
 assert.equal(JSON.parse(x.f.store.read(tx=>tx.getRecord(x.f.principal,a.hold).data)).heldUnits,'10000000000');
 assert.throws(()=>x.f.store.transaction(tx=>x.budget.releaseUnsentInTransaction(tx,x.f.principal,x.f.actor,a.hold)),/SEND_MAY_HAVE_OCCURRED/);
 const settle=amount=>x.f.store.transaction(tx=>{
  const row=tx.getRecord(x.f.principal,a.obligation);tx.updateRecord({...row,revision:row.revision+1n,data:JSON.stringify({...JSON.parse(row.data),settled:true,heldYen:'0',bookedYen:'50'})},row.revision);
  return x.budget.observeInTransaction(tx,x.f.principal,a.hold,x.ev,amount);
 });
 assert.equal(settle('0.1'),'recorded');assert.equal(settle('0.10'),'duplicate');
 const before=x.f.store.read(tx=>tx.getRecord(x.f.principal,a.obligation));assert.throws(()=>settle('0.2'),/OBSERVATION_CONFLICT/);
 assert.deepEqual(x.f.store.read(tx=>tx.getRecord(x.f.principal,a.obligation)),before);
});
