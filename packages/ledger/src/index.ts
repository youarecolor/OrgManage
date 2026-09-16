import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite';
import { RUNNER_SCHEMA, RunnerAccess } from './runner.js';
import { NATIVE_SCHEMA, NativeAccess } from './native.js';
import { CANDIDATE_SCHEMA, CANDIDATE_CONTRACT_V8, CandidateAccess } from './candidate.js';
import { CANDIDATE_EVALUATION_SCHEMA, CandidateEvaluationAccess } from './candidate-evaluation.js';
import {CANDIDATE_ARTIFACT_SCHEMA,CANDIDATE_OUTCOME_SCHEMA,CandidateArtifactAccess} from './candidate-artifact.js';
import type {CandidateArtifactReader,CandidateArtifactTransaction} from './candidate-artifact.js';
export type {CandidateArtifactRow,CandidateOutcomeRow} from './candidate-artifact.js';
import type { CandidateEvaluationReader, CandidateEvaluationTransaction } from './candidate-evaluation.js';
export type { CandidateEvaluationPlanRow, CandidateEvaluationAttemptRow, CandidateEvaluationResultRow } from './candidate-evaluation.js';
import type { CandidateReader, CandidateTransaction } from './candidate.js';
export type { CandidateBaseRecord, CandidateProposalRecord } from './candidate.js';
import type { NativeReader, NativeTransaction } from './native.js';
export type { NativeAttempt, NativeEvent } from './native.js';
import type { RunnerReader, RunnerTransaction } from './runner.js';
export type { RunnerProfile, RunnerWorkspace, RunnerLease, RunnerStopObservation, RunnerEvidenceKind } from './runner.js';

export class LedgerBusyError extends Error { override name = 'LedgerBusyError'; }
export class LedgerIntegrityError extends Error { override name = 'LedgerIntegrityError'; }
export class LedgerOwnerError extends Error { override name = 'LedgerOwnerError'; }
export class RevisionConflictError extends Error { override name = 'RevisionConflictError'; }

