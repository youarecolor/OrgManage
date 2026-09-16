import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

export const oracle = JSON.parse(readFileSync(new URL('./wire-oracle.json', import.meta.url), 'utf8'));
export const { command: commandId, target: targetId, reference: ref } = oracle.ids;
export const bytes = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
export const command = (command_type = 'mission.start', payload = { brief_revision: ref, contract_revision: ref }) => ({
  protocol_version: 1, command_id: commandId, command_type, target_id: targetId, expected_revision: '1', payload,
});
export const conversation = (raw_text = '') => command('conversation.post', {
  message_id: ref, raw_text, attachment_refs: [], relation_hint: 'unspecified',
});
export const outcome = (comment = null) => command('outcome.decide', {
  artifact_revision_id: ref, choice: 'accepted', comment, explanation_revision: '1',
});
export function rejected(result, expectedCode) {
  assert.equal(result.ok, false, 'input must be rejected');
  assert.equal(typeof result.error?.code, 'string');
  if (expectedCode) assert.equal(result.error.code, expectedCode);
  assert.equal(Object.hasOwn(result, 'value'), false, 'rejection must not expose an accepted value');
  assert.equal(Object.hasOwn(result, 'digest'), false, 'rejection must not expose a content fingerprint');
}
export function accepted(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}
