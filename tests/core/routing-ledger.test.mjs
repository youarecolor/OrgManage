import test from 'node:test';
import assert from 'node:assert/strict';
import {RoutingCoordinator,routingViews} from '../../dist/core/src/routing-ledger.js';
import {sealConfiguration} from '../../dist/core/src/routing.js';
import {fixture,post,randomUUID,LedgerStore,snap,control,bytes,committed} from './fixtures/helpers.mjs';

async function setup(t){
  const f=await fixture(t),{mission}=post(f),now=f.now.getTime();
  const c={id:'fixture',version:'1',persona:'developer',model:'fixture',effort:'low',promptVersion:'1',contextPolicyVersion:'1',tools:[],runtime:'standard',billingRoute:'synthetic',capabilities:['text'],contextCapacity:4000,quality:90,expiresAt:now+10000,evidence:{kind:'observed_selected_only',ref:'synthetic-run'}};
  const seal=sealConfiguration(c),evidenceId=randomUUID();
  f.store.transaction(tx=>tx.insertRecord({principalId:f.principal,id:evidenceId,kind:'evidence',revision:1n,data:JSON.stringify({format:'synthetic_route_observation'})}));
  const [policyVersion,evidenceRef]=f.store.read(tx=>[tx.getRecord(f.principal,tx.getMeta(`policy:${f.principal}`)).versionId,tx.getRecord(f.principal,evidenceId).versionId]);
  const input={policyVersion,minimumQuality:80,contextSize:10,requiredCapabilities:['text'],availableYen:'0',nativeEnabled:false,standardDigest:seal.digest,current:null,reselect:false,observations:[{digest:seal.digest,observedAt:now,expiresAt:now+5000,permitted:true,qualified:true,disclosureAllowed:true,quota:'available',verifiedNoExtraCharge:false,maximumYen:'0',expectedTotalYen:'0',expectedCompletionMs:1,includesRework:true,evidenceRef}]};
  return {f,mission,c,input,router:new RoutingCoordinator(f.store,[c],()=>f.now.getTime())};
}
test('same Mission stores source-bound proposal and survives database reopen without dispatch',async t=>{
  const {f,mission,c,input,router}=await setup(t),before=snap(f);
  const r=router.propose(f.principal,f.actor,mission.id,input);assert.equal(r.decision.kind,'select');
  const saved=f.store.read(tx=>JSON.parse(tx.getRecord(f.principal,r.id).data));
  assert.equal(saved.request.originalText,'原文を失わない合成依頼');assert.equal(saved.request.policyVersion,input.policyVersion);
  assert.deepEqual(snap(f).intents,before.intents);assert.deepEqual(snap(f).budget,before.budget);
  await f.store.close();f.store=await LedgerStore.open(f.path);
  assert.deepEqual(new RoutingCoordinator(f.store,[c]).list(f.principal,f.actor),[r]);
});
test('foreign actor and missing observation evidence cannot add proposal',async t=>{
  const {f,mission,input,router}=await setup(t);
  assert.throws(()=>router.propose(f.principal,randomUUID(),mission.id,input),/ACTOR/);
  assert.throws(()=>router.propose(f.principal,f.actor,mission.id,{...input,observations:[{...input.observations[0],evidenceRef:randomUUID()}]}),/EVIDENCE/);
  assert.equal(router.list(f.principal,f.actor).length,0);
});

