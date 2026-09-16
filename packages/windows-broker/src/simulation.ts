import {randomUUID} from 'node:crypto';
import {actionDigest, contentDigest, decodeBrokerRequest, isDigest, isId} from './contract.js';
import type {BrokerRequest, RestartOperation} from './contract.js';

/** All evidence below is synthetic. This module NEVER queries Windows, opens IPC,
 * executes a service/command, or grants real authority. Do not use as an OS adapter. */
export interface SimulatedPeer {
  readonly evidence: 'simulation';
  readonly user: string;
  readonly logon: string;
  readonly authenticationId: string;
  readonly pid: number;
  readonly creationTime: string;
  readonly integrity: 'medium';
  readonly imageDigest: string;
  readonly codeClosureDigest: string;
  readonly instanceId: string;
}
export interface SimulatedObservation {
  readonly peer: SimulatedPeer;
  readonly local: boolean;
  readonly identityKnown: boolean;
  readonly retainedProcessAlive: boolean;
  readonly protectedImage: boolean;
  readonly serverAuthenticated: boolean;
  readonly closedIngress: boolean;
}
export interface SimulatedPolicy {
  readonly revision: string;
  readonly resourceId: string;
  readonly configurationDigest: string;
  readonly targetProtected: boolean;
  readonly maxLifetimeMs: number;
  readonly maxTimeoutMs: number;
}
export interface SimulatedApproval {
  readonly evidence: 'simulation';
  readonly principalId: string;
  readonly subject: {readonly kind: 'run' | 'control_operation'; readonly id: string};
  readonly approvalId: string;
  readonly adminApprovalId: string;
  readonly actionDigest: string;
  readonly coreDecision: 'approved';
  readonly independentAdminDecision: 'approved';
  readonly policyRevision: string;
  readonly instanceId: string;
  readonly brokerBootId: string;
  readonly expiresAtMs: number;
}
declare const connectionBrand: unique symbol;
export interface SimulationConnection {readonly [connectionBrand]: true}
export type EffectState = 'running' | 'succeeded' | 'failed' | 'unknown';
export interface SimulationEffect {
  readonly requestId: string;
  readonly permitId: string;
  readonly requestDigest: string;
  readonly actionDigest: string;
  readonly operation: RestartOperation;
  readonly principalId: string;
  readonly subject: SimulatedApproval['subject'];
  readonly approvalId: string;
  readonly adminApprovalId: string;
  readonly connectionId: string;
  readonly instanceId: string;
  readonly policyRevision: string;
  readonly bootId: string;
  state: EffectState;
  cancellation: 'not_requested' | 'requested' | 'observed';
  readonly deadline: number;
  readonly wallDeadline: number;
}
export interface SimulationEvent {
  readonly evidence: 'simulation';
  readonly kind: string;
  readonly requestId: string | null;
  readonly permitId: string | null;
  readonly code: string | null;
}
interface State {bootId: string; effects: Map<string, SimulationEffect>; events: SimulationEvent[]; starts: number; decisions: Set<string>}
const journals = new WeakMap<SimulationJournal, State>();
/** Models a protected journal across broker incarnations, within ONE process.
 * Not a durable Windows store, ACL, atomic disk transaction or crash-recovery proof. */
