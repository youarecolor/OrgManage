import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeSubscription} from './fixtures/native-subscription.mjs';
import {committed,snap} from './fixtures/helpers.mjs';
import {NativeProviderDispatch} from '../../dist/core/src/native-provider-dispatch.js';
async function fixture(t){
 const x=await nativeSubscription(t,{},undefined,'provider'),r=x.prepare();committed(x.decide(r));
 const identity={sessionId:x.sessionValue.sessionId,threadId:x.request.threadId,accountRoute:x.request.accountRoute,profileDigest:x.request.profileDigest,model:x.request.model,effort:x.request.effort};
 const channel={writes:[],aborts:0,ends:0,callbacks:null,identity:()=>({...identity}),bind(c){assert.equal(this.callbacks,null);this.callbacks=c;},write(bytes){const state=x.state(r);assert.equal(state.attempt.state==='send_intent'||state.attempt.cancellation==='requested',true);assert.equal(JSON.parse(state.hold.data).state,'send_acquired');this.writes.push(JSON.parse(Buffer.from(bytes).toString()));},end(){this.ends++;},abort(){this.aborts++;this.callbacks?.closed();}};
 const dispatch=new NativeProviderDispatch(x.f.core.codex,x.f.principal,r.attempt.id,{...x.guards,holdId:r.holdId},channel);
 t.after(()=>{if(!dispatch.state.channelClosed&&channel.callbacks)channel.callbacks.closed();});
 const frame=v=>channel.callbacks.data(Buffer.from(JSON.stringify(v)+'\n'));
 const startReply=()=>frame({id:`start:${r.attempt.id}`,result:{turn:{id:'turn',status:'inProgress'}}});
 const end=(status='completed')=>frame({method:'turn/completed',params:{threadId:x.request.threadId,turn:{id:'turn',status,items:[{id:'answer',type:'agentMessage',text:'untrusted reply'}]}}});
 return {...x,r,channel,identity,dispatch,frame,startReply,end};
}
test('dispatch commits exact Run/Attempt and holds before any write, then resolves only after terminal and close',async t=>{
 const x=await fixture(t);x.dispatch.start();assert.equal(x.channel.writes.length,1);assert.equal(x.channel.writes[0].params.effort,'low');assert.equal(x.channel.writes[0].params.input[0].text,x.request.input);assert.throws(()=>x.dispatch.start());
 x.startReply();x.end();assert.equal(x.channel.ends,1);assert.equal(JSON.parse(x.state(x.r).hold.data).state,'send_acquired');x.channel.callbacks.closed();assert.equal(JSON.parse(x.state(x.r).hold.data).state,'resolved');assert.equal(x.state(x.r).attempt.state,'completed');assert.equal(snap(x.f).outcomes.length,0);
});
test('wrong live channel identity is refused without send acquisition',async t=>{
 const x=await fixture(t);x.identity.sessionId='0'.repeat(64);assert.throws(()=>x.dispatch.start());assert.equal(x.channel.writes.length,0);assert.equal(x.state(x.r).attempt.state,'prepared');
});
test('channel closure during bind leaves no send intent or write',async t=>{
 const x=await fixture(t);x.channel.bind=function(c){this.callbacks=c;c.closed();};assert.throws(()=>x.dispatch.start());assert.equal(x.channel.writes.length,0);assert.equal(x.state(x.r).attempt.state,'prepared');assert.equal(JSON.parse(x.state(x.r).hold.data).state,'reserved');
});
test('data during bind is rejected without pretending a request was acquired',async t=>{
 const x=await fixture(t);x.channel.bind=function(c){this.callbacks=c;c.data(Buffer.from('{}\n'));};assert.throws(()=>x.dispatch.start());assert.equal(x.channel.writes.length,0);assert.equal(x.state(x.r).attempt.state,'prepared');
});
test('write exception after acquisition is unknown, retained and never retried',async t=>{
 const x=await fixture(t);let writes=0;x.channel.write=()=>{writes++;throw Error('broken pipe');};assert.throws(()=>x.dispatch.start());assert.equal(writes,1);assert.equal(x.channel.aborts,1);assert.equal(x.state(x.r).attempt.state,'unknown');assert.equal(JSON.parse(x.state(x.r).hold.data).state,'unknown');assert.throws(()=>x.dispatch.start());
});
test('identity drift after acquisition prevents the write and keeps uncertainty',async t=>{
 const x=await fixture(t);let n=0;x.channel.identity=()=>({...x.identity,sessionId:++n>=3?'0'.repeat(64):x.identity.sessionId});assert.throws(()=>x.dispatch.start());assert.equal(x.channel.writes.length,0);assert.equal(x.state(x.r).attempt.state,'unknown');
});
test('EOF without a terminal retains the subscription hold',async t=>{
 const x=await fixture(t);x.dispatch.start();x.startReply();x.channel.callbacks.closed();assert.equal(x.state(x.r).attempt.state,'unknown');assert.equal(JSON.parse(x.state(x.r).hold.data).state,'unknown');
});
test('Home cancellation writes a single interrupt and only a terminal observation confirms stop',async t=>{
 const x=await fixture(t);x.dispatch.start();x.startReply();x.dispatch.requestStop();x.dispatch.maintain();assert.equal(x.channel.writes.length,2);assert.equal(x.channel.writes[1].method,'turn/interrupt');x.frame({id:`interrupt:${x.r.attempt.id}`,result:{}});assert.equal(x.state(x.r).attempt.cancellation,'requested');x.end('interrupted');x.channel.callbacks.closed();assert.equal(x.state(x.r).attempt.cancellation,'observed');assert.equal(JSON.parse(x.state(x.r).hold.data).state,'resolved');
});
test('deadline requests stop and OS abort without claiming cancellation was observed',async t=>{
 const x=await fixture(t);x.dispatch.start();x.startReply();x.f.now=new Date(x.f.now.getTime()+10001);x.dispatch.maintain();assert.equal(x.channel.aborts,1);assert.equal(x.channel.writes[1].method,'turn/interrupt');assert.equal(x.state(x.r).attempt.state,'unknown');assert.equal(x.state(x.r).attempt.cancellation,'requested');assert.equal(JSON.parse(x.state(x.r).hold.data).state,'unknown');
});
test('foreign thread or malformed frames quarantine the reply and abort the owned channel',async t=>{
 const x=await fixture(t);x.dispatch.start();x.frame({method:'turn/completed',params:{threadId:'foreign',turn:{id:'turn',status:'completed',items:[]}}});assert.equal(x.state(x.r).attempt.state,'unknown');assert.equal(x.channel.aborts,1);assert.equal(JSON.parse(x.state(x.r).hold.data).state,'unknown');
});
test('a truncated frame at EOF cannot release the hold',async t=>{
 const x=await fixture(t);x.dispatch.start();x.channel.callbacks.data(Buffer.from('{"id":'));x.channel.callbacks.closed();assert.equal(x.state(x.r).attempt.state,'unknown');assert.equal(JSON.parse(x.state(x.r).hold.data).state,'unknown');
});
