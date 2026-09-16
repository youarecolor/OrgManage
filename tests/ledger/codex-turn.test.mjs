import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { LedgerStore, LedgerIntegrityError, LedgerOwnerError } from '../../dist/ledger/src/index.js';
import { CodexTurnCoordinator } from '../../dist/core/src/codex-turn.js';
import { assessCodexModel, CODEX_LIVE_BLOCKERS } from '../../dist/native-codex/src/admission.js';
const base=resolve('.private/test-runs');await mkdir(base,{recursive:true});const dir=await mkdtemp(join(base,'codex-turn-'));let serial=0;
const path=()=>join(dir,`${++serial}.sqlite`);
const bytes=v=>Buffer.from(JSON.stringify(v));
const start=a=>({id:`start:${a.id}`,result:{turn:{id:'turn-fixture',status:'inProgress',items:[],error:null}}});
const end=(a,status='completed',text='synthetic answer')=>({method:'turn/completed',params:{threadId:a.threadId,turn:{id:'turn-fixture',status,error:null,items:[{id:'message-fixture',type:'agentMessage',text,phase:'final_answer'}]}}});
async function fixture(t){
  const dbPath=path(),store=await LedgerStore.open(dbPath);t.after(()=>store.close());
  const p=randomUUID(),actor=randomUUID(),app=randomUUID(),scope=randomUUID(),contract=randomUUID();let now=100000;
  store.transaction(tx=>{tx.insertPrincipal({id:p,kind:'person',displayName:'Synthetic native'});tx.putMembership({principalId:p,actorId:actor,role:'owner',generation:1n});tx.insertScope({id:app,principalId:null,kind:'application',parentId:null,revision:1n,epoch:1n,state:'active'});tx.insertScope({id:scope,principalId:p,kind:'principal',parentId:app,revision:1n,epoch:1n,state:'active'});tx.insertRecord({principalId:p,id:contract,kind:'contract',revision:1n,data:JSON.stringify({mode:'codex_protocol_rehearsal',scopeId:scope})});});
  const core=new CodexTurnCoordinator(store,()=>now);
  const request={mode:'synthetic',principalId:p,actorId:actor,scopeId:scope,contractVersion:store.read(tx=>tx.getRecord(p,contract).versionId),accountRoute:'synthetic-chatgpt-account',model:'test-model',effort:'high',input:'Reply with OK.',threadId:'thread-fixture',profileDigest:'b'.repeat(64),expiresAt:110000};
  return {store,core,request,p,actor,app,scope,dbPath,clock:()=>now,setNow:n=>{now=n;},prepare:()=>core.prepare(request),read:a=>store.read(tx=>tx.native.getAttempt(p,a.id)),observe:(a,v)=>core.observe(p,a.id,bytes(v))};
}
test('durable Run/Attempt, pinned request and one send; output remains data',async t=>{
  const f=await fixture(t),a=f.prepare();const packet=f.core.acquireStart(f.p,a.id);
  assert.equal(packet.kind,'synthetic');assert.equal(f.read(a).state,'send_intent');assert.equal(packet.request.params.model,'test-model');assert.equal(packet.request.params.effort,'high');assert.deepEqual(packet.request.params.environments,[]);
  assert.throws(()=>f.core.acquireStart(f.p,a.id));f.observe(a,start(a));assert.equal(f.observe(a,end(a,'completed','<script>malicious()</script>')).state,'completed');
  assert.equal(f.store.read(tx=>tx.getRecord(f.p,a.runId)).kind,'run');assert.equal(f.store.read(tx=>tx.native.events(f.p,a.id)).at(-1).payload.includes('<script>'),true);
  assert.equal(f.store.read(tx=>tx.listRecord(f.p,'artifact')).length,0);assert.equal(f.store.read(tx=>tx.listRecord(f.p,'cost_event')).length,0);
});
test('terminal notification before start response is retained, late response cannot regress',async t=>{
  const f=await fixture(t),a=f.prepare();f.core.acquireStart(f.p,a.id);assert.equal(f.observe(a,end(a)).state,'completed');assert.equal(f.observe(a,start(a)).state,'completed');
});
test('stop before start discards; stop before turn id waits; ack is not observed stop',async t=>{
  const f=await fixture(t),a=f.prepare();f.core.requestStop(f.p,a.id);assert.equal(f.read(a).state,'discarded');assert.throws(()=>f.core.acquireStart(f.p,a.id));
  const b=f.prepare();f.core.acquireStart(f.p,b.id);f.core.requestStop(f.p,b.id);assert.throws(()=>f.core.acquireInterrupt(f.p,b.id));f.observe(b,start(b));
  assert.equal(f.core.acquireInterrupt(f.p,b.id).request.method,'turn/interrupt');assert.throws(()=>f.core.acquireInterrupt(f.p,b.id));
  const ack=f.observe(b,{id:`interrupt:${b.id}`,result:{}});assert.equal(ack.cancellation,'requested');assert.equal(ack.state,'running');
  const stopped=f.observe(b,end(b,'interrupted'));assert.equal(stopped.state,'interrupted');assert.equal(stopped.cancellation,'observed');
});
test('completion after cancellation is completion, not fabricated cancellation',async t=>{
  const f=await fixture(t),a=f.prepare();f.core.acquireStart(f.p,a.id);f.observe(a,start(a));f.core.requestStop(f.p,a.id);
  const done=f.observe(a,end(a));assert.equal(done.state,'completed');assert.equal(done.cancellation,'requested');
});
test('expiry maintenance requests stop; regressed clock cannot send',async t=>{
  const f=await fixture(t),a=f.prepare();f.setNow(99999);assert.throws(()=>f.core.acquireStart(f.p,a.id));f.core.maintain();assert.equal(f.read(a).state,'discarded');
  f.setNow(100000);const b=f.prepare();f.core.acquireStart(f.p,b.id);f.setNow(110000);f.core.maintain();assert.equal(f.read(b).state,'send_intent');assert.equal(f.read(b).cancellation,'requested');
});
test('late conflict is retained even after another attempt was prepared',async t=>{
  const f=await fixture(t),a=f.prepare();f.core.acquireStart(f.p,a.id);f.observe(a,end(a));const b=f.prepare();
  assert.equal(f.observe(a,end(a,'failed')).state,'unknown');assert.equal(f.read(b).state,'discarded');assert.throws(()=>f.core.acquireStart(f.p,b.id));assert.throws(()=>f.prepare());
});
test('model/effort selection never silently falls back; live blockers are immutable',()=>{
  const catalog=[{model:'gpt-5.6-sol',efforts:['low','max']}];
  assert.equal(assessCodexModel('gpt-6-astra','max',catalog).reason,'model_not_advertised');assert.equal(assessCodexModel('gpt-5.6-sol','high',catalog).reason,'effort_not_advertised');
  assert.deepEqual(assessCodexModel('gpt-5.6-sol','max',catalog),{eligible:true,reason:'listed',model:'gpt-5.6-sol',effort:'max',fallback:false});assert.ok(Object.isFrozen(CODEX_LIVE_BLOCKERS));
});
test('unknown has a unique reconciliation job, blocks replacement and accepts late evidence',async t=>{
  const f=await fixture(t),a=f.prepare();f.core.acquireStart(f.p,a.id);f.core.transportLost(f.p,a.id);f.core.transportLost(f.p,a.id);
  assert.equal(f.read(a).state,'unknown');assert.throws(()=>f.prepare());assert.throws(()=>f.core.acquireStart(f.p,a.id));
  assert.equal(f.store.read(tx=>tx.listRecord(f.p,'reconciliation_case')).length,1);assert.equal(f.store.read(tx=>tx.listRecord(f.p,'job')).length,1);
  assert.equal(f.observe(a,end(a)).state,'completed');assert.equal(JSON.parse(f.store.read(tx=>tx.listRecord(f.p,'reconciliation_case'))[0].data).state,'resolved');
});
test('same event duplicate is idempotent, conflict preserves both and stays unknown',async t=>{
  const f=await fixture(t),a=f.prepare();f.core.acquireStart(f.p,a.id);const first=f.observe(a,end(a));assert.equal(f.observe(a,end(a)).revision,first.revision);
  assert.equal(f.observe(a,end(a,'completed','different answer')).state,'unknown');assert.equal(f.store.read(tx=>tx.native.events(f.p,a.id)).length,2);
  assert.equal(f.observe(a,end(a)).state,'unknown');assert.throws(()=>f.prepare());
});
test('reopen recovers old owner without replay; prepared requests are discarded',async t=>{
  const f=await fixture(t),a=f.prepare();f.core.acquireStart(f.p,a.id);await f.store.close();
  const next=await LedgerStore.open(f.dbPath);t.after(()=>next.close());const core=new CodexTurnCoordinator(next,f.clock);
  assert.equal(next.read(tx=>tx.native.getAttempt(f.p,a.id)).state,'unknown');assert.throws(()=>core.acquireStart(f.p,a.id));assert.equal(core.observe(f.p,a.id,bytes(end(a))).state,'completed');
  const b=core.prepare(f.request);await next.close();const third=await LedgerStore.open(f.dbPath);t.after(()=>third.close());new CodexTurnCoordinator(third,f.clock);assert.equal(third.read(tx=>tx.native.getAttempt(f.p,b.id)).state,'discarded');
});
for(const variant of ['expired','revoked','ancestor_paused','generation_changed'])test(`rechecks ${variant} before send`,async t=>{
  const f=await fixture(t),a=f.prepare();
  if(variant==='expired')f.setNow(110000);else f.store.transaction(tx=>{if(variant==='revoked')tx.putMembership({principalId:f.p,actorId:f.actor,role:'revoked',generation:2n});else{const s=tx.getScope(f.app);tx.updateScope({...s,state:variant==='ancestor_paused'?'paused':'active',revision:2n,epoch:2n},1n);}});
  assert.throws(()=>f.core.acquireStart(f.p,a.id));assert.equal(f.read(a).state,'prepared');
});
for(const variant of ['wrong_thread','wrong_turn','server_request','rpc_error','tool_item','wrong_reply_id','malformed'])test(`rejects ${variant} without claiming success`,async t=>{
  const f=await fixture(t),a=f.prepare();f.core.acquireStart(f.p,a.id);f.observe(a,start(a));let message=end(a);
  if(variant==='wrong_thread')message.params.threadId='other';if(variant==='wrong_turn')message.params.turn.id='other';if(variant==='server_request')message={id:42,method:'item/commandExecution/requestApproval',params:{command:'unexpected'}};
  if(variant==='rpc_error')message={id:`start:${a.id}`,error:{code:1,message:'SECRET'}};if(variant==='tool_item')message.params.turn.items=[{id:'tool',type:'commandExecution',command:'do something'}];if(variant==='wrong_reply_id')message={id:'wrong',result:{}};
  if(variant==='malformed')assert.throws(()=>f.core.observe(f.p,a.id,Buffer.from('{"id":1,"id":2}')));else f.observe(a,message);
  assert.equal(f.read(a).state,'unknown');assert.equal(JSON.stringify(f.store.read(tx=>tx.native.events(f.p,a.id))).includes('SECRET'),false);
});
test('same transaction stops ancestors and rolls back the stop if caller fails',async t=>{
  const f=await fixture(t),a=f.prepare();assert.throws(()=>f.store.transaction(tx=>{f.core.stopDescendants(tx,f.p,f.app);throw Error('rollback');}));assert.equal(f.read(a).state,'prepared');
  f.store.transaction(tx=>f.core.stopDescendants(tx,f.p,f.app));assert.equal(f.read(a).state,'discarded');
});
test('live flag and foreign contract cannot create Run/Attempt',async t=>{
  const f=await fixture(t);assert.throws(()=>f.core.prepare({...f.request,mode:'live'}));assert.throws(()=>f.core.prepare({...f.request,contractVersion:randomUUID()}));assert.equal(f.store.read(tx=>tx.listRecord(f.p,'run')).length,0);
});
test('SQLite rejects wrong run identity; identity and events immutable; API callback confinement',async t=>{
  const f=await fixture(t),a=f.prepare();assert.throws(()=>f.store.transaction(tx=>tx.native.insertAttempt({...a,id:randomUUID(),runId:randomUUID()})),LedgerIntegrityError);
  let api;f.store.read(tx=>{api=tx.native;assert.throws(()=>api.updateAttempt({...a,state:'running',revision:2n},1n),LedgerOwnerError);});assert.throws(()=>api.events(f.p,a.id),LedgerOwnerError);
  const raw=new DatabaseSync(f.dbPath,{enableForeignKeyConstraints:true});t.after(()=>raw.close());assert.throws(()=>raw.prepare('UPDATE native_attempts SET run_id=? WHERE id=?').run(randomUUID(),a.id));
  f.core.acquireStart(f.p,a.id);f.observe(a,end(a));assert.throws(()=>raw.exec("UPDATE native_events SET payload='{}'"));assert.throws(()=>raw.exec('DELETE FROM native_events'));
});
test('exact original v2 migrates to v8 and retains metadata; tampered v2 is rejected',async t=>{
  const frozen=JSON.parse(await readFile(new URL('./fixtures/schema-v2.json',import.meta.url),'utf8'));
  for(const tamper of [false,true]){const p=path(),db=new DatabaseSync(p);db.exec('BEGIN');for(const sql of [...frozen.schema].sort((a,b)=>Number(!a.startsWith('CREATE TABLE'))-Number(!b.startsWith('CREATE TABLE'))))db.exec(sql);for(const m of frozen.meta)db.prepare('INSERT INTO meta VALUES(?,?)').run(m.key,m.value);db.exec('PRAGMA application_id=1330464561; PRAGMA user_version=2; COMMIT');if(tamper)db.exec('CREATE TABLE unexpected(x TEXT)');db.close();
    if(tamper){await assert.rejects(LedgerStore.open(p),LedgerIntegrityError);const raw=new DatabaseSync(p);assert.equal(raw.prepare('PRAGMA user_version').get().user_version,2);assert.equal(raw.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name='native_attempts'").get().n,0);raw.close();}
    else{const store=await LedgerStore.open(p);t.after(()=>store.close());assert.equal(store.read(tx=>tx.getMeta('fixture_preserve')),'native-original');assert.deepEqual(store.read(tx=>tx.native.listAttempts(randomUUID())),[]);const raw=new DatabaseSync(p);assert.equal(raw.prepare('PRAGMA user_version').get().user_version,8);raw.close();}
  }
});
