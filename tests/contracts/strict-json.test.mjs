import test from 'node:test';
import assert from 'node:assert/strict';
import { strictJson, WIRE_LIMITS } from '../../dist/contracts/src/index.js';
import { oracle, bytes, rejected, accepted } from './fixtures/helpers.mjs';

test('G08-V13: the approved packet byte/depth limits are explicit', () => {
  assert.deepEqual(WIRE_LIMITS, { maxBytes: 262144, maxDepth: 16, rawTextBytes: 65536, commentBytes: 16384 });
});

test('JSON accepts scalar values, CRLF whitespace, escaped punctuation and separate object key scopes', () => {
  for (const text of ['null', 'true', 'false', '1', '"text"', '[]', '{}', '\r\n { "x": [1, "{}[]\\\""], "y": {"x":2} } \t', '[{"a":1},{"a":2}]']) {
    assert.deepEqual(accepted(strictJson(bytes(text))), JSON.parse(text));
  }
});

for (const text of oracle.invalid_json) {
  test(`G08-V13: rejects invalid JSON ${JSON.stringify(text)}`, () => rejected(strictJson(bytes(text)), 'INVALID_JSON'));
}
for (const text of oracle.duplicate_json) {
  test(`G08-V13: rejects duplicate decoded property ${text}`, () => rejected(strictJson(bytes(text)), 'DUPLICATE_KEY'));
}
for (const sequence of oracle.invalid_utf8_bytes) {
  test(`invalid UTF-8 is never silently replaced: ${sequence.join(',')}`, () => rejected(strictJson(Uint8Array.from(sequence)), 'INVALID_UTF8'));
}

test('UTF-8 BOM is rejected, rather than silently stripped', () => {
  rejected(strictJson(Buffer.concat([Buffer.from([239, 187, 191]), bytes('{}')])), 'INVALID_JSON');
});

test('JCS boundary rejects lone surrogate values and property names', () => {
  for (const text of ['"\\ud800"', '"\\udc00"', '{"\\ud800":1}', '{"text":"x\\udc00y"}']) {
    rejected(strictJson(bytes(text)), 'INVALID_UNICODE');
  }
  assert.equal(accepted(strictJson(bytes('"\\ud83d\\ude00"'))), '😀');
});

test('container depth counts root as one, accepting sixteen and rejecting seventeen', () => {
  accepted(strictJson(bytes('['.repeat(16) + '0' + ']'.repeat(16))));
  rejected(strictJson(bytes('['.repeat(17) + '0' + ']'.repeat(17))), 'DEPTH_LIMIT');
  accepted(strictJson(bytes('{"x":'.repeat(16) + '0' + '}'.repeat(16))));
  rejected(strictJson(bytes('{"x":'.repeat(17) + '0' + '}'.repeat(17))), 'DEPTH_LIMIT');
});

test('a nesting bomb is rejected without entering recursive parsing', () => {
  rejected(strictJson(bytes('['.repeat(50000) + '0' + ']'.repeat(50000))), 'DEPTH_LIMIT');
});

test('G08-V13: total input bytes include trailing whitespace and reject rather than truncate', () => {
  accepted(strictJson(bytes('[]' + ' '.repeat(262142))));
  rejected(strictJson(bytes('[]' + ' '.repeat(262143))), 'BYTE_LIMIT');
});

test('escaped braces and brackets inside a string do not count as containers', () => {
  assert.equal(accepted(strictJson(bytes(JSON.stringify('[]{}"'.repeat(200))))), '[]{}"'.repeat(200));
});

test('the wire parser accepts bytes only, including a Uint8Array view with an offset', () => {
  for (const value of ['{}', {}, null, [], new ArrayBuffer(4)]) rejected(strictJson(value), 'INVALID_INPUT');
  const buffer = bytes('xx{}yy');
  assert.deepEqual(accepted(strictJson(new Uint8Array(buffer.buffer, buffer.byteOffset + 2, 2))), {});
});

test('untrusted property names do not mutate the object prototype', () => {
  const result = accepted(strictJson(bytes('{"__proto__":{"orgmanageInjected":true}}')));
  assert.equal(Object.hasOwn(result, '__proto__'), true);
  assert.equal({}.orgmanageInjected, undefined);
});
