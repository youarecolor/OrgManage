import {createHash} from 'node:crypto';
import {strictJson, WIRE_LIMITS} from '../../contracts/src/wire.js';

function check(ok:unknown,why:string):asserts ok{if(!ok)throw Error(`OPENROUTER_${why}`);}
function object(v:unknown):Record<string,unknown>{check(v!==null&&typeof v==='object'&&!Array.isArray(v),'RESPONSE_SHAPE');return v as Record<string,unknown>;}
function count(v:unknown):v is number{return Number.isSafeInteger(v)&&Number(v)>=0;}

/** Bounded private copy of a non-streaming HTTP body. No fetch, credentials or
 * retries. Cancellation is a local observation only, never remote-stop evidence. */
export async function readOpenRouterBody(stream:ReadableStream<Uint8Array>,signal:AbortSignal,maxBytes=262144):Promise<Uint8Array>{
  check(Number.isSafeInteger(maxBytes)&&maxBytes>0&&maxBytes<=WIRE_LIMITS.maxBytes,'RESPONSE_LIMIT');
  const reader=stream.getReader();let cancelled=false;
  let rejectAbort:(e:Error)=>void=()=>{};
  const aborted=new Promise<never>((_,reject)=>{rejectAbort=reject;});
  const cancel=()=>{if(cancelled)return;cancelled=true;void reader.cancel().catch(()=>{});rejectAbort(Error('OPENROUTER_READ_ABORTED'));};
  signal.addEventListener('abort',cancel,{once:true});
  try{
    if(signal.aborted)cancel();
    const chunks:Uint8Array[]=[];let total=0;
    for(;;){
      const part=await Promise.race([reader.read(),aborted]);
      check(!signal.aborted,'READ_ABORTED');if(part.done)break;
      check(part.value instanceof Uint8Array&&!(part.value.buffer instanceof SharedArrayBuffer),'RESPONSE_BYTES');
      total+=part.value.byteLength;check(total<=maxBytes,'RESPONSE_LIMIT');
      chunks.push(new Uint8Array(part.value));
    }
    const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
  }catch(error){void reader.cancel().catch(()=>{});throw error;}
  finally{signal.removeEventListener('abort',cancel);reader.releaseLock();}
}

export interface OpenRouterResponseExpectation {
  models:readonly string[];
  /** Exact response display names observed for qualified endpoint slugs. */
  providerNames:readonly string[];
}
/** Parse a received observation, not a settlement command. Retains generation ID
 * and response digest even when identity/output/cost is unresolved. Full raw bytes
 * must be stored by the protected journal before this projection is consumed. */
export function decodeOpenRouterResponse(bytes:Uint8Array,expected:OpenRouterResponseExpectation){
  const parsed=strictJson(bytes);check(parsed.ok,parsed.ok?'RESPONSE_JSON':parsed.error.code);
  const value=object(parsed.value);
  const generationId=typeof value.id==='string'&&/^gen-[A-Za-z0-9_-]{1,200}$/.test(value.id)?value.id:null;
  const model=typeof value.model==='string'?value.model:null;
  const provider=typeof value.provider==='string'?value.provider:null;
  const identityVerified=generationId!==null&&model!==null&&provider!==null&&expected.models.includes(model)&&expected.providerNames.includes(provider);
  let text:string|null=null;
  if(value.object==='chat.completion'&&!('error' in value)&&Array.isArray(value.choices)&&value.choices.length===1){
    const choice=object(value.choices[0]),message=object(choice.message);
    if(choice.index===0&&choice.finish_reason==='stop'&&message.role==='assistant'&&typeof message.content==='string'&&!('tool_calls' in message)&&!('function_call' in message))text=message.content;
  }
  let usage:{promptTokens:number;completionTokens:number;totalTokens:number;costCredits:number}|null=null;
  if(value.usage!==null&&typeof value.usage==='object'&&!Array.isArray(value.usage)){
    const u=object(value.usage);
    if(count(u.prompt_tokens)&&count(u.completion_tokens)&&count(u.total_tokens)&&u.prompt_tokens+u.completion_tokens===u.total_tokens&&typeof u.cost==='number'&&Number.isFinite(u.cost)&&u.cost>=0)
      usage={promptTokens:u.prompt_tokens,completionTokens:u.completion_tokens,totalTokens:u.total_tokens,costCredits:u.cost};
  }
  return {generationId,model,provider,identityVerified,text:identityVerified?text:null,usage,
    outputState:identityVerified&&text!==null?'completed' as const:'unknown' as const,
    costState:usage===null?'unknown' as const:'observed' as const,
    responseDigest:createHash('sha256').update(bytes).digest('hex')};
}
/** Shared live/recovery MIME admission; absent evidence is never assumed JSON. */
export function isOpenRouterJson(contentType: string | null): boolean {
 return typeof contentType === 'string' && contentType.split(';')[0]?.trim().toLowerCase() === 'application/json';
}
