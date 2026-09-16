import { randomUUID } from 'node:crypto';
import { strictJson } from '../../contracts/src/index.js';
import type { LedgerStore, LedgerTransaction, LedgerReader, RunnerLease, RunnerProfile, RunnerWorkspace, RunnerStopObservation } from '../../ledger/src/index.js';

export class RunnerDeniedError extends Error { override name='RunnerDeniedError'; }
export interface RunnerBinding { principalId:string; leaseId:string; workspaceId:string; generation:string; ownerId:string; ownerEpoch:string; stopEpoch:string; profileDigest:string; isolationId:string }
/** Staging subset of RunnerPort: trusted finite verification only, never arbitrary commands/VM IDs. */
export interface FixedVerificationPort {
  startExecutor(binding:Readonly<RunnerBinding>):Promise<Uint8Array>;
  requestStop(binding:Readonly<RunnerBinding>):Promise<Uint8Array>;
  inspect(binding:Readonly<RunnerBinding>):Promise<Uint8Array>;
}
export type FixedRunnerRegistration = {profile:RunnerProfile;port:FixedVerificationPort};
type Observation = RunnerBinding & {status:'running'|'stopped'|'unknown';kind:RunnerProfile['kind'];handlesSignaled:boolean;jobEmpty:boolean;writesStable:boolean;detail:unknown};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const digest=/^[0-9a-f]{64}$/;
const max=999999999999999999n;
function requireThat(condition:unknown,message:string):asserts condition {if(!condition)throw new RunnerDeniedError(message);}
function time(now:number):number {requireThat(Number.isSafeInteger(now)&&now>=0&&now<=Number.MAX_SAFE_INTEGER-120000,'Invalid bounded clock');return now;}
function sameBinding(a:RunnerBinding,b:RunnerBinding):boolean {return (Object.keys(a) as (keyof RunnerBinding)[]).every(k=>a[k]===b[k]);}
function observation(bytes:Uint8Array,expected:RunnerBinding,kind:RunnerProfile['kind']):Observation {
  requireThat(bytes instanceof Uint8Array && bytes.byteLength<=16384,'Runner response too large');
  const parsed=strictJson(bytes);requireThat(parsed.ok && parsed.value!==null && typeof parsed.value==='object' && !Array.isArray(parsed.value),'Invalid runner response');
  const row=parsed.value as Observation;
  const keys=[...Object.keys(expected),'status','kind','handlesSignaled','jobEmpty','writesStable','detail'].sort();
  requireThat(JSON.stringify(Object.keys(row).sort())===JSON.stringify(keys),'Unknown/missing runner response fields');
  requireThat(sameBinding(expected,row)&&row.kind===kind&&['running','stopped','unknown'].includes(row.status),'Runner scope/profile mismatch');
  requireThat(typeof row.handlesSignaled==='boolean'&&typeof row.jobEmpty==='boolean'&&typeof row.writesStable==='boolean','Invalid stop predicates');
  return row;
}

