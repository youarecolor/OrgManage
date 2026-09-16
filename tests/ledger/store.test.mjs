import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile, link } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { LedgerStore, LedgerIntegrityError, LedgerOwnerError, LedgerBusyError, RevisionConflictError, MAX_REVISION } from '../../dist/ledger/src/index.js';

const base = resolve('.private/test-runs');
await mkdir(base, { recursive: true });
const run = await mkdtemp(join(base, 'ledger-'));
let serial = 0;
const dbPath = () => join(run, `case-${++serial}.sqlite`);
const principal = () => ({ id: randomUUID(), kind: 'person', displayName: 'Synthetic owner' });
const record = (p, kind = 'mission', revision = 1n) => ({ principalId: p.id, id: randomUUID(), kind, revision, data: '{"status":"draft"}' });
const appScope = () => ({ id: randomUUID(), principalId: null, kind: 'application', parentId: null, revision: 1n, epoch: 1n, state: 'active' });
const childScope = (p, parent, kind = 'principal') => ({ id: randomUUID(), principalId: p.id, kind, parentId: parent.id, revision: 1n, epoch: 1n, state: 'active' });
async function fixture(t) { const path = dbPath(); const store = await LedgerStore.open(path); t.after(() => store.close()); return { path, store }; }
function raw(path) { return new DatabaseSync(path, { enableForeignKeyConstraints: true, readBigInts: true, allowExtension: false }); }

test('a new physical schema has no business Principal or synthetic setup receipt', async t => {
  const { store } = await fixture(t);
  assert.deepEqual(store.read(tx => tx.listPrincipal()), []);
  assert.equal(store.read(tx => tx.getMeta('initialized')), undefined);
  assert.equal(store.ownerEpoch, 1n);
});

test('transaction atomically persists Principal, owner, scope, receipt and audit across close/reopen', async t => {
  const { path, store } = await fixture(t); const p = principal(); const actorId = randomUUID(); const app = appScope(); const ps = childScope(p, app); const commandId = randomUUID();
  store.transaction(tx => {
    tx.insertPrincipal(p); tx.putMembership({ principalId: p.id, actorId, role: 'owner', generation: 1n });
    tx.insertScope(app); tx.insertScope(ps);
    tx.insertCommand({ principalId: p.id, commandId, actorId, digest: 'a'.repeat(64), receipt: '{"status":"committed"}' });
    assert.equal(tx.appendAudit({ principalId: p.id, commandId, kind: 'setup', entityId: ps.id, createdAt: '2026-09-12T00:00:00.000Z' }), 1n);
    tx.setMeta('initialized', p.id);
  });
  await store.close(); const reopened = await LedgerStore.open(path); t.after(() => reopened.close());
  assert.equal(reopened.ownerEpoch, 2n);
  assert.deepEqual(reopened.read(tx => tx.getPrincipal(p.id)), p);
  assert.equal(reopened.read(tx => tx.getMembership(p.id, actorId)).role, 'owner');
  assert.equal(reopened.read(tx => tx.getMeta('initialized')), p.id);
  assert.equal(reopened.read(tx => tx.getCommand(p.id, commandId)).receipt, '{"status":"committed"}');
  assert.equal(reopened.read(tx => tx.listAudit(p.id)).length, 1);
});

test('exception rolls back every business row and receipt in the transaction', async t => {
  const { store } = await fixture(t); const p = principal();
  assert.throws(() => store.transaction(tx => { tx.insertPrincipal(p); tx.setMeta('initialized', p.id); throw new Error('synthetic crash before commit'); }), /synthetic crash/);
  assert.deepEqual(store.read(tx => tx.listPrincipal()), []);
  assert.equal(store.read(tx => tx.getMeta('initialized')), undefined);
});