export type Principal = { id: string; kind: 'person' | 'organization'; displayName: string };
export type Membership = { principalId: string; actorId: string; role: 'owner' | 'viewer' | 'revoked'; generation: bigint };
export type ScopeKind = 'application' | 'principal' | 'conversation' | 'mission' | 'control_operation';
export type Scope = { id: string; principalId: string | null; kind: ScopeKind; parentId: string | null; revision: bigint; epoch: bigint; state: 'active' | 'paused' | 'closed'; reason?: string | null; actorId?: string | null; changedAt?: string | null };
export const RECORD_KINDS = ['conversation', 'message', 'brief', 'contract', 'policy', 'mission', 'approval', 'intent', 'artifact', 'outcome', 'evidence', 'control_operation', 'dispatch_observation', 'cost_obligation', 'run', 'attempt', 'reconciliation_case', 'cost_event', 'job', 'knowledge', 'evaluation', 'knowledge_use', 'source', 'source_grant', 'context_manifest', 'change', 'classification_correction', 'resource_snapshot', 'resource_hold', 'budget_month'] as const;
export type RecordKind = typeof RECORD_KINDS[number];
export type LedgerRecord = { principalId: string; id: string; kind: RecordKind; revision: bigint; data: string; versionId?: string | undefined };
export type StoredLedgerRecord = LedgerRecord & { versionId: string };
export type Command = { principalId: string; commandId: string; actorId: string; digest: string; receipt: string };
export type Audit = { seq: bigint; principalId: string; commandId: string | null; kind: string; entityId: string | null; createdAt: string };
export const MAX_REVISION = 999_999_999_999_999_999n;
const APPLICATION_ID = 0x4f4d4731;
const VERSION = 'orgmanage-local-ledger-v8';
const IMMUTABLE = new Set<RecordKind>(['brief', 'contract', 'artifact', 'evidence']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LEGACY_SCHEMA = [
  `CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`,
  `CREATE TABLE principals(id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('person','organization')), display_name TEXT NOT NULL) STRICT`,
  `CREATE TABLE memberships(principal_id TEXT NOT NULL REFERENCES principals(id), actor_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','viewer','revoked')), generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 999999999999999999), PRIMARY KEY(principal_id,actor_id)) STRICT`,
  `CREATE TABLE scopes(id TEXT PRIMARY KEY, principal_id TEXT REFERENCES principals(id), kind TEXT NOT NULL CHECK(kind IN ('application','principal','conversation','mission','control_operation')), parent_id TEXT REFERENCES scopes(id), revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 999999999999999999), epoch INTEGER NOT NULL CHECK(epoch BETWEEN 1 AND 999999999999999999), state TEXT NOT NULL CHECK(state IN ('active','paused','closed')), reason TEXT, actor_id TEXT, changed_at TEXT, CHECK((kind='application' AND principal_id IS NULL AND parent_id IS NULL) OR (kind!='application' AND principal_id IS NOT NULL AND parent_id IS NOT NULL)), CHECK(parent_id IS NULL OR parent_id!=id), UNIQUE(principal_id,id)) STRICT`,
  `CREATE UNIQUE INDEX one_application_scope ON scopes(kind) WHERE kind='application'`,
  `CREATE TRIGGER scope_parent_insert BEFORE INSERT ON scopes WHEN NEW.parent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM scopes p WHERE p.id=NEW.parent_id AND ((NEW.kind='principal' AND p.kind='application') OR (NEW.kind!='principal' AND p.principal_id=NEW.principal_id))) BEGIN SELECT RAISE(ABORT,'scope parent mismatch'); END`,
  `CREATE TRIGGER scope_identity_update BEFORE UPDATE ON scopes WHEN NEW.id!=OLD.id OR NEW.kind!=OLD.kind OR NEW.principal_id IS NOT OLD.principal_id OR NEW.parent_id IS NOT OLD.parent_id BEGIN SELECT RAISE(ABORT,'scope identity is immutable'); END`,
  `CREATE TABLE record_versions(principal_id TEXT NOT NULL REFERENCES principals(id), version_id TEXT NOT NULL, subject_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN (${RECORD_KINDS.map(k => `'${k}'`).join(',')})), revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 999999999999999999), data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(principal_id,version_id), UNIQUE(principal_id,kind,subject_id,revision), UNIQUE(principal_id,kind,subject_id,revision,version_id)) STRICT`,
  `CREATE TABLE record_heads(principal_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, revision INTEGER NOT NULL, current_version_id TEXT NOT NULL, PRIMARY KEY(principal_id,id), UNIQUE(principal_id,id,kind), FOREIGN KEY(principal_id,kind,id,revision,current_version_id) REFERENCES record_versions(principal_id,kind,subject_id,revision,version_id)) STRICT`,
  `CREATE TRIGGER record_version_update BEFORE UPDATE ON record_versions BEGIN SELECT RAISE(ABORT,'record version is immutable'); END`,
  `CREATE TRIGGER record_version_delete BEFORE DELETE ON record_versions BEGIN SELECT RAISE(ABORT,'record version cannot be deleted'); END`,
  `CREATE TRIGGER record_identity_update BEFORE UPDATE ON record_heads WHEN NEW.principal_id!=OLD.principal_id OR NEW.id!=OLD.id OR NEW.kind!=OLD.kind BEGIN SELECT RAISE(ABORT,'record identity is immutable'); END`,
  `CREATE TRIGGER immutable_record_update BEFORE UPDATE ON record_heads WHEN OLD.kind IN ('brief','contract','artifact','evidence') BEGIN SELECT RAISE(ABORT,'immutable record'); END`,
  `CREATE TABLE approval_bindings(principal_id TEXT NOT NULL, request_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'approval' CHECK(kind='approval'), action_digest TEXT NOT NULL CHECK(length(action_digest)=64 AND action_digest NOT GLOB '*[^0-9a-f]*'), PRIMARY KEY(principal_id,request_id), UNIQUE(principal_id,request_id,action_digest), FOREIGN KEY(principal_id,request_id,kind) REFERENCES record_heads(principal_id,id,kind)) STRICT`,
  `CREATE TABLE intent_approval_bindings(principal_id TEXT NOT NULL, intent_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'intent' CHECK(kind='intent'), request_id TEXT NOT NULL, action_digest TEXT NOT NULL, PRIMARY KEY(principal_id,intent_id), FOREIGN KEY(principal_id,intent_id,kind) REFERENCES record_heads(principal_id,id,kind), FOREIGN KEY(principal_id,request_id,action_digest) REFERENCES approval_bindings(principal_id,request_id,action_digest)) STRICT`,
  `CREATE TABLE commands(principal_id TEXT NOT NULL REFERENCES principals(id), command_id TEXT NOT NULL, actor_id TEXT NOT NULL, digest TEXT NOT NULL CHECK(length(digest)=64 AND digest NOT GLOB '*[^0-9a-f]*'), receipt TEXT NOT NULL CHECK(json_valid(receipt)), PRIMARY KEY(principal_id,command_id)) STRICT`,
  `CREATE TABLE audit(seq INTEGER PRIMARY KEY AUTOINCREMENT, principal_id TEXT NOT NULL REFERENCES principals(id), command_id TEXT, kind TEXT NOT NULL, entity_id TEXT, created_at TEXT NOT NULL, FOREIGN KEY(principal_id,command_id) REFERENCES commands(principal_id,command_id) DEFERRABLE INITIALLY DEFERRED) STRICT`,
];
const schemaHash = (sql: string[]) => createHash('sha256').update([...sql].sort().join('\n')).digest('hex');
const V2_SCHEMA = [...LEGACY_SCHEMA, ...RUNNER_SCHEMA];
const V2_SCHEMA_HASH = schemaHash(V2_SCHEMA);
const V3_SCHEMA = [...V2_SCHEMA, ...NATIVE_SCHEMA];
const V3_SCHEMA_HASH = schemaHash(V3_SCHEMA);
const V4_SCHEMA = [...V3_SCHEMA, ...CANDIDATE_SCHEMA];
const V4_SCHEMA_HASH = schemaHash(V4_SCHEMA);
const V5_SCHEMA = [...V4_SCHEMA, ...CANDIDATE_EVALUATION_SCHEMA];
const V5_SCHEMA_HASH = schemaHash(V5_SCHEMA);
const V6_SCHEMA = [...V5_SCHEMA, ...CANDIDATE_ARTIFACT_SCHEMA];
const V6_SCHEMA_HASH = schemaHash(V6_SCHEMA);
const V7_SCHEMA = [...V6_SCHEMA, ...CANDIDATE_OUTCOME_SCHEMA];
const V7_SCHEMA_HASH = schemaHash(V7_SCHEMA);
const SCHEMA = V7_SCHEMA.map(sql=>sql.startsWith('CREATE TRIGGER candidate_base_contract ')?CANDIDATE_CONTRACT_V8:sql);
const LEGACY_SCHEMA_HASH = schemaHash(LEGACY_SCHEMA);
export const LEDGER_SCHEMA_HASH = schemaHash(SCHEMA);

function revision(value: bigint): void {
  if (typeof value !== 'bigint' || value < 1n || value > MAX_REVISION) throw new LedgerIntegrityError('Revision/generation must be a positive 1–18 digit bigint');
}
function identifier(value: string): void {
  if (typeof value !== 'string' || !UUID.test(value)) throw new LedgerIntegrityError('Expected canonical UUID');
}
function failure(error: unknown): never {
  if (error instanceof LedgerIntegrityError || error instanceof LedgerBusyError || error instanceof LedgerOwnerError || error instanceof RevisionConflictError) throw error;
  const code = error && typeof error === 'object' && 'errcode' in error ? Number(error.errcode) & 0xff : undefined;
  if (code === 5 || code === 6) throw new LedgerBusyError('Database writer is busy', { cause: error });
  throw new LedgerIntegrityError('Ledger operation failed', { cause: error });
}
function synchronous<T>(value: T): T {
  if (value !== null && (typeof value === 'object' || typeof value === 'function') && 'then' in value && typeof value.then === 'function') {
    // Observe native promises so an invalid async callback cannot cause an unhandled rejection.
    if (value instanceof Promise) void value.catch(() => undefined);
    throw new LedgerIntegrityError('Transaction/read callbacks must be synchronous');
  }
  return value;
}
type Row = Record<string, SQLOutputValue>;
const pRow = (r: Row): Principal => ({ id: r.id as string, kind: r.kind as Principal['kind'], displayName: r.display_name as string });
const mRow = (r: Row): Membership => ({ principalId: r.principal_id as string, actorId: r.actor_id as string, role: r.role as Membership['role'], generation: r.generation as bigint });
const sRow = (r: Row): Scope => ({ id: r.id as string, principalId: r.principal_id as string | null, kind: r.kind as ScopeKind, parentId: r.parent_id as string | null, revision: r.revision as bigint, epoch: r.epoch as bigint, state: r.state as Scope['state'], reason: r.reason as string | null, actorId: r.actor_id as string | null, changedAt: r.changed_at as string | null });
const rRow = (r: Row): StoredLedgerRecord => ({ principalId: r.principal_id as string, id: r.subject_id as string, kind: r.kind as RecordKind, revision: r.revision as bigint, data: r.data as string, versionId: r.version_id as string });
const HEAD_SELECT = 'SELECT v.* FROM record_heads h JOIN record_versions v ON v.principal_id=h.principal_id AND v.version_id=h.current_version_id';
const cRow = (r: Row): Command => ({ principalId: r.principal_id as string, commandId: r.command_id as string, actorId: r.actor_id as string, digest: r.digest as string, receipt: r.receipt as string });
const aRow = (r: Row): Audit => ({ seq: r.seq as bigint, principalId: r.principal_id as string, commandId: r.command_id as string | null, kind: r.kind as string, entityId: r.entity_id as string | null, createdAt: r.created_at as string });

export interface LedgerReader {
  readonly candidateEvaluation: CandidateEvaluationReader;
  readonly candidateArtifact: CandidateArtifactReader;
  readonly candidate: CandidateReader;
  readonly native: NativeReader;
  readonly runner: RunnerReader;
  getMeta(key: string): string | undefined;
  getPrincipal(id: string): Principal | undefined;
  listPrincipal(): Principal[];
  getMembership(principalId: string, actorId: string): Membership | undefined;
  listMembership(principalId: string): Membership[];
  getScope(id: string): Scope | undefined;
  listScope(principalId: string | null): Scope[];
  getRecord(principalId: string, id: string): StoredLedgerRecord | undefined;
  listRecord(principalId: string, kind?: RecordKind): StoredLedgerRecord[];
  getRecordVersion(principalId: string, versionId: string): StoredLedgerRecord | undefined;
  getRecordHistory(principalId: string, id: string): StoredLedgerRecord[];
  getCommand(principalId: string, commandId: string): Command | undefined;
  listAudit(principalId: string): Audit[];
}
export interface LedgerTransaction extends LedgerReader {
  readonly candidateEvaluation: CandidateEvaluationTransaction;
  readonly candidateArtifact: CandidateArtifactTransaction;
  readonly candidate: CandidateTransaction;
  readonly native: NativeTransaction;
  readonly runner: RunnerTransaction;
  setMeta(key: string, value: string): void;
  insertPrincipal(row: Principal): void;
  putMembership(row: Membership): void;
  insertScope(row: Scope): void;
  updateScope(row: Scope, expectedRevision: bigint): void;
  insertRecord(row: LedgerRecord): void;
  updateRecord(row: LedgerRecord, expectedRevision: bigint): void;
  registerApprovalBinding(principalId: string, requestId: string, actionDigest: string): void;
  bindIntentApproval(principalId: string, intentId: string, requestId: string, actionDigest: string): void;
  insertCommand(row: Command): void;
  appendAudit(row: Omit<Audit, 'seq'>): bigint;
}

// Instances are callback-scoped. The database and SQL never escape through this API.
class Access implements LedgerTransaction {
  readonly candidateEvaluation: CandidateEvaluationTransaction;
  readonly candidateArtifact: CandidateArtifactTransaction;
  readonly candidate: CandidateTransaction;
  readonly native: NativeTransaction;
  readonly runner: RunnerTransaction;
  #active = true;
  #db: DatabaseSync;
  #writable: boolean;
  #owned: () => boolean;
  constructor(db: DatabaseSync, writable: boolean, owned: () => boolean) {
    this.#db = db; this.#writable = writable; this.#owned = owned;
    this.candidateEvaluation = new CandidateEvaluationAccess((sql,...args)=>this.#get(sql,...args),(sql,...args)=>this.#all(sql,...args),(sql,...args)=>this.#run(sql,...args));
    this.candidateArtifact = new CandidateArtifactAccess((sql,...args)=>this.#get(sql,...args),(sql,...args)=>this.#run(sql,...args));
    this.candidate = new CandidateAccess((sql,...args)=>this.#get(sql,...args),(sql,...args)=>this.#all(sql,...args),(sql,...args)=>this.#run(sql,...args));
    this.native = new NativeAccess((sql,...args)=>this.#get(sql,...args),(sql,...args)=>this.#all(sql,...args),(sql,...args)=>this.#run(sql,...args),()=>{throw new RevisionConflictError('Native revision conflict');});
    this.runner = new RunnerAccess((sql,...args)=>this.#get(sql,...args),(sql,...args)=>this.#all(sql,...args),(sql,...args)=>this.#run(sql,...args),()=>{throw new RevisionConflictError('Runner revision/generation conflict');});
  }
  invalidate(): void { this.#active = false; }
  #check(write = false): void {
    if (!this.#active || !this.#owned()) throw new LedgerOwnerError('Ledger callback is no longer active');
    if (write && !this.#writable) throw new LedgerOwnerError('Read callback cannot mutate the ledger');
  }
  #get(sql: string, ...params: SQLInputValue[]): Row | undefined { this.#check(); const stmt = this.#db.prepare(sql); stmt.setReadBigInts(true); return stmt.get(...params); }
  #all(sql: string, ...params: SQLInputValue[]): Row[] { this.#check(); const stmt = this.#db.prepare(sql); stmt.setReadBigInts(true); return stmt.all(...params); }
  #run(sql: string, ...params: SQLInputValue[]): { changes: number | bigint; lastInsertRowid: number | bigint } { this.#check(true); const stmt = this.#db.prepare(sql); stmt.setReadBigInts(true); return stmt.run(...params); }
  getMeta(key: string): string | undefined { return this.#get('SELECT value FROM meta WHERE key=?', key)?.value as string | undefined; }
  setMeta(key: string, value: string): void {
    if (key.startsWith('_store.')) throw new LedgerIntegrityError('Reserved store metadata');
    this.#run('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value);
  }
  getPrincipal(id: string): Principal | undefined { const r = this.#get('SELECT * FROM principals WHERE id=?', id); return r && pRow(r); }
  listPrincipal(): Principal[] { return this.#all('SELECT * FROM principals ORDER BY id').map(pRow); }
  insertPrincipal(r: Principal): void { identifier(r.id); this.#run('INSERT INTO principals VALUES(?,?,?)', r.id, r.kind, r.displayName); }
  getMembership(principalId: string, actorId: string): Membership | undefined { const r = this.#get('SELECT * FROM memberships WHERE principal_id=? AND actor_id=?', principalId, actorId); return r && mRow(r); }
  listMembership(principalId: string): Membership[] { return this.#all('SELECT * FROM memberships WHERE principal_id=? ORDER BY actor_id', principalId).map(mRow); }
  putMembership(r: Membership): void {
    identifier(r.principalId); identifier(r.actorId); revision(r.generation);
    this.#run('INSERT INTO memberships VALUES(?,?,?,?) ON CONFLICT(principal_id,actor_id) DO UPDATE SET role=excluded.role,generation=excluded.generation WHERE excluded.generation>memberships.generation', r.principalId, r.actorId, r.role, r.generation);
    const saved = this.getMembership(r.principalId, r.actorId);
    if (saved?.generation !== r.generation || saved.role !== r.role) throw new RevisionConflictError('Membership generation must advance');
  }
  getScope(id: string): Scope | undefined { const r = this.#get('SELECT * FROM scopes WHERE id=?', id); return r && sRow(r); }
  listScope(principalId: string | null): Scope[] { return this.#all('SELECT * FROM scopes WHERE principal_id IS ? ORDER BY id', principalId).map(sRow); }
  insertScope(r: Scope): void {
    identifier(r.id); if (r.principalId !== null) identifier(r.principalId); if (r.parentId !== null) identifier(r.parentId); revision(r.revision); revision(r.epoch);
    this.#run('INSERT INTO scopes VALUES(?,?,?,?,?,?,?,?,?,?)', r.id, r.principalId, r.kind, r.parentId, r.revision, r.epoch, r.state, r.reason ?? null, r.actorId ?? null, r.changedAt ?? null);
  }
  updateScope(r: Scope, expectedRevision: bigint): void {
    revision(expectedRevision); revision(r.revision); revision(r.epoch);
    if (r.revision !== expectedRevision + 1n) throw new RevisionConflictError('Scope revision must advance by one');
    const old = this.getScope(r.id);
    if (!old || old.principalId !== r.principalId || old.parentId !== r.parentId || old.kind !== r.kind || old.revision !== expectedRevision) throw new RevisionConflictError('Scope identity/revision conflict');
    if (r.epoch < old.epoch || (old.state === 'closed' && r.state !== 'closed')) throw new LedgerIntegrityError('Scope epoch cannot regress; closed scope cannot reopen');
    if (this.#run('UPDATE scopes SET revision=?,epoch=?,state=?,reason=?,actor_id=?,changed_at=? WHERE id=? AND revision=?', r.revision, r.epoch, r.state, r.reason ?? null, r.actorId ?? null, r.changedAt ?? null, r.id, expectedRevision).changes !== 1n) throw new RevisionConflictError('Scope revision conflict');
  }
  getRecord(principalId: string, id: string): StoredLedgerRecord | undefined { const r = this.#get(`${HEAD_SELECT} WHERE h.principal_id=? AND h.id=?`, principalId, id); return r && rRow(r); }
  listRecord(principalId: string, kind?: RecordKind): StoredLedgerRecord[] { return (kind === undefined ? this.#all(`${HEAD_SELECT} WHERE h.principal_id=? ORDER BY h.id`, principalId) : this.#all(`${HEAD_SELECT} WHERE h.principal_id=? AND h.kind=? ORDER BY h.id`, principalId, kind)).map(rRow); }
  getRecordVersion(principalId: string, versionId: string): StoredLedgerRecord | undefined { const r = this.#get('SELECT * FROM record_versions WHERE principal_id=? AND version_id=?', principalId, versionId); return r && rRow(r); }
  getRecordHistory(principalId: string, id: string): StoredLedgerRecord[] { return this.#all('SELECT * FROM record_versions WHERE principal_id=? AND subject_id=? ORDER BY revision', principalId, id).map(rRow); }
  insertRecord(r: LedgerRecord): void {
    identifier(r.principalId); identifier(r.id); revision(r.revision); const versionId = r.versionId ?? randomUUID(); identifier(versionId);
    this.#run('INSERT INTO record_versions VALUES(?,?,?,?,?,?)', r.principalId, versionId, r.id, r.kind, r.revision, r.data);
    this.#run('INSERT INTO record_heads VALUES(?,?,?,?,?)', r.principalId, r.id, r.kind, r.revision, versionId);
  }
  updateRecord(r: LedgerRecord, expectedRevision: bigint): void {
    revision(expectedRevision); revision(r.revision);
    if (IMMUTABLE.has(r.kind)) throw new LedgerIntegrityError('Immutable record requires a new ID');
    if (r.revision !== expectedRevision + 1n) throw new RevisionConflictError('Record revision must advance by one');
    const old = this.getRecord(r.principalId, r.id);
    if (!old || old.kind !== r.kind || old.revision !== expectedRevision) throw new RevisionConflictError('Record revision conflict');
    // A row read from the store contains its old version ID; updates create a fresh version.
    const versionId = r.versionId && r.versionId !== old.versionId ? r.versionId : randomUUID(); identifier(versionId);
    this.#run('INSERT INTO record_versions VALUES(?,?,?,?,?,?)', r.principalId, versionId, r.id, r.kind, r.revision, r.data);
    if (this.#run('UPDATE record_heads SET revision=?,current_version_id=? WHERE principal_id=? AND id=? AND kind=? AND revision=?', r.revision, versionId, r.principalId, r.id, r.kind, expectedRevision).changes !== 1n) throw new RevisionConflictError('Record revision conflict');
  }
  registerApprovalBinding(principalId: string, requestId: string, actionDigest: string): void { this.#run('INSERT INTO approval_bindings(principal_id,request_id,action_digest) VALUES(?,?,?)', principalId, requestId, actionDigest); }
  bindIntentApproval(principalId: string, intentId: string, requestId: string, actionDigest: string): void { this.#run('INSERT INTO intent_approval_bindings(principal_id,intent_id,request_id,action_digest) VALUES(?,?,?,?)', principalId, intentId, requestId, actionDigest); }
  getCommand(principalId: string, commandId: string): Command | undefined { const r = this.#get('SELECT * FROM commands WHERE principal_id=? AND command_id=?', principalId, commandId); return r && cRow(r); }
  insertCommand(r: Command): void { identifier(r.principalId); identifier(r.commandId); identifier(r.actorId); this.#run('INSERT INTO commands VALUES(?,?,?,?,?)', r.principalId, r.commandId, r.actorId, r.digest, r.receipt); }
  appendAudit(r: Omit<Audit, 'seq'>): bigint { return BigInt(this.#run('INSERT INTO audit(principal_id,command_id,kind,entity_id,created_at) VALUES(?,?,?,?,?)', r.principalId, r.commandId, r.kind, r.entityId, r.createdAt).lastInsertRowid); }
  listAudit(principalId: string): Audit[] { return this.#all('SELECT * FROM audit WHERE principal_id=? ORDER BY seq', principalId).map(aRow); }
}

async function canonicalPath(input: string): Promise<{ path: string; existed: boolean }> {
  const absolute = resolve(input);
  let canonical: string;
  let existed = true;
  try {
    const info = await lstat(absolute);
    canonical = await realpath(absolute);
    const target = info.isSymbolicLink() ? await stat(canonical) : info;
    if (!target.isFile() || target.nlink !== 1) throw new LedgerIntegrityError('Ledger must be a regular file with no hard-link aliases');
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    // The host chooses/creates an authorized directory. A dangling link is not a new DB.
    try { await lstat(absolute); throw new LedgerIntegrityError('Dangling ledger link'); } catch (probe) { if (!(probe && typeof probe === 'object' && 'code' in probe && probe.code === 'ENOENT')) throw probe; }
    canonical = join(await realpath(dirname(absolute)), basename(absolute));
    existed = false;
  }
  return { path: process.platform === 'win32' ? canonical.toLowerCase() : canonical, existed };
}
function ownerLock(path: string): Promise<Server> {
  const hash = createHash('sha256').update(path).digest('hex');
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\orgmanage-ledger-${hash}` : join(dirname(path), `.orgmanage-${hash.slice(0, 28)}.sock`);
  return new Promise((resolveLock, rejectLock) => {
    const server = createServer(socket => socket.destroy());
    const failed = (error: Error) => { server.close(); rejectLock(new LedgerOwnerError('Exclusive ledger owner is unavailable', { cause: error })); };
    server.once('error', failed);
    server.listen({ path: address, exclusive: true }, () => { server.off('error', failed); server.on('error', () => { server.close(); }); resolveLock(server); });
  });
}
async function closeLock(lock: Server): Promise<void> { await new Promise<void>((done, reject) => { lock.close(error => { if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error); else done(); }); }); }

export class LedgerStore {
  #closed = false;
  #inCallback = false;
  #writeAccess: LedgerTransaction | null = null;
  #db: DatabaseSync;
  #lock: Server;
  #ownerEpoch: bigint;
  private constructor(readonly path: string, readonly ownerId: string, db: DatabaseSync, lock: Server, ownerEpoch: bigint) { this.#db = db; this.#lock = lock; this.#ownerEpoch = ownerEpoch; }
  get ownerEpoch(): bigint { return this.#ownerEpoch; }
  static async open(input: string, options: { ownerId?: string } = {}): Promise<LedgerStore> {
    const ownerId = options.ownerId ?? randomUUID(); identifier(ownerId);
    const target = await canonicalPath(input);
    const lock = await ownerLock(target.path);
    let db: DatabaseSync | undefined;
    try {
      const current = await canonicalPath(input);
      if (current.path !== target.path || current.existed !== target.existed) throw new LedgerIntegrityError('Ledger path changed while acquiring ownership');
      if (current.existed && (await stat(current.path)).size === 0) throw new LedgerIntegrityError('Existing empty database is not an uninitialized OrgManage ledger');
      db = new DatabaseSync(target.path, { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false, timeout: 75, readBigInts: true, defensive: true });
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=75');
      if (db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1n) throw new LedgerIntegrityError('Foreign key enforcement unavailable');
      if (!target.existed) {
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const sql of SCHEMA) db.exec(sql);
          db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('_store.version', VERSION);
          db.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('_store.schema_hash', LEDGER_SCHEMA_HASH);
          db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=8; COMMIT`);
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      }
      const storedVersion = db.prepare('PRAGMA user_version').get()?.user_version;
      if (db.prepare('PRAGMA application_id').get()?.application_id !== BigInt(APPLICATION_ID) || ![1n,2n,3n,4n,5n,6n,7n,8n].includes(storedVersion as bigint)) throw new LedgerIntegrityError('Unknown database identity/version');
      const actualSql = db.prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all().map(r => r.sql as string);
      const expectedHash = storedVersion === 1n ? LEGACY_SCHEMA_HASH : storedVersion === 2n ? V2_SCHEMA_HASH : storedVersion === 3n ? V3_SCHEMA_HASH : storedVersion === 4n ? V4_SCHEMA_HASH : storedVersion === 5n ? V5_SCHEMA_HASH : storedVersion === 6n ? V6_SCHEMA_HASH : storedVersion === 7n ? V7_SCHEMA_HASH : LEDGER_SCHEMA_HASH;
      const expectedVersion = `orgmanage-local-ledger-v${storedVersion}`;
      if (schemaHash(actualSql) !== expectedHash || db.prepare("SELECT value FROM meta WHERE key='_store.schema_hash'").get()?.value !== expectedHash || db.prepare("SELECT value FROM meta WHERE key='_store.version'").get()?.value !== expectedVersion) throw new LedgerIntegrityError('Database schema identity mismatch');
      const check = db.prepare('PRAGMA quick_check').all();
      if (check.length !== 1 || check[0]?.quick_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length !== 0) throw new LedgerIntegrityError('Database integrity check failed');
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
      if (db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'wal' || db.prepare('PRAGMA synchronous').get()?.synchronous !== 2n) throw new LedgerIntegrityError('Required durable journal settings unavailable');
      if (storedVersion !== 8n) {
        // Exact known v1-v7 only. DDL commits atomically, preserving business rows.
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const sql of [...(storedVersion === 1n ? RUNNER_SCHEMA : []), ...((storedVersion as bigint)<3n ? NATIVE_SCHEMA : []), ...((storedVersion as bigint)<4n ? CANDIDATE_SCHEMA : []), ...((storedVersion as bigint)<5n ? CANDIDATE_EVALUATION_SCHEMA : []), ...((storedVersion as bigint)<6n ? CANDIDATE_ARTIFACT_SCHEMA : []), ...((storedVersion as bigint)<7n ? CANDIDATE_OUTCOME_SCHEMA : [])]) db.exec(sql);
          db.exec('DROP TRIGGER candidate_base_contract');db.exec(CANDIDATE_CONTRACT_V8);
          db.prepare("UPDATE meta SET value=? WHERE key='_store.schema_hash'").run(LEDGER_SCHEMA_HASH);
          db.prepare("UPDATE meta SET value=? WHERE key='_store.version'").run(VERSION);
          db.exec('PRAGMA user_version=8');
          const migrated = db.prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all().map(r=>r.sql as string);
          if (schemaHash(migrated)!==LEDGER_SCHEMA_HASH || db.prepare('PRAGMA foreign_key_check').all().length) throw new LedgerIntegrityError('Ledger migration verification failed');
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      }
      const after = await canonicalPath(input);
      if (after.path !== target.path) throw new LedgerIntegrityError('Ledger identity changed during open');
      db.exec('BEGIN IMMEDIATE');
      let ownerEpoch: bigint;
      try {
        const oldEpoch = db.prepare("SELECT value FROM meta WHERE key='_store.owner_epoch'").get()?.value;
        if (oldEpoch !== undefined && (typeof oldEpoch !== 'string' || !/^[1-9][0-9]{0,17}$/.test(oldEpoch))) throw new LedgerIntegrityError('Invalid stored owner epoch');
        ownerEpoch = oldEpoch === undefined ? 1n : BigInt(oldEpoch as string) + 1n; revision(ownerEpoch);
        db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('_store.owner_id', ownerId);
        db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('_store.owner_epoch', ownerEpoch.toString());
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return new LedgerStore(target.path, ownerId, db, lock, ownerEpoch);
    } catch (error) { try { db?.close(); } finally { await closeLock(lock); } return failure(error); }
  }
  #owned(): boolean { return !this.#closed && this.#lock.listening; }
  #use<T>(writable: boolean, fn: (tx: LedgerTransaction) => T): T {
    if (!this.#owned()) throw new LedgerOwnerError('Ledger ownership is unavailable');
    if (this.#inCallback) throw new LedgerOwnerError('Nested ledger callbacks are forbidden');
    this.#inCallback = true;
    const access = new Access(this.#db, writable, () => this.#owned());
    let begun = false;
    try {
      if (!writable) this.#db.exec('PRAGMA query_only=ON');
      this.#db.exec(writable ? 'BEGIN IMMEDIATE' : 'BEGIN'); begun = true;
      if (this.#db.prepare("SELECT value FROM meta WHERE key='_store.owner_id'").get()?.value !== this.ownerId || this.#db.prepare("SELECT value FROM meta WHERE key='_store.owner_epoch'").get()?.value !== this.#ownerEpoch.toString()) throw new LedgerOwnerError('Persisted ledger ownership changed');
      this.#writeAccess = writable ? access : null;
      const result = synchronous(fn(access));
      access.invalidate();
      this.#db.exec('COMMIT'); begun = false;
      return result;
    } catch (error) {
      if (begun) this.#db.exec('ROLLBACK');
      // Preserve core's domain error. SQLite errors are translated to store errors.
      if (error && typeof error === 'object' && 'errcode' in error) return failure(error);
      throw error;
    } finally { this.#writeAccess = null; access.invalidate(); if (!writable) this.#db.exec('PRAGMA query_only=OFF'); this.#inCallback = false; }
  }
  /** Trusted coordinator composition only; rejects foreign, read-only and expired callbacks. */
  assertTransaction(tx: LedgerTransaction): void {
    if (!this.#owned() || this.#writeAccess !== tx || !this.#inCallback) throw new LedgerOwnerError('Active transaction from this ledger required');
  }
  transaction<T>(fn: (tx: LedgerTransaction) => T): T { return this.#use(true, fn); }
  read<T>(fn: (tx: LedgerReader) => T): T { return this.#use(false, fn); }
  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#inCallback) throw new LedgerOwnerError('Cannot close inside a ledger callback');
    this.#closed = true;
    try { this.#db.close(); } finally { await closeLock(this.#lock); }
  }
}
