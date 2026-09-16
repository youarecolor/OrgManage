import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, protocol, session, Tray, utilityProcess } from 'electron';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { windowsActorId } from '../../dist/host/src/index.js';
import {CredentialVault} from './credential-vault.mjs';
import {checkSavedOpenRouterKey} from './openrouter-key-check.mjs';

export const HOME_URL = 'orgmanage://home/';
const project = fileURLToPath(new URL('../../', import.meta.url));
const stateRoot = resolve(project, '.private/local-state/desktop-p02');
const allowedMethods = new Set(['snapshot', 'setup', 'command']);
const error = code => ({ ok: false, error: { code, retry: 'none' } });
function exact(value, names) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";
let registered = false;

// Electron requires scheme registration before app.ready, including trusted probe imports.
protocol.registerSchemesAsPrivileged([{ scheme: 'orgmanage', privileges: { standard: true, secure: true, corsEnabled: true } }]);
app.enableSandbox();

function under(root, target) {
  const rel = relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
export function validRendererRequest(method, body) {
  if (!allowedMethods.has(method)) return false;
  if (method === 'snapshot') return body === null;
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > 262_144) return false;
  try { const value = JSON.parse(body); return value !== null && typeof value === 'object' && !Array.isArray(value); }
  catch { return false; }
}
export function validateHomeSender(event, contents) {
  try {
    return Boolean(contents && !contents.isDestroyed() && event.sender === contents
      && event.senderFrame === contents.mainFrame && event.senderFrame?.url === HOME_URL && contents.getURL() === HOME_URL);
  } catch { return false; }
}

async function actorFromWindows() {
  if (process.platform !== 'win32') throw new Error('This packet requires the registered Windows identity profile');
  const executable = resolve(process.env.SystemRoot ?? 'C:\\Windows', 'System32/whoami.exe');
  const { stdout } = await promisify(execFile)(executable, ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 4096 });
  const matches = stdout.match(/S-1-[0-9]+(?:-[0-9]+)+/g);
  if (!matches || matches.length !== 1) throw new Error('Windows identity was not verified');
  return windowsActorId(matches[0]);
}

async function assetMap() {
  const root = await realpath(resolve(project, 'dist/home'));
  const assets = new Map();
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
  for (const file of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!file.isFile()) continue;
    const path = await realpath(resolve(file.parentPath, file.name));
    if (!under(root, path)) throw new Error('Build asset escapes trusted static root');
    const type = types[extname(file.name)];
    if (type) assets.set(`/${relative(root, path).split(sep).join('/')}`, { bytes: await readFile(path), type });
  }
  if (!assets.has('/index.html')) throw new Error('Build Home before starting the desktop shell');
  return assets;
}

