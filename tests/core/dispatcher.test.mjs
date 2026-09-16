import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalFakeDispatcher } from '../../dist/core/src/local-dispatcher.js';
import { LedgerBusyError } from '../../dist/ledger/src/index.js';
import { fixture, approved, snap, saved, bytes, request, committed, control, outcome } from './fixtures/helpers.mjs';

const busy = () => ({ ok: false, error: { code: 'BUSY_NOT_COMMITTED', retry: 'same_id' } });
test('external or mismatched route chains cannot acquire, settle or discard through the local adapter', async t => {
  const { update } = await import('./fixtures/helpers.mjs');
  for (const variant of ['intent-route', 'attempt-route', 'run-mode', 'run-mission']) {
    const f = await fixture(t), item = approved(f), intent = saved(f, item.intent.id).value;
    const attempt = saved(f, intent.attemptId).value;
    if (variant === 'intent-route') update(f, item.intent.id, v => ({ ...v, route: 'openrouter' }));
    if (variant === 'attempt-route') update(f, intent.attemptId, v => ({ ...v, route: 'openrouter' }));
    if (variant === 'run-mode') update(f, attempt.runId, v => ({ ...v, mode: 'standard_api' }));
    if (variant === 'run-mission') update(f, attempt.runId, v => ({ ...v, missionId: 'another-mission' }));
    const before = saved(f, item.intent.id).row.versionId;
    let scheduled = 0;
    const execute = f.core.executeFake.bind(f.core);
    f.core.executeFake = (...args) => { scheduled++; return execute(...args); };
    assert.equal(new LocalFakeDispatcher(f.core).tick().status, 'ready', variant);
    assert.equal(scheduled, 0, variant);
    for (const result of [f.core.acquireDispatch(f.principal, item.intent.id), execute(f.principal, item.intent.id),
      f.core.exhaustFakeRetry(f.principal, item.intent.id)]) {
      assert.equal(result.ok, false, variant); assert.equal(result.error.code, 'DENIED', variant);
    }
    assert.equal(saved(f, item.intent.id).row.versionId, before);
    update(f, item.intent.id, v => ({ ...v, state: 'unknown' }));
    const unknown = saved(f, item.intent.id).row.versionId;
    assert.equal(f.core.finishFakeObservation(f.principal, item.intent.id).ok, false);
    assert.equal(f.core.observeFake(f.principal, item.intent.id, 'success', 'late-result', '0').ok, false);
    assert.equal(saved(f, item.intent.id).row.versionId, unknown);
    assert.equal(saved(f, intent.obligationId).value.heldYen, '700');
    assert.equal(f.store.read(tx => tx.listRecord(f.principal, 'outcome').length), 0);
    assert.equal(f.store.read(tx => tx.listRecord(f.principal, 'cost_event').length), 0);
  }
});

