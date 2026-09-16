import {randomUUID} from 'node:crypto';
import canonicalize from 'canonicalize';
import type {CodexTurnCoordinator} from '../../core/src/codex-turn.js';
import {validateNativePreparation,type NativePreparationReceipt} from '../../core/src/native-session-ingress.js';
import {inspectNativeJournal,type NativeJournalSeal} from './native-journal.js';
import {strictJson} from '../../contracts/src/wire.js';

/** Implemented by the fixed protected guest reader, never a renderer/file picker.
 * Reader verifies original VM/directory/source/ACL and closed writer before
 * supplying a snapshot. A hash or boolean from untrusted JSON is insufficient. */
export interface NativeJournalRecoveryPort {
 read():{preparation:NativePreparationReceipt;journal:Uint8Array;seal?:NativeJournalSeal;processExitObserved:boolean};
}
export function recoverNativeJournal(core:CodexTurnCoordinator,p:string,actor:string,id:string,port:NativeJournalRecoveryPort){
 const check=(value:unknown)=>{if(!value)throw Error('NATIVE_JOURNAL_RECOVERY_DENIED');};
 const source=structuredClone(port.read()),prepared=source.preparation;
 check(source.journal instanceof Uint8Array&&typeof source.processExitObserved==='boolean');
 // Historical validation at its own observation time, not a renewed send lease.
 validateNativePreparation(prepared,prepared.observedAt);
 const journal=inspectNativeJournal(source.journal,source.seal);
 const context=core.store.read(tx=>{
  check(tx.getMembership(p,actor)?.role==='owner');
  const a=tx.native.getAttempt(p,id);check(a&&['unknown','completed','interrupted','failed'].includes(a.state));
  const b=JSON.parse(a!.binding);check(b.mode==='provider');
  const session=tx.getRecordVersion(p,b.providerSessionVersion);check(session?.kind==='evidence');
  const raw=tx.getRecordVersion(p,JSON.parse(session!.data).preparationVersion);check(raw?.kind==='evidence'&&canonicalize(JSON.parse(raw!.data))===canonicalize(prepared));
  return {attempt:a!,binding:b,events:tx.native.events(p,id)};
 });
 const {attempt:a,binding:b}=context;
 const writes=journal.entries.filter(e=>e.kind==='outbound');
 if(journal.entries.length){
  check(journal.entries[0]!.kind==='outbound'&&writes.length>=1&&writes.length<=2);
  const start=strictJson(Buffer.from(writes[0]!.frame));check(start.ok);
  check(canonicalize(start.ok?start.value:null)===canonicalize({id:`start:${id}`,method:'turn/start',params:{threadId:a.threadId,input:[{type:'text',text:b.input,text_elements:[]}],model:b.model,effort:b.effort,environments:[],approvalPolicy:'never'}}));
  if(writes.length===2){
   const intent=context.events.find(e=>e.eventKey==='interrupt_intent');check(intent);
   const value=JSON.parse(intent!.payload),frame=strictJson(Buffer.from(writes[1]!.frame));check(frame.ok);
   check(canonicalize(frame.ok?frame.value:null)===canonicalize({id:`interrupt:${id}`,method:'turn/interrupt',params:{threadId:a.threadId,turnId:value.turnId}}));
  }
 }
 const reread=port.read();
 check(canonicalize({...reread,journal:Buffer.from(reread.journal).toString('base64')})===canonicalize({...source,journal:Buffer.from(source.journal).toString('base64')}));
 const version=core.store.transaction(tx=>{
  const evidenceId=randomUUID();tx.insertRecord({principalId:p,id:evidenceId,kind:'evidence',revision:1n,data:JSON.stringify({format:'native_journal_recovery_v1',attemptId:id,providerSessionVersion:b.providerSessionVersion,sealed:journal.integrity==='sealed',processExitObserved:source.processExitObserved===true,journalSha256:journal.sha256,journalBase64:Buffer.from(source.journal).toString('base64'),seal:source.seal??null,observedAt:core.clock()})});return tx.getRecord(p,evidenceId)!.versionId;
 });
 if(journal.integrity!=='sealed'||!source.processExitObserved||!writes.length)return {replayed:false,evidenceVersion:version,state:a.state};
 const result=core.observeRecoveredFrames(p,id,journal.entries.filter(e=>e.kind==='inbound').map(e=>Buffer.from(e.frame)),version);
 // Subscription hold resolution is separate and requires this evidence plus
 // the actual terminal. No automatic resend, acceptance or candidate execution.
 return {replayed:true,evidenceVersion:version,state:result.state};
}
