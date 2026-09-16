import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexAccountHandshake } from '../../dist/native-codex/src/account.js';
const bytes = value => Buffer.from(JSON.stringify(value));
function ready() { const h = new CodexAccountHandshake(); h.start(); h.accept(bytes({ id: 0, result: { userAgent: 'fixture' } })); return h; }
test('account protocol sends only initialization and nonrefreshing metadata read', () => {
  const h = new CodexAccountHandshake();
  assert.deepEqual(h.start().map(x => x.method), ['initialize']);
  const outgoing = h.accept(bytes({ id: 0, result: { userAgent: 'fixture' } }));
  assert.deepEqual(outgoing, [{ method: 'initialized', params: {} }, { id: 1, method: 'account/read', params: { refreshToken: false } }]);
  assert.throws(() => h.start());
});
test('ChatGPT metadata is projected without email, ID, tokens or false qualification', () => {
  const h = ready(); h.accept(bytes({ id: 1, result: { requiresOpenaiAuth: true, account: { type: 'chatgpt', planType: 'pro', email: 'private@example.test', accessToken: 'SECRET', accountId: 'PRIVATE' } } }));
  assert.deepEqual(h.status, { provider: 'codex', authMode: 'chatgpt_managed', state: 'authenticated_not_qualified', planType: 'pro', inferenceStarted: false, candidateExecutionEnabled: false });
  assert.equal(Object.isFrozen(h.status), true); assert.throws(() => h.accept(bytes({ id: 1, result: {} })));
});
test('missing login does not become ready', () => {
  const h = ready(); h.accept(bytes({ id: 1, result: { requiresOpenaiAuth: true, account: null } })); assert.equal(h.status.state, 'login_required');
});
test('API-key login is refused without changing auth', () => {
  const h = ready(); assert.throws(() => h.accept(bytes({ id: 1, result: { requiresOpenaiAuth: true, account: { type: 'apiKey' } } })), /CHATGPT_LOGIN_REQUIRED/); assert.equal(h.status, undefined);
});
for (const [name, frame] of [
  ['wrong response ID', '{"id":2,"result":{}}'],
  ['duplicate JSON key', '{"id":1,"id":1,"result":{}}'],
  ['server execution request', '{"id":8,"method":"item/commandExecution/requestApproval","params":{}}'],
  ['missing account fields', '{"id":1,"result":{}}'],
  ['remote error contains secret text', '{"id":1,"error":{"message":"SECRET"}}'],
]) test(`fail closed: ${name}`, () => {
  const h = ready(); assert.throws(() => h.accept(Buffer.from(frame)), error => !error.message.includes('SECRET')); assert.equal(h.status, undefined); assert.throws(() => h.accept(Buffer.from('{}')), /CLOSED/);
});
test('notification flood is bounded and cannot authorize an operation', () => {
  const h = ready(); for (let i = 0; i < 63; i++) assert.deepEqual(h.accept(bytes({ method: 'notice', params: { secret: 'ignored' } })), []);
  assert.throws(() => h.accept(bytes({ method: 'notice' })), /MESSAGE_LIMIT/);
});
