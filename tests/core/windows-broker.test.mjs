import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createWindowsPrivilegePort, WINDOWS_PRIVILEGES_ENABLED, decodeBrokerRequest, actionDigest} from '../../dist/windows-broker/src/index.js';
import {BrokerSimulation, SimulationJournal} from '../../dist/windows-broker/src/simulation.js';
import {createCodexSimulationAdapter, projectSimulationForHome} from '../../dist/windows-broker/src/presentation.js';

const bytes = value => Buffer.from(JSON.stringify(value));
function fixture() {
  const f = {mono: 100, wall: 1_800_000_000_000, journal: new SimulationJournal()};
  f.peer = {evidence: 'simulation', user: 'synthetic-user', logon: 'synthetic-logon', authenticationId: 'synthetic-auth',
    pid: 1234, creationTime: 'synthetic-generation-1', integrity: 'medium', imageDigest: 'a'.repeat(64), codeClosureDigest: 'b'.repeat(64), instanceId: randomUUID()};
  f.policy = {revision: randomUUID(), resourceId: randomUUID(), configurationDigest: 'c'.repeat(64), targetProtected: true, maxLifetimeMs: 10_000, maxTimeoutMs: 1000};
  f.options = {journal: f.journal, enrolledPeer: f.peer, policy: f.policy, clock: () => ({monotonicMs: f.mono, wallMs: f.wall})};
  f.broker = new BrokerSimulation(f.options);
  f.observation = {peer: f.peer, local: true, identityKnown: true, retainedProcessAlive: true, protectedImage: true, serverAuthenticated: true, closedIngress: true};
  f.connection = f.broker.connectForSimulation(f.observation);
  f.operation = {kind: 'registered_service.restart', resourceId: f.policy.resourceId, configurationDigest: f.policy.configurationDigest};
  f.approval = () => ({evidence: 'simulation', principalId: randomUUID(), subject: {kind: 'control_operation', id: randomUUID()},
    approvalId: randomUUID(), adminApprovalId: randomUUID(), actionDigest: actionDigest(f.operation, 500),
    coreDecision: 'approved', independentAdminDecision: 'approved', policyRevision: f.policy.revision, instanceId: f.peer.instanceId,
    brokerBootId: f.broker.snapshot().bootId, expiresAtMs: f.wall + 10_000});
  f.issue = (approval = f.approval()) => f.broker.issueForSimulation(f.connection, approval, f.operation, 500, 1000);
  f.request = (permitId = f.issue()) => ({version: 1, requestId: randomUUID(), permitId, operation: f.operation, timeoutMs: 500});
  f.start = request => f.broker.start(f.connection, bytes(request));
  f.receipt = (effect, state = 'succeeded', stopObserved = false) => ({evidence: 'simulation', requestDigest: effect.requestDigest, bootId: effect.bootId, state, stopObserved});
  return f;
}
function deny(f, request, code, connection = f.connection) {
  const before = f.broker.snapshot().virtualStarts;
  const result = f.broker.start(connection, bytes(request));
  assert.equal(result.ok, false); assert.equal(result.code, code); assert.equal(result.retry, 'none');
  assert.equal(f.broker.snapshot().virtualStarts, before);
}

