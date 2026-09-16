import {randomUUID} from 'node:crypto';
import canonicalize from 'canonicalize';
import type {CodexTurnCoordinator} from './codex-turn.js';
import type {CodexFrameStream} from '../../native-codex/src/stream.js';

export interface NativeChannelIdentity {
 sessionId:string;threadId:string;accountRoute:string;profileDigest:string;model:string;effort:string;
}
/** Protected host adapter, never supplied by a renderer or candidate. bind must
 * exclusively claim an already prepared connection. close only reports observed
 * transport closure, not provider cancellation. abort requests bounded OS cleanup. */
export interface NativeProviderChannel {
 identity():Readonly<NativeChannelIdentity>;
 bind(callbacks:{data:(bytes:Uint8Array)=>void;closed:()=>void;fault:()=>void}):void;
 write(bytes:Uint8Array):void;
 end():void;
 abort():void;
}
type Guards=Parameters<CodexTurnCoordinator['acquireProviderStartWithSubscription']>[2];
const terminal=(state:string)=>['completed','failed','interrupted'].includes(state);
function check(v:unknown):asserts v{if(!v)throw Error('NATIVE_DISPATCH_DENIED');}

/** One channel, one acquired Attempt, no retry or fallback. Session facts and
 * qualification must come from independently checked real adapter observations.
 * Timers here supplement, never replace, the adapter's independent OS deadline. */
export class NativeProviderDispatch {
 #used=false;#acquired=false;#closed=false;#failed=false;#ending=false;#interrupt=false;
 #stream:CodexFrameStream|undefined;#identity:NativeChannelIdentity|undefined;
 #deadline=0;#timer:ReturnType<typeof setInterval>|undefined;
 constructor(readonly core:CodexTurnCoordinator,readonly principalId:string,readonly attemptId:string,readonly guards:Guards,readonly channel:NativeProviderChannel){}
 #attempt(){return this.core.store.read(tx=>{const a=tx.native.getAttempt(this.principalId,this.attemptId);check(a);return a;});}
 #bound(){
  const a=this.#attempt(),b=JSON.parse(a.binding);check(b.mode==='provider'&&b.providerSessionVersion);
  const session=this.core.store.read(tx=>tx.getRecordVersion(this.principalId,b.providerSessionVersion));check(session?.kind==='evidence');const s=JSON.parse(session.data);
  const identity={sessionId:s.sessionId,threadId:a.threadId,accountRoute:b.accountRoute,profileDigest:b.profileDigest,model:b.model,effort:b.effort};
  check(canonicalize(this.channel.identity())===canonicalize(identity));
  if(this.#identity)check(canonicalize(this.#identity)===canonicalize(identity));
  return identity as NativeChannelIdentity;
 }
 start():void{
  check(!this.#used);this.#used=true;this.#identity=this.#bound();
  try{
   this.channel.bind({data:bytes=>this.#data(bytes),closed:()=>this.#close(),fault:()=>this.#fault()});
   check(!this.#closed&&!this.#failed);this.#bound();
   const wire=this.core.acquireProviderStartWithSubscription(this.principalId,this.attemptId,this.guards);this.#acquired=true;check(wire.kind==='provider');
   this.#stream=this.core.openStream(this.principalId,this.attemptId);
   const hold=this.core.store.read(tx=>tx.getRecord(this.principalId,this.guards.holdId));check(hold?.kind==='resource_hold');const h=JSON.parse(hold.data);
   check(Number.isSafeInteger(h.maxDurationMs)&&h.maxDurationMs>0&&h.maxDurationMs<=180000);
   this.#deadline=this.core.clock()+h.maxDurationMs;
   this.#timer=setInterval(()=>{try{this.maintain();}catch{this.#fault();}},250);this.#timer.unref();
   this.#bound();this.channel.write(Buffer.from(JSON.stringify(wire.request)+'\n'));
  }catch(error){this.#fault();throw error;}
 }
 #data(bytes:Uint8Array):void{
  if(this.#closed)return;
  try{check(this.#acquired&&this.#stream);this.#bound();this.#stream.push(bytes);
   const a=this.#attempt();if(terminal(a.state)&&!this.#ending){this.#ending=true;this.channel.end();}
  }catch{this.#fault();}
 }
 #hold(status:'unknown'|'resolved'):void{
  if(!this.#acquired)return;
  const a=this.#attempt(),p=this.principalId;
  const version=this.core.store.transaction(tx=>{
   const id=randomUUID();tx.insertRecord({principalId:p,id,kind:'evidence',revision:1n,data:JSON.stringify({format:'native_channel_observation_v1',attemptId:a.id,runId:a.runId,session:this.#identity,state:a.state,channelClosed:this.#closed,faulted:this.#failed,observedAt:this.core.clock(),events:tx.native.events(p,a.id).map(e=>({key:e.eventKey,digest:e.digest}))})});return tx.getRecord(p,id)!.versionId;
  });
  this.guards.subscription.observe(p,this.guards.holdId,status,version);
 }
 #close():void{
  if(this.#closed)return;this.#closed=true;clearInterval(this.#timer);
  if(!this.#acquired)return;
  try{this.#stream?.finish();this.#hold(!this.#failed&&terminal(this.#attempt().state)?'resolved':'unknown');}
  catch{this.#failed=true;this.core.transportLost(this.principalId,this.attemptId);this.#hold('unknown');}
 }
 #fault():void{
  if(this.#failed||this.#closed)return;this.#failed=true;clearInterval(this.#timer);
  try{if(this.#acquired){this.core.transportLost(this.principalId,this.attemptId);this.#hold('unknown');}}
  finally{try{this.channel.abort();}catch{/* No observed closure or cancellation is inferred. */}}
 }
 maintain():void{
  if(!this.#acquired||this.#closed||this.#failed)return;
  this.#bound();this.core.maintain();const a=this.#attempt();
  if(this.core.clock()>=this.#deadline){this.core.requestStop(this.principalId,this.attemptId);this.#sendInterrupt();this.#fault();return;}
  if(a.state==='unknown'){this.#fault();return;}
  if(a.cancellation==='requested')this.#sendInterrupt();
 }
 #sendInterrupt():void{
  if(this.#interrupt)return;const a=this.#attempt();
  if(terminal(a.state))return;
  if(!a.turnId){this.#fault();return;}
  const wire=this.core.acquireInterrupt(this.principalId,this.attemptId);check(wire.kind==='provider');this.#interrupt=true;this.#bound();this.channel.write(Buffer.from(JSON.stringify(wire.request)+'\n'));
 }
 requestStop():void{this.core.requestStop(this.principalId,this.attemptId);this.maintain();}
 get state(){return {started:this.#used,acquired:this.#acquired,channelClosed:this.#closed,faulted:this.#failed};}
}
