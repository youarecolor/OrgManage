import type {LedgerReader,CandidateBaseRecord} from '../../ledger/src/index.js';
export function candidateContract(tx:LedgerReader,p:string,missionId:string){
 const mission=tx.getRecord(p,missionId);
 if(mission?.kind!=='mission')throw Error('CANDIDATE_CONTRACT_MISSING');
 const data=JSON.parse(mission.data),ref=data.contractRef;
 if(typeof ref!=='string'||data.pendingContractRef)throw Error('CANDIDATE_CONTRACT_CHANGED');
 const head=tx.getRecord(p,ref),version=tx.getRecordVersion(p,ref),record=head??version;
 if(record?.kind!=='contract'||(head&&version&&head.versionId!==version.versionId)||tx.getRecord(p,record.id)?.versionId!==record.versionId)throw Error('CANDIDATE_CONTRACT_CHANGED');
 return {ref,id:record.id,versionId:record.versionId};
}
export function assertCandidateContract(tx:LedgerReader,p:string,base:Readonly<CandidateBaseRecord>){
 const current=candidateContract(tx,p,base.missionId),evidence=tx.getRecord(p,base.id);
 if(evidence?.kind!=='evidence')throw Error('CANDIDATE_CONTRACT_MISSING');
 const saved=JSON.parse(evidence.data).contractBinding;
 if(current.id!==base.contractId)throw Error('CANDIDATE_CONTRACT_CHANGED');
 // Existing bases predate immutable-version binding. Preserve their ID semantics;
 // never allow an old ID-only base to acquire a new version-reference authority.
 if(saved===undefined){if(current.ref!==base.contractId)throw Error('CANDIDATE_CONTRACT_CHANGED');}
 else if(JSON.stringify(saved)!==JSON.stringify(current))throw Error('CANDIDATE_CONTRACT_CHANGED');
 return current;
}