export class SimulationJournal {
  #failWrites = false;
  constructor() { journals.set(this, {bootId: '', effects: new Map(), events: [], starts: 0, decisions: new Set()}); }
  failWritesForSimulation(fail: boolean): void { this.#failWrites = fail; }
  canAppendForSimulation(): boolean { return !this.#failWrites; }
}
interface Connection {id: string; active: boolean; peer: SimulatedPeer; observation: SimulatedObservation}
interface Permit {
  id: string; connection: Connection; approval: SimulatedApproval; operation: RestartOperation;
  timeoutMs: number; deadline: number; wallDeadline: number; consumed: boolean; revoked: boolean;
}
export type StartResult = {ok: true; evidence: 'simulation'; duplicate: boolean; effect: SimulationEffect}
  | {ok: false; code: string; retry: 'none'};
function requireValue(value: unknown, code: string): asserts value { if (!value) throw Error(code); }
function active(state: EffectState): boolean { return state === 'running' || state === 'unknown'; }
function requestStop(effect: SimulationEffect): void {
  if (effect.cancellation === 'not_requested') effect.cancellation = 'requested';
}
function validLabel(value: unknown): boolean { return typeof value === 'string' && /^[A-Za-z0-9:._-]{1,128}$/.test(value); }
function validatePolicy(policy: SimulatedPolicy): void {
  requireValue(policy && isId(policy.resourceId) && isId(policy.revision) && isDigest(policy.configurationDigest)
    && typeof policy.targetProtected === 'boolean'
    && Number.isSafeInteger(policy.maxLifetimeMs) && policy.maxLifetimeMs > 0 && policy.maxLifetimeMs <= 300_000
    && Number.isSafeInteger(policy.maxTimeoutMs) && policy.maxTimeoutMs > 0 && policy.maxTimeoutMs <= 30_000, 'INVALID_POLICY_FIXTURE');
}

export class BrokerSimulation {
  readonly #journal: SimulationJournal;
  readonly #state: State;
  readonly #bootId: string;
  readonly #peer: SimulatedPeer;
  #policy: SimulatedPolicy;
  readonly #connections = new WeakMap<SimulationConnection, Connection>();
  readonly #permits = new Map<string, Permit>();
  #controlConnected = true;
  #poisoned = false;
  #lastMono = -1;
  #lastWall = -1;
  #connectionCount = 0;
  constructor(options: {journal: SimulationJournal; enrolledPeer: SimulatedPeer; policy: SimulatedPolicy;
    clock: () => {monotonicMs: number; wallMs: number}}) {
    this.#journal = options.journal;
    this.#state = journals.get(options.journal)!;
    requireValue(this.#state, 'SIMULATION_JOURNAL_REQUIRED');
    requireValue(options.enrolledPeer.evidence === 'simulation' && options.enrolledPeer.integrity === 'medium' && isId(options.enrolledPeer.instanceId)
      && isDigest(options.enrolledPeer.imageDigest) && isDigest(options.enrolledPeer.codeClosureDigest)
      && ['user', 'logon', 'authenticationId', 'creationTime'].every(key => validLabel(options.enrolledPeer[key as keyof SimulatedPeer]))
      && Number.isSafeInteger(options.enrolledPeer.pid) && options.enrolledPeer.pid > 0, 'INVALID_PEER_FIXTURE');
    validatePolicy(options.policy);
    this.#peer = structuredClone(options.enrolledPeer);
    this.#policy = structuredClone(options.policy);
    this.clock = options.clock;
    this.#bootId = randomUUID();
    // A new incarnation fences the previous in-memory owner immediately.
    this.#state.bootId = this.#bootId;
    for (const effect of this.#state.effects.values()) if (active(effect.state)) {
      effect.state = 'unknown'; requestStop(effect);
    }
    this.#append('boot', null, null);
    this.#time();
  }
  private readonly clock: () => {monotonicMs: number; wallMs: number};
  #append(kind: string, requestId: string | null, permitId: string | null, code: string | null = null): boolean {
    if (this.#state.bootId !== this.#bootId || this.#state.events.length >= 4096
      || this.#poisoned || !this.#journal.canAppendForSimulation()) { this.#poisoned = true; return false; }
    this.#state.events.push(Object.freeze({evidence: 'simulation', kind, requestId, permitId, code}));
    return true;
  }
  #time() {
    let now: {monotonicMs: number; wallMs: number};
    try { now = this.clock(); } catch { this.#poisoned = true; this.#interruptAll(); throw Error('CLOCK_UNTRUSTED'); }
    if (!Number.isSafeInteger(now.monotonicMs) || !Number.isSafeInteger(now.wallMs)
      || now.monotonicMs < 0 || now.wallMs < 0 || now.monotonicMs > Number.MAX_SAFE_INTEGER - 300_000
      || now.wallMs > 8_640_000_000_000_000 - 300_000 || now.monotonicMs < this.#lastMono || now.wallMs < this.#lastWall) {
      this.#poisoned = true;
      for (const permit of this.#permits.values()) permit.revoked = true;
      this.#interruptAll();
      throw Error('CLOCK_UNTRUSTED');
    }
    this.#lastMono = now.monotonicMs; this.#lastWall = now.wallMs;
    return now;
  }
  #live() { requireValue(this.#state.bootId === this.#bootId, 'BOOT_CHANGED'); }
  #validObservation(observation: SimulatedObservation): boolean {
    return observation.local === true && observation.identityKnown === true && observation.retainedProcessAlive === true
      && observation.protectedImage === true && observation.serverAuthenticated === true && observation.closedIngress === true
      && contentDigest(observation.peer) === contentDigest(this.#peer);
  }
  #connection(handle: SimulationConnection): Connection {
    this.#live();
    const value = this.#connections.get(handle);
    requireValue(value?.active && this.#validObservation(value.observation), 'CONNECTION_UNAUTHENTICATED');
    return value;
  }
  #deny(code: string, requestId: string | null = null): StartResult {
    this.#append('denied', requestId, null, code);
    return {ok: false, code, retry: 'none'};
  }
  connectForSimulation(observation: SimulatedObservation): SimulationConnection {
    this.#live(); this.#time();
    requireValue(!this.#poisoned && this.#controlConnected && this.#validObservation(observation), 'CONNECTION_UNAUTHENTICATED');
    requireValue(this.#connectionCount < 64, 'CONNECTION_LIMIT'); this.#connectionCount++;
    const handle = Object.freeze({}) as SimulationConnection;
    const copy = structuredClone(observation);
    this.#connections.set(handle, {id: randomUUID(), active: true, peer: copy.peer, observation: copy});
    return handle;
  }
  /** Test fixture control plane; deliberately absent from production port and wire. */
  issueForSimulation(handle: SimulationConnection, approval: SimulatedApproval, operation: RestartOperation,
    timeoutMs: number, lifetimeMs: number): string {
    const connection = this.#connection(handle), now = this.#time(), policy = this.#policy;
    requireValue(!this.#poisoned && this.#controlConnected, 'CONTROL_UNAVAILABLE');
    requireValue(approval.evidence === 'simulation' && approval.coreDecision === 'approved'
      && approval.independentAdminDecision === 'approved' && isId(approval.approvalId) && isId(approval.adminApprovalId)
      && approval.approvalId !== approval.adminApprovalId
      && isId(approval.principalId) && isId(approval.subject.id) && ['run', 'control_operation'].includes(approval.subject.kind)
      && approval.instanceId === connection.peer.instanceId && approval.policyRevision === policy.revision
      && approval.brokerBootId === this.#bootId && Number.isSafeInteger(approval.expiresAtMs)
      && approval.expiresAtMs > now.wallMs && approval.expiresAtMs - now.wallMs >= lifetimeMs
      && approval.actionDigest === actionDigest(operation, timeoutMs), 'APPROVAL_UNBOUND');
    const validated = decodeBrokerRequest(Buffer.from(JSON.stringify({version: 1, requestId: randomUUID(), permitId: randomUUID(), operation, timeoutMs})));
    requireValue(validated.ok && this.#targetValid(operation) && timeoutMs <= policy.maxTimeoutMs
      && Number.isSafeInteger(lifetimeMs) && lifetimeMs > 0 && lifetimeMs <= policy.maxLifetimeMs, 'POLICY_DENIED');
    requireValue(this.#permits.size < 128 && this.#state.events.length < 4096, 'CAPACITY');
    // Each business/admin decision pair authorizes one permit, not one per caller retry.
    requireValue(!this.#state.decisions.has(approval.approvalId) && !this.#state.decisions.has(approval.adminApprovalId), 'APPROVAL_REUSED');
    const id = randomUUID();
    requireValue(this.#append('permitted', null, id), 'AUDIT_UNAVAILABLE');
    this.#state.decisions.add(approval.approvalId); this.#state.decisions.add(approval.adminApprovalId);
    this.#permits.set(id, {id, connection, approval: structuredClone(approval), operation: structuredClone(operation), timeoutMs,
      deadline: now.monotonicMs + lifetimeMs, wallDeadline: now.wallMs + lifetimeMs, consumed: false, revoked: false});
    return id;
  }
  #targetValid(operation: RestartOperation) {
    return this.#policy.targetProtected === true && operation.kind === 'registered_service.restart'
      && operation.resourceId === this.#policy.resourceId && operation.configurationDigest === this.#policy.configurationDigest;
  }
  start(handle: SimulationConnection, bytes: Uint8Array): StartResult {
    const decoded = decodeBrokerRequest(bytes);
    if (!decoded.ok) return this.#deny(decoded.code);
    const request = decoded.request;
    try {
      const connection = this.#connection(handle), now = this.#time();
      requireValue(!this.#poisoned && this.#journal.canAppendForSimulation(), 'AUDIT_UNAVAILABLE');
      requireValue(this.#controlConnected, 'CONTROL_DISCONNECTED');
      const previous = this.#state.effects.get(request.requestId);
      if (previous) {
        requireValue(previous.connectionId === connection.id && previous.requestDigest === decoded.digest, 'REPLAY_CONFLICT');
        return {ok: true, evidence: 'simulation', duplicate: true, effect: structuredClone(previous)};
      }
      const permit = this.#permits.get(request.permitId);
      requireValue(permit && permit.connection === connection, 'PERMIT_UNBOUND');
      requireValue(!permit.revoked, 'PERMIT_REVOKED');
      requireValue(!permit.consumed, 'PERMIT_CONSUMED');
      requireValue(now.monotonicMs < permit.deadline && now.wallMs < permit.wallDeadline, 'PERMIT_EXPIRED');
      requireValue(permit.approval.policyRevision === this.#policy.revision && this.#targetValid(request.operation)
        && request.timeoutMs === permit.timeoutMs && actionDigest(request.operation, request.timeoutMs) === permit.approval.actionDigest, 'POLICY_DENIED');
      requireValue(![...this.#state.effects.values()].some(e => active(e.state)), 'RESOURCE_QUARANTINED');
      requireValue(this.#state.effects.size < 128 && this.#state.events.length < 4096, 'CAPACITY');
      const effect: SimulationEffect = {requestId: request.requestId, permitId: permit.id, requestDigest: decoded.digest,
        actionDigest: permit.approval.actionDigest, operation: structuredClone(request.operation), principalId: permit.approval.principalId,
        subject: structuredClone(permit.approval.subject), approvalId: permit.approval.approvalId, adminApprovalId: permit.approval.adminApprovalId,
        connectionId: connection.id, instanceId: connection.peer.instanceId, policyRevision: this.#policy.revision, bootId: this.#bootId,
        state: 'running', cancellation: 'not_requested', deadline: now.monotonicMs + request.timeoutMs, wallDeadline: now.wallMs + request.timeoutMs};
      // No await / callback between consume, intent and the fixed virtual handler.
      requireValue(this.#append('started', request.requestId, permit.id), 'AUDIT_UNAVAILABLE');
      permit.consumed = true; this.#state.effects.set(request.requestId, effect); this.#state.starts++;
      return {ok: true, evidence: 'simulation', duplicate: false, effect: structuredClone(effect)};
    } catch (cause) {
      return this.#deny(cause instanceof Error ? cause.message : 'UNVERIFIED', request.requestId);
    }
  }
  revokeForSimulation(permitId: string): void {
    this.#live(); const permit = this.#permits.get(permitId); requireValue(permit, 'PERMIT_UNKNOWN');
    permit.revoked = true; this.#append('revoked', null, permitId);
  }
  stopForSimulation(requestId: string): void {
    this.#live(); const effect = this.#state.effects.get(requestId); requireValue(effect, 'REQUEST_UNKNOWN');
    if (active(effect.state)) {
      requestStop(effect); this.#append('stop_requested', requestId, effect.permitId);
    }
  }
  #interruptAll(): void {
    for (const effect of this.#state.effects.values()) if (active(effect.state)) {
      effect.state = 'unknown'; requestStop(effect);
    }
  }
  disconnectForSimulation(handle: SimulationConnection): void {
    const connection = this.#connection(handle); connection.active = false;
    for (const permit of this.#permits.values()) if (permit.connection === connection) permit.revoked = true;
    for (const effect of this.#state.effects.values()) if (effect.connectionId === connection.id && active(effect.state)) {
      effect.state = 'unknown'; requestStop(effect);
    }
    this.#append('disconnected', null, null);
  }
  observePeerExitForSimulation(handle: SimulationConnection): void { this.disconnectForSimulation(handle); }
  loseControlForSimulation(): void {
    this.#live(); this.#controlConnected = false;
    for (const permit of this.#permits.values()) permit.revoked = true;
    this.#interruptAll(); this.#append('control_disconnected', null, null);
  }
  replacePolicyForSimulation(policy: SimulatedPolicy): void {
    this.#live(); validatePolicy(policy); this.#policy = structuredClone(policy);
    for (const permit of this.#permits.values()) permit.revoked = true;
    this.#interruptAll(); this.#append('policy_invalidated', null, null);
  }
  maintainForSimulation(): void {
    this.#live(); const now = this.#time();
    for (const effect of this.#state.effects.values()) if (effect.state === 'running'
      && (now.monotonicMs >= effect.deadline || now.wallMs >= effect.wallDeadline)) {
      effect.state = 'unknown'; requestStop(effect); this.#append('timeout_unknown', effect.requestId, effect.permitId);
    }
  }
  /** Models independently retrieved handler evidence, never a client response or Home click. */
  reconcileForSimulation(requestId: string, receipt: {evidence: 'simulation'; requestDigest: string; bootId: string;
    state: 'succeeded' | 'failed' | 'unknown'; stopObserved: boolean}): void {
    this.#live(); const effect = this.#state.effects.get(requestId);
    requireValue(effect && receipt.evidence === 'simulation' && receipt.requestDigest === effect.requestDigest && receipt.bootId === effect.bootId
      && ['succeeded', 'failed', 'unknown'].includes(receipt.state) && typeof receipt.stopObserved === 'boolean', 'RECEIPT_UNBOUND');
    requireValue(active(effect.state) || effect.state === receipt.state, 'RECEIPT_CONFLICT');
    // An identical terminal receipt is already recorded. Do not create a new
    // uncertain operation just because a later duplicate cannot be audited.
    if (!active(effect.state) && (!receipt.stopObserved || effect.cancellation === 'observed')) return;
    if (!this.#append('reconciled', requestId, effect.permitId, receipt.state)) {
      if (active(effect.state)) { effect.state = 'unknown'; requestStop(effect); }
      return;
    }
    effect.state = receipt.state;
    if (receipt.stopObserved) effect.cancellation = 'observed';
  }
  snapshot() {
    this.#live();
    return {evidence: 'simulation' as const, durable: false as const, bootId: this.#bootId, auditHealthy: !this.#poisoned,
      virtualStarts: this.#state.starts, effects: [...this.#state.effects.values()].map(effect => {
        const copy = structuredClone(effect);
        if (this.#poisoned && active(copy.state)) { copy.state = 'unknown'; requestStop(copy); }
        return copy;
      }), events: structuredClone(this.#state.events)};
  }
}
