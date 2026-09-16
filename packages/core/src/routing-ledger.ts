import {randomUUID} from 'node:crypto';
import type {LedgerStore,LedgerReader,LedgerTransaction} from '../../ledger/src/index.js';
import canonicalize from 'canonicalize';
import {selectRoute,sealConfiguration,qualifyRoutingPool} from './routing.js';
import type {ExecutionConfiguration,RoutingInput,RoutingDecision} from './routing.js';
import type {RoutingView} from './model.js';

export function routingViews(tx:LedgerReader,p:string):RoutingView[]{
  const records=tx.listRecord(p,'evidence').map(row=>({row,v:JSON.parse(row.data)})).filter(({v})=>['routing_proposal_v1','routing_pool_v1'].includes(v.format));
  const pooled=new Set(records.filter(({v})=>v.format==='routing_pool_v1').map(({v})=>v.proposalId));
  records.sort((a,b)=>(a.v.createdAt??0)-(b.v.createdAt??0)||a.row.id.localeCompare(b.row.id));
  return records.flatMap(({row,v}):RoutingView[]=>{
    if(v.format==='routing_pool_v1'){
      const q=v.qualification,c=q.sharedConfiguration;
      return [{id:row.id,missionId:v.missionId,kind:'pool',reason:'declared_auto_pool',model:null,candidateModels:q.members.map((m:{model:string})=>m.model),effort:c.effort,runtime:c.runtime,billingRoute:c.billingRoute,policyVersion:q.policyVersion,inputDigest:q.poolDigest}];
    }
    if(v.format!=='routing_proposal_v1'||pooled.has(row.id))return [];
    const c=v.pool.find((entry:{digest:string})=>entry.digest===v.decision.digest)?.configuration;
    return [{id:row.id,missionId:v.missionId,kind:v.decision.kind,reason:v.decision.reason,model:c?.model??null,effort:c?.effort??null,runtime:c?.runtime??null,billingRoute:c?.billingRoute??null,policyVersion:v.decision.policyVersion,inputDigest:v.decision.inputDigest}];
  });
}

