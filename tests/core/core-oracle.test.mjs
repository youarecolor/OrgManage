import test from 'node:test';
import assert from 'node:assert/strict';
import { budgetMonth, aggregate, canReserve, yen } from '../../dist/core/src/index.js';
import { LedgerStore, LedgerIntegrityError, OrgManageCore, randomUUID, bytes, request, committed, denied,
  snap, saved, update, fixture, post, start, prepared, approved, approve, control, outcome, addPrincipal } from './fixtures/helpers.mjs';

// Expected behavior is derived from G08 16.3-5, G09 17.4-6 and G11 19.1-11.
// DB fixture writes below represent trusted preconditions, never renderer authorization.

test('G11 DP-01 snapshot before setup does not create principals, grants or jobs', async t => {
  const f = await fixture(t, { setup: false });
  assert.equal(f.core.snapshot(f.session).status, 'setup_required');
  assert.equal(f.core.snapshot(f.session).status, 'setup_required');
  f.store.read(tx => { assert.deepEqual(tx.listPrincipal(), []); assert.equal(tx.getMeta('bootstrap'), undefined); });
});
test('G11 DP-01 setup binds the host identity and stores a terminal receipt with no external permission', async t => {
  const f = await fixture(t), view = snap(f);
  assert.equal(view.mode, 'local_fake'); assert.equal(view.messages.length, 0); assert.equal(view.missions.length, 0);
  f.store.read(tx => { assert.equal(tx.getMembership(f.principal, f.actor).role, 'owner');
    const policy = JSON.parse(tx.getRecord(f.principal, tx.getMeta(`policy:${f.principal}`)).data);
    assert.equal(policy.externalAllowed, false); assert.ok(tx.getMeta('bootstrap')); assert.ok(tx.getCommand(f.principal, f.setupRequest.setup_command_id)); });
});
test('G11 DP-01 authenticated same setup ID and content returns the original receipt', async t => {
  const f = await fixture(t), before = f.store.read(tx => tx.listAudit(f.principal).length);
  assert.deepEqual(committed(f.core.setup(f.session, bytes(f.setupRequest))), f.setupReceipt);
  assert.equal(f.store.read(tx => tx.listAudit(f.principal).length), before);
});
test('G11 DP-01 setup ID conflict and new setup ID cannot reset data', async t => {
  const f = await fixture(t); post(f);
  denied(f.core.setup(f.session, bytes({ ...f.setupRequest, principal: { kind: 'person', display_name: 'different' } })), 'COMMAND_CONFLICT');
  denied(f.core.setup(f.session, bytes({ ...f.setupRequest, setup_command_id: randomUUID() })), 'ALREADY_INITIALIZED');
  assert.equal(snap(f).messages.length, 1);
});
test('G11 DP-01 another actor cannot recover the bootstrap receipt', async t => {
  const f = await fixture(t), stranger = f.core.openSession(randomUUID());
  denied(f.core.setup(stranger, bytes(f.setupRequest))); denied(f.core.receipt(stranger, f.setupRequest.setup_command_id));
});
for (const failAt of [2, 7, 14]) test(`G11 DP-01 bootstrap write fault ${failAt} rolls back the entire business transaction`, async t => {
  const f = await fixture(t, { setup: false }); let calls = 0;
  const writerMethods = new Set(['insertPrincipal', 'putMembership', 'insertScope', 'insertRecord', 'setMeta', 'appendAudit', 'insertCommand']);
  const proxy = new Proxy(f.store, { get(target, name) {
    if (name === 'transaction') return fn => target.transaction(tx => fn(new Proxy(tx, { get(access, key) {
      const member = Reflect.get(access, key, access);
      return typeof member !== 'function' ? member : (...args) => {
        if (writerMethods.has(key) && ++calls === failAt) throw new LedgerIntegrityError('Independent bootstrap fault');
        return member.apply(access, args);
      };
    } })));
    const member = Reflect.get(target, name, target); return typeof member === 'function' ? member.bind(target) : member;
  } });
  const core = new OrgManageCore(proxy, f.options), session = core.openSession(f.actor);
  denied(core.setup(session, bytes(f.setupRequest)), 'RECOVERY_REQUIRED');
  assert.equal(calls, failAt); f.store.read(tx => { assert.deepEqual(tx.listPrincipal(), []); assert.deepEqual(tx.listScope(null), []); assert.equal(tx.getMeta('bootstrap'), undefined); });
  assert.equal(core.snapshot(session).status, 'setup_required');
  committed(f.core.setup(f.session, bytes(f.setupRequest)));
});
test('G11 DP-01 partial business bootstrap is not presented as a fresh setup', async t => {
  const f = await fixture(t, { setup: false });
  f.store.transaction(tx => tx.insertPrincipal({ id: randomUUID(), kind: 'person', displayName: 'incomplete' }));
  assert.throws(() => new OrgManageCore(f.store, f.options), LedgerIntegrityError);
});
test('G08 16.3 repeated command returns a durable receipt without duplicate messages', async t => {
  const f = await fixture(t), sent = post(f), before = snap(f);
  assert.deepEqual(committed(f.core.command(f.session, bytes(sent.input))), sent.receipt);
  assert.deepEqual(committed(f.core.receipt(f.session, sent.input.command_id)), sent.receipt);
  assert.equal(snap(f).messages.length, 1); assert.equal(snap(f).conversation.revision, before.conversation.revision);
  denied(f.core.command(f.session, bytes({ ...sent.input, payload: { ...sent.input.payload, raw_text: 'changed' } })), 'COMMAND_CONFLICT');
});
test('G08 16.3 business rejection is durable and does not perform partial writes', async t => {
  const f = await fixture(t), conversation = snap(f).conversation;
  const input = request('conversation.post', conversation.id, '2', { message_id: randomUUID(), raw_text: 'rejected', attachment_refs: [], relation_hint: 'new' });
  const first = denied(f.core.command(f.session, bytes(input)), 'REVISION_CONFLICT');
  assert.equal(first.ok, true); assert.deepEqual(f.core.command(f.session, bytes(input)), first);
  assert.deepEqual(f.core.receipt(f.session, input.command_id), first); assert.equal(snap(f).messages.length, 0);
});
test('G08 16.3 malformed wire input does not create a terminal command receipt', async t => {
  const f = await fixture(t), before = f.store.read(tx => tx.listAudit(f.principal).length), commandId = randomUUID();
  denied(f.core.command(f.session, bytes({ command_id: commandId, actor: f.actor })), 'SCHEMA_INVALID');
  assert.equal(f.store.read(tx => tx.getCommand(f.principal, commandId)), undefined);
  assert.equal(f.store.read(tx => tx.listAudit(f.principal).length), before);
});
test('G11 DP-11 fabricated session object grants no authority', async t => {
  const f = await fixture(t); denied(f.core.snapshot({ principalId: f.principal, actorId: f.actor }));
});
test('G08 current ACL rejects old session and receipt access after membership revocation', async t => {
  const f = await fixture(t), sent = post(f);
  f.store.transaction(tx => tx.putMembership({ principalId: f.principal, actorId: f.actor, role: 'revoked', generation: 2n }));
  denied(f.core.snapshot(f.session)); denied(f.core.receipt(f.session, sent.input.command_id)); denied(f.core.command(f.session, bytes(sent.input)));
});
test('viewer can see authorized state but cannot issue commands or read another actors receipt', async t => {
  const f = await fixture(t), viewer = randomUUID();
  f.store.transaction(tx => tx.putMembership({ principalId: f.principal, actorId: viewer, role: 'viewer', generation: 1n }));
  const session = f.core.openSession(viewer), view = snap(f, session);
  const input = request('conversation.post', view.conversation.id, view.conversation.revision, { message_id: randomUUID(), raw_text: 'forbidden', attachment_refs: [], relation_hint: 'new' });
  denied(f.core.command(session, bytes(input))); denied(f.core.receipt(session, f.setupRequest.setup_command_id));
});
test('G11 DP-11 principal selection invalidates old session and isolates contents and cursor', async t => {
  const f = await fixture(t); post(f, '旧主体だけの原文'); const other = addPrincipal(f), old = f.session, before = snap(f);
  const next = f.core.selectPrincipal(old, other.principal); assert.equal(next.ok, undefined);
  denied(f.core.snapshot(old)); const view = snap(f, next);
  assert.equal(view.principal.id, other.principal); assert.equal(view.messages.length, 0); assert.notEqual(view.visibleCursor, before.visibleCursor);
  assert.equal(view.sessionGeneration, '2');
});
test('G11 DP-08 activity in another principal does not change the current visible cursor', async t => {
  const f = await fixture(t), other = addPrincipal(f, randomUUID()), before = snap(f).visibleCursor;
  const session = f.core.openSession(other.actor); post(f, '他主体の非公開原文', 'new', session);
  assert.equal(snap(f).visibleCursor, before); assert.equal(snap(f).messages.length, 0);
  assert.equal('seq' in snap(f), false); assert.equal('event_seq' in snap(f), false);
});
test('G11 DP-01 normal snapshot is read-only', async t => {
  const f = await fixture(t); prepared(f);
  const before = f.store.read(tx => ({ records: tx.listRecord(f.principal), audit: tx.listAudit(f.principal) }));
  snap(f); snap(f);
  assert.deepEqual(f.store.read(tx => ({ records: tx.listRecord(f.principal), audit: tx.listAudit(f.principal) })), before);
});
test('G08 raw text remains exact and authorized posts do not imply external execution', async t => {
  const f = await fixture(t), text = 'e\u0301\n　空白と改行\n'; post(f, text);
  const view = snap(f); assert.equal(view.messages[0].text, text); assert.equal(view.intents.length, 0); assert.equal(view.budget.actualExternalCostYen, '0');
});
test('Home timeline uses posting order rather than random UUID sort order', async t => {
  const f = await fixture(t);
  post(f, 'first', 'new', f.session, 'ffffffff-ffff-ffff-ffff-ffffffffffff'); f.now = new Date(f.now.getTime() + 1000);
  post(f, 'second', 'new', f.session, '00000000-0000-0000-0000-000000000001');
  assert.deepEqual(snap(f).messages.map(m => m.text), ['first', 'second']);
});
test('G08 reference syntax cannot authorize unregistered attachments', async t => {
  const f = await fixture(t), view = snap(f);
  const input = request('conversation.post', view.conversation.id, view.conversation.revision, { message_id: randomUUID(), raw_text: 'file', attachment_refs: [randomUUID()], relation_hint: 'new' });
  denied(f.core.command(f.session, bytes(input)), 'CAPABILITY_UNVERIFIED'); assert.equal(snap(f).messages.length, 0);
});
test('TX1 atomically reserves a fake amount and creates a pending approval before dispatch', async t => {
  const f = await fixture(t), item = prepared(f), view = snap(f);
  assert.equal(view.pendingCount, 1); assert.equal(view.budget.heldYen, '700'); assert.equal(view.budget.bookedYen, '0');
  assert.equal(view.intents[0].state, 'prepared'); denied(f.core.acquireDispatch(f.principal, item.intent.id));
  assert.equal(view.approvals[0].explanation.maximumYen, '700'); assert.equal(view.budget.actualExternalCostYen, '0');
});
test('TX1 concurrent sequential reservations cannot overbook a normal 1000 fixture cap', async t => {
  const f = await fixture(t); prepared(f); const next = post(f, 'second').mission;
  const input = request('mission.start', next.id, next.scope.revision, { brief_revision: next.briefRef, contract_revision: next.contractRef });
  denied(f.core.command(f.session, bytes(input)), 'BUDGET_BLOCKED');
  assert.equal(snap(f).intents.length, 1); assert.equal(snap(f).budget.heldYen, '700');
});
test('approval target digest and explanation revision must match independently', async t => {
  const f = await fixture(t), item = prepared(f), a = item.approval;
  for (const payload of [
    { action_digest: '0'.repeat(64), explanation_revision: a.explanationRevision, choice: 'approve', comment: null },
    { action_digest: a.actionDigest, explanation_revision: '2', choice: 'approve', comment: null },
  ]) denied(f.core.command(f.session, bytes(request('approval.decide', a.id, a.revision, payload))), 'REVISION_CONFLICT');
  assert.equal(snap(f).approvals[0].state, 'pending');
});
test('approval comment, actor and decision timestamp survive in the immutable version history', async t => {
  const f = await fixture(t), item = approved(f), row = saved(f, item.approval.id);
  assert.deepEqual(row.value.decision, { actorId: f.actor, membershipGeneration: '1', comment: 'この模擬条件のみ', decidedAt: f.now.toISOString() });
  assert.equal(f.store.read(tx => tx.getRecordHistory(f.principal, item.approval.id).length), 2);
});
test('unrelated progress does not invalidate an approval', async t => {
  const f = await fixture(t), item = approved(f); post(f, 'unrelated request'); f.core.maintain();
  assert.equal(snap(f).approvals.find(a => a.id === item.approval.id).state, 'approved'); assert.equal(f.core.acquireDispatch(f.principal, item.intent.id).ok, true);
});
test('TX2 rejects a revoked initiator even after prior approval', async t => {
  const f = await fixture(t), item = approved(f);
  f.store.transaction(tx => tx.putMembership({ principalId: f.principal, actorId: f.actor, role: 'revoked', generation: 2n }));
  denied(f.core.acquireDispatch(f.principal, item.intent.id)); assert.equal(saved(f, item.intent.id).value.state, 'prepared');
});
test('TX2 rejects a revoked independent decider even while initiator stays authorized', async t => {
  const f = await fixture(t), item = prepared(f), decider = randomUUID();
  f.store.transaction(tx => tx.putMembership({ principalId: f.principal, actorId: decider, role: 'owner', generation: 1n }));
  approve(f, item, f.core.openSession(decider));
  f.store.transaction(tx => tx.putMembership({ principalId: f.principal, actorId: decider, role: 'revoked', generation: 2n }));
  denied(f.core.acquireDispatch(f.principal, item.intent.id));
});
test('G11 DP-10 exact expiry blocks TX2, marks approval expired and releases only prepared reservation', async t => {
  const f = await fixture(t), item = approved(f); f.now = new Date(item.approval.expiresAt);
  denied(f.core.acquireDispatch(f.principal, item.intent.id), 'POLICY_EXPIRED'); f.core.maintain();
  const view = snap(f); assert.equal(view.approvals[0].state, 'expired'); assert.equal(view.intents[0].state, 'discarded'); assert.equal(view.budget.heldYen, '0');
});
test('G11 DP-10 expiry after send preserves unknown reservation and requests cancellation', async t => {
  const f = await fixture(t), item = approved(f); assert.equal(f.core.acquireDispatch(f.principal, item.intent.id).ok, true);
  f.now = new Date(item.approval.expiresAt); f.core.maintain(); const view = snap(f);
  assert.equal(view.intents[0].state, 'unknown'); assert.equal(view.budget.heldYen, '700');
  assert.equal(view.intents[0].cancellation, 'requested'); assert.notEqual(view.intents[0].cancellation, 'observed');
});
test('G11 DP-10 meaningful same-policy change supersedes approval without silently moving money', async t => {
  const f = await fixture(t), item = approved(f), policyId = f.store.read(tx => tx.getMeta(`policy:${f.principal}`));
  update(f, policyId, value => ({ ...value, normalLimitYen: '900' }));
  denied(f.core.acquireDispatch(f.principal, item.intent.id), 'POLICY_EXPIRED'); f.core.maintain();
  assert.equal(snap(f).approvals[0].state, 'superseded'); assert.equal(snap(f).intents[0].state, 'discarded');
});
test('G11 DP-10 equivalent policy version does not require another approval', async t => {
  const f = await fixture(t), item = approved(f), next = randomUUID();
  f.store.transaction(tx => { const old = tx.getRecord(f.principal, tx.getMeta(`policy:${f.principal}`));
    tx.insertRecord({ principalId: f.principal, id: next, kind: 'policy', revision: 1n, data: old.data }); tx.setMeta(`policy:${f.principal}`, next); });
  f.core.maintain(); assert.equal(snap(f).approvals[0].state, 'approved'); assert.equal(f.core.acquireDispatch(f.principal, item.intent.id).ok, true);
});
for (const kind of ['application', 'principal', 'conversation', 'mission']) test(`G11 DP-02 ${kind} stop rejects new dispatch and receipt replay does not advance epoch twice`, async t => {
  const f = await fixture(t), item = approved(f), view = snap(f);
  const scope = kind === 'application' ? view.application : kind === 'principal' ? view.principalScope : kind === 'conversation' ? view.conversation : view.missions[0].scope;
  const input = control(f, scope, kind === 'application' ? 'halt_dispatch' : 'pause');
  const receipt = committed(f.core.command(f.session, bytes(input))), after = f.store.read(tx => tx.getScope(scope.id));
  assert.equal(after.epoch, BigInt(scope.epoch) + 1n); assert.deepEqual(committed(f.core.command(f.session, bytes(input))), receipt);
  assert.equal(f.store.read(tx => tx.getScope(scope.id).epoch), after.epoch); denied(f.core.acquireDispatch(f.principal, item.intent.id));
  assert.equal(snap(f).intents[0].state, 'discarded'); assert.equal(snap(f).budget.heldYen, '0');
});
test('G11 DP-02 control_operation scope supports persistent close and cannot resume', async t => {
  const f = await fixture(t), id = randomUUID();
  f.store.transaction(tx => tx.insertScope({ id, principalId: f.principal, kind: 'control_operation', parentId: f.principal, revision: 1n, epoch: 1n, state: 'active' }));
  committed(f.core.command(f.session, bytes(control(f, { id, kind: 'control_operation', revision: '1' }, 'close'))));
  denied(f.core.command(f.session, bytes(control(f, { id, kind: 'control_operation', revision: '2' }, 'resume'))));
  assert.equal(f.store.read(tx => tx.getScope(id).state), 'closed');
});
test('G11 DP-02 resume never resurrects a discarded intent; a new start must get a fresh approval', async t => {
  const f = await fixture(t), item = approved(f);
  committed(f.core.command(f.session, bytes(control(f, snap(f).missions[0].scope, 'pause'))));
  committed(f.core.command(f.session, bytes(control(f, snap(f).missions[0].scope, 'resume'))));
  denied(f.core.acquireDispatch(f.principal, item.intent.id)); const next = start(f, snap(f).missions[0]);
  assert.notEqual(next.intent.id, item.intent.id); assert.notEqual(next.approval.id, item.approval.id); denied(f.core.acquireDispatch(f.principal, next.intent.id));
});
test('G11 DP-02 application resume requires an explicit new start and a fresh approval after prepared discard', async t => {
  const f = await fixture(t), previous = prepared(f);
  committed(f.core.command(f.session, bytes(control(f, snap(f).application, 'halt_dispatch'))));
  let view = snap(f);
  assert.equal(view.intents.find(i => i.id === previous.intent.id).state, 'discarded');
  assert.equal(view.approvals.find(a => a.id === previous.approval.id).state, 'superseded');
  assert.equal(view.missions.find(m => m.id === previous.mission.id).phase, 'intake');
  committed(f.core.command(f.session, bytes(control(f, view.application, 'resume_dispatch'))));
  denied(f.core.acquireDispatch(f.principal, previous.intent.id));
  view = snap(f); assert.equal(view.intents.length, 1, 'resume alone must not create another execution');
  const next = start(f, view.missions.find(m => m.id === previous.mission.id));
  assert.notEqual(next.intent.id, previous.intent.id); assert.notEqual(next.approval.id, previous.approval.id);
  assert.equal(next.approval.state, 'pending'); denied(f.core.acquireDispatch(f.principal, next.intent.id));
});
test('G11 DP-02 application halt requests cancellation across all principals', async t => {
  const f = await fixture(t), first = approved(f); assert.equal(f.core.acquireDispatch(f.principal, first.intent.id).ok, true);
  const other = addPrincipal(f, randomUUID()), session = f.core.openSession(other.actor), second = approve(f, start(f, post(f, '別組織', 'new', session).mission, session), session);
  assert.equal(f.core.acquireDispatch(other.principal, second.intent.id).ok, true);
  committed(f.core.command(f.session, bytes(control(f, snap(f).application, 'halt_dispatch'))));
  for (const [p, id] of [[f.principal, first.intent.id], [other.principal, second.intent.id]]) {
    const state = saved(f, id, p).value; assert.equal(state.cancellation, 'requested'); assert.equal(state.state, 'send_intent');
  }
});
test('G11 DP-03 late completion after pause records costs and artifact without reopening or accepting', async t => {
  const f = await fixture(t), item = approved(f); assert.equal(f.core.acquireDispatch(f.principal, item.intent.id).ok, true);
  committed(f.core.command(f.session, bytes(control(f, snap(f).missions[0].scope, 'pause'))));
  assert.equal(f.core.observeFake(f.principal, item.intent.id, 'success', 'late-result', '400').ok, true);
  const view = snap(f); assert.equal(view.missions[0].scope.state, 'paused'); assert.equal(view.outcomes[0].state, 'pending');
  assert.equal(view.intents[0].cancellation, 'requested'); assert.equal(view.budget.bookedYen, '400'); assert.equal(view.budget.heldYen, '0');
});
test('G11 DP-03 unknown preserves conservative hold, one case and one finite job; no retry', async t => {
  const f = await fixture(t), item = approved(f); assert.equal(f.core.acquireDispatch(f.principal, item.intent.id).ok, true);
  denied(f.core.observeFake(f.principal, item.intent.id, 'unknown', 'first', '0'), 'OUTCOME_UNKNOWN');
  denied(f.core.observeFake(f.principal, item.intent.id, 'unknown', 'second', '0'), 'OUTCOME_UNKNOWN');
  const view = snap(f); assert.equal(view.budget.heldYen, '700'); assert.equal(view.budget.bookedYen, '0'); assert.equal(view.outcomes.length, 0);
  f.store.read(tx => { assert.equal(tx.listRecord(f.principal, 'reconciliation_case').length, 1); const jobs = tx.listRecord(f.principal, 'job');
    assert.equal(jobs.length, 1); assert.equal(JSON.parse(jobs[0].data).maxAttempts, '3'); });
  denied(f.core.executeFake(f.principal, item.intent.id)); assert.equal(snap(f).intents.length, 1);
});
test('G11 DP-03 pause and resume cannot disguise replacement execution while prior effect is unknown', async t => {
  const f = await fixture(t), item = approved(f); assert.equal(f.core.acquireDispatch(f.principal, item.intent.id).ok, true);
  denied(f.core.observeFake(f.principal, item.intent.id, 'unknown', 'unresolved-effect', '0'), 'OUTCOME_UNKNOWN');
  committed(f.core.command(f.session, bytes(control(f, snap(f).missions[0].scope, 'pause'))));
  committed(f.core.command(f.session, bytes(control(f, snap(f).missions[0].scope, 'resume'))));
  const mission = snap(f).missions[0], input = request('mission.start', mission.id, mission.scope.revision,
    { brief_revision: mission.briefRef, contract_revision: mission.contractRef });
  const result = f.core.command(f.session, bytes(input));
  assert.equal(result.ok && result.receipt.disposition === 'committed', false, 'unknown effect must block replacement before any fresh intent is created');
  const view = snap(f); assert.equal(view.intents.length, 1); assert.equal(view.intents[0].id, item.intent.id);
  assert.equal(view.intents[0].state, 'unknown'); assert.equal(view.budget.heldYen, '700');
});
test('G11 DP-03 later confirmed result settles unknown without creating a replacement intent', async t => {
  const f = await fixture(t), item = approved(f); f.core.acquireDispatch(f.principal, item.intent.id);
  f.core.observeFake(f.principal, item.intent.id, 'unknown', 'unknown', '0');
  const result = f.core.observeFake(f.principal, item.intent.id, 'success', 'confirmed', '400'); assert.equal(result.ok, true);
  assert.equal('receipt' in result, false); assert.equal(result.result.intentId, item.intent.id); assert.ok(result.result.outcomeId);
  const view = snap(f); assert.equal(view.intents.length, 1); assert.equal(view.budget.heldYen, '0'); assert.equal(view.budget.bookedYen, '400');
  assert.equal(saved(f, view.intents[0].reconciliationId).value.state, 'resolved'); denied(f.core.acquireDispatch(f.principal, item.intent.id));
});
test('G11 DP-08 duplicate success observation neither charges twice nor creates another outcome', async t => {
  const f = await fixture(t), item = approved(f); f.core.acquireDispatch(f.principal, item.intent.id);
  assert.equal(f.core.observeFake(f.principal, item.intent.id, 'success', 'same-event', '400').ok, true);
  const again = f.core.observeFake(f.principal, item.intent.id, 'success', 'same-event', '400'); assert.equal(again.ok, true); assert.equal(again.result.duplicate, true);
  const view = snap(f); assert.equal(view.budget.bookedYen, '400'); assert.equal(view.outcomes.length, 1);
  assert.equal(f.store.read(tx => tx.listRecord(f.principal, 'cost_event').length), 1);
});
test('G11 DP-08 conflicting event content retains both evidence versions and becomes unknown', async t => {
  const f = await fixture(t), item = approved(f); f.core.acquireDispatch(f.principal, item.intent.id);
  f.core.observeFake(f.principal, item.intent.id, 'unknown', 'conflict-key', '0'); f.now = new Date(f.now.getTime() + 1000);
  denied(f.core.observeFake(f.principal, item.intent.id, 'success', 'conflict-key', '400'), 'OUTCOME_UNKNOWN');
  const evidence = f.store.read(tx => tx.listRecord(f.principal, 'evidence').map(row => JSON.parse(row.data)));
  assert.equal(evidence.length, 2); assert.deepEqual(new Set(evidence.map(e => e.outcome)), new Set(['unknown', 'success']));
  assert.equal(evidence.every(e => e.observedAt && e.eventKey === 'conflict-key'), true);
  assert.equal(snap(f).intents[0].state, 'unknown'); assert.equal(snap(f).budget.heldYen, '700'); assert.equal(snap(f).outcomes.length, 0);
});
test('G11 DP-08 reconciliation case links both conflicting evidence records', async t => {
  const f = await fixture(t), item = approved(f); f.core.acquireDispatch(f.principal, item.intent.id);
  f.core.observeFake(f.principal, item.intent.id, 'unknown', 'same-key', '0');
  f.core.observeFake(f.principal, item.intent.id, 'success', 'same-key', '400');
  const evidenceIds = f.store.read(tx => tx.listRecord(f.principal, 'evidence').map(row => row.id));
  const caseId = snap(f).intents[0].reconciliationId, caseData = saved(f, caseId).value;
  assert.equal(evidenceIds.length, 2);
  for (const id of evidenceIds) assert.ok(caseData.evidenceRefs.includes(id), 'case must link preserved conflicting payload evidence');
});
test('G11 DP-08 conflict after completed result cannot recreate charge and artifact with another event key', async t => {
  const f = await fixture(t), item = approved(f); f.core.acquireDispatch(f.principal, item.intent.id);
  f.core.observeFake(f.principal, item.intent.id, 'success', 'original', '400');
  f.core.observeFake(f.principal, item.intent.id, 'success', 'original', '500');
  f.core.observeFake(f.principal, item.intent.id, 'success', 'new-event', '400');
  assert.equal(snap(f).outcomes.length, 1, 'one effect must not create a second artifact/OutcomeReview after conflict');
  assert.equal(f.store.read(tx => tx.listRecord(f.principal, 'cost_event').length), 1, 'event identity alone is not a second charge identity');
  assert.equal(snap(f).budget.bookedYen, '400');
});
test('G11 DP-03 conflicting settlement retains conservative remainder and deduplicates repeated conflict evidence', async t => {
  const f = await fixture(t), item = approved(f); assert.equal(f.core.acquireDispatch(f.principal, item.intent.id).ok, true);
  assert.equal(f.core.observeFake(f.principal, item.intent.id, 'success', 'cost-conflict', '400').ok, true);
  denied(f.core.observeFake(f.principal, item.intent.id, 'success', 'cost-conflict', '500'), 'OUTCOME_UNKNOWN');
  const view = snap(f);
  assert.equal(view.intents[0].state, 'unknown'); assert.equal(view.budget.bookedYen, '400');
  assert.ok(BigInt(view.budget.heldYen) >= 300n, '700 reservation minus 400 booked must remain conservatively held');
  assert.equal(f.store.read(tx => tx.listRecord(f.principal, 'cost_event').length), 1);
  const before = f.store.read(tx => tx.listRecord(f.principal, 'evidence').length);
  f.core.observeFake(f.principal, item.intent.id, 'success', 'cost-conflict', '500');
  assert.equal(f.store.read(tx => tx.listRecord(f.principal, 'evidence').length), before);
  assert.equal(f.store.read(tx => tx.listRecord(f.principal, 'cost_event').length), 1);
  assert.equal(snap(f).budget.bookedYen, '400'); assert.ok(BigInt(snap(f).budget.heldYen) >= 300n);
});
test('G09 17.6 settlement above reservation records the truth and blocks further over-cap admission', async t => {
  const f = await fixture(t), item = approved(f); f.core.acquireDispatch(f.principal, item.intent.id);
  assert.equal(f.core.observeFake(f.principal, item.intent.id, 'success', 'overrun', '1200').ok, true);
  assert.equal(snap(f).budget.bookedYen, '1200'); assert.equal(snap(f).budget.actualExternalCostYen, '0');
  const next = post(f, 'blocked by real fixture amount').mission;
  denied(f.core.command(f.session, bytes(request('mission.start', next.id, next.scope.revision, { brief_revision: next.briefRef, contract_revision: next.contractRef }))), 'BUDGET_BLOCKED');
});
for (const choice of ['accepted', 'revise', 'hold', 'close']) test(`G08/G11 Home ${choice} persists its specific effect without creating external authority`, async t => {
  const f = await fixture(t), item = approved(f); assert.equal(f.core.executeFake(f.principal, item.intent.id).ok, true);
  const before = snap(f), decision = outcome(f, choice, '利用者の理由'), view = snap(f);
  assert.equal(view.outcomes[0].state, choice); assert.equal(saved(f, decision.previous.id).value.comment, '利用者の理由');
  assert.equal(view.approvals.length, before.approvals.length); assert.equal(view.intents.length, 1);
  assert.equal(view.budget.actualExternalCostYen, '0');
  if (choice === 'accepted') assert.equal(view.missions[0].phase, 'exit');
  if (choice === 'hold') assert.equal(view.missions[0].scope.state, 'paused');
  if (choice === 'close') assert.equal(view.missions[0].scope.state, 'closed');
  if (choice === 'revise') {
    const mission = saved(f, view.missions[0].id).value;
    assert.equal(mission.originalRequest, '原文を失わない合成依頼'); assert.equal(view.missions[0].phase, 'intake');
    assert.equal(mission.contractRef, before.missions[0].contractRef); assert.notEqual(mission.pendingContractRef, mission.contractRef);
    assert.equal(saved(f, mission.briefRef).value.organized, false);
  }
});
test('G11 DP-10 revise then continue uses the latest request and contract consistently', async t => {
  const f = await fixture(t, { fakeProfile: { reservationYen: '0', settledYen: '0' } }), item = approved(f); f.core.executeFake(f.principal, item.intent.id);
  outcome(f, 'revise', '最初の修正候補'); post(f, '追加の修正内容', 'continue');
  const mission = snap(f).missions[0], next = start(f, mission);
  assert.equal(next.approval.state, 'pending'); assert.equal(saved(f, mission.id).value.contractRef, mission.contractRef);
  assert.equal(saved(f, mission.briefRef).value.revisionRequest, '追加の修正内容');
});
test('G11 DP-10 old contract cannot start after revise without confirming the new candidate', async t => {
  const f = await fixture(t, { fakeProfile: { reservationYen: '0', settledYen: '0' } }), item = approved(f); f.core.executeFake(f.principal, item.intent.id);
  const old = snap(f).missions[0]; outcome(f, 'revise', null); const next = snap(f).missions[0];
  denied(f.core.command(f.session, bytes(request('mission.start', next.id, next.scope.revision, { brief_revision: next.briefRef, contract_revision: old.contractRef }))), 'REVISION_CONFLICT');
  assert.equal(snap(f).intents.length, 1);
});
test('G11 recovery discards old-owner prepared intent and never auto-dispatches on reopen', async t => {
  const f = await fixture(t), item = approved(f); await f.store.close(); f.store = await LedgerStore.open(f.path);
  f.core = new OrgManageCore(f.store, f.options); f.session = f.core.openSession(f.actor);
  assert.equal(snap(f).intents[0].state, 'discarded'); assert.equal(snap(f).budget.heldYen, '0'); denied(f.core.executeFake(f.principal, item.intent.id));
});
test('G11 recovery records prepared discard and approval invalidation in audit and changes the visible feed', async t => {
  const f = await fixture(t), item = prepared(f), before = snap(f);
  const oldAudit = f.store.read(tx => tx.listAudit(f.principal));
  await f.store.close(); f.store = await LedgerStore.open(f.path);
  f.core = new OrgManageCore(f.store, f.options); f.session = f.core.openSession(f.actor);
  const view = snap(f), audit = f.store.read(tx => tx.listAudit(f.principal)), freshAudit = audit.slice(oldAudit.length);
  assert.equal(view.intents.find(i => i.id === item.intent.id).state, 'discarded');
  assert.equal(view.approvals.find(a => a.id === item.approval.id).state, 'superseded');
  assert.equal(view.missions.find(m => m.id === item.mission.id).phase, 'intake');
  assert.notEqual(view.visibleCursor, before.visibleCursor, 'recovery must invalidate the stale UI feed');
  assert.ok(freshAudit.some(e => e.entityId === item.intent.id), 'the discarded intent needs an auditable transition');
  assert.ok(freshAudit.some(e => e.entityId === item.approval.id), 'the invalidated approval needs an auditable transition');
  assert.equal(view.budget.heldYen, '0');
});
test('G11 recovery turns old send boundary into unknown and preserves budget and receipt', async t => {
  const f = await fixture(t), item = approved(f); f.core.acquireDispatch(f.principal, item.intent.id);
  await f.store.close(); f.store = await LedgerStore.open(f.path); f.core = new OrgManageCore(f.store, f.options); f.session = f.core.openSession(f.actor);
  assert.equal(snap(f).intents[0].state, 'unknown'); assert.equal(snap(f).budget.heldYen, '700');
  assert.deepEqual(committed(f.core.receipt(f.session, item.input.command_id)), item.receipt); denied(f.core.executeFake(f.principal, item.intent.id));
});
test('G11 recovery fences old intent when owner ID is reused but owner epoch advances', async t => {
  const f = await fixture(t), item = approved(f), ownerId = f.store.ownerId, oldEpoch = f.store.ownerEpoch;
  await f.store.close(); f.store = await LedgerStore.open(f.path, { ownerId });
  assert.equal(f.store.ownerEpoch, oldEpoch + 1n); f.core = new OrgManageCore(f.store, f.options); f.session = f.core.openSession(f.actor);
  assert.equal(snap(f).intents[0].state, 'discarded'); denied(f.core.acquireDispatch(f.principal, item.intent.id));
});
test('G09 17.6 JST month boundary changes only newly admitted step accounting', () => {
  assert.equal(budgetMonth(new Date('2026-09-30T14:59:59.999Z')), '2026-09');
  assert.equal(budgetMonth(new Date('2026-09-30T15:00:00Z')), '2026-10');
  const rows = [{ month: '2026-09', purpose: 'production', bookedYen: '400', heldYen: '700' }];
  assert.deepEqual(aggregate(rows, '2026-09'), { booked: 400n, held: 700n, autonomousE: 0n });
  assert.deepEqual(aggregate(rows, '2026-10'), { booked: 0n, held: 0n, autonomousE: 0n });
});
test('G11 DP-07 autonomous E includes booked plus held and cannot borrow normal headroom beyond E cap', () => {
  const policy = { normalLimitYen: '1000', autonomousELimitYen: '100' };
  const rows = [{ month: '2026-09', purpose: 'autonomous_e', bookedYen: '60', heldYen: '30' }];
  assert.equal(canReserve(policy, rows, '2026-09', '10', 'autonomous_e'), true);
  assert.equal(canReserve(policy, rows, '2026-09', '11', 'autonomous_e'), false);
  assert.equal(canReserve(policy, rows, '2026-09', '11', 'production'), true);
  assert.equal(yen('9007199254740993') - yen('9007199254740992'), 1n);
  for (const bad of ['01', '-1', '1.1', '1e3', '1\n']) assert.throws(() => yen(bad), RangeError);
});
