import {strictJson} from '../../contracts/src/wire.js';
import type {CandidateEvaluationPlan,CandidateEvaluationPort} from '../../core/src/candidate-evaluation.js';
import type {RunnerBinding} from '../../core/src/runner.js';
import type {RunnerProfile} from '../../ledger/src/index.js';
import {candidateSnapshotBytes,reopenCandidateSnapshot} from './candidate.js';
import type {CandidateProposal} from './candidate.js';
import {assertCandidateTransferBinding,createCandidateTransfer,openCandidateTransfer} from './candidate-transfer.js';
import type {CandidateTransferExpectation,OpenedCandidateTransfer} from './candidate-transfer.js';

export interface CandidateChannelRequest {
  readonly operation:'start'|'inspect'|'stop';
  readonly binding:Readonly<RunnerBinding>;
  readonly expected:Readonly<CandidateTransferExpectation>;
  /** Exact original snapshot/patch bytes, sent only on the single start attempt. */
  readonly transfer?:Uint8Array;
}
/** Trusted host-owned channel, not candidate input. The implementation must authenticate the
 * fixed VM/management endpoint, durably deduplicate start by attempt, enforce OS admission,
 * and read protected receipts/objects. A child-written report is not a protected observation.
 * This interface itself provides none of that admission and has no default implementation. */
export interface ProtectedCandidateChannel {
  dispatch(request:Readonly<CandidateChannelRequest>):Promise<Uint8Array>;
  collect(expected:Readonly<CandidateTransferExpectation>):Promise<Uint8Array>;
}
export interface CandidateChannelProfile {
  readonly principalId:string;readonly isolationId:string;readonly profileDigest:string;
  readonly evaluatorDigest:string;readonly evidenceKind:RunnerProfile['kind'];
}
type Staged={transfer:OpenedCandidateTransfer;wire:Uint8Array;expected:Readonly<CandidateTransferExpectation>;started:boolean};
const hash=/^[0-9a-f]{64}$/,uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
function check(v:unknown,code:string):asserts v {if(!v)throw Error('CANDIDATE_CHANNEL_'+code);}
function copy(bytes:Uint8Array,max:number):Buffer{
  check(bytes instanceof Uint8Array&&!(bytes.buffer instanceof SharedArrayBuffer)&&bytes.byteLength<=max,'WIRE');return Buffer.from(bytes);
}

/** Connects the existing durable Core dispatch to exact transfer/observation/collection data.
 * No shell, filesystem, VM IDs selected by a payload, network, credentials or live defaults.
 * Local duplicate-start refusal supplements (does not replace) Core and channel journals. */
export class CandidateChannelPort implements CandidateEvaluationPort {
  readonly #profile:Readonly<CandidateChannelProfile>;
  readonly #channel:ProtectedCandidateChannel;
  readonly #staged=new Map<string,Staged>();
  readonly #leases=new Map<string,string>();
  constructor(profile:CandidateChannelProfile,channel:ProtectedCandidateChannel){
    check(uuid.test(profile.principalId)&&uuid.test(profile.isolationId)&&hash.test(profile.profileDigest)&&hash.test(profile.evaluatorDigest)&&['synthetic','fixed_guest_fixture'].includes(profile.evidenceKind),'PROFILE');
    check(typeof channel?.dispatch==='function'&&typeof channel?.collect==='function','CHANNEL');
    this.#profile=Object.freeze({...profile});
    this.#channel=Object.freeze({dispatch:channel.dispatch.bind(channel),collect:channel.collect.bind(channel)});
  }
  stageCandidate(plan:Readonly<CandidateEvaluationPlan>,proposal:CandidateProposal,attemptId:string,patchBase64:string):void{
    check(plan.principalId===this.#profile.principalId&&plan.profileDigest===this.#profile.profileDigest&&plan.evaluatorDigest===this.#profile.evaluatorDigest&&plan.evidenceKind===this.#profile.evidenceKind,'PROFILE');
    const expected=Object.freeze({planDigest:plan.digest,attemptId,profileDigest:this.#profile.profileDigest,evaluatorDigest:this.#profile.evaluatorDigest});
    const wire=createCandidateTransfer(plan,proposal,attemptId,patchBase64),transfer=openCandidateTransfer(wire,expected);
    const old=this.#staged.get(attemptId),lease=this.#leases.get(plan.leaseId);
    check(!lease||lease===attemptId,'LEASE_CONFLICT');
    if(old){check(old.transfer.wireDigest===transfer.wireDigest,'STAGE_CONFLICT');return;}
    this.#staged.set(attemptId,{transfer,wire:Buffer.from(wire),expected,started:false});this.#leases.set(plan.leaseId,attemptId);
  }
  startExecutor(binding:Readonly<RunnerBinding>):Promise<Uint8Array>{return this.#dispatch(binding,'start');}
  inspect(binding:Readonly<RunnerBinding>):Promise<Uint8Array>{return this.#dispatch(binding,'inspect');}
  requestStop(binding:Readonly<RunnerBinding>):Promise<Uint8Array>{return this.#dispatch(binding,'stop');}
  async #dispatch(binding:Readonly<RunnerBinding>,operation:CandidateChannelRequest['operation']):Promise<Uint8Array>{
    // Snapshot all scope fields before the asynchronous transport can observe caller changes.
    const bound=Object.freeze({...binding});
    const id=this.#leases.get(bound.leaseId),entry=id?this.#staged.get(id):undefined;check(entry,'NOT_STAGED');
    assertCandidateTransferBinding(entry.transfer,bound,this.#profile.isolationId,operation);
    if(operation==='start'){check(!entry.started,'RECONCILE_BEFORE_RETRY');entry.started=true;}
    const request=Object.freeze({operation,binding:bound,expected:entry.expected,...(operation==='start'?{transfer:Buffer.from(entry.wire)}:{})});
    const bytes=copy(await this.#channel.dispatch(request),16384),parsed=strictJson(bytes);
    check(parsed.ok&&parsed.value!==null&&typeof parsed.value==='object'&&!Array.isArray(parsed.value),'OBSERVATION');
    const value=parsed.value as Record<string,unknown>;
    check(Object.keys(value).sort().join('|')===[...Object.keys(bound),'status','kind','handlesSignaled','jobEmpty','writesStable','detail'].sort().join('|'),'OBSERVATION_FIELDS');
    for(const key of Object.keys(bound) as (keyof RunnerBinding)[])check(value[key]===bound[key],'OBSERVATION_BINDING');
    check(value.kind===this.#profile.evidenceKind&&['running','stopped','unknown'].includes(value.status as string)&&['handlesSignaled','jobEmpty','writesStable'].every(k=>typeof value[k]==='boolean'),'OBSERVATION_STATUS');
    // Preserve the endpoint's stop predicates and details verbatim. Core evaluates them;
    // never overlay a current binding/stopEpoch or manufacture success from process exit.
    return bytes;
  }
  async readCollected(plan:Readonly<CandidateEvaluationPlan>,attemptId:string):Promise<Uint8Array>{
    const entry=this.#staged.get(attemptId);check(entry&&entry.transfer.plan.digest===plan.digest&&entry.transfer.plan.id===plan.id,'NOT_STAGED');
    const bytes=copy(await this.#channel.collect(entry.expected),262144);
    const snapshot=reopenCandidateSnapshot(bytes,entry.transfer.plan.afterDigest);
    check(snapshot.treeDigest===entry.transfer.plan.afterTreeDigest,'COLLECTION_CHANGED');
    return candidateSnapshotBytes(snapshot);
  }
}
