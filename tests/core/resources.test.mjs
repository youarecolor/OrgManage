import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, post, randomUUID, addPrincipal, LedgerStore } from './fixtures/helpers.mjs';
import { ResourceCoordinator } from '../../dist/core/src/resources.js';

async function setup(t){
  const f=await fixture(t),mission=post(f).mission;
  const start=f.now.getTime()-1000,end=start+600000;
  const pool={kind:'quota',provider:'test',account:'shared-account',pool:'common',unit:'units',freshnessMs:300000,
    windows:[{id:'short',revision:'1',startsAt:start,resetsAt:end},{id:'week',revision:'1',startsAt:start,resetsAt:end+600000}]};
  const service=new ResourceCoordinator(f.store,pool,()=>f.now.getTime());
  const evidence=(p=f.principal)=>{const id=randomUUID();f.store.transaction(tx=>tx.insertRecord({principalId:p,id,kind:'evidence',revision:1n,data:'{"source":"synthetic-only"}'}));return id;};
  const effect=(p=f.principal,scope=mission.id)=>{const id=randomUUID();f.store.transaction(tx=>tx.insertRecord({principalId:p,id,kind:'attempt',revision:1n,data:JSON.stringify({scopeId:scope})}));return id;};
  const observation=(remaining='10',reflected=[],s=service)=>s.pool.windows.map(w=>({windowId:w.id,revision:w.revision,remaining,observedAt:f.now.getTime(),evidenceId:evidence(),reflectedHoldIds:reflected}));
  const observe=(remaining='10',reflected=[],s=service)=>s.observe(f.principal,f.actor,observation(remaining,reflected,s));
  const reserve=(n='1',id=effect(),p=f.principal,scope=mission.id,s=service)=>s.reserve(p,f.actor,scope,'attempt',id,{short:n,week:n});
  return {f,mission,pool,service,evidence,effect,observation,observe,reserve};
}
test('quota reservations are durable, exclusive per effect and atomically account for all windows',async t=>{
  const x=await setup(t),{f,service}=x;x.observe();const e=x.effect(),id=x.reserve('6',e);
  assert.throws(()=>x.reserve('1',e),/ALREADY_RESERVED/);assert.throws(()=>x.reserve('5'),/CAPACITY_EXCEEDED/);
  service.acquireSend(f.principal,f.actor,id);assert.throws(()=>service.acquireSend(f.principal,f.actor,id),/SEND_ALREADY/);
  const row=f.store.read(tx=>tx.getRecord(f.principal,id));assert.equal(JSON.parse(row.data).sendSnapshot.id,JSON.parse(row.data).reservationSnapshot.id);
  await f.store.close();f.store=await LedgerStore.open(f.path);
  const restored=new ResourceCoordinator(f.store,x.pool,()=>f.now.getTime());
  assert.throws(()=>restored.acquireSend(f.principal,f.actor,id),/SEND_ALREADY/);
  assert.throws(()=>restored.reserve(f.principal,f.actor,x.mission.id,'attempt',x.effect(),{short:'5',week:'5'}),/CAPACITY_EXCEEDED/);
});
test('a scarce secondary window cannot be offset by plentiful primary capacity',async t=>{
  const x=await setup(t),o=x.observation('100');o.find(w=>w.windowId==='week').remaining='1';x.service.observe(x.f.principal,x.f.actor,o);
  assert.throws(()=>x.reserve('2'),/CAPACITY_EXCEEDED/);assert.equal(x.f.store.read(tx=>tx.listRecord(x.f.principal,'resource_hold')).length,0);
});
test('reflected consumed use is not deducted twice; unreflected consumption still counts',async t=>{
  const x=await setup(t);x.observe();const id=x.reserve('4');x.service.acquireSend(x.f.principal,x.f.actor,id);
  assert.throws(()=>x.service.settle(x.f.principal,id,'consumed',x.evidence()),/ACTUAL_USAGE_REQUIRED/);
  x.service.settle(x.f.principal,id,'consumed',x.evidence(),{short:'4',week:'4'});
  x.f.now=new Date(x.f.now.getTime()+1);x.observe('6');assert.throws(()=>x.reserve('3'),/CAPACITY_EXCEEDED/);
  x.f.now=new Date(x.f.now.getTime()+1);x.observe('6',[id]);assert.ok(x.reserve('6'));
});
test('actual usage over reservation is retained and blocks overbooking',async t=>{
  const x=await setup(t);x.observe();const id=x.reserve('1');x.service.acquireSend(x.f.principal,x.f.actor,id);
  x.service.settle(x.f.principal,id,'consumed',x.evidence(),{short:'11',week:'11'});assert.throws(()=>x.reserve(),/CAPACITY_EXCEEDED/);
});
test('unknown remains held and cannot be marked reflected or erased by reset',async t=>{
  const x=await setup(t);x.observe();const id=x.reserve('8');x.service.acquireSend(x.f.principal,x.f.actor,id);x.service.settle(x.f.principal,id,'unknown',x.evidence());
  x.f.now=new Date(x.f.now.getTime()+1);assert.throws(()=>x.observe('10',[id]),/UNPROVEN_RESOURCE_COVERAGE/);
  assert.throws(()=>x.reserve('3'),/CAPACITY_EXCEEDED/);
  x.f.now=new Date(x.pool.windows[1].resetsAt+1);
  const next=new ResourceCoordinator(x.f.store,{...x.pool,windows:x.pool.windows.map(w=>({...w,revision:'2',startsAt:x.f.now.getTime()-1,resetsAt:x.f.now.getTime()+600000}))},()=>x.f.now.getTime());
  x.observe('100',[],next);assert.throws(()=>x.reserve('1',x.effect(),x.f.principal,x.mission.id,next),/PRIOR_WINDOW_UNRESOLVED/);
  next.settle(x.f.principal,id,'unconsumed',x.evidence());assert.ok(x.reserve('1',x.effect(),x.f.principal,x.mission.id,next));
});
for(const kind of ['missing','unknown','stale','future','missing-window'])test(`quota denies ${kind} observation`,async t=>{
  const x=await setup(t);
  if(kind==='unknown')x.observe(null);
  if(kind==='stale'){x.observe();x.f.now=new Date(x.f.now.getTime()+300000);}
  if(kind==='future'){const o=x.observation();o[0].observedAt++;assert.throws(()=>x.service.observe(x.f.principal,x.f.actor,o));return;}
  if(kind==='missing-window'){assert.throws(()=>x.service.observe(x.f.principal,x.f.actor,x.observation().slice(0,1)),/ALL_RESOURCE_WINDOWS/);return;}
  assert.throws(()=>x.reserve(),/RESOURCE_(OBSERVATION_MISSING|STALE_OR_UNKNOWN)/);
});
test('two Principals sharing a provider pool cannot each reserve the whole balance',async t=>{
  const x=await setup(t);x.observe();x.reserve('7');const other=addPrincipal(x.f);
  assert.throws(()=>x.reserve('4',x.effect(other.principal,other.principal),other.principal,other.principal),/CAPACITY_EXCEEDED/);
  assert.ok(x.reserve('3',x.effect(other.principal,other.principal),other.principal,other.principal));
});
test('send checks refreshed external usage, source scope and membership generation',async t=>{
  const x=await setup(t);x.observe();const id=x.reserve('7');x.f.now=new Date(x.f.now.getTime()+1);x.observe('6');
  assert.throws(()=>x.service.acquireSend(x.f.principal,x.f.actor,id),/CAPACITY_EXCEEDED/);
  x.f.now=new Date(x.f.now.getTime()+1);x.observe('10');
  x.f.store.transaction(tx=>tx.putMembership({principalId:x.f.principal,actorId:x.f.actor,role:'owner',generation:2n}));
  assert.throws(()=>x.service.acquireSend(x.f.principal,x.f.actor,id),/AUTHORITY_CHANGED/);
  assert.throws(()=>x.reserve('1',x.effect(),x.f.principal,x.f.principal),/EFFECT_SCOPE_MISMATCH/);
});
test('amounts preserve large integer bounds and reject trailing newline or invented ticket quota',async t=>{
  const x=await setup(t);x.observe('999999999999999999');assert.ok(x.reserve('999999999999999998'));
  assert.throws(()=>x.reserve('2'),/CAPACITY_EXCEEDED/);assert.throws(()=>x.reserve('1\n'),/INVALID_RESOURCE_AMOUNT/);
  assert.throws(()=>new ResourceCoordinator(x.f.store,{...x.pool,kind:'ticket'}),/TICKET_APPROVAL_PATH_REQUIRED/);
});
test('only a reservation with no acquired send can be locally cancelled and released',async t=>{
  const x=await setup(t);x.observe();const first=x.reserve('10');x.service.cancelReserved(x.f.principal,x.f.actor,first);
  const row=x.f.store.read(tx=>tx.getRecord(x.f.principal,first)),hold=JSON.parse(row.data);
  assert.equal(hold.state,'unconsumed');assert.equal(x.f.store.read(tx=>tx.getRecord(x.f.principal,hold.evidenceId)).kind,'evidence');
  const next=x.reserve('10');x.service.acquireSend(x.f.principal,x.f.actor,next);
  assert.throws(()=>x.service.cancelReserved(x.f.principal,x.f.actor,next),/SEND_MAY_HAVE_OCCURRED/);
  assert.throws(()=>x.reserve(),/CAPACITY_EXCEEDED/);
});
