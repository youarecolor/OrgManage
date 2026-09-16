import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { decodeCommand } from '../../dist/contracts/src/index.js';
import { oracle, bytes, command, conversation, outcome, ref, rejected, accepted } from './fixtures/helpers.mjs';

test('supported closed commands validate only their syntax', () => {
  const examples = [
    command(), conversation('shell http delete are ordinary request text'), outcome(),
    command('approval.decide', { action_digest: 'a'.repeat(64), choice: 'approve', comment: null, explanation_revision: '1' }),
    command('mission.control', { choice: 'pause', comment: null }),
    command('knowledge.decide', { choice: 'reject', candidate_ref: ref, evaluation_ref: null, scope_ref: ref, comment: null }),
    command('application.control', { choice: 'halt_dispatch', comment: null }),
    command('scope.control', { scope: 'conversation', choice: 'close', comment: null }),
  ];
  for (const value of examples) {
    const result = decodeCommand(bytes(value));
    assert.deepEqual(accepted(result), value);
    assert.equal(result.validation, 'syntax_only');
    for (const flag of ['authorized', 'approved', 'executed', 'persisted', 'passed']) assert.equal(Object.hasOwn(result, flag), false);
  }
});

test('the result contains a canonical fingerprint, including independent golden field ordering', () => {
  const result = decodeCommand(bytes(command()));
  accepted(result);
  assert.equal(result.canonical, oracle.canonical_mission_start);
  assert.equal(result.digest, createHash('sha256').update(oracle.canonical_mission_start, 'utf8').digest('hex'));
  const reordered = '{ "payload": { "contract_revision": "' + ref + '", "brief_revision": "' + ref + '" },' +
    '"target_id":"' + oracle.ids.target + '", "command_type":"mission.start", "expected_revision":"1",' +
    '"protocol_version":1, "command_id":"' + oracle.ids.command + '" }';
  const equivalent = decodeCommand(bytes(reordered));
  accepted(equivalent);
  assert.equal(equivalent.canonical, result.canonical);
  assert.equal(equivalent.digest, result.digest);
});

test('raw Unicode text is preserved without NFC normalization or summarization', () => {
  const nfc = decodeCommand(bytes(conversation('é')));
  const nfd = decodeCommand(bytes(conversation('e\u0301')));
  assert.equal(accepted(nfc).payload.raw_text, 'é');
  assert.equal(accepted(nfd).payload.raw_text, 'e\u0301');
  assert.notEqual(nfc.digest, nfd.digest);
  const escaped = decodeCommand(bytes(JSON.stringify(conversation('é')).replace('é', '\\u00e9')));
  accepted(escaped);
  assert.equal(escaped.digest, nfc.digest);
});

test('accepted values are deeply frozen and independent of subsequent input-byte mutation', () => {
  const input = bytes(conversation('retained'));
  const value = accepted(decodeCommand(input));
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.payload), true);
  assert.equal(Object.isFrozen(value.payload.attachment_refs), true);
  assert.throws(() => { value.payload.raw_text = 'changed'; }, TypeError);
  assert.throws(() => value.payload.attachment_refs.push(ref), TypeError);
  input.fill(0);
  assert.equal(value.payload.raw_text, 'retained');
});

test('G08-V13: every envelope field is required and actor/session claims are rejected', () => {
  for (const field of Object.keys(command())) {
    const candidate = command();
    delete candidate[field];
    rejected(decodeCommand(bytes(candidate)), 'SCHEMA_INVALID');
  }
  for (const field of ['actor', 'actor_id', 'principal', 'principal_id', 'ui_session', 'authorized', 'approved', '__proto__']) {
    const candidate = command();
    Object.defineProperty(candidate, field, { enumerable: true, value: 'self-claimed' });
    rejected(decodeCommand(bytes(candidate)), 'SCHEMA_INVALID');
  }
});

test('G08-V13: all payload fields are required, including explicit null comments', () => {
  const baseline = outcome();
  for (const field of Object.keys(baseline.payload)) {
    const candidate = structuredClone(baseline);
    delete candidate.payload[field];
    rejected(decodeCommand(bytes(candidate)), 'SCHEMA_INVALID');
  }
  for (const field of ['actor', 'principal_id', 'script', 'tool', 'approved', 'apply_directly', 'settings']) {
    const candidate = outcome();
    candidate.payload[field] = true;
    rejected(decodeCommand(bytes(candidate)), 'SCHEMA_INVALID');
  }
});

for (const value of oracle.invalid_revisions) {
  test(`wire revision rejects ${JSON.stringify(value)}`, () => {
    const candidate = command(); candidate.expected_revision = value;
    rejected(decodeCommand(bytes(candidate)), 'SCHEMA_INVALID');
  });
}
test('G08-V16: the decoded adjacent revisions and fingerprints remain distinct', () => {
  const first = command(); first.expected_revision = '9007199254740992';
  const next = command(); next.expected_revision = '9007199254740993';
  const firstResult = decodeCommand(bytes(first)); const nextResult = decodeCommand(bytes(next));
  assert.equal(accepted(firstResult).expected_revision, '9007199254740992');
  assert.equal(accepted(nextResult).expected_revision, '9007199254740993');
  assert.notEqual(firstResult.digest, nextResult.digest);
});

