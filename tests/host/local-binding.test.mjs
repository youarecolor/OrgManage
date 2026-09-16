import test from 'node:test';
import assert from 'node:assert/strict';
import {cp, mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve, join} from 'node:path';

test('source-only copy loads normally but cannot use the private native VM binding', async () => {
  const base = resolve('.private/test-runs');
  await mkdir(base, {recursive:true});
  const root = await mkdtemp(join(base, 'source-only-binding-'));
  await cp(resolve('dist'), join(root, 'dist'), {recursive:true});
  await cp(resolve('packages/contracts/schema'), join(root, 'packages/contracts/schema'), {recursive:true});
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n', {flag:'wx'});
  const host = await import(pathToFileURL(join(root, 'dist/host/src/native-preparation.js')).href);
  const runner = await import(pathToFileURL(join(root, 'dist/runner/src/fixed-guest-port.js')).href);
  assert.equal(typeof host.ZERO_TOOL_PROFILE.profile, 'string');
  assert.throws(() => host.ZERO_TOOL_PROFILE.vm, {message:'LOCAL_NATIVE_BINDING_UNAVAILABLE'});
  assert.throws(() => runner.fixedGuestProfile('11111111-1111-4111-8111-111111111111'), {message:'LOCAL_NATIVE_BINDING_UNAVAILABLE'});
  assert.throws(() => runner.renderFixedGuestPackage({}, 'start'), {message:'LOCAL_NATIVE_BINDING_UNAVAILABLE'});
  await mkdir(join(root,'.private/local-bindings'), {recursive:true});
  const forged=JSON.stringify({format:'orgmanage-local-native-binding-v1',vmId:'11111111-1111-4111-8111-111111111111'})+'\n';
  await writeFile(join(root,'.private/local-bindings/fixed-environment.json'),forged,{flag:'wx'});
  assert.throws(() => host.ZERO_TOOL_PROFILE.vm, {message:'LOCAL_NATIVE_BINDING_UNAVAILABLE'});
  assert.throws(() => runner.fixedGuestProfile('11111111-1111-4111-8111-111111111111'), {message:'LOCAL_NATIVE_BINDING_UNAVAILABLE'});
});
