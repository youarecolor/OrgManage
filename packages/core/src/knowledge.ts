import {randomUUID,createHash} from 'node:crypto';
import type {LedgerStore,LedgerReader,LedgerTransaction,StoredLedgerRecord} from '../../ledger/src/index.js';
import type {KnowledgeView} from './model.js';

type Plan={format:'knowledge_plan_v1';scopeId:string;generatorSession:string;evaluatorSession:string;criteria:readonly string[];createdAt:number};
type Knowledge={format:'knowledge_v1';scopeId:string;originMissionId:string;worker:string;planId:string;text:string;digest:string;sourceVersions:readonly string[];state:'candidate'|'active'|'rejected'|'revoked';evaluationId:string|null;reason:string|null};
type Evaluation={format:'knowledge_evaluation_v1';candidateId:string;candidateVersion:string;planId:string;planVersion:string;results:readonly {criterion:string;status:'pass'|'fail'|'unknown';evidenceVersion:string}[]};
export class KnowledgeDenied extends Error {constructor(readonly code:string){super('KNOWLEDGE_'+code);}}
function check(v:unknown,code:string):asserts v {if(!v)throw new KnowledgeDenied(code);}
const read=<T>(r:StoredLedgerRecord)=>JSON.parse(r.data) as T;
const sha=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex');
const bounded=(v:unknown,max=65536):v is string=>typeof v==='string'&&v.length>0&&Buffer.byteLength(v,'utf8')<=max;

/** Trusted local knowledge ports. Evaluation registration is a protected host
 * capability, never made available to a candidate or renderer. No script execution. */
