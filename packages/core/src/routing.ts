import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { yen } from './budget.js';
import {moneyUnits,type Money} from './money.js';

/** A proposal is never an execution capability. The send transaction must still
 * acquire current disclosure, budget, runtime, scope and ActionApproval guards. */
export interface ExecutionConfiguration {
  id: string; version: string; persona: string; model: string; effort: string;
  promptVersion: string; contextPolicyVersion: string; tools: readonly string[];
  runtime: 'standard' | 'native'; billingRoute: string;
  capabilities: readonly string[]; contextCapacity: number;
  quality: number; expiresAt: number;
  evidence: { kind: 'teacher_prediction' | 'controlled_comparison' | 'observed_selected_only'; ref: string };
}
export interface SealedConfiguration { configuration: Readonly<ExecutionConfiguration>; digest: string }
export interface RouteObservation {
  digest: string; observedAt: number; expiresAt: number;
  permitted: boolean; qualified: boolean; disclosureAllowed: boolean;
  quota: 'available' | 'unknown' | 'exhausted';
  verifiedNoExtraCharge: boolean;
  maximumYen?: string; expectedTotalYen?: string; maximum?:Money;expectedTotal?:Money;expectedCompletionMs: number;
  includesRework: boolean; evidenceRef: string;
}
export interface RoutingInput {
  originalText: string; policyVersion: string; now: number;
  revisionText?: string | null;
  minimumQuality: number; contextSize: number; requiredCapabilities: readonly string[];
  availableYen?: string; available?:Money;nativeEnabled: boolean; standardDigest: string;
  // These values are trusted Core observations, never renderer assertions.
  current: null | { digest: string; policyVersion: string; valid: boolean; activeTurn: boolean };
  reselect: boolean;
  observations: readonly RouteObservation[];
}
export interface RoutingDecision {
  kind: 'continue' | 'select' | 'wait' | 'blocked';
  digest: string | null; reason: string; policyVersion: string;
  inputDigest: string; candidates: readonly string[];
  rejected: readonly { digest: string; reason: string }[];
  evidence: ExecutionConfiguration['evidence'] | null;
  executionAuthorized: false;
}
const hash=(value:unknown)=>createHash('sha256').update(canonicalize(value)!).digest('hex');
function check(value:unknown,code:string):asserts value {if(!value)throw Error(code);}
const text=(v:unknown)=>typeof v==='string'&&v.length>0&&v.length<=512;
const integer=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>=0;
const strings=(v:unknown):v is string[]=>Array.isArray(v)&&v.length<=128&&v.every(text)&&new Set(v).size===v.length;
function amount(cash:boolean,value:Money|undefined,legacy:string|undefined):bigint{
  if(cash){check(value?.currency==='USD'&&legacy===undefined,'ROUTE_CURRENCY');return moneyUnits(value);}
  check(value===undefined,'ROUTE_CURRENCY');return yen(legacy!);
}

/** Installed by the trusted host from reviewed profiles. No model downloads or sends. */
export function sealConfiguration(value:ExecutionConfiguration):SealedConfiguration {
  const c=structuredClone(value);
  check(Object.keys(c).sort().join(',')===['id','version','persona','model','effort','promptVersion','contextPolicyVersion','tools','runtime','billingRoute','capabilities','contextCapacity','quality','expiresAt','evidence'].sort().join(','),'ROUTE_UNKNOWN_FIELD');
  check([c.id,c.version,c.persona,c.model,c.effort,c.promptVersion,c.contextPolicyVersion,c.billingRoute].every(text),'ROUTE_CONFIGURATION_INVALID');
  check(strings(c.tools)&&strings(c.capabilities)&&integer(c.contextCapacity)&&integer(c.quality)&&c.quality<=100&&integer(c.expiresAt),'ROUTE_CONFIGURATION_INVALID');
  check(c.runtime==='standard'||c.runtime==='native','ROUTE_RUNTIME_INVALID');
  check(c.evidence&&Object.keys(c.evidence).sort().join(',')==='kind,ref'&&text(c.evidence.ref)&&['teacher_prediction','controlled_comparison','observed_selected_only'].includes(c.evidence.kind),'ROUTE_EVIDENCE_INVALID');
  Object.freeze(c.tools);Object.freeze(c.capabilities);Object.freeze(c.evidence);Object.freeze(c);
  return Object.freeze({configuration:c,digest:hash(c)});
}

