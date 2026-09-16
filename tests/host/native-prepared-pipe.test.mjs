import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {NativePipeConnection} from '../../dist/host/src/native-pipe.js';
import {NativeSessionIngress} from '../../dist/core/src/native-session-ingress.js';
import {fixture,post} from '../core/fixtures/helpers.mjs';
import {preparationFixture} from './fixtures/native-preparation.mjs';
const windows={skip:process.platform!=='win32',timeout:15000};
async function prepare(t,mutate=()=>{}){
 const sessionId=randomBytes(32).toString('hex'),sockets=[];
 const {stdout}=await promisify(execFile)('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-Command',`(Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().Ticks`],{windowsHide:true,timeout:5000});
 const expected={sessionId,processId:process.pid,processStartTicks:stdout.trim(),accountRoute:'test-only-account',profileDigest:'a'.repeat(64),model:'gpt-6-astra',effort:'low',helperSourceDigest:'b'.repeat(64),vmId:'12345678-1234-1234-1234-123456789abc',runnerDigest:'c'.repeat(64),cliDigest:'d'.repeat(64)};
 const receipt={format:'native_preparation_v1',mode:'provider',stage:'ready',sessionId,threadId:'test-only-thread',accountRoute:expected.accountRoute,profileDigest:expected.profileDigest,model:expected.model,effort:expected.effort,helper:{processId:expected.processId,startTicks:expected.processStartTicks,sourceDigest:expected.helperSourceDigest},guest:{vmId:expected.vmId,processId:456,runnerDigest:expected.runnerDigest,cliDigest:expected.cliDigest},observedAt:Date.now(),expiresAt:Date.now()+30000,closed:false,turnsSent:0,maxTurns:1,toolsEnabled:false,apiFallbackEnabled:false,purchaseOperationsEnabled:false};
 mutate(receipt,expected);let requests=0;
 const server=createServer(socket=>{
  sockets.push(socket);socket.on('error',()=>{});
  const body=Buffer.from(JSON.stringify(receipt)),head=Buffer.alloc(4);head.writeUInt32LE(body.length);socket.write(Buffer.concat([head,body]));
  let pending=Buffer.alloc(0);socket.on('data',bytes=>{pending=Buffer.concat([pending,bytes]);while(pending.length>=4&&pending.length>=4+pending.readUInt32LE(0)){
   const n=pending.readUInt32LE(0),r=JSON.parse(pending.subarray(4,4+n));pending=pending.subarray(4+n);requests++;
   const b=Buffer.from(JSON.stringify({sessionId,sequence:r.sequence,frames:[],closed:r.operation==='end',processExitObserved:r.operation==='end'})),h=Buffer.alloc(4);h.writeUInt32LE(b.length);socket.write(Buffer.concat([h,b]));
  }});
 });
 server.listen('\\\\.\\pipe\\OrgManage-Native-'+sessionId);await once(server,'listening');t.after(()=>{for(const s of sockets)s.destroy();server.close();});
 return {expected,receipt,requests:()=>requests};
}
async function close(connection){const done=connection.child.exitCode===null?once(connection.child,'close'):Promise.resolve();connection.disconnect();await done;}

