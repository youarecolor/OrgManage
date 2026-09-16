import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {strictJson} from '../../contracts/src/wire.js';
import type {NativeBridgeConnection} from './native-channel.js';
import {validateNativePreparation,type NativePreparationReceipt,type NativePreparedConnection} from '../../core/src/native-session-ingress.js';
import {projectNativePreparation,type NativeGuestLiveObservation} from './native-preparation.js';
import type {NativeSubscriptionObservation} from '../../core/src/native-subscription-ingress.js';

type Expected={sessionId:string;processId:number;processStartTicks:string};
export type NativePreparedExpected=Expected&{accountRoute:string;profileDigest:string;model:string;effort:string;helperSourceDigest:string;vmId:string;runnerDigest:string;cliDigest:string};
type Pending={resolve:(value:unknown)=>void;reject:(error:Error)=>void};
/** Concrete Windows pipe connection. The companion owns the actual pipe handle
 * and verifies its server PID/generation before announcing readiness. */
export class NativePipeConnection implements NativeBridgeConnection,NativePreparedConnection {
 #buffer=Buffer.alloc(0);#total=0;#stderr=0;#pending:Pending|undefined;#ready=false;#closed=false;#failed=false;
 #resolveReady!:()=>void;#rejectReady!:(error:Error)=>void;readonly ready:Promise<void>;
 #preparation:Readonly<NativePreparationReceipt>|undefined;#sent=false;
 #subscription:NativeSubscriptionObservation|undefined;
 private constructor(readonly child:ChildProcessWithoutNullStreams,readonly expected:Expected,readonly preparedExpected?:NativePreparedExpected){
  this.ready=new Promise((resolve,reject)=>{this.#resolveReady=resolve;this.#rejectReady=reject;});
  child.stdout.on('data',(bytes:Buffer)=>{try{this.#accept(bytes);}catch{this.#fail();}});
  child.stderr.on('data',(bytes:Buffer)=>{this.#stderr+=bytes.length;if(this.#stderr>65536)this.#fail();});
  child.on('error',()=>this.#fail());child.stdin.on('error',()=>this.#fail());
  child.on('close',()=>{this.#closed=true;if(!this.#ready||this.#pending||this.#buffer.length)this.#fail();});
 }
 static async open(expected:Expected):Promise<NativePipeConnection>{
  return this.#open(expected);
 }
 static async openPrepared(expected:NativePreparedExpected):Promise<NativePipeConnection>{
  return this.#open(expected,structuredClone(expected));
 }
 static async #open(expected:Expected,preparedExpected?:NativePreparedExpected):Promise<NativePipeConnection>{
  if(process.platform!=='win32'||!/^[a-f0-9]{64}$/.test(expected.sessionId)||!Number.isSafeInteger(expected.processId)||expected.processId<=0||!/^\d{16,19}$/.test(expected.processStartTicks))throw Error('NATIVE_PIPE_BINDING');
  const script=resolve(import.meta.dirname,'../../../scripts/native-pipe-client.ps1');
  if(createHash('sha256').update(await readFile(script)).digest('hex')!=='f9a00c838439f0f462b1f005f98ab1efdcfd3b8b9ce89c28970c0bb269ac6cfa')throw Error('NATIVE_PIPE_SOURCE_DRIFT');
  const env:NodeJS.ProcessEnv={};for(const key of ['SystemRoot','WINDIR','TEMP','TMP','USERPROFILE'])if(process.env[key])env[key]=process.env[key];
  const child=spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-File',script,'-ExpectedProcessId',String(expected.processId),'-ExpectedStartTicks',expected.processStartTicks,'-SessionId',expected.sessionId,...(preparedExpected?['-ReadPreparation']:[])],{windowsHide:true,env,stdio:['pipe','pipe','pipe']});
  const connection=new NativePipeConnection(child,Object.freeze({...expected}),preparedExpected);let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([connection.ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('NATIVE_PIPE_READY_TIMEOUT')),6000);})]);return connection;}
  catch(error){connection.disconnect();throw error;}finally{clearTimeout(timer);}
 }
 #accept(bytes:Buffer){
  this.#total+=bytes.length;if(this.#total>8*1024*1024)throw Error('OUTPUT_BOUND');this.#buffer=Buffer.concat([this.#buffer,bytes]);
  for(let index;(index=this.#buffer.indexOf(10))>=0;){
   if(index>262145)throw Error('FRAME_BOUND');const data=this.#buffer.subarray(0,index);this.#buffer=this.#buffer.subarray(index+1);const parsed=strictJson(data);if(!parsed.ok)throw Error('INVALID_FRAME');
   if(!this.#ready){
    const v=parsed.value as Record<string,unknown>;if(!v||v.ready!==true||v.sessionId!==this.expected.sessionId||v.processId!==this.expected.processId)throw Error('HANDSHAKE_MISMATCH');
    if(Object.keys(v).sort().join('|')!==(this.preparedExpected?'preparation|processId|ready|sessionId':'processId|ready|sessionId'))throw Error('HANDSHAKE_FIELDS');
    if(this.preparedExpected){
     const e=this.preparedExpected,wire=v.preparation as Record<string,unknown>;
     let p:Readonly<NativePreparationReceipt>;
     if(wire?.format==='native_guest_preparation_envelope_v1'){
      if(Object.keys(wire).sort().join('|')!=='format|live|raw')throw Error('PREPARATION_ENVELOPE_FIELDS');
      p=projectNativePreparation(wire.raw,e,wire.live as NativeGuestLiveObservation,Date.now());
      // projectNativePreparation already checked exact raw/credits fields and
      // all fixed source/profile facts. Keep only non-identifying account data.
      const raw=wire.raw as {plan:'plus'|'pro';creditObservedAt:number};
      this.#subscription={format:'native_subscription_observation_v1',sessionId:p.sessionId,plan:raw.plan,accountType:'chatgpt',paidCreditsAvailable:false,unlimitedCredits:false,creditBalance:'0',creditObservedAt:raw.creditObservedAt,expiresAt:Math.min(p.expiresAt,raw.creditObservedAt+300000)};
     }else p=validateNativePreparation(v.preparation as NativePreparationReceipt,Date.now());
     if(p.sessionId!==e.sessionId||p.helper.processId!==e.processId||p.helper.startTicks!==e.processStartTicks||p.helper.sourceDigest!==e.helperSourceDigest||p.guest.vmId!==e.vmId||p.guest.runnerDigest!==e.runnerDigest||p.guest.cliDigest!==e.cliDigest)throw Error('PREPARATION_PEER_MISMATCH');
     for(const k of ['accountRoute','profileDigest','model','effort'] as const)if(p[k]!==e[k])throw Error('PREPARATION_PROFILE_MISMATCH');
     this.#preparation=p;
    }else if('preparation' in v)throw Error('UNEXPECTED_PREPARATION');
    this.#ready=true;this.#resolveReady();
   }
   else{if(!this.#pending)throw Error('UNSOLICITED_FRAME');const p=this.#pending;this.#pending=undefined;p.resolve(parsed.value);}
  }
  if(this.#buffer.length>262145)throw Error('FRAME_BOUND');
 }
 #fail(){if(this.#failed)return;this.#failed=true;const error=Error('NATIVE_PIPE_FAILED');this.#rejectReady(error);this.#pending?.reject(error);this.#pending=undefined;this.disconnect();}
 exchange(request:Parameters<NativeBridgeConnection['exchange']>[0]):Promise<unknown>{
  if(!this.#ready||this.#closed||this.#failed||this.#pending||request.sessionId!==this.expected.sessionId)throw Error('NATIVE_PIPE_UNAVAILABLE');
  const data=JSON.stringify(request)+'\n';if(Buffer.byteLength(data)>32768)throw Error('NATIVE_PIPE_INPUT_BOUND');
  if(request.operation==='write'||request.operation==='end'||request.operation==='abort')this.#sent=true;
  return new Promise((resolve,reject)=>{this.#pending={resolve,reject};this.child.stdin.write(data);});
 }
 preparation():Readonly<NativePreparationReceipt>{
  if(!this.#ready||this.#closed||this.#failed||this.#sent||!this.#preparation||this.child.exitCode!==null)throw Error('NATIVE_PIPE_NOT_PREPARED');
  return validateNativePreparation(this.#preparation,Date.now());
 }
 disconnect():void{
  if(this.#closed)return;this.#closed=true;this.#pending?.reject(Error('NATIVE_PIPE_CLOSED'));this.#pending=undefined;
  this.child.stdin.end();const timer=setTimeout(()=>{if(this.child.exitCode===null&&!this.child.killed)this.child.kill();},2000);timer.unref();this.child.once('close',()=>clearTimeout(timer));
 }
 subscriptionObservation():Readonly<NativeSubscriptionObservation>{
  this.preparation();
  if(!this.#subscription||Date.now()>=this.#subscription.expiresAt)throw Error('NATIVE_PIPE_NO_SUBSCRIPTION_OBSERVATION');
  return structuredClone(this.#subscription);
 }
}
