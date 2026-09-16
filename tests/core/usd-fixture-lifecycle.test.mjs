import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,request,bytes,committed,denied,control,saved,post,start,approve,snap,LedgerStore,OrgManageCore} from './fixtures/helpers.mjs';
import {parseMoney} from '../../dist/core/src/money.js';

async function setup(t){
 const f=await fixture(t,{fakeProfile:{reservationUsd:'6',settledUsd:'2.000000001'}});
 const p=snap(f).budgetPolicy;
 committed(f.core.command(f.session,bytes(request('budget.configure',p.id,p.revision,{currency:'USD',normal_limit:'8',reserve_limit:'16',autonomous_e_limit:'2'}))));
 return f;
}
test('normal command flow reserves, approves and settles USD without interpreting old yen fixture prices',async t=>{
 const f=await setup(t),a=approve(f,start(f,post(f).mission));
 assert.deepEqual(a.approval.explanation.maximum,{format:'money_v1',currency:'USD',units:'6000000000'});
 assert.equal(a.approval.explanation.maximumYen,undefined);
 assert.equal(snap(f).budget.cash.held,'6');
 const result=f.core.executeFake(f.principal,a.intent.id);assert.equal(result.ok,true,JSON.stringify(result));
 const o=saved(f,saved(f,a.intent.id).value.obligationId).value;
 assert.equal(o.format,'cash_obligation_v1');assert.equal(o.held.units,'0');assert.equal(o.booked.units,'2000000001');assert.equal(o.bookedYen,undefined);
 assert.equal(snap(f).budget.cash.booked,'2.000000001');assert.equal(snap(f).budget.cash.actualExternalCost,'0');
 assert.deepEqual(snap(f).intents.find(v=>v.id===a.intent.id).cash,{currency:'USD',held:'0',booked:'2.000000001'});
 await f.store.close();f.store=await LedgerStore.open(f.path);f.core=new OrgManageCore(f.store,f.options);f.session=f.core.openSession(f.actor);
 assert.equal(snap(f).budget.cash.booked,'2.000000001');
 assert.equal(f.core.finishFakeObservation(f.principal,a.intent.id).result.duplicate,true);
});
test('USD stop releases only unsent obligations; unknown after acquisition preserves debt across restart',async t=>{
 const f=await setup(t),a=start(f,post(f).mission);
 committed(f.core.command(f.session,bytes(control(f,snap(f).missions.find(m=>m.id===a.mission.id).scope,'pause'))));
 assert.equal(snap(f).budget.cash.held,'0');assert.equal(snap(f).intents.find(v=>v.id===a.intent.id).state,'discarded');
 const b=approve(f,start(f,post(f).mission));assert.equal(f.core.acquireDispatch(f.principal,b.intent.id).ok,true);
 denied(f.core.observeFakeCash(f.principal,b.intent.id,'unknown','unknown',parseMoney('USD','0')),'OUTCOME_UNKNOWN');
 committed(f.core.command(f.session,bytes(control(f,snap(f).missions.find(m=>m.id===b.mission.id).scope,'pause'))));
 assert.equal(snap(f).budget.cash.held,'6');assert.equal(snap(f).intents.find(v=>v.id===b.intent.id).cancellation,'requested');
 await f.store.close();f.store=await LedgerStore.open(f.path);f.core=new OrgManageCore(f.store,f.options);f.session=f.core.openSession(f.actor);
 assert.equal(snap(f).budget.cash.held,'6');assert.equal(snap(f).intents.find(v=>v.id===b.intent.id).state,'unknown');
});
test('USD accounting refuses yen observations and keeps overage and conflicting evidence without double booking',async t=>{
 const f=await setup(t),a=approve(f,start(f,post(f).mission));assert.equal(f.core.acquireDispatch(f.principal,a.intent.id).ok,true);
 denied(f.core.observeFake(f.principal,a.intent.id,'success','yen-wrong','2'));
 assert.equal(snap(f).budget.cash.held,'6');assert.equal(snap(f).budget.cash.booked,'0');
 assert.equal(f.core.observeFakeCash(f.principal,a.intent.id,'success','usd-charge',parseMoney('USD','9')).ok,true);
 assert.equal(snap(f).budget.cash.booked,'9');
 const m=post(f).mission;denied(f.core.command(f.session,bytes(request('mission.start',m.id,m.scope.revision,{brief_revision:m.briefRef,contract_revision:m.contractRef}))),'BUDGET_BLOCKED');
 denied(f.core.observeFakeCash(f.principal,a.intent.id,'success','usd-charge',parseMoney('USD','12')),'OUTCOME_UNKNOWN');
 assert.equal(snap(f).budget.cash.booked,'9');assert.equal(snap(f).budget.cash.held,'3');
 denied(f.core.observeFakeCash(f.principal,a.intent.id,'success','usd-charge',parseMoney('USD','12')),'OUTCOME_UNKNOWN');
 assert.equal(snap(f).budget.cash.held,'3');
});