test('business rejection identity survives rollback without becoming a DB error', async t => {
  const { store } = await fixture(t); const rejection = new Error('synthetic core policy denial');
  try { store.transaction(tx => { tx.insertPrincipal(principal()); throw rejection; }); assert.fail('expected rejection'); }
  catch (error) { assert.equal(error, rejection); }
  assert.deepEqual(store.read(tx => tx.listPrincipal()), []);
});

test('audit can precede its command receipt within the same committed transaction', async t => {
  const { store } = await fixture(t); const p = principal(); const actorId = randomUUID(); const commandId = randomUUID();
  store.transaction(tx => {
    tx.insertPrincipal(p);
    tx.appendAudit({ principalId: p.id, commandId, kind: 'setup', entityId: null, createdAt: '2026-09-12T00:00:00.000Z' });
    tx.insertCommand({ principalId: p.id, commandId, actorId, digest: 'a'.repeat(64), receipt: '{}' });
  });
  assert.equal(store.read(tx => tx.listAudit(p.id)).length, 1);
});

test('lowercase UUID shape follows the wire codec without adding version/variant restrictions', async t => {
  const { store } = await fixture(t); const p = { ...principal(), id: '00000000-0000-0000-0000-000000000000' };
  store.transaction(tx => tx.insertPrincipal(p)); assert.deepEqual(store.read(tx => tx.getPrincipal(p.id)), p);
});

test('Promise/thenable callbacks reject and their writes roll back', async t => {
  const { store } = await fixture(t);
  for (const result of [Promise.resolve('bad'), { then() { throw new Error('must not invoke user then'); } }]) {
    assert.throws(() => store.transaction(tx => { tx.insertPrincipal(principal()); return result; }), LedgerIntegrityError);
    assert.deepEqual(store.read(tx => tx.listPrincipal()), []);
  }
  assert.throws(() => store.read(() => Promise.resolve('bad')), LedgerIntegrityError);
});

test('async continuation cannot retain a writable transaction after rollback', async t => {
  const { store } = await fixture(t); let late;
  assert.throws(() => store.transaction(async tx => { await Promise.resolve(); try { tx.insertPrincipal(principal()); } catch (error) { late = error; } }), LedgerIntegrityError);
  await Promise.resolve();
  assert.ok(late instanceof LedgerOwnerError);
  assert.deepEqual(store.read(tx => tx.listPrincipal()), []);
});

test('read callback rejects mutators at runtime and exposes no raw database property', async t => {
  const { store } = await fixture(t);
  assert.equal(store.db, undefined);
  assert.throws(() => store.read(tx => { assert.equal(tx.db, undefined); tx.insertPrincipal(principal()); }), LedgerOwnerError);
  assert.deepEqual(store.read(tx => tx.listPrincipal()), []);
});

test('retained transaction/read access and nested callbacks are rejected', async t => {
  const { store } = await fixture(t); let saved;
  store.transaction(tx => { saved = tx; });
  assert.throws(() => saved.getMeta('initialized'), LedgerOwnerError);
  assert.throws(() => saved.setMeta('initialized', 'bad'), LedgerOwnerError);
  assert.throws(() => store.transaction(() => store.read(() => null)), LedgerOwnerError);
});

test('large adjacent revisions preserve exact bigint values and CAS creates immutable history', async t => {
  const { store } = await fixture(t); const p = principal(); const initial = record(p, 'mission', 9_007_199_254_740_992n);
  store.transaction(tx => { tx.insertPrincipal(p); tx.insertRecord(initial); });
  const first = store.read(tx => tx.getRecord(p.id, initial.id));
  store.transaction(tx => tx.updateRecord({ ...first, revision: 9_007_199_254_740_993n, data: '{"status":"ready"}' }, first.revision));
  const second = store.read(tx => tx.getRecord(p.id, initial.id));
  assert.equal(first.revision, 9_007_199_254_740_992n); assert.equal(second.revision, 9_007_199_254_740_993n);
  assert.notEqual(first.versionId, second.versionId);
  assert.equal(store.read(tx => tx.getRecordVersion(p.id, first.versionId)).data, initial.data);
  assert.deepEqual(store.read(tx => tx.getRecordHistory(p.id, initial.id)).map(r => r.revision), [9_007_199_254_740_992n, 9_007_199_254_740_993n]);
  assert.throws(() => store.transaction(tx => tx.updateRecord({ ...second, revision: first.revision + 1n }, first.revision)), RevisionConflictError);
  assert.equal(store.read(tx => tx.getRecordHistory(p.id, initial.id)).length, 2);
});

