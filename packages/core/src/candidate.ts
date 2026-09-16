import { createHash, randomUUID } from 'node:crypto';
import type { LedgerStore, LedgerReader, CandidateBaseRecord, CandidateProposalRecord } from '../../ledger/src/index.js';
import { candidateSnapshotBytes, importCandidatePatch, reopenCandidateSnapshot } from '../../runner/src/candidate.js';
import type { CandidateSnapshot, CandidateProposal } from '../../runner/src/candidate.js';
import {prepareNativeCandidate,reopenNativeCandidateSource} from '../../runner/src/native-candidate.js';
import type {NativeCandidateSource} from '../../runner/src/native-candidate.js';
import {candidateContract,assertCandidateContract} from './candidate-contract.js';

const hash = (v: Uint8Array | string) => createHash('sha256').update(v).digest('hex');
function check(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }
export interface StoredCandidateProposal {
  readonly record: Readonly<CandidateProposalRecord>;
  readonly proposal: CandidateProposal;
  /** Exact admitted wire, including whitespace. Trusted transport data, never a renderer field. */
  readonly patchBase64: string;
  readonly textSource?: Readonly<NativeCandidateSource>;
  readonly status: 'unverified';
}
/** Trusted core integration port, not a renderer command or an execution/adoption permission. */
export class CandidateCoordinator {
  constructor(readonly store: LedgerStore, readonly clock: () => number = () => Date.now()) {}
  #now(): number { const value=this.clock();check(Number.isSafeInteger(value)&&value>=0,'INVALID_CLOCK');return value; }
  #member(tx: LedgerReader, p: string, actor: string): string {
    const member=tx.getMembership(p,actor);check(member?.role==='owner','CANDIDATE_ACTOR_DENIED');return String(member.generation);
  }
  #authority(tx: LedgerReader, actor: string, snapshot: CandidateSnapshot, now: number): string {
    const b=snapshot.binding, memberGeneration=this.#member(tx,b.principalId,actor);
    let scope=tx.getScope(b.missionId);
    check(scope?.kind==='mission'&&scope.principalId===b.principalId,'CANDIDATE_MISSION_DENIED');
    const scopes:{id:string;epoch:string}[]=[],seen=new Set<string>();
    while(scope){
      check(!seen.has(scope.id)&&seen.size<128&&scope.state==='active'&&(scope.principalId===b.principalId||scope.kind==='application'),'CANDIDATE_SCOPE_STOPPED');
      seen.add(scope.id);scopes.push({id:scope.id,epoch:String(scope.epoch)});
      if(scope.parentId===null)break;
      scope=tx.getScope(scope.parentId);check(scope,'CANDIDATE_ANCESTOR_MISSING');
    }
    const lease=tx.runner.getLease(b.principalId,b.leaseId),workspace=tx.runner.getWorkspace(b.principalId,b.workspaceId);
    check(lease&&workspace&&lease.actorId===actor&&lease.scopeId===b.missionId&&lease.workspaceId===b.workspaceId
      &&String(lease.generation)===b.generation&&workspace.generation===lease.generation&&workspace.state==='ready'
      &&lease.state==='active'&&!lease.dispatched&&lease.stopEpoch===0n&&lease.ownerId===this.store.ownerId
      &&lease.ownerEpoch===this.store.ownerEpoch&&now>=lease.updatedAt&&now<lease.expiresAt,'CANDIDATE_LEASE_DENIED');
    check(workspace.profileDigest===b.profileDigest&&workspace.snapshotDigest===snapshot.treeDigest
      &&workspace.writeSetDigest===hash(JSON.stringify(snapshot.writeSet)),'CANDIDATE_WORKSPACE_MISMATCH');
    const captured=tx.getRecord(b.principalId,b.leaseId);
    check(captured?.kind==='evidence'&&captured.data===JSON.stringify({version:'runner-authority-v1',actorGeneration:memberGeneration,scopeEpochs:scopes}),'CANDIDATE_AUTHORITY_CHANGED');
    const mission=tx.getRecord(b.principalId,b.missionId),command=tx.getCommand(b.principalId,b.commandId);
    check(mission?.kind==='mission'&&command&&JSON.parse(command.receipt).result_ref===b.missionId,'CANDIDATE_SOURCE_COMMAND_MISMATCH');
    return candidateContract(tx,b.principalId,b.missionId).id;
  }
  capture(actor: string, snapshot: CandidateSnapshot): Readonly<CandidateBaseRecord> {
    // Hash/serialization on sealed, immutable data outside the write transaction.
    const bytes=candidateSnapshotBytes(snapshot);
    return this.store.transaction(tx=>{
      const now=this.#now(),contractId=this.#authority(tx,actor,snapshot,now),b=snapshot.binding;
      const old=tx.candidate.baseForLease(b.principalId,b.leaseId);
      if(old){check(old.snapshotDigest===snapshot.digest&&old.contractId===contractId,'CANDIDATE_BASE_CONFLICT');assertCandidateContract(tx,b.principalId,old);return Object.freeze(old);}
      const data=JSON.stringify({format:'candidate_base_v1',snapshot:JSON.parse(Buffer.from(bytes).toString('utf8')),contractBinding:candidateContract(tx,b.principalId,b.missionId)});
      const row:CandidateBaseRecord={principalId:b.principalId,id:randomUUID(),missionId:b.missionId,commandId:b.commandId,contractId,
        leaseId:b.leaseId,workspaceId:b.workspaceId,generation:BigInt(b.generation),profileDigest:b.profileDigest,
        snapshotDigest:snapshot.digest,treeDigest:snapshot.treeDigest,writeSetDigest:hash(JSON.stringify(snapshot.writeSet)),createdAt:now};
      tx.insertRecord({principalId:b.principalId,id:row.id,kind:'evidence',revision:1n,data});tx.candidate.insertBase(row);
      tx.appendAudit({principalId:b.principalId,commandId:b.commandId,kind:'candidate.base_captured',entityId:row.id,createdAt:new Date(now).toISOString()});
      return Object.freeze(row);
    });
  }
  #base(tx: LedgerReader, p: string, id: string): {record: CandidateBaseRecord; snapshot: CandidateSnapshot} {
    const record=tx.candidate.getBase(p,id),data=tx.getRecord(p,id);
    check(record&&data?.kind==='evidence','CANDIDATE_BASE_UNAVAILABLE');
    const content=JSON.parse(data.data);check(content.format==='candidate_base_v1','CANDIDATE_BASE_UNAVAILABLE');
    const snapshot=reopenCandidateSnapshot(Buffer.from(JSON.stringify(content.snapshot)),record.snapshotDigest);
    check(snapshot.binding.principalId===p&&snapshot.binding.commandId===record.commandId&&snapshot.binding.leaseId===record.leaseId
      &&snapshot.binding.missionId===record.missionId&&snapshot.binding.workspaceId===record.workspaceId
      &&snapshot.binding.generation===String(record.generation)&&snapshot.binding.profileDigest===record.profileDigest
      &&snapshot.treeDigest===record.treeDigest&&hash(JSON.stringify(snapshot.writeSet))===record.writeSetDigest,'CANDIDATE_BASE_UNAVAILABLE');
    return {record,snapshot};
  }
  importPatch(actor: string, p: string, baseId: string, wire: Uint8Array): Readonly<CandidateProposalRecord> {
    check(wire instanceof Uint8Array&&!(wire.buffer instanceof SharedArrayBuffer)&&wire.byteLength<=256*1024,'CANDIDATE_PATCH_BOUND');
    const bytes=Buffer.from(wire);
    return this.#import(actor,p,baseId,()=>({bytes}));
  }
  /** Trusted data import only. The expected request digest must come from the saved request,
   * not the model reply. This does not attest provider origin or permit execution. */
  importNativeEdit(actor:string,p:string,baseId:string,requestWire:Uint8Array,expectedRequestDigest:string,responseWire:Uint8Array):Readonly<CandidateProposalRecord> {
    for(const wire of [requestWire,responseWire])check(wire instanceof Uint8Array&&!(wire.buffer instanceof SharedArrayBuffer)&&wire.byteLength<=16384,'CANDIDATE_NATIVE_BOUND');
    const requestBytes=Buffer.from(requestWire),responseBytes=Buffer.from(responseWire);
    return this.#import(actor,p,baseId,snapshot=>{
      const prepared=prepareNativeCandidate(snapshot,requestBytes,expectedRequestDigest,responseBytes);
      return {bytes:Buffer.from(prepared.patchBase64,'base64'),textSource:prepared.source};
    });
  }
  #import(actor:string,p:string,baseId:string,produce:(snapshot:CandidateSnapshot)=>{bytes:Buffer;textSource?:Readonly<NativeCandidateSource>}):Readonly<CandidateProposalRecord> {
    const base=this.store.read(tx=>{this.#member(tx,p,actor);return this.#base(tx,p,baseId);});
    const {bytes,textSource}=produce(base.snapshot);
    const proposed=importCandidatePatch(base.snapshot,bytes);
    // Keep the existing SQL-bound candidate envelope; the optional source has its
    // own version and grants no new candidate/evaluation authority.
    const data=JSON.stringify({format:'candidate_proposal_v1',after:proposed.after,patchBase64:bytes.toString('base64'),...(textSource?{textSource}: {})});
    return this.store.transaction(tx=>{
      const now=this.#now(),contractId=this.#authority(tx,actor,base.snapshot,now);
      check(contractId===base.record.contractId,'CANDIDATE_CONTRACT_CHANGED');
      assertCandidateContract(tx,p,base.record);
      const current=tx.candidate.getBase(p,baseId);check(current?.snapshotDigest===base.record.snapshotDigest,'CANDIDATE_BASE_CHANGED');
      const old=tx.candidate.proposalForBase(p,baseId);
      if(old){
        check(old.patchDigest===proposed.patchDigest,'CANDIDATE_PATCH_CONFLICT');
        const prior=tx.getRecord(p,old.id);check(prior?.kind==='evidence'&&prior.data===data,'CANDIDATE_SOURCE_CONFLICT');
        return Object.freeze(old);
      }
      const row:CandidateProposalRecord={principalId:p,id:randomUUID(),baseId,patchDigest:proposed.patchDigest,
        afterDigest:proposed.after.digest,afterTreeDigest:proposed.after.treeDigest,createdAt:now};
      tx.insertRecord({principalId:p,id:row.id,kind:'evidence',revision:1n,data});tx.candidate.insertProposal(row);
      tx.appendAudit({principalId:p,commandId:base.record.commandId,kind:'candidate.data_imported_unverified',entityId:row.id,createdAt:new Date(now).toISOString()});
      return Object.freeze(row);
    });
  }
  readProposal(actor: string, p: string, id: string): StoredCandidateProposal {
    const stored=this.store.read(tx=>{
      this.#member(tx,p,actor);
      const record=tx.candidate.getProposal(p,id),data=tx.getRecord(p,id);check(record&&data?.kind==='evidence','CANDIDATE_PROPOSAL_UNAVAILABLE');
      return {record,content:JSON.parse(data.data),base:this.#base(tx,p,record.baseId)};
    });
    const {record,content,base}=stored;
    check(content.format==='candidate_proposal_v1'&&typeof content.patchBase64==='string'&&content.patchBase64.length<=349528,'CANDIDATE_PROPOSAL_UNAVAILABLE');
    const hasTextSource=Object.hasOwn(content,'textSource');
    const expectedFields=hasTextSource?['format','after','patchBase64','textSource']:['format','after','patchBase64'];
    check(Object.keys(content).sort().join('|')===expectedFields.sort().join('|'),'CANDIDATE_PROPOSAL_FIELDS');
    const bytes=Buffer.from(content.patchBase64,'base64');check(bytes.toString('base64')===content.patchBase64&&hash(bytes)===record.patchDigest,'CANDIDATE_PATCH_UNAVAILABLE');
    const proposal=importCandidatePatch(base.snapshot,bytes);
    const after=reopenCandidateSnapshot(Buffer.from(JSON.stringify(content.after)),record.afterDigest);
    check(proposal.after.digest===after.digest&&after.treeDigest===record.afterTreeDigest,'CANDIDATE_AFTER_UNAVAILABLE');
    const textSource=hasTextSource?reopenNativeCandidateSource(base.snapshot,content.textSource,content.patchBase64):undefined;
    return Object.freeze({record:Object.freeze(record),proposal,patchBase64:content.patchBase64,...(textSource?{textSource}:{}),status:'unverified'});
  }
}
