import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { LedgerStore, LedgerIntegrityError } from '../../../dist/ledger/src/index.js';
import { OrgManageCore } from '../../../dist/core/src/index.js';

export { LedgerStore, LedgerIntegrityError, OrgManageCore, randomUUID };
export const bytes = value => Buffer.from(JSON.stringify(value));
export const request = (type, targetId, revision, payload, commandId = randomUUID()) => ({
  protocol_version: 1, command_id: commandId, command_type: type,
  target_id: targetId, expected_revision: String(revision), payload,
});
export const setupRequest = (commandId = randomUUID()) => ({ protocol_version: 1, setup_command_id: commandId,
  principal: { kind: 'person', display_name: '独立合成fixture' }, owner_binding_candidate: null });
export function committed(value) {
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.equal(value.receipt.disposition, 'committed', JSON.stringify(value));
  assert.equal(value.receipt.error_code, null);
  assert.match(value.receipt.visible_cursor, /^[A-Za-z0-9_-]{32,256}$/);
  assert.equal('event_seq' in value.receipt, false);
  return value.receipt;
}
export function denied(value, code = 'DENIED') {
  if (value.ok) { assert.equal(value.receipt.disposition, 'rejected'); assert.equal(value.receipt.error_code, code); }
  else assert.equal(value.error.code, code, JSON.stringify(value));
  return value;
}
export function snap(f, session = f.session) {
  const value = f.core.snapshot(session); assert.equal(value.status, 'ready', JSON.stringify(value)); return value;
}
export function saved(f, id, principal = f.principal) {
  return f.store.read(tx => { const row = tx.getRecord(principal, id); assert.ok(row); return { row, value: JSON.parse(row.data) }; });
}
export function update(f, id, transform, principal = f.principal) {
  f.store.transaction(tx => { const row = tx.getRecord(principal, id); assert.ok(row);
    tx.updateRecord({ ...row, revision: row.revision + 1n, data: JSON.stringify(transform(JSON.parse(row.data))) }, row.revision); });
}
export async function fixture(t, options = {}) {
  const directory = resolve('.private/test-runs/core'); await mkdir(directory, { recursive: true });
  const path = join(await mkdtemp(join(directory, 'oracle-')), 'ledger.sqlite');
  const f = { path, store: await LedgerStore.open(path), actor: randomUUID(), now: new Date('2026-09-12T01:00:00Z') };
  f.options = { clock: () => new Date(f.now), fakeProfile: { reservationYen: '700', settledYen: '400', normalLimitYen: '1000', autonomousELimitYen: '100', approvalLifetimeMs: 60000, ...options.fakeProfile } };
  f.core = new OrgManageCore(f.store, f.options); f.session = f.core.openSession(f.actor);
  t.after(async () => { await f.store.close(); });
  f.setupRequest = setupRequest();
  if (options.setup !== false) { f.setupReceipt = committed(f.core.setup(f.session, bytes(f.setupRequest))); f.principal = snap(f).principal.id; }
  return f;
}
export function post(f, text = '原文を失わない合成依頼', relation = 'new', session = f.session, messageId = randomUUID()) {
  const view = snap(f, session);
  const input = request('conversation.post', view.conversation.id, view.conversation.revision,
    { message_id: messageId, raw_text: text, attachment_refs: [], relation_hint: relation });
  const receipt = committed(f.core.command(session, bytes(input)));
  const mission = snap(f, session).missions.find(m => m.id === receipt.result_ref); assert.ok(mission);
  return { mission, input, receipt, messageId };
}
export function start(f, mission, session = f.session) {
  const input = request('mission.start', mission.id, mission.scope.revision,
    { brief_revision: mission.briefRef, contract_revision: mission.contractRef });
  const receipt = committed(f.core.command(session, bytes(input)));
  const view = snap(f, session), approval = view.approvals.find(a => a.id === receipt.result_ref), intent = view.intents.find(i => i.missionId === mission.id && i.state === 'prepared');
  assert.ok(approval); assert.ok(intent); return { mission, approval, intent, input, receipt };
}
export function approve(f, started, session = f.session, comment = 'この模擬条件のみ') {
  const a = snap(f, session).approvals.find(a => a.id === started.approval.id);
  const input = request('approval.decide', a.id, a.revision,
    { action_digest: a.actionDigest, explanation_revision: a.explanationRevision, choice: 'approve', comment });
  const receipt = committed(f.core.command(session, bytes(input))); return { ...started, approval: a, approvalInput: input, approvalReceipt: receipt };
}
export function prepared(f) { return start(f, post(f).mission); }
export function approved(f) { return approve(f, prepared(f)); }
export function control(f, scope, choice, session = f.session) {
  const type = scope.kind === 'application' ? 'application.control' : 'scope.control';
  return request(type, scope.id, scope.revision, scope.kind === 'application' ? { choice, comment: '独立停止fixture' } : { scope: scope.kind, choice, comment: '独立停止fixture' });
}
export function outcome(f, choice, comment = null) {
  const view = snap(f), o = view.outcomes.find(o => o.state === 'pending'); assert.ok(o);
  const input = request('outcome.decide', o.id, o.revision,
    { artifact_revision_id: o.artifactId, explanation_revision: o.explanationRevision, choice, comment });
  const receipt = committed(f.core.command(f.session, bytes(input))); return { receipt, input, previous: o };
}
export function addPrincipal(f, actor = f.actor) {
  const principal = randomUUID(), conversation = randomUUID(), policy = randomUUID();
  const view = snap(f), sourcePolicy = f.store.read(tx => JSON.parse(tx.getRecord(f.principal, tx.getMeta(`policy:${f.principal}`)).data));
  f.store.transaction(tx => {
    tx.insertPrincipal({ id: principal, kind: 'organization', displayName: '別主体の合成fixture' });
    tx.putMembership({ principalId: principal, actorId: actor, role: 'owner', generation: 1n });
    tx.insertScope({ id: principal, principalId: principal, kind: 'principal', parentId: view.application.id, revision: 1n, epoch: 1n, state: 'active' });
    tx.insertScope({ id: conversation, principalId: principal, kind: 'conversation', parentId: principal, revision: 1n, epoch: 1n, state: 'active' });
    tx.insertRecord({ principalId: principal, id: conversation, kind: 'conversation', revision: 1n, data: JSON.stringify({ messageIds: [], missionIds: [] }) });
    tx.insertRecord({ principalId: principal, id: policy, kind: 'policy', revision: 1n, data: JSON.stringify(sourcePolicy) });
    tx.setMeta(`policy:${principal}`, policy); tx.setMeta(`feed:${principal}`, randomUUID());
  });
  return { principal, conversation, actor };
}
