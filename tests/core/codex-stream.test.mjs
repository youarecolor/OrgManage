import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,randomUUID,post,control,bytes,committed,snap,addPrincipal,LedgerStore,OrgManageCore} from './fixtures/helpers.mjs';
import {CodexFrameStream} from '../../dist/native-codex/src/stream.js';

async function setup(t){
  const f=await fixture(t),mission=post(f).mission,id=randomUUID();
  f.store.transaction(tx=>tx.insertRecord({principalId:f.principal,id,kind:'contract',revision:1n,data:JSON.stringify({mode:'codex_protocol_rehearsal',scopeId:mission.id})}));
  const a=f.core.codex.prepare({mode:'synthetic',principalId:f.principal,actorId:f.actor,scopeId:mission.id,contractVersion:f.store.read(tx=>tx.getRecord(f.principal,id).versionId),accountRoute:'synthetic-account',model:'test-model',effort:'low',input:'fixture',threadId:'thread-one',profileDigest:'c'.repeat(64),expiresAt:f.now.getTime()+60000});
  f.core.codex.acquireStart(f.principal,a.id);
  const stream=f.core.codex.openStream(f.principal,a.id),view=()=>snap(f).nativeAttempts[0];
  const send=v=>stream.push(Buffer.concat([bytes(v),Buffer.from('\n')]));
  const frame=(method,params={})=>({method,params:{threadId:a.threadId,turnId:'turn-one',...params}});
  const item=(text='日本語の応答',id='answer')=>({id,type:'agentMessage',text,phase:'final_answer'});
  const start=()=>send({id:`start:${a.id}`,result:{turn:{id:'turn-one',status:'inProgress',items:[],error:null}}});
  const end=(status='completed',items=[])=>send(frame('turn/completed',{turn:{id:'turn-one',status,items,error:null}}));
  const usage=(input=5461,output=9)=>frame('thread/tokenUsage/updated',{tokenUsage:{total:{inputTokens:input,outputTokens:output,totalTokens:input+output,cachedInputTokens:0,reasoningOutputTokens:0,cacheWriteInputTokens:0}}});
  return {f,mission,a,stream,send,frame,item,start,end,usage,view};
}

test('wire-shaped text/items/usage reach scoped Home projection and survive database reopen',async t=>{
  const x=await setup(t);x.start();
  x.send(x.frame('item/started',{item:x.item('')}));
  const delta=Buffer.concat([bytes(x.frame('item/agentMessage/delta',{itemId:'answer',delta:'日本語'})),Buffer.from('\n')]);
  for(const b of delta)x.stream.push(Uint8Array.of(b));
  assert.deepEqual(x.view().messages,[]); // Deltas never masquerade as completed output.
  x.send(x.frame('item/completed',{item:x.item('<script>window.bad=true</script> 日本語')}));
  assert.equal(x.view().state,'running');assert.equal(x.view().messages.length,1);
  x.send(x.usage());x.end();x.stream.finish();
  assert.equal(x.view().state,'completed');assert.equal(x.view().usage.totalTokens,5470);
  const expected=x.view(),cursor=snap(x.f).visibleCursor;
  assert.deepEqual(x.view(),expected);assert.equal(snap(x.f).visibleCursor,cursor);
  const other=addPrincipal(x.f),otherSession=x.f.core.selectPrincipal(x.f.core.openSession(x.f.actor),other.principal);
  assert.deepEqual(snap(x.f,otherSession).nativeAttempts,[]);
  await x.f.store.close();x.f.store=await LedgerStore.open(x.f.path);x.f.core=new OrgManageCore(x.f.store,x.f.options);x.f.session=x.f.core.selectPrincipal(x.f.core.openSession(x.f.actor),x.f.principal);
  assert.deepEqual(snap(x.f).nativeAttempts[0],expected);
  assert.equal(x.f.store.read(tx=>tx.listRecord(x.f.principal,'outcome')).length,0);
});

test('Home stop request and interrupt acknowledgement remain distinct from observed interrupted terminal',async t=>{
  const x=await setup(t);x.start();
  committed(x.f.core.command(x.f.session,bytes(control(x.f,snap(x.f).application,'halt_dispatch'))));
  const request=x.f.core.codex.acquireInterrupt(x.f.principal,x.a.id).request;
  x.send({id:request.id,result:{}});
  assert.equal(x.view().interruptionAcknowledged,true);assert.equal(x.view().cancellation,'requested');assert.equal(x.view().state,'running');
  x.end('interrupted');assert.equal(x.view().cancellation,'observed');x.stream.finish();
});