test('zero, Number, over-18-digit revisions fail without coercion', async t => {
  const { store } = await fixture(t); const p = principal(); store.transaction(tx => tx.insertPrincipal(p));
  for (const value of [0n, -1n, 1, MAX_REVISION + 1n]) assert.throws(() => store.transaction(tx => tx.insertRecord(record(p, 'mission', value))), LedgerIntegrityError);
  store.transaction(tx => tx.insertRecord(record(p, 'mission', MAX_REVISION)));
  assert.equal(store.read(tx => tx.listRecord(p.id)).length, 1);
});

test('immutable brief/contract/artifact/evidence require new identity', async t => {
  const { store } = await fixture(t); const p = principal(); store.transaction(tx => tx.insertPrincipal(p));
  for (const kind of ['brief', 'contract', 'artifact', 'evidence']) {
    const r = record(p, kind); store.transaction(tx => tx.insertRecord(r));
    assert.throws(() => store.transaction(tx => tx.updateRecord({ ...r, revision: 2n }, 1n)), LedgerIntegrityError);
    assert.equal(store.read(tx => tx.getRecordHistory(p.id, r.id)).length, 1);
  }
});

test('membership generation is monotonic and same generation cannot silently change role', async t => {
  const { store } = await fixture(t); const p = principal(); const actorId = randomUUID();
  store.transaction(tx => { tx.insertPrincipal(p); tx.putMembership({ principalId: p.id, actorId, role: 'owner', generation: 2n }); });
  assert.throws(() => store.transaction(tx => tx.putMembership({ principalId: p.id, actorId, role: 'revoked', generation: 2n })), RevisionConflictError);
  store.transaction(tx => tx.putMembership({ principalId: p.id, actorId, role: 'revoked', generation: 3n }));
  assert.equal(store.read(tx => tx.getMembership(p.id, actorId)).role, 'revoked');
});

test('same-Principal scope ancestry enforced and closed scope cannot resume', async t => {
  const { store } = await fixture(t); const a = principal(); const b = principal(); const app = appScope(); const ps = childScope(a, app); const mission = childScope(a, ps, 'mission');
  store.transaction(tx => { tx.insertPrincipal(a); tx.insertPrincipal(b); tx.insertScope(app); tx.insertScope(ps); tx.insertScope(mission); });
  assert.throws(() => store.transaction(tx => tx.insertScope(childScope(b, ps, 'mission'))), LedgerIntegrityError);
  store.transaction(tx => tx.updateScope({ ...mission, state: 'closed', revision: 2n, epoch: 2n }, 1n));
  assert.throws(() => store.transaction(tx => tx.updateScope({ ...mission, state: 'active', revision: 3n, epoch: 3n }, 2n)), LedgerIntegrityError);
  assert.equal(store.read(tx => tx.getScope(mission.id)).state, 'closed');
});

test('missing Principal and mismatched audit command foreign keys reject', async t => {
  const { store } = await fixture(t); const a = principal(); const b = principal(); const actorId = randomUUID(); const commandId = randomUUID();
  assert.throws(() => store.transaction(tx => tx.insertRecord(record(a))), LedgerIntegrityError);
  store.transaction(tx => { tx.insertPrincipal(a); tx.insertPrincipal(b); tx.insertCommand({ principalId: a.id, commandId, actorId, digest: 'a'.repeat(64), receipt: '{}' }); });
  assert.throws(() => store.transaction(tx => tx.appendAudit({ principalId: b.id, commandId, kind: 'fake', entityId: null, createdAt: '2026-09-12T00:00:00.000Z' })), LedgerIntegrityError);
});