test('recorded selection revalidates in the caller transaction and expires without replacing its evidence',async t=>{
 const {f,mission,c,input,router}=await setup(t),receipt=router.propose(f.principal,f.actor,mission.id,input);
 const confirm=()=>f.store.transaction(tx=>router.confirmInTransaction(tx,f.principal,f.actor,receipt.id,mission.id,receipt.contractVersion));
 assert.equal(confirm().configuration.model,c.model);
 const changed=new RoutingCoordinator(f.store,[{...c,effort:'high'}],()=>f.now.getTime());
 assert.throws(()=>f.store.transaction(tx=>changed.confirmInTransaction(tx,f.principal,f.actor,receipt.id,mission.id,receipt.contractVersion)),/PROFILES_CHANGED/);
 f.now=new Date(f.now.getTime()+6000);assert.throws(confirm,/SELECTION_EXPIRED/);
 assert.equal(router.list(f.principal,f.actor).length,1);
});
test('pending revised contract and stopped scope cannot create stale routing',async t=>{
  const {f,mission,input,router}=await setup(t);
  post(f,'要求を変更','continue');assert.throws(()=>router.propose(f.principal,f.actor,mission.id,input),/PENDING/);
  const app=snap(f).application;committed(f.core.command(f.session,bytes(control(f,app,'halt_dispatch'))));
  assert.throws(()=>router.propose(f.principal,f.actor,mission.id,input),/STOPPED/);
});

test('pool receipt survives reopen and expires when a non-winning member expires',async t=>{
 const {f,mission,c,input}=await setup(t),second={...c,id:'second',model:'second'},digest=sealConfiguration(second).digest;
 const profiles=[c,second],request={...input,observations:[...input.observations,{...input.observations[0],digest,expiresAt:f.now.getTime()+2000}]};
 let router=new RoutingCoordinator(f.store,profiles,()=>f.now.getTime());
 const proposal=router.propose(f.principal,f.actor,mission.id,request),pool=router.recordPool(f.principal,f.actor,proposal.id);
 const confirm=()=>f.store.transaction(tx=>router.confirmPoolInTransaction(tx,f.principal,f.actor,pool.id,mission.id,pool.contractVersion));
 assert.equal(confirm().configurations.length,2);const poolVersion=confirm().poolVersion;
 const views=f.store.read(tx=>routingViews(tx,f.principal));assert.equal(views.length,1);assert.equal(views[0].kind,'pool');assert.equal(views[0].model,null);assert.deepEqual(views[0].candidateModels,[c.model,second.model]);
 await f.store.close();f.store=await LedgerStore.open(f.path);router=new RoutingCoordinator(f.store,profiles,()=>f.now.getTime());
 assert.equal(confirm().poolVersion,poolVersion);
 assert.throws(()=>f.store.transaction(tx=>router.confirmPoolInTransaction(tx,f.principal,randomUUID(),pool.id,mission.id,pool.contractVersion)),/BINDING/);
 f.now=new Date(f.now.getTime()+2500);
 // The old single-model selection still qualifies; the full Auto pool does not.
 f.store.transaction(tx=>router.confirmInTransaction(tx,f.principal,f.actor,proposal.id,mission.id,pool.contractVersion));
 assert.throws(confirm,/POOL_EXPIRED/);
});

test('pool rejects widening and pending contracts; observation evidence is immutable',async t=>{
 const {f,mission,c,input,router}=await setup(t),proposal=router.propose(f.principal,f.actor,mission.id,input),pool=router.recordPool(f.principal,f.actor,proposal.id);
 const widened=new RoutingCoordinator(f.store,[c,{...c,id:'extra',model:'extra'}],()=>f.now.getTime());
 assert.throws(()=>f.store.transaction(tx=>widened.confirmPoolInTransaction(tx,f.principal,f.actor,pool.id,mission.id,pool.contractVersion)),/PROFILES_CHANGED/);
 assert.throws(()=>f.store.transaction(tx=>{const row=tx.getRecordVersion(f.principal,input.observations[0].evidenceRef);tx.updateRecord({...row,revision:row.revision+1n,data:JSON.stringify({format:'replacement'})},row.revision);}),/Immutable record/);
 f.store.transaction(tx=>router.confirmPoolInTransaction(tx,f.principal,f.actor,pool.id,mission.id,pool.contractVersion));
 post(f,'要求を変更','continue');
 assert.throws(()=>f.store.transaction(tx=>router.confirmPoolInTransaction(tx,f.principal,f.actor,pool.id,mission.id,pool.contractVersion)),/CONTRACT_CHANGED/);
});