test('transport close preserves partial completed text and creates reconciliation without retransmission',async t=>{
  const x=await setup(t);x.start();x.send(x.frame('item/completed',{item:x.item()}));x.stream.finish();
  assert.equal(x.view().state,'unknown');assert.equal(x.view().messages[0].text,'日本語の応答');assert.equal(x.view().usage,null);
  assert.throws(()=>x.f.core.codex.acquireStart(x.f.principal,x.a.id));
  x.f.core.codex.observe(x.f.principal,x.a.id,bytes(x.frame('turn/completed',{turn:{id:'turn-one',status:'completed',items:[],error:null}})));
  assert.equal(x.view().state,'completed');
});

for(const scenario of ['wrong-thread','wrong-turn','tool','server-request','duplicate-json-key','invalid-utf8','message-conflict','terminal-conflict','usage-regression','unsafe-number','late-tool'])test(`stream quarantines ${scenario}`,async t=>{
  const x=await setup(t);x.start();let f=x.frame('item/completed',{item:x.item()});
  if(scenario==='wrong-thread')f.params.threadId='alien';
  if(scenario==='wrong-turn')f.params.turnId='alien';
  if(scenario==='tool'||scenario==='late-tool'){if(scenario==='late-tool')x.end();f.params.item={id:'tool',type:'commandExecution',command:'SECRET'};}
  if(scenario==='server-request')f={id:44,method:'item/tool/call',params:{arguments:'SECRET'}};
  if(scenario==='message-conflict'){x.send(f);f.params.item=x.item('different');}
  if(scenario==='terminal-conflict'){x.send(f);f=x.frame('turn/completed',{turn:{id:'turn-one',status:'completed',items:[x.item('different')],error:null}});}
  if(scenario==='usage-regression'){x.send(x.usage());f=x.usage(4,2);}
  if(scenario==='unsafe-number'){f=x.usage();f.params.tokenUsage.total.totalTokens=Number.MAX_SAFE_INTEGER+1;}
  assert.throws(()=>scenario==='duplicate-json-key'?x.stream.push(Buffer.from('{"id":1,"id":2}\n')):scenario==='invalid-utf8'?x.stream.push(Buffer.from([0xff,10])):x.send(f));
  assert.equal(x.view().state,'unknown');assert.equal(x.view().quarantined,true);
  assert.throws(()=>x.send(f));
  assert.equal(JSON.stringify(x.f.store.read(tx=>tx.native.events(x.f.principal,x.a.id))).includes('SECRET'),false);
});

test('repeated completed messages and usage snapshots are idempotent; multiple messages fit empty terminal',async t=>{
  const x=await setup(t);x.start();
  const message=x.frame('item/completed',{item:x.item()});x.send(message);x.send(message);
  x.send(x.usage());x.send(x.usage());x.send(x.usage(5500,20));
  x.send(x.frame('item/completed',{item:x.item('second','answer-2')}));x.end();
  assert.equal(x.view().messages.length,2);assert.equal(x.view().usage.totalTokens,5520);
  x.send(x.usage(5500,21));assert.equal(x.view().state,'completed');assert.equal(x.view().usage.totalTokens,5521);x.stream.finish();
});

test('metadata is bounded but diagnostic contents are not imported into output or authority',async t=>{
  const x=await setup(t);x.start();
  x.send(x.frame('warning',{message:'SECRET'}));x.send({method:'account/rateLimits/updated',params:{SECRET:'secret'}});
  x.send(x.frame('thread/status/changed',{status:{type:'active',activeFlags:[]}}));
  x.send(x.frame('error',{willRetry:false,error:{message:'SECRET'}}));x.end('failed');
  assert.equal(x.view().state,'failed');assert.equal(x.view().usage,null);
  assert.equal(JSON.stringify(x.f.store.read(tx=>tx.native.events(x.f.principal,x.a.id))).includes('SECRET'),false);
});

for(const kind of ['partial-eof','long-frame','total-limit','frame-count'])test(`bounded framing rejects ${kind}`,()=>{
  let faults=0,ended=0,frames=0;const s=new CodexFrameStream(()=>frames++,()=>ended++,()=>faults++);
  assert.throws(()=>{if(kind==='partial-eof'){s.push(Buffer.from('{'));s.finish();}else if(kind==='long-frame')s.push(Buffer.alloc(65537,32));else if(kind==='total-limit')s.push(Buffer.alloc(2097153));else s.push(Buffer.from('{}\n'.repeat(4097)));});
  assert.equal(faults,1);s.finish();assert.equal(ended,0);assert.throws(()=>s.push(Buffer.from('{}\n')));assert.equal(faults,1);
});

test('empty and partial streams cannot establish success',async t=>{
  const x=await setup(t);x.stream.finish();assert.equal(x.view().state,'unknown');
});
