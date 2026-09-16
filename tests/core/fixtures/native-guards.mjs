import {createHash} from 'node:crypto';
import {fixture,post,randomUUID,update} from './helpers.mjs';
import {ResourceCoordinator} from '../../../dist/core/src/resources.js';
import {DisclosureCoordinator} from '../../../dist/core/src/disclosure.js';
import {NativeCashCoordinator} from '../../../dist/core/src/native-cash.js';
export async function nativeGuards(t,quoteChanges={},initialNow){
 const f=await fixture(t);if(initialNow)f.now=new Date(initialNow);
 const mission=post(f).mission,contract=randomUUID(),evidenceId=randomUUID();
 f.store.transaction(tx=>{tx.insertRecord({principalId:f.principal,id:contract,kind:'contract',revision:1n,data:JSON.stringify({mode:'codex_protocol_rehearsal',scopeId:mission.id})});tx.insertRecord({principalId:f.principal,id:evidenceId,kind:'evidence',revision:1n,data:'{"kind":"synthetic-billing-only"}'});});
 const contractVersion=f.store.read(tx=>tx.getRecord(f.principal,contract).versionId);update(f,mission.id,m=>({...m,contractRef:contractVersion}));
 const disclosure=new DisclosureCoordinator(f.store,()=>f.now.getTime()),cash=new NativeCashCoordinator(f.store,()=>f.now.getTime());
 const to={provider:'codex',accountRoute:'test-account',profileDigest:'d'.repeat(64)},input='Fixed synthetic input 日本語.';
 const source=disclosure.registerSource(f.principal,f.actor,mission.id,'fixture',input),grant=disclosure.grant(f.principal,f.actor,source,to,f.now.getTime()+60000),manifestId=disclosure.createManifest(f.principal,f.actor,mission.id,contractVersion,to,[{sourceId:source,grantId:grant}]);
 const pool={kind:'quota',provider:'codex',account:'test-account',pool:'test',unit:'test-units',freshnessMs:300000,windows:[{id:'short',revision:'1',startsAt:f.now.getTime()-1,resetsAt:f.now.getTime()+600000}]},resource=new ResourceCoordinator(f.store,pool,()=>f.now.getTime());
 resource.observe(f.principal,f.actor,[{windowId:'short',revision:'1',remaining:'10',observedAt:f.now.getTime(),evidenceId,reflectedHoldIds:[]}]);
 const evidenceVersionId=f.store.read(tx=>tx.getRecord(f.principal,evidenceId).versionId);
 const request={mode:'synthetic',principalId:f.principal,actorId:f.actor,scopeId:mission.id,contractVersion,accountRoute:to.accountRoute,model:'test',effort:'low',input,threadId:'thread',profileDigest:to.profileDigest,expiresAt:f.now.getTime()+60000};
 const quote={mode:'synthetic',...to,model:request.model,effort:request.effort,inputDigest:createHash('sha256').update(input).digest('hex'),maximumYen:'200',currency:'JPY',taxIncluded:true,observedAt:f.now.getTime(),expiresAt:f.now.getTime()+30000,evidenceVersionId,...quoteChanges};
 const quoteId=cash.recordQuote(f.principal,f.actor,mission.id,contractVersion,quote),guards={resource,amounts:{short:'1'},disclosure,manifestId,cash,quoteId};
 const prepare=()=>f.core.codex.prepareWithGuards(request,guards);
 const send=r=>f.core.codex.acquireStartWithGuards(f.principal,r.attempt.id,{...guards,holdId:r.holdId,cashHoldId:r.cashHoldId});
 const state=r=>f.store.read(tx=>({native:tx.native.getAttempt(f.principal,r.attempt.id),quota:tx.getRecord(f.principal,r.holdId),cash:tx.getRecord(f.principal,r.cashHoldId),audits:tx.listAudit(f.principal)}));
 return {f,mission,contractVersion,evidenceId,evidenceVersionId,disclosure,source,grant,resource,pool,cash,quote,quoteId,request,guards,prepare,send,state};
}
