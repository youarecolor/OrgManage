import type { ClientError, CoreResult, HomeSnapshot } from '../../../packages/core/src/model';

export interface HomeBridge {
  snapshot(): Promise<HomeSnapshot | ClientError>;
  setup(request: unknown): Promise<CoreResult>;
  command(request: unknown): Promise<CoreResult>;
}

declare global { interface Window { orgmanage?: Readonly<HomeBridge> } }

let session: Promise<string> | null = null;

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  return await response.json() as T;
}

function csrf(): Promise<string> {
  session ??= request<{ csrfToken: string }>('/api/session').then(value => {
    if (typeof value.csrfToken !== 'string' || value.csrfToken.length === 0) throw new Error('SESSION_UNAVAILABLE');
    return value.csrfToken;
  }).catch(error => { session = null; throw error; });
  return session;
}

async function write(path: string, value: unknown): Promise<CoreResult> {
  const token = await csrf();
  return request<CoreResult>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-OrgManage-CSRF': token },
    body: JSON.stringify(value),
  });
}

const browserBridge: HomeBridge = {
  async snapshot() { await csrf(); return request<HomeSnapshot | ClientError>('/api/snapshot'); },
  setup: value => write('/api/setup', value),
  command: value => write('/api/command', value),
};

export const bridge: HomeBridge = window.orgmanage ?? browserBridge;
