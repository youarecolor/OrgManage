import {createHash} from 'node:crypto';
import {StandardExecutor,type ExecutorPolicy} from '../../core/src/standard-executor.js';
import {prepareOpenRouterRequest,type OpenRouterPolicy} from '../../core/src/openrouter-policy.js';
import type {OpenRouterResponseExpectation} from '../../core/src/openrouter-response.js';
import {OpenRouterTransport,type OpenRouterDispatchPorts} from './openrouter-transport.js';

export interface OpenRouterExecutorPorts extends OpenRouterDispatchPorts {
 /** Recheck the already acquired effect and exact request at the wire boundary.
  * This must not create another send, renew a permit, or release an unknown hold. */
 confirmAcquired(effectId:string,requestDigest:string):void;
 /** Executor progress is separate from the provider observation and its costs. */
 progress(effectId:string,state:'completed'|'unknown',output:unknown):void;
}

/** Text candidate generation through the standard loop. No native runtime or
 * candidate execution. Tool-enabled/multi-turn API work requires a separate
 * transcript contract; it cannot silently use this single-request adapter. */
export class OpenRouterTextExecutor {
 #used=false;
 readonly #policy:OpenRouterPolicy;
 readonly #expected:OpenRouterResponseExpectation;
 readonly #limits:ExecutorPolicy;
 constructor(readonly ports:OpenRouterExecutorPorts,policy:OpenRouterPolicy,expected:OpenRouterResponseExpectation,limits:ExecutorPolicy,readonly fetcher:typeof fetch=fetch){
  if(limits.maxSteps!==1||limits.tools.length!==0)throw Error('OPENROUTER_TEXT_SCOPE');
  this.#policy=structuredClone(policy);this.#expected=structuredClone(expected);this.#limits=structuredClone(limits);
 }
 async run(original:string,stop:AbortSignal){
  if(this.#used)throw Error('OPENROUTER_EXECUTOR_CONSUMED');this.#used=true;
  const request=prepareOpenRouterRequest(this.#policy,original);
  const requestDigest=createHash('sha256').update(JSON.stringify(request.body)).digest('hex');
  let acquired:string|null=null,wireEntered=false;
  const transcript=JSON.stringify([{role:'user',text:original}]);
  const transport=new OpenRouterTransport({
   acquire:d=>{
    if(acquired===null||wireEntered||d!==requestDigest)throw Error('OPENROUTER_EFFECT_BINDING');
    wireEntered=true;this.ports.confirmAcquired(acquired,d);return acquired;
   },
   withKey:cb=>this.ports.withKey(cb),
   journal:(id,status,bytes,mime)=>this.ports.journal(id,status,bytes,mime),
   observe:(id,result)=>this.ports.observe(id,result),
  },this.fetcher);
  const executor=new StandardExecutor({
   acquire:(kind,input)=>{
    if(kind!=='model'||acquired!==null||JSON.stringify(input)!==transcript)throw Error('OPENROUTER_TEXT_SCOPE');
    const id=this.ports.acquire(requestDigest);
    if(typeof id!=='string'||!id)throw Error('OPENROUTER_EFFECT_BINDING');
    acquired=id;return id;
   },
   model:async(input,signal)=>{
    if(JSON.stringify(input)!==transcript)throw Error('OPENROUTER_TEXT_SCOPE');
    const result=await transport.send(this.#policy,original,this.#expected,signal,Math.min(this.#limits.deadlineMs,120000));
    if(result.state!=='observed'||result.observation.outputState!=='completed'||result.observation.text===null)throw Error('EXECUTOR_PROVIDER_UNRESOLVED');
    return {kind:'final',text:result.observation.text};
   },
   tool:async()=>{throw Error('EXECUTOR_TOOL_DENIED');},
   observe:(id,state,output)=>this.ports.progress(id,state,output),
  },this.#limits);
  return executor.run(original,stop);
 }
}