function launchService(databasePath, actorId, tempPath) {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const worker = utilityProcess.fork(fileURLToPath(new URL('./service.mjs', import.meta.url)), [], {
    cwd: project, serviceName: 'OrgManage Local Core', stdio: 'pipe',
    env: { SystemRoot: systemRoot, WINDIR: systemRoot, PATH: resolve(systemRoot, 'System32'), TEMP: tempPath, TMP: tempPath },
  });
  const pending = new Map();
  let faulted = false, exited = false, shuttingDown = false;
  let quiesceRequested = false, quiesced = false, stopRecorded = false, databaseClosed = false;
  let quiesceRequestId = null, heartbeat = null, heartbeatSequence = 0n;
  let resolveReady, rejectReady;
  const ready = new Promise((done, reject) => { resolveReady = done; rejectReady = reject; });
  const readyTimer = setTimeout(() => fail('SERVICE_START_TIMEOUT'), 15_000);
  function requestQuiesce() {
    if (exited) return;
    quiesceRequested = true;
    quiesceRequestId ??= randomUUID();
    // This private control port remains usable after ordinary RPC admission fails.
    // An unresponsive service is not killed or reported as stopped by the shell.
    try { worker.postMessage({ version: 1, type: 'quiesce', requestId: quiesceRequestId, reason: 'main_fault' }); }
    catch { /* The local monotonic lease is the independent dispatch guard. */ }
  }
  function sendHeartbeat() {
    if (faulted || exited || shuttingDown) return;
    heartbeatSequence += 1n;
    try { worker.postMessage({ version: 1, type: 'heartbeat', sequence: String(heartbeatSequence) }); }
    catch { fail('SERVICE_UNAVAILABLE'); }
  }
  function fail(code) {
    const firstFault = !faulted;
    faulted = true;
    clearTimeout(readyTimer);
    if (heartbeat) clearInterval(heartbeat);
    if (firstFault) requestQuiesce();
    rejectReady(new Error(code));
    for (const [id, item] of pending) {
      if (item.method === 'shutdown' && !exited) continue;
      clearTimeout(item.timer); item.reject(new Error(code)); pending.delete(id);
    }
  }
  worker.on('spawn', () => { if (faulted && !exited) requestQuiesce(); });
  worker.on('message', message => {
    if (!message || message.version !== 1) { fail('SERVICE_PROTOCOL_ERROR'); return; }
    if (message.type === 'ready') {
      if (!exact(message, ['version', 'type', 'versions', 'pid']) || !exact(message.versions, ['electron', 'chrome', 'node', 'sqlite'])
        || !Object.values(message.versions).every(value => value === null || typeof value === 'string') || !Number.isSafeInteger(message.pid)) { fail('SERVICE_PROTOCOL_ERROR'); return; }
      clearTimeout(readyTimer);
      if (faulted) { requestQuiesce(); return; }
      if (heartbeat) { fail('SERVICE_PROTOCOL_ERROR'); return; }
      heartbeat = setInterval(sendHeartbeat, 500);
      sendHeartbeat();
      resolveReady(message);
      return;
    }
    if (message.type === 'quiesced') {
      if (!exact(message, ['version', 'type', 'requestId', 'reason', 'dispatchLatched', 'stopRecorded'])
        || !['main_fault', 'lease_expired', 'service_fault', 'shutdown'].includes(message.reason)
        || message.dispatchLatched !== true || typeof message.stopRecorded !== 'boolean'
        || (message.requestId !== null && message.requestId !== quiesceRequestId)) { fail('SERVICE_PROTOCOL_ERROR'); return; }
      quiesced = true;
      stopRecorded = stopRecorded || message.stopRecorded;
      if (message.reason !== 'shutdown') fail('RECOVERY_REQUIRED');
      return;
    }
    if (message.type === 'fault') {
      if (!exact(message, ['version', 'type', 'code']) || message.code !== 'RECOVERY_REQUIRED') { fail('SERVICE_PROTOCOL_ERROR'); return; }
      fail('RECOVERY_REQUIRED'); return;
    }
    if (message.type === 'reply') {
      if (!exact(message, ['version', 'type', 'id', 'value']) || typeof message.id !== 'string') { fail('SERVICE_PROTOCOL_ERROR'); return; }
      const item = pending.get(message.id);
      if (item) { clearTimeout(item.timer); pending.delete(message.id); item.resolve(message.value); }
      return;
    }
    fail('SERVICE_PROTOCOL_ERROR');
  });
  worker.on('exit', () => { exited = true; if (heartbeat) clearInterval(heartbeat); if (!shuttingDown || pending.size) fail('SERVICE_EXITED'); });
  worker.on('error', () => fail('SERVICE_FAILED'));
  // No environment, request body, database content or diagnostics are copied to renderer logs.
  worker.stdout?.on('data', () => {});
  worker.stderr?.on('data', () => {});
  try { worker.postMessage({ version: 1, type: 'init', databasePath, actorId }); }
  catch { fail('SERVICE_UNAVAILABLE'); }
  function request(method, body, timeout = 10_000) {
    if (exited || (faulted && method !== 'shutdown' && method !== 'snapshot')) return Promise.reject(new Error('RECOVERY_REQUIRED'));
    if (pending.size >= 100) return Promise.resolve(error('BUSY_NOT_COMMITTED'));
    const id = randomUUID();
    return new Promise((done, reject) => {
      const timer = setTimeout(() => { pending.delete(id); fail('SERVICE_RESPONSE_UNKNOWN'); reject(new Error('SERVICE_RESPONSE_UNKNOWN')); }, timeout);
      pending.set(id, { resolve: done, reject, timer, method });
      try { worker.postMessage({ version: 1, type: 'request', id, method, body }); }
      catch { fail('SERVICE_UNAVAILABLE'); }
    });
  }
  return {
    worker, ready,
    rpc(method, body = null) { return validRendererRequest(method, body) ? request(method, body) : Promise.resolve(error('INVALID_REQUEST')); },
    async close() {
      if (exited) throw new Error('RECOVERY_REQUIRED');
      shuttingDown = true;
      if (heartbeat) clearInterval(heartbeat);
      try {
        const result = await request('shutdown', null, 30_000);
        if (!result.ok || result.databaseClosed !== true) throw new Error('SHUTDOWN_NOT_CONFIRMED');
        databaseClosed = true;
        return result;
      } catch (cause) { shuttingDown = false; fail('SHUTDOWN_NOT_CONFIRMED'); throw cause; }
    },
    status: () => ({ faulted, exited, shuttingDown, pendingCount: pending.size,
      quiesceRequested, quiesced, stopRecorded, exitObserved: exited,
      cleanShutdownConfirmed: databaseClosed, recoveryRequired: faulted }),
  };
}

