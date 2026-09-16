import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function probe(mode) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/schema-loader-probe.mjs', import.meta.url)), mode], {
    encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  assert.equal(result.error, undefined, 'trusted test child must execute');
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('the runtime validator starts with the exact schemas bound to its generated declarations', () => {
  assert.deepEqual(probe('clean'), { loaded: true, tampered: false });
});
test('RESP-V06: post-build schema change fails closed before the validator is published', () => {
  const result = probe('tampered');
  assert.equal(result.tampered, true, 'the test must intercept the schema loader');
  assert.equal(result.loaded, false, 'changed schema must not publish a validator with stale TS types');
  assert.match(result.error, /schema/i);
  assert.match(result.error, /digest|hash|mismatch/i);
});
