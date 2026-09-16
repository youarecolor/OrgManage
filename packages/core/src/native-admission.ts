import {createHash,randomUUID} from 'node:crypto';
import canonicalize from 'canonicalize';
import type {LedgerStore,LedgerReader,LedgerTransaction} from '../../ledger/src/index.js';

export interface NativeQualificationProfile {
 mode:'synthetic'|'provider'; provider:'codex'; purpose:'native_text_generation'|'native_candidate_execution';
 accountRoute:string; project:string; profileDigest:string; runnerDigest:string;
 adapterVersion:string; cliVersion:string; osVersion:string;
 operations:readonly string[];
}
const COMMON=['authentication','approval_mapping','effect_capture','cost_enforcement','quota_enforcement','cancel_request','cancel_observation','unknown_reconciliation','observation_coverage','disclosure','retention','environment_rights_capacity','host_isolation','secret_isolation','egress_boundary','child_process_stop','credential_separation','runner_lease','old_writer_exclusion','restart_reconciliation'] as const;
const EXECUTION=['input_snapshot','isolated_incoming','same_version_apply_verify_collect','immutable_blob_permissions'] as const;
const digest=(v:unknown)=>createHash('sha256').update(canonicalize(v)!).digest('hex');
function check(v:unknown,reason:string):asserts v{if(!v)throw Error('NATIVE_ADMISSION_'+reason);}
function label(v:unknown):asserts v is string{check(typeof v==='string'&&v.length>0&&Buffer.byteLength(v)<=256,'LABEL');}
function hash(v:unknown):asserts v is string{check(typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),'HASH');}
function profile(value:NativeQualificationProfile):NativeQualificationProfile{
 check(value&&(value.mode==='synthetic'||value.mode==='provider')&&value.provider==='codex','PROFILE');
 check(['native_text_generation','native_candidate_execution'].includes(value.purpose),'PURPOSE');
 for(const key of ['accountRoute','project','adapterVersion','cliVersion','osVersion'] as const)label(value[key]);
 hash(value.profileDigest);hash(value.runnerDigest);
 const operations=value.purpose==='native_text_generation'?['read_permitted_input','generate_text']:['read_permitted_input','generate_text','apply_candidate','build','test','collect'];
 check(Array.isArray(value.operations)&&canonicalize([...value.operations].sort())===canonicalize([...operations].sort()),'OPERATIONS');
 return {mode:value.mode,provider:'codex',purpose:value.purpose,accountRoute:value.accountRoute,project:value.project,profileDigest:value.profileDigest,runnerDigest:value.runnerDigest,adapterVersion:value.adapterVersion,cliVersion:value.cliVersion,osVersion:value.osVersion,operations};
}
/** Required capabilities are Core policy, never a caller-supplied list. */
export function requiredNativeCapabilities(value:NativeQualificationProfile):readonly string[]{const p=profile(value);return Object.freeze([...COMMON,...(p.purpose==='native_candidate_execution'?EXECUTION:[])]);}
export interface NativeCapabilityObservation {
 capability:string; mode:'synthetic'|'provider'; profileHash:string;
 status:'pass'|'fail'|'unknown'|'not_applicable'; observedAt:number; expiresAt:number;
 evidenceVersionId:string; inputDigest:string; expected:string; observed:string; limitations:string; invalidation:string;
}
type Authority={membership:string;scopes:{id:string;epoch:string}[]};
type Receipt=NativeCapabilityObservation&{format:'native_capability_v1';profileId:string;actorId:string;authority:Authority};
type Admission={format:'native_admission_v1';profileId:string;profileHash:string;actorId:string;scopeId:string;contractVersion:string;authority:Authority;receipts:{capability:string;versionId:string}[]};
export type NativeAdmissionTarget={mode:'synthetic'|'provider';accountRoute:string;profileDigest:string};
/** Protected qualification ingress. Only independent trusted probes may submit
 * observations; no renderer/candidate API, provider port or default registration.
 * Stored pass assertions are not themselves evidence that a real probe ran. */