function trayImage() {
  // A compact, built-in application glyph; no remote image, provider, or image decoder input.
  const size = 24, bytes = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const offset = (y * size + x) * 4;
    const ring = Math.hypot(x - 11.5, y - 11.5) >= 5 && Math.hypot(x - 11.5, y - 11.5) < 8;
    bytes[offset] = ring ? 255 : 246; bytes[offset + 1] = ring ? 255 : 89; bytes[offset + 2] = ring ? 255 : 23; bytes[offset + 3] = 255;
  }
  return nativeImage.createFromBitmap(bytes, { width: size, height: size });
}

/** Trusted main-process integration port. Options never come from renderer IPC. */
export async function startDesktopShell(options = {}) {
  if (registered) throw new Error('One desktop shell per main process');
  if (Object.keys(options).some(key => !['show', 'tray', 'probeName', 'nativeHomeReview', 'nativeCoreReview'].includes(key))) throw new Error('Unknown desktop option');
  if(options.nativeCoreReview!==undefined&&options.nativeCoreReview!==true)throw Error('Invalid core review option');
  if(options.nativeCoreReview&&(options.nativeHomeReview||options.probeName!==undefined))throw Error('Review modes cannot be combined');
  if (options.nativeHomeReview !== undefined && options.nativeHomeReview !== true) throw new Error('Invalid native review option');
  if (options.nativeHomeReview && options.probeName !== undefined) throw new Error('Review and synthetic probe cannot be combined');
  if (options.probeName !== undefined && (typeof options.probeName !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(options.probeName))) throw new Error('Invalid local probe name');
  registered = true;
  const statePath = options.nativeCoreReview ? resolve(stateRoot,'reviews/native-core-dispatch') : options.nativeHomeReview ? resolve(stateRoot, 'reviews/native-home-v3') : options.probeName ? resolve(stateRoot, 'probes', options.probeName) : stateRoot;
  // Fixed trusted review entry only. No caller-selected path and no renderer option.
  const ledgerPath = options.nativeCoreReview ? resolve(project,'.private/reviews/20260914-native-core-dispatch/ledger.sqlite') : options.nativeHomeReview ? resolve(project, '.private/reviews/20260914-native-home-edit/v3/candidate/ledger.sqlite') : resolve(statePath, 'ledger.sqlite');
  if ((options.nativeHomeReview||options.nativeCoreReview) && realpathSync(ledgerPath) !== ledgerPath) throw new Error('Native review ledger must be the existing fixed file');
  const tempPath = resolve(statePath, 'temp');
  // Configure Chromium paths synchronously before the first await can allow app.ready.
  mkdirSync(statePath, { recursive: true });
  const canonicalProject = realpathSync(project), canonicalState = realpathSync(statePath);
  if (!under(canonicalProject, canonicalState)) throw new Error('Desktop state escapes OrgManage');
  for (const folder of ['user-data', 'session-data', 'cache', 'logs', 'crash-dumps', 'temp']) {
    const path = resolve(statePath, folder);
    mkdirSync(path, { recursive: true });
    if (!under(canonicalState, realpathSync(path))) throw new Error('Desktop runtime folder escapes local state');
  }
  app.setName('OrgManage');
  app.setPath('userData', resolve(statePath, 'user-data'));
  app.setPath('sessionData', resolve(statePath, 'session-data'));
  app.setPath('crashDumps', resolve(statePath, 'crash-dumps'));
  app.setPath('temp', tempPath);
  app.setAppLogsPath(resolve(statePath, 'logs'));
  app.commandLine.appendSwitch('disk-cache-dir', resolve(statePath, 'cache'));
  await app.whenReady();
  const actorId = await actorFromWindows(), assets = await assetMap();
  const isolatedSession = session.fromPartition(`orgmanage-home-${randomUUID()}`, { cache: false });
  const headers = { 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };
  isolatedSession.protocol.handle('orgmanage', request => {
    const url = new URL(request.url);
    if (request.method !== 'GET' || url.protocol !== 'orgmanage:' || url.host !== 'home' || url.username || url.password || url.search || url.hash) return new Response('Unavailable', { status: 404, headers });
    const asset = assets.get(url.pathname === '/' ? '/index.html' : url.pathname);
    return asset ? new Response(asset.bytes, { headers: { ...headers, 'Content-Type': asset.type } }) : new Response('Unavailable', { status: 404, headers });
  });
  isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolatedSession.setPermissionCheckHandler(() => false);
  isolatedSession.on('will-download', event => event.preventDefault());
  isolatedSession.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false;
    try {
      const url = new URL(details.url);
      allowed = url.protocol === 'orgmanage:' && url.host === 'home' && !url.search && !url.hash && !url.username && !url.password
        && assets.has(url.pathname === '/' ? '/index.html' : url.pathname);
    } catch { /* Reject malformed or foreign URL. */ }
    callback({ cancel: !allowed });
  });
  const service = launchService(ledgerPath, actorId, tempPath);
  let ready;
  try { ready = await service.ready; }
  catch (cause) { if (options.probeName || options.nativeHomeReview || options.nativeCoreReview) service.worker.kill(); throw cause; }
  const mainWindow = new BrowserWindow({
    width: 1600, height: 900, minWidth: 1280, minHeight: 720, show: false, title: 'OrgManage', backgroundColor: '#ffffff',
    webPreferences: { preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)), session: isolatedSession,
      nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
      contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
      webviewTag: false, devTools: false, experimentalFeatures: false, navigateOnDragDrop: false, spellcheck: false },
  });
  mainWindow.setMenu(null);
  let quitting = false, closing = false, rendererMutation = false, tray = null;
  const credentialStop=new AbortController();
  const validateSender = event => validateHomeSender(event, mainWindow.webContents);
  const credentialPath=resolve(statePath,'credentials');
  mkdirSync(credentialPath,{recursive:true});
  let vault=null,credentialMutation=false;try{vault=new CredentialVault(credentialPath);}catch{/* Unavailable remains disabled; never fall back to plaintext. */}
  // Secrets are local configuration. They never traverse the Core command journal,
  // utility process, normal dialogue or snapshot. No credential read IPC exists.
  ipcMain.handle('orgmanage:credentials',async(event,...args)=>{
    if(!validateSender(event)||args.length!==1)return {ok:false,code:'DENIED'};
    const value=args[0];
    if(!exact(value,['action','key','consent'])||!['status','save','remove','check'].includes(value.action)||typeof value.key!=='string'||value.key.length>512||typeof value.consent!=='boolean')return {ok:false,code:'INVALID_REQUEST'};
    if((value.action==='status'&&(value.key!==''||value.consent))||(value.action!=='status'&&!value.consent)||(value.action!=='save'&&value.key!==''))return {ok:false,code:'INVALID_REQUEST'};
    if(closing||service.status().faulted||!vault)return {ok:false,code:'UNAVAILABLE'};
    if(credentialMutation)return {ok:false,code:'BUSY'};credentialMutation=true;
    try{
      const view=await service.rpc('snapshot');
      if(!validateSender(event)||closing||view.status!=='ready')return {ok:false,code:'DENIED'};
      if(value.action==='check'){
        const result=await checkSavedOpenRouterKey(vault,credentialStop.signal);
        if(!validateSender(event)||closing||service.status().faulted||credentialStop.signal.aborted)return {ok:false,code:'UNAVAILABLE'};
        return {ok:true,...result};
      }
      const result=value.action==='save'?vault.saveNew('openrouter',value.key):value.action==='remove'?vault.remove('openrouter'):vault.status('openrouter');
      return {ok:true,stored:result.stored};
    }catch{return {ok:false,code:'SAVE_OR_READ_FAILED'};}
    finally{credentialMutation=false;}
  });
  for (const method of allowedMethods) ipcMain.handle(`orgmanage:${method}`, async (event, ...args) => {
    if (!validateSender(event) || (method === 'snapshot' ? args.length !== 0 : args.length !== 1)) return error('DENIED');
    const body = method === 'snapshot' ? null : args[0];
    if (!validRendererRequest(method, body)) return error('INVALID_REQUEST');
    if (closing || service.status().faulted) throw new Error('RECOVERY_REQUIRED');
    if (method !== 'snapshot' && rendererMutation) return error('BUSY_NOT_COMMITTED');
    if (method !== 'snapshot') rendererMutation = true;
    try { return await service.rpc(method, body); }
    finally { if (method !== 'snapshot') rendererMutation = false; }
  });
  const contents = mainWindow.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', event => event.preventDefault());
  contents.on('will-frame-navigate', event => event.preventDefault());
  contents.on('will-redirect', event => event.preventDefault());
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.on('render-process-gone', () => { rendererMutation = false; });
  mainWindow.on('close', event => { if (!quitting) { event.preventDefault(); mainWindow.hide(); } });
  app.on('window-all-closed', () => {});
  app.on('activate', () => { if (!mainWindow.isDestroyed()) mainWindow.show(); });
  async function close() {
    if (closing) throw new Error('Desktop shutdown already pending');
    closing = true;
    credentialStop.abort();
    try {
      const result = await service.close();
      quitting = true;
      for (const method of allowedMethods) ipcMain.removeHandler(`orgmanage:${method}`);
      ipcMain.removeHandler('orgmanage:credentials');
      tray?.destroy();
      mainWindow.destroy();
      return result;
    } catch (cause) { closing = false; throw cause; }
  }
  async function quitRequested() {
    try { await close(); app.quit(); }
    catch {
      if (!mainWindow.isDestroyed()) mainWindow.show();
      void dialog.showMessageBox(mainWindow, { type: 'error', title: '停止を確認できません', message: '停止と台帳の終了を確認できませんでした。', detail: '画面は参照専用で保持します。未確認の操作を再送せず、回復手順で照合してください。', buttons: ['閉じる'] });
    }
  }
  app.on('before-quit', event => { if (!quitting) { event.preventDefault(); if (!closing) void quitRequested(); } });
  if (options.tray !== false) {
    tray = new Tray(trayImage());
    tray.setToolTip('OrgManage — Home');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Homeを開く', click: () => { mainWindow.show(); mainWindow.focus(); } },
      { type: 'separator' },
      { label: '停止して終了', click: () => { if (!closing) void quitRequested(); } },
    ]));
    tray.on('double-click', () => { mainWindow.show(); mainWindow.focus(); });
  }
  await mainWindow.loadURL(HOME_URL);
  if (options.show !== false) mainWindow.show();
  return { window: mainWindow, utility: service.worker, rpc: service.rpc, close, validateSender,
    versions: ready.versions, serviceStatus: service.status, statePath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startDesktopShell().catch(() => {
    dialog.showErrorBox('OrgManageを開始できません', 'ローカルCore・台帳・本人の識別を確認できませんでした。既存の台帳を初期化せず停止します。');
    app.exit(1);
  });
}
