import {nativeGuards} from './native-guards.mjs';
import {randomUUID,update,request,bytes,snap} from './helpers.mjs';
import {NativeAdmissionCoordinator,requiredNativeCapabilities} from '../../../dist/core/src/native-admission.js';
import {NativeSubscriptionCoordinator} from '../../../dist/core/src/native-subscription.js';
import {NativeSessionIngress} from '../../../dist/core/src/native-session-ingress.js';
export async function nativeSubscription(t,changes={},initialNow,fixtureMode='synthetic',profileChanges={}){
 if(!['synthetic','provider'].includes(fixtureMode))throw Error('fixture mode');
 const x=await nativeGuards(t,{},initialNow),{f}=x;
 const admission=new NativeAdmissionCoordinator(f.store,()=>f.now.getTime()),subscription=new NativeSubscriptionCoordinator(f.store,()=>f.now.getTime());
 x.request.mode=fixtureMode;
 const profile={mode:fixtureMode,provider:'codex',purpose:'native_text_generation',accountRoute:x.request.accountRoute,project:'synthetic',profileDigest:x.request.profileDigest,runnerDigest:'e'.repeat(64),adapterVersion:'fixture-1',cliVersion:'fixture-1',osVersion:'fixture-1',operations:['read_permitted_input','generate_text'],...profileChanges};
 const profileId=admission.registerProfile(f.principal,f.actor,x.mission.id,profile),contractId=randomUUID();
 f.store.transaction(tx=>tx.insertRecord({principalId:f.principal,id:contractId,kind:'contract',revision:1n,data:JSON.stringify({mode:fixtureMode==='provider'?'codex_native_text':'codex_protocol_rehearsal',scopeId:x.mission.id,nativeProfileId:profileId,nativeActionApprovalRequired:true,nativeBudgetMode:'subscription_no_extra'})}));
 const contractVersion=f.store.read(tx=>tx.getRecord(f.principal,contractId).versionId);update(f,x.mission.id,v=>({...v,contractRef:contractVersion}));x.request.contractVersion=contractVersion;
 const manifestId=x.disclosure.createManifest(f.principal,f.actor,x.mission.id,contractVersion,{provider:'codex',accountRoute:x.request.accountRoute,profileDigest:x.request.profileDigest},[{sourceId:x.source,grantId:x.grant}]);
 const observation=capability=>({mode:fixtureMode,profileHash:admission.profileHash(f.principal,profileId),capability,status:'pass',observedAt:f.now.getTime(),expiresAt:f.now.getTime()+60000,evidenceVersionId:x.evidenceVersionId,inputDigest:'a'.repeat(64),expected:'synthetic expected',observed:'synthetic observed',limitations:'synthetic only, not live admission',invalidation:'configuration/version/authority changes'});
 for(const c of requiredNativeCapabilities(profile))admission.observe(f.principal,f.actor,profileId,observation(c));
 const entitlementValue={mode:fixtureMode,provider:'codex',accountRoute:x.request.accountRoute,profileDigest:x.request.profileDigest,plan:'pro',accountType:'chatgpt',cashMode:'none',additionalCharges:'verified_absent',paidCreditsAvailable:false,unlimitedCredits:false,creditBalance:'0',apiFallbackEnabled:false,purchaseOperationsEnabled:false,noExtraChargeEvidenceVersion:x.evidenceVersionId,accountEvidenceVersion:x.evidenceVersionId,configurationEvidenceVersion:x.evidenceVersionId,observedAt:f.now.getTime(),expiresAt:f.now.getTime()+30000,...changes};
 const entitlementId=subscription.recordEntitlement(f.principal,f.actor,x.mission.id,contractVersion,entitlementValue),guards={subscription,entitlementId,maxDurationMs:10000,disclosure:x.disclosure,manifestId,admission,profileId,actions:f.core.nativeActions};
 let sessionValue;
 if(fixtureMode==='provider'){
  // Modeled provider evidence only. No process, VM or external service is used by this fixture.
  const prepared={format:'native_preparation_v1',mode:'provider',stage:'ready',closed:false,turnsSent:0,accountRoute:x.request.accountRoute,profileDigest:x.request.profileDigest,model:x.request.model,effort:x.request.effort,threadId:x.request.threadId,sessionId:'9'.repeat(64),observedAt:f.now.getTime(),expiresAt:f.now.getTime()+30000,maxTurns:1,toolsEnabled:false,apiFallbackEnabled:false,purchaseOperationsEnabled:false,helper:{processId:123,startTicks:'639249846085978446',sourceDigest:'a'.repeat(64)},guest:{vmId:'12345678-1234-1234-1234-123456789abc',processId:456,runnerDigest:'b'.repeat(64),cliDigest:'c'.repeat(64)}};
  x.request.sessionEvidenceVersion=new NativeSessionIngress(f.store,()=>f.now.getTime()).import(f.principal,f.actor,x.mission.id,{preparation:()=>prepared});
  sessionValue=f.store.read(tx=>JSON.parse(tx.getRecordVersion(f.principal,x.request.sessionEvidenceVersion).data));
 }
 const prepare=()=>fixtureMode==='provider'?f.core.codex.prepareProviderWithSubscription(x.request,guards):f.core.codex.prepareWithSubscription(x.request,guards),send=r=>fixtureMode==='provider'?f.core.codex.acquireProviderStartWithSubscription(f.principal,r.attempt.id,{...guards,holdId:r.holdId}):f.core.codex.acquireStartWithSubscription(f.principal,r.attempt.id,{...guards,holdId:r.holdId});
 const approval=r=>snap(f).approvals.find(a=>a.id===r.approvalId);
 const decide=(r,choice='approve')=>{const a=approval(r);return f.core.command(f.session,bytes(request('approval.decide',a.id,a.revision,{action_digest:a.actionDigest,explanation_revision:a.explanationRevision,choice,comment:'subscription fixture only'})));};
 const state=r=>f.store.read(tx=>({attempt:tx.native.getAttempt(f.principal,r.attempt.id),hold:tx.getRecord(f.principal,r.holdId),approval:tx.getRecord(f.principal,r.approvalId),mission:tx.getRecord(f.principal,x.mission.id),audits:tx.listAudit(f.principal)}));
 return {...x,sessionValue,admission,subscription,profileId,observation,entitlementId,entitlementValue,guards,prepare,send,approval,decide,state};
}