export function selectRoute(pool:readonly SealedConfiguration[],input:RoutingInput):RoutingDecision {
  check(pool.length>0&&pool.length<=128&&new Set(pool.map(p=>p.digest)).size===pool.length&&new Set(pool.map(p=>p.configuration.id)).size===pool.length,'ROUTE_POOL_INVALID');
  for(const p of pool)check(sealConfiguration(p.configuration).digest===p.digest,'ROUTE_SEAL_MISMATCH');
  check(typeof input.originalText==='string'&&Buffer.byteLength(input.originalText,'utf8')<=1048576&&text(input.policyVersion)&&integer(input.now),'ROUTE_INPUT_INVALID');
  check(input.revisionText==null||(typeof input.revisionText==='string'&&Buffer.byteLength(input.revisionText,'utf8')<=1048576),'ROUTE_REVISION_INVALID');
  check(integer(input.minimumQuality)&&input.minimumQuality<=100&&integer(input.contextSize)&&strings(input.requiredCapabilities),'ROUTE_REQUIREMENTS_INVALID');
  check(typeof input.nativeEnabled==='boolean'&&typeof input.reselect==='boolean'&&pool.some(p=>p.digest===input.standardDigest),'ROUTE_POLICY_INVALID');
  const cash=input.available!==undefined,available=amount(cash,input.available,input.availableYen);
  check(input.observations.length<=128&&new Set(input.observations.map(o=>o.digest)).size===input.observations.length,'ROUTE_OBSERVATIONS_INVALID');
  const inputDigest=hash(input),rejected:{digest:string;reason:string}[]=[];
  const eligible:{p:SealedConfiguration;o:RouteObservation;expected:bigint}[]=[];
  for(const p of pool){
    const c=p.configuration,o=input.observations.find(o=>o.digest===p.digest);
    let reason='',expected=0n;
    if(!o)reason='observation_missing';
    else {
      check(integer(o.observedAt)&&integer(o.expiresAt)&&integer(o.expectedCompletionMs)&&text(o.evidenceRef),'ROUTE_OBSERVATION_INVALID');
      check([o.permitted,o.qualified,o.disclosureAllowed,o.verifiedNoExtraCharge,o.includesRework].every(v=>typeof v==='boolean')&&['available','unknown','exhausted'].includes(o.quota),'ROUTE_OBSERVATION_INVALID');
      const maximum=amount(cash,o.maximum,o.maximumYen);expected=amount(cash,o.expectedTotal,o.expectedTotalYen);
      check(expected<=maximum,'ROUTE_ESTIMATE_INVALID');
      if(o.observedAt>input.now||o.expiresAt<=input.now||c.expiresAt<=input.now)reason='expired';
      else if(!o.permitted||!o.qualified||!o.disclosureAllowed)reason='not_admitted';
      else if(!input.nativeEnabled&&c.runtime==='native')reason='native_disabled';
      else if(c.quality<input.minimumQuality||c.contextCapacity<input.contextSize||!input.requiredCapabilities.every(v=>c.capabilities.includes(v)))reason='requirements_not_met';
      else if(o.quota==='exhausted'||(o.quota==='unknown'&&!(o.verifiedNoExtraCharge&&maximum===0n)))reason='quota_unavailable';
      else if(maximum>available)reason='budget_unavailable';
      else if(!o.includesRework)reason='total_estimate_missing';
    }
    if(reason)rejected.push({digest:p.digest,reason});else eligible.push({p,o:o!,expected});
  }
  const result=(kind:RoutingDecision['kind'],selected:SealedConfiguration|null,reason:string,candidates:readonly string[]):RoutingDecision=>({kind,digest:selected?.digest??null,reason,policyVersion:input.policyVersion,inputDigest,candidates,rejected,evidence:selected?.configuration.evidence??null,executionAuthorized:false});
  const current=input.current;
  if(current){
    check(typeof current.valid==='boolean'&&typeof current.activeTurn==='boolean'&&text(current.policyVersion)&&text(current.digest),'ROUTE_SESSION_INVALID');
    // Never switch an active native turn, or reinterpret an existing run under a new policy.
    if(current.activeTurn)return result('wait',null,'active_turn_reconcile_before_routing',[]);
    if(current.policyVersion!==input.policyVersion)return result('blocked',null,'run_policy_changed',[]);
    const previous=eligible.find(e=>e.p.digest===current.digest);
    if(current.valid&&previous&&!input.reselect)return result('continue',previous.p,'valid_session_continuation',[previous.p.digest]);
  }
  if(!eligible.length)return result('blocked',null,'no_admissible_configuration',[]);
  // Pareto frontier avoids inventing a money/time exchange rate. Evidence kinds
  // remain distinct; a selected-only observation does not prove comparative superiority.
  const frontier=eligible.filter(a=>!eligible.some(b=>b!==a&&b.expected<=a.expected&&b.o.expectedCompletionMs<=a.o.expectedCompletionMs&&(b.expected<a.expected||b.o.expectedCompletionMs<a.o.expectedCompletionMs)));
  const standard=eligible.find(e=>e.p.digest===input.standardDigest);
  const comparable=frontier.length===1&&eligible.every(e=>e.p.configuration.evidence.kind==='controlled_comparison'&&e.p.configuration.evidence.ref===frontier[0]!.p.configuration.evidence.ref);
  const winner=eligible.length===1?eligible[0]:comparable?frontier[0]:standard;
  const candidates=[...(winner?[winner]:[]),...frontier.filter(e=>e!==winner).sort((a,b)=>a.p.digest<b.p.digest?-1:1)].slice(0,3).map(e=>e.p.digest);
  return winner?result('select',winner.p,eligible.length===1?'only_admissible_configuration':comparable?'comparable_total_cost_and_time':'standard_profile_under_uncertainty',candidates):result('blocked',null,'incomparable_candidates_require_decision',candidates);
}

