import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeGuards} from './fixtures/native-guards.mjs';
import {randomUUID,post,start,update,LedgerStore} from './fixtures/helpers.mjs';
import {NativeCashCoordinator} from '../../dist/core/src/native-cash.js';
import {aggregate} from '../../dist/core/src/budget.js';
const value=r=>JSON.parse(r.data);
test('all three guards commit with native state and share the Principal monthly budget',async t=>{
 const x=await nativeGuards(t),r=x.prepare();assert.equal(value(x.state(r).cash).heldYen,'200');assert.equal(x.send(r).kind,'synthetic');const s=x.state(r);assert.equal(s.native.state,'send_intent');assert.equal(value(s.quota).state,'send_acquired');assert.equal(value(s.cash).state,'send_acquired');assert.equal(x.f.store.read(tx=>tx.listRecord(x.f.principal,'budget_month')).length,1);
});
for(const change of [{maximumYen:null},{currency:'USD'},{taxIncluded:null},{taxIncluded:false}])test(`unknown price/tax/currency rolls back all preparation: ${JSON.stringify(change)}`,async t=>{
 const x=await nativeGuards(t,change);assert.throws(x.prepare,/PRICE_UNKNOWN/);
 for(const kind of ['run','attempt','resource_hold','cost_obligation','budget_month'])assert.equal(x.f.store.read(tx=>tx.listRecord(x.f.principal,kind)).length,0,kind);
});
test('explicit zero quote remains distinct from an unknown price',async t=>{
 const x=await nativeGuards(t,{maximumYen:'0'}),r=x.prepare();x.send(r);assert.equal(value(x.state(r).cash).reservedYen,'0');assert.equal(value(x.state(r).cash).settled,false);
});
test('existing common Core reservations are counted instead of granting a second native allowance',async t=>{
 const x=await nativeGuards(t,{maximumYen:'400'});start(x.f,post(x.f,'other local fixture').mission);assert.throws(x.prepare,/NATIVE_CASH_CAPACITY/);assert.equal(x.f.store.read(tx=>tx.native.listAttempts(x.f.principal)).length,0);assert.equal(x.f.store.read(tx=>tx.listRecord(x.f.principal,'cost_obligation')).length,1);
});
for(const cause of ['expired-quote','policy-changed','month-changed'])test(`${cause} before send rolls back native/quota together`,async t=>{
 const x=await nativeGuards(t,{},cause==='month-changed'?'2026-09-30T14:59:59.990Z':undefined),r=x.prepare();
 if(cause==='expired-quote')x.f.now=new Date(x.f.now.getTime()+30001);
 if(cause==='policy-changed'){const id=x.f.store.read(tx=>tx.getMeta(`policy:${x.f.principal}`));update(x.f,id,p=>({...p,normalLimitYen:'100'}));}
 if(cause==='month-changed')x.f.now=new Date(x.f.now.getTime()+20);
 const before=x.state(r);assert.throws(()=>x.send(r),cause==='expired-quote'?/QUOTE_EXPIRED/:/POLICY_OR_MONTH_CHANGED/);assert.deepEqual(x.state(r),before);
});
test('cash-bound attempt cannot bypass monetary validation through earlier entrypoints',async t=>{
 const x=await nativeGuards(t),r=x.prepare(),before=x.state(r);
 assert.throws(()=>x.f.core.codex.acquireStart(x.f.principal,r.attempt.id));
 assert.throws(()=>x.f.core.codex.acquireStartWithResource(x.f.principal,r.attempt.id,x.resource,r.holdId));
 assert.throws(()=>x.f.core.codex.acquireStartWithDisclosure(x.f.principal,r.attempt.id,x.resource,r.holdId,x.disclosure));
 assert.deepEqual(x.state(r),before);
});
test('a different Attempt cash obligation rolls back already-checked native and quota state',async t=>{
 const x=await nativeGuards(t),r=x.prepare(),other=randomUUID();
 x.f.store.transaction(tx=>{const row=tx.getRecord(x.f.principal,r.cashHoldId);tx.insertRecord({principalId:x.f.principal,id:other,kind:'cost_obligation',revision:1n,data:JSON.stringify({...value(row),attemptId:randomUUID()})});});
 const before=x.state(r);assert.throws(()=>x.send({...r,cashHoldId:other}),/HOLD_BINDING/);assert.deepEqual(x.state(r),before);
});
for(const change of [{mode:'provider'},{accountRoute:'other'},{model:'other'},{effort:'high'},{inputDigest:'f'.repeat(64)}])test(`foreign quote binding cannot acquire money: ${JSON.stringify(change)}`,async t=>{
 const x=await nativeGuards(t,change);assert.throws(x.prepare,/QUOTE_MISMATCH/);assert.equal(x.f.store.read(tx=>tx.listRecord(x.f.principal,'cost_obligation')).length,0);
});
test('uncertain sends keep their whole cash hold after DB reopen and cannot be locally cancelled',async t=>{
 const x=await nativeGuards(t),r=x.prepare();x.send(r);x.cash.observe(x.f.principal,r.cashHoldId,'unknown',x.evidenceVersionId);assert.equal(value(x.state(r).cash).heldYen,'200');assert.throws(()=>x.cash.cancelUnsent(x.f.principal,x.f.actor,r.cashHoldId),/SEND_MAY_HAVE_OCCURRED/);
 await x.f.store.close();x.f.store=await LedgerStore.open(x.f.path);const cash=new NativeCashCoordinator(x.f.store,()=>x.f.now.getTime());assert.throws(()=>cash.cancelUnsent(x.f.principal,x.f.actor,r.cashHoldId),/SEND_MAY_HAVE_OCCURRED/);assert.equal(value(x.f.store.read(tx=>tx.getRecord(x.f.principal,r.cashHoldId))).state,'unknown');
});
test('actual overrun is recorded, shared totals expose it, and repeated same charge is idempotent',async t=>{
 const x=await nativeGuards(t),r=x.prepare();x.send(r);const charge={key:'charge-1',amountYen:'1100'};
 assert.equal(x.cash.observe(x.f.principal,r.cashHoldId,'settled',x.evidenceVersionId,charge),'recorded');const before=x.state(r).cash;
 assert.equal(x.cash.observe(x.f.principal,r.cashHoldId,'settled',x.evidenceVersionId,charge),'duplicate');assert.deepEqual(x.state(r).cash,before);
 const h=value(before);assert.equal(h.bookedYen,'1100');assert.equal(h.heldYen,'0');assert.equal(aggregate([h],h.month).booked,1100n);
 x.f.core.codex.observe(x.f.principal,r.attempt.id,Buffer.from(JSON.stringify({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn-1',status:'completed',items:[],error:null}}})));
 assert.equal(x.f.store.read(tx=>tx.native.getAttempt(x.f.principal,r.attempt.id)).state,'completed');
 assert.throws(x.prepare,/NATIVE_CASH_CAPACITY/);
 assert.throws(()=>x.cash.observe(x.f.principal,r.cashHoldId,'settled',x.evidenceVersionId,{key:'charge-1',amountYen:'100'}),/CHARGE_CONFLICT/);assert.equal(x.f.store.read(tx=>tx.listRecord(x.f.principal,'cost_event')).length,1);
});
test('an unsent discarded Attempt can release its hold, but prepared alone is insufficient',async t=>{
 const x=await nativeGuards(t),r=x.prepare();assert.throws(()=>x.cash.cancelUnsent(x.f.principal,x.f.actor,r.cashHoldId));x.f.core.codex.requestStop(x.f.principal,r.attempt.id);x.cash.cancelUnsent(x.f.principal,x.f.actor,r.cashHoldId);assert.equal(value(x.state(r).cash).heldYen,'0');assert.equal(value(x.state(r).cash).state,'unsent');
});
test('unknown monetary observation cannot carry an invented zero actual charge',async t=>{
 const x=await nativeGuards(t),r=x.prepare();x.send(r);const before=x.state(r).cash;assert.throws(()=>x.cash.observe(x.f.principal,r.cashHoldId,'unknown',x.evidenceVersionId,{key:'invented',amountYen:'0'}),/UNKNOWN_AMOUNT/);assert.deepEqual(x.state(r).cash,before);
});
