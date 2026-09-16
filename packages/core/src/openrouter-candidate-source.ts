import {createHash,randomUUID} from 'node:crypto';
import canonicalize from 'canonicalize';
import type {LedgerReader,LedgerStore,LedgerTransaction,StoredLedgerRecord} from '../../ledger/src/index.js';
import {DisclosureCoordinator,type DisclosureDestination} from './disclosure.js';
import {OpenRouterJournal} from './openrouter-journal.js';
import {openrouterLineage} from './openrouter-lineage.js';
import {moneyUnits,parseMoney} from './money.js';
import type {OpenRouterResponseExpectation} from './openrouter-response.js';

const sha=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const digest=(value:unknown)=>sha(canonicalize(value)!);
function check(value:unknown,reason:string):asserts value{if(!value)throw Error(`OPENROUTER_CANDIDATE_SOURCE_${reason}`);}

export interface OpenRouterCandidateSourceEvidence {
 readonly format:'openrouter_candidate_source_v1';
 readonly principalId:string;
 readonly actorId:string;
 readonly actorMembershipGeneration:string;
 readonly intentId:string;
 readonly missionId:string;
 readonly contractVersion:string;
 readonly witnessVersion:string;
 readonly observationVersion:string;
 readonly journalVersion:string;
 readonly settlementVersion:string;
 readonly requestDigest:string;
 readonly responseDigest:string;
 readonly textDigest:string;
 readonly sourceLineage:Readonly<{
  manifestId:string;
  inputDigest:string;
  sources:readonly Readonly<{id:string;version:string;digest:string}>[];
 }>;
 readonly capturedAt:number;
 readonly status:'unverified';
 readonly executionAuthorized:false;
}

export interface OpenRouterCandidateSourceResult {
 readonly id:string;
 readonly version:string;
 readonly evidence:Readonly<OpenRouterCandidateSourceEvidence>;
 readonly text:string;
 readonly status:'unverified';
 readonly executionAuthorized:false;
}

type Resolved={binding:Omit<OpenRouterCandidateSourceEvidence,'capturedAt'>;text:string};

/** Trusted Core read/import port. It accepts only ledger identities and rereads the
 * protected response journal; callers cannot supply text, response bodies or provenance.
 * The returned text is data for later candidate decoding, never adoption or execution. */
export class OpenRouterCandidateSource {
 constructor(readonly store:LedgerStore,readonly clock:()=>number=Date.now){}

 capture(p:string,actor:string,missionId:string,contractVersion:string,intentId:string):OpenRouterCandidateSourceResult{
  return this.store.transaction(tx=>{
   const resolved=this.#resolve(tx,p,actor,missionId,contractVersion,intentId);
   const key=`openrouter-candidate-source:${p}:${intentId}:${resolved.binding.observationVersion}`;
   const prior=tx.getMeta(key);
   if(prior){
    const row=this.#sourceRow(tx,p,prior),evidence=this.#evidence(row);
    this.#sameBinding(evidence,resolved.binding);
    return this.#result(row,evidence,resolved.text);
   }
   const capturedAt=this.#now(),id=randomUUID();
   const evidence:OpenRouterCandidateSourceEvidence={...resolved.binding,capturedAt};
   tx.insertRecord({principalId:p,id,kind:'evidence',revision:1n,data:JSON.stringify(evidence)});
   const row=tx.getRecord(p,id)!;
   tx.setMeta(key,id);
   tx.appendAudit({principalId:p,commandId:null,kind:'openrouter.candidate_source_captured',entityId:id,createdAt:new Date(capturedAt).toISOString()});
   return this.#result(row,this.#evidence(row),resolved.text);
  });
 }

 read(p:string,actor:string,missionId:string,contractVersion:string,id:string):OpenRouterCandidateSourceResult{
  return this.store.transaction(tx=>{
   const row=this.#sourceRow(tx,p,id),evidence=this.#evidence(row);
   check(evidence.missionId===missionId,'MISSION');
   check(evidence.contractVersion===contractVersion,'CONTRACT');
   const resolved=this.#resolve(tx,p,actor,missionId,contractVersion,evidence.intentId);
   this.#sameBinding(evidence,resolved.binding);
   return this.#result(row,evidence,resolved.text);
  });
 }

