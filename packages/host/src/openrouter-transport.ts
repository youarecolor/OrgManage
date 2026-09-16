import {createHash} from 'node:crypto';
import {prepareOpenRouterRequest,type OpenRouterPolicy} from '../../core/src/openrouter-policy.js';
import {readOpenRouterBody,decodeOpenRouterResponse,isOpenRouterJson,type OpenRouterResponseExpectation} from '../../core/src/openrouter-response.js';

export interface OpenRouterDispatchPorts {
 /** Synchronous durable Core transaction. Must recheck policy, exact request
  * digest, disclosure, approval, budgets, owner and unresolved prior sends. */
 acquire(requestDigest:string):string;
 /** Protected key provider. Never expose the key to renderer or candidate code. */
 withKey<T>(consume:(key:string)=>Promise<T>):Promise<T>;
 /** Durable protected response journal; completes before parsing/projecting. */
 journal(effectId:string,status:number,bytes:Uint8Array,contentType:string|null):void;
 observe(effectId:string,result:ReturnType<typeof decodeOpenRouterResponse>|{outputState:'unknown';reason:string}):void;
}
/** One-shot bounded wire transport. Product entry remains unavailable until its
 * concrete Core admission and credential ports have been qualified together. */
export class OpenRouterTransport {
 #used=false;
 constructor(readonly ports:OpenRouterDispatchPorts,readonly fetcher:typeof fetch=fetch){}
 async send(policy:OpenRouterPolicy,original:string,expected:OpenRouterResponseExpectation,stop:AbortSignal,deadlineMs=30000,continuation:string|null=null){
  if(this.#used)throw Error('OPENROUTER_TRANSPORT_CONSUMED');
  if(!Number.isSafeInteger(deadlineMs)||deadlineMs<=0||deadlineMs>120000)throw Error('OPENROUTER_DEADLINE');
  const request=prepareOpenRouterRequest(policy,original,continuation),body=JSON.stringify(request.body);
  const expectation=structuredClone(expected);
  if(!expectation.models.length||!expectation.providerNames.length||expectation.models.some(m=>!policy.models.includes(m))||(!request.body.plugins&& (expectation.models.length!==1||expectation.models[0]!==request.body.model)))throw Error('OPENROUTER_EXPECTATION');
  if(stop.aborted)return {state:'not_sent' as const};
  this.#used=true;
  const controller=new AbortController(),abort=()=>controller.abort();stop.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(abort,deadlineMs);let effect:string|null=null;
  const wait=<T>(promise:Promise<T>)=>new Promise<T>((resolve,reject)=>{
   const cancelled=()=>reject(Error('OPENROUTER_ABORTED'));
   if(controller.signal.aborted){promise.catch(()=>{});cancelled();return;}
   controller.signal.addEventListener('abort',cancelled,{once:true});
   promise.then(resolve,reject).finally(()=>controller.signal.removeEventListener('abort',cancelled)).catch(()=>{});
  });
  try{
   effect=this.ports.acquire(createHash('sha256').update(body).digest('hex'));
   if(typeof effect!=='string'||effect.length===0)throw Error('OPENROUTER_PERMIT');
   const observation=await wait(this.ports.withKey(async key=>{
    if(controller.signal.aborted)throw Error('OPENROUTER_ABORTED');
    if(typeof key!=='string'||key.length<16||key.length>512||!/^[\x21-\x7e]+$/.test(key))throw Error('OPENROUTER_KEY');
    const response=await this.fetcher(request.endpoint,{method:'POST',redirect:'error',credentials:'omit',cache:'no-store',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body,signal:controller.signal});
    if(controller.signal.aborted){void response.body?.cancel().catch(()=>{});throw Error('OPENROUTER_ABORTED');}
    if(!response.body)throw Error('OPENROUTER_NO_BODY');
    const bytes=await readOpenRouterBody(response.body,controller.signal);
    const contentType=response.headers.get('content-type');
    this.ports.journal(effect!,response.status,bytes,contentType);
    if(response.status!==200||!isOpenRouterJson(contentType))throw Error('OPENROUTER_RESPONSE');
    return decodeOpenRouterResponse(bytes,expectation);
   }));
   this.ports.observe(effect,observation);return {state:'observed' as const,observation};
  }catch{
   controller.abort();
   if(effect!==null)this.ports.observe(effect,{outputState:'unknown',reason:'transport_or_observation_unresolved'});
   return {state:effect===null?'not_sent' as const:'unknown' as const};
  }finally{clearTimeout(timer);stop.removeEventListener('abort',abort);}
 }
}