export class NativeAdmissionCoordinator{
 constructor(readonly store:LedgerStore,readonly clock:()=>number=Date.now){}
 #now(){const n=this.clock();check(Number.isSafeInteger(n)&&n>=0,'CLOCK');return n;}
 #authority(tx:LedgerReader,p:string,actor:string,id:string):Authority{
  const member=tx.getMembership(p,actor);check(member?.role==='owner','ACTOR');
  const scopes:Authority['scopes']=[];let s=tx.getScope(id);check(s?.principalId===p&&s.kind==='mission','SCOPE');
  while(s){check(scopes.length<128&&!scopes.some(v=>v.id===s!.id)&&s.state==='active'&&(s.principalId===p||s.kind==='application'),'SCOPE_STOPPED');scopes.push({id:s.id,epoch:String(s.epoch)});if(s.parentId===null)break;s=tx.getScope(s.parentId);check(s,'ANCESTOR');}
  check(s.kind==='application','ROOT');return {membership:String(member.generation),scopes};
 }
 #evidence(tx:LedgerReader,p:string,versionId:string){const r=tx.getRecordVersion(p,versionId);check(r?.kind==='evidence','EVIDENCE');return JSON.parse(r.data);}
 #insert(tx:LedgerTransaction,p:string,data:object){const id=randomUUID();tx.insertRecord({principalId:p,id,kind:'evidence',revision:1n,data:JSON.stringify(data)});return tx.getRecord(p,id)!;}
 #profile(tx:LedgerReader,p:string,id:string){const r=tx.getRecord(p,id);check(r?.kind==='evidence','PROFILE_RECORD');const d=JSON.parse(r.data);check(d.format==='native_qualification_profile_v1','PROFILE_FORMAT');const value=profile(d.value);check(d.profileHash===digest(value),'PROFILE_HASH');return {...d,value} as {scopeId:string;actorId:string;authority:Authority;value:NativeQualificationProfile;profileHash:string};}
 #key(p:string,id:string,c:string){return `native-capability:${p}:${id}:${c}`;}
 registerProfile(p:string,actor:string,scopeId:string,value:NativeQualificationProfile):string{
  const fixed=profile(value);return this.store.transaction(tx=>{const authority=this.#authority(tx,p,actor,scopeId);return this.#insert(tx,p,{format:'native_qualification_profile_v1',scopeId,actorId:actor,authority,value:fixed,profileHash:digest(fixed)}).id;});
 }
 profileHash(p:string,id:string):string{return this.store.read(tx=>this.#profile(tx,p,id).profileHash);}
 observe(p:string,actor:string,profileId:string,value:NativeCapabilityObservation):string{
  const v=structuredClone(value);return this.store.transaction(tx=>{
   const d=this.#profile(tx,p,profileId),authority=this.#authority(tx,p,actor,d.scopeId),now=this.#now();
   check(actor===d.actorId&&canonicalize(authority)===canonicalize(d.authority),'AUTHORITY_CHANGED');
   check(requiredNativeCapabilities(d.value).includes(v.capability)&&v.profileHash===d.profileHash&&v.mode===d.value.mode,'OBSERVATION_BINDING');
   check(['pass','fail','unknown','not_applicable'].includes(v.status),'STATUS');
   check(Number.isSafeInteger(v.observedAt)&&v.observedAt>=0&&Number.isSafeInteger(v.expiresAt)&&v.observedAt<=now&&v.expiresAt>now&&v.expiresAt-v.observedAt<=86400000,'EXPIRY');
   hash(v.inputDigest);for(const k of ['expected','observed','limitations','invalidation'] as const)label(v[k]);this.#evidence(tx,p,v.evidenceVersionId);
   const key=this.#key(p,profileId,v.capability),previous=tx.getMeta(key);
   if(previous){const old=this.#evidence(tx,p,previous);check(old.format==='native_capability_v1'&&v.observedAt>=old.observedAt,'STALE_OBSERVATION');}
   const receipt:Receipt={...v,format:'native_capability_v1',profileId,actorId:actor,authority};const row=this.#insert(tx,p,receipt);tx.setMeta(key,row.versionId);return row.versionId;
  });
 }
 #verify(tx:LedgerTransaction,p:string,actor:string,scopeId:string,contractVersion:string,profileId:string,target:NativeAdmissionTarget){
  this.store.assertTransaction(tx);const d=this.#profile(tx,p,profileId),authority=this.#authority(tx,p,actor,scopeId),now=this.#now();
  check(d.scopeId===scopeId&&d.actorId===actor&&canonicalize(d.authority)===canonicalize(authority),'AUTHORITY_CHANGED');
  const mission=tx.getRecord(p,scopeId),contract=tx.getRecordVersion(p,contractVersion);check(mission?.kind==='mission'&&JSON.parse(mission.data).contractRef===contractVersion&&contract?.kind==='contract','CONTRACT_CHANGED');
  const c=JSON.parse(contract.data);check(c.scopeId===scopeId&&c.nativeProfileId===profileId,'CONTRACT_PROFILE');
  check(target.mode===d.value.mode&&target.accountRoute===d.value.accountRoute&&target.profileDigest===d.value.profileDigest,'TARGET');
  const receipts=requiredNativeCapabilities(d.value).map(capability=>{
   const versionId=tx.getMeta(this.#key(p,profileId,capability));check(versionId,'MISSING_CAPABILITY');const r=this.#evidence(tx,p,versionId) as Receipt;
   check(r.format==='native_capability_v1'&&r.profileId===profileId&&r.profileHash===d.profileHash&&r.capability===capability&&r.mode===target.mode,'RECEIPT_BINDING');
   check(r.status==='pass','CAPABILITY_NOT_PASSED');check(now>=r.observedAt&&now<r.expiresAt,'CAPABILITY_EXPIRED');
   check(r.actorId===actor&&canonicalize(r.authority)===canonicalize(authority),'RECEIPT_AUTHORITY');this.#evidence(tx,p,r.evidenceVersionId);
   return {capability,versionId};
  });
  return {format:'native_admission_v1' as const,profileId,profileHash:d.profileHash,actorId:actor,scopeId,contractVersion,authority,receipts};
 }
 prepareInTransaction(tx:LedgerTransaction,p:string,actor:string,scopeId:string,contractVersion:string,profileId:string,target:NativeAdmissionTarget):Readonly<{id:string;digest:string}>{
  const value=this.#verify(tx,p,actor,scopeId,contractVersion,profileId,target),row=this.#insert(tx,p,value);return {id:row.id,digest:digest(value)};
 }
 authorizeInTransaction(tx:LedgerTransaction,p:string,actor:string,scopeId:string,contractVersion:string,id:string,target:NativeAdmissionTarget):Readonly<{id:string;digest:string}>{
  this.store.assertTransaction(tx);const row=tx.getRecord(p,id);check(row?.kind==='evidence','ADMISSION_RECORD');const value=JSON.parse(row.data) as Admission;check(value.format==='native_admission_v1','ADMISSION_FORMAT');
  const current=this.#verify(tx,p,actor,scopeId,contractVersion,value.profileId,target);check(canonicalize(current)===canonicalize(value),'RECEIPT_CHANGED');return {id,digest:digest(value)};
 }
}
