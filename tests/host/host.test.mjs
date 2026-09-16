import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startLocalHost, windowsActorId } from '../../dist/host/src/index.js';

// Independent HTTP oracle: protected session, closed wire inputs, durable receipts,
// read-only snapshots, and the actual local fake command/approval/outcome path.
const TEST_ACTOR = '11111111-1111-4111-8111-111111111111';
const suiteRoot = resolve('.private/test-runs/host');
await mkdir(suiteRoot, { recursive: true });

function call(origin, path, { method = 'GET', headers = {}, body } = {}) {
  const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return new Promise((done, reject) => {
    const req = httpRequest(new URL(path, origin), { method, headers: { ...(payload ? { 'content-length': String(payload.length) } : {}), ...headers } }, res => {
      const chunks = []; let length = 0;
      res.on('data', chunk => { length += chunk.length; if (length > 2_000_000) res.destroy(new Error('Unbounded host response')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json; try { json = JSON.parse(text); } catch { /* Static fixture and redirects are not JSON. */ }
        done({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.setTimeout(8000, () => req.destroy(new Error('HTTP fixture timed out')));
    req.on('error', reject); req.end(payload);
  });
}

async function fixture(t) {
  const directory = await mkdtemp(join(suiteRoot, 'http-'));
  const staticRoot = join(directory, 'static'), databaseDirectory = join(directory, 'db');
  await mkdir(staticRoot); await mkdir(databaseDirectory);
  await writeFile(join(staticRoot, 'index.html'), '<!doctype html><title>OrgManage HTTP fixture</title><main>Trusted static fixture</main>');
  await writeFile(join(staticRoot, 'fixture.js'), 'export const fixture = true;');
  await writeFile(join(staticRoot, 'fixture.css'), 'main { color: black; }');
  await writeFile(join(staticRoot, 'private.txt'), 'must not be served');
  const databasePath = join(databaseDirectory, 'ledger.sqlite');
  const host = await startLocalHost({ databasePath, staticRoot, actorId: TEST_ACTOR, port: 0 });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await host.close(); } };
  t.after(close);
  return { ...host, close, directory, databasePath, cookie: '', csrf: '' };
}

async function login(f) {
  const launch = await call(f.origin, f.launchUrl);
  assert.equal(launch.status, 303); assert.equal(launch.headers.location, '/');
  const setCookie = launch.headers['set-cookie']?.[0]; assert.ok(setCookie);
  assert.match(setCookie, /; HttpOnly(?:;|$)/); assert.match(setCookie, /; SameSite=Strict(?:;|$)/);
  f.cookie = setCookie.split(';')[0];
  const session = await call(f.origin, '/api/session', { headers: { cookie: f.cookie } });
  assert.equal(session.status, 200); assert.match(session.json.csrfToken, /^[A-Za-z0-9_-]{40,}$/);
  f.csrf = session.json.csrfToken;
}
const post = (f, path, body, extra = {}) => call(f.origin, path, {
  method: 'POST', headers: { cookie: f.cookie, origin: f.origin, 'content-type': 'application/json', 'x-orgmanage-csrf': f.csrf, ...extra }, body,
});
const setupBody = () => ({ protocol_version: 1, setup_command_id: randomUUID(), principal: { kind: 'person', display_name: '独立HTTP合成主体' }, owner_binding_candidate: null });
const command = (type, id, revision, payload, commandId = randomUUID()) => ({ protocol_version: 1, command_id: commandId, command_type: type, target_id: id, expected_revision: revision, payload });
function committed(response) {
  assert.equal(response.status, 200, response.text); assert.equal(response.json.ok, true, response.text);
  assert.equal(response.json.receipt.disposition, 'committed', response.text); assert.equal(response.json.receipt.error_code, null);
  assert.equal('event_seq' in response.json.receipt, false); return response.json.receipt;
}
async function snapshot(f) {
  const response = await call(f.origin, '/api/snapshot', { headers: { cookie: f.cookie } });
  assert.equal(response.status, 200, response.text); assert.equal(response.json.status, 'ready', response.text); return response.json;
}
async function ready(t) { const f = await fixture(t); await login(f); committed(await post(f, '/api/setup', setupBody())); return f; }
async function newMission(f, rawText = 'HTTP境界で原文を保存する\n二行目') {
  const view = await snapshot(f); const input = command('conversation.post', view.conversation.id, view.conversation.revision,
    { message_id: randomUUID(), raw_text: rawText, attachment_refs: [], relation_hint: 'new' });
  const receipt = committed(await post(f, '/api/command', input));
  const after = await snapshot(f); const mission = after.missions.find(row => row.id === receipt.result_ref); assert.ok(mission);
  return { input, receipt, mission, rawText };
}
function durableRows(path) {
  const db = new DatabaseSync(path, { readOnly: true, readBigInts: true, allowExtension: false });
  try {
    return {
      heads: db.prepare('SELECT * FROM record_heads ORDER BY principal_id,id').all(),
      versions: db.prepare('SELECT * FROM record_versions ORDER BY principal_id,version_id').all(),
      commands: db.prepare('SELECT * FROM commands ORDER BY principal_id,command_id').all(),
      audit: db.prepare('SELECT * FROM audit ORDER BY seq').all(),
      scopes: db.prepare('SELECT * FROM scopes ORDER BY id').all(),
      meta: db.prepare('SELECT * FROM meta ORDER BY key').all(),
    };
  } finally { db.close(); }
}

test('HTTP setup → post → start → approve → fake artifact → accept crosses the real host', async t => {
  const f = await fixture(t);
  try {
    await login(f);
    const before = await call(f.origin, '/api/snapshot', { headers: { cookie: f.cookie } });
    assert.equal(before.json.status, 'setup_required');
    committed(await post(f, '/api/setup', setupBody()));
    const created = await newMission(f);
    const startReceipt = committed(await post(f, '/api/command', command('mission.start', created.mission.id, created.mission.scope.revision,
      { brief_revision: created.mission.briefRef, contract_revision: created.mission.contractRef })));
    const pending = await snapshot(f); const approval = pending.approvals.find(row => row.id === startReceipt.result_ref); assert.ok(approval);
    assert.equal(pending.outcomes.length, 0, 'starting work cannot fabricate an accepted artifact');
    committed(await post(f, '/api/command', command('approval.decide', approval.id, approval.revision,
      { action_digest: approval.actionDigest, explanation_revision: approval.explanationRevision, choice: 'approve', comment: 'この模擬操作のみ承認' })));
    let completed;
    const deadline = Date.now() + 5000;
    do {
      completed = await snapshot(f);
      if (completed.outcomes.length) break;
      await new Promise(done => setTimeout(done, 25));
    } while (Date.now() < deadline);
    assert.equal(completed.outcomes.length, 1, 'approved local fake work produces one reviewable result');
    const outcome = completed.outcomes[0]; assert.equal(outcome.state, 'pending'); assert.equal(outcome.verification, 'local_fixture');
    assert.match(outcome.text, /HTTP境界で原文を保存する/); assert.equal(completed.budget.actualExternalCostYen, '0');
    committed(await post(f, '/api/command', command('outcome.decide', outcome.id, outcome.revision,
      { artifact_revision_id: outcome.artifactId, explanation_revision: outcome.explanationRevision, choice: 'accepted', comment: 'HTTP一周を確認' })));
    const accepted = await snapshot(f);
    assert.equal(accepted.outcomes[0].state, 'accepted'); assert.equal(accepted.missions[0].phase, 'exit');
    assert.equal(accepted.messages[0].text, created.rawText); assert.equal(accepted.intents.length, 1);
  } finally { await f.close(); }
});

test('API requests without a valid HttpOnly session cookie are denied', async t => {
  const f = await fixture(t);
  for (const cookie of [undefined, 'orgmanage_fake=forged']) {
    const response = await call(f.origin, '/api/snapshot', { headers: cookie ? { cookie } : {} });
    assert.equal(response.status, 401); assert.equal(response.json.error.code, 'LOCAL_SESSION_REQUIRED');
  }
});

test('launch token is one use and invalid tokens cannot consume it', async t => {
  const f = await fixture(t);
  const invalid = await call(f.origin, '/launch?token=invalid'); assert.equal(invalid.status, 403);
  await login(f);
  const replay = await call(f.origin, f.launchUrl, { headers: { cookie: f.cookie } });
  assert.equal(replay.status, 403); assert.equal(replay.headers['set-cookie'], undefined);
});

test('Host, Origin and Fetch-Site validation reject cross-origin reads before session exposure', async t => {
  const f = await ready(t);
  for (const headers of [
    { host: 'evil.example:80' }, { origin: 'https://evil.example' }, { origin: 'null' },
    { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' },
  ]) {
    const response = await call(f.origin, '/api/session', { headers: { cookie: f.cookie, ...headers } });
    assert.equal(response.status, 403); assert.equal(response.json.error.code, 'DENIED');
    assert.equal(response.json.csrfToken, undefined);
  }
});

test('missing/wrong CSRF, Origin or Content-Type never initializes business state', async t => {
  const f = await fixture(t); await login(f);
  for (const headers of [
    { 'x-orgmanage-csrf': '' }, { 'x-orgmanage-csrf': 'x'.repeat(43) }, { origin: '' },
    { origin: 'https://evil.example' }, { 'content-type': 'text/plain' },
  ]) {
    const response = await post(f, '/api/setup', setupBody(), headers);
    assert.equal(response.status, 403); assert.equal(response.json.error.code, 'DENIED');
  }
  const response = await call(f.origin, '/api/snapshot', { headers: { cookie: f.cookie } });
  assert.equal(response.json.status, 'setup_required');
});

test('unknown endpoints and wrong methods cannot invoke arbitrary core actions', async t => {
  const f = await ready(t); const before = durableRows(f.databasePath);
  for (const [path, method] of [['/api/run-shell', 'POST'], ['/api/command', 'GET'], ['/api/session', 'POST'], ['/api/receipt', 'GET']]) {
    const response = await call(f.origin, path, { method, headers: { cookie: f.cookie, origin: f.origin, 'content-type': 'application/json', 'x-orgmanage-csrf': f.csrf }, body: method === 'POST' ? {} : undefined });
    assert.equal(response.status, 404); assert.equal(response.json.error.code, 'UNKNOWN_ENDPOINT');
  }
  assert.deepEqual(durableRows(f.databasePath), before);
});

test('renderer actor/authority self-claims fail the closed setup and command schemas', async t => {
  const f = await fixture(t); await login(f);
  const forgedSetup = await post(f, '/api/setup', { ...setupBody(), actor_id: randomUUID(), role: 'owner' });
  assert.equal(forgedSetup.status, 200); assert.equal(forgedSetup.json.ok, false); assert.equal(forgedSetup.json.error.code, 'SCHEMA_INVALID');
  committed(await post(f, '/api/setup', setupBody())); const view = await snapshot(f); const before = durableRows(f.databasePath);
  const forgedCommand = await post(f, '/api/command', { ...command('conversation.post', view.conversation.id, view.conversation.revision,
    { message_id: randomUUID(), raw_text: 'forged', attachment_refs: [], relation_hint: 'new' }), actor_id: randomUUID(), principal_id: view.principal.id });
  assert.equal(forgedCommand.json.ok, false); assert.equal(forgedCommand.json.error.code, 'SCHEMA_INVALID');
  assert.deepEqual(durableRows(f.databasePath), before);
  const db = new DatabaseSync(f.databasePath, { readOnly: true });
  try { assert.equal(db.prepare('SELECT actor_id FROM memberships').get().actor_id, TEST_ACTOR); }
  finally { db.close(); }
});

test('HTTP bodies beyond the registered wire byte limit return 413 and commit nothing', async t => {
  const f = await ready(t); const before = durableRows(f.databasePath);
  const response = await post(f, '/api/command', Buffer.alloc(262_145, 0x20));
  assert.equal(response.status, 413); assert.equal(response.json.error.code, 'BYTE_LIMIT');
  assert.deepEqual(durableRows(f.databasePath), before);
});

test('same command ID and body return the durable receipt once; changed content conflicts', async t => {
  const f = await ready(t), created = await newMission(f); const before = durableRows(f.databasePath);
  assert.deepEqual(committed(await post(f, '/api/command', created.input)), created.receipt);
  assert.deepEqual(durableRows(f.databasePath), before);
  const conflict = await post(f, '/api/command', { ...created.input, payload: { ...created.input.payload, raw_text: 'changed content' } });
  assert.equal(conflict.json.ok, false); assert.equal(conflict.json.error.code, 'COMMAND_CONFLICT');
  assert.equal((await snapshot(f)).messages.length, 1);
});

test('snapshot polling and static reload do not write records, audit, commands or feed', async t => {
  const f = await ready(t); await newMission(f); const before = durableRows(f.databasePath); const original = await snapshot(f);
  for (let i = 0; i < 3; i++) {
    const html = await call(f.origin, '/', { headers: { cookie: f.cookie } }); assert.equal(html.status, 200);
    const next = await snapshot(f); assert.equal(next.visibleCursor, original.visibleCursor); assert.deepEqual(next.messages, original.messages);
  }
  assert.deepEqual(durableRows(f.databasePath), before);
});

test('static assets have strict response policy and cannot expose local paths or unsupported files', async t => {
  const f = await fixture(t); const page = await call(f.origin, '/');
  assert.equal(page.status, 200); assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['x-content-type-options'], 'nosniff'); assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.match(page.headers['content-security-policy'], /default-src 'none'/); assert.match(page.headers['content-security-policy'], /connect-src 'self'/);
  assert.equal(page.headers['access-control-allow-origin'], undefined);
  for (const path of ['/private.txt', '/.private/db/ledger.sqlite', '/%2e%2e%2fdb%2fledger.sqlite', '/fixture.js?file=secrets']) {
    const response = await call(f.origin, path); assert.equal(response.status, 404); assert.equal(response.json.error.code, 'UNKNOWN_ENDPOINT');
  }
});

test('host close releases both HTTP listener and database writer ownership', async t => {
  const f = await ready(t); const receipt = await newMission(f); await f.close();
  await assert.rejects(call(f.origin, '/api/snapshot'));
  const restarted = await startLocalHost({ databasePath: f.databasePath, staticRoot: join(f.directory, 'static'), actorId: TEST_ACTOR, port: 0 });
  const session = { ...restarted, cookie: '', csrf: '' };
  try { await login(session); const view = await snapshot(session); assert.equal(view.messages.length, 1); assert.equal(view.messages[0].text, receipt.rawText); }
  finally { await restarted.close(); }
});

test('trusted Windows SID mapping is stable and separates distinct host identities', () => {
  const sid = 'S-1-5-21-1000-1001-1002-1003';
  const actor = windowsActorId(sid);
  assert.equal(windowsActorId(sid), actor);
  assert.notEqual(windowsActorId('S-1-5-21-1000-1001-1002-1004'), actor);
  assert.match(actor, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(actor.includes(sid), false);
});

test('malformed Windows identity strings cannot mint a host actor UUID', () => {
  for (const value of ['', 'windows:S-1-5-21-1000', 'S-1', 's-1-5-21', 'S-1-5-not-a-SID', 'S-1-5-21\n', `S-1-5-${'1'.repeat(185)}`]) {
    assert.throws(() => windowsActorId(value), /Invalid Windows SID/);
  }
});

test('host refuses raw SID actor identities at startup without retaining a database lock', async t => {
  const f = await fixture(t); await f.close();
  await assert.rejects(startLocalHost({ databasePath: f.databasePath, staticRoot: join(f.directory, 'static'), actorId: 'windows:S-1-5-21-1000', port: 0 }), /Trusted host actor UUID required/);
  const actorId = windowsActorId('S-1-5-21-1000-1001-1002-1003');
  const restarted = await startLocalHost({ databasePath: f.databasePath, staticRoot: join(f.directory, 'static'), actorId, port: 0 });
  const session = { ...restarted, cookie: '', csrf: '' };
  try {
    await login(session); committed(await post(session, '/api/setup', setupBody()));
    const db = new DatabaseSync(f.databasePath, { readOnly: true });
    try { assert.equal(db.prepare('SELECT actor_id FROM memberships').get().actor_id, actorId); }
    finally { db.close(); }
  } finally { await restarted.close(); }
});