test('approval binding requires same Principal, approval kind and matching digest', async t => {
  const { store } = await fixture(t); const a = principal(); const b = principal(); const approval = record(a, 'approval'); const intent = record(a, 'intent'); const other = record(b, 'intent'); const wrongKind = record(a, 'mission');
  store.transaction(tx => { tx.insertPrincipal(a); tx.insertPrincipal(b); for (const r of [approval, intent, other, wrongKind]) tx.insertRecord(r); tx.registerApprovalBinding(a.id, approval.id, 'a'.repeat(64)); });
  assert.throws(() => store.transaction(tx => tx.registerApprovalBinding(a.id, wrongKind.id, 'a'.repeat(64))), LedgerIntegrityError);
  assert.throws(() => store.transaction(tx => tx.bindIntentApproval(a.id, intent.id, approval.id, 'b'.repeat(64))), LedgerIntegrityError);
  assert.throws(() => store.transaction(tx => tx.bindIntentApproval(b.id, other.id, approval.id, 'a'.repeat(64))), LedgerIntegrityError);
  store.transaction(tx => tx.bindIntentApproval(a.id, intent.id, approval.id, 'a'.repeat(64)));
});

test('DB itself rejects a head pointing to another subject/kind/revision, and overwriting old content', async t => {
  const { path, store } = await fixture(t); const p = principal(); const a = record(p); const b = record(p, 'approval');
  store.transaction(tx => { tx.insertPrincipal(p); tx.insertRecord(a); tx.insertRecord(b); });
  const old = store.read(tx => tx.getRecord(p.id, a.id)); const other = store.read(tx => tx.getRecord(p.id, b.id)); await store.close();
  const db = raw(path); t.after(() => db.close());
  assert.throws(() => db.prepare('UPDATE record_heads SET current_version_id=? WHERE principal_id=? AND id=?').run(other.versionId, p.id, a.id), /FOREIGN KEY/);
  assert.throws(() => db.prepare('UPDATE record_heads SET revision=2 WHERE principal_id=? AND id=?').run(p.id, a.id), /FOREIGN KEY/);
  assert.throws(() => db.prepare("UPDATE record_versions SET data='{}' WHERE principal_id=? AND version_id=?").run(p.id, old.versionId), /immutable/);
});

test('same process cannot acquire another writer, including Windows case aliases; release permits reopen', async t => {
  const { path, store } = await fixture(t);
  await assert.rejects(LedgerStore.open(path), LedgerOwnerError);
  if (process.platform === 'win32') await assert.rejects(LedgerStore.open(path.toUpperCase()), LedgerOwnerError);
  await store.close(); const next = await LedgerStore.open(path); await next.close();
});

