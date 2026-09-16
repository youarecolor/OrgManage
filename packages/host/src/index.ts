import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { resolve, relative, extname, sep } from 'node:path';
import type { AddressInfo } from 'node:net';
import { LedgerStore } from '../../ledger/src/index.js';
import { OrgManageCore } from '../../core/src/index.js';
import { LocalFakeDispatcher } from '../../core/src/local-dispatcher.js';

export interface LocalHostOptions { databasePath: string; staticRoot: string; actorId: string; port?: number }
const equal = (a: string, b: string): boolean => { const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); };
const failure = (code: string) => ({ ok: false, error: { code, retry: 'none' } });
export function windowsActorId(sid: string): string {
  if (!/^S-1-[0-9]+(?:-[0-9]+)+(?![\s\S])/.test(sid) || sid.length > 184) throw new Error('Invalid Windows SID');
  const bytes = createHash('sha256').update(`OrgManage:WindowsSID:v1\0${sid}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 128; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString('hex'); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Development-only trusted host. No provider, external fetch, or arbitrary filesystem endpoint. */
export async function startLocalHost(options: LocalHostOptions) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![\s\S])/.test(options.actorId)) throw new Error('Trusted host actor UUID required');
  const root = await realpath(options.staticRoot), files = new Map<string, { bytes: Buffer; type: string }>();
  const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
  for (const item of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!item.isFile()) continue;
    const absolute = await realpath(resolve(item.parentPath, item.name)), rel = relative(root, absolute);
    if (rel.startsWith(`..${sep}`) || rel === '..' || resolve(root, rel) !== absolute) throw new Error('Static asset escapes build root');
    const type = types[extname(item.name)]; if (!type) continue;
    files.set(`/${rel.split(sep).join('/')}`, { bytes: await readFile(absolute), type });
  }
  if (!files.has('/index.html')) throw new Error('Build Home before starting the local host');
  const store = await LedgerStore.open(options.databasePath);
  let core: OrgManageCore;
  try { core = new OrgManageCore(store); } catch (cause) { await store.close(); throw cause; }
  const session = core.openSession(options.actorId);
  const launchToken = randomBytes(32).toString('base64url'), cookieValue = randomBytes(32).toString('base64url');
  const cookieName = `orgmanage_${randomBytes(8).toString('hex')}`, csrfToken = randomBytes(32).toString('base64url');
  let launched = false, origin = '', stopped = false, serviceFault = false;
  const dispatcher = new LocalFakeDispatcher(core);
  const pump = () => {
    if (stopped || serviceFault) return;
    try {
      if (dispatcher.tick().status === 'recovery_required') serviceFault = true;
    } catch { serviceFault = true; }
  };
  const send = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value));
  };
  const authorized = (req: IncomingMessage) => (req.headers.cookie ?? '').split(';').some(pair => equal(pair.trim(), `${cookieName}=${cookieValue}`));
  const body = async (req: IncomingMessage): Promise<Uint8Array> => {
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of req) { const bytes = Buffer.from(chunk); length += bytes.length; if (length <= 262_144) chunks.push(bytes); }
    if (length > 262_144) throw new RangeError('Request too large');
    return Buffer.concat(chunks);
  };
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    try {
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)
        || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site'])))) return send(res, 403, failure('DENIED'));
      const url = new URL(req.url ?? '/', origin);
      if (url.pathname === '/launch' && req.method === 'GET') {
        if (launched || !equal(url.searchParams.get('token') ?? '', launchToken)) return send(res, 403, failure('DENIED'));
        launched = true;
        res.writeHead(303, { Location: '/', 'Set-Cookie': `${cookieName}=${cookieValue}; HttpOnly; SameSite=Strict; Path=/` }); return res.end();
      }
      if (url.pathname.startsWith('/api/')) {
        if (!authorized(req)) return send(res, 401, failure('LOCAL_SESSION_REQUIRED'));
        if (serviceFault) return send(res, 503, failure('RECOVERY_REQUIRED'));
        if (req.method === 'GET' && url.pathname === '/api/session') return send(res, 200, { csrfToken });
        if (req.method === 'GET' && url.pathname === '/api/snapshot') return send(res, 200, core.snapshot(session));
        if (req.method === 'POST' && ['/api/setup', '/api/command'].includes(url.pathname)) {
          if (req.headers.origin !== origin || req.headers['content-type'] !== 'application/json'
            || !equal(String(req.headers['x-orgmanage-csrf'] ?? ''), csrfToken)) return send(res, 403, failure('DENIED'));
          const bytes = await body(req);
          const result = url.pathname === '/api/setup' ? core.setup(session, bytes) : core.command(session, bytes);
          send(res, 200, result); setImmediate(pump); return;
        }
        return send(res, 404, failure('UNKNOWN_ENDPOINT'));
      }
      if (req.method !== 'GET' || url.search) return send(res, 404, failure('UNKNOWN_ENDPOINT'));
      const asset = files.get(url.pathname === '/' ? '/index.html' : url.pathname);
      if (!asset) return send(res, 404, failure('UNKNOWN_ENDPOINT'));
      res.writeHead(200, { 'Content-Type': asset.type }); res.end(asset.bytes);
    } catch (cause) { if (!res.headersSent) send(res, cause instanceof RangeError ? 413 : 503, failure(cause instanceof RangeError ? 'BYTE_LIMIT' : 'RECOVERY_REQUIRED')); else res.end(); }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 5_000; server.maxHeadersCount = 32;
  try { await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', done); }); }
  catch (cause) { await store.close(); throw cause; }
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const timer = setInterval(pump, 1_000); timer.unref();
  return {
    origin, launchUrl: `${origin}/launch?token=${launchToken}`,
    async close() { stopped = true; clearInterval(timer); server.closeAllConnections(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); await store.close(); },
  };
}
