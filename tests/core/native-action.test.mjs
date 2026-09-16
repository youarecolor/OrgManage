import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeGuards} from './fixtures/native-guards.mjs';
import {randomUUID,update,request,bytes,snap,committed,denied,LedgerStore,OrgManageCore} from './fixtures/helpers.mjs';
async function setup(t){
 const x=await nativeGuards(t),{f}=x,id=randomUUID();
 f.store.transaction(tx=>tx.insertRecord({principalId:f.principal,id,kind:'contract',revision:1n,data:JSON.stringify({mode:'codex_protocol_rehearsal',scopeId:x.mission.id,nativeActionApprovalRequired:true})}));
 const contractVersion=f.store.read(tx=>tx.getRecord(f.principal,id).versionId);update(f,x.mission.id,m=>({...m,contractRef:contractVersion}));x.request.contractVersion=contractVersion;
 x.guards.manifestId=x.disclosure.createManifest(f.principal,f.actor,x.mission.id,contractVersion,{provider:'codex',accountRoute:x.request.accountRoute,profileDigest:x.request.profileDigest},[{sourceId:x.source,grantId:x.grant}]);
 x.guards.quoteId=x.cash.recordQuote(f.principal,f.actor,x.mission.id,contractVersion,x.quote);x.guards.actions=f.core.nativeActions;
 const approval=r=>snap(f).approvals.find(a=>a.id===JSON.parse(r.attempt.binding).actionApprovalId);
 const decision=(r,choice='approve',overrides={})=>{const a=approval(r);return request('approval.decide',a.id,a.revision,{action_digest:a.actionDigest,explanation_revision:a.explanationRevision,choice,comment:'synthetic native only',...overrides});};
 const decide=(r,choice='approve',overrides={})=>f.core.command(f.session,bytes(decision(r,choice,overrides)));
 return {...x,approval,decision,decide};
}
test('ordinary Home snapshot and approval.decide authorize the exact guarded native Attempt',async t=>{
 const x=await setup(t),r=x.prepare(),a=x.approval(r);assert.equal(a.state,'pending');assert.equal(a.explanation.maximumYen,'200');assert.equal(a.explanation.account,'test-account');assert.ok(a.explanation.route.includes('test / low'));assert.ok(a.explanation.disclosure.endsWith(x.request.input));assert.equal(snap(x.f).missions[0].phase,'approval');assert.equal(snap(x.f).pendingCount,1);
 assert.throws(()=>x.send(r),/NOT_APPROVED/);committed(x.decide(r));assert.equal(x.send(r).kind,'synthetic');assert.equal(snap(x.f).missions[0].phase,'execution');assert.equal(x.approval(r).state,'approved');assert.equal(snap(x.f).outcomes.length,0);
});
test('same decision command is idempotent and does not imply a send',async t=>{
 const x=await setup(t),r=x.prepare(),command=x.decision(r),first=x.f.core.command(x.f.session,bytes(command));committed(first);assert.deepEqual(x.f.core.command(x.f.session,bytes(command)),first);assert.equal(x.state(r).native.state,'prepared');
});
for(const overrides of [{action_digest:'f'.repeat(64)},{explanation_revision:'2'}])test(`stale approval UI fails closed: ${JSON.stringify(overrides)}`,async t=>{
 const x=await setup(t),r=x.prepare(),before=x.state(r);denied(x.decide(r,'approve',overrides));assert.equal(x.approval(r).state,'pending');assert.equal(x.state(r).native.state,before.native.state);
});
test('denial uses the shared Home command and atomically releases only unsent holds',async t=>{
 const x=await setup(t),r=x.prepare();committed(x.decide(r,'deny'));const state=x.state(r);assert.equal(x.approval(r).state,'denied');assert.equal(state.native.state,'discarded');assert.equal(JSON.parse(state.cash.data).heldYen,'0');assert.equal(JSON.parse(state.quota.data).state,'unconsumed');assert.equal(snap(x.f).missions[0].phase,'intake');assert.throws(()=>x.send(r));
});
test('expired native approval maintenance does not require a fake intent and releases unsent reservation',async t=>{
 const x=await setup(t),r=x.prepare();x.f.now=new Date(x.f.now.getTime()+60001);x.f.core.maintain();assert.equal(x.approval(r).state,'expired');assert.equal(x.state(r).native.state,'discarded');assert.equal(JSON.parse(x.state(r).cash.data).heldYen,'0');assert.equal(JSON.parse(x.state(r).quota.data).state,'unconsumed');x.f.core.maintain();assert.equal(x.approval(r).state,'expired');
});
test('policy version changes reject approval and invalidate it in ordinary maintenance',async t=>{
 const x=await setup(t),r=x.prepare();const id=x.f.store.read(tx=>tx.getMeta(`policy:${x.f.principal}`));update(x.f,id,v=>({...v,normalLimitYen:'900'}));denied(x.decide(r));x.f.core.maintain();assert.equal(x.approval(r).state,'superseded');assert.equal(JSON.parse(x.state(r).cash.data).heldYen,'0');
});
test('approved action cannot bypass all guard methods or be sent twice',async t=>{
 const x=await setup(t),r=x.prepare();committed(x.decide(r));const c=x.f.core.codex,p=x.f.principal;
 assert.throws(()=>c.acquireStart(p,r.attempt.id));assert.throws(()=>c.acquireStartWithResource(p,r.attempt.id,x.resource,r.holdId));assert.throws(()=>c.acquireStartWithDisclosure(p,r.attempt.id,x.resource,r.holdId,x.disclosure));
 const {actions,...guards}=x.guards;assert.throws(()=>c.acquireStartWithGuards(p,r.attempt.id,{...guards,holdId:r.holdId,cashHoldId:r.cashHoldId}));
 x.send(r);assert.throws(()=>x.send(r));
});
test('ActionApproval-required Contract and Mission refuse old unguarded preparation',async t=>{
 const x=await setup(t);assert.throws(()=>x.f.core.codex.prepare(x.request));assert.throws(()=>x.f.core.codex.prepare({...x.request,contractVersion:x.contractVersion}));
 const {actions,...guards}=x.guards;assert.throws(()=>x.f.core.codex.prepareWithGuards(x.request,guards));assert.equal(x.f.store.read(tx=>tx.native.listAttempts(x.f.principal)).length,0);
});
test('immutable approval explanation and exact hold version cannot be silently rewritten',async t=>{
 const x=await setup(t),r=x.prepare(),id=x.approval(r).id;update(x.f,id,v=>({...v,explanation:{...v.explanation,maximumYen:'0'}}));denied(x.decide(r));assert.throws(()=>x.send(r),/WITNESS_CHANGED/);
});
test('foreign hold or changed reserved amounts cannot use a prior approval',async t=>{
 const x=await setup(t),r=x.prepare();committed(x.decide(r));update(x.f,r.cashHoldId,v=>({...v,reservedYen:'201',heldYen:'201'}));const before=x.state(r);assert.throws(()=>x.send(r),/HOLD_CHANGED/);assert.deepEqual(x.state(r),before);
});
test('changed source grant after approval still rolls back native state and reservations',async t=>{
 const x=await setup(t),r=x.prepare();committed(x.decide(r));x.disclosure.revokeGrant(x.f.principal,x.f.actor,x.grant);const before=x.state(r);assert.throws(()=>x.send(r),/GRANT_MISMATCH/);assert.deepEqual(x.state(r),before);assert.equal(x.approval(r).state,'approved');
});
test('viewer session cannot decide, and revoking a second owner invalidates its earlier decision',async t=>{
 const x=await setup(t),r=x.prepare(),actor=randomUUID();x.f.store.transaction(tx=>tx.putMembership({principalId:x.f.principal,actorId:actor,role:'viewer',generation:1n}));const viewer=x.f.core.openSession(actor);denied(x.f.core.command(viewer,bytes(x.decision(r))));
 x.f.store.transaction(tx=>tx.putMembership({principalId:x.f.principal,actorId:actor,role:'owner',generation:2n}));const owner=x.f.core.openSession(actor);committed(x.f.core.command(owner,bytes(x.decision(r))));
 x.f.store.transaction(tx=>tx.putMembership({principalId:x.f.principal,actorId:actor,role:'revoked',generation:3n}));assert.throws(()=>x.send(r),/DECIDER_CHANGED/);
});
test('unknown send and expired approval never locally release its held money or quota',async t=>{
 const x=await setup(t),r=x.prepare();committed(x.decide(r));x.send(r);x.f.core.codex.transportLost(x.f.principal,r.attempt.id);x.f.now=new Date(x.f.now.getTime()+60001);x.f.core.maintain();assert.equal(x.state(r).native.state,'unknown');assert.equal(JSON.parse(x.state(r).cash.data).heldYen,'200');assert.equal(JSON.parse(x.state(r).quota.data).state,'send_acquired');assert.equal(x.approval(r).state,'approved');assert.throws(()=>x.send(r));
});
test('SQLite owner restart preserves historical decision but invalidates unsent work',async t=>{
 const x=await setup(t),r=x.prepare();committed(x.decide(r));await x.f.store.close();x.f.store=await LedgerStore.open(x.f.path);x.f.core=new OrgManageCore(x.f.store,x.f.options);x.f.session=x.f.core.openSession(x.f.actor);x.f.core.maintain();
 assert.equal(x.approval(r).state,'superseded');assert.equal(x.state(r).native.state,'discarded');assert.equal(JSON.parse(x.state(r).cash.data).heldYen,'0');
});
