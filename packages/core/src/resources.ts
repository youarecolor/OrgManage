import { createHash, randomUUID } from 'node:crypto';
import type { LedgerStore, LedgerReader, LedgerRecord, LedgerTransaction } from '../../ledger/src/index.js';

export interface ResourceWindow { readonly id: string; readonly revision: string; readonly startsAt: number; readonly resetsAt: number }
export interface ResourcePool {
  readonly kind: 'quota';
  readonly provider: string; readonly account: string; readonly pool: string; readonly unit: string;
  readonly windows: readonly ResourceWindow[]; readonly freshnessMs: number;
}
export interface ResourceObservation {
  readonly windowId: string; readonly revision: string; readonly remaining: string | null;
  readonly observedAt: number; readonly evidenceId: string; readonly reflectedHoldIds: readonly string[];
}
interface Hold {
  format: 'resource_hold_v1'; poolDigest: string; profileDigest: string; windows: readonly ResourceWindow[]; effectId: string; effectKind: 'attempt' | 'control_operation';
  scopeId: string; actorId: string; authority: string; ownerId: string; ownerEpoch: string;
  amounts: Record<string,string>; state: 'reserved' | 'send_acquired' | 'consumed' | 'unconsumed' | 'unknown';
  evidenceId: string | null;
  reservationSnapshot: {principalId:string;id:string}; sendSnapshot: {principalId:string;id:string}|null;
}
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
function check(v:unknown,code:string):asserts v {if(!v)throw new Error(code);}
const amount=(v:unknown):bigint=>{check(typeof v==='string'&&/^(0|[1-9][0-9]{0,17})(?![\s\S])/.test(v),'INVALID_RESOURCE_AMOUNT');return BigInt(v);};
const time=(v:number)=>{check(Number.isSafeInteger(v)&&v>=0,'INVALID_RESOURCE_TIME');return v;};
const data=<T>(r:LedgerRecord):T=>JSON.parse(r.data) as T;

/** Trusted core quota port. It grants neither provider access nor a cash exemption or ticket use.
 * A caller must supply an actual reservable unit; a remaining percentage is not a per-turn bound. */