test('a second OS process cannot acquire the live owner even with another owner UUID', async t => {
  const { path } = await fixture(t);
  const moduleUrl = pathToFileURL(resolve('dist/ledger/src/index.js')).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import {LedgerStore} from ${JSON.stringify(moduleUrl)}; try {const s=await LedgerStore.open(${JSON.stringify(path)}); await s.close();process.exitCode=4;} catch(e){process.stdout.write(e.name);process.exitCode=e.name==='LedgerOwnerError'?0:5;}`], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(child.error, undefined); assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, 'LedgerOwnerError');
});

test('unknown SQLite, existing empty file and corrupt file fail closed without reinitializing', async () => {
  const unknown = dbPath(); const db = raw(unknown); db.exec('CREATE TABLE foreign_data(value TEXT); INSERT INTO foreign_data VALUES(\'keep\')'); db.close();
  const empty = dbPath(); await writeFile(empty, ''); const corrupt = dbPath(); await writeFile(corrupt, 'not a SQLite database');
  for (const path of [unknown, empty, corrupt]) { const before = await readFile(path); await assert.rejects(LedgerStore.open(path), LedgerIntegrityError); assert.deepEqual(await readFile(path), before); }
});

test('extra/partial schema and stored schema hash mismatch reject reopen', async t => {
  for (const alteration of ["CREATE TABLE unexpected(value TEXT)", "UPDATE meta SET value='tampered' WHERE key='_store.schema_hash'", 'DROP TRIGGER immutable_record_update']) {
    const { path, store } = await fixture(t); await store.close(); const db = raw(path); db.exec(alteration); db.close(); await assert.rejects(LedgerStore.open(path), LedgerIntegrityError);
  }
});

test('hard-link aliases are refused rather than taking an independent writer lock', async t => {
  const { path, store } = await fixture(t); await store.close(); const alias = dbPath(); await link(path, alias);
  await assert.rejects(LedgerStore.open(alias), LedgerIntegrityError);
  await assert.rejects(LedgerStore.open(path), LedgerIntegrityError);
});

test('persisted owner mismatch refuses subsequent read and write transaction', async t => {
  const { path, store } = await fixture(t); const db = raw(path);
  db.prepare("UPDATE meta SET value=? WHERE key='_store.owner_id'").run(randomUUID()); db.close();
  assert.throws(() => store.read(tx => tx.listPrincipal()), LedgerOwnerError);
  assert.throws(() => store.transaction(tx => tx.insertPrincipal(principal())), LedgerOwnerError);
});

test('reserved owner/schema metadata cannot be rewritten through trusted transaction API', async t => {
  const { store } = await fixture(t);
  for (const key of ['_store.owner_id', '_store.owner_epoch', '_store.schema_hash']) assert.throws(() => store.transaction(tx => tx.setMeta(key, 'tamper')), LedgerIntegrityError);
});

test('unclean process exit rolls back an open transaction and releases the OS owner', async t => {
  const path = dbPath(); const p = principal(); const moduleUrl = pathToFileURL(resolve('dist/ledger/src/index.js')).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import {LedgerStore} from ${JSON.stringify(moduleUrl)};const s=await LedgerStore.open(${JSON.stringify(path)});s.transaction(tx=>{tx.insertPrincipal(${JSON.stringify(p)});tx.setMeta('partial','must roll back');process.exit(23);});`], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(child.error, undefined); assert.equal(child.status, 23, child.stderr);
  const store = await LedgerStore.open(path); t.after(() => store.close());
  assert.deepEqual(store.read(tx => tx.listPrincipal()), []); assert.equal(store.read(tx => tx.getMeta('partial')), undefined);
});

test('committed WAL data survives process exit without explicit close', async t => {
  const path = dbPath(); const p = principal(); const moduleUrl = pathToFileURL(resolve('dist/ledger/src/index.js')).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import {LedgerStore} from ${JSON.stringify(moduleUrl)};const s=await LedgerStore.open(${JSON.stringify(path)});s.transaction(tx=>{tx.insertPrincipal(${JSON.stringify(p)});tx.setMeta('committed','retained');});process.exit(23);`], { encoding: 'utf8', timeout: 15000, windowsHide: true });
  assert.equal(child.error, undefined); assert.equal(child.status, 23, child.stderr);
  const store = await LedgerStore.open(path); t.after(() => store.close());
  assert.deepEqual(store.read(tx => tx.getPrincipal(p.id)), p); assert.equal(store.read(tx => tx.getMeta('committed')), 'retained');
});

test('noncooperating SQLite writer yields a bounded busy failure without partial data', async t => {
  const { path, store } = await fixture(t); const db = raw(path); t.after(() => db.close());
  db.exec('BEGIN IMMEDIATE');
  try { assert.throws(() => store.transaction(tx => tx.insertPrincipal(principal())), LedgerBusyError); }
  finally { db.exec('ROLLBACK'); }
  assert.deepEqual(store.read(tx => tx.listPrincipal()), []);
});