test('raw guest envelope is projected after actual pipe peer verification and reaches Core',windows,async t=>{
 const x=await prepare(t,(receipt,expected)=>{
  const f=preparationFixture();Object.assign(expected,{profileDigest:f.binding.profileDigest,runnerDigest:f.binding.runnerDigest,cliDigest:f.binding.cliDigest,vmId:f.binding.vmId});
  for(const key of Object.keys(receipt))delete receipt[key];
  Object.assign(receipt,{format:'native_guest_preparation_envelope_v1',raw:f.raw,live:f.live});
 });
 const connection=await NativePipeConnection.openPrepared(x.expected);t.after(()=>close(connection));
 assert.equal(connection.preparation().threadId,'test-only-thread');assert.equal(connection.preparation().toolsEnabled,false);
 const f=await fixture(t);f.now=new Date();const mission=post(f).mission;
 const version=new NativeSessionIngress(f.store).import(f.principal,f.actor,mission.id,connection);
 assert.equal(f.store.read(tx=>JSON.parse(tx.getRecordVersion(f.principal,version).data)).sessionId,x.expected.sessionId);
 const account=connection.subscriptionObservation();
 assert.equal(account.sessionId,x.expected.sessionId);assert.equal(account.creditBalance,'0');
 assert.equal(account.expiresAt,Math.min(connection.preparation().expiresAt,account.creditObservedAt+300000));
 account.plan='tampered';assert.notEqual(connection.subscriptionObservation().plan,'tampered');
 assert.equal(x.requests(),0);
 await connection.exchange({sessionId:x.expected.sessionId,sequence:1,operation:'end'});
 assert.throws(()=>connection.subscriptionObservation());
});
for(const [name,change] of [['closed',e=>e.live.processExitObserved=true],['extra secret',e=>e.token='refuse'],['unfixed profile',e=>e.live.profilePinned=false]])test(`raw pipe envelope rejects ${name}`,windows,async t=>{
 const x=await prepare(t,(receipt,expected)=>{const f=preparationFixture();Object.assign(expected,{profileDigest:f.binding.profileDigest,runnerDigest:f.binding.runnerDigest,cliDigest:f.binding.cliDigest,vmId:f.binding.vmId});for(const k of Object.keys(receipt))delete receipt[k];Object.assign(receipt,{format:'native_guest_preparation_envelope_v1',raw:f.raw,live:f.live});change(receipt);});
 await assert.rejects(NativePipeConnection.openPrepared(x.expected));assert.equal(x.requests(),0);
});
test('real Windows pipe preparation reaches Core atomically on the same verified connection',windows,async t=>{
 const x=await prepare(t),connection=await NativePipeConnection.openPrepared(x.expected);t.after(()=>close(connection));assert.deepEqual(connection.preparation(),x.receipt);
 assert.throws(()=>connection.subscriptionObservation()); // Legacy preparation cannot invent account facts.
 const copy=connection.preparation();copy.helper.processId=99;assert.equal(connection.preparation().helper.processId,process.pid);
 const f=await fixture(t);f.now=new Date();const mission=post(f).mission;
 const version=new NativeSessionIngress(f.store).import(f.principal,f.actor,mission.id,connection);
 const stored=f.store.read(tx=>JSON.parse(tx.getRecordVersion(f.principal,version).data));assert.equal(stored.sessionId,x.expected.sessionId);assert.equal(stored.threadId,x.receipt.threadId);assert.equal(x.requests(),0);
 await connection.exchange({sessionId:x.expected.sessionId,sequence:1,operation:'write',frame:'{}'});assert.throws(()=>connection.preparation());assert.equal(x.requests(),1);
 await close(connection);assert.throws(()=>connection.preparation());assert.equal(connection.child.exitCode,0);
});
for(const [name,mutate] of [
 ['wrong helper generation',r=>r.helper.startTicks='100000000000000000'],['wrong VM',r=>r.guest.vmId='22345678-1234-1234-1234-123456789abc'],
 ['wrong runner',r=>r.guest.runnerDigest='f'.repeat(64)],['wrong CLI',r=>r.guest.cliDigest='f'.repeat(64)],['wrong helper source',r=>r.helper.sourceDigest='f'.repeat(64)],
 ['wrong route',r=>r.accountRoute='other'],['wrong model',r=>r.model='other'],['wrong effort',r=>r.effort='high'],['extra secret field',r=>r.token='refuse-before-store']
])test(`prepared pipe rejects ${name} before any request`,windows,async t=>{const x=await prepare(t,mutate);await assert.rejects(NativePipeConnection.openPrepared(x.expected));assert.equal(x.requests(),0);});
test('explicit end invalidates preparation without claiming a turn was sent',windows,async t=>{
 const x=await prepare(t),connection=await NativePipeConnection.openPrepared(x.expected);t.after(()=>close(connection));
 await connection.exchange({sessionId:x.expected.sessionId,sequence:1,operation:'end'});assert.throws(()=>connection.preparation());assert.equal(x.requests(),1);
});
