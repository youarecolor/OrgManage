import type {NativeChannelIdentity,NativeProviderChannel} from '../../core/src/native-provider-dispatch.js';
import {strictJson} from '../../contracts/src/wire.js';

/** One verified Windows pipe connection. The concrete process adapter must pin
 * the helper PID/generation on that same pipe before yielding any reply. */
export interface NativeBridgeConnection {
 exchange(request:Readonly<{sessionId:string;sequence:number;operation:'write'|'poll'|'end'|'abort';frame?:string}>):Promise<unknown>;
 disconnect():void;
}
type Callbacks=Parameters<NativeProviderChannel['bind']>[0];
type Operation={operation:'write'|'poll'|'end'|'abort';frame?:string};
function check(v:unknown):asserts v{if(!v)throw Error('NATIVE_CHANNEL_DENIED');}
function object(v:unknown){check(v&&typeof v==='object'&&!Array.isArray(v));return v as Record<string,unknown>;}
function keys(v:Record<string,unknown>,names:string[]){check(Object.keys(v).sort().join('|')===names.sort().join('|'));}

/** Serial polling adapter used by NativeProviderDispatch. No re-connect,
 * credentials, arbitrary methods, model fallback or implicit resend. */
export class NativeBridgeChannel implements NativeProviderChannel {
 readonly #identity:NativeChannelIdentity;#callbacks:Callbacks|undefined;#sequence=0;#busy=false;#closed=false;#faulted=false;
 #started=false;#interrupted=false;#ending=false;#queue:Operation[]=[];#timer:ReturnType<typeof setTimeout>|undefined;#total=0;
 constructor(identity:NativeChannelIdentity,readonly connection:NativeBridgeConnection){
  check(/^[a-f0-9]{64}$/.test(identity.sessionId)&&/^[a-f0-9]{64}$/.test(identity.profileDigest));
  for(const k of ['threadId','accountRoute','model','effort'] as const)check(typeof identity[k]==='string'&&identity[k].length>0&&Buffer.byteLength(identity[k])<=256);
  this.#identity=Object.freeze({...identity});
 }
 identity(){return {...this.#identity};}
 bind(callbacks:Callbacks){check(!this.#callbacks&&!this.#closed&&!this.#faulted);this.#callbacks=callbacks;}
 write(bytes:Uint8Array):void{
  check(this.#callbacks&&!this.#closed&&!this.#faulted&&!this.#ending&&bytes.byteLength<=16384);
  const parsed=strictJson(bytes);check(parsed.ok);const frame=object(parsed.value),params=object(frame.params);
  keys(frame,['id','method','params']);check(typeof frame.id==='string'&&frame.id.length<=256&&params.threadId===this.#identity.threadId);
  if(frame.method==='turn/start'){
   keys(params,['threadId','model','effort','approvalPolicy','environments','input']);
   check(frame.id.startsWith('start:')&&!this.#started&&params.model===this.#identity.model&&params.effort===this.#identity.effort&&params.approvalPolicy==='never'&&Array.isArray(params.environments)&&params.environments.length===0);
   check(Array.isArray(params.input)&&params.input.length===1);const input=object(params.input[0]);keys(input,['type','text','text_elements']);check(input.type==='text'&&typeof input.text==='string'&&Buffer.byteLength(input.text)<=4096&&Array.isArray(input.text_elements)&&input.text_elements.length===0);
   this.#started=true;
  }else{keys(params,['threadId','turnId']);check(frame.id.startsWith('interrupt:')&&frame.method==='turn/interrupt'&&this.#started&&!this.#interrupted&&typeof params.turnId==='string'&&params.turnId.length>0&&params.turnId.length<=256);this.#interrupted=true;}
  this.#enqueue({operation:'write',frame:JSON.stringify(frame)});
 }
 end(){if(this.#closed||this.#ending||this.#faulted)return;check(this.#callbacks);this.#ending=true;this.#enqueue({operation:'end'});}
 abort(){if(this.#closed)return;clearTimeout(this.#timer);this.#ending=true;this.#queue=[{operation:'abort'}];void this.#pump();}
 #enqueue(op:Operation){check(this.#queue.length<3);clearTimeout(this.#timer);this.#queue.push(op);void this.#pump();}
 async #pump():Promise<void>{
  if(this.#busy||this.#closed||!this.#queue.length)return;
  const op=this.#queue.shift()!;this.#busy=true;const sequence=++this.#sequence;let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   check(sequence<=2048);
   const pending=this.connection.exchange({sessionId:this.#identity.sessionId,sequence,...op});
   const raw=await Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('NATIVE_CHANNEL_TIMEOUT')),12000);})]);
   const reply=object(raw);check(reply.sessionId===this.#identity.sessionId&&reply.sequence===sequence&&typeof reply.closed==='boolean'&&Array.isArray(reply.frames)&&reply.frames.length<=128);
   if(reply.closed)check(reply.frames.length===0&&reply.processExitObserved===true);
   for(const value of reply.frames){
    check(typeof value==='string'&&!value.includes('\n')&&!value.includes('\r'));const data=Buffer.from(value+'\n');this.#total+=data.byteLength;check(data.byteLength<=65537&&this.#total<=2*1024*1024);
    if(!this.#faulted)this.#callbacks!.data(data);
   }
   if(reply.closed){this.#closed=true;clearTimeout(this.#timer);this.connection.disconnect();this.#callbacks?.closed();}
  }catch{this.#faulted=true;this.#closed=true;this.#queue=[];clearTimeout(this.#timer);try{this.#callbacks?.fault();}finally{this.connection.disconnect();}}
  finally{clearTimeout(timer);this.#busy=false;}
  if(this.#closed)return;
  if(this.#queue.length){void this.#pump();return;}
  if(this.#started||this.#ending){this.#timer=setTimeout(()=>{this.#queue.push({operation:'poll'});void this.#pump();},100);this.#timer.unref();}
 }
 get state(){return {closed:this.#closed,faulted:this.#faulted,sequence:this.#sequence,queued:this.#queue.length};}
}
