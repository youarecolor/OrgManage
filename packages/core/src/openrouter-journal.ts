import {createHash,randomUUID} from 'node:crypto';
import type {LedgerStore,LedgerReader,LedgerTransaction} from '../../ledger/src/index.js';
import {decodeOpenRouterResponse,isOpenRouterJson,type OpenRouterResponseExpectation} from './openrouter-response.js';
const sha=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex');
function check(ok:unknown,why:string):asserts ok{if(!ok)throw Error(`OPENROUTER_JOURNAL_${why}`);}
type Receipt={format:'openrouter_response_v1'|'openrouter_response_v2';contentType?:string|null;intentId:string;intentVersion:string;requestDigest:string;status:number;bodyBase64:string;bodyDigest:string;receivedAt:number};
/** Protected ledger ingress. Does not acquire a send, adopt output or settle cost.
 * Exact response evidence survives service-owner changes and scope cancellation. */
export class OpenRouterJournal{
 constructor(readonly store:LedgerStore,readonly clock:()=>number=Date.now){}
 #intent(tx:LedgerReader,p:string,actor:string,id:string){
  check(tx.getMembership(p,actor)?.role==='owner','ACTOR');
  const row=tx.getRecord(p,id);check(row?.kind==='intent','INTENT');const value=JSON.parse(row.data);
  check(value.route==='openrouter'&&typeof value.requestDigest==='string'&&/^[a-f0-9]{64}$/.test(value.requestDigest),'BINDING');
  check(['send_intent','unknown','completed'].includes(value.state),'NOT_SENT');return {row,value};
 }
 append(p:string,actor:string,intentId:string,status:number,input:Uint8Array,contentType:string|null=null):string{
  check(contentType===null||(typeof contentType==='string'&&contentType.length<=1024),'CONTENT_TYPE');
  check(input instanceof Uint8Array&&!(input.buffer instanceof SharedArrayBuffer)&&input.byteLength<=262144,'BODY_LIMIT');
  check(Number.isSafeInteger(status)&&status>=100&&status<=599,'STATUS');
  const bytes=new Uint8Array(input),bodyDigest=sha(bytes),receivedAt=this.clock();check(Number.isSafeInteger(receivedAt)&&receivedAt>=0,'CLOCK');
  return this.store.transaction(tx=>{
   const {row,value}=this.#intent(tx,p,actor,intentId),key=`openrouter-response:${p}:${intentId}`,prior=tx.getMeta(key);
   if(prior){const old=tx.getRecord(p,prior);check(old?.kind==='evidence'&&old.revision===1n,'RECEIPT_CHANGED');const r=JSON.parse(old.data) as Receipt;
    check(r.format==='openrouter_response_v2'&&r.contentType===contentType&&r.intentId===intentId&&r.requestDigest===value.requestDigest&&r.status===status&&r.bodyDigest===bodyDigest&&r.bodyBase64===Buffer.from(bytes).toString('base64'),'CONFLICT');return old.id;
   }
   const id=randomUUID(),receipt:Receipt={format:'openrouter_response_v2',contentType,intentId,intentVersion:row.versionId,requestDigest:value.requestDigest,status,bodyBase64:Buffer.from(bytes).toString('base64'),bodyDigest,receivedAt};
   tx.insertRecord({principalId:p,id,kind:'evidence',revision:1n,data:JSON.stringify(receipt)});tx.setMeta(key,id);return id;
  });
 }
 recover(p:string,actor:string,intentId:string,expected:OpenRouterResponseExpectation){
  return this.store.read(tx=>this.#recover(tx,p,actor,intentId,expected));
 }
 recoverInTransaction(tx:LedgerTransaction,p:string,actor:string,intentId:string,expected:OpenRouterResponseExpectation){
  this.store.assertTransaction(tx);return this.#recover(tx,p,actor,intentId,expected);
 }
 #recover(tx:LedgerReader,p:string,actor:string,intentId:string,expected:OpenRouterResponseExpectation){
   const {value}=this.#intent(tx,p,actor,intentId),id=tx.getMeta(`openrouter-response:${p}:${intentId}`);check(id,'MISSING');
   const row=tx.getRecord(p,id);check(row?.kind==='evidence'&&row.revision===1n,'RECEIPT_CHANGED');const r=JSON.parse(row.data) as Receipt;
   const before=tx.getRecordVersion(p,r.intentVersion);check(before?.kind==='intent'&&before.id===intentId,'INTENT_VERSION');
   const original=JSON.parse(before.data);check(original.route==='openrouter'&&original.requestDigest===value.requestDigest&&r.requestDigest===value.requestDigest&&r.intentId===intentId&&['openrouter_response_v1','openrouter_response_v2'].includes(r.format),'BINDING');
   const bytes=Buffer.from(r.bodyBase64,'base64');check(bytes.length<=262144&&bytes.toString('base64')===r.bodyBase64&&sha(bytes)===r.bodyDigest,'BODY_CHANGED');
   const metadata={receiptId:id,evidenceVersion:row.versionId,intentVersion:r.intentVersion,requestDigest:r.requestDigest,responseDigest:r.bodyDigest,receivedAt:r.receivedAt};
   if(r.status!==200)return {...metadata,outputState:'unknown' as const,reason:'http_error',costState:'unknown' as const};
   if(r.format!=='openrouter_response_v2'||!isOpenRouterJson(r.contentType??null))return {...metadata,outputState:'unknown' as const,reason:'content_type_unverified',costState:'unknown' as const};
   try{return {...metadata,...decodeOpenRouterResponse(bytes,expected)};}
   catch{return {...metadata,outputState:'unknown' as const,reason:'invalid_response',costState:'unknown' as const};}
 }
}