test('UUID syntax is exact, lowercase and not silently repaired', () => {
  for (const value of ['ABCDEF00-0000-0000-0000-000000000000', ref + '\n', ref + ' ', ref.slice(1), 1, null]) {
    const candidate = command(); candidate.target_id = value;
    rejected(decodeCommand(bytes(candidate)), 'SCHEMA_INVALID');
  }
  const zero = command(); zero.target_id = '00000000-0000-0000-0000-000000000000';
  accepted(decodeCommand(bytes(zero)));
});

test('approval digests require exactly 64 lowercase hex digits', () => {
  for (const value of ['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'a'.repeat(64) + '\n', 'g'.repeat(64), null]) {
    rejected(decodeCommand(bytes(command('approval.decide', { action_digest: value, choice: 'approve', comment: null, explanation_revision: '1' }))), 'SCHEMA_INVALID');
  }
});

test('Outcome Acceptance and ActionApproval choices cannot substitute for each other', () => {
  const candidate = outcome(); candidate.payload.choice = 'approve';
  rejected(decodeCommand(bytes(candidate)), 'SCHEMA_INVALID');
  rejected(decodeCommand(bytes(command('approval.decide', { action_digest: 'a'.repeat(64), choice: 'accepted', comment: null, explanation_revision: '1' }))), 'SCHEMA_INVALID');
});

for (const operation of oracle.unknown_operations) {
  test(`OP5-F26 partial: unregistered or deferred operation ${operation} is rejected`, () => {
    const candidate = command(); candidate.command_type = operation;
    rejected(decodeCommand(bytes(candidate)), 'SCHEMA_INVALID');
  });
}
test('unknown operation hidden under a dialogue label is not a control bypass', () => {
  const candidate = conversation();
  candidate.payload.tool = { kind: 'dialogue', command: 'shell', args: ['ignored'] };
  rejected(decodeCommand(bytes(candidate)), 'SCHEMA_INVALID');
});

test('G08-V13: attachment limit is 32 references and every item has the reference shape', () => {
  const atLimit = conversation(); atLimit.payload.attachment_refs = Array(32).fill(ref);
  accepted(decodeCommand(bytes(atLimit)));
  const tooMany = conversation(); tooMany.payload.attachment_refs = Array(33).fill(ref);
  rejected(decodeCommand(bytes(tooMany)), 'SCHEMA_INVALID');
  const objectRef = conversation(); objectRef.payload.attachment_refs = [{ id: ref, principal: ref }];
  rejected(decodeCommand(bytes(objectRef)), 'SCHEMA_INVALID');
});

test('G08-V13: raw text respects UTF-8 bytes at ASCII, multibyte and supplementary boundaries', () => {
  for (const text of ['x'.repeat(65536), 'é'.repeat(32768), '😀'.repeat(16384)]) {
    assert.equal(accepted(decodeCommand(bytes(conversation(text)))).payload.raw_text, text);
    rejected(decodeCommand(bytes(conversation(text + 'x'))));
  }
  rejected(decodeCommand(bytes(conversation('é'.repeat(32769)))), 'TEXT_BYTE_LIMIT');
});
test('G08-V13: comment respects UTF-8 bytes and explicit empty/null values', () => {
  for (const text of [null, '', 'x'.repeat(16384), 'é'.repeat(8192), '😀'.repeat(4096)]) {
    assert.equal(accepted(decodeCommand(bytes(outcome(text)))).payload.comment, text);
  }
  rejected(decodeCommand(bytes(outcome('é'.repeat(8193)))), 'TEXT_BYTE_LIMIT');
});

test('strict JSON preprocessing applies to the public Command decoder', () => {
  const text = JSON.stringify(command());
  rejected(decodeCommand(bytes(text.replace('"protocol_version":1', '"protocol_version":1,"protocol_version":1'))), 'DUPLICATE_KEY');
  rejected(decodeCommand(bytes(text.slice(0, -1) + ',}')), 'INVALID_JSON');
  rejected(decodeCommand(bytes(text + ' '.repeat(262144))), 'BYTE_LIMIT');
  rejected(decodeCommand(command()), 'INVALID_INPUT');
});

test('scope and application controls use the closed packet enums', () => {
  for (const scope of ['principal', 'conversation', 'mission', 'control_operation']) {
    for (const choice of ['pause', 'resume', 'close']) accepted(decodeCommand(bytes(command('scope.control', { scope, choice, comment: null }))));
  }
  for (const choice of ['quiesce', 'recover_readonly', 'halt_dispatch', 'resume_dispatch']) {
    accepted(decodeCommand(bytes(command('application.control', { choice, comment: null }))));
  }
  rejected(decodeCommand(bytes(command('scope.control', { scope: 'other_application', choice: 'pause', comment: null }))), 'SCHEMA_INVALID');
  rejected(decodeCommand(bytes(command('application.control', { choice: 'resume_all_expired_grants', comment: null }))), 'SCHEMA_INVALID');
});