/** Single-owner ledger coordinator. Its host-only constructor is the profile/transport trust boundary. */
export class FixedRunnerCoordinator {
  readonly #profiles=new Map<string,Readonly<RunnerProfile>>();
  readonly #ports=new Map<string,FixedVerificationPort>();
  readonly #inflight=new Set<string>();
  constructor(readonly store:LedgerStore, profiles:readonly FixedRunnerRegistration[], readonly clock:()=>number=()=>Date.now(), readonly responseTimeoutMs=15000) {
    requireThat(Number.isSafeInteger(responseTimeoutMs)&&responseTimeoutMs>=1&&responseTimeoutMs<=120000,'Invalid response timeout');
    for(const {profile:p,port} of profiles){
      requireThat([p.principalId,p.id,p.isolationId].every(v=>uuid.test(v))&&typeof p.revision==='bigint'&&p.revision>0n&&p.revision<=max&&digest.test(p.digest)&&['synthetic','fixed_guest_fixture'].includes(p.kind)&&Number.isSafeInteger(p.ttlMs)&&p.ttlMs>=100&&p.ttlMs<=60000,'Invalid fixed profile');
      const key=this.#key(p);requireThat(!this.#profiles.has(key),'Duplicate profile binding');
      this.#profiles.set(key,Object.freeze({...p}));this.#ports.set(key,port);
    }
    this.recover();
  }
  #key(p:{principalId:string;id:string;revision:bigint}):string{return `${p.principalId}/${p.id}/${p.revision}`;}
  #lease(tx:LedgerReader,p:string,id:string):RunnerLease {const l=tx.runner.getLease(p,id);requireThat(l,'Unknown lease');return l;}
  #workspace(tx:LedgerReader,p:string,id:string):RunnerWorkspace {const w=tx.runner.getWorkspace(p,id);requireThat(w,'Unknown workspace');return w;}
  #profile(w:RunnerWorkspace):Readonly<RunnerProfile> {const p=this.#profiles.get(this.#key({principalId:w.principalId,id:w.profileId,revision:w.profileRevision}));requireThat(p&&p.digest===w.profileDigest&&p.isolationId===w.isolationId,'Profile not admitted to this fixed controller');return p;}
  #allowed(tx:LedgerReader,p:string,actor:string,scopeId:string):{version:string;actorGeneration:string;scopeEpochs:{id:string;epoch:string}[]} {
    const member=tx.getMembership(p,actor);requireThat(member?.role==='owner','Runner actor is not an owner');
    let scope=tx.getScope(scopeId);requireThat(scope&&scope.principalId===p,'Scope outside Principal');
    const seen=new Set<string>(),scopeEpochs:{id:string;epoch:string}[]=[];
    while(scope){requireThat(!seen.has(scope.id)&&seen.size<128&&scope.state==='active'&&(scope.principalId===p||scope.kind==='application'),'Stopped/invalid ancestor scope');seen.add(scope.id);scopeEpochs.push({id:scope.id,epoch:String(scope.epoch)});if(scope.parentId===null)break;scope=tx.getScope(scope.parentId);requireThat(scope,'Missing ancestor scope');}
    return {version:'runner-authority-v1',actorGeneration:String(member.generation),scopeEpochs};
  }
  #authority(tx:LedgerReader,l:RunnerLease):void {
    const captured=tx.getRecord(l.principalId,l.id);
    requireThat(captured?.kind==='evidence'&&captured.revision===1n&&captured.data===JSON.stringify(this.#allowed(tx,l.principalId,l.actorId,l.scopeId)),'Runner authority generation changed or missing');
  }
  #audit(tx:LedgerTransaction,l:RunnerLease,kind:string,now:number):void {tx.appendAudit({principalId:l.principalId,commandId:null,kind,entityId:l.id,createdAt:new Date(now).toISOString()});}
  #stop(tx:LedgerTransaction,l:RunnerLease,now:number,quarantine:boolean):RunnerLease {
    if(l.state==='released')return l;
    const state=quarantine?'quarantined':l.state==='quarantined'?'quarantined':'stop_requested';
    if(l.state===state)return l;
    const next={...l,state,stopEpoch:1n,revision:l.revision+1n,updatedAt:Math.max(now,l.updatedAt)} as RunnerLease;
    tx.runner.updateLease(next,l.revision);
    const w=this.#workspace(tx,l.principalId,l.workspaceId);tx.runner.updateWorkspace({...w,state:'quarantined'},w.generation);
    this.#audit(tx,next,`runner.${state}`,next.updatedAt);return next;
  }
  recover():void {
    const now=time(this.clock());
    this.store.transaction(tx=>{for(const p of tx.listPrincipal())for(const l of tx.runner.listLeases(p.id))if(l.state!=='released'&&(l.ownerId!==this.store.ownerId||l.ownerEpoch!==this.store.ownerEpoch))this.#stop(tx,l,now,true);});
  }
  prepare(workspace:Omit<RunnerWorkspace,'generation'|'state'>):RunnerWorkspace {
    requireThat(uuid.test(workspace.id)&&digest.test(workspace.snapshotDigest)&&digest.test(workspace.writeSetDigest),'Invalid workspace snapshot binding');
    const w:RunnerWorkspace={...workspace,generation:1n,state:'ready'},p=this.#profile(w);
    return this.store.transaction(tx=>{
      requireThat(tx.getPrincipal(w.principalId),'Unknown Principal');
      const old=tx.runner.getProfile(p.principalId,p.id,p.revision);
      if(!old)tx.runner.insertProfile({...p});else requireThat(old.digest===p.digest&&old.kind===p.kind&&old.ttlMs===p.ttlMs&&old.isolationId===p.isolationId,'Stored profile differs from trusted registration');
      const existing=tx.runner.getWorkspace(w.principalId,w.id);
      if(existing){requireThat(['profileId','profileRevision','profileDigest','snapshotDigest','writeSetDigest','isolationId'].every(k=>existing[k as keyof RunnerWorkspace]===w[k as keyof RunnerWorkspace]),'Workspace identity conflict');return existing;}
      tx.runner.insertWorkspace(w);return w;
    });
  }
  claim(principalId:string,workspaceId:string,scopeId:string,actorId:string):RunnerLease {
    const now=time(this.clock());
    return this.store.transaction(tx=>{
      const authority=this.#allowed(tx,principalId,actorId,scopeId);
      const w=this.#workspace(tx,principalId,workspaceId),p=this.#profile(w);
      requireThat(w.state==='ready'&&!tx.runner.listLeases(principalId).some(l=>l.workspaceId===w.id&&l.state!=='released'),'Workspace still has an unexcluded writer');
      requireThat(w.generation<max,'Workspace generation exhausted');
      const generation=w.generation+1n;tx.runner.updateWorkspace({...w,generation},w.generation);
      const l:RunnerLease={principalId,id:randomUUID(),workspaceId,generation,scopeId,actorId,ownerId:this.store.ownerId,ownerEpoch:this.store.ownerEpoch,stopEpoch:0n,operation:'verify',state:'active',revision:1n,sequence:0n,expiresAt:now+p.ttlMs,hardDeadline:now+p.ttlMs*2,updatedAt:now,dispatched:false,observationId:null};
      tx.insertRecord({principalId,id:l.id,kind:'evidence',revision:1n,data:JSON.stringify(authority)});
      tx.runner.insertLease(l);this.#audit(tx,l,'runner.claimed',now);return l;
    });
  }
  renew(principalId:string,id:string,ownerId:string,ownerEpoch:bigint,stopEpoch:bigint,sequence:bigint):boolean {
    const now=time(this.clock());
    return this.store.transaction(tx=>{
      const l=this.#lease(tx,principalId,id);
      if(l.state!=='active')return false;
      if(now<l.updatedAt||now>=l.expiresAt){this.#stop(tx,l,now,true);return false;}
      if(ownerId!==l.ownerId||ownerEpoch!==l.ownerEpoch||stopEpoch!==l.stopEpoch||l.ownerId!==this.store.ownerId||l.ownerEpoch!==this.store.ownerEpoch||typeof sequence!=='bigint'||sequence<=l.sequence||sequence>max)return false;
      try{this.#authority(tx,l);}catch{this.#stop(tx,l,now,true);return false;}
      const profile=this.#profile(this.#workspace(tx,principalId,l.workspaceId));
      tx.runner.updateLease({...l,sequence,expiresAt:Math.min(l.hardDeadline,now+profile.ttlMs),updatedAt:now,revision:l.revision+1n},l.revision);return true;
    });
  }
  maintain():RunnerLease[] {
    const now=time(this.clock());return this.store.transaction(tx=>{
      const pending:RunnerLease[]=[];
      for(const p of tx.listPrincipal())for(let l of tx.runner.listLeases(p.id)){
        if(l.state==='released')continue;
        let invalid=false;try{this.#authority(tx,l);}catch{invalid=true;}
        if(invalid||now<l.updatedAt||now>=l.expiresAt||l.ownerId!==this.store.ownerId||l.ownerEpoch!==this.store.ownerEpoch)l=this.#stop(tx,l,now,true);
        if(l.state!=='active')pending.push(l);
      }return pending;
    });
  }
  requestStop(principalId:string,id:string):RunnerLease {const now=time(this.clock());return this.store.transaction(tx=>this.#stop(tx,this.#lease(tx,principalId,id),now,false));}
  /** Called inside the core's existing scope-stop TX; no transport or nested transaction here. */
  stopDescendants(tx:LedgerTransaction,principalId:string,scopeId:string):void {
    const now=time(this.clock());
    for(const l of tx.runner.listLeases(principalId)){
      if(l.state==='released')continue;
      let scope=tx.getScope(l.scopeId);const seen=new Set<string>();
      while(scope&&!seen.has(scope.id)&&seen.size<128){
        if(scope.id===scopeId){this.#stop(tx,l,now,false);break;}
        seen.add(scope.id);scope=scope.parentId===null?undefined:tx.getScope(scope.parentId);
      }
    }
  }
  #binding(l:RunnerLease,w:RunnerWorkspace):Readonly<RunnerBinding> {return Object.freeze({principalId:l.principalId,leaseId:l.id,workspaceId:l.workspaceId,generation:String(l.generation),ownerId:l.ownerId,ownerEpoch:String(l.ownerEpoch),stopEpoch:String(l.stopEpoch),profileDigest:w.profileDigest,isolationId:w.isolationId});}
  async startExecutor(principalId:string,id:string):Promise<RunnerLease> {return this.#execute(principalId,id,'startExecutor');}
  async reconcile(principalId:string,id:string,stop=false):Promise<RunnerLease> {if(stop)this.requestStop(principalId,id);return this.#execute(principalId,id,stop?'requestStop':'inspect');}
  async #execute(principalId:string,id:string,operation:keyof FixedVerificationPort):Promise<RunnerLease> {
    requireThat(!this.#inflight.has(id),'Lease request is already in flight');this.#inflight.add(id);
    try {
      const now=time(this.clock());
      const prepared=this.store.transaction(tx=>{
        let l=this.#lease(tx,principalId,id);const w=this.#workspace(tx,principalId,l.workspaceId),p=this.#profile(w);
        if(l.state==='released')return {l,w,p,send:false};
        if(operation==='startExecutor'){
          this.#authority(tx,l);
          requireThat(l.ownerId===this.store.ownerId&&l.ownerEpoch===this.store.ownerEpoch&&l.state==='active'&&!l.dispatched&&now>=l.updatedAt&&now<l.expiresAt,'Start refused; reconcile before retry');
          l={...l,dispatched:true,revision:l.revision+1n,updatedAt:now};tx.runner.updateLease(l,l.revision-1n);this.#audit(tx,l,'runner.start_intent',now);
        }
        return {l,w,p,send:true};
      });
      if(!prepared.send)return prepared.l;
      const binding=this.#binding(prepared.l,prepared.w),port=this.#ports.get(this.#key(prepared.p))!;
      let result:Observation;
      let timeout:ReturnType<typeof setTimeout>|undefined;
      try{
        const pending=port[operation](binding);
        const bytes=await Promise.race([pending,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Runner observation timeout')),this.responseTimeoutMs);})]);
        result=observation(bytes,binding,prepared.p.kind);
      }
      catch{
        return this.store.transaction(tx=>this.#stop(tx,this.#lease(tx,principalId,id),time(this.clock()),true));
      }finally{if(timeout!==undefined)clearTimeout(timeout);}
      return this.store.transaction(tx=>{
        let l=this.#lease(tx,principalId,id);if(l.state==='released')return l;
        const current=this.#binding(l,this.#workspace(tx,principalId,l.workspaceId));
        // A response from before a stop/generation change cannot discharge the newer stop obligation.
        if(!sameBinding(binding,current))return l;
        const observedAt=Math.max(time(this.clock()),l.updatedAt);
        if(result.status==='running'&&l.state==='active'){
          if(observedAt>=l.expiresAt)return this.#stop(tx,l,observedAt,true);
          return l;
        }
        if(result.status!=='stopped'||!result.handlesSignaled||!result.jobEmpty||!result.writesStable)return this.#stop(tx,l,observedAt,true);
        const proof:RunnerStopObservation={principalId,id:randomUUID(),leaseId:id,workspaceId:l.workspaceId,generation:l.generation,ownerId:l.ownerId,ownerEpoch:l.ownerEpoch,stopEpoch:l.stopEpoch,kind:prepared.p.kind,handlesSignaled:true,jobEmpty:true,writesStable:true,observedAt,detail:JSON.stringify(result.detail)};
        tx.runner.insertObservation(proof);
        l={...l,state:'released',observationId:proof.id,revision:l.revision+1n,updatedAt:observedAt};tx.runner.updateLease(l,l.revision-1n);
        const w=this.#workspace(tx,principalId,l.workspaceId);tx.runner.updateWorkspace({...w,state:'ready'},w.generation);
        this.#audit(tx,l,'runner.stopped_observed',observedAt);return l;
      });
    } finally {this.#inflight.delete(id);}
  }
}
