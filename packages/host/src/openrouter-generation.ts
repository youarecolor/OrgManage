import {decodeOpenRouterGeneration} from '../../core/src/openrouter-generation.js';
import type {OpenRouterRecovery} from '../../core/src/openrouter-recovery.js';
import {readOpenRouterBody,isOpenRouterJson,type OpenRouterResponseExpectation} from '../../core/src/openrouter-response.js';
export interface GenerationLookupPorts {
 /** Must resolve a previously journaled ID and its account-bound credential. */
 withKey<T>(use:(key:string)=>Promise<T>):Promise<T>;
 journal(status:number,bytes:Uint8Array,contentType:string|null):void;
}
/** Connects the GET adapter to the original Core record and its account vault. */
export async function recoverOpenRouterGeneration(recovery:OpenRouterRecovery,p:string,actor:string,intentId:string,
 withAccountKey:<T>(accountRoute:string,use:(key:string)=>Promise<T>)=>Promise<T>,fetcher:typeof fetch=fetch){
 const binding=recovery.prepare(p,actor,intentId);let evidenceId:string|null=null;
 const result=await lookupOpenRouterGeneration(binding.generationId,binding.expected,{
  withKey:use=>withAccountKey(binding.accountRoute,use),
  journal:(status,bytes,mime)=>{evidenceId=recovery.record(p,actor,binding,status,bytes,mime);},
 },fetcher);
 return {result,evidenceId};
}
/** Protected GET only. Caller must bind ID/account to the original intent.
 * No retry, generation, transcript retrieval or budget release occurs here. */
export async function lookupOpenRouterGeneration(id:string,expected:OpenRouterResponseExpectation,ports:GenerationLookupPorts,fetcher:typeof fetch=fetch){
 if(!/^gen-[A-Za-z0-9_-]{1,200}$/.test(id))throw Error('OPENROUTER_GENERATION_ID');
 const fixed=structuredClone(expected),signal=AbortSignal.timeout(15000);
 const unknown={status:'unknown' as const,outputRecovered:false as const,remoteStopObserved:false as const,settlementAuthorized:false as const};
 try{return await ports.withKey(async key=>{
  if(signal.aborted)return unknown;
  const response=await fetcher(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(id)}`,{method:'GET',redirect:'error',signal,headers:{Authorization:`Bearer ${key}`}});
  const bytes=response.body?await readOpenRouterBody(response.body,signal,65536):new Uint8Array();
  const mime=response.headers.get('content-type');ports.journal(response.status,new Uint8Array(bytes),mime);
  if(response.status!==200||!isOpenRouterJson(mime))return unknown;
  return decodeOpenRouterGeneration(bytes,id,fixed);
 });}catch{return unknown;}
}
