import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRevision, formatRevision } from '../../dist/contracts/src/index.js';
import { oracle } from './fixtures/helpers.mjs';

for (const value of oracle.valid_revisions) {
  test(`G08-V16: decimal revision round trip ${value}`, () => {
    assert.equal(parseRevision(value), BigInt(value));
    assert.equal(formatRevision(parseRevision(value)), value);
  });
}
for (const value of oracle.invalid_revisions) {
  test(`G08-V13: revision rejects coercion/noncanonical spelling ${JSON.stringify(value)}`, () => {
    assert.throws(() => parseRevision(value), RangeError);
  });
}
test('G08-V16: adjacent values above Number safe range remain distinct', () => {
  const first = parseRevision('9007199254740992');
  const next = parseRevision('9007199254740993');
  assert.notEqual(first, next);
  assert.equal(next - first, 1n);
});
test('formatting validates positive 18-digit range and requires a bigint', () => {
  for (const value of [0n, -1n, 1000000000000000000n, 1, '1', null]) {
    assert.throws(() => formatRevision(value), RangeError);
  }
});
