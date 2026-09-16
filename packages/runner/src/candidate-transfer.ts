import {createHash} from 'node:crypto';
import {strictJson} from '../../contracts/src/wire.js';
import {candidateSnapshotBytes,reopenCandidateSnapshot,importCandidatePatch} from './candidate.js';
import type {CandidateProposal} from './candidate.js';
import type {CandidateEvaluationPlan} from '../../core/src/candidate-evaluation.js';
import type {RunnerBinding} from '../../core/src/runner.js';

/** Data transfer only. No file access, shell, VM, code import, or authority from payload content. */
export const CANDIDATE_TRANSFER_LIMIT=192*1024;
const hash=/^[0-9a-f]{64}$/,uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
function check(v:unknown,code:string):asserts v {if(!v)throw Error('TRANSFER_'+code);}
function object(v:unknown,keys:readonly string[]):Record<string,unknown>{
  check(v!==null&&typeof v==='object'&&!Array.isArray(v),'OBJECT');
  check(Object.keys(v).sort().join('|')===[...keys].sort().join('|'),'FIELDS');return v as Record<string,unknown>;
}
function base64(v:unknown):Buffer{
  check(typeof v==='string'&&v.length<=262144&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v),'BASE64');
  const b=Buffer.from(v,'base64');check(b.toString('base64')===v,'BASE64');return b;
}
const planKeys=['version','id','principalId','proposalId','actorId','missionId','commandId','contractId','leaseId','workspaceId','generation','baseDigest','baseTreeDigest','writeSetDigest','patchDigest','afterDigest','afterTreeDigest','profileDigest','registrationDigest','evaluatorDigest','checkIds','evidenceKind','authority','createdAt','digest'] as const;
function validatePlan(value:unknown):Readonly<CandidateEvaluationPlan>{
  const p=object(value,planKeys);
  check(p.version==='CANDIDATE-EVALUATION-PLAN-v1','VERSION');
  for(const k of ['id','principalId','proposalId','missionId','commandId','contractId','leaseId','workspaceId'])check(typeof p[k]==='string'&&uuid.test(p[k]),'IDENTITY');
  check(typeof p.actorId==='string'&&p.actorId.length>0&&p.actorId.length<=256,'ACTOR');
  check(typeof p.generation==='string'&&/^[1-9][0-9]{0,17}$/.test(p.generation),'GENERATION');
  for(const k of ['baseDigest','baseTreeDigest','writeSetDigest','patchDigest','afterDigest','afterTreeDigest','profileDigest','registrationDigest','evaluatorDigest','digest'])check(typeof p[k]==='string'&&hash.test(p[k]),'DIGEST');
  check(typeof p.authority==='string'&&p.authority.length>0&&p.authority.length<=32768,'AUTHORITY');
  check(Number.isSafeInteger(p.createdAt)&&(p.createdAt as number)>=0,'TIME');
  check(p.evidenceKind==='synthetic'||p.evidenceKind==='fixed_guest_fixture','KIND');
  check(Array.isArray(p.checkIds)&&p.checkIds.length>0&&p.checkIds.length<=32&&p.checkIds.every(v=>typeof v==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(v))&&new Set(p.checkIds).size===p.checkIds.length&&p.checkIds.join('|')===[...p.checkIds].sort().join('|'),'CHECKS');
  const {digest,...body}=p;check(sha(JSON.stringify(body))===digest,'PLAN_HASH');
  return Object.freeze({...p,checkIds:Object.freeze([...p.checkIds])}) as unknown as Readonly<CandidateEvaluationPlan>;
}
export interface CandidateTransferExpectation {
  readonly planDigest:string;readonly attemptId:string;readonly profileDigest:string;readonly evaluatorDigest:string;
}
export interface OpenedCandidateTransfer {
  readonly plan:Readonly<CandidateEvaluationPlan>;readonly attemptId:string;
  readonly proposal:CandidateProposal;readonly patchBase64:string;readonly wireDigest:string;
}
function compatible(plan:Readonly<CandidateEvaluationPlan>,proposal:CandidateProposal){
  const {base,after}=proposal;
  for(const k of ['principalId','missionId','commandId','leaseId','workspaceId','generation','profileDigest'] as const)check(base.binding[k]===plan[k]&&after.binding[k]===plan[k],'SCOPE');
  check(base.digest===plan.baseDigest&&base.treeDigest===plan.baseTreeDigest&&sha(JSON.stringify(base.writeSet))===plan.writeSetDigest,'BASE_BINDING');
  check(proposal.patchDigest===plan.patchDigest&&after.digest===plan.afterDigest&&after.treeDigest===plan.afterTreeDigest,'AFTER_BINDING');
}
/** Expected identities must come from the protected dispatch record, separately from these bytes. */
export function openCandidateTransfer(bytes:Uint8Array,expected:CandidateTransferExpectation):OpenedCandidateTransfer{
  check(bytes instanceof Uint8Array&&!(bytes.buffer instanceof SharedArrayBuffer)&&bytes.byteLength<=CANDIDATE_TRANSFER_LIMIT,'SIZE');
  check([expected.planDigest,expected.profileDigest,expected.evaluatorDigest].every(x=>typeof x==='string'&&hash.test(x))&&uuid.test(expected.attemptId),'EXPECTED_IDENTITY');
  const copy=Buffer.from(bytes),parsed=strictJson(copy);check(parsed.ok,'JSON');
  const data=object(parsed.value,['version','plan','attemptId','baseBase64','patchBase64']);
  check(data.version==='CANDIDATE-TRANSFER-v1'&&data.attemptId===expected.attemptId,'ATTEMPT');
  const plan=validatePlan(data.plan);
  check(plan.digest===expected.planDigest&&plan.profileDigest===expected.profileDigest&&plan.evaluatorDigest===expected.evaluatorDigest,'EXPECTED_PLAN');
  const base=reopenCandidateSnapshot(base64(data.baseBase64),plan.baseDigest),patch=base64(data.patchBase64);
  const proposal=importCandidatePatch(base,patch);compatible(plan,proposal);
  return Object.freeze({plan,attemptId:expected.attemptId,proposal,patchBase64:patch.toString('base64'),wireDigest:sha(copy)});
}
export function createCandidateTransfer(plan:Readonly<CandidateEvaluationPlan>,proposal:CandidateProposal,attemptId:string,patchBase64:string):Uint8Array{
  const bytes=Buffer.from(JSON.stringify({version:'CANDIDATE-TRANSFER-v1',plan,attemptId,baseBase64:Buffer.from(candidateSnapshotBytes(proposal.base)).toString('base64'),patchBase64}));
  // Re-import the exact patch rather than silently regenerating a different patch digest.
  const opened=openCandidateTransfer(bytes,{planDigest:plan.digest,attemptId,profileDigest:plan.profileDigest,evaluatorDigest:plan.evaluatorDigest});
  check(opened.proposal.after.digest===proposal.after.digest,'PROPOSAL_CHANGED');return bytes;
}
/** Must pass before a staged transfer can be used by a Runner start. Inspect/stop may use stopEpoch 1. */
export function assertCandidateTransferBinding(transfer:OpenedCandidateTransfer,binding:Readonly<RunnerBinding>,expectedIsolationId:string,mode:'start'|'inspect'|'stop'):void{
  object(binding,['principalId','leaseId','workspaceId','generation','ownerId','ownerEpoch','stopEpoch','profileDigest','isolationId']);
  check(['start','inspect','stop'].includes(mode),'MODE');
  check(uuid.test(expectedIsolationId)&&binding.isolationId===expectedIsolationId,'ISOLATION');
  for(const k of ['principalId','leaseId','workspaceId','generation','profileDigest'] as const)check(binding[k]===transfer.plan[k],'RUNNER_BINDING');
  check(uuid.test(binding.ownerId)&&uuid.test(binding.isolationId)&&/^[1-9][0-9]{0,17}$/.test(binding.ownerEpoch)&&/^[01]$/.test(binding.stopEpoch)&&(mode!=='start'||binding.stopEpoch==='0'),'RUNNER_AUTHORITY');
  const parsed=strictJson(Buffer.from(transfer.plan.authority));check(parsed.ok,'AUTHORITY');
  const a=object(parsed.value,['actorGeneration','scopes','contractId','ownerId','ownerEpoch']);
  check(a.ownerId===binding.ownerId&&a.ownerEpoch===binding.ownerEpoch&&a.contractId===transfer.plan.contractId,'OWNER_CHANGED');
}
