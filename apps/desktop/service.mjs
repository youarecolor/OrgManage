import { randomUUID, createHash } from 'node:crypto';
import { realpath, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { OrgManageCore } from '../../dist/core/src/index.js';
import { LocalFakeDispatcher } from '../../dist/core/src/local-dispatcher.js';
import { LedgerStore } from '../../dist/ledger/src/index.js';

const port = process.parentPort;
if (!port || process.type !== 'utility') throw new Error('OrgManage service requires an Electron utility process');
const project = fileURLToPath(new URL('../../', import.meta.url));
const stateRoot = resolve(project, '.private/local-state/desktop-p02');
const methods = new Set(['snapshot', 'setup', 'command', 'shutdown']);
const failure = code => ({ ok: false, error: { code, retry: 'none' } });
let initializing = false, core = null, store = null, session = null, faulted = false, closing = false, timer = null;
let dispatchLatched = false, stopRecorded = false, databaseClosed = false, leaseDeadline = 0, heartbeatSequence = 0n;
let dispatcher = null;

function exact(value, names) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}
function under(root, target) {
  const rel = relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function send(value) { try { port.postMessage(value); } catch { /* Parent silence expires the local dispatch lease. */ } }
function recordStop() {
  if (!core || !store || databaseClosed) return false;
  const snapshot = core.snapshot(session);
  if ('ok' in snapshot) return false;
  if (!snapshot.application || snapshot.application.state !== 'active') return true;
  const result = core.command(session, Buffer.from(JSON.stringify({
    protocol_version: 1, command_id: randomUUID(), command_type: 'application.control',
    target_id: snapshot.application.id, expected_revision: snapshot.application.revision,
    payload: { choice: 'halt_dispatch', comment: null },
  })));
  return result.ok && result.receipt.disposition === 'committed';
}
function quiesce(reason, requestId = null) {
  dispatchLatched = true;
  if (timer) clearInterval(timer);
  try { stopRecorded = stopRecorded || recordStop(); } catch { /* A local latch is not a durable stop receipt. */ }
  send({ version: 1, type: 'quiesced', requestId, reason, dispatchLatched: true, stopRecorded });
}
function fault() {
  faulted = true;
  quiesce('service_fault');
  send({ version: 1, type: 'fault', code: 'RECOVERY_REQUIRED' });
}
function leaseIsCurrent() {
  // Pure: this function is also called immediately before the Core's TX2 write.
  return !dispatchLatched && !faulted && !closing && Boolean(core) && performance.now() < leaseDeadline;
}
function leaseAllowsDispatch() {
  if (leaseIsCurrent()) return true;
  if (!dispatchLatched && !faulted && !closing && core && performance.now() >= leaseDeadline) quiesce('lease_expired');
  return false;
}
function pump() {
  if (!core || !store || !leaseAllowsDispatch()) return;
  try {
    if (dispatcher.tick(leaseIsCurrent).status === 'recovery_required') fault();
    // Persist the stop outside any Store callback if the lease expired during TX2.
    else leaseAllowsDispatch();
  } catch { fault(); }
}

async function initialize(message) {
  if (initializing || core || faulted || !exact(message, ['version', 'type', 'databasePath', 'actorId'])
    || message.version !== 1 || message.type !== 'init'
    || typeof message.actorId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(message.actorId)
    || typeof message.databasePath !== 'string' || !isAbsolute(message.databasePath)) throw new Error('Invalid service initialization');
  initializing = true;
  const root = await realpath(stateRoot), parent = await realpath(dirname(message.databasePath));
  // One fixed, existing real-candidate ledger for the trusted human review entry.
  // No arbitrary alternate database roots or renderer-selected paths are accepted.
  const nativeReviewPath = resolve(project, '.private/reviews/20260914-native-home-edit/v3/candidate/ledger.sqlite');
  const nativeReview = message.databasePath === nativeReviewPath && await realpath(message.databasePath) === nativeReviewPath;
  const coreReviewPath=resolve(project,'.private/reviews/20260914-native-core-dispatch/ledger.sqlite');
  const coreReview=message.databasePath===coreReviewPath&&await realpath(message.databasePath)===coreReviewPath;
  // The fixed pilot was created with a ledger-local actor UUID. Map only the
  // same verified Windows owner to that existing identity, never renderer input.
  let reviewBinding=null;
  if(coreReview){
    // Personal pilot identities stay outside distributable source. This is still
    // the exact existing binding, not a configurable impersonation mechanism.
    const bytes=await readFile(resolve(project,'.private/local-integrations/core-review-binding.json'));
    if(createHash('sha256').update(bytes).digest('hex')!=='c7be20c651cb69bc5f1323b5394ac82fa29b3b8f5c4838bc183fbcdb50f80264')throw Error('Fixed review binding changed');
    reviewBinding=JSON.parse(bytes.toString('utf8'));
    if(message.actorId!==reviewBinding.windowsActor)throw Error('Fixed review Windows owner required');
  }
  if (!nativeReview && !coreReview && parent !== root && !under(root, parent)) throw new Error('Service database must remain within local desktop state');
  if (resolve(message.databasePath) !== resolve(parent, 'ledger.sqlite')) throw new Error('Fixed ledger filename required');
  store = await LedgerStore.open(message.databasePath);
  try {
    if(coreReview){const owner=store.read(tx=>tx.getMembership(reviewBinding.principal,reviewBinding.ledgerActor));if(owner?.role!=='owner')throw Error('Fixed review owner binding changed');}
    core = new OrgManageCore(store); session = core.openSession(coreReview?reviewBinding.ledgerActor:message.actorId); dispatcher = new LocalFakeDispatcher(core);
  }
  catch (cause) { await store.close(); store = null; throw cause; }
  leaseDeadline = performance.now() + 3000;
  send({ version: 1, type: 'ready', versions: {
    electron: process.versions.electron ?? null, chrome: process.versions.chrome ?? null,
    node: process.versions.node, sqlite: process.versions.sqlite ?? null,
  }, pid: process.pid });
  if (dispatchLatched || faulted) quiesce('service_fault');
  else timer = setInterval(pump, 1000);
}

async function shutdown() {
  closing = true;
  quiesce('shutdown');
  if (!stopRecorded) { closing = false; return failure('STOP_NOT_COMMITTED'); }
  await store.close();
  databaseClosed = true;
  return { ok: true, stopped: true, databaseClosed: true };
}

port.on('message', event => {
  const message = event.data;
  if (message?.type === 'init') { void initialize(message).catch(() => fault()); return; }
  if (message?.type === 'heartbeat') {
    if (!exact(message, ['version', 'type', 'sequence']) || message.version !== 1
      || typeof message.sequence !== 'string' || !/^[1-9][0-9]{0,17}(?![\s\S])/.test(message.sequence)) { fault(); return; }
    if (dispatchLatched || faulted || closing || !core) return;
    if (performance.now() >= leaseDeadline) { quiesce('lease_expired'); return; }
    const sequence = BigInt(message.sequence);
    if (sequence <= heartbeatSequence) { fault(); return; }
    heartbeatSequence = sequence;
    leaseDeadline = performance.now() + 3000;
    return;
  }
  if (message?.type === 'quiesce') {
    if (!exact(message, ['version', 'type', 'requestId', 'reason']) || message.version !== 1 || message.reason !== 'main_fault'
      || typeof message.requestId !== 'string' || !/^[0-9a-f-]{36}(?![\s\S])/.test(message.requestId)) { fault(); return; }
    quiesce('main_fault', message.requestId);
    return;
  }
  if (!exact(message, ['version', 'type', 'id', 'method', 'body']) || message.version !== 1 || message.type !== 'request'
    || typeof message.id !== 'string' || !/^[0-9a-f-]{36}$/.test(message.id) || !methods.has(message.method)) {
    fault(); return;
  }
  const reply = value => send({ version: 1, type: 'reply', id: message.id, value });
  if (!core || !store || databaseClosed || closing) { reply(failure('RECOVERY_REQUIRED')); return; }
  if (message.method === 'shutdown') {
    if (message.body !== null) { reply(failure('INVALID_REQUEST')); return; }
    void shutdown().then(value => {
      reply(value);
      if (value.ok) setImmediate(() => process.exit(0));
      else fault();
    }).catch(() => { closing = false; reply(failure('RECOVERY_REQUIRED')); fault(); });
    return;
  }
  try {
    if (message.method === 'snapshot') {
      reply(message.body === null ? core.snapshot(session) : failure('INVALID_REQUEST'));
      return;
    }
    if (faulted || !leaseAllowsDispatch()) { reply(failure('RECOVERY_REQUIRED')); return; }
    if (typeof message.body !== 'string' || Buffer.byteLength(message.body, 'utf8') > 262_144) { reply(failure('BYTE_LIMIT')); return; }
    const bytes = Buffer.from(message.body, 'utf8');
    reply(message.method === 'setup' ? core.setup(session, bytes) : core.command(session, bytes));
    setImmediate(pump);
  } catch { reply(failure('RECOVERY_REQUIRED')); fault(); }
});
process.on('uncaughtException', () => { fault(); });
process.on('unhandledRejection', () => { fault(); });