export class KnowledgeCoordinator {
  constructor(readonly store:LedgerStore,readonly clock:()=>number=Date.now){}
  views(tx:LedgerReader,p:string):KnowledgeView[]{
    const evaluations=tx.listRecord(p,'evaluation').map(r=>({id:r.id,value:JSON.parse(r.data)}));
    const uses=tx.listRecord(p,'knowledge_use').map(r=>JSON.parse(r.data));
    return tx.listRecord(p,'knowledge').flatMap(row=>{
      const k=read<Knowledge>(row);if(k.format!=='knowledge_v1')return [];
      const evaluation=evaluations.find(e=>e.value.format==='knowledge_evaluation_v1'&&e.value.candidateVersion===row.versionId&&e.value.results.every((r:{status:string})=>r.status==='pass'));
      return [{id:row.id,revision:String(row.revision),scopeId:k.scopeId,originMissionId:k.originMissionId,worker:k.worker,text:k.text,state:k.state,evaluationId:k.evaluationId??evaluation?.id??null,sourceVersions:k.sourceVersions,useCount:uses.filter(u=>u.format==='knowledge_use_v1'&&u.knowledgeId===row.id).length}];
    });
  }
  #authority(tx:LedgerReader,p:string,actor:string,scopeId:string,active=true){
    check(tx.getMembership(p,actor)?.role==='owner','ACTOR');
    let scope=tx.getScope(scopeId);check(scope?.principalId===p,'SCOPE');const seen=new Set<string>();
    while(scope){check(!seen.has(scope.id)&&seen.size<128&&(scope.principalId===p||scope.kind==='application')&&(!active||scope.state==='active'),'SCOPE_STOPPED');seen.add(scope.id);if(scope.parentId===null)break;scope=tx.getScope(scope.parentId);}
    check(scope?.kind==='application','ROOT');
  }
  #record(tx:LedgerReader,p:string,id:string,kind:'knowledge'|'evaluation'|'evidence'){
    const r=tx.getRecord(p,id);check(r?.kind===kind,'RECORD');return r;
  }
  #sources(tx:LedgerReader,p:string,versions:readonly string[],scopeId:string){
    check(versions.length>0&&versions.length<=32&&new Set(versions).size===versions.length,'SOURCES');
    for(const version of versions){
      const r=tx.getRecordVersion(p,version);check(r&&(r.kind==='source'||r.kind==='evidence')&&tx.getRecord(p,r.id)?.versionId===version,'SOURCE_CHANGED');
      const source=JSON.parse(r.data);check(typeof source.scopeId==='string'&&this.#within(tx,source.scopeId,scopeId)&&source.state!=='revoked'&&source.state!=='quarantined','SOURCE_SCOPE');
    }
  }
  preparePlan(p:string,actor:string,scopeId:string,generatorSession:string,evaluatorSession:string,criteria:readonly string[]):string{
    check(bounded(generatorSession,256)&&bounded(evaluatorSession,256)&&generatorSession!==evaluatorSession,'INDEPENDENT_SESSION');
    check(criteria.length>=8&&criteria.length<=64&&new Set(criteria).size===criteria.length&&criteria.every(c=>bounded(c,128))&&criteria.includes('reproduction')&&criteria.includes('prohibited_changes')&&criteria.filter(c=>c.startsWith('holdout:')).length>=3&&criteria.filter(c=>c.startsWith('nonregression:')).length>=3,'CRITERIA');
    return this.store.transaction(tx=>{this.#authority(tx,p,actor,scopeId);const id=randomUUID();const value:Plan={format:'knowledge_plan_v1',scopeId,generatorSession,evaluatorSession,criteria:[...criteria],createdAt:this.clock()};tx.insertRecord({principalId:p,id,kind:'evaluation',revision:1n,data:JSON.stringify(value)});return id;});
  }
  propose(p:string,actor:string,planId:string,originMissionId:string,worker:string,text:string,sourceVersions:readonly string[]):string{
    check(bounded(worker,128)&&bounded(text),'TEXT');
    return this.store.transaction(tx=>{
      const planRow=this.#record(tx,p,planId,'evaluation'),plan=read<Plan>(planRow);check(plan.format==='knowledge_plan_v1'&&planRow.revision===1n,'PLAN');
      this.#authority(tx,p,actor,plan.scopeId);this.#authority(tx,p,actor,originMissionId);
      check(tx.getScope(originMissionId)?.kind==='mission'&&this.#within(tx,originMissionId,plan.scopeId),'ORIGIN_SCOPE');this.#sources(tx,p,sourceVersions,plan.scopeId);
      const id=randomUUID(),value:Knowledge={format:'knowledge_v1',scopeId:plan.scopeId,originMissionId,worker,planId,text,digest:sha(text),sourceVersions:[...sourceVersions],state:'candidate',evaluationId:null,reason:null};
      tx.insertRecord({principalId:p,id,kind:'knowledge',revision:1n,data:JSON.stringify(value)});return id;
    });
  }
  #within(tx:LedgerReader,child:string,parent:string){let s=tx.getScope(child);const seen=new Set<string>();while(s&&!seen.has(s.id)&&seen.size<128){if(s.id===parent)return true;seen.add(s.id);s=s.parentId?tx.getScope(s.parentId):undefined;}return false;}
  recordEvaluation(p:string,actor:string,id:string,evaluatorSession:string,results:Evaluation['results']):string{
    return this.store.transaction(tx=>{
      const row=this.#record(tx,p,id,'knowledge'),k=read<Knowledge>(row);check(k.format==='knowledge_v1'&&k.state==='candidate','CANDIDATE');this.#authority(tx,p,actor,k.scopeId);
      const planRow=this.#record(tx,p,k.planId,'evaluation'),plan=read<Plan>(planRow);check(plan.format==='knowledge_plan_v1'&&planRow.revision===1n&&plan.evaluatorSession===evaluatorSession&&evaluatorSession!==plan.generatorSession,'INDEPENDENT_SESSION');
      check(results.length===plan.criteria.length&&new Set(results.map(r=>r.criterion)).size===results.length&&new Set(results.map(r=>r.evidenceVersion)).size===results.length&&results.every(r=>plan.criteria.includes(r.criterion)&&['pass','fail','unknown'].includes(r.status)),'RESULTS');
      for(const r of results){
        const evidence=tx.getRecordVersion(p,r.evidenceVersion);check(evidence?.kind==='evidence'&&tx.getRecord(p,evidence.id)?.versionId===evidence.versionId,'EVIDENCE');
        const observed=JSON.parse(evidence.data);check(observed.format==='knowledge_check_v1'&&observed.candidateVersion===row.versionId&&observed.planVersion===planRow.versionId&&observed.criterion===r.criterion&&observed.status===r.status,'EVIDENCE_BINDING');
      }
      const evaluationId=randomUUID(),value:Evaluation={format:'knowledge_evaluation_v1',candidateId:id,candidateVersion:row.versionId,planId:k.planId,planVersion:planRow.versionId,results:structuredClone(results)};
      tx.insertRecord({principalId:p,id:evaluationId,kind:'evaluation',revision:1n,data:JSON.stringify(value)});return evaluationId;
    });
  }
  decideInTransaction(tx:LedgerTransaction,p:string,actor:string,id:string,revision:bigint,choice:'adopt'|'reject'|'revoke',evaluationId:string|null,scopeId:string,comment:string|null):void{
    this.store.assertTransaction(tx);const row=this.#record(tx,p,id,'knowledge'),k=read<Knowledge>(row);
    check(k.format==='knowledge_v1'&&row.revision===revision&&k.scopeId===scopeId,'VERSION');this.#authority(tx,p,actor,k.scopeId,choice!=='revoke');
    check(comment===null||bounded(comment),'COMMENT');
    if(choice==='adopt'){
      check(k.state==='candidate'&&evaluationId,'CANDIDATE');this.#sources(tx,p,k.sourceVersions,k.scopeId);
      const e=read<Evaluation>(this.#record(tx,p,evaluationId,'evaluation'));
      check(e.format==='knowledge_evaluation_v1'&&e.candidateId===id&&e.candidateVersion===row.versionId&&e.planId===k.planId&&e.results.every(r=>r.status==='pass'),'EVALUATION_NOT_PASSED');
      check(tx.getRecord(p,k.planId)?.versionId===e.planVersion,'PLAN_CHANGED');
      for(const r of e.results){const evidence=tx.getRecordVersion(p,r.evidenceVersion);check(evidence&&tx.getRecord(p,evidence.id)?.versionId===r.evidenceVersion,'EVIDENCE_CHANGED');}
    }else check(choice==='revoke'?k.state==='active':k.state==='candidate','STATE');
    tx.updateRecord({...row,revision:row.revision+1n,data:JSON.stringify({...k,state:choice==='adopt'?'active':choice==='revoke'?'revoked':'rejected',evaluationId:choice==='adopt'?evaluationId:k.evaluationId,reason:comment})},row.revision);
  }
  use(p:string,actor:string,id:string,missionId:string,worker:string):{useId:string;text:string;sourceVersions:readonly string[]}{
    return this.store.transaction(tx=>{
      const row=this.#record(tx,p,id,'knowledge'),k=read<Knowledge>(row);check(k.format==='knowledge_v1'&&k.state==='active'&&k.worker===worker&&sha(k.text)===k.digest,'NOT_ACTIVE');
      this.#authority(tx,p,actor,k.scopeId);this.#authority(tx,p,actor,missionId);
      check(tx.getScope(missionId)?.kind==='mission'&&missionId!==k.originMissionId&&this.#within(tx,missionId,k.scopeId),'SEPARATE_MISSION_REQUIRED');this.#sources(tx,p,k.sourceVersions,k.scopeId);
      const useId=randomUUID();tx.insertRecord({principalId:p,id:useId,kind:'knowledge_use',revision:1n,data:JSON.stringify({format:'knowledge_use_v1',knowledgeId:id,knowledgeVersion:row.versionId,missionId,worker,sourceVersions:k.sourceVersions,createdAt:this.clock(),result:null})});
      return {useId,text:k.text,sourceVersions:k.sourceVersions};
    });
  }
  recordUseResult(p:string,actor:string,useId:string,outcomeVersion:string):void{
    this.store.transaction(tx=>{
      const row=tx.getRecord(p,useId);check(row?.kind==='knowledge_use','USE');const value=JSON.parse(row.data);
      check(value.format==='knowledge_use_v1'&&value.result===null,'USE_RESULT_ALREADY_RECORDED');
      this.#authority(tx,p,actor,value.missionId,false);
      const outcome=tx.getRecordVersion(p,outcomeVersion);check(outcome?.kind==='outcome','OUTCOME');
      const data=JSON.parse(outcome.data);check(data.missionId===value.missionId,'OUTCOME_MISSION');
      tx.updateRecord({...row,revision:row.revision+1n,data:JSON.stringify({...value,result:{outcomeVersion,recordedAt:this.clock()}})},row.revision);
    });
  }
  /** Revalidate a prepared use in the same transaction as a downstream action. */
  confirmUseInTransaction(tx:LedgerTransaction,p:string,actor:string,useId:string,missionId:string,worker:string){
    this.store.assertTransaction(tx);
    const use=tx.getRecord(p,useId);check(use?.kind==='knowledge_use','USE');const u=JSON.parse(use.data);
    check(u.format==='knowledge_use_v1'&&u.missionId===missionId&&u.worker===worker,'USE_BINDING');
    const row=this.#record(tx,p,u.knowledgeId,'knowledge'),k=read<Knowledge>(row);
    check(k.format==='knowledge_v1'&&k.state==='active'&&row.versionId===u.knowledgeVersion&&k.worker===worker&&sha(k.text)===k.digest,'NOT_ACTIVE');
    this.#authority(tx,p,actor,k.scopeId);this.#authority(tx,p,actor,missionId);
    check(missionId!==k.originMissionId&&this.#within(tx,missionId,k.scopeId),'SEPARATE_MISSION_REQUIRED');
    this.#sources(tx,p,k.sourceVersions,k.scopeId);
    return {useId,knowledgeId:row.id,knowledgeVersion:row.versionId,text:k.text,sourceVersions:[...k.sourceVersions]};
  }
}
