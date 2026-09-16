import {createHash} from 'node:crypto';
import {strictJson} from '../../contracts/src/wire.js';
import {usdUnits} from './api-trial-budget.js';
import type {OpenRouterResponseExpectation} from './openrouter-response.js';
export function decodeOpenRouterGeneration(bytes:Uint8Array,id:string,expected:OpenRouterResponseExpectation){
 const unknown={status:'unknown' as const,outputRecovered:false as const,remoteStopObserved:false as const,settlementAuthorized:false as const};
 if(!/^gen-[A-Za-z0-9_-]{1,200}$/.test(id))throw Error('OPENROUTER_GENERATION_ID');
 const parsed=strictJson(bytes);if(!parsed.ok)return unknown;
 const envelope=parsed.value as any,v=envelope?.data;
 if(!v||typeof v!=='object'||Array.isArray(v)||envelope.error||v.id!==id||!expected.models.includes(v.model)||!expected.providerNames.includes(v.provider_name)||v.is_byok!==false)return unknown;
 const cost=v.total_cost;
 if(typeof cost!=='number'||!Number.isFinite(cost)||cost<0||cost>999999999)return unknown;
 const decimal=cost.toFixed(9);if(Number(decimal)!==cost)return unknown;
 let costUnits:string;try{costUnits=String(usdUnits(decimal));}catch{return unknown;}
 return {...unknown,status:'observed' as const,generationId:id,model:v.model as string,provider:v.provider_name as string,totalCostCreditUnits:costUnits,
  cancellationReported:typeof v.cancelled==='boolean'?v.cancelled:null,evidenceDigest:createHash('sha256').update(bytes).digest('hex')};
}
