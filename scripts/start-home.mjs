import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLocalHost, windowsActorId } from '../dist/host/src/index.js';

if (process.platform !== 'win32') throw new Error('This local host identity profile is Windows only');
const project = fileURLToPath(new URL('..', import.meta.url));
const identity = execFileSync('C:/Windows/System32/whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
const sid = identity.match(/S-1-[0-9]+(?:-[0-9]+)+/g);
if (sid?.length !== 1) throw new Error('Could not establish trusted host identity');
const databaseDir = resolve(project, '.private/local-state/home-p02');
await mkdir(databaseDir, { recursive: true });
const host = await startLocalHost({ databasePath: resolve(databaseDir, 'ledger.sqlite'), staticRoot: resolve(project, 'dist/home'), actorId: windowsActorId(sid[0]) });
console.log(`OrgManage local fixture (no external provider): ${host.launchUrl}`);
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { if (closing) return; closing = true; await host.close(); process.exit(0); });
