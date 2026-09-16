import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,request,bytes,committed,denied,saved,LedgerStore,OrgManageCore,post,start,randomUUID} from './fixtures/helpers.mjs';
const target=f=>f.store.read(tx=>tx.getRecord(f.principal,tx.getMeta(`policy:${f.principal}`)));
const configure=f=>{const p=target(f);return request('budget.configure',p.id,p.revision,{currency:'USD',normal_limit:'40',reserve_limit:'80',autonomous_e_limit:'10'});};
test('owner configures versioned USD monthly limits through the common command and reopens the same receipt',async t=>{
 const f=await fixture(t),before=target(f),cmd=configure(f);
 const receipt=committed(f.core.command(f.session,bytes(cmd)));
 const view=f.core.snapshot(f.session);assert.equal(view.status,'ready');
 assert.equal(view.budgetPolicy.currency,'USD');assert.equal(view.budgetPolicy.normalLimit,'40');assert.equal(view.budgetPolicy.reserveLimit,'80');assert.equal(view.budgetPolicy.autonomousELimit,'10');
 assert.deepEqual(view.budget.cash,{currency:'USD',booked:'0',held:'0',limit:'40',actualExternalCost:'0'});
 assert.equal(f.store.read(tx=>tx.getRecordVersion(f.principal,before.versionId).data),before.data);
 assert.deepEqual(f.core.command(f.session,bytes(cmd)).receipt,receipt);
 await f.store.close();f.store=await LedgerStore.open(f.path);f.core=new OrgManageCore(f.store,f.options);f.session=f.core.openSession(f.actor);
 assert.equal(f.core.snapshot(f.session).budgetPolicy.currency,'USD');assert.deepEqual(f.core.command(f.session,bytes(cmd)).receipt,receipt);
});
test('legacy unresolved obligations prevent currency migration without changing policy or held debt',async t=>{
 const f=await fixture(t),pending=start(f,post(f).mission),before=target(f),debt=saved(f,pending.intent.id).value.obligationId,old=saved(f,debt).row.data;
 denied(f.core.command(f.session,bytes(configure(f))),'BUDGET_MIGRATION_UNRESOLVED');
 assert.equal(target(f).versionId,before.versionId);assert.equal(saved(f,debt).row.data,old);
});
test('USD budget configuration rejects stale revision and E above normal without mutation',async t=>{
 const f=await fixture(t),cmd=configure(f),before=target(f);
 denied(f.core.command(f.session,bytes({...cmd,payload:{...cmd.payload,autonomous_e_limit:'41'}})),'BUDGET_E_NOT_SUBSET');
 assert.equal(target(f).versionId,before.versionId);
 const valid=configure(f);committed(f.core.command(f.session,bytes(valid)));
 denied(f.core.command(f.session,bytes({...valid,command_id:randomUUID()})),'REVISION_CONFLICT');
});
