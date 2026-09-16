import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeCommand, decodeSetup, decodeReceipt, decodeExecutionEvidence } from '../../dist/contracts/src/index.js';
import { bytes, commandId, ref, command, rejected, accepted } from './fixtures/helpers.mjs';

const setup = () => ({ protocol_version: 1, setup_command_id: commandId, principal: { kind: 'person', display_name: 'Local example' }, owner_binding_candidate: null });
const receipt = () => ({ command_id: commandId, disposition: 'committed', visible_cursor: 'a'.repeat(32), result_ref: null, error_code: null });
const evidence = () => ({ cancellation: { kind: 'not_requested' }, effect: { kind: 'unknown', reconciliation_ref: ref } });

test('G11 DP-01 partial: setup has a separate closed input and provides no owner authority', () => {
  for (const kind of ['person', 'organization']) {
    const candidate = setup(); candidate.principal.kind = kind;
    const result = decodeSetup(bytes(candidate));
    assert.deepEqual(accepted(result), candidate);
    assert.equal(result.validation, 'syntax_only');
    assert.equal(Object.hasOwn(result, 'owner'), false);
    assert.equal(Object.hasOwn(result, 'authenticated'), false);
  }
  rejected(decodeCommand(bytes(setup())), 'SCHEMA_INVALID');
  rejected(decodeSetup(bytes(command())), 'SCHEMA_INVALID');
});

test('setup rejects all self-asserted owner/OS/policy claims and normal revisions', () => {
  for (const field of ['actor', 'principal_id', 'os_identity', 'is_owner', 'policy', 'script', 'expected_revision']) {
    const candidate = setup(); candidate[field] = field === 'expected_revision' ? '0' : 'self-asserted';
    rejected(decodeSetup(bytes(candidate)), 'SCHEMA_INVALID');
  }
  for (const field of ['actor', 'role', 'permissions']) {
    const candidate = setup(); candidate.principal[field] = 'owner';
    rejected(decodeSetup(bytes(candidate)), 'SCHEMA_INVALID');
  }
  const claimed = setup(); claimed.owner_binding_candidate = { actor: 'owner' };
  rejected(decodeSetup(bytes(claimed)), 'SCHEMA_INVALID');
});

test('setup requires every declared field, a known Principal kind and a bounded nonempty display name', () => {
  for (const field of Object.keys(setup())) {
    const candidate = setup(); delete candidate[field];
    rejected(decodeSetup(bytes(candidate)), 'SCHEMA_INVALID');
  }
  for (const value of ['', 'x'.repeat(257), null]) {
    const candidate = setup(); candidate.principal.display_name = value;
    rejected(decodeSetup(bytes(candidate)), 'SCHEMA_INVALID');
  }
  const atLimit = setup(); atLimit.principal.display_name = 'x'.repeat(256);
  accepted(decodeSetup(bytes(atLimit)));
  const unknownKind = setup(); unknownKind.principal.kind = 'system_owner';
  rejected(decodeSetup(bytes(unknownKind)), 'SCHEMA_INVALID');
});

test('G11 DP-08 partial: external receipt shape uses a visible cursor and omits global audit sequence', () => {
  const result = decodeReceipt(bytes(receipt()));
  assert.deepEqual(accepted(result), receipt());
  assert.equal(result.validation, 'syntax_only');
  for (const field of ['event_seq', 'seq', 'principal_id', 'executed', 'persisted']) {
    const candidate = receipt(); candidate[field] = '9007199254740993';
    rejected(decodeReceipt(bytes(candidate)), 'SCHEMA_INVALID');
  }
  for (const value of ['1', '', 'a'.repeat(31), 'a'.repeat(257), 'a'.repeat(32) + '\n']) {
    const candidate = receipt(); candidate.visible_cursor = value;
    rejected(decodeReceipt(bytes(candidate)), 'SCHEMA_INVALID');
  }
});

test('G08-V17 partial: BUSY and UNKNOWN are never terminal rejected receipt codes', () => {
  for (const error_code of ['BUSY_NOT_COMMITTED', 'OUTCOME_UNKNOWN']) {
    const candidate = receipt(); candidate.disposition = 'rejected'; candidate.error_code = error_code;
    rejected(decodeReceipt(bytes(candidate)), 'SCHEMA_INVALID');
  }
  const rejectedReceipt = receipt(); rejectedReceipt.disposition = 'rejected'; rejectedReceipt.error_code = 'REVISION_CONFLICT';
  accepted(decodeReceipt(bytes(rejectedReceipt)));
  for (const disposition of ['accepted', 'approved', 'completed', 'busy', 'unknown']) {
    const candidate = receipt(); candidate.disposition = disposition;
    rejected(decodeReceipt(bytes(candidate)), 'SCHEMA_INVALID');
  }
  const badCommitted = receipt(); badCommitted.error_code = 'REVISION_CONFLICT';
  rejected(decodeReceipt(bytes(badCommitted)), 'SCHEMA_INVALID');
  const badRejected = receipt(); badRejected.disposition = 'rejected';
  rejected(decodeReceipt(bytes(badRejected)), 'SCHEMA_INVALID');
});

test('cancellation request and cancellation observation have distinct required evidence shapes', () => {
  const requested = evidence(); requested.cancellation = { kind: 'requested', request_ref: ref };
  const requestedValue = accepted(decodeExecutionEvidence(bytes(requested)));
  assert.equal(requestedValue.cancellation.kind, 'requested');
  assert.equal(requestedValue.effect.kind, 'unknown');
  const observed = evidence(); observed.cancellation = { kind: 'observed', request_ref: ref, observation_ref: ref };
  accepted(decodeExecutionEvidence(bytes(observed)));
  for (const cancellation of [{ kind: 'requested' }, { kind: 'observed', request_ref: ref }, { kind: 'observed', observation_ref: ref }, { kind: 'requested', request_ref: ref, observed: true }]) {
    const candidate = evidence(); candidate.cancellation = cancellation;
    rejected(decodeExecutionEvidence(bytes(candidate)), 'SCHEMA_INVALID');
  }
});

test('unknown effect needs a reconciliation reference and cannot carry retry or zero-cost permission', () => {
  const value = accepted(decodeExecutionEvidence(bytes(evidence())));
  assert.equal(value.effect.kind, 'unknown');
  const noCase = evidence(); delete noCase.effect.reconciliation_ref;
  rejected(decodeExecutionEvidence(bytes(noCase)), 'SCHEMA_INVALID');
  for (const field of ['retry_allowed', 'not_sent', 'zero_cost', 'write_off', 'authorized']) {
    const candidate = evidence(); candidate.effect[field] = true;
    rejected(decodeExecutionEvidence(bytes(candidate)), 'SCHEMA_INVALID');
  }
  for (const kind of ['not_sent', 'accepted', 'completed', 'failed']) {
    const candidate = evidence(); candidate.effect = { kind, evidence_ref: ref };
    const result = decodeExecutionEvidence(bytes(candidate));
    accepted(result);
    assert.equal(result.validation, 'syntax_only');
    delete candidate.effect.evidence_ref;
    rejected(decodeExecutionEvidence(bytes(candidate)), 'SCHEMA_INVALID');
  }
});