 #resolve(tx:LedgerTransaction,p:string,actor:string,missionId:string,contractVersion:string,intentId:string):Resolved{
  check(tx.getPrincipal(p),'PRINCIPAL');
  const member=tx.getMembership(p,actor);check(member?.role==='owner','ACTOR');
  const intentRow=tx.getRecord(p,intentId);check(intentRow?.kind==='intent','INTENT');
  const intent=JSON.parse(intentRow.data);
  check(intent.format==='openrouter_intent_v1'&&intent.route==='openrouter','INTENT');
  check(intent.missionId===missionId,'MISSION');
  check(intent.state==='completed'&&intent.outputState==='completed'&&intent.financialState==='settled'&&intent.cancellation==='not_requested'&&intent.wireClaimed===true,'STATE');
  check(intent.actorId===actor&&intent.membershipGeneration===String(member.generation),'ACTOR');
  check(typeof intent.requestDigest==='string'&&/^[a-f0-9]{64}$/.test(intent.requestDigest),'BINDING');

  const witnessRow=tx.getRecordVersion(p,intent.witnessVersion);check(witnessRow?.kind==='evidence'&&witnessRow.revision===1n,'WITNESS');
  const witness=JSON.parse(witnessRow.data);
  check(witness.format==='openrouter_action_witness_v1'&&witness.intentId===intentId&&witness.actorId===actor&&witness.membershipGeneration===String(member.generation),'ACTOR');
  check(witness.missionId===missionId,'MISSION');
  check(witness.contractVersion===contractVersion,'CONTRACT');
  check(witness.requestDigest===intent.requestDigest&&digest(witness)===intent.actionDigest,'BINDING');
  check(witness.destination?.provider==='openrouter'&&witness.destination.accountRoute===intent.accountRoute,'DESTINATION');
  const disclosure=new DisclosureCoordinator(this.store,this.clock).authorizeInTransaction(tx,p,actor,witness.manifestId,missionId,contractVersion,witness.destination as DisclosureDestination,witness.input);
  check(witness.disclosure&&canonicalize(disclosure)===canonicalize(witness.disclosure),'DISCLOSURE');

  const expectation=witness.responseExpectation as OpenRouterResponseExpectation|undefined;
  check(expectation&&Array.isArray(expectation.models)&&expectation.models.length>0&&Array.isArray(expectation.providerNames)&&expectation.providerNames.length>0,'EXPECTATION');
  let recovered:ReturnType<OpenRouterJournal['recoverInTransaction']>;
  try{recovered=new OpenRouterJournal(this.store,this.clock).recoverInTransaction(tx,p,actor,intentId,expectation);}
  catch{throw Error('OPENROUTER_CANDIDATE_SOURCE_JOURNAL');}
  check(recovered.outputState==='completed'&&typeof recovered.text==='string','OUTPUT');
  const observationRow=tx.getRecord(p,intent.observationId);check(observationRow?.kind==='evidence'&&observationRow.revision===1n,'OBSERVATION');
  const observation=JSON.parse(observationRow.data);
  check(observation.format==='openrouter_observation_v1'&&observation.intentId===intentId&&observation.witnessVersion===intent.witnessVersion,'OBSERVATION');
  check(observation.financialState==='unsettled'&&canonicalize(observation.response)===canonicalize(recovered),'OBSERVATION_BINDING');
  check(recovered.requestDigest===intent.requestDigest,'BINDING');
  const journalRow=tx.getRecord(p,recovered.receiptId);check(journalRow?.kind==='evidence'&&journalRow.revision===1n&&journalRow.versionId===recovered.evidenceVersion,'JOURNAL');