export class ResourceCoordinator {
  readonly pool: Readonly<ResourcePool>;
  readonly poolDigest: string;
  readonly profileDigest: string;
  constructor(readonly store:LedgerStore,pool:ResourcePool,readonly clock:()=>number=()=>Date.now()) {
    check([pool.provider,pool.account,pool.pool,pool.unit].every(v=>typeof v==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(v)),'INVALID_RESOURCE_POOL');
    check(pool.kind==='quota','TICKET_APPROVAL_PATH_REQUIRED');
    check(pool.unit!=='ticket'&&pool.unit!=='reset_credit','TICKET_APPROVAL_PATH_REQUIRED');
    check(Number.isSafeInteger(pool.freshnessMs)&&pool.freshnessMs>0&&pool.freshnessMs<=300000,'INVALID_RESOURCE_FRESHNESS');
    check(pool.windows.length>0&&pool.windows.length<=8&&new Set(pool.windows.map(w=>w.id)).size===pool.windows.length,'INVALID_RESOURCE_WINDOWS');
    const windows=pool.windows.map(w=>{
      check(/^[A-Za-z0-9_-]{1,64}$/.test(w.id)&&/^[1-9][0-9]{0,17}$/.test(w.revision)&&time(w.startsAt)<time(w.resetsAt),'INVALID_RESOURCE_WINDOW');
      return Object.freeze({id:w.id,revision:w.revision,startsAt:w.startsAt,resetsAt:w.resetsAt});
    }).sort((a,b)=>a.id.localeCompare(b.id,'en'));
    this.pool=Object.freeze({kind:'quota',provider:pool.provider,account:pool.account,pool:pool.pool,unit:pool.unit,freshnessMs:pool.freshnessMs,windows:Object.freeze(windows)});
    this.poolDigest=digest({provider:pool.provider,account:pool.account,pool:pool.pool});
    this.profileDigest=digest(this.pool);
  }
  #records(tx:LedgerReader,kind:'resource_hold'|'resource_snapshot'):LedgerRecord[] {
    // A shared provider account cannot be overbooked by giving each Principal a separate capacity copy.
    return tx.listPrincipal().flatMap(p=>tx.listRecord(p.id,kind)).filter(r=>JSON.parse(r.data).poolDigest===this.poolDigest);
  }
  #evidence(tx:LedgerReader,p:string,id:string):void {check(tx.getRecord(p,id)?.kind==='evidence','RESOURCE_EVIDENCE_REQUIRED');}
  #member(tx:LedgerReader,p:string,actor:string):string {const m=tx.getMembership(p,actor);check(m?.role==='owner','RESOURCE_ACTOR_DENIED');return String(m.generation);}
  #authority(tx:LedgerReader,p:string,actor:string,scopeId:string):string {
    const generation=this.#member(tx,p,actor),scopes=[];let scope=tx.getScope(scopeId);const seen=new Set<string>();
    check(scope&&scope.principalId===p,'RESOURCE_SCOPE_DENIED');
    while(scope){check(scope.state==='active'&&!seen.has(scope.id)&&seen.size<128&&(scope.principalId===p||scope.kind==='application'),'RESOURCE_SCOPE_STOPPED');seen.add(scope.id);scopes.push([scope.id,String(scope.epoch)]);if(scope.parentId===null)break;scope=tx.getScope(scope.parentId);check(scope,'RESOURCE_SCOPE_MISSING');}
    return digest({generation,scopes});
  }
  observe(principalId:string,actor:string,observations:readonly ResourceObservation[]):string {
    const copied=JSON.parse(JSON.stringify(observations)) as ResourceObservation[];
    check(copied.length===this.pool.windows.length&&new Set(copied.map(o=>o.windowId)).size===copied.length,'ALL_RESOURCE_WINDOWS_REQUIRED');
    return this.store.transaction(tx=>{
      this.#member(tx,principalId,actor);const now=time(this.clock()),holds=this.#records(tx,'resource_hold');
      for(const o of copied){
        const w=this.pool.windows.find(w=>w.id===o.windowId);check(w&&o.revision===w.revision&&time(o.observedAt)<=now&&o.observedAt>=w.startsAt&&o.observedAt<w.resetsAt,'RESOURCE_OBSERVATION_WINDOW_MISMATCH');
        if(o.remaining!==null)amount(o.remaining);this.#evidence(tx,principalId,o.evidenceId);
        check(Array.isArray(o.reflectedHoldIds)&&o.reflectedHoldIds.length<=4096&&new Set(o.reflectedHoldIds).size===o.reflectedHoldIds.length,'INVALID_RESOURCE_COVERAGE');
        for(const id of o.reflectedHoldIds){const r=holds.find(r=>r.id===id);check(r&&data<Hold>(r).state==='consumed','UNPROVEN_RESOURCE_COVERAGE');}
      }
      const previous=this.#records(tx,'resource_snapshot').filter(r=>JSON.parse(r.data).profileDigest===this.profileDigest);
      for(const r of previous)for(const old of data<{observations:ResourceObservation[]}>(r).observations){const next=copied.find(o=>o.windowId===old.windowId)!;check(next.observedAt>old.observedAt,'RESOURCE_OBSERVATION_NOT_NEWER');}
      const id=randomUUID();tx.insertRecord({principalId,id,kind:'resource_snapshot',revision:1n,data:JSON.stringify({format:'resource_snapshot_v1',poolDigest:this.poolDigest,profileDigest:this.profileDigest,observations:copied})});return id;
    });
  }
  #availability(tx:LedgerReader,now:number,excludeHold?:string):{available:Record<string,bigint>;snapshot:{principalId:string;id:string}} {
    const snapshots=this.#records(tx,'resource_snapshot').filter(r=>JSON.parse(r.data).profileDigest===this.profileDigest);check(snapshots.length>0,'RESOURCE_OBSERVATION_MISSING');
    check(snapshots.every(r=>r.revision===1n),'RESOURCE_OBSERVATION_MUTATED');
    const snapshot=snapshots.sort((a,b)=>data<{observations:ResourceObservation[]}>(b).observations[0]!.observedAt-data<{observations:ResourceObservation[]}>(a).observations[0]!.observedAt)[0]!;
    const observations=data<{observations:ResourceObservation[]}>(snapshot).observations;
    const holds=this.#records(tx,'resource_hold'),available:Record<string,bigint>=Object.create(null);
    for(const w of this.pool.windows){
      const o=observations.find(o=>o.windowId===w.id);
      check(o&&o.revision===w.revision&&o.remaining!==null&&now>=o.observedAt&&now-o.observedAt<this.pool.freshnessMs&&now>=w.startsAt&&now<w.resetsAt,'RESOURCE_STALE_OR_UNKNOWN');
      let left=amount(o.remaining);
      for(const row of holds){
        if(row.id===excludeHold)continue;const h=data<Hold>(row);
        if(h.state==='unconsumed'||(h.state==='consumed'&&o.reflectedHoldIds.includes(row.id)))continue;
        const oldWindow=h.windows.find(old=>old.id===w.id&&old.revision===w.revision&&old.startsAt===w.startsAt&&old.resetsAt===w.resetsAt);
        if(!oldWindow){check(h.state==='consumed'&&h.windows.every(old=>old.resetsAt<=w.startsAt),'RESOURCE_PRIOR_WINDOW_UNRESOLVED');continue;}
        check(h.profileDigest===this.profileDigest,'RESOURCE_POOL_PROFILE_CHANGED');
        left-=amount(h.amounts[w.id]);
      }
      available[w.id]=left;
    }
    return {available,snapshot:{principalId:snapshot.principalId,id:snapshot.id}};
  }
  reserve(principalId:string,actor:string,scopeId:string,effectKind:Hold['effectKind'],effectId:string,requested:Readonly<Record<string,string>>):string {
    return this.store.transaction(tx=>this.reserveInTransaction(tx,principalId,actor,scopeId,effectKind,effectId,requested));
  }
  /** Joins Run/Attempt creation; a quota failure rolls the whole caller transaction back. */
  reserveInTransaction(tx:LedgerTransaction,principalId:string,actor:string,scopeId:string,effectKind:Hold['effectKind'],effectId:string,requested:Readonly<Record<string,string>>):string {
    this.store.assertTransaction(tx);
    check(effectKind==='attempt'||effectKind==='control_operation','RESOURCE_EFFECT_KIND');
    const amounts={...requested};check(Object.keys(amounts).sort().join('|')===this.pool.windows.map(w=>w.id).sort().join('|'),'ALL_RESOURCE_WINDOWS_REQUIRED');
    for(const v of Object.values(amounts))check(amount(v)>0n,'RESOURCE_RESERVATION_MUST_BE_POSITIVE');
      const now=time(this.clock()),authority=this.#authority(tx,principalId,actor,scopeId);
      const effect=tx.getRecord(principalId,effectId);check(effect?.kind===effectKind,'RESOURCE_EFFECT_MISSING');
      const effectData=data<{scopeId?:string;attemptId?:string}>(effect);
      const effectScope=tx.native.getAttempt(principalId,effectId)?.scopeId
        ?? (effectData.attemptId?tx.native.getAttempt(principalId,effectData.attemptId)?.scopeId:effectData.scopeId);
      check(effectScope===scopeId,'RESOURCE_EFFECT_SCOPE_MISMATCH');
      const rows=this.#records(tx,'resource_hold');
      check(!rows.some(r=>r.principalId===principalId&&data<Hold>(r).effectId===effectId),'RESOURCE_EFFECT_ALREADY_RESERVED');
      const observation=this.#availability(tx,now);for(const w of this.pool.windows)check(observation.available[w.id]!>=amount(amounts[w.id]),'RESOURCE_CAPACITY_EXCEEDED');
      const id=randomUUID(),hold:Hold={format:'resource_hold_v1',poolDigest:this.poolDigest,profileDigest:this.profileDigest,windows:this.pool.windows,effectId,effectKind,scopeId,actorId:actor,authority,
        ownerId:this.store.ownerId,ownerEpoch:String(this.store.ownerEpoch),amounts,state:'reserved',evidenceId:null,reservationSnapshot:observation.snapshot,sendSnapshot:null};
      tx.insertRecord({principalId,id,kind:'resource_hold',revision:1n,data:JSON.stringify(hold)});return id;
  }
  acquireSend(principalId:string,actor:string,id:string):void {
    this.store.transaction(tx=>{
      const row=tx.getRecord(principalId,id);check(row?.kind==='resource_hold','RESOURCE_HOLD_MISSING');const hold=data<Hold>(row);
      this.acquireSendInTransaction(tx,principalId,actor,id,{scopeId:hold.scopeId,effectKind:hold.effectKind,effectId:hold.effectId});
    });
  }
  /** Same TX as send_intent; never use another Attempt's valid reservation. */
  acquireSendInTransaction(tx:LedgerTransaction,principalId:string,actor:string,id:string,expected:Readonly<{scopeId:string;effectKind:Hold['effectKind'];effectId:string}>):void {
      this.store.assertTransaction(tx);
      const row=tx.getRecord(principalId,id);check(row?.kind==='resource_hold','RESOURCE_HOLD_MISSING');const hold=data<Hold>(row);
      check(hold.scopeId===expected.scopeId&&hold.effectKind===expected.effectKind&&hold.effectId===expected.effectId,'RESOURCE_EFFECT_BINDING_MISMATCH');
      check(hold.poolDigest===this.poolDigest&&hold.profileDigest===this.profileDigest&&hold.actorId===actor&&hold.state==='reserved'&&hold.ownerId===this.store.ownerId&&hold.ownerEpoch===String(this.store.ownerEpoch),'RESOURCE_SEND_ALREADY_CLAIMED_OR_STALE');
      check(hold.authority===this.#authority(tx,principalId,actor,hold.scopeId),'RESOURCE_AUTHORITY_CHANGED');
      const observation=this.#availability(tx,time(this.clock()),id);for(const w of this.pool.windows)check(observation.available[w.id]!>=amount(hold.amounts[w.id]),'RESOURCE_CAPACITY_EXCEEDED');
      tx.updateRecord({...row,revision:row.revision+1n,data:JSON.stringify({...hold,state:'send_acquired',sendSnapshot:observation.snapshot})},row.revision);
  }
  cancelReserved(principalId:string,actor:string,id:string):void {
    this.store.transaction(tx=>{
      this.#member(tx,principalId,actor);
      const row=tx.getRecord(principalId,id);check(row?.kind==='resource_hold','RESOURCE_HOLD_MISSING');const hold=data<Hold>(row);
      check(hold.poolDigest===this.poolDigest&&hold.state==='reserved','RESOURCE_SEND_MAY_HAVE_OCCURRED');
      const evidenceId=randomUUID();
      tx.insertRecord({principalId,id:evidenceId,kind:'evidence',revision:1n,data:JSON.stringify({format:'resource_unsent_cancel_v1',holdId:id,holdRevision:String(row.revision),ownerId:this.store.ownerId,at:time(this.clock())})});
      tx.updateRecord({...row,revision:row.revision+1n,data:JSON.stringify({...hold,state:'unconsumed',evidenceId})},row.revision);
    });
  }
  settle(principalId:string,id:string,state:'consumed'|'unconsumed'|'unknown',evidenceId:string,actual?:Readonly<Record<string,string>>):void {
    // Trusted observation ingress only. Evidence authenticity/admission belongs to the qualified adapter.
    this.store.transaction(tx=>{
      this.#evidence(tx,principalId,evidenceId);
      const row=tx.getRecord(principalId,id);check(row?.kind==='resource_hold','RESOURCE_HOLD_MISSING');const hold=data<Hold>(row);
      check(hold.poolDigest===this.poolDigest&&['send_acquired','unknown'].includes(hold.state)&&['consumed','unconsumed','unknown'].includes(state),'RESOURCE_SETTLEMENT_DENIED');
      let amounts=hold.amounts;
      if(state==='consumed'){
        check(actual&&Object.keys(actual).sort().join('|')===Object.keys(hold.amounts).sort().join('|'),'RESOURCE_ACTUAL_USAGE_REQUIRED');
        amounts={...actual};for(const v of Object.values(amounts))amount(v);
      }else check(actual===undefined,'UNEXPECTED_RESOURCE_ACTUAL');
      tx.updateRecord({...row,revision:row.revision+1n,data:JSON.stringify({...hold,amounts,state,evidenceId})},row.revision);
    });
  }
}
