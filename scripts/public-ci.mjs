import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// This profile never installs the local privileged protocol or runs a VM helper.
// Keep the main npm test/verify profile unchanged, including these test files.
export const notRun = Object.freeze([
  { path: 'tests/host/native-pipe.test.mjs', reason: 'requires-installed-protected-native-protocol' },
  { path: 'tests/host/native-prepared-pipe.test.mjs', reason: 'requires-installed-protected-native-protocol' },
  { path: 'tests/host/native-preparation.test.mjs', reason: 'pins-private-machine-specific-guest-helper-source' },
  { path: 'tests/core/runner-package.test.mjs', reason: 'requires-private-machine-specific-fixed-guest-assets' },
]);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw Error('PUBLIC_CI_NO_ARGUMENTS');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const paths = [];
  for (const dir of ['tests/contracts','tests/ledger','tests/core','tests/host']) {
    for (const name of await readdir(resolve(root, dir))) if (name.endsWith('.test.mjs')) paths.push(`${dir}/${name}`);
  }
  if (notRun.some(entry => !paths.includes(entry.path))) throw Error('PUBLIC_CI_EXCLUSION_DRIFT');
  const tests = paths.filter(path => !notRun.some(entry => entry.path === path)).sort();
  if (!tests.length) throw Error('PUBLIC_CI_EMPTY');
  console.log(JSON.stringify({ format: 'orgmanage-public-ci-scope-v1', testFiles: tests, notRun, productAcceptance: false }));
  const child = spawn(process.execPath, ['--test', ...tests], { cwd: root, stdio: 'inherit', windowsHide: true });
  child.on('error', () => { console.error('PUBLIC_CI_SPAWN_FAILED'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code === 0 ? 0 : 1; });
}
