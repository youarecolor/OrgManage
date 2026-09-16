import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {strictJson} from '../../contracts/src/index.js';
import type {LedgerStore,LedgerReader,CandidateEvaluationResultRow,RunnerProfile,CandidateArtifactRow} from '../../ledger/src/index.js';
import {reopenCandidateSnapshot} from '../../runner/src/candidate.js';
import type {CandidateProposal,CandidateSnapshot} from '../../runner/src/candidate.js';
import type {CandidateCoordinator} from './candidate.js';
import type {FixedRunnerCoordinator,FixedVerificationPort} from './runner.js';
import type {CandidateEvaluationSummary,CandidateArtifactReview} from './model.js';
import {assertCandidateContract} from './candidate-contract.js';

const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const hash=/^[0-9a-f]{64}$/;
function check(v:unknown,code:string):asserts v {if(!v)throw new Error('EVALUATION_'+code);}
function object(v:unknown,keys:string[]):Record<string,unknown>{check(v!==null&&typeof v==='object'&&!Array.isArray(v),'OBJECT');check(Object.keys(v).sort().join('|')===keys.sort().join('|'),'FIELDS');return v as Record<string,unknown>;}
export interface CandidateEvaluationPlan {
  version:'CANDIDATE-EVALUATION-PLAN-v1';id:string;principalId:string;proposalId:string;actorId:string;
  missionId:string;commandId:string;contractId:string;leaseId:string;workspaceId:string;generation:string;
  baseDigest:string;baseTreeDigest:string;writeSetDigest:string;patchDigest:string;afterDigest:string;afterTreeDigest:string;
  profileDigest:string;registrationDigest:string;evaluatorDigest:string;checkIds:readonly string[];
  evidenceKind:RunnerProfile['kind'];authority:string;createdAt:number;digest:string;
}
/** Trusted host adapter only. stageCandidate MUST only bind immutable data in memory;
 * all execution/inspection/stop effects flow through FixedRunnerCoordinator's durable intent. */
export interface CandidateEvaluationPort extends FixedVerificationPort {
  stageCandidate(plan:Readonly<CandidateEvaluationPlan>,proposal:CandidateProposal,attemptId:string,patchBase64:string):void;
  readCollected(plan:Readonly<CandidateEvaluationPlan>,attemptId:string):Promise<Uint8Array>;
}
export interface CandidateEvaluationRegistration {profile:RunnerProfile;port:CandidateEvaluationPort;evaluatorDigest:string;checkIds:readonly string[]}
type Registered={profile:Readonly<RunnerProfile>;port:CandidateEvaluationPort;evaluatorDigest:string;checkIds:readonly string[];digest:string};
export interface CandidateEvaluationView {plan:Readonly<CandidateEvaluationPlan>;attemptId:string|null;status:'prepared'|'unknown'|'passed'|'failed'|'quarantined';result:Readonly<CandidateEvaluationResultRow>|null}
export interface CollectedCandidateArtifact {readonly record:Readonly<CandidateArtifactRow>;readonly snapshot:CandidateSnapshot;readonly text:string;readonly evidenceKind:RunnerProfile['kind'];readonly grantsExecution:false}
declare const artifactDecisionBrand:unique symbol;
export interface ArtifactDecisionWitness {readonly [artifactDecisionBrand]:true}