test('production is disabled regardless of supplied enable flag or forged approval; no enrollment API', () => {
  const port = createWindowsPrivilegePort({enabled: true, approval: true});
  assert.equal(WINDOWS_PRIVILEGES_ENABLED, false); assert.equal(port.enabled, false);
  assert.deepEqual(Object.keys(port), ['enabled', 'request']);
  assert.equal(port.request(bytes({approved: true, command: 'arbitrary'})).code, 'WINDOWS_PRIVILEGES_DISABLED');
});
test('same connected instance consumes exactly one permit; duplicate returns existing result', () => {
  const f = fixture(), request = f.request(), result = f.start(request);
  assert.equal(result.ok, true); assert.equal(result.duplicate, false);
  assert.equal(f.start(request).duplicate, true); assert.equal(f.broker.snapshot().virtualStarts, 1);
  f.broker.reconcileForSimulation(request.requestId, f.receipt(result.effect));
  assert.equal(f.start(request).effect.state, 'succeeded');
  deny(f, {...request, requestId: randomUUID()}, 'PERMIT_CONSUMED');
});
test('copied permit on another connection to same enrolled process is refused', () => {
  const f = fixture(), request = f.request(), other = f.broker.connectForSimulation(f.observation);
  deny(f, request, 'PERMIT_UNBOUND', other);
});
test('serialized or invented connection handle never authenticates', () => {
  const f = fixture(), request = f.request(); deny(f, request, 'CONNECTION_UNAUTHENTICATED', JSON.parse(JSON.stringify(f.connection)));
});
for (const [field, value] of Object.entries({user: 'another-user', logon: 'another-logon', authenticationId: 'another-auth', pid: 4321,
  creationTime: 'reused-pid-generation', integrity: 'high', imageDigest: 'd'.repeat(64), codeClosureDigest: 'e'.repeat(64), instanceId: randomUUID()})) {
  test(`OS fact oracle refuses copied token with changed ${field}`, () => {
    const f = fixture(); f.request();
    assert.throws(() => f.broker.connectForSimulation({...f.observation, peer: {...f.peer, [field]: value}}), /CONNECTION_UNAUTHENTICATED/);
    assert.equal(f.broker.snapshot().virtualStarts, 0);
  });
}
for (const field of ['local', 'identityKnown', 'retainedProcessAlive', 'protectedImage', 'serverAuthenticated', 'closedIngress']) {
  test(`OS fact oracle refuses unavailable ${field}`, () => {
    const f = fixture();
    assert.throws(() => f.broker.connectForSimulation({...f.observation, [field]: false}), /CONNECTION_UNAUTHENTICATED/);
    assert.equal(f.broker.snapshot().virtualStarts, 0);
  });
}
for (const field of ['pid', 'session_id', 'verified', 'parentPid', 'signature', 'approve', 'adminApproval', 'command', 'exe', 'path', 'updatePolicy', 'receipt']) {
  test(`wire cannot supply ${field} as identity, authority or handler`, () => {
    const f = fixture(); deny(f, {...f.request(), [field]: 'untrusted-canary'}, 'SCHEMA_INVALID');
    assert.equal(JSON.stringify(f.broker.snapshot()).includes('untrusted-canary'), false);
  });
}
for (const [name, change] of [
  ['shell operation', r => ({...r, operation: {...r.operation, kind: 'shell'}})],
  ['executable argument', r => ({...r, operation: {...r.operation, executable: 'cmd'}})],
  ['traversal resource', r => ({...r, operation: {...r.operation, resourceId: '../target'}})],
  ['junction-style path', r => ({...r, operation: {...r.operation, resourceId: 'C:\\junction\\service.exe'}})],
  ['arbitrary service', r => ({...r, operation: {...r.operation, resourceId: randomUUID()}})],
  ['target replacement', r => ({...r, operation: {...r.operation, configurationDigest: 'd'.repeat(64)}})],
  ['timeout expansion', r => ({...r, timeoutMs: 501})],
]) test(name, () => {
  const f = fixture(), input = change(f.request());
  const code = decodeBrokerRequest(bytes(input)).ok ? 'POLICY_DENIED' : 'SCHEMA_INVALID'; deny(f, input, code);
});
for (const [name, payload, code] of [
  ['invalid UTF8', Buffer.from([0xff]), 'INVALID_UTF8'],
  ['duplicate keys', Buffer.from('{"version":1,"version":1}'), 'DUPLICATE_KEY'],
  ['too large', Buffer.alloc(4097, 32), 'INPUT_LIMIT'],
  ['deep input', Buffer.from('['.repeat(20) + '0' + ']'.repeat(20)), 'DEPTH_LIMIT'],
  ['shared mutable input', new Uint8Array(new SharedArrayBuffer(3)), 'INVALID_INPUT'],
  ['invalid Unicode', Buffer.from('{"x":"\\ud800"}'), 'INVALID_UNICODE'],
]) test(`strict codec: ${name}`, () => {
  const f = fixture(); const result = f.broker.start(f.connection, payload);
  assert.equal(result.code, code); assert.equal(f.broker.snapshot().virtualStarts, 0);
});
test('strict codec seals decoded request and operation', () => {
  const f = fixture(), result = decodeBrokerRequest(bytes(f.request())); assert.equal(result.ok, true);
  assert.throws(() => result.request.operation.kind = 'shell', TypeError);
});
for (const [field, value] of Object.entries({evidence: 'os_verified', coreDecision: 'pending', independentAdminDecision: 'pending',
  instanceId: randomUUID(), policyRevision: randomUUID(), actionDigest: 'f'.repeat(64), brokerBootId: randomUUID(), expiresAtMs: 0})) {
  test(`approval fixture refuses missing or unbound ${field}`, () => {
    const f = fixture(); assert.throws(() => f.issue({...f.approval(), [field]: value}), /APPROVAL_UNBOUND/);
    assert.equal(f.broker.snapshot().virtualStarts, 0);
  });
}
test('reissuing same business or admin approval cannot reset one-use quota', () => {
  const f = fixture(), approval = f.approval(); f.issue(approval);
  assert.throws(() => f.issue(approval), /APPROVAL_REUSED/);
  assert.throws(() => f.issue({...f.approval(), adminApprovalId: approval.adminApprovalId}), /APPROVAL_REUSED/);
});
test('wall and monotonic deadlines each expire exactly at boundary', () => {
  for (const clock of ['wall', 'mono']) {
    const f = fixture(), request = f.request(); f[clock] += 1000; deny(f, request, 'PERMIT_EXPIRED');
  }
});
test('clock rollback fails closed and poisons further requests', () => {
  for (const clock of ['wall', 'mono']) {
    const f = fixture(), request = f.request(); f[clock]--; deny(f, request, 'CLOCK_UNTRUSTED');
    f[clock]++; deny(f, request, 'AUDIT_UNAVAILABLE');
  }
});
test('revocation immediately prevents new starts but does not report active work stopped', () => {
  const f = fixture(), first = f.request(), second = f.request(); f.start(first); f.broker.revokeForSimulation(first.permitId);
  assert.equal(f.broker.snapshot().effects[0].cancellation, 'not_requested');
  f.broker.revokeForSimulation(second.permitId); deny(f, second, 'PERMIT_REVOKED');
});
test('concurrent uses acquire at most once, with no async gap at consumption', async () => {
  const f = fixture(), a = f.request(), b = {...a, requestId: randomUUID()};
  const results = await Promise.all([Promise.resolve().then(() => f.start(a)), Promise.resolve().then(() => f.start(b))]);
  assert.equal(results.filter(r => r.ok).length, 1); assert.equal(f.broker.snapshot().virtualStarts, 1);
});
test('replay with changed content is rejected and never starts again', () => {
  const f = fixture(), request = f.request(); f.start(request); deny(f, {...request, timeoutMs: 501}, 'REPLAY_CONFLICT');
});
test('unresolved work blocks new requests even with a fresh permit', () => {
  const f = fixture(), first = f.request(), started = f.start(first);
  f.broker.reconcileForSimulation(first.requestId, f.receipt(started.effect, 'unknown'));
  deny(f, f.request(), 'RESOURCE_QUARANTINED');
});
test('timeout requests stopping and preserves unknown until matching receipt', () => {
  const f = fixture(), first = f.request(), started = f.start(first); f.mono += 500; f.broker.maintainForSimulation();
  const effect = f.broker.snapshot().effects[0]; assert.equal(effect.state, 'unknown'); assert.equal(effect.cancellation, 'requested');
  deny(f, f.request(), 'RESOURCE_QUARANTINED');
  f.broker.reconcileForSimulation(first.requestId, f.receipt(started.effect, 'failed', true));
  assert.equal(f.broker.snapshot().effects[0].cancellation, 'observed'); assert.equal(f.start(f.request()).ok, true);
});
test('stop acknowledgement alone does not settle outcome or roll back side effects', () => {
  const f = fixture(), r = f.request(), started = f.start(r); f.broker.stopForSimulation(r.requestId);
  assert.equal(f.broker.snapshot().effects[0].state, 'running');
  f.broker.reconcileForSimulation(r.requestId, f.receipt(started.effect, 'unknown', true));
  deny(f, f.request(), 'RESOURCE_QUARANTINED');
});
for (const action of ['disconnectForSimulation', 'observePeerExitForSimulation']) test(`${action} revokes and retains pending effects`, () => {
  const f = fixture(), r = f.request(), next = f.request(); f.start(r); f.broker[action](f.connection);
  deny(f, next, 'CONNECTION_UNAUTHENTICATED'); assert.equal(f.broker.snapshot().effects[0].state, 'unknown');
});
test('control loss stops new starts and marks in-flight outcome unknown', () => {
  const f = fixture(), r = f.request(), next = f.request(); f.start(r); f.broker.loseControlForSimulation();
  deny(f, next, 'CONTROL_DISCONNECTED'); assert.equal(f.broker.snapshot().effects[0].cancellation, 'requested');
});
test('restart fences old instance and permits; unknown survives in shared simulation journal', () => {
  const f = fixture(), r = f.request(), started = f.start(r), old = f.broker;
  f.broker = new BrokerSimulation(f.options); f.connection = f.broker.connectForSimulation(f.observation);
  assert.equal(old.start({}, bytes(r)).code, 'BOOT_CHANGED');
  deny(f, {...r, requestId: randomUUID()}, 'PERMIT_UNBOUND');
  deny(f, f.request(), 'RESOURCE_QUARANTINED');
  f.broker.reconcileForSimulation(r.requestId, f.receipt(started.effect));
  assert.equal(f.broker.snapshot().effects[0].state, 'succeeded'); assert.equal(f.broker.snapshot().virtualStarts, 1);
});
test('completed operation approvals cannot be resurrected by reboot', () => {
  const f = fixture(), approval = f.approval(), r = f.request(f.issue(approval)), started = f.start(r);
  f.broker.reconcileForSimulation(r.requestId, f.receipt(started.effect));
  f.broker = new BrokerSimulation(f.options); f.connection = f.broker.connectForSimulation(f.observation);
  assert.throws(() => f.issue(approval), /APPROVAL_UNBOUND/);
  assert.throws(() => f.issue({...approval, brokerBootId: f.broker.snapshot().bootId}), /APPROVAL_REUSED/);
});
test('journal failure before action causes zero virtual starts; later failure retains unknown', () => {
  const f = fixture(), r = f.request(); f.journal.failWritesForSimulation(true); deny(f, r, 'AUDIT_UNAVAILABLE');
  const g = fixture(), s = g.request(), started = g.start(s); g.journal.failWritesForSimulation(true);
  g.broker.reconcileForSimulation(s.requestId, g.receipt(started.effect));
  assert.equal(g.broker.snapshot().effects[0].state, 'unknown'); assert.equal(g.broker.snapshot().auditHealthy, false);
  g.broker.stopForSimulation(s.requestId); assert.equal(g.broker.snapshot().effects[0].cancellation, 'requested');
});
test('target trust revocation or configuration change blocks previously approved permit', () => {
  for (const changed of [{targetProtected: false}, {configurationDigest: 'f'.repeat(64)}, {revision: randomUUID()}]) {
    const f = fixture(), r = f.request(); f.broker.replacePolicyForSimulation({...f.policy, ...changed}); deny(f, r, 'PERMIT_REVOKED');
  }
});
test('unprotected service dependency fixture cannot receive a permit', () => {
  const f = fixture(); f.broker.replacePolicyForSimulation({...f.policy, targetProtected: false});
  assert.throws(() => f.issue(), /POLICY_DENIED/);
});
test('forged completion evidence or conflicting terminal outcome is refused', () => {
  const f = fixture(), r = f.request(), started = f.start(r);
  assert.throws(() => f.broker.reconcileForSimulation(r.requestId, {...f.receipt(started.effect), requestDigest: 'f'.repeat(64)}), /RECEIPT_UNBOUND/);
  f.broker.reconcileForSimulation(r.requestId, f.receipt(started.effect));
  assert.throws(() => f.broker.reconcileForSimulation(r.requestId, f.receipt(started.effect, 'failed')), /RECEIPT_CONFLICT/);
});
test('client adapter has no approval or policy mutation and Home never asserts live verification', () => {
  const f = fixture(), r = f.request(), adapter = createCodexSimulationAdapter(f.broker, f.connection);
  assert.deepEqual(Object.keys(adapter), ['request']); const started = adapter.request(bytes(r));
  f.broker.stopForSimulation(r.requestId);
  const view = projectSimulationForHome(f.broker.snapshot().effects[0]);
  assert.equal(view.evidence, 'simulation'); assert.equal(view.liveEnabled, false); assert.equal('missionId' in view, false);
  assert.match(view.statusText, /停止未確認/); assert.equal(view.subject.kind, 'control_operation');
  started.effect.state = 'succeeded'; view.subject.id = randomUUID();
  assert.equal(f.broker.snapshot().effects[0].state, 'running'); assert.notEqual(view.subject.id, f.broker.snapshot().effects[0].subject.id);
});