test('route change after BUSY cannot become a local retry exhaustion or observation', async t => {
  const { update } = await import('./fixtures/helpers.mjs');
  const f = await fixture(t), item = approved(f);
  const execute = f.core.executeFake.bind(f.core);
  f.core.executeFake = () => busy();
  let now = 0;
  const dispatcher = new LocalFakeDispatcher(f.core, () => now);
  dispatcher.tick();
  update(f, item.intent.id, v => ({ ...v, route: 'openrouter', state: 'send_intent' }));
  f.core.executeFake = execute;
  now = 1000; dispatcher.tick(); now = 10000; dispatcher.tick();
  assert.equal(saved(f, item.intent.id).value.state, 'send_intent');
  assert.equal(snap(f).outcomes.length, 0);
  assert.equal(snap(f).budget.heldYen, '700');
});
test('pre-send transient BUSY retries the same prepared intent with finite backoff', async t => {
  const f = await fixture(t), item = approved(f), original = f.core.executeFake.bind(f.core);
  let attempts = 0, now = 0;
  f.core.executeFake = (...args) => ++attempts < 3 ? busy() : original(...args);
  const d = new LocalFakeDispatcher(f.core, () => now);
  d.tick(); d.tick(); assert.equal(attempts, 1); assert.equal(snap(f).intents[0].state, 'prepared');
  now = 1000; d.tick(); now = 2000; d.tick(); now = 3000; d.tick();
  assert.equal(attempts, 3); assert.equal(snap(f).intents.length, 1); assert.equal(snap(f).outcomes.length, 1); assert.equal(snap(f).intents[0].id, item.intent.id);
});
test('post-send observation BUSY retries observation only, never acquires send twice', async t => {
  const f = await fixture(t); approved(f);
  const originalAcquire = f.core.acquireDispatch.bind(f.core), originalFinish = f.core.finishFakeObservation.bind(f.core);
  let acquires = 0, writes = 0, now = 0;
  f.core.acquireDispatch = (...args) => { acquires++; return originalAcquire(...args); };
  f.core.finishFakeObservation = (...args) => ++writes < 3 ? busy() : originalFinish(...args);
  const d = new LocalFakeDispatcher(f.core, () => now);
  d.tick(); assert.equal(snap(f).intents[0].state, 'send_intent');
  now = 1000; d.tick(); now = 2000; d.tick();
  assert.equal(acquires, 1); assert.equal(writes, 3); assert.equal(snap(f).outcomes.length, 1); assert.equal(snap(f).budget.bookedYen, '400');
});
test('exhausted pre-send retries release only the unsent reservation and require new approval', async t => {
  const f = await fixture(t), item = approved(f); let calls = 0, now = 0;
  f.core.executeFake = () => { calls++; return busy(); };
  const d = new LocalFakeDispatcher(f.core, () => now);
  for (let i = 0; i < 6; i++) { now = i * 1000; d.tick(); }
  assert.equal(calls, 3); assert.equal(saved(f, item.intent.id).value.state, 'discarded'); assert.equal(snap(f).budget.heldYen, '0'); assert.equal(snap(f).approvals[0].state, 'superseded');
});
test('exhausted observation writes create unknown once and retain its budget', async t => {
  const f = await fixture(t); approved(f); let calls = 0, now = 0;
  f.core.finishFakeObservation = () => { calls++; return busy(); };
  const d = new LocalFakeDispatcher(f.core, () => now);
  for (let i = 0; i < 6; i++) { now = i * 1000; d.tick(); }
  assert.equal(calls, 3); assert.equal(snap(f).intents[0].state, 'unknown'); assert.equal(snap(f).budget.heldYen, '700');
  assert.equal(f.store.read(tx => tx.listRecord(f.principal, 'reconciliation_case').length), 1); assert.equal(snap(f).outcomes.length, 0);
});
test('scheduler lease guard prevents even an approved prepared fixture from dispatching', async t => {
  const f = await fixture(t); approved(f); const d = new LocalFakeDispatcher(f.core);
  d.tick(() => false); assert.equal(snap(f).intents[0].state, 'prepared'); assert.equal(snap(f).outcomes.length, 0);
});
test('lease expiring after scheduler admission is rechecked inside TX2 before any send right is written', async t => {
  const f = await fixture(t), item = approved(f), transaction = f.store.transaction.bind(f.store);
  let leaseClock = 0, insideTransaction = false, transactionChecks = 0;
  const instrumented = fn => transaction(tx => {
    insideTransaction = true;
    try {
      return fn(new Proxy(tx, { get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        return (...args) => {
          const result = value.apply(target, args);
          // Simulate elapsed monotonic time after BEGIN IMMEDIATE and the first
          // TX2 read, without asynchronous work or re-entering the Store.
          if (key === 'getRecord' && args[1] === item.intent.id) leaseClock = 100;
          return result;
        };
      } }));
    } finally { insideTransaction = false; }
  });
  // Instrument only the intended legacy TX2. Maintenance also contains native
  // coordinators that correctly reject proxy/foreign transaction identities.
  const acquire = f.core.acquireDispatch.bind(f.core);
  f.core.acquireDispatch = (...args) => {
    f.store.transaction = instrumented;
    try { return acquire(...args); } finally { f.store.transaction = transaction; }
  };
  const allowed = () => { if (insideTransaction) transactionChecks++; return leaseClock < 100; };
  const d = new LocalFakeDispatcher(f.core, () => leaseClock);
  assert.equal(d.tick(allowed).status, 'ready');
  f.store.transaction = transaction;
  assert.equal(transactionChecks, 1, 'the pure admission predicate must run inside TX2');
  assert.equal(saved(f, item.intent.id).value.state, 'prepared');
  assert.equal(snap(f).outcomes.length, 0); assert.equal(snap(f).budget.heldYen, '700');
  assert.equal(f.store.read(tx => tx.listAudit(f.principal).filter(row => row.kind === 'intent.send_acquired').length), 0);
});
test('lease expiry after committed acquisition does not acquire again when storing the fixed local result', async t => {
  const f = await fixture(t), item = approved(f), acquire = f.core.acquireDispatch.bind(f.core);
  let leaseClock = 0, acquires = 0;
  f.core.acquireDispatch = (...args) => { acquires++; const result = acquire(...args); if (result.ok) leaseClock = 100; return result; };
  const d = new LocalFakeDispatcher(f.core, () => leaseClock);
  assert.equal(d.tick(() => leaseClock < 100).status, 'ready');
  assert.equal(acquires, 1); assert.equal(saved(f, item.intent.id).value.state, 'completed');
  assert.equal(snap(f).outcomes.length, 1); assert.equal(snap(f).budget.bookedYen, '400');
  assert.equal(f.store.read(tx => tx.listAudit(f.principal).filter(row => row.kind === 'intent.send_acquired').length), 1);
});
test('post-send BUSY plus BUSY state inspection resumes observation, without another acquisition', async t => {
  const f = await fixture(t), item = approved(f), acquire = f.core.acquireDispatch.bind(f.core);
  const finish = f.core.finishFakeObservation.bind(f.core), read = f.store.read.bind(f.store);
  let acquires = 0, writes = 0, readFailures = 0, now = 0;
  f.core.acquireDispatch = (...args) => { acquires++; return acquire(...args); };
  f.core.finishFakeObservation = (...args) => { writes++; if (writes === 1) { readFailures = 2; return busy(); } return finish(...args); };
  f.store.read = fn => read(tx => fn(new Proxy(tx, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== 'function') return value;
    return (...args) => {
      if (key === 'getRecord' && args[1] === item.intent.id && readFailures > 0) { readFailures--; throw new LedgerBusyError('Independent post-send inspection contention'); }
      return value.apply(target, args);
    };
  } })));
  const d = new LocalFakeDispatcher(f.core, () => now);
  for (let i = 0; i < 5; i++) { now = i * 1000; assert.equal(d.tick().status, 'ready'); }
  f.store.read = read;
  assert.equal(readFailures, 0); assert.equal(acquires, 1); assert.equal(writes, 2);
  assert.equal(saved(f, item.intent.id).value.state, 'completed');
  assert.equal(snap(f).outcomes.length, 1); assert.equal(snap(f).budget.bookedYen, '400');
  assert.equal(f.store.read(tx => tx.listRecord(f.principal, 'cost_event').length), 1);
});
test('acquire DENIED triggers state inspection rather than losing a result already acquired by the trusted host', async t => {
  const f = await fixture(t), item = approved(f), execute = f.core.executeFake.bind(f.core), acquire = f.core.acquireDispatch.bind(f.core);
  let now = 0, executeCalls = 0;
  f.core.executeFake = (...args) => {
    executeCalls++;
    // Another trusted local entry acquired this same effect before the queued
    // scheduler call; its ordinary execute path therefore returns DENIED.
    if (executeCalls === 1) assert.equal(acquire(...args).ok, true);
    return execute(...args);
  };
  const d = new LocalFakeDispatcher(f.core, () => now);
  d.tick(); assert.equal(saved(f, item.intent.id).value.state, 'send_intent');
  now = 1000; d.tick(); now = 2000; d.tick();
  assert.equal(executeCalls, 1); assert.equal(saved(f, item.intent.id).value.state, 'completed');
  assert.equal(snap(f).outcomes.length, 1);
  assert.equal(f.store.read(tx => tx.listAudit(f.principal).filter(row => row.kind === 'intent.send_acquired').length), 1);
});
test('holding then explicitly resuming reopens the same outcome revision for acceptance', async t => {
  const f = await fixture(t), item = approved(f); f.core.executeFake(f.principal, item.intent.id);
  outcome(f, 'hold', '後で確認する'); const held = snap(f).outcomes[0], scope = snap(f).missions[0].scope;
  committed(f.core.command(f.session, bytes(control(f, scope, 'resume'))));
  const resumed = snap(f).outcomes[0];
  assert.equal(resumed.id, held.id); assert.equal(resumed.artifactId, held.artifactId); assert.equal(BigInt(resumed.revision), BigInt(held.revision) + 1n); assert.equal(resumed.state, 'pending');
  committed(f.core.command(f.session, bytes(request('outcome.decide', resumed.id, resumed.revision, { artifact_revision_id: resumed.artifactId, explanation_revision: resumed.explanationRevision, choice: 'accepted', comment: null }))));
  assert.equal(snap(f).outcomes[0].state, 'accepted'); assert.equal(snap(f).intents.length, 1);
});