export interface RoutingReceipt {id:string;missionId:string;contractVersion:string;decision:RoutingDecision;createdAt:number}
/** Host-only proposal journal. Cannot create an Attempt, approval or budget hold. */
export class RoutingCoordinator {
  readonly #pool;
  constructor(readonly store:LedgerStore,profiles:readonly ExecutionConfiguration[],readonly clock:()=>number=Date.now){this.#pool=profiles.map(sealConfiguration);}
  #authority(tx:LedgerReader,p:string,actor:string,missionId:string){
    const membership=tx.getMembership(p,actor);
    if(membership?.role!=='owner')throw Error('ROUTING_ACTOR_DENIED');
    let scope=tx.getScope(missionId);const scopes:{id:string;epoch:string}[]=[];
    if(scope?.kind!=='mission'||scope.principalId!==p)throw Error('ROUTING_MISSION_REQUIRED');
    while(scope){
      if(scope.state!=='active'||scopes.some(s=>s.id===scope!.id)||scopes.length>=128||(scope.principalId!==p&&scope.kind!=='application'))throw Error('ROUTING_SCOPE_STOPPED');
      scopes.push({id:scope.id,epoch:String(scope.epoch)});
      if(scope.parentId===null)break;scope=tx.getScope(scope.parentId);
    }
    if(scope?.kind!=='application')throw Error('ROUTING_ROOT_MISSING');
    return {membership:String(membership.generation),scopes};
  }
  propose(p:string,actor:string,missionId:string,input:Omit<RoutingInput,'originalText'|'revisionText'|'now'>):RoutingReceipt{
    return this.store.transaction(tx=>{
      const authority=this.#authority(tx,p,actor,missionId),mission=tx.getRecord(p,missionId);
      if(mission?.kind!=='mission')throw Error('ROUTING_MISSION_REQUIRED');
      const m=JSON.parse(mission.data),ref=m.contractRef;
      if(m.pendingContractRef)throw Error('ROUTING_CONTRACT_PENDING');
      const contract=tx.getRecord(p,ref)??tx.getRecordVersion(p,ref);
      if(contract?.kind!=='contract'||tx.getRecord(p,contract.id)?.versionId!==contract.versionId)throw Error('ROUTING_CONTRACT_CHANGED');
      const policyId=tx.getMeta(`policy:${p}`),policy=policyId?tx.getRecord(p,policyId):undefined;
      if(!policy||policy.versionId!==input.policyVersion)throw Error('ROUTING_POLICY_CHANGED');
      if((JSON.parse(policy.data).cash!==undefined)!==(input.available!==undefined))throw Error('ROUTING_POLICY_CURRENCY');
      for(const observation of input.observations){
        const evidence=tx.getRecordVersion(p,observation.evidenceRef);
        if(evidence?.kind!=='evidence'||tx.getRecord(p,evidence.id)?.versionId!==evidence.versionId)throw Error('ROUTING_EVIDENCE_REQUIRED');
      }
      const brief=tx.getRecord(p,m.briefRef)??tx.getRecordVersion(p,m.briefRef);
      if(brief?.kind!=='brief')throw Error('ROUTING_BRIEF_REQUIRED');
      const now=this.clock(),request={...input,originalText:m.originalRequest,revisionText:JSON.parse(brief.data).revisionRequest??null,now};
      const decision=selectRoute(this.#pool,request),id=randomUUID();
      const receipt={id,missionId,contractVersion:contract.versionId,decision,createdAt:now};
      tx.insertRecord({principalId:p,id,kind:'evidence',revision:1n,data:JSON.stringify({format:'routing_proposal_v1',...receipt,actor,authority,request,pool:this.#pool})});
      return receipt;
    });
  }
  list(p:string,actor:string):RoutingReceipt[]{
    return this.store.read(tx=>{
      if(tx.getMembership(p,actor)?.role!=='owner')throw Error('ROUTING_ACTOR_DENIED');
      return tx.listRecord(p,'evidence').flatMap(row=>{
        const value=JSON.parse(row.data);
        return value.format==='routing_proposal_v1'?[{id:row.id,missionId:value.missionId,contractVersion:value.contractVersion,decision:value.decision,createdAt:value.createdAt}]:[];
      });
    });
  }
  /** Revalidates a recorded proposal; this does not acquire execution authority. */
  recordPool(p:string,actor:string,proposalId:string){
    return this.store.transaction(tx=>{
      const proposal=tx.getRecord(p,proposalId);
      if(proposal?.kind!=='evidence')throw Error('ROUTING_PROPOSAL_REQUIRED');
      const v=JSON.parse(proposal.data);
      this.confirmInTransaction(tx,p,actor,proposalId,v.missionId,v.contractVersion);
      const qualification=qualifyRoutingPool(this.#pool,v.request);
      const current=qualifyRoutingPool(this.#pool,{...v.request,now:this.clock()});
      if(qualification.kind!=='eligible'||current.kind!=='eligible')throw Error('ROUTING_POOL_NOT_ELIGIBLE');
      const id=randomUUID(),data={format:'routing_pool_v1',actor,proposalId,proposalVersion:proposal.versionId,missionId:v.missionId,contractVersion:v.contractVersion,qualification,createdAt:this.clock()};
      tx.insertRecord({principalId:p,id,kind:'evidence',revision:1n,data:JSON.stringify(data)});
      tx.appendAudit({principalId:p,commandId:null,kind:'routing.pool_recorded',entityId:id,createdAt:new Date(this.clock()).toISOString()});
      return {id,missionId:v.missionId as string,contractVersion:v.contractVersion as string,qualification};
    });
  }
  /** Rechecks every candidate, including those other than the single-route winner. */
  confirmPoolInTransaction(tx:LedgerTransaction,p:string,actor:string,id:string,missionId:string,contractVersion:string){
    this.store.assertTransaction(tx);
    const row=tx.getRecord(p,id);if(row?.kind!=='evidence'||row.revision!==1n)throw Error('ROUTING_POOL_REQUIRED');
    const v=JSON.parse(row.data);
    if(v.format!=='routing_pool_v1'||v.actor!==actor||v.missionId!==missionId||v.contractVersion!==contractVersion)throw Error('ROUTING_POOL_BINDING_CHANGED');
    const proposal=tx.getRecord(p,v.proposalId);
    if(!proposal||proposal.versionId!==v.proposalVersion)throw Error('ROUTING_POOL_PROPOSAL_CHANGED');
    this.confirmInTransaction(tx,p,actor,v.proposalId,missionId,contractVersion);
    const request=JSON.parse(proposal.data).request;
    const original=qualifyRoutingPool(this.#pool,request);
    if(original.kind!=='eligible'||canonicalize(original)!==canonicalize(v.qualification))throw Error('ROUTING_POOL_CHANGED');
    if(qualifyRoutingPool(this.#pool,{...request,now:this.clock()}).kind!=='eligible')throw Error('ROUTING_POOL_EXPIRED');
    return {poolVersion:row.versionId,proposalVersion:proposal.versionId,qualification:original,configurations:this.#pool.map(p=>structuredClone(p.configuration))};
  }
  /** Revalidates a recorded single-model proposal, without acquiring authority. */
  confirmInTransaction(tx:LedgerTransaction,p:string,actor:string,id:string,missionId:string,contractVersion:string){
    this.store.assertTransaction(tx);
    const authority=this.#authority(tx,p,actor,missionId),row=tx.getRecord(p,id);
    if(row?.kind!=='evidence'||row.revision!==1n)throw Error('ROUTING_PROPOSAL_REQUIRED');
    const v=JSON.parse(row.data),mission=tx.getRecord(p,missionId),m=mission&&JSON.parse(mission.data);
    if(v.format!=='routing_proposal_v1'||v.actor!==actor||v.missionId!==missionId||v.contractVersion!==contractVersion||canonicalize(v.authority)!==canonicalize(authority))throw Error('ROUTING_BINDING_CHANGED');
    const contract=tx.getRecordVersion(p,contractVersion);
    if(contract?.kind!=='contract'||tx.getRecord(p,contract.id)?.versionId!==contractVersion||m.pendingContractRef||![contract.id,contractVersion].includes(m.contractRef))throw Error('ROUTING_CONTRACT_CHANGED');
    const policyId=tx.getMeta(`policy:${p}`);
    if(!policyId||tx.getRecord(p,policyId)?.versionId!==v.request.policyVersion)throw Error('ROUTING_POLICY_CHANGED');
    if((JSON.parse(tx.getRecord(p,policyId)!.data).cash!==undefined)!==(v.request.available!==undefined))throw Error('ROUTING_POLICY_CURRENCY');
    const brief=tx.getRecord(p,m.briefRef)??tx.getRecordVersion(p,m.briefRef);
    if(brief?.kind!=='brief'||m.originalRequest!==v.request.originalText||(JSON.parse(brief.data).revisionRequest??null)!==v.request.revisionText)throw Error('ROUTING_INPUT_CHANGED');
    if(canonicalize(v.pool)!==canonicalize(this.#pool))throw Error('ROUTING_PROFILES_CHANGED');
    for(const o of v.request.observations){const e=tx.getRecordVersion(p,o.evidenceRef);if(e?.kind!=='evidence'||tx.getRecord(p,e.id)?.versionId!==e.versionId)throw Error('ROUTING_EVIDENCE_CHANGED');}
    const original=selectRoute(this.#pool,v.request);
    if(canonicalize(original)!==canonicalize(v.decision))throw Error('ROUTING_DECISION_CHANGED');
    const decision=selectRoute(this.#pool,{...v.request,now:this.clock()});
    if(!['select','continue'].includes(decision.kind)||decision.digest!==original.digest)throw Error('ROUTING_SELECTION_EXPIRED');
    const selected=this.#pool.find(c=>c.digest===decision.digest);if(!selected)throw Error('ROUTING_SELECTION_REQUIRED');
    return {proposalVersion:row.versionId,configuration:structuredClone(selected.configuration),configurationDigest:selected.digest,...(v.request.available?{maximum:structuredClone(v.request.observations.find((o:{digest:string})=>o.digest===selected.digest).maximum) as import('./money.js').Money}:{})};
  }
}
