import {createHash} from 'node:crypto';
import {strictJson,strictMetadataJson} from '../../contracts/src/wire.js';
import {prepareOpenRouterRequest,type OpenRouterPolicy} from './openrouter-policy.js';
import {moneyUnits,type Money} from './money.js';
function check(ok:unknown,why:string):asserts ok{if(!ok)throw Error(`OPENROUTER_CATALOG_${why}`);}
function text(v:unknown,max=128):asserts v is string{check(typeof v==='string'&&v.length>0&&v.length<=max,'TEXT');}
function limit(v:unknown):number|null{check(v===null||v===undefined||(Number.isSafeInteger(v)&&Number(v)>0),'LIMIT');return v==null?null:Number(v);}
/** Price strings are per token; convert to per-million without float rounding. */
export function usdPerMillion(value:unknown):string|null{
 if(value===undefined||value===null)return null;
 check(typeof value==='string'&&/^(0|[1-9][0-9]{0,5})(\.[0-9]{1,18})?(?![\s\S])/.test(value),'PRICE');
 const [whole,fraction='']=value.split('.'),units=BigInt(whole!)*10n**18n+BigInt(fraction.padEnd(18,'0'));
 const scaled=units*1000000n,integer=scaled/(10n**18n),tail=String(scaled%(10n**18n)).padStart(18,'0').replace(/0+$/,'');
 return String(integer)+(tail?'.'+tail:'');
}
/** Public metadata projection; does not certify runtime, data policy or pricing
 * freshness, nor grant access to endpoints or secrets. */
export function decodeOpenRouterCatalog(bytes:Uint8Array,model:string){
 check(/^[a-z0-9-]+\/[a-z0-9][a-z0-9._-]*$/.test(model),'MODEL');
 const decoded=strictJson(bytes);check(decoded.ok,'JSON');
 const root=decoded.value as {data?:unknown};check(root&&typeof root==='object','SHAPE');
 const data=root.data as Record<string,unknown>;check(data&&typeof data==='object'&&data.id===model&&Array.isArray(data.endpoints)&&data.endpoints.length<=128,'MODEL_BINDING');
 const seen=new Set<string>();
 const endpoints=data.endpoints.map(raw=>{
  check(raw&&typeof raw==='object'&&!Array.isArray(raw),'ENDPOINT');const e=raw as Record<string,unknown>;
  check(e.model_id===model,'ENDPOINT_MODEL');text(e.provider_name);text(e.tag);check(/^[a-z0-9][a-z0-9._/-]*$/.test(e.tag)&&!seen.has(e.tag),'TAG');seen.add(e.tag);
  check(Number.isSafeInteger(e.status),'STATUS');
  check(Array.isArray(e.supported_parameters)&&e.supported_parameters.length<=128&&e.supported_parameters.every(v=>typeof v==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(v)),'PARAMETERS');
  const price=e.pricing as Record<string,unknown>;check(price&&typeof price==='object'&&!Array.isArray(price),'PRICING');
  const requestUsd=usdPerMillion(price.request)===null?null:price.request as string;
  return {model,providerName:e.provider_name,endpointTag:e.tag,status:Number(e.status),contextLength:limit(e.context_length),maxCompletionTokens:limit(e.max_completion_tokens),maxPromptTokens:limit(e.max_prompt_tokens),
   supportedParameters:[...new Set(e.supported_parameters as string[])],promptUsdPerMillion:usdPerMillion(price.prompt),completionUsdPerMillion:usdPerMillion(price.completion),
   // Missing request fee/retention is unknown, never a fabricated zero/allowance.
   requestFeeKnown:requestUsd!==null,requestUsd,
   cacheReadUsdPerMillion:usdPerMillion(price.input_cache_read),cacheWriteUsdPerMillion:usdPerMillion(price.input_cache_write),
   unmodeledPriceFields:Object.keys(price).filter(k=>{
    if(['prompt','completion','request','input_cache_read','input_cache_write'].includes(k)||(k==='discount'&&price[k]===0))return false;
    try{return usdPerMillion(price[k])!=='0';}catch{return true;}
   }).sort(),
   retentionVerified:false as const};
 });
 return {model,endpoints,evidenceDigest:createHash('sha256').update(bytes).digest('hex'),executionAuthorized:false as const};
}

/** ZDR preview membership is an observation, not a permanent retention grant. */
export function decodeOpenRouterZdr(bytes:Uint8Array,model:string){
 const decoded=strictMetadataJson(bytes);check(decoded.ok,'JSON');
 const root=decoded.value as {data?:unknown};check(root&&typeof root==='object'&&Array.isArray(root.data)&&root.data.length<=4096,'ZDR_SHAPE');
 const entries=root.data.filter(e=>e&&typeof e==='object'&&e.model_id===model);
 const catalog=decodeOpenRouterCatalog(Buffer.from(JSON.stringify({data:{id:model,endpoints:entries}})),model);
 return {...catalog,evidenceDigest:createHash('sha256').update(bytes).digest('hex'),source:'zdr_preview' as const};
}

export function matchOpenRouterZdr(catalog:ReturnType<typeof decodeOpenRouterCatalog>,preview:ReturnType<typeof decodeOpenRouterZdr>){
 check(catalog.model===preview.model,'ZDR_MODEL');
 return catalog.endpoints.map(e=>({...e,zdrEligibilityObserved:preview.endpoints.some(z=>z.endpointTag===e.endpointTag&&z.providerName===e.providerName&&z.model===e.model),catalogDigest:catalog.evidenceDigest,zdrDigest:preview.evidenceDigest,executionAuthorized:false as const}));
}

