import {readOpenRouterBody,isOpenRouterJson} from '../../core/src/openrouter-response.js';
import {inspectOpenRouterKeyStatus} from '../../core/src/openrouter-key-status.js';
export interface OpenRouterKeyCheckPort {withKey<T>(use:(key:string)=>Promise<T>):Promise<T>}
/** Current inference key only. Metadata is not a reservation or send capability. */
export async function checkOpenRouterKey(port:OpenRouterKeyCheckPort,fetcher:typeof fetch=fetch,clock:()=>number=Date.now,stop?:AbortSignal){
 const blocked=(reason:string)=>({keyLimitVerified:false,reason,executionAuthorized:false as const,accountCreditsVerified:false as const});
 const startedAt=clock();if(!Number.isSafeInteger(startedAt)||startedAt<0)return blocked('clock_invalid');
 const controller=new AbortController(),signal=controller.signal;
 const abort=()=>controller.abort();stop?.addEventListener('abort',abort,{once:true});
 if(stop?.aborted)abort();
 const timer=setTimeout(abort,15000);
 let detach=()=>{};
 const interrupted=new Promise<ReturnType<typeof blocked>>(done=>{
  const cancel=()=>done(blocked('metadata_interrupted'));
  signal.addEventListener('abort',cancel,{once:true});detach=()=>signal.removeEventListener('abort',cancel);
  if(signal.aborted)cancel();
 });
 try{
  if(signal.aborted)return blocked('metadata_interrupted');
  const operation=port.withKey(async key=>{
  if(signal.aborted)return blocked('metadata_unavailable');
  const response=await fetcher('https://openrouter.ai/api/v1/key',{method:'GET',redirect:'error',headers:{Authorization:`Bearer ${key}`},signal});
  if(signal.aborted){void response.body?.cancel().catch(()=>{});return blocked('metadata_interrupted');}
  if(response.status!==200||!isOpenRouterJson(response.headers.get('content-type'))){
   void response.body?.cancel().catch(()=>{});
   return blocked(response.status===401?'authentication_rejected':response.status!==200?'metadata_http_failure':'metadata_content_type');
  }
  if(!response.body)return blocked('metadata_missing');
  const bytes=await readOpenRouterBody(response.body,signal,65536),now=clock();
  if(signal.aborted)return blocked('metadata_interrupted');
  if(!Number.isSafeInteger(now)||now<startedAt||now-startedAt>=15000)return blocked('metadata_stale');
  return inspectOpenRouterKeyStatus(bytes,'10',now);
  });
  return await Promise.race([operation,interrupted]);
 }catch{return blocked('metadata_unavailable');}
 finally{clearTimeout(timer);detach();stop?.removeEventListener('abort',abort);controller.abort();}
}
