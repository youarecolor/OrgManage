import {createHash,randomUUID} from 'node:crypto';
import canonicalize from 'canonicalize';
import type {LedgerStore,LedgerReader,LedgerTransaction,StoredLedgerRecord} from '../../ledger/src/index.js';

export type DisclosureDestination =
 | {provider:'codex';accountRoute:string;profileDigest:string}
 | {provider:'openrouter';accountRoute:string;profileDigest:string;models:readonly string[];endpoints:readonly string[]};
type Authority={membership:string;scopes:{id:string;epoch:string}[]};
type Source={format:'disclosure_source_v1';scopeId:string;label:string;text:string;digest:string;createdAt:number};
type Grant={format:'disclosure_grant_v1';scopeId:string;sourceId:string;sourceVersion:string;destination:DisclosureDestination;purpose:'native_text'|'standard_api_text';actorId:string;authority:Authority;createdAt:number;expiresAt:number;state:'active'|'revoked'};
type Part={sourceId:string;sourceVersion:string;sourceDigest:string;grantId:string;grantVersion:string};
type Manifest={format:'disclosure_manifest_v1';actorId:string;scopeId:string;contractVersion:string;destination:DisclosureDestination;authority:Authority;parts:Part[];input:string;inputDigest:string;createdAt:number;expiresAt:number;digest:string};
const sha=(b:string)=>createHash('sha256').update(b,'utf8').digest('hex');
const digest=(v:unknown)=>sha(canonicalize(v)!);
const read=<T>(r:StoredLedgerRecord):T=>JSON.parse(r.data) as T;
function check(v:unknown,reason:string):asserts v{if(!v)throw Error('DISCLOSURE_'+reason);}
function content(v:unknown,max:number):asserts v is string{check(typeof v==='string'&&v.length>0&&Buffer.byteLength(v,'utf8')<=max&&Buffer.from(v,'utf8').toString('utf8')===v,'TEXT_BOUNDARY');}
function destination(v:DisclosureDestination):DisclosureDestination{
 check((v?.provider==='codex'||v?.provider==='openrouter')&&typeof v.accountRoute==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(v.accountRoute)&&/^[a-f0-9]{64}$/.test(v.profileDigest),'DESTINATION');
 // Existing native callers pass a full qualified profile; project its destination
 // fields as before, but do not accept OpenRouter pool fields on a Codex target.
 if(v.provider==='codex'){
  check(!('models' in v)&&!('endpoints' in v),'DESTINATION_FIELDS');
  return {provider:'codex',accountRoute:v.accountRoute,profileDigest:v.profileDigest};
 }
 check(Object.keys(v).sort().join(',')==='accountRoute,endpoints,models,profileDigest,provider','DESTINATION_FIELDS');
 const pool=(items:readonly string[],pattern:RegExp)=>{
  check(Array.isArray(items)&&items.length>0&&items.length<=16&&new Set(items).size===items.length&&items.every(s=>typeof s==='string'&&s.length<=128&&pattern.test(s)),'DESTINATION_POOL');
  return [...items].sort();
 };
 const models=pool(v.models,/^[a-z0-9-]+\/[a-z0-9][a-z0-9._-]*$/);
 check(models.every(m=>!m.startsWith('openrouter/')&&!/(^|[-/])latest($|[-])/.test(m)),'DESTINATION_MODEL');
 return {provider:'openrouter',accountRoute:v.accountRoute,profileDigest:v.profileDigest,models,endpoints:pool(v.endpoints,/^[a-z0-9][a-z0-9._/-]*$/)};
}
const purpose=(to:DisclosureDestination)=>to.provider==='codex'?'native_text' as const:'standard_api_text' as const;
/** Protected host/Core port, not renderer IPC. Registration and grants must be based
 * on the user's effective source/disclosure permissions, never candidate instructions.
 * This component neither reads host paths nor enables a provider route. */
