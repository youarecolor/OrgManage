import {createHash} from 'node:crypto';
import {prepareOpenRouterRequest,type OpenRouterPolicy} from './openrouter-policy.js';
import {deriveOpenRouterPriceBasis} from './openrouter-catalog.js';
function dollars(n:bigint){const tail=String(n%1000000000n).padStart(9,'0').replace(/0+$/,'');return String(n/1000000000n)+(tail?'.'+tail:'');}
export interface CatalogObservation {model:string;bytes:Uint8Array;observedAt:number}
/** Request-bound view of the shared conditional USD price basis; not runtime
 * qualification or spend authorization. Metadata has a 60-second lifetime. */
export function openrouterEnvelope(policy:OpenRouterPolicy,original:string,catalogs:readonly CatalogObservation[],zdr:{bytes:Uint8Array;observedAt:number},now:number){
 const request=prepareOpenRouterRequest(policy,original);
 for(const t of [zdr.observedAt,...catalogs.map(c=>c.observedAt)]){
  if(!Number.isSafeInteger(t)||t<0||t>now||now-t>=60000)throw Error('OPENROUTER_ENVELOPE_STALE_METADATA');
 }
 const basis=deriveOpenRouterPriceBasis(policy,catalogs.map(c=>({model:c.model,catalogBytes:c.bytes,zdrBytes:zdr.bytes,observedAt:Math.min(c.observedAt,zdr.observedAt)})),now);
 return {requestDigest:createHash('sha256').update(JSON.stringify(request.body)).digest('hex'),maximumUsd:dollars(BigInt(basis.maximum.units)),expiresAt:basis.expiresAt,
  endpoints:basis.endpoints.map(e=>({model:e.model,tag:e.endpointTag,providerName:e.providerName,promptMaximum:e.promptTokenBound,maximumUsd:dollars(BigInt(e.maximum.units)),catalogDigest:e.catalogDigest,zdrDigest:e.zdrDigest,requestFeeKnown:e.requestFeeKnown})),
  conditions:basis.conditions,jpyVerified:false as const,executionAuthorized:false as const};
}