/** No renderer entrypoint and no default live profile. Candidate text cannot supply a plan or receipt. */
export class CandidateEvaluationCoordinator {
  #profiles=new Map<string,Registered>();#inflight=new Set<string>();
  #artifactDecisions=new WeakMap<object,{actor:string;p:string;artifactId:string;artifactDigest:string;artifactVersion:string;planVersion:string;plan:Readonly<CandidateEvaluationPlan>;authority:{actorGeneration:string;scopes:{id:string;epoch:string}[];contractId:string;ownerId:string;ownerEpoch:string}}>();
  constructor(readonly store:LedgerStore,readonly candidate:CandidateCoordinator,readonly runner:FixedRunnerCoordinator,
    registrations:readonly CandidateEvaluationRegistration[],readonly clock:()=>number=Date.now,readonly collectionTimeoutMs=15000){
    check(Number.isSafeInteger(collectionTimeoutMs)&&collectionTimeoutMs>0&&collectionTimeoutMs<=120000,'TIMEOUT');
    for(const r of registrations){
      check(hash.test(r.evaluatorDigest)&&Array.isArray(r.checkIds)&&r.checkIds.length>0&&r.checkIds.length<=32&&r.checkIds.every(v=>/^[a-z][a-z0-9-]{0,63}$/.test(v))&&new Set(r.checkIds).size===r.checkIds.length,'PROFILE');
      const profile=Object.freeze({...r.profile}),checkIds=Object.freeze([...r.checkIds].sort());
      const key=this.#key(profile.principalId,profile.digest);check(!this.#profiles.has(key),'DUPLICATE_PROFILE');
      const digest=sha(JSON.stringify({profile:{...profile,revision:String(profile.revision)},evaluatorDigest:r.evaluatorDigest,checkIds}));
      this.#profiles.set(key,{profile,checkIds,digest,evaluatorDigest:r.evaluatorDigest,port:r.port});
    }
  }
  #key(p:string,d:string){return p+'/'+d;}
  #now(){const n=this.clock();check(Number.isSafeInteger(n)&&n>=0,'CLOCK');return n;}
  #profile(p:string,d:string){const r=this.#profiles.get(this.#key(p,d));check(r,'UNADMITTED_PROFILE');return r;}
  #authority(tx:LedgerReader,p:string,actor:string,proposalId:string,phase:'prepare'|'finish'){
    const proposal=tx.candidate.getProposal(p,proposalId);check(proposal,'PROPOSAL_MISSING');
    const base=tx.candidate.getBase(p,proposal.baseId);check(base,'BASE_MISSING');
    const member=tx.getMembership(p,actor);check(member?.role==='owner','ACTOR_DENIED');
    assertCandidateContract(tx,p,base);
    let scope=tx.getScope(base.missionId);const scopes:{id:string;epoch:string}[]=[],seen=new Set<string>();
    check(scope?.kind==='mission'&&scope.principalId===p,'SCOPE');
    while(scope){check(!seen.has(scope.id)&&seen.size<128&&scope.state==='active'&&(scope.principalId===p||scope.kind==='application'),'SCOPE_STOPPED');seen.add(scope.id);scopes.push({id:scope.id,epoch:String(scope.epoch)});if(scope.parentId===null)break;scope=tx.getScope(scope.parentId);check(scope,'ANCESTOR_MISSING');}
    const lease=tx.runner.getLease(p,base.leaseId),workspace=tx.runner.getWorkspace(p,base.workspaceId);
    check(lease&&workspace&&lease.actorId===actor&&lease.scopeId===base.missionId&&lease.workspaceId===workspace.id&&lease.generation===base.generation&&workspace.generation===base.generation&&workspace.profileDigest===base.profileDigest&&workspace.snapshotDigest===base.treeDigest&&workspace.writeSetDigest===base.writeSetDigest,'LEASE_BINDING');
    check(lease.ownerId===this.store.ownerId&&lease.ownerEpoch===this.store.ownerEpoch,'OWNER_CHANGED');
    const expected=JSON.stringify({version:'runner-authority-v1',actorGeneration:String(member.generation),scopeEpochs:scopes});
    check(tx.getRecord(p,lease.id)?.data===expected,'AUTHORITY_CHANGED');
    if(phase==='prepare')check(lease.state==='active'&&!lease.dispatched&&lease.stopEpoch===0n&&workspace.state==='ready'&&this.#now()>=lease.updatedAt&&this.#now()<lease.expiresAt,'LEASE_NOT_READY');
    else check(lease.state==='released'&&lease.dispatched&&lease.observationId!==null&&lease.stopEpoch===0n,'STOP_NOT_OBSERVED');
    return {base,proposal,lease,authority:JSON.stringify({actorGeneration:String(member.generation),scopes,contractId:base.contractId,ownerId:lease.ownerId,ownerEpoch:String(lease.ownerEpoch)})};
  }
  prepare(actor:string,p:string,proposalId:string):Readonly<CandidateEvaluationPlan>{
    const immutable=this.candidate.readProposal(actor,p,proposalId).proposal;
    return this.store.transaction(tx=>{
      const a=this.#authority(tx,p,actor,proposalId,'prepare'),registered=this.#profile(p,a.base.profileDigest);
      check(this.#now()>=a.proposal.createdAt,'CLOCK_REGRESSION');
      check(immutable.after.digest===a.proposal.afterDigest,'PROPOSAL_CHANGED');
      const body={version:'CANDIDATE-EVALUATION-PLAN-v1' as const,id:randomUUID(),principalId:p,proposalId,actorId:actor,
        missionId:a.base.missionId,commandId:a.base.commandId,contractId:a.base.contractId,leaseId:a.base.leaseId,workspaceId:a.base.workspaceId,generation:String(a.base.generation),
        baseDigest:a.base.snapshotDigest,baseTreeDigest:a.base.treeDigest,writeSetDigest:a.base.writeSetDigest,patchDigest:a.proposal.patchDigest,afterDigest:a.proposal.afterDigest,afterTreeDigest:a.proposal.afterTreeDigest,
        profileDigest:a.base.profileDigest,registrationDigest:registered.digest,evaluatorDigest:registered.evaluatorDigest,checkIds:registered.checkIds,evidenceKind:registered.profile.kind,authority:a.authority,createdAt:this.#now()};
      const plan=Object.freeze({...body,digest:sha(JSON.stringify(body))});
      tx.insertRecord({principalId:p,id:plan.id,kind:'evidence',revision:1n,data:JSON.stringify({format:'candidate_evaluation_plan_v1',plan})});
      tx.candidateEvaluation.insertPlan({principalId:p,id:plan.id,proposalId,planDigest:plan.digest,createdAt:plan.createdAt});
      tx.appendAudit({principalId:p,commandId:plan.commandId,kind:'candidate.evaluation_planned',entityId:plan.id,createdAt:new Date(plan.createdAt).toISOString()});
      tx.setMeta(`feed:${p}`,randomBytes(24).toString('base64url'));
      return plan;
    });
  }
  #plan(tx:LedgerReader,p:string,id:string):Readonly<CandidateEvaluationPlan>{
    const row=tx.candidateEvaluation.getPlan(p,id),record=tx.getRecord(p,id);check(row&&record?.kind==='evidence','PLAN_MISSING');
    const content=JSON.parse(record.data);check(content.format==='candidate_evaluation_plan_v1','PLAN_FORMAT');
    object(content.plan,['version','id','principalId','proposalId','actorId','missionId','commandId','contractId','leaseId','workspaceId','generation','baseDigest','baseTreeDigest','writeSetDigest','patchDigest','afterDigest','afterTreeDigest','profileDigest','registrationDigest','evaluatorDigest','checkIds','evidenceKind','authority','createdAt','digest']);
    const {digest,...body}=content.plan as CandidateEvaluationPlan;
    check(body.version==='CANDIDATE-EVALUATION-PLAN-v1'&&[body.baseDigest,body.baseTreeDigest,body.writeSetDigest,body.patchDigest,body.afterDigest,body.afterTreeDigest,body.profileDigest,body.registrationDigest,body.evaluatorDigest].every(d=>typeof d==='string'&&hash.test(d)),'PLAN_FORMAT');
    check(digest===row.planDigest&&sha(JSON.stringify(body))===digest&&body.id===id&&body.principalId===p&&body.proposalId===row.proposalId,'PLAN_CHANGED');
    return Object.freeze({...body,checkIds:Object.freeze([...body.checkIds]),digest});
  }
  read(actor:string,p:string,id:string):CandidateEvaluationView {
    return this.store.read(tx=>{
      check(tx.getMembership(p,actor)?.role==='owner','ACTOR_DENIED');const plan=this.#plan(tx,p,id);
      const attempt=tx.candidateEvaluation.attemptForPlan(p,id),result=attempt?tx.candidateEvaluation.results(p,attempt.id).at(-1):undefined;
      if(result)this.#checkResult(tx,result);
      return Object.freeze({plan,attemptId:attempt?.id??null,status:result?.status??(attempt?'unknown':'prepared'),result:result?Object.freeze(result):null});
    });
  }
  #checkResult(tx:LedgerReader,row:CandidateEvaluationResultRow){
    const record=tx.getRecord(row.principalId,row.id);check(record?.kind==='evidence','RESULT_MISSING');const data=JSON.parse(record.data);
    check(data.format==='candidate_evaluation_result_v1'&&data.attemptId===row.attemptId&&data.status===row.status&&data.receiptDigest===row.receiptDigest&&sha(JSON.stringify({receipt:data.receipt,collectedDigest:data.collectedDigest,status:data.status}))===row.receiptDigest,'RESULT_CHANGED');
  }
  /** Safe projection under the caller's authenticated Principal transaction. No raw source/owner data. */
  views(tx:LedgerReader,p:string):CandidateEvaluationSummary[]{
    return tx.candidateEvaluation.listPlans(p).map(row=>{
      const plan=this.#plan(tx,p,row.id),attempt=tx.candidateEvaluation.attemptForPlan(p,row.id),result=attempt?tx.candidateEvaluation.results(p,attempt.id).at(-1):undefined;
      if(result)this.#checkResult(tx,result);
      return {id:plan.id,missionId:plan.missionId,proposalId:plan.proposalId,candidateDigest:plan.afterDigest,status:result?.status??(attempt?'unknown':'prepared'),evidenceKind:plan.evidenceKind,checks:[...plan.checkIds]};
    });
  }
  execute(actor:string,p:string,id:string):Promise<CandidateEvaluationView>{return this.#run(actor,p,id,false);}
  reconcile(actor:string,p:string,id:string):Promise<CandidateEvaluationView>{return this.#run(actor,p,id,true);}
  /** Recollect the evaluated object, then store immutable bytes. No execution or adoption. */
  async registerArtifact(actor:string,p:string,id:string):Promise<CollectedCandidateArtifact>{
    check(!this.#inflight.has(id),'IN_FLIGHT');this.#inflight.add(id);
    try{
      const evaluation=this.read(actor,p,id),{plan,result,attemptId}=evaluation;
      check(evaluation.status==='passed'&&result&&attemptId,'ARTIFACT_NOT_VERIFIED');
      const prior=this.store.read(tx=>tx.candidateArtifact.forPlan(p,id));
      if(prior)return this.readArtifact(actor,p,prior.id);
      const registered=this.#profile(p,plan.profileDigest);check(registered.digest===plan.registrationDigest,'PROFILE_CHANGED');
      const stored=this.candidate.readProposal(actor,p,plan.proposalId);
      check(stored.proposal.after.digest===plan.afterDigest&&stored.proposal.patchDigest===plan.patchDigest,'PROPOSAL_CHANGED');
      this.store.read(tx=>check(this.#authority(tx,p,actor,plan.proposalId,'finish').authority===plan.authority,'AUTHORITY_CHANGED'));
      registered.port.stageCandidate(plan,stored.proposal,attemptId,stored.patchBase64);
      let timer:ReturnType<typeof setTimeout>|undefined;
      let snapshot:CandidateSnapshot;
      try{
        const wire=await Promise.race([registered.port.readCollected(plan,attemptId),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Artifact collection observation timeout')),this.collectionTimeoutMs);})]);
        check(wire instanceof Uint8Array&&!(wire.buffer instanceof SharedArrayBuffer)&&wire.byteLength<=262144,'COLLECTION_LIMIT');
        snapshot=reopenCandidateSnapshot(Buffer.from(wire),plan.afterDigest);
        check(snapshot.treeDigest===plan.afterTreeDigest,'COLLECTION_CHANGED');
      }finally{if(timer!==undefined)clearTimeout(timer);}
      const text=`独立検証を通過した候補\n検証経路: ${plan.evidenceKind==='synthetic'?'合成試験':'固定VM試験'}\n検査: ${plan.checkIds.join(', ')}\n変更対象: ${stored.proposal.changedPaths.join(', ')}\n内容版: ${snapshot.digest}\n\n成果の登録です。採択・使用中アプリへの反映は行っていません。`;
      const body={format:'candidate_artifact_v1',verification:'candidate_verified',missionId:plan.missionId,contractRef:plan.contractId,planId:id,planDigest:plan.digest,resultId:result.id,resultDigest:result.receiptDigest,evidenceKind:plan.evidenceKind,snapshot,text};
      const artifactDigest=sha(JSON.stringify(body)),data=JSON.stringify({...body,artifactDigest});
      const artifactId=this.store.transaction(tx=>{
        check(this.#authority(tx,p,actor,plan.proposalId,'finish').authority===plan.authority,'AUTHORITY_CHANGED');
        const latest=tx.candidateEvaluation.results(p,attemptId).at(-1);check(latest?.id===result.id&&latest.status==='passed','RESULT_CHANGED');
        this.#checkResult(tx,latest);
        const old=tx.candidateArtifact.forPlan(p,id);
        if(old){check(old.artifactDigest===artifactDigest,'ARTIFACT_CONFLICT');return old.id;}
        const now=this.#now();check(now>=latest.createdAt,'CLOCK_REGRESSION');
        const row={principalId:p,id:randomUUID(),planId:id,resultId:result.id,snapshotDigest:snapshot.digest,treeDigest:snapshot.treeDigest,artifactDigest,createdAt:now};
        tx.insertRecord({principalId:p,id:row.id,kind:'artifact',revision:1n,data});tx.candidateArtifact.insert(row);
        tx.appendAudit({principalId:p,commandId:plan.commandId,kind:'candidate.artifact_registered',entityId:row.id,createdAt:new Date(now).toISOString()});
        tx.setMeta(`feed:${p}`,randomBytes(24).toString('base64url'));return row.id;
      });
      return this.readArtifact(actor,p,artifactId);
    }finally{this.#inflight.delete(id);}
  }
  readArtifact(actor:string,p:string,id:string):CollectedCandidateArtifact{
    const stored=this.store.read(tx=>{
      check(tx.getMembership(p,actor)?.role==='owner','ACTOR_DENIED');
      const row=tx.candidateArtifact.get(p,id),record=tx.getRecord(p,id);check(row&&record?.kind==='artifact','ARTIFACT_UNAVAILABLE');
      const plan=this.#plan(tx,p,row.planId),attempt=tx.candidateEvaluation.attemptForPlan(p,plan.id);
      const result=attempt?tx.candidateEvaluation.results(p,attempt.id).at(-1):undefined;
      check(result?.id===row.resultId&&result.status==='passed','ARTIFACT_RESULT');this.#checkResult(tx,result);
      return {row,record,plan,result};
    });
    const {row,record,plan,result}=stored;
    const value=object(JSON.parse(record.data),['format','verification','missionId','contractRef','planId','planDigest','resultId','resultDigest','evidenceKind','snapshot','text','artifactDigest']);
    const {artifactDigest,...body}=value;
    check(artifactDigest===row.artifactDigest&&sha(JSON.stringify(body))===artifactDigest,'ARTIFACT_CHANGED');
    check(value.format==='candidate_artifact_v1'&&value.verification==='candidate_verified'&&value.missionId===plan.missionId&&value.contractRef===plan.contractId&&value.planId===plan.id&&value.planDigest===plan.digest&&value.resultId===result.id&&value.resultDigest===result.receiptDigest&&value.evidenceKind===plan.evidenceKind&&typeof value.text==='string','ARTIFACT_BINDING');
    const snapshot=reopenCandidateSnapshot(Buffer.from(JSON.stringify(value.snapshot)),row.snapshotDigest);
    check(snapshot.digest===plan.afterDigest&&snapshot.treeDigest===row.treeDigest&&snapshot.treeDigest===plan.afterTreeDigest,'ARTIFACT_SNAPSHOT');
    return Object.freeze({record:Object.freeze(row),snapshot,text:value.text,evidenceKind:plan.evidenceKind,grantsExecution:false});
  }
  /** Data-only review of collected bytes. Never exposes unchanged protected files or raw native exchanges. */
  artifactReview(actor:string,p:string,planId:string):CandidateArtifactReview|undefined{
    const row=this.store.read(tx=>{check(tx.getMembership(p,actor)?.role==='owner','ACTOR_DENIED');return tx.candidateArtifact.forPlan(p,planId);});
    if(!row)return undefined;
    const artifact=this.readArtifact(actor,p,row.id),plan=this.read(actor,p,planId).plan;
    const stored=this.candidate.readProposal(actor,p,plan.proposalId),proposal=stored.proposal;
    check(proposal.base.digest===plan.baseDigest&&proposal.base.treeDigest===plan.baseTreeDigest&&proposal.after.digest===artifact.snapshot.digest&&proposal.patchDigest===plan.patchDigest,'ARTIFACT_BINDING');
    const files=proposal.changedPaths.map(path=>{
      const before=proposal.base.files.find(f=>f.path===path),after=artifact.snapshot.files.find(f=>f.path===path);
      check(before&&after&&before.digest!==after.digest,'ARTIFACT_FILE');
      return {path,before:before.text,after:after.text,beforeDigest:before.digest,afterDigest:after.digest};
    });
    return {status:'ready',artifactId:row.id,artifactDigest:row.artifactDigest,beforeTreeDigest:plan.baseTreeDigest,afterTreeDigest:artifact.snapshot.treeDigest,source:stored.textSource?'unverified_text':'unspecified',files};
  }
  /** Verify immutable object hashes before the decision write transaction. */
  prepareArtifactDecision(actor:string,p:string,id:string):ArtifactDecisionWitness{
    const artifact=this.readArtifact(actor,p,id);
    const captured=this.store.read(tx=>{
      const plan=this.#plan(tx,p,artifact.record.planId),record=tx.getRecord(p,id),planRecord=tx.getRecord(p,plan.id);
      check(record?.kind==='artifact'&&planRecord?.kind==='evidence','ARTIFACT_UNAVAILABLE');
      const parsed=strictJson(Buffer.from(plan.authority));check(parsed.ok,'AUTHORITY');
      const authority=object(parsed.value,['actorGeneration','scopes','contractId','ownerId','ownerEpoch']);
      check(typeof authority.actorGeneration==='string'&&Array.isArray(authority.scopes)&&authority.scopes.length>0&&authority.scopes.length<=128,'AUTHORITY');
      for(const scope of authority.scopes){const s=object(scope,['id','epoch']);check(typeof s.id==='string'&&typeof s.epoch==='string','AUTHORITY');}
      return {actor,p,artifactId:id,artifactDigest:artifact.record.artifactDigest,artifactVersion:record.versionId,planVersion:planRecord.versionId,plan,authority:authority as unknown as {actorGeneration:string;scopes:{id:string;epoch:string}[];contractId:string;ownerId:string;ownerEpoch:string}};
    });
    const witness=Object.freeze({}) as ArtifactDecisionWitness;this.#artifactDecisions.set(witness,captured);return witness;
  }
  /** CAS and current authority only; never grants Runner, provider or update access. */
  assertArtifactDecision(tx:LedgerReader,actor:string,p:string,id:string,witness:ArtifactDecisionWitness,requireActive:boolean):Readonly<CandidateEvaluationPlan>{
    const captured=this.#artifactDecisions.get(witness);
    check(captured&&captured.actor===actor&&captured.p===p&&captured.artifactId===id,'ARTIFACT_WITNESS');
    const {plan,authority}=captured,record=tx.getRecord(p,id),binding=tx.candidateArtifact.get(p,id);
    check(record?.versionId===captured.artifactVersion&&binding?.artifactDigest===captured.artifactDigest&&binding.planId===plan.id&&binding.snapshotDigest===plan.afterDigest&&tx.getRecord(p,plan.id)?.versionId===captured.planVersion,'ARTIFACT_CHANGED');
    const member=tx.getMembership(p,actor);check(member?.role==='owner','ACTOR_DENIED');
    if(requireActive){
      check(plan.actorId===actor&&String(member.generation)===authority.actorGeneration,'AUTHORITY_CHANGED');
      const mission=tx.getRecord(p,plan.missionId);check(mission?.kind==='mission','MISSION_MISSING');
      const proposal=tx.candidate.getProposal(p,plan.proposalId),base=proposal&&tx.candidate.getBase(p,proposal.baseId);check(base&&base.contractId===plan.contractId,'CONTRACT_CHANGED');assertCandidateContract(tx,p,base);
      for(const expected of authority.scopes){const scope=tx.getScope(expected.id);check(scope&&scope.state==='active'&&String(scope.epoch)===expected.epoch&&(scope.principalId===p||scope.kind==='application'),'SCOPE_CHANGED');}
      const lease=tx.runner.getLease(p,plan.leaseId),workspace=tx.runner.getWorkspace(p,plan.workspaceId);
      check(lease?.state==='released'&&lease.dispatched&&lease.stopEpoch===0n&&String(lease.generation)===plan.generation&&workspace&&String(workspace.generation)===plan.generation&&workspace.profileDigest===plan.profileDigest&&workspace.snapshotDigest===plan.baseTreeDigest,'LEASE_CHANGED');
    }
    return plan;
  }
  async #run(actor:string,p:string,id:string,reconcile:boolean):Promise<CandidateEvaluationView>{
    check(!this.#inflight.has(id),'IN_FLIGHT');this.#inflight.add(id);
    try{
      const old=this.read(actor,p,id);if(old.result&&old.status!=='unknown')return old;
      const plan=old.plan,r=this.#profile(p,plan.profileDigest);check(r.digest===plan.registrationDigest,'PROFILE_CHANGED');
      const stored=this.candidate.readProposal(actor,p,plan.proposalId),proposal=stored.proposal;
      check(proposal.after.digest===plan.afterDigest&&proposal.patchDigest===plan.patchDigest,'PROPOSAL_CHANGED');
      let attemptId:string;
      if(reconcile){check(old.attemptId,'NO_ATTEMPT');attemptId=old.attemptId;}
      else{
        check(!old.attemptId,'RECONCILE_BEFORE_RETRY');
        attemptId=this.store.transaction(tx=>{
          check(!tx.candidateEvaluation.attemptForPlan(p,id),'ALREADY_DISPATCHED');
          check(this.#authority(tx,p,actor,plan.proposalId,'prepare').authority===plan.authority,'AUTHORITY_CHANGED');
          const attempt={principalId:p,id:randomUUID(),planId:id,ownerId:this.store.ownerId,ownerEpoch:this.store.ownerEpoch,createdAt:this.#now()};
          tx.insertRecord({principalId:p,id:attempt.id,kind:'evidence',revision:1n,data:JSON.stringify({format:'candidate_evaluation_dispatch_v1',planId:id,ownerId:attempt.ownerId,ownerEpoch:String(attempt.ownerEpoch)})});
          tx.candidateEvaluation.insertAttempt(attempt);tx.setMeta(`feed:${p}`,randomBytes(24).toString('base64url'));return attempt.id;
        });
      }
      let status:CandidateEvaluationResultRow['status']='unknown',receipt:unknown=null,collectedDigest:string|null=null;
      try{
        r.port.stageCandidate(plan,proposal,attemptId,stored.patchBase64);
        const lease=await (reconcile?this.runner.reconcile(p,plan.leaseId):this.runner.startExecutor(p,plan.leaseId));
        if(lease.state==='released'&&lease.observationId){
          const observation=this.store.read(tx=>tx.runner.getObservation(p,lease.observationId!));check(observation,'OBSERVATION_MISSING');
          const raw=Buffer.from(observation.detail);check(raw.byteLength<=16000,'RECEIPT_LIMIT');
          const decoded=strictJson(raw);check(decoded.ok,'RECEIPT_WIRE');
          const v=object(decoded.value,['version','planDigest','attemptId','application','verification','collection']);
          check(v.version==='CANDIDATE-EVALUATION-RECEIPT-v1'&&v.planDigest===plan.digest&&v.attemptId===attemptId,'RECEIPT_BINDING');
          const applied=object(v.application,['baseDigest','beforeTreeDigest','writeSetDigest','patchDigest','treeDigest','status','appliedAt','receiptDigest']);
          check(applied.baseDigest===plan.baseDigest&&applied.beforeTreeDigest===plan.baseTreeDigest&&applied.writeSetDigest===plan.writeSetDigest&&applied.patchDigest===plan.patchDigest&&applied.treeDigest===plan.afterTreeDigest&&applied.status==='applied'&&Number.isSafeInteger(applied.appliedAt)&&(applied.appliedAt as number)>=0&&typeof applied.receiptDigest==='string'&&hash.test(applied.receiptDigest),'APPLICATION_MISMATCH');
          const verified=object(v.verification,['treeDigest','evaluatorDigest','checks','verifiedAt','receiptDigest']);
          check(Number.isSafeInteger(verified.verifiedAt)&&(verified.verifiedAt as number)>=(applied.appliedAt as number),'VERIFICATION_TIME');
          check(verified.treeDigest===plan.afterTreeDigest&&verified.evaluatorDigest===plan.evaluatorDigest&&typeof verified.receiptDigest==='string'&&hash.test(verified.receiptDigest)&&Array.isArray(verified.checks),'VERIFICATION_MISMATCH');
          const checks=verified.checks.map(c=>object(c,['id','status','evidenceDigest']));
          check(checks.length===plan.checkIds.length&&checks.every((c,i)=>c.id===plan.checkIds[i]&&['passed','failed','unknown'].includes(c.status as string)&&typeof c.evidenceDigest==='string'&&hash.test(c.evidenceDigest)),'CHECK_SET_MISMATCH');
          receipt=v;
          if(checks.some(c=>c.status==='unknown'))status='unknown';
          else if(checks.some(c=>c.status==='failed'))status='failed';
          else{
            const collected=object(v.collection,['snapshotDigest','treeDigest','collectedAt','receiptDigest']);
            check(Number.isSafeInteger(collected.collectedAt)&&(collected.collectedAt as number)>=(verified.verifiedAt as number),'COLLECTION_TIME');
            check(collected.snapshotDigest===plan.afterDigest&&collected.treeDigest===plan.afterTreeDigest&&typeof collected.receiptDigest==='string'&&hash.test(collected.receiptDigest),'COLLECTION_MISMATCH');
            let timer:ReturnType<typeof setTimeout>|undefined;
            try{
              const bytes=await Promise.race([r.port.readCollected(plan,attemptId),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Collection observation timeout')),this.collectionTimeoutMs);})]);
              check(bytes instanceof Uint8Array&&!(bytes.buffer instanceof SharedArrayBuffer)&&bytes.byteLength<=262144,'COLLECTION_LIMIT');
              const snapshot=reopenCandidateSnapshot(Buffer.from(bytes),plan.afterDigest);check(snapshot.treeDigest===plan.afterTreeDigest,'COLLECTION_CHANGED');
              collectedDigest=snapshot.digest;status='passed';
            }finally{if(timer!==undefined)clearTimeout(timer);}
          }
        }
      }catch{status='unknown';}
      this.store.transaction(tx=>{
        const prior=tx.candidateEvaluation.results(p,attemptId).at(-1);if(prior&&prior.status!=='unknown')return;
        if(status==='passed'||status==='failed'){
          try{check(this.#authority(tx,p,actor,plan.proposalId,'finish').authority===plan.authority,'AUTHORITY_CHANGED');}catch{status='quarantined';}
        }
        const receiptDigest=sha(JSON.stringify({receipt,collectedDigest,status}));
        if(prior?.receiptDigest===receiptDigest)return;
        const row={principalId:p,id:randomUUID(),attemptId,sequence:(prior?.sequence??0n)+1n,receiptDigest,status,createdAt:this.#now()};
        tx.insertRecord({principalId:p,id:row.id,kind:'evidence',revision:1n,data:JSON.stringify({format:'candidate_evaluation_result_v1',attemptId,status,receiptDigest,receipt,collectedDigest})});
        tx.candidateEvaluation.insertResult(row);
        tx.appendAudit({principalId:p,commandId:plan.commandId,kind:'candidate.evaluation_'+status,entityId:row.id,createdAt:new Date(row.createdAt).toISOString()});
        tx.setMeta(`feed:${p}`,randomBytes(24).toString('base64url'));
      });
      return this.read(actor,p,id);
    }finally{this.#inflight.delete(id);}
  }
}
