import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexRpcPort } from '../../dist/native-codex/src/rpc.js';

function fixture(on=()=>{},timeout=200){
  const writes=[];let aborted=0,ended=0;
  const port=new CodexRpcPort({write:b=>writes.push(JSON.parse(Buffer.from(b))),end:()=>ended++,abort:()=>aborted++},on,timeout);
  const send=v=>port.push(Buffer.from(JSON.stringify(v)+'\n'));
  return {port,writes,send,aborted:()=>aborted,ended:()=>ended};
}
test('RPC correlates interleaved replies and byte-split UTF8 notifications',async()=>{
  const notes=[],x=fixture(n=>notes.push(n)),a=x.port.request('initialize',{}),b=x.port.request('account/read',{});
  const note=Buffer.from(JSON.stringify({method:'warning',params:{message:'日本語'}})+'\n');for(const byte of note)x.port.push(Uint8Array.of(byte));
  x.send({id:2,result:{account:null}});x.send({id:1,result:{userAgent:'fixture'}});
  assert.deepEqual(await a,{userAgent:'fixture'});assert.deepEqual(await b,{account:null});assert.equal(notes[0].params.message,'日本語');
  x.port.initialized();assert.throws(()=>x.port.initialized());x.port.end();x.port.end();assert.equal(x.ended(),1);x.port.finish();assert.equal(x.port.pendingCount,0);
});
for(const kind of ['server-request','unknown-id','missing-result','both-result-error','invalid-error','duplicate-key','partial-eof','notification-throw'])test(`RPC quarantines ${kind} and rejects outstanding work`,async()=>{
  const x=fixture(()=>{if(kind==='notification-throw')throw Error('untrusted item');});
  const pending=x.port.request('turn/start',{});const rejected=assert.rejects(pending);
  let frame={id:1};
  if(kind==='server-request')frame={id:7,method:'tool/call',params:{}};
  if(kind==='unknown-id')frame={id:9,result:{}};
  if(kind==='both-result-error')frame={id:1,result:{},error:{code:1}};
  if(kind==='invalid-error')frame={id:1,error:{code:'bad'}};
  if(kind==='notification-throw')frame={method:'item/completed',params:{}};
  assert.throws(()=>{if(kind==='partial-eof'){x.port.push(Buffer.from('{'));x.port.finish();}else if(kind==='duplicate-key')x.port.push(Buffer.from('{"id":1,"id":1,"result":{}}\n'));else x.send(frame);});
  await rejected;assert.equal(x.aborted(),1);assert.equal(x.port.pendingCount,0);assert.throws(()=>x.port.request('turn/start',{}));
});
test('RPC timeout rejects all pending requests, late replies cannot revive transport',async()=>{
  const x=fixture(()=>{},10),a=x.port.request('turn/start',{}),b=x.port.request('account/read',{});
  await Promise.all([assert.rejects(a,/TIMEOUT/),assert.rejects(b,/TIMEOUT/)]);
  assert.equal(x.aborted(),1);assert.throws(()=>x.send({id:1,result:{}}));assert.equal(x.writes.length,2);
});
test('remote errors expose no provider free text and do not imply retry',async()=>{
  const x=fixture(),a=x.port.request('turn/start',{});x.send({id:1,error:{code:-32600,message:'SECRET'}});
  await assert.rejects(a,e=>e.message==='CODEX_RPC_REMOTE_ERROR');assert.equal(x.writes.length,1);x.port.end();x.port.finish();
});
test('bounds, closed transport and write failures do not leak pending promises',async()=>{
  const x=fixture();assert.throws(()=>x.port.request('exec',{}));assert.throws(()=>x.port.request('turn/start',{text:'x'.repeat(65536)}));
  const a=x.port.request('turn/start',{});const rejected=assert.rejects(a,/CLOSED/);x.port.finish();await rejected;
  assert.throws(()=>x.port.request('turn/start',{}));assert.equal(x.port.pendingCount,0);
  let abort=0;const broken=new CodexRpcPort({write:()=>{throw Error('pipe');},end:()=>{},abort:()=>abort++},()=>{});
  await assert.rejects(broken.request('initialize',{}),/WRITE_FAILED/);assert.equal(abort,1);
});
test('pending and lifetime request caps reject before writing',async()=>{
  const x=fixture(),pending=Array.from({length:4},()=>x.port.request('config/read',{}));
  assert.throws(()=>x.port.request('config/read',{}));assert.equal(x.writes.length,4);
  pending.forEach((_,i)=>x.send({id:i+1,result:{}}));await Promise.all(pending);
  for(let id=5;id<=32;id++){const p=x.port.request('config/read',{});x.send({id,result:{}});await p;}
  assert.throws(()=>x.port.request('config/read',{}));assert.equal(x.writes.length,32);x.port.end();x.port.finish();
});
