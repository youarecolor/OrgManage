/** Standard orchestration contains no native harness, shell, credential lookup or
 * provider-specific API. Trusted adapters must enforce the existing Core guards. */
export interface ExecutorPolicy {
  maxSteps:number; maxInputBytes:number; maxOutputBytes:number; deadlineMs:number;
  tools:readonly string[];
}
export type ModelStep={kind:'final';text:string}|{kind:'tool';name:string;arguments:unknown};
export interface ExecutorPort {
  /** Atomically acquire current Core guards and durably record send intent before
   * returning. A previous unknown effect must refuse here, including after restart. */
  acquire(kind:'model'|'tool',input:unknown):string;
  model(input:readonly unknown[],signal:AbortSignal):Promise<ModelStep>;
  tool(name:string,args:unknown,signal:AbortSignal):Promise<unknown>;
  observe(effectId:string,state:'completed'|'unknown',output:unknown):void;
}
export type ExecutorResult={state:'completed';text:string;steps:number}|{state:'stopped'|'unknown'|'limit';reason:string;steps:number};
function bytes(value:unknown):number{const s=JSON.stringify(value);if(s===undefined)throw Error('EXECUTOR_JSON_REQUIRED');return Buffer.byteLength(s,'utf8');}
function positive(n:number,max:number){if(!Number.isSafeInteger(n)||n<1||n>max)throw Error('EXECUTOR_LIMIT_INVALID');}

export class StandardExecutor {
  readonly #policy:ExecutorPolicy;
  constructor(readonly port:ExecutorPort,policy:ExecutorPolicy){
    positive(policy.maxSteps,32);positive(policy.maxInputBytes,1048576);positive(policy.maxOutputBytes,1048576);positive(policy.deadlineMs,300000);
    if(policy.tools.length>32||new Set(policy.tools).size!==policy.tools.length||!policy.tools.every(t=>/^[a-z][a-z0-9_.-]{0,63}$/.test(t)))throw Error('EXECUTOR_TOOL_INVALID');
    this.#policy=Object.freeze({...policy,tools:Object.freeze([...policy.tools])});
  }
  async run(original:string,stop:AbortSignal):Promise<ExecutorResult>{
    const p=this.#policy;if(typeof original!=='string'||bytes(original)>p.maxInputBytes)throw Error('EXECUTOR_INPUT_LIMIT');
    const controller=new AbortController(),expiresAt=performance.now()+p.deadlineMs,deadline=setTimeout(()=>controller.abort('deadline'),p.deadlineMs);
    // Synchronous ledger work can delay timer delivery. Check elapsed monotonic
    // time as well, so expiry during acquisition cannot start the next effect.
    const expired=()=>{if(performance.now()>=expiresAt)controller.abort('deadline');return controller.signal.aborted;};
    const abort=()=>controller.abort('requested');stop.addEventListener('abort',abort,{once:true});if(stop.aborted)abort();
    const transcript:unknown[]=[{role:'user',text:original}];let steps=0,effect:string|null=null;
    // Race observation against cancellation; adapters must still observe actual
    // process/network termination. Abort is never reported as observed cancellation.
    const wait=<T>(promise:Promise<T>):Promise<T>=>new Promise((resolve,reject)=>{
      const onAbort=()=>reject(Error('EXECUTOR_ABORTED'));
      if(controller.signal.aborted){promise.catch(()=>{});reject(Error('EXECUTOR_ABORTED'));return;}
      controller.signal.addEventListener('abort',onAbort,{once:true});
      promise.then(resolve,reject).finally(()=>controller.signal.removeEventListener('abort',onAbort)).catch(()=>{});
    });
    try{
      for(;steps<p.maxSteps;){
        if(expired())return {state:'stopped',reason:'no_new_effect_after_stop',steps};
        if(bytes(transcript)>p.maxInputBytes)return {state:'limit',reason:'context_limit',steps};
        // The guard/receipt ports are synchronous Core transactions, not network
        // operations; only model/tool adapters may wait for external responses.
        effect=this.port.acquire('model',structuredClone(transcript));
        if(expired()){await this.port.observe(effect,'unknown',{reason:'stop_after_acquire'});effect=null;return {state:'unknown',reason:'stop_after_acquire',steps};}
        steps++;
        const reply=structuredClone(await wait(this.port.model(structuredClone(transcript),controller.signal)));
        if(bytes(reply)>p.maxOutputBytes)throw Error('EXECUTOR_OUTPUT_LIMIT');
        if(!reply||typeof reply!=='object')throw Error('EXECUTOR_REPLY_INVALID');
        if(reply.kind==='final'){
          if(typeof reply.text!=='string'||Object.keys(reply).sort().join(',')!=='kind,text')throw Error('EXECUTOR_REPLY_INVALID');
          await this.port.observe(effect,'completed',structuredClone(reply));effect=null;return {state:'completed',text:reply.text,steps};
        }
        if(reply.kind!=='tool'||Object.keys(reply).sort().join(',')!=='arguments,kind,name'||!p.tools.includes(reply.name))throw Error('EXECUTOR_TOOL_DENIED');
        await this.port.observe(effect,'completed',structuredClone(reply));effect=null;
        if(expired())return {state:'stopped',reason:'no_tool_after_stop',steps};
        if(steps>=p.maxSteps)return {state:'limit',reason:'step_limit_before_tool',steps};
        effect=this.port.acquire('tool',structuredClone(reply));
        if(expired()){await this.port.observe(effect,'unknown',{reason:'stop_after_acquire'});effect=null;return {state:'unknown',reason:'stop_after_acquire',steps};}
        steps++;const output=structuredClone(await wait(this.port.tool(reply.name,structuredClone(reply.arguments),controller.signal)));
        if(bytes(output)>p.maxOutputBytes)throw Error('EXECUTOR_OUTPUT_LIMIT');
        await this.port.observe(effect,'completed',structuredClone(output));effect=null;transcript.push(reply,{role:'tool',name:reply.name,output});
      }
      return {state:'limit',reason:'step_limit',steps};
    }catch(error){
      if(effect!==null)await this.port.observe(effect,'unknown',{reason:'unresolved_effect'});
      return {state:'unknown',reason:error instanceof Error&&/^EXECUTOR_[A-Z_]+$/.test(error.message)?error.message:'executor_failure',steps};
    }finally{clearTimeout(deadline);stop.removeEventListener('abort',abort);}
  }
}
