import { strictJson } from '../../contracts/src/wire.js';

export type CodexAccountStatus = Readonly<{
  provider: 'codex'; authMode: 'chatgpt_managed' | 'none';
  state: 'authenticated_not_qualified' | 'login_required';
  planType: string | null; inferenceStarted: false; candidateExecutionEnabled: false;
}>;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CODEX_PROTOCOL_INVALID');
  return value as Record<string, unknown>;
};
/** Metadata only. No public arbitrary-RPC method, turns, login writes or token ingestion. */
export class CodexAccountHandshake {
  #phase: 'new' | 'initialize' | 'account' | 'done' | 'failed' = 'new';
  #messages = 0;
  #status: CodexAccountStatus | undefined;
  start(): readonly object[] {
    if (this.#phase !== 'new') throw new Error('CODEX_ALREADY_STARTED');
    this.#phase = 'initialize';
    return [{ id: 0, method: 'initialize', params: { clientInfo: { name: 'orgmanage_account_probe', title: 'OrgManage account probe', version: '0.1.0' }, capabilities: { experimentalApi: false } } }];
  }
  accept(bytes: Uint8Array): readonly object[] {
    if (this.#phase === 'new' || this.#phase === 'done' || this.#phase === 'failed') throw new Error('CODEX_PROTOCOL_CLOSED');
    try {
      if (++this.#messages > 64) throw new Error('CODEX_MESSAGE_LIMIT');
      const parsed = strictJson(bytes);
      if (!parsed.ok) throw new Error('CODEX_PROTOCOL_INVALID');
      const message = object(parsed.value);
      if ('method' in message) {
        if ('id' in message || typeof message.method !== 'string') throw new Error('CODEX_UNEXPECTED_SERVER_REQUEST');
        return []; // Notifications carry no authorization and are not persisted.
      }
      if ('error' in message) throw new Error('CODEX_RPC_FAILED'); // Never surface remote free text.
      if (message.id !== (this.#phase === 'initialize' ? 0 : 1)) throw new Error('CODEX_RESPONSE_ID_MISMATCH');
      const result = object(message.result);
      if (this.#phase === 'initialize') {
        if (typeof result.userAgent !== 'string') throw new Error('CODEX_INITIALIZE_INVALID');
        this.#phase = 'account';
        return [{ method: 'initialized', params: {} }, { id: 1, method: 'account/read', params: { refreshToken: false } }];
      }
      if (typeof result.requiresOpenaiAuth !== 'boolean') throw new Error('CODEX_ACCOUNT_INVALID');
      const account = result.account === null ? null : object(result.account);
      if (account && account.type !== 'chatgpt') throw new Error('CODEX_CHATGPT_LOGIN_REQUIRED');
      const plan = account?.planType;
      const planType = typeof plan === 'string' && /^(free|go|plus|pro|team|business|enterprise|edu|unknown)$/.test(plan) ? plan : null;
      this.#status = Object.freeze({ provider: 'codex', authMode: account ? 'chatgpt_managed' : 'none', state: account ? 'authenticated_not_qualified' : 'login_required', planType, inferenceStarted: false, candidateExecutionEnabled: false });
      this.#phase = 'done';
      return [];
    } catch (error) { this.#phase = 'failed'; throw error; }
  }
  get status(): CodexAccountStatus | undefined { return this.#status; }
}