  const settlementRow=tx.getRecord(p,intent.costEventId);check(settlementRow?.kind==='cost_event'&&settlementRow.revision===1n,'SETTLEMENT');
  const settlement=JSON.parse(settlementRow.data);
  check(settlement.format==='openrouter_cost_event_v2'&&settlement.intentId===intentId&&settlement.accountRoute===intent.accountRoute&&settlement.generationId===recovered.generationId&&settlement.observationVersion===observationRow.versionId,'SETTLEMENT_BINDING');
  const chargeRow=tx.getRecordVersion(p,settlement.chargeVersion);check(chargeRow?.kind==='evidence'&&chargeRow.revision===1n,'CHARGE');
  const charge=JSON.parse(chargeRow.data);
  check(charge.format==='openrouter_charge_v2'&&charge.currency==='USD'&&charge.intentId===intentId&&charge.accountRoute===intent.accountRoute&&charge.generationId===recovered.generationId&&charge.observationVersion===observationRow.versionId,'CHARGE_BINDING');
  const charged=parseMoney('USD',charge.amountUsd);
  check(settlement.amountUsd===charge.amountUsd&&settlement.amount?.currency==='USD'&&moneyUnits(settlement.amount)===moneyUnits(charged),'CHARGE_BINDING');
  const obligationRow=tx.getRecord(p,intent.obligationId);check(obligationRow?.kind==='cost_obligation','OBLIGATION');
  const obligation=JSON.parse(obligationRow.data);
  check(obligation.format==='cash_obligation_v1'&&obligation.intentId===intentId&&obligation.settled===true&&obligation.held?.currency==='USD'&&moneyUnits(obligation.held)===0n&&obligation.booked?.currency==='USD'&&moneyUnits(obligation.booked)===moneyUnits(charged),'OBLIGATION');

  const sourceLineage=openrouterLineage(tx,p,intentId,intent);check(sourceLineage,'LINEAGE');
  const binding:Omit<OpenRouterCandidateSourceEvidence,'capturedAt'>={
   format:'openrouter_candidate_source_v1',principalId:p,actorId:actor,actorMembershipGeneration:String(member.generation),
   intentId,missionId,contractVersion,witnessVersion:witnessRow.versionId,observationVersion:observationRow.versionId,
   journalVersion:journalRow.versionId,settlementVersion:settlementRow.versionId,requestDigest:intent.requestDigest,
   responseDigest:recovered.responseDigest,textDigest:sha(recovered.text),sourceLineage:structuredClone(sourceLineage),
   status:'unverified',executionAuthorized:false,
  };
  return {binding,text:recovered.text};
 }

 #now():number{const now=this.clock();check(Number.isSafeInteger(now)&&now>=0,'CLOCK');return now;}
 #sourceRow(tx:LedgerReader,p:string,id:string):StoredLedgerRecord{
  const row=tx.getRecord(p,id);check(row?.kind==='evidence'&&row.revision===1n,'SOURCE');return row;
 }
 #evidence(row:StoredLedgerRecord):OpenRouterCandidateSourceEvidence{
  const value=JSON.parse(row.data) as OpenRouterCandidateSourceEvidence;
  const fields=['actorId','actorMembershipGeneration','capturedAt','contractVersion','executionAuthorized','format','intentId','journalVersion','missionId','observationVersion','principalId','requestDigest','responseDigest','settlementVersion','sourceLineage','status','textDigest','witnessVersion'];
  check(Object.keys(value).sort().join('|')===fields.join('|')&&value.format==='openrouter_candidate_source_v1','SOURCE_FORMAT');
  check(value.principalId===row.principalId&&Number.isSafeInteger(value.capturedAt)&&value.capturedAt>=0&&value.status==='unverified'&&value.executionAuthorized===false,'SOURCE_FORMAT');
  for(const hash of [value.requestDigest,value.responseDigest,value.textDigest])check(/^[a-f0-9]{64}$/.test(hash),'SOURCE_FORMAT');
  check(value.sourceLineage&&Array.isArray(value.sourceLineage.sources)&&value.sourceLineage.sources.length>0,'SOURCE_FORMAT');
  return value;
 }
 #sameBinding(evidence:OpenRouterCandidateSourceEvidence,binding:Resolved['binding']):void{
  const {capturedAt:_,...stored}=evidence;
  check(canonicalize(stored)===canonicalize(binding),'SOURCE_CHANGED');
 }
 #result(row:StoredLedgerRecord,evidence:OpenRouterCandidateSourceEvidence,text:string):OpenRouterCandidateSourceResult{
  check(sha(text)===evidence.textDigest,'TEXT_CHANGED');
  for(const source of evidence.sourceLineage.sources)Object.freeze(source);
  Object.freeze(evidence.sourceLineage.sources);Object.freeze(evidence.sourceLineage);Object.freeze(evidence);
  return Object.freeze({id:row.id,version:row.versionId,evidence,text,status:'unverified' as const,executionAuthorized:false as const});
 }
}
