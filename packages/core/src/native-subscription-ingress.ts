import {randomUUID} from 'node:crypto';
import canonicalize from 'canonicalize';
import type {LedgerStore} from '../../ledger/src/index.js';
import {validateNativePreparation,verifyNativeSessionPreparation,type NativePreparedConnection} from './native-session-ingress.js';
import {NativeSubscriptionCoordinator} from './native-subscription.js';

export interface NativeSubscriptionObservation {
 format:'native_subscription_observation_v1';sessionId:string;plan:'plus'|'pro';
 accountType:'chatgpt';paidCreditsAvailable:false;unlimitedCredits:false;creditBalance:'0';
 creditObservedAt:number;expiresAt:number;
}
export interface NativeSubscriptionConnection extends NativePreparedConnection {
 subscriptionObservation():Readonly<NativeSubscriptionObservation>;
}
/** Protected host ingress. Account observations do not prove configuration or
 * grant capability admission; independently checked no-extra-charge evidence
 * remains an explicit input. Never exposed to a renderer or provider. */
export function importNativeSubscription(store:LedgerStore,p:string,actor:string,scope:string,contractVersion:string,sessionVersion:string,noExtraChargeEvidenceVersion:string,connection:NativeSubscriptionConnection,clock:()=>number=Date.now):string{
 const check=(v:unknown)=>{if(!v)throw Error('NATIVE_SUBSCRIPTION_INGRESS_DENIED');};
 const prepared=validateNativePreparation(connection.preparation(),clock());
 const observation=structuredClone(connection.subscriptionObservation()),now=clock();
 check(Object.keys(observation).sort().join('|')==='accountType|creditBalance|creditObservedAt|expiresAt|format|paidCreditsAvailable|plan|sessionId|unlimitedCredits');
 check(observation.format==='native_subscription_observation_v1'&&observation.sessionId===prepared.sessionId&&['plus','pro'].includes(observation.plan)&&observation.accountType==='chatgpt');
 check(observation.paidCreditsAvailable===false&&observation.unlimitedCredits===false&&observation.creditBalance==='0');
 check(Number.isSafeInteger(observation.creditObservedAt)&&observation.creditObservedAt>=0&&observation.creditObservedAt<=prepared.observedAt&&now-observation.creditObservedAt<300000);
 check(observation.expiresAt===Math.min(prepared.expiresAt,observation.creditObservedAt+300000)&&now<observation.expiresAt);
 const accountVersion=store.transaction(tx=>{
  check(tx.getMembership(p,actor)?.role==='owner');
  const row=tx.getRecordVersion(p,sessionVersion);check(row?.kind==='evidence');
  const session=JSON.parse(row!.data);
  verifyNativeSessionPreparation(tx,p,session,now);
  check(session.actorId===actor&&session.scopeId===scope&&session.ownerId===store.ownerId&&session.ownerEpoch===String(store.ownerEpoch));
  check(session.sessionId===prepared.sessionId&&session.accountRoute===prepared.accountRoute&&session.profileDigest===prepared.profileDigest);
  const raw=tx.getRecordVersion(p,session.preparationVersion);check(raw&&canonicalize(JSON.parse(raw.data))===canonicalize(prepared));
  check(tx.getRecordVersion(p,noExtraChargeEvidenceVersion)?.kind==='evidence');
  check(canonicalize(connection.subscriptionObservation())===canonicalize(observation)&&canonicalize(validateNativePreparation(connection.preparation(),clock()))===canonicalize(prepared));
  const id=randomUUID();tx.insertRecord({principalId:p,id,kind:'evidence',revision:1n,data:JSON.stringify({...observation,sessionVersion,preparationVersion:session.preparationVersion})});
  return tx.getRecord(p,id)!.versionId;
 });
 // No acquisition here. A failure may leave observation evidence, never a Run,
 // hold, send intent or provider write. Core rechecks all guards at acquisition.
 validateNativePreparation(connection.preparation(),clock());
 return new NativeSubscriptionCoordinator(store,clock).recordEntitlement(p,actor,scope,contractVersion,{
  mode:'provider',provider:'codex',accountRoute:prepared.accountRoute,profileDigest:prepared.profileDigest,
  plan:observation.plan,accountType:'chatgpt',cashMode:'none',additionalCharges:'verified_absent',
  paidCreditsAvailable:false,unlimitedCredits:false,creditBalance:'0',apiFallbackEnabled:false,purchaseOperationsEnabled:false,
  noExtraChargeEvidenceVersion,accountEvidenceVersion:accountVersion,configurationEvidenceVersion:noExtraChargeEvidenceVersion,
  observedAt:observation.creditObservedAt,expiresAt:observation.expiresAt,
 });
}
