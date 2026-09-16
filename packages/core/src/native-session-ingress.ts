import {createHash,randomUUID} from 'node:crypto';
import canonicalize from 'canonicalize';
import type {LedgerStore,LedgerReader} from '../../ledger/src/index.js';
import type {NativeChannelIdentity} from './native-provider-dispatch.js';

export interface NativePreparationReceipt extends NativeChannelIdentity {
 format:'native_preparation_v1'; mode:'provider'; stage:'ready';
 helper:{processId:number;startTicks:string;sourceDigest:string};
 guest:{vmId:string;processId:number;runnerDigest:string;cliDigest:string};
 observedAt:number;expiresAt:number;closed:boolean;turnsSent:number;
 maxTurns:number;toolsEnabled:boolean;apiFallbackEnabled:boolean;purchaseOperationsEnabled:boolean;
}
/** A protected host must obtain this from the same verified live connection.
 * A file, renderer request or candidate cannot be substituted for this port.
 * Its receipt describes preparation only, never capability/admission success. */
export interface NativePreparedConnection {
 preparation():Readonly<NativePreparationReceipt>;
}
function check(v:unknown):asserts v {if(!v)throw Error('NATIVE_SESSION_INGRESS_DENIED');}
const digest=(v:unknown)=>createHash('sha256').update(canonicalize(v)!).digest('hex');
const hash=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
function keys(v:object,expected:string[]){check(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===expected.sort().join('|'));}
function preparation(v:NativePreparationReceipt,now:number){
 check(v&&v.format==='native_preparation_v1'&&v.mode==='provider'&&v.stage==='ready');
 keys(v,['format','mode','stage','sessionId','threadId','accountRoute','profileDigest','model','effort','helper','guest','observedAt','expiresAt','closed','turnsSent','maxTurns','toolsEnabled','apiFallbackEnabled','purchaseOperationsEnabled']);
 keys(v.helper,['processId','startTicks','sourceDigest']);keys(v.guest,['vmId','processId','runnerDigest','cliDigest']);
 check(hash(v.sessionId)&&hash(v.profileDigest));
 for(const key of ['threadId','accountRoute','model','effort'] as const)check(typeof v[key]==='string'&&v[key].length>0&&Buffer.byteLength(v[key])<=256);
 check(v.helper&&Number.isSafeInteger(v.helper.processId)&&v.helper.processId>0&&typeof v.helper.startTicks==='string'&&/^\d{16,19}$/.test(v.helper.startTicks)&&hash(v.helper.sourceDigest));
 check(v.guest&&typeof v.guest.vmId==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v.guest.vmId)&&Number.isSafeInteger(v.guest.processId)&&v.guest.processId>0&&hash(v.guest.runnerDigest)&&hash(v.guest.cliDigest));
 check(Number.isSafeInteger(now)&&now>=0&&Number.isSafeInteger(v.observedAt)&&v.observedAt>=0&&v.observedAt<=now&&Number.isSafeInteger(v.expiresAt)&&v.expiresAt>now&&v.expiresAt-v.observedAt<=60000);
 check(v.closed===false&&v.turnsSent===0&&v.maxTurns===1&&v.toolsEnabled===false&&v.apiFallbackEnabled===false&&v.purchaseOperationsEnabled===false);
 return v;
}
/** Pure validation/copy for the trusted transport. It grants no authority. */
export function validateNativePreparation(value:NativePreparationReceipt,now:number):Readonly<NativePreparationReceipt>{return structuredClone(preparation(value,now));}
/** Called only by the trusted host that owns the pipe. Binds an immutable raw
 * preparation and its projection to this ledger owner in one transaction.
 * Re-reading the connection before commit rejects closure/rebinding races. */
export class NativeSessionIngress {
 constructor(readonly store:LedgerStore,readonly clock:()=>number=Date.now){}
 import(p:string,actor:string,scope:string,connection:NativePreparedConnection):string{
  const fixed=structuredClone(preparation(connection.preparation(),this.clock()));
  return this.store.transaction(tx=>{
   check(tx.getMembership(p,actor)?.role==='owner');const s=tx.getScope(scope);check(s?.principalId===p&&s.kind==='mission'&&s.state==='active');
   const key=`native-preparation:${fixed.sessionId}`;check(!tx.getMeta(key));
   const sourceId=randomUUID();tx.insertRecord({principalId:p,id:sourceId,kind:'evidence',revision:1n,data:JSON.stringify(fixed)});
   const sourceVersion=tx.getRecord(p,sourceId)!.versionId,id=randomUUID();
   const value={format:'native_provider_session_v1',provider:'codex',actorId:actor,scopeId:scope,ownerId:this.store.ownerId,ownerEpoch:String(this.store.ownerEpoch),sessionId:fixed.sessionId,threadId:fixed.threadId,accountRoute:fixed.accountRoute,profileDigest:fixed.profileDigest,model:fixed.model,effort:fixed.effort,observedAt:fixed.observedAt,expiresAt:fixed.expiresAt,maxTurns:1,toolsEnabled:false,apiFallbackEnabled:false,purchaseOperationsEnabled:false,preparationVersion:sourceVersion,preparationDigest:digest(fixed)};
   tx.insertRecord({principalId:p,id,kind:'evidence',revision:1n,data:JSON.stringify(value)});tx.setMeta(key,tx.getRecord(p,id)!.versionId);
   check(canonicalize(preparation(connection.preparation(),this.clock()))===canonicalize(fixed));
   return tx.getRecord(p,id)!.versionId;
  });
 }
}
/** The send boundary validates the original immutable preparation again. */
export function verifyNativeSessionPreparation(tx:LedgerReader,p:string,session:Record<string,unknown>,now:number):void{
 check(typeof session.preparationVersion==='string'&&hash(session.preparationDigest));
 const row=tx.getRecordVersion(p,session.preparationVersion);check(row?.kind==='evidence');
 const raw=preparation(JSON.parse(row.data),now);check(digest(raw)===session.preparationDigest);
 for(const key of ['sessionId','threadId','accountRoute','profileDigest','model','effort','observedAt','expiresAt','maxTurns','toolsEnabled','apiFallbackEnabled','purchaseOperationsEnabled'] as const)check(session[key]===raw[key]);
}
