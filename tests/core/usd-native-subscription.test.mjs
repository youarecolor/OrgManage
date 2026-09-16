import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeSubscription} from './fixtures/native-subscription.mjs';
import {nativeGuards} from './fixtures/native-guards.mjs';
import {request,bytes,committed,denied,snap,update} from './fixtures/helpers.mjs';

function configureUsd(f,limits={normal_limit:'8',reserve_limit:'16',autonomous_e_limit:'2'}){
 const policy=snap(f).budgetPolicy;
 committed(f.core.command(f.session,bytes(request('budget.configure',policy.id,policy.revision,{currency:'USD',...limits}))));
}

test('USD policy presents a no-extra-charge subscription as USD zero and acquires no cash debt',async t=>{
 const x=await nativeSubscription(t);configureUsd(x.f);
 const prepared=x.prepare(),approval=x.approval(prepared);
 assert.deepEqual(approval.explanation.maximum,{format:'money_v1',currency:'USD',units:'0'});
 assert.equal(approval.explanation.maximumYen,undefined);
 assert.match(approval.explanation.risk,/購読残枠は不明/);
 assert.equal(x.entitlementValue.cashMode,'none');
 assert.equal(x.entitlementValue.paidCreditsAvailable,false);
 assert.equal(x.entitlementValue.apiFallbackEnabled,false);
 assert.equal(x.f.store.read(tx=>tx.listRecord(x.f.principal,'cost_obligation')).length,0);

 committed(x.decide(prepared));
 assert.equal(x.send(prepared).kind,'synthetic');
 const hold=JSON.parse(x.state(prepared).hold.data);
 assert.equal(hold.format,'native_subscription_hold_v1');
 assert.equal(hold.state,'send_acquired');
 assert.equal(hold.cashMode,'none');
 assert.equal(hold.remaining,'unknown');
 assert.equal(x.f.store.read(tx=>tx.listRecord(x.f.principal,'cost_obligation')).length,0);
});

test('subscription approval is still bound to the exact USD policy version',async t=>{
 const x=await nativeSubscription(t);configureUsd(x.f);
 const prepared=x.prepare(),before=x.state(prepared);
 configureUsd(x.f,{normal_limit:'9',reserve_limit:'18',autonomous_e_limit:'2'});
 denied(x.decide(prepared));
 assert.equal(x.approval(prepared).state,'pending');
 const after=x.state(prepared);
 for(const key of ['attempt','hold','approval','mission'])assert.deepEqual(after[key],before[key],key);
});

test('JPY policy keeps the legacy zero-yen subscription explanation',async t=>{
 const x=await nativeSubscription(t),approval=x.approval(x.prepare());
 assert.equal(approval.explanation.maximumYen,'0');
 assert.equal(approval.explanation.maximum,undefined);
});

test('legacy native cash quote, reserve and acquire cannot proceed under a USD policy',async t=>{
 const quoted=await nativeGuards(t);configureUsd(quoted.f);
 assert.throws(()=>quoted.cash.recordQuote(quoted.f.principal,quoted.f.actor,quoted.mission.id,quoted.contractVersion,quoted.quote),/NATIVE_CASH_POLICY_CURRENCY/);
 const before=quoted.f.store.read(tx=>tx.listRecord(quoted.f.principal));
 assert.throws(quoted.prepare,/NATIVE_CASH_POLICY_CURRENCY/);
 assert.deepEqual(quoted.f.store.read(tx=>tx.listRecord(quoted.f.principal)),before);

 const acquired=await nativeGuards(t),prepared=acquired.prepare();
 const policyId=acquired.f.store.read(tx=>tx.getMeta(`policy:${acquired.f.principal}`));
 update(acquired.f,policyId,value=>({...value,cash:{format:'usd_budget_policy_v1',normal:{format:'money_v1',currency:'USD',units:'8000000000'},reserve:{format:'money_v1',currency:'USD',units:'16000000000'},autonomousE:{format:'money_v1',currency:'USD',units:'2000000000'}}}));
 const acquiredBefore=acquired.state(prepared);
 assert.throws(()=>acquired.send(prepared),/NATIVE_CASH_POLICY_CURRENCY/);
 assert.deepEqual(acquired.state(prepared),acquiredBefore);
});
