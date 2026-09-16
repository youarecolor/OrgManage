import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeBridgeChannel} from '../../dist/host/src/native-channel.js';
const identity={sessionId:'a'.repeat(64),profileDigest:'b'.repeat(64),threadId:'thread',accountRoute:'account',model:'test',effort:'low'};
const wire=(change={})=>Buffer.from(JSON.stringify({id:'start:attempt',method:'turn/start',params:{threadId:'thread',model:'test',effort:'low',approvalPolicy:'never',environments:[],input:[{type:'text',text:'固定試験',text_elements:[]}],...change}})+'\n');
const flush=()=>new Promise(r=>setImmediate(r));
function fixture(t,handler){
 const calls=[],events=[];let disconnected=0;
 const connection={async exchange(r){calls.push(r);return handler?handler(r):{sessionId:identity.sessionId,sequence:r.sequence,frames:[],closed:r.operation==='end'||r.operation==='abort',processExitObserved:true};},disconnect(){disconnected++;}};
 const channel=new NativeBridgeChannel(identity,connection);channel.bind({data:b=>events.push(['data',Buffer.from(b).toString()]),closed:()=>events.push(['closed']),fault:()=>events.push(['fault'])});t.after(()=>channel.abort());
 return {channel,calls,events,disconnected:()=>disconnected};
}
test('channel serializes one exact write and closes after observed exit',async t=>{const x=fixture(t);x.channel.write(wire());assert.throws(()=>x.channel.write(wire()));await flush();assert.equal(x.calls[0].operation,'write');assert.equal(JSON.parse(x.calls[0].frame).params.input[0].text,'固定試験');x.channel.end();await flush();assert.equal(x.calls[1].sequence,2);assert.deepEqual(x.events,[['closed']]);});
for(const change of [{threadId:'foreign'},{model:'other'},{effort:'high'},{environments:['shell']},{approvalPolicy:'on-request'},{config:{tools:true}},{input:[{type:'text',text:'text',text_elements:[{secret:'x'}]}]}])test(`channel rejects request drift: ${JSON.stringify(change)}`,t=>{const x=fixture(t);assert.throws(()=>x.channel.write(wire(change)));assert.equal(x.calls.length,0);});
test('channel rejects reply from another session without a retry',async t=>{const x=fixture(t,r=>({sessionId:'f'.repeat(64),sequence:r.sequence,frames:[],closed:false}));x.channel.write(wire());await flush();assert.deepEqual(x.events,[['fault']]);assert.equal(x.calls.length,1);assert.equal(x.disconnected(),1);assert.throws(()=>x.channel.write(wire()));});
test('close acknowledgement without observed process exit is a fault',async t=>{const x=fixture(t,r=>({sessionId:identity.sessionId,sequence:r.sequence,frames:[],closed:true}));x.channel.end();await flush();assert.deepEqual(x.events,[['fault']]);});
test('requests remain ordered when a write is waiting and end is queued',async t=>{let reply;const x=fixture(t,r=>new Promise(resolve=>{reply=()=>resolve({sessionId:identity.sessionId,sequence:r.sequence,frames:[],closed:r.operation==='end',processExitObserved:true});}));x.channel.write(wire());x.channel.end();assert.equal(x.calls.length,1);reply();await flush();assert.equal(x.calls.length,2);assert.equal(x.calls[1].operation,'end');reply();await flush();assert.deepEqual(x.events,[['closed']]);});
test('connection failure is terminal and does not reconnect or resend',async t=>{const x=fixture(t,()=>{throw Error('broken');});x.channel.write(wire());await flush();assert.equal(x.calls.length,1);assert.deepEqual(x.events,[['fault']]);assert.equal(x.disconnected(),1);});
