import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LedgerStore, LedgerIntegrityError, LedgerOwnerError, LEDGER_SCHEMA_HASH } from '../../dist/ledger/src/index.js';
import { FixedRunnerCoordinator, RunnerDeniedError } from '../../dist/core/src/runner.js';

const base=resolve('.private/test-runs');await mkdir(base,{recursive:true});const run=await mkdtemp(join(base,'runner-'));let serial=0;
const path=()=>join(run,`${++serial}.sqlite`);
const response=(b,status='running',extra={})=>Buffer.from(JSON.stringify({...b,status,kind:'synthetic',handlesSignaled:status==='stopped',jobEmpty:status==='stopped',writesStable:status==='stopped',detail:{fixture:true},...extra}));
async function fixture(t,{port,timeout}={}){
  const dbPath=path(),store=await LedgerStore.open(dbPath);t.after(()=>store.close());
  const p=randomUUID(),actor=randomUUID(),app=randomUUID(),scope=randomUUID();let now=100000;
  store.transaction(tx=>{tx.insertPrincipal({id:p,kind:'person',displayName:'Runner fixture'});tx.putMembership({principalId:p,actorId:actor,role:'owner',generation:1n});tx.insertScope({id:app,principalId:null,kind:'application',parentId:null,revision:1n,epoch:1n,state:'active'});tx.insertScope({id:scope,principalId:p,kind:'principal',parentId:app,revision:1n,epoch:1n,state:'active'});});
  const profile={principalId:p,id:randomUUID(),revision:1n,digest:'a'.repeat(64),kind:'synthetic',isolationId:randomUUID(),ttlMs:1000};
  const calls=[];const transport=port??{startExecutor:async b=>{calls.push(['start',b]);return response(b);},requestStop:async b=>{calls.push(['stop',b]);return response(b,'stopped');},inspect:async b=>{calls.push(['inspect',b]);return response(b,'stopped');}};
  const core=new FixedRunnerCoordinator(store,[{profile,port:transport}],()=>now,timeout??1000);
  const workspace=core.prepare({principalId:p,id:randomUUID(),profileId:profile.id,profileRevision:1n,profileDigest:profile.digest,snapshotDigest:'b'.repeat(64),writeSetDigest:'c'.repeat(64),isolationId:profile.isolationId});
  return {store,dbPath,p,actor,app,scope,profile,transport,core,workspace,calls,setNow:n=>{now=n;},clock:()=>now,claim:()=>core.claim(p,workspace.id,scope,actor)};
}
const read=(f,l)=>f.store.read(tx=>tx.runner.getLease(f.p,l.id));
const raw=p=>new DatabaseSync(p,{enableForeignKeyConstraints:true,readBigInts:true,allowExtension:false});

