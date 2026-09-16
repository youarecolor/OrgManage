import {createHash,randomUUID} from 'node:crypto';
import canonicalize from 'canonicalize';
import type {LedgerReader,LedgerStore} from '../../ledger/src/index.js';
import {decodeOpenRouterGeneration} from './openrouter-generation.js';
import {usdUnits} from './api-trial-budget.js';
import {isOpenRouterJson,type OpenRouterResponseExpectation} from './openrouter-response.js';
const hash=(v:unknown)=>createHash('sha256').update(canonicalize(v)!).digest('hex');
function check(ok:unknown,why:string):asserts ok{if(!ok)throw Error(`OPENROUTER_RECOVERY_${why}`);}
export interface GenerationRecoveryBinding {intentId:string;accountRoute:string;generationId:string;requestDigest:string;witnessVersion:string;observationVersion:string;expected:OpenRouterResponseExpectation}
/** Protected recovery ingress; metadata does not settle costs or restore output. */
export class OpenRouterRecovery {
 constructor(readonly store:LedgerStore,readonly clock:()=>number=Date.now){}
 #binding(tx:LedgerReader,p:string,actor:string,id:string):GenerationRecoveryBinding{
  check(tx.getMembership(p,actor)?.role==='owner','ACTOR');
  const row=tx.getRecord(p,id);check(row?.kind==='intent','INTENT');const i=JSON.parse(row.data);
  check(i.format==='openrouter_intent_v1'&&i.route==='openrouter'&&['unknown','completed'].includes(i.state),'STATE');
  const witness=tx.getRecordVersion(p,i.witnessVersion),observation=tx.getRecord(p,i.observationId);
  check(witness?.kind==='evidence'&&observation?.kind==='evidence'&&observation.revision===1n,'EVIDENCE');
  const w=JSON.parse(witness.data),o=JSON.parse(observation.data),r=o.response;
  check(w.format==='openrouter_action_witness_v1'&&w.intentId===id&&w.requestDigest===i.requestDigest&&w.accountRoute===i.accountRoute,'WITNESS');
  check(o.format==='openrouter_observation_v1'&&o.intentId===id&&o.witnessVersion===witness.versionId&&r?.requestDigest===i.requestDigest,'OBSERVATION');
  check(typeof r.generationId==='string'&&/^gen-[A-Za-z0-9_-]{1,200}$/.test(r.generationId),'GENERATION_UNKNOWN');
  const expected=w.responseExpectation;check(expected&&Array.isArray(expected.models)&&Array.isArray(expected.providerNames)&&expected.models.length>0&&expected.providerNames.length>0,'EXPECTATION');
  return {intentId:id,accountRoute:i.accountRoute,generationId:r.generationId,requestDigest:i.requestDigest,witnessVersion:witness.versionId,observationVersion:observation.versionId,expected};
 }
 prepare(p:string,actor:string,id:string){return this.store.read(tx=>this.#binding(tx,p,actor,id));}
 record(p:string,actor:string,binding:GenerationRecoveryBinding,status:number,input:Uint8Array,contentType:string|null):string{
  check(input instanceof Uint8Array&&!(input.buffer instanceof SharedArrayBuffer)&&input.byteLength<=65536,'BYTES');
  check(Number.isSafeInteger(status)&&status>=100&&status<=599,'STATUS');
  check(contentType===null||typeof contentType==='string'&&contentType.length<=1024,'MIME');
  const bytes=new Uint8Array(input),fixed=structuredClone(binding),at=this.clock();check(Number.isSafeInteger(at)&&at>=0,'CLOCK');
  return this.store.transaction(tx=>{
   check(hash(this.#binding(tx,p,actor,fixed.intentId))===hash(fixed),'BINDING_CHANGED');
   const raw={status,contentType,bodyBase64:Buffer.from(bytes).toString('base64')};
   const key=`openrouter-generation:${p}:${fixed.intentId}:${hash({fixed,raw})}`,prior=tx.getMeta(key);if(prior)return prior;
   const result=status===200&&isOpenRouterJson(contentType)?decodeOpenRouterGeneration(bytes,fixed.generationId,fixed.expected):{status:'unknown',settlementAuthorized:false,outputRecovered:false,remoteStopObserved:false};
   const id=randomUUID();tx.insertRecord({principalId:p,id,kind:'evidence',revision:1n,data:JSON.stringify({format:'openrouter_generation_recovery_v1',binding:fixed,raw,result,receivedAt:at})});
   if(result.status==='observed'){
    const original=JSON.parse(tx.getRecordVersion(p,fixed.observationVersion)!.data).response.usage?.costCredits;
    const amounts=new Set<string>();
    if(typeof original==='number'&&Number.isFinite(original)&&original>=0){try{const decimal=original.toFixed(9);if(Number(decimal)===original)amounts.add(String(usdUnits(decimal)));}catch{/* Unsupported precision remains unqualified. */}}
    for(const row of tx.listRecord(p,'evidence')){
     const r=JSON.parse(row.data);
     if(r.format==='openrouter_generation_recovery_v1'&&hash(r.binding)===hash(fixed)&&r.result.status==='observed')amounts.add(r.result.totalCostCreditUnits);
    }
    if(amounts.size>1)tx.setMeta(`api-trial-conflict:openrouter:${fixed.accountRoute}`,id);
   }
   tx.setMeta(key,id);tx.appendAudit({principalId:p,commandId:null,kind:'openrouter.generation_recovered',entityId:id,createdAt:new Date(at).toISOString()});tx.setMeta(`feed:${p}`,randomUUID());
   return id;
  });
 }
}
