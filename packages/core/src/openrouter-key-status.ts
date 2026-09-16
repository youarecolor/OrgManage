import {strictJson} from '../../contracts/src/wire.js';
import {usdUnits} from './api-trial-budget.js';
/** Safe projection of GET /api/v1/key. No label, key fragment, creator ID or raw
 * provider body leaves this boundary. Key allowance is not account credit balance. */
export function inspectOpenRouterKeyStatus(bytes:Uint8Array,maximumUsd:string,now:number){
 const maximum=usdUnits(maximumUsd);
 if(!Number.isSafeInteger(now)||now<0||maximum<=0n)throw Error('OPENROUTER_KEY_POLICY');
 const parsed=strictJson(bytes);
 const blocked=(reason:string)=>({keyLimitVerified:false,reason,executionAuthorized:false as const,accountCreditsVerified:false as const});
 if(!parsed.ok)return blocked('invalid_response');
 const envelope=parsed.value as {data?:unknown}|null;
 if(!envelope||typeof envelope!=='object'||!envelope.data||typeof envelope.data!=='object'||Array.isArray(envelope.data))return blocked('invalid_response');
 const v=envelope.data as Record<string,unknown>;
 if(v.is_management_key!==false||v.is_provisioning_key!==false)return blocked('inference_key_required');
 if(v.disabled===true)return blocked('key_disabled');
 if(v.limit_reset!==null)return blocked('nonresetting_limit_required');
 let expiresAt=now+60000;
 if(v.expires_at!==null){
  if(typeof v.expires_at!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(v.expires_at))return blocked('expiry_unknown');
  const expiry=Date.parse(v.expires_at);if(!Number.isFinite(expiry)||expiry<=now)return blocked('key_expired');
  expiresAt=Math.min(expiresAt,expiry);
 }
 const amount=(x:unknown)=>{if(typeof x!=='number'||!Number.isFinite(x)||x<0)return null;try{return usdUnits(String(x));}catch{return null;}};
 const limit=amount(v.limit),remaining=amount(v.limit_remaining),used=amount(v.usage);
 if(limit===null||remaining===null||used===null)return blocked('amount_unknown');
 if(limit<=0n||limit>maximum)return blocked('limit_outside_trial');
 if(remaining<=0n)return blocked('key_allowance_exhausted');
 if(used+remaining>limit)return blocked('amount_inconsistent');
 return {keyLimitVerified:true,reason:'bounded_key_allowance',limitUsdUnits:String(limit),remainingUsdUnits:String(remaining),usedUsdUnits:String(used),observedAt:now,expiresAt,executionAuthorized:false as const,accountCreditsVerified:false as const};
}
