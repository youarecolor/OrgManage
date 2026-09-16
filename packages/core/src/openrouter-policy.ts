/** Data-only OpenRouter boundary. Producing a request grants no send authority.
 * The live adapter must acquire Core disclosure, cash and stop guards separately. */
export interface OpenRouterPolicy {
  mode:'fixed'|'auto'; models:readonly string[]; providers:readonly string[];
  maxPromptUsdPerMillion:number; maxCompletionUsdPerMillion:number;
  maxOutputTokens:number; maxInputBytes:number;
}
function check(ok:unknown,reason:string):asserts ok {if(!ok)throw Error(`OPENROUTER_${reason}`);}
function exact(v:unknown,keys:string[]):asserts v is Record<string,unknown>{
  check(v!==null&&typeof v==='object'&&!Array.isArray(v),'OBJECT');
  check(Object.keys(v).sort().join(',')===keys.sort().join(','),'FIELDS');
}
function list(v:unknown,pattern:RegExp,max:number):asserts v is string[]{
  check(Array.isArray(v)&&v.length>0&&v.length<=max&&new Set(v).size===v.length&&v.every(s=>typeof s==='string'&&s.length<=128&&pattern.test(s)),'ALLOWLIST');
}
function validate(p:OpenRouterPolicy){
  exact(p,['mode','models','providers','maxPromptUsdPerMillion','maxCompletionUsdPerMillion','maxOutputTokens','maxInputBytes']);
  check(p.mode==='fixed'||p.mode==='auto','MODE');
  // No wildcard, latest, router, or dynamic variant can widen this sealed pool.
  list(p.models,/^[a-z0-9-]+\/[a-z0-9][a-z0-9._-]*$/,16);
  check(p.models.every(m=>!m.startsWith('openrouter/')&&!/(^|[-/])latest($|[-])/.test(m)),'DYNAMIC_MODEL');
  list(p.providers,/^[a-z0-9][a-z0-9._/-]*$/,16);
  check(p.mode!=='fixed'||p.models.length===1,'FIXED_POOL');
  for(const n of [p.maxPromptUsdPerMillion,p.maxCompletionUsdPerMillion])check(typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1000,'PRICE');
  check(Number.isSafeInteger(p.maxOutputTokens)&&p.maxOutputTokens>0&&p.maxOutputTokens<=16384,'OUTPUT_LIMIT');
  check(Number.isSafeInteger(p.maxInputBytes)&&p.maxInputBytes>0&&p.maxInputBytes<=65536,'INPUT_LIMIT');
}
export function prepareOpenRouterRequest(policy:OpenRouterPolicy,original:string,continuationModel:string|null=null){
  validate(policy);
  check(typeof original==='string'&&original.length>0&&Buffer.byteLength(original,'utf8')<=policy.maxInputBytes,'INPUT_LIMIT');
  check(continuationModel===null||policy.models.includes(continuationModel),'CONTINUATION_MODEL');
  const auto=policy.mode==='auto'&&continuationModel===null;
  const body={
    model:continuationModel??(auto?'openrouter/auto':policy.models[0]!),
    messages:[{role:'user' as const,content:original}],stream:false,
    max_tokens:policy.maxOutputTokens,
    provider:{only:[...policy.providers],allow_fallbacks:false,require_parameters:true,
      data_collection:'deny',zdr:true,sort:'price',
      max_price:{prompt:policy.maxPromptUsdPerMillion,completion:policy.maxCompletionUsdPerMillion,request:0}},
    ...(auto?{plugins:[{id:'auto-router',allowed_models:[...policy.models],cost_tier:'low'}]}:{})
  };
  return {endpoint:'https://openrouter.ai/api/v1/chat/completions',body,executionAuthorized:false as const};
}
/** Response metadata is evidence only: a mismatch cannot undo an external send.
 * Keep the Attempt/cost unresolved until reconciled; never silently retry it. */
export function inspectOpenRouterIdentity(policy:OpenRouterPolicy,metadata:unknown){
  validate(policy);exact(metadata,['id','model','provider']);
  check(typeof metadata.id==='string'&&/^gen-[A-Za-z0-9_-]{1,200}$/.test(metadata.id),'RESPONSE_ID');
  check(typeof metadata.model==='string'&&policy.models.includes(metadata.model),'RESPONSE_MODEL');
  // The adapter must map response provider display names to verified endpoint slugs.
  check(typeof metadata.provider==='string'&&policy.providers.includes(metadata.provider),'RESPONSE_PROVIDER');
  return {generationId:metadata.id,model:metadata.model,provider:metadata.provider};
}