export interface OpenRouterPriceSample {model:string;catalogBytes:Uint8Array;zdrBytes:Uint8Array;observedAt:number}
/** Data-only, conservative price basis. Full prompt capacity avoids an invented
 * tokenizer/byte ratio. Transport provenance and runtime capability are separate. */
export function deriveOpenRouterPriceBasis(policy:OpenRouterPolicy,samples:readonly OpenRouterPriceSample[],now:number){
 prepareOpenRouterRequest(policy,'x');
 check(Number.isSafeInteger(now)&&now>=0&&samples.length===policy.models.length&&new Set(samples.map(s=>s.model)).size===samples.length,'PRICE_SAMPLES');
 const scaled=(value:string):bigint=>{
  check(/^(0|[1-9][0-9]{0,12})(\.[0-9]{1,18})?(?![\s\S])/.test(value),'PRICE');
  const [whole,fraction='']=value.split('.');return BigInt(whole!)*10n**18n+BigInt(fraction.padEnd(18,'0'));
 };
 const cap=(n:number)=>{const s=n.toFixed(9);check(Number(s)===n,'PRICE_PRECISION');return scaled(s);};
 const promptCap=cap(policy.maxPromptUsdPerMillion),completionCap=cap(policy.maxCompletionUsdPerMillion);
 let maximum=0n,expiresAt=Number.MAX_SAFE_INTEGER;
 const endpoints:{model:string;endpointTag:string;providerName:string;promptTokenBound:number;completionTokenBound:number;maximum:Money;catalogDigest:string;zdrDigest:string;observedAt:number;requestFeeKnown:boolean}[]=[];
 for(const model of policy.models){
  const sample=samples.find(s=>s.model===model);check(sample,'PRICE_MODEL');
  check(Number.isSafeInteger(sample.observedAt)&&Number.isSafeInteger(sample.observedAt+60000)&&sample.observedAt>=0&&sample.observedAt<=now&&now-sample.observedAt<60000,'PRICE_EXPIRED');
  expiresAt=Math.min(expiresAt,sample.observedAt+60000);
  const catalog=decodeOpenRouterCatalog(sample.catalogBytes,model),preview=decodeOpenRouterZdr(sample.zdrBytes,model);
  const selected=matchOpenRouterZdr(catalog,preview).filter(e=>policy.providers.includes(e.endpointTag));check(selected.length>0,'PRICE_ENDPOINT_MISSING');
  // A base slug can include sub-endpoints. Do not silently price only its base.
  check(!catalog.endpoints.some(e=>policy.providers.some(tag=>e.endpointTag.startsWith(tag+'/'))),'PRICE_ENDPOINT_EXPANSION');
  for(const e of selected){
   check(e.status===0&&e.zdrEligibilityObserved&&e.supportedParameters.includes('max_tokens'),'PRICE_ENDPOINT_UNQUALIFIED');
   check(e.contextLength!==null&&e.maxCompletionTokens!==null&&policy.maxOutputTokens<=e.maxCompletionTokens&&policy.maxOutputTokens<=e.contextLength,'PRICE_TOKEN_LIMIT');
   check(e.promptUsdPerMillion!==null&&e.completionUsdPerMillion!==null&&(e.requestUsd===null||scaled(e.requestUsd)===0n)&&e.unmodeledPriceFields.length===0,'PRICE_INCOMPLETE');
   const prompt=[e.promptUsdPerMillion,e.cacheReadUsdPerMillion,e.cacheWriteUsdPerMillion].filter((v):v is string=>v!==null).map(scaled).reduce((a,b)=>a>b?a:b);
   const completion=scaled(e.completionUsdPerMillion);check(prompt<=promptCap&&completion<=completionCap,'PRICE_CAP');
   const promptTokenBound=Math.min(e.contextLength,e.maxPromptTokens??e.contextLength),completionTokenBound=policy.maxOutputTokens;
   // Prices above are USD / million, scaled by 10^18. Round the sum upward to
   // USD nanos; never round a positive sub-nano observation down to zero.
   const numerator=promptCap*BigInt(promptTokenBound)+completionCap*BigInt(completionTokenBound),denominator=10n**15n;
   const units=(numerator+denominator-1n)/denominator,amount:Money={format:'money_v1',currency:'USD',units:String(units)};moneyUnits(amount);
   maximum=maximum>units?maximum:units;
   endpoints.push({model,endpointTag:e.endpointTag,providerName:e.providerName,promptTokenBound,completionTokenBound,maximum:amount,catalogDigest:e.catalogDigest,zdrDigest:e.zdrDigest,observedAt:sample.observedAt,requestFeeKnown:e.requestFeeKnown});
  }
 }
 check(policy.providers.every(tag=>endpoints.some(e=>e.endpointTag===tag)),'PRICE_UNUSED_ENDPOINT');
 return {format:'openrouter_price_basis_v1' as const,maximum:{format:'money_v1' as const,currency:'USD' as const,units:String(maximum)},endpoints,expiresAt,conditions:['advertised_token_limits_enforced','request_price_cap_zero_enforced','per_token_price_caps_enforced'] as const,runtimeQualified:false as const,executionAuthorized:false as const};
}