// Independent reviewer oracles WB-R01..04; expectations originate outside implementation session.
test('WB-R01 policy update cannot expand immutable limits or change field types', () => {
  for (const change of [{maxLifetimeMs: 3_600_000}, {maxTimeoutMs: 30001}, {targetProtected: 'true'}, {revision: ''}, {configurationDigest: ''}]) {
    const f = fixture(); assert.throws(() => f.broker.replacePolicyForSimulation({...f.policy, ...change}), /INVALID_POLICY_FIXTURE/);
    assert.equal(f.start(f.request()).ok, true); // rejected update preserves previous valid policy
  }
});
test('WB-R02 duplicate terminal receipt with audit failure cannot regress and accept contradictory outcome after boot', () => {
  const f = fixture(), r = f.request(), started = f.start(r);
  f.broker.reconcileForSimulation(r.requestId, f.receipt(started.effect));
  f.journal.failWritesForSimulation(true);
  f.broker.reconcileForSimulation(r.requestId, f.receipt(started.effect));
  assert.equal(f.broker.snapshot().effects[0].state, 'succeeded');
  f.broker.reconcileForSimulation(r.requestId, f.receipt(started.effect, 'succeeded', true));
  assert.equal(f.broker.snapshot().effects[0].state, 'succeeded');
  f.journal.failWritesForSimulation(false); f.broker = new BrokerSimulation(f.options);
  assert.throws(() => f.broker.reconcileForSimulation(r.requestId, f.receipt(started.effect, 'failed')), /RECEIPT_CONFLICT/);
});
for (const transition of ['stop', 'disconnect', 'control', 'policy', 'boot', 'audit', 'clock']) {
  test(`WB-R03 stop observation survives ${transition} while unknown effect remains quarantined`, () => {
    const f = fixture(), r = f.request(), started = f.start(r);
    f.broker.reconcileForSimulation(r.requestId, f.receipt(started.effect, 'unknown', true));
    if (transition === 'stop') f.broker.stopForSimulation(r.requestId);
    if (transition === 'disconnect') f.broker.disconnectForSimulation(f.connection);
    if (transition === 'control') f.broker.loseControlForSimulation();
    if (transition === 'policy') f.broker.replacePolicyForSimulation({...f.policy, revision: randomUUID()});
    if (transition === 'boot') f.broker = new BrokerSimulation(f.options);
    if (transition === 'audit') { f.journal.failWritesForSimulation(true); f.broker.stopForSimulation(r.requestId); }
    if (transition === 'clock') { f.mono--; assert.throws(() => f.broker.maintainForSimulation(), /CLOCK_UNTRUSTED/); }
    const effect = f.broker.snapshot().effects[0]; assert.equal(effect.state, 'unknown'); assert.equal(effect.cancellation, 'observed');
    assert.doesNotMatch(projectSimulationForHome(effect).statusText, /停止未確認/);
  });
}
for (const field of ['user', 'logon', 'authenticationId', 'creationTime']) {
  test(`WB-R04 required peer ${field} must exist, be nonempty and bounded`, () => {
    for (const value of [undefined, '', 1234, 'x'.repeat(129)]) {
      const f = fixture(), peer = {...f.peer, [field]: value};
      if (value === undefined) delete peer[field];
      assert.throws(() => new BrokerSimulation({...f.options, enrolledPeer: peer}), /INVALID_PEER_FIXTURE/);
    }
  });
}
test('independent approval references cannot alias a normal Home approval', () => {
  const f = fixture(), approval = f.approval();
  assert.throws(() => f.issue({...approval, adminApprovalId: approval.approvalId}), /APPROVAL_UNBOUND/);
});