test('migrates the frozen real v1 schema atomically and preserves original rows/owner generation',async t=>{
  const frozen=JSON.parse(await readFile(new URL('./fixtures/schema-v1.json',import.meta.url),'utf8'));const p=path(),db=raw(p);
  db.exec('BEGIN');for(const sql of frozen.schema)db.exec(sql);for(const r of frozen.meta)db.prepare('INSERT INTO meta VALUES(?,?)').run(r.key,r.value);
  db.prepare('INSERT INTO principals VALUES(?,?,?)').run('11111111-1111-1111-1111-111111111111','person','Migration fixture');db.exec('PRAGMA application_id=1330464561; PRAGMA user_version=1; COMMIT');db.close();
  const store=await LedgerStore.open(p);t.after(()=>store.close());assert.equal(store.ownerEpoch,2n);assert.equal(store.read(tx=>tx.getMeta('fixture_preserve')),'original');assert.equal(store.read(tx=>tx.listPrincipal())[0].displayName,'Migration fixture');
  const check=raw(p);assert.equal(check.prepare('PRAGMA user_version').get().user_version,8n);assert.equal(check.prepare("SELECT value FROM meta WHERE key='_store.schema_hash'").get().value,LEDGER_SCHEMA_HASH);check.close();
  await store.close();const again=await LedgerStore.open(p);t.after(()=>again.close());assert.equal(again.ownerEpoch,3n);assert.deepEqual(again.read(tx=>tx.runner.listLeases('11111111-1111-1111-1111-111111111111')),[]);
});
test('partial or tampered v1 fails before creating any runner table',async()=>{
  const frozen=JSON.parse(await readFile(new URL('./fixtures/schema-v1.json',import.meta.url),'utf8'));const p=path(),db=raw(p);
  for(const sql of frozen.schema)db.exec(sql);for(const r of frozen.meta)db.prepare('INSERT INTO meta VALUES(?,?)').run(r.key,r.value);db.exec("PRAGMA application_id=1330464561; PRAGMA user_version=1; CREATE TABLE unexpected(x TEXT)");db.close();
  await assert.rejects(LedgerStore.open(p),LedgerIntegrityError);const check=raw(p);assert.equal(check.prepare('PRAGMA user_version').get().user_version,1n);assert.equal(check.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='runner_leases'").get().n,0n);check.close();
});
test('same ledger transaction rolls back workspace generation, lease and audit together',async t=>{
  const f=await fixture(t);const l=f.claim();assert.equal(l.generation,2n);
  assert.throws(()=>f.claim(),RunnerDeniedError);assert.equal(f.store.read(tx=>tx.runner.getWorkspace(f.p,f.workspace.id)).generation,2n);
  assert.equal(f.store.read(tx=>tx.runner.listLeases(f.p)).length,1);assert.equal(f.store.read(tx=>tx.listAudit(f.p)).filter(a=>a.kind==='runner.claimed').length,1);
});
test('DB independently prevents a second writer and direct release without OS observation',async t=>{
  const f=await fixture(t);const l=f.claim();const db=raw(f.dbPath);
  assert.throws(()=>db.prepare('INSERT INTO runner_leases SELECT principal_id,?,workspace_id,generation,scope_id,actor_id,owner_id,owner_epoch,stop_epoch,operation,state,revision,sequence,expires_at,hard_deadline,updated_at,dispatched,observation_id FROM runner_leases WHERE id=?').run(randomUUID(),l.id),/UNIQUE/);
  assert.throws(()=>db.prepare("UPDATE runner_leases SET state='released',observation_id=?,revision=revision+1 WHERE id=?").run(randomUUID(),l.id),/matching complete stop observation/);
  assert.throws(()=>db.prepare('UPDATE runner_workspaces SET generation=generation+1 WHERE id=?').run(l.workspaceId),/unreleased writer/);db.close();
});
test('complete natural completion releases generation zero and immutable matching proof',async t=>{
  const f=await fixture(t,{port:{startExecutor:async b=>response(b,'stopped'),inspect:async b=>response(b,'stopped'),requestStop:async b=>response(b,'stopped')}});const l=f.claim();const result=await f.core.startExecutor(f.p,l.id);
  assert.equal(result.state,'released');assert.equal(result.stopEpoch,0n);assert.ok(result.observationId);const proof=f.store.read(tx=>tx.runner.getObservation(f.p,result.observationId));assert.equal(proof.leaseId,l.id);assert.equal(proof.kind,'synthetic');
  const db=raw(f.dbPath);assert.throws(()=>db.prepare('DELETE FROM runner_stop_observations WHERE id=?').run(proof.id),/immutable/);assert.throws(()=>db.prepare('DELETE FROM runner_leases WHERE id=?').run(l.id),/history/);db.close();
  const next=f.claim();assert.equal(next.generation,l.generation+1n);assert.notEqual(next.id,l.id);
});
test('dispatch is durably recorded before adapter invocation, second start is refused',async t=>{
  const f=await fixture(t);const l=f.claim();f.transport.startExecutor=async b=>{assert.equal(read(f,l).dispatched,true);assert.ok(f.store.read(tx=>tx.listAudit(f.p)).some(a=>a.kind==='runner.start_intent'));return response(b);};
  assert.equal((await f.core.startExecutor(f.p,l.id)).state,'active');await assert.rejects(f.core.startExecutor(f.p,l.id),/reconcile/);
});
test('rejected/replayed/old-owner heartbeat cannot extend the durable lease',async t=>{
  const f=await fixture(t);const l=f.claim();f.setNow(100500);
  assert.equal(f.core.renew(f.p,l.id,randomUUID(),l.ownerEpoch,0n,1n),false);assert.equal(read(f,l).expiresAt,101000);
  assert.equal(f.core.renew(f.p,l.id,l.ownerId,l.ownerEpoch,0n,1n),true);assert.equal(read(f,l).expiresAt,101500);
  f.setNow(100700);assert.equal(f.core.renew(f.p,l.id,l.ownerId,l.ownerEpoch,0n,1n),false);assert.equal(read(f,l).expiresAt,101500);
  f.setNow(101499);assert.equal(f.core.renew(f.p,l.id,l.ownerId,l.ownerEpoch,0n,2n),true);assert.equal(read(f,l).expiresAt,102000);
  f.setNow(102000);assert.equal(f.core.renew(f.p,l.id,l.ownerId,l.ownerEpoch,0n,3n),false);assert.equal(read(f,l).state,'quarantined');assert.throws(()=>f.claim(),RunnerDeniedError);
});
test('stop request is not release; matching observation then permits reuse',async t=>{
  const f=await fixture(t);const l=f.claim();await f.core.startExecutor(f.p,l.id);const stopped=f.core.requestStop(f.p,l.id);assert.equal(stopped.state,'stop_requested');assert.equal(stopped.stopEpoch,1n);assert.equal(stopped.observationId,null);assert.throws(()=>f.claim(),RunnerDeniedError);
  assert.equal((await f.core.reconcile(f.p,l.id,true)).state,'released');assert.equal(f.calls.at(-1)[1].stopEpoch,'1');assert.doesNotThrow(()=>f.claim());
});
test('reopen quarantines previous owner and never reissues its start',async t=>{
  const f=await fixture(t);const l=f.claim();await f.core.startExecutor(f.p,l.id);await f.store.close();const store=await LedgerStore.open(f.dbPath);t.after(()=>store.close());const core=new FixedRunnerCoordinator(store,[{profile:f.profile,port:f.transport}],f.clock);
  assert.equal(store.read(tx=>tx.runner.getLease(f.p,l.id)).state,'quarantined');assert.throws(()=>core.claim(f.p,f.workspace.id,f.scope,f.actor),RunnerDeniedError);await assert.rejects(core.startExecutor(f.p,l.id));assert.equal(f.calls.filter(c=>c[0]==='start').length,1);
  assert.equal((await core.reconcile(f.p,l.id,true)).state,'released');const next=core.claim(f.p,f.workspace.id,f.scope,f.actor);assert.equal(next.ownerEpoch,store.ownerEpoch);assert.equal(next.generation,l.generation+1n);
});
for(const failure of ['throw','malformed','wrong_owner','wrong_generation','wrong_kind','missing_predicate','extra_field','duplicate_key','timeout'])test(`uncertain ${failure} cannot release or resend`,async t=>{
  const f=await fixture(t,{timeout:20});const l=f.claim();f.transport.startExecutor=async b=>{
    if(failure==='throw')throw new Error('transport');if(failure==='timeout')return new Promise(()=>{});if(failure==='malformed')return Buffer.from('{');
    if(failure==='duplicate_key')return Buffer.from(response(b,'stopped').toString().replace('"status":"stopped"','"status":"stopped","status":"running"'));
    return response(b,'stopped',failure==='wrong_owner'?{ownerId:randomUUID()}:failure==='wrong_generation'?{generation:'999'}:failure==='wrong_kind'?{kind:'fixed_guest_fixture'}:failure==='missing_predicate'?{jobEmpty:false}:{unexpected:true});
  };
  assert.equal((await f.core.startExecutor(f.p,l.id)).state,'quarantined');assert.equal(read(f,l).observationId,null);assert.throws(()=>f.claim(),RunnerDeniedError);await assert.rejects(f.core.startExecutor(f.p,l.id));
});
test('late start observation from before a stop cannot satisfy the newer generation',async t=>{
  const f=await fixture(t);const l=f.claim();let finish,binding;f.transport.startExecutor=b=>{binding=b;return new Promise(r=>{finish=r;});};const request=f.core.startExecutor(f.p,l.id);
  f.core.requestStop(f.p,l.id);finish(response(binding,'stopped'));assert.equal((await request).state,'stop_requested');assert.equal(read(f,l).observationId,null);assert.equal((await f.core.reconcile(f.p,l.id,true)).state,'released');
});
test('paused ancestor/revoked member prohibits start and maintenance quarantines existing lease',async t=>{
  const f=await fixture(t);const l=f.claim();f.store.transaction(tx=>{const app=tx.getScope(f.app);tx.updateScope({...app,state:'paused',revision:2n,epoch:2n},1n);});await assert.rejects(f.core.startExecutor(f.p,l.id));assert.equal(f.calls.length,0);assert.equal(f.core.maintain()[0].state,'quarantined');
  assert.throws(()=>f.core.claim(f.p,f.workspace.id,f.scope,randomUUID()),RunnerDeniedError);
});
test('clock regression quarantines and does not reopen after clock correction',async t=>{
  const f=await fixture(t);const l=f.claim();f.setNow(99999);assert.equal(f.core.maintain()[0].state,'quarantined');f.setNow(100001);assert.equal(f.core.renew(f.p,l.id,l.ownerId,l.ownerEpoch,1n,1n),false);assert.throws(()=>f.claim(),RunnerDeniedError);
});
test('runner capabilities cannot escape read-only/expired callback or expose SQL',async t=>{
  const f=await fixture(t);let saved;f.store.read(tx=>{saved=tx.runner;assert.equal(tx.runner.get,undefined);assert.equal(tx.runner.run,undefined);assert.throws(()=>tx.runner.insertProfile({...f.profile,id:randomUUID()}),LedgerOwnerError);});assert.throws(()=>saved.listLeases(f.p),LedgerOwnerError);
});

test('real owner process exits after committed start intent; replacement quarantines without replay',async t=>{
  const f=await fixture(t);const inputPath=f.dbPath+'.input.json',markerPath=f.dbPath+'.effect.json';
  await writeFile(inputPath,JSON.stringify({p:f.p,actor:f.actor,scope:f.scope,workspaceId:f.workspace.id,profile:{...f.profile,revision:'1'}}));await f.store.close();
  const child=spawnSync(process.execPath,[fileURLToPath(new URL('./fixtures/runner-owner-crash.mjs',import.meta.url)),f.dbPath,inputPath,markerPath],{encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(child.status,42,child.stderr);const binding=JSON.parse(await readFile(markerPath,'utf8'));
  const store=await LedgerStore.open(f.dbPath);t.after(()=>store.close());const core=new FixedRunnerCoordinator(store,[{profile:f.profile,port:f.transport}]);
  const recovered=store.read(tx=>tx.runner.getLease(f.p,binding.leaseId));assert.equal(recovered.dispatched,true);assert.equal(recovered.state,'quarantined');assert.equal(recovered.observationId,null);await assert.rejects(core.startExecutor(f.p,binding.leaseId));assert.equal(f.calls.length,0);
});

test('DB rejects cross-workspace observation and mismatched evidence kind',async t=>{
  const f=await fixture(t);const l=f.claim();const db=raw(f.dbPath);
  assert.throws(()=>db.prepare('INSERT INTO runner_stop_observations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(f.p,randomUUID(),l.id,randomUUID(),l.generation,l.ownerId,l.ownerEpoch,0n,'synthetic',1,1,1,100000,'{}'),/FOREIGN KEY/);
  const proofId=randomUUID();db.prepare('INSERT INTO runner_stop_observations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(f.p,proofId,l.id,l.workspaceId,l.generation,l.ownerId,l.ownerEpoch,0n,'fixed_guest_fixture',1,1,1,100000,'{}');
  assert.throws(()=>db.prepare("UPDATE runner_leases SET state='released',observation_id=?,revision=revision+1 WHERE id=?").run(proofId,l.id),/matching complete stop observation/);db.close();
});

test('revoked then restored membership cannot revive a captured lease authorization',async t=>{
  const f=await fixture(t);const l=f.claim();f.store.transaction(tx=>{tx.putMembership({principalId:f.p,actorId:f.actor,role:'revoked',generation:2n});tx.putMembership({principalId:f.p,actorId:f.actor,role:'owner',generation:3n});});
  await assert.rejects(f.core.startExecutor(f.p,l.id),/authority generation/);assert.equal(f.calls.length,0);assert.equal(f.core.maintain()[0].state,'quarantined');
});
test('scope epoch change without a paused state still invalidates the old authorization',async t=>{
  const f=await fixture(t);const l=f.claim();f.store.transaction(tx=>{const s=tx.getScope(f.scope);tx.updateScope({...s,revision:2n,epoch:2n},1n);});
  assert.equal(f.core.renew(f.p,l.id,l.ownerId,l.ownerEpoch,0n,1n),false);assert.equal(read(f,l).state,'quarantined');
});
