import canonicalize from 'canonicalize';
import type {OrgManageCore} from '../../core/src/index.js';
import {NativeSessionIngress} from '../../core/src/native-session-ingress.js';
import {importNativeSubscription,type NativeSubscriptionConnection} from '../../core/src/native-subscription-ingress.js';
import {NativeSubscriptionCoordinator} from '../../core/src/native-subscription.js';
import {NativeAdmissionCoordinator} from '../../core/src/native-admission.js';
import {DisclosureCoordinator} from '../../core/src/disclosure.js';
import {NativeProviderDispatch} from '../../core/src/native-provider-dispatch.js';
import {NativeBridgeChannel,type NativeBridgeConnection} from './native-channel.js';

export interface NativeExecutionScope {
 principalId:string;actorId:string;scopeId:string;contractVersion:string;
 profileId:string;noExtraChargeEvidenceVersion:string;
 sources:readonly {sourceId:string;grantId:string}[];
 input:string;maxDurationMs:number;
}
type Connection=NativeSubscriptionConnection&NativeBridgeConnection;
type Prepared=ReturnType<OrgManageCore['codex']['prepareProviderWithSubscription']>;
/** Single live connection from preparation through observed closure. This
 * trusted host port does not grant disclosure, assert qualifications or approve
 * actions. Those must already exist for this exact scope/profile/destination.
 * No candidate, renderer or provider may supply the connection or evidence IDs. */
export class NativeExecution {
 readonly #scope:NativeExecutionScope;
 #prepared:Prepared|undefined;#dispatch:NativeProviderDispatch|undefined;
 #guards:Parameters<OrgManageCore['codex']['prepareProviderWithSubscription']>[1]|undefined;
 #preparation:ReturnType<Connection['preparation']>|undefined;
 #claimed=false;#started=false;
 constructor(readonly core:OrgManageCore,scope:NativeExecutionScope,readonly connection:Connection){this.#scope=structuredClone(scope);}
 prepare():Prepared{
  if(this.#claimed)throw Error('NATIVE_EXECUTION_ALREADY_CLAIMED');this.#claimed=true;
  const s=this.#scope,store=this.core.codex.store,clock=this.core.codex.clock;
  try{
   const prepared=this.connection.preparation();this.#preparation=structuredClone(prepared);
   const profile=store.read(tx=>tx.getRecord(s.principalId,s.profileId));
   if(profile?.kind!=='evidence')throw Error('NATIVE_EXECUTION_PROFILE_MISSING');
   const qualification=JSON.parse(profile.data);
   if(qualification.format!=='native_qualification_profile_v1'||qualification.value.mode!=='provider'||qualification.value.adapterVersion!==prepared.helper.sourceDigest||qualification.value.runnerDigest!==prepared.guest.runnerDigest)throw Error('NATIVE_EXECUTION_PROFILE_SOURCE_CHANGED');
   const sessionEvidenceVersion=new NativeSessionIngress(store,clock).import(s.principalId,s.actorId,s.scopeId,this.connection);
   const entitlementId=importNativeSubscription(store,s.principalId,s.actorId,s.scopeId,s.contractVersion,sessionEvidenceVersion,s.noExtraChargeEvidenceVersion,this.connection,clock);
   const disclosure=new DisclosureCoordinator(store,clock);
   const manifestId=disclosure.createManifest(s.principalId,s.actorId,s.scopeId,s.contractVersion,{provider:'codex',accountRoute:prepared.accountRoute,profileDigest:prepared.profileDigest},[...s.sources]);
   this.#guards={subscription:new NativeSubscriptionCoordinator(store,clock),entitlementId,maxDurationMs:s.maxDurationMs,disclosure,manifestId,admission:new NativeAdmissionCoordinator(store,clock),profileId:s.profileId,actions:this.core.nativeActions};
   this.#prepared=this.core.codex.prepareProviderWithSubscription({principalId:s.principalId,actorId:s.actorId,scopeId:s.scopeId,contractVersion:s.contractVersion,input:s.input,mode:'provider',accountRoute:prepared.accountRoute,model:prepared.model,effort:prepared.effort,threadId:prepared.threadId,profileDigest:prepared.profileDigest,expiresAt:prepared.expiresAt,sessionEvidenceVersion},this.#guards);
   return structuredClone(this.#prepared);
  }catch(error){this.connection.disconnect();throw error;}
 }
 /** Invoke after the existing Core ActionApproval has been decided. Acquisition
  * rechecks current scope, evidence, disclosure and approval in one transaction. */
 start():void{
  if(this.#started||!this.#prepared||!this.#guards||!this.#preparation)throw Error('NATIVE_EXECUTION_NOT_PREPARED');
  this.#started=true;
  try{
   if(canonicalize(this.connection.preparation())!==canonicalize(this.#preparation))throw Error('NATIVE_EXECUTION_CONNECTION_CHANGED');
   const {sessionId,threadId,accountRoute,profileDigest,model,effort}=this.#preparation;
   const channel=new NativeBridgeChannel({sessionId,threadId,accountRoute,profileDigest,model,effort},this.connection);
   this.#dispatch=new NativeProviderDispatch(this.core.codex,this.#scope.principalId,this.#prepared.attempt.id,{...this.#guards,holdId:this.#prepared.holdId},channel);
   this.#dispatch.start();
  }catch(error){this.connection.disconnect();throw error;}
 }
 requestStop():void{if(!this.#dispatch)throw Error('NATIVE_EXECUTION_NOT_STARTED');this.#dispatch.requestStop();}
 get state(){return {prepared:!!this.#prepared,started:this.#started,dispatch:this.#dispatch?.state??null};}
}