export class DisclosureCoordinator{
 constructor(readonly store:LedgerStore,readonly clock:()=>number=Date.now){}
 #now(){const n=this.clock();check(Number.isSafeInteger(n)&&n>=0,'CLOCK');return n;}
 #authority(tx:LedgerReader,p:string,actor:string,scopeId:string):Authority{
  const member=tx.getMembership(p,actor);check(member?.role==='owner','ACTOR');
  const scopes:Authority['scopes']=[];let scope=tx.getScope(scopeId);check(scope?.kind==='mission'&&scope.principalId===p,'SCOPE');
  while(scope){check(scopes.length<128&&!scopes.some(s=>s.id===scope!.id)&&scope.state==='active'&&(scope.principalId===p||scope.kind==='application'),'SCOPE_STOPPED');scopes.push({id:scope.id,epoch:String(scope.epoch)});if(scope.parentId===null)break;scope=tx.getScope(scope.parentId);check(scope,'ANCESTOR');}
  check(scope.kind==='application','ROOT');return {membership:String(member.generation),scopes};
 }
 #record(tx:LedgerReader,p:string,id:string,kind:'source'|'source_grant'|'context_manifest'){
  const row=tx.getRecord(p,id);check(row?.kind===kind,'RECORD');return row;
 }
 registerSource(p:string,actor:string,scopeId:string,label:string,text:string):string{
  content(label,256);content(text,65536);
  return this.store.transaction(tx=>{this.#authority(tx,p,actor,scopeId);const id=randomUUID(),value:Source={format:'disclosure_source_v1',scopeId,label,text,digest:sha(text),createdAt:this.#now()};tx.insertRecord({principalId:p,id,kind:'source',revision:1n,data:JSON.stringify(value)});return id;});
 }
 reviseSource(p:string,actor:string,id:string,text:string):void{
  content(text,65536);this.store.transaction(tx=>{const row=this.#record(tx,p,id,'source'),old=read<Source>(row);check(old.format==='disclosure_source_v1','SOURCE_FORMAT');this.#authority(tx,p,actor,old.scopeId);tx.updateRecord({...row,revision:row.revision+1n,data:JSON.stringify({...old,text,digest:sha(text),createdAt:this.#now()})},row.revision);});
 }
 grant(p:string,actor:string,sourceId:string,target:DisclosureDestination,expiresAt:number):string{
  const to=destination(target);
  return this.store.transaction(tx=>{const now=this.#now(),row=this.#record(tx,p,sourceId,'source'),source=read<Source>(row);check(source.format==='disclosure_source_v1'&&source.digest===sha(source.text)&&now>=source.createdAt,'SOURCE_FORMAT');const authority=this.#authority(tx,p,actor,source.scopeId);check(Number.isSafeInteger(expiresAt)&&expiresAt>now&&expiresAt-now<=86400000,'EXPIRY');
   check(!tx.listRecord(p,'source_grant').some(r=>{const g=read<Grant>(r);return g.format==='disclosure_grant_v1'&&g.sourceId===sourceId&&g.state==='active'&&canonicalize(g.destination)===canonicalize(to);}), 'GRANT_ALREADY_ACTIVE');
   const id=randomUUID(),value:Grant={format:'disclosure_grant_v1',scopeId:source.scopeId,sourceId,sourceVersion:row.versionId,destination:to,purpose:purpose(to),actorId:actor,authority,createdAt:now,expiresAt,state:'active'};tx.insertRecord({principalId:p,id,kind:'source_grant',revision:1n,data:JSON.stringify(value)});return id;
  });
 }
 revokeGrant(p:string,actor:string,id:string):void{
  this.store.transaction(tx=>{const row=this.#record(tx,p,id,'source_grant'),value=read<Grant>(row);check(['disclosure_grant_v1','disclosure_deny_v1'].includes(value.format),'GRANT_FORMAT');this.#authority(tx,p,actor,value.scopeId);if(value.state==='revoked')return;tx.updateRecord({...row,revision:row.revision+1n,data:JSON.stringify({...value,state:'revoked'})},row.revision);});
 }
 /** Explicit user denial takes priority over a grant, including after source revision. */
 denySource(p:string,actor:string,sourceId:string,target:DisclosureDestination,expiresAt:number):string{
  const to=destination(target);
  return this.store.transaction(tx=>{const now=this.#now(),row=this.#record(tx,p,sourceId,'source'),source=read<Source>(row);
   check(source.format==='disclosure_source_v1','SOURCE_FORMAT');this.#authority(tx,p,actor,source.scopeId);
   check(Number.isSafeInteger(expiresAt)&&expiresAt>now&&expiresAt-now<=86400000,'EXPIRY');
   const id=randomUUID();tx.insertRecord({principalId:p,id,kind:'source_grant',revision:1n,data:JSON.stringify({format:'disclosure_deny_v1',scopeId:source.scopeId,sourceId,destination:to,actorId:actor,createdAt:now,expiresAt,state:'active'})});return id;
  });
 }
 #resolve(tx:LedgerReader,p:string,scopeId:string,to:DisclosureDestination,part:Part|{sourceId:string;grantId:string},now:number){
  const row=this.#record(tx,p,part.sourceId,'source'),s=read<Source>(row),grantRow=this.#record(tx,p,part.grantId,'source_grant'),g=read<Grant>(grantRow);
  check(!tx.listRecord(p,'source_grant').some(r=>{const d=JSON.parse(r.data);return d.format==='disclosure_deny_v1'&&d.state==='active'&&d.sourceId===row.id&&d.scopeId===scopeId&&canonicalize(d.destination)===canonicalize(to)&&d.createdAt<=now&&now<d.expiresAt;}),'EXPLICIT_DENY');
  check(s.format==='disclosure_source_v1'&&s.scopeId===scopeId&&s.digest===sha(s.text),'SOURCE_CHANGED');content(s.text,65536);
  check(g.format==='disclosure_grant_v1'&&g.scopeId===scopeId&&g.purpose===purpose(to)&&g.state==='active'&&g.sourceId===row.id&&g.sourceVersion===row.versionId&&canonicalize(g.destination)===canonicalize(to),'GRANT_MISMATCH');
  check(now>=s.createdAt&&now>=g.createdAt&&now<g.expiresAt,'GRANT_EXPIRED');
  check(canonicalize(g.authority)===canonicalize(this.#authority(tx,p,g.actorId,scopeId)),'GRANT_AUTHORITY_CHANGED');
  const resolved:Part={sourceId:row.id,sourceVersion:row.versionId,sourceDigest:s.digest,grantId:grantRow.id,grantVersion:grantRow.versionId};
  if('sourceVersion' in part)check(canonicalize(resolved)===canonicalize(part),'VERSION_CHANGED');
  return {part:resolved,text:s.text,expiresAt:g.expiresAt};
 }
 #contract(tx:LedgerReader,p:string,scopeId:string,version:string){
  const mission=tx.getRecord(p,scopeId),contract=tx.getRecordVersion(p,version);
  check(mission?.kind==='mission'&&JSON.parse(mission.data).contractRef===version&&contract?.kind==='contract','CONTRACT_CHANGED');
 }
 createManifest(p:string,actor:string,scopeId:string,contractVersion:string,target:DisclosureDestination,parts:readonly {sourceId:string;grantId:string}[]):string{
  const to=destination(target);check(Array.isArray(parts)&&parts.length>0&&parts.length<=16&&new Set(parts.map(p=>p.sourceId)).size===parts.length,'PARTS');
  const copied=parts.map(p=>({sourceId:p.sourceId,grantId:p.grantId}));
  return this.store.transaction(tx=>{const now=this.#now(),authority=this.#authority(tx,p,actor,scopeId);this.#contract(tx,p,scopeId,contractVersion);const sources=copied.map(part=>this.#resolve(tx,p,scopeId,to,part,now)),input=sources.map(s=>s.text).join('\n\n');content(input,16384);
   const value:Omit<Manifest,'digest'>={format:'disclosure_manifest_v1',actorId:actor,scopeId,contractVersion,destination:to,authority,parts:sources.map(s=>s.part),input,inputDigest:sha(input),createdAt:now,expiresAt:Math.min(...sources.map(s=>s.expiresAt))};const id=randomUUID();tx.insertRecord({principalId:p,id,kind:'context_manifest',revision:1n,data:JSON.stringify({...value,digest:digest(value)})});return id;
  });
 }
 /** Called inside the same transaction that acquires send_intent and its holds. */
 authorizeInTransaction(tx:LedgerTransaction,p:string,actor:string,id:string,scopeId:string,contractVersion:string,target:DisclosureDestination,input:string):Readonly<{id:string;digest:string;inputDigest:string}>{
  this.store.assertTransaction(tx);content(input,16384);const to=destination(target),row=this.#record(tx,p,id,'context_manifest'),value=read<Manifest>(row),{digest:storedDigest,...body}=value;
  check(row.revision===1n&&value.format==='disclosure_manifest_v1'&&storedDigest===digest(body),'MANIFEST_CHANGED');
  check(value.actorId===actor&&value.scopeId===scopeId&&value.contractVersion===contractVersion&&canonicalize(value.destination)===canonicalize(to),'BINDING');
  const now=this.#now();check(now>=value.createdAt&&now<value.expiresAt,'MANIFEST_EXPIRED');this.#contract(tx,p,scopeId,contractVersion);
  check(canonicalize(value.authority)===canonicalize(this.#authority(tx,p,actor,scopeId)),'AUTHORITY_CHANGED');
  check(Array.isArray(value.parts)&&value.parts.length>0&&value.parts.length<=16&&new Set(value.parts.map(p=>p.sourceId)).size===value.parts.length,'PARTS');
  const exact=value.parts.map(part=>this.#resolve(tx,p,scopeId,to,part,now).text).join('\n\n');
  check(value.input===exact&&input===exact&&value.inputDigest===sha(exact),'INPUT_MISMATCH');return Object.freeze({id,digest:storedDigest,inputDigest:value.inputDigest});
 }
 /** Literal search only among sources currently permitted for this destination.
  * Knowledge candidates and unregistered paths are not searchable sources. */
 search(p:string,actor:string,scopeId:string,target:DisclosureDestination,query:string):readonly {sourceId:string;sourceVersion:string;grantId:string;label:string;excerpt:string}[]{
  content(query,256);const to=destination(target);
  return this.store.read(tx=>{this.#authority(tx,p,actor,scopeId);const now=this.#now(),matches=[];
   for(const row of tx.listRecord(p,'source_grant')){
    const grant=JSON.parse(row.data);if(grant.format!=='disclosure_grant_v1'||grant.scopeId!==scopeId)continue;
    try{const resolved=this.#resolve(tx,p,scopeId,to,{sourceId:grant.sourceId,grantId:row.id},now),offset=resolved.text.indexOf(query);
     if(offset>=0){const source=read<Source>(this.#record(tx,p,grant.sourceId,'source'));matches.push({sourceId:grant.sourceId,sourceVersion:resolved.part.sourceVersion,grantId:row.id,label:source.label,excerpt:resolved.text.slice(Math.max(0,offset-80),offset+query.length+160)});if(matches.length>=16)break;}
    }catch(error){if(!(error instanceof Error)||!error.message.startsWith('DISCLOSURE_'))throw error;}
   }return matches;
  });
 }
 /** Historical lineage is retained even when current permission is revoked.
  * Returns hashes/refs, never old source text or authority to disclose again. */
 traceAttempt(p:string,actor:string,attemptId:string){
  return this.store.read(tx=>{check(tx.getMembership(p,actor)?.role==='owner','ACTOR');const attempt=tx.native.getAttempt(p,attemptId);check(attempt&&tx.getScope(attempt.scopeId)?.principalId===p,'ATTEMPT');
   const binding=JSON.parse(attempt.binding);check(binding.disclosure?.id,'NO_DISCLOSURE_LINEAGE');
   const row=this.#record(tx,p,binding.disclosure.id,'context_manifest'),value=read<Manifest>(row),{digest:stored,...body}=value;
   check(row.revision===1n&&value.format==='disclosure_manifest_v1'&&stored===digest(body)&&binding.disclosure.digest===stored,'MANIFEST_CHANGED');
   return {attemptId,manifestId:row.id,inputDigest:value.inputDigest,parts:value.parts.map(part=>({...part})),state:attempt.state};
  });
 }
}