/** Qualifies every member of a caller-declared provider routing pool. This is
 * neither selection of an actual model nor permission to dispatch. */
export function qualifyRoutingPool(pool:readonly SealedConfiguration[],input:RoutingInput){
  // Run the common full-input/seal validation before narrowing to each member.
  selectRoute(pool,input);
  check(pool.length<=16&&new Set(pool.map(p=>p.configuration.model)).size===pool.length,'ROUTE_AUTO_POOL_INVALID');
  if(input.current){
    check(!input.current.activeTurn,'ROUTE_AUTO_ACTIVE_TURN');
    check(input.current.policyVersion===input.policyVersion,'ROUTE_AUTO_POLICY_CHANGED');
    check(!input.current.valid&&input.reselect,'ROUTE_AUTO_SESSION_PIN_REQUIRED');
  }
  const first=pool[0]!.configuration;
  const common=(c:Readonly<ExecutionConfiguration>)=>({persona:c.persona,effort:c.effort,promptVersion:c.promptVersion,contextPolicyVersion:c.contextPolicyVersion,tools:c.tools,runtime:c.runtime,billingRoute:c.billingRoute});
  const cash=input.available!==undefined,shared=common(first),rejected:{digest:string;reason:string}[]=[],members:{digest:string;model:string;maximumYen?:string;maximum?:Money;expiresAt:number;evidenceRef:string}[]=[];
  let maximum=0n,expiresAt=Number.MAX_SAFE_INTEGER;
  for(const p of pool){
    check(canonicalize(common(p.configuration))===canonicalize(shared),'ROUTE_AUTO_REQUEST_PROFILE_MISMATCH');
    const observation=input.observations.find(o=>o.digest===p.digest);
    const result=selectRoute([p],{...input,standardDigest:p.digest,current:null,observations:observation?[observation]:[]});
    if(result.kind!=='select'){rejected.push(...result.rejected);continue;}
    const o=observation!,bound=amount(cash,o.maximum,o.maximumYen),expiry=Math.min(o.expiresAt,p.configuration.expiresAt);
    if(bound>maximum)maximum=bound;expiresAt=Math.min(expiresAt,expiry);
    members.push({digest:p.digest,model:p.configuration.model,...(cash?{maximum:o.maximum!}:{maximumYen:o.maximumYen!}),expiresAt:expiry,evidenceRef:o.evidenceRef});
  }
  // A failed candidate is not silently dropped from the approved/requested pool.
  const eligible=rejected.length===0&&members.length===pool.length;
  return {kind:eligible?'eligible' as const:'blocked' as const,poolDigest:hash({pool,input}),policyVersion:input.policyVersion,
    members,rejected,...(cash?{maximum:eligible?{format:'money_v1' as const,currency:'USD' as const,units:String(maximum)}:null}:{maximumYen:eligible?String(maximum):null}),expiresAt:eligible?expiresAt:null,
    sharedConfiguration:structuredClone(shared),executionAuthorized:false as const};
}
