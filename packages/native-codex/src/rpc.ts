import { strictJson } from '../../contracts/src/wire.js';
import { CodexFrameStream } from './stream.js';

export interface CodexWire {
  write(bytes:Uint8Array):void;
  end():void;
  abort():void;
}
type Method='initialize'|'account/read'|'config/read'|'experimentalFeature/list'|'thread/start'|'turn/start'|'turn/interrupt';
const methods=new Set<Method>(['initialize','account/read','config/read','experimentalFeature/list','thread/start','turn/start','turn/interrupt']);
interface Pending { resolve:(value:unknown)=>void; reject:(reason:Error)=>void; timer:ReturnType<typeof setTimeout> }
/** Trusted host transport only. No credentials, process creation, admission, retry or fallback. */
export class CodexRpcPort {
  #pending=new Map<number,Pending>(); #next=1; #closed=false; #ending=false; #failure:string|null=null;
  #initialized=false;
  readonly #frames:CodexFrameStream;
  constructor(readonly wire:CodexWire,readonly onNotification:(frame:Record<string,unknown>)=>void,readonly timeoutMs=15000){
    if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>15000)throw Error('CODEX_RPC_TIMEOUT_INVALID');
    this.#frames=new CodexFrameStream(bytes=>this.#accept(bytes),()=>{},()=>this.fail('CODEX_RPC_STREAM_INVALID'));
  }
  get failure():string|null{return this.#failure;}
  get closed():boolean{return this.#closed;}
  get pendingCount():number{return this.#pending.size;}
  #bytes(frame:object):Uint8Array{
    const text=JSON.stringify(frame);if(Buffer.byteLength(text)>65536)throw Error('CODEX_RPC_REQUEST_LIMIT');
    return Buffer.from(text+'\n');
  }
  initialized():void{
    if(this.#closed||this.#ending||this.#failure||this.#initialized)throw Error('CODEX_RPC_UNAVAILABLE');
    this.#initialized=true;
    try{this.wire.write(this.#bytes({method:'initialized',params:{}}));}catch{this.fail('CODEX_RPC_WRITE_FAILED');throw Error('CODEX_RPC_WRITE_FAILED');}
  }
  request(method:Method,params:object):Promise<unknown>{
    if(this.#closed||this.#ending||this.#failure)throw Error('CODEX_RPC_UNAVAILABLE');
    if(!methods.has(method))throw Error('CODEX_RPC_METHOD_DENIED');
    if(this.#pending.size>=4||this.#next>32)throw Error('CODEX_RPC_REQUEST_LIMIT');
    const id=this.#next,bytes=this.#bytes({id,method,params});this.#next++;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>this.fail('CODEX_RPC_TIMEOUT'),this.timeoutMs);
      this.#pending.set(id,{resolve,reject,timer});
      try{this.wire.write(bytes);}catch{this.fail('CODEX_RPC_WRITE_FAILED');}
    });
  }
  #accept(bytes:Uint8Array):void{
    const parsed=strictJson(bytes);if(!parsed.ok)throw Error('CODEX_RPC_INVALID');
    const value=parsed.value;
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error('CODEX_RPC_INVALID');
    const frame=value as Record<string,unknown>;
    if('method' in frame){
      if('id' in frame||typeof frame.method!=='string')throw Error('CODEX_RPC_SERVER_REQUEST');
      this.onNotification(frame);return;
    }
    if(typeof frame.id!=='number'||!Number.isSafeInteger(frame.id))throw Error('CODEX_RPC_UNBOUND_REPLY');
    const pending=this.#pending.get(frame.id);if(!pending)throw Error('CODEX_RPC_UNBOUND_REPLY');
    const hasResult=Object.hasOwn(frame,'result'),hasError=Object.hasOwn(frame,'error');
    if(hasResult===hasError)throw Error('CODEX_RPC_INVALID_REPLY');
    // Keep the waiter registered until the whole envelope is valid.
    if(hasError){
      const e=frame.error;if(!e||typeof e!=='object'||Array.isArray(e)||!Number.isSafeInteger((e as Record<string,unknown>).code))throw Error('CODEX_RPC_INVALID_ERROR');
    }
    clearTimeout(pending.timer);this.#pending.delete(frame.id);
    if(hasError)pending.reject(Error('CODEX_RPC_REMOTE_ERROR'));else pending.resolve(frame.result);
  }
  push(bytes:Uint8Array):void{
    if(this.#closed||this.#failure)throw Error('CODEX_RPC_UNAVAILABLE');
    this.#frames.push(bytes);
  }
  finish():void{
    if(this.#closed)return;
    try{this.#frames.finish();}finally{
      this.#closed=true;
      if(this.#pending.size)this.fail('CODEX_RPC_CLOSED_WITH_PENDING');
    }
  }
  end():void{
    if(this.#ending||this.#closed)return;this.#ending=true;
    try{this.wire.end();}catch{this.fail('CODEX_RPC_END_FAILED');}
  }
  fail(code:'CODEX_RPC_STREAM_INVALID'|'CODEX_RPC_TIMEOUT'|'CODEX_RPC_WRITE_FAILED'|'CODEX_RPC_CLOSED_WITH_PENDING'|'CODEX_RPC_END_FAILED'|'CODEX_RPC_PROCESS_FAILED'):void{
    if(this.#failure)return;this.#failure=code;
    for(const p of this.#pending.values()){clearTimeout(p.timer);p.reject(Error(code));}this.#pending.clear();
    try{this.wire.abort();}catch{ /* No success/stop inference from a broken process handle. */ }
  }
}
