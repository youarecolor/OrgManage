import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {nativeSubscription} from '../core/fixtures/native-subscription.mjs';
import {committed} from '../core/fixtures/helpers.mjs';
import {recoverNativeJournal} from '../../dist/host/src/native-journal-recovery.js';
const hash=s=>createHash('sha256').update(s).digest('hex');
async function fixture(t,conflict=false){
 const x=await nativeSubscription(t,{},undefined,'provider'),r=x.prepare();committed(x.decide(r));const wire=x.send(r);
 x.f.core.codex.transportLost(x.f.principal,r.attempt.id);
 const preparation=x.f.store.read(tx=>JSON.parse(tx.getRecordVersion(x.f.principal,x.sessionValue.preparationVersion).data));
 const terminal=text=>({method:'turn/completed',params:{threadId:x.request.threadId,turn:{id:'fixed-turn',status:'completed',items:[{id:'answer',type:'agentMessage',text}]}}});
 const frames=[['outbound',wire.request],['inbound',{id:wire.request.id,result:{turn:{id:'fixed-turn',status:'inProgress'}}}],['inbound',terminal('recovered answer')]];
 if(conflict)frames.push(['inbound',terminal('conflicting answer')]);
 let head='0'.repeat(64);const lines=frames.map(([kind,frame],i)=>{const encoded=Buffer.from(JSON.stringify(frame)).toString('base64'),previous=head;head=hash(`${kind}\n${i+1}\n${head}\n${encoded}`);return JSON.stringify({version:1,index:i+1,kind,previous,digest:head,frameBase64:encoded})+'\n';});
 const journal=Buffer.from(lines.join('')),source={preparation,journal,seal:{count:frames.length,headDigest:head,length:journal.length,sha256:hash(journal)},processExitObserved:true};
 const run=()=>recoverNativeJournal(x.f.core.codex,x.f.principal,x.f.actor,r.attempt.id,{read:()=>source});
 return {...x,r,source,run};
}
test('sealed journal recovers only its original acquired Attempt without resend',async t=>{
 const x=await fixture(t);const result=x.run();assert.equal(result.replayed,true);assert.equal(result.state,'completed');assert.equal(x.state(x.r).attempt.state,'completed');
 assert.equal(x.f.store.read(tx=>tx.native.listAttempts(x.f.principal).length),1);
 assert.equal(JSON.parse(x.state(x.r).hold.data).state,'send_acquired'); // Recovery does not silently release accounting.
 assert.equal(x.run().state,'completed');
});
test('unsealed or live-writer recovery preserves unknown',async t=>{
 for(const change of [s=>delete s.seal,s=>s.processExitObserved=false]){const x=await fixture(t);change(x.source);assert.equal(x.run().replayed,false);assert.equal(x.state(x.r).attempt.state,'unknown');}
});
test('terminal followed by conflicting tail rolls back the entire replay',async t=>{
 const x=await fixture(t,true);assert.throws(()=>x.run());assert.equal(x.state(x.r).attempt.state,'unknown');
 assert.equal(x.f.store.read(tx=>tx.native.events(x.f.principal,x.r.attempt.id).filter(e=>e.eventKey==='terminal').length),0);
});
test('foreign original preparation is rejected',async t=>{
 const x=await fixture(t);x.source.preparation.threadId='foreign';assert.throws(()=>x.run());assert.equal(x.state(x.r).attempt.state,'unknown');
});
