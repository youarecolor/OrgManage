import { createHash } from 'node:crypto';
import { strictJson } from '../../contracts/src/wire.js';

/** Data-only boundary. This module never reads paths, executes code, or grants a lease. */
export const CANDIDATE_LIMITS = Object.freeze({ files: 32, fileBytes: 64 * 1024, treeBytes: 192 * 1024 });
export interface CandidateBinding {
  readonly principalId: string;
  readonly missionId: string;
  readonly commandId: string;
  readonly workspaceId: string;
  readonly leaseId: string;
  readonly generation: string;
  readonly profileDigest: string;
}
export interface CandidateFile { readonly path: string; readonly text: string; readonly digest: string }
export interface CandidateSnapshot {
  readonly version: 'CANDIDATE-TEXT-v1';
  readonly binding: Readonly<CandidateBinding>;
  readonly writeSet: readonly string[];
  readonly files: readonly Readonly<CandidateFile>[];
  readonly treeDigest: string;
  readonly digest: string;
}
export interface CandidateProposal {
  readonly version: 'CANDIDATE-PROPOSAL-v1';
  readonly base: CandidateSnapshot;
  readonly after: CandidateSnapshot;
  readonly patchDigest: string;
  readonly changedPaths: readonly string[];
  readonly status: 'unverified';
}
const snapshots = new WeakSet<object>();
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function check(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'OBJECT_REQUIRED');
  check(Object.keys(value).sort().join('|') === [...keys].sort().join('|'), 'UNEXPECTED_FIELDS');
  return value as Record<string, unknown>;
}
function path(value: unknown): string {
  // A deliberately small cross-platform namespace: no ADS, devices, hidden paths, or aliases.
  check(typeof value === 'string' && value.length <= 180, 'INVALID_PATH');
  const parts = value.split('/');
  check(parts.length <= 12 && parts.every(p => /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(p)
    && !p.endsWith('.') && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)), 'INVALID_PATH');
  check(!parts.some(p => /^(node_modules|dist|\.git)$/i.test(p)), 'EXCLUDED_PATH');
  return value;
}
function text(value: unknown): string {
  check(typeof value === 'string' && value.isWellFormed() && !value.includes('\0'), 'INVALID_TEXT');
  check(Buffer.byteLength(value) <= CANDIDATE_LIMITS.fileBytes, 'FILE_LIMIT');
  return value;
}
function binding(value: CandidateBinding): Readonly<CandidateBinding> {
  const v = object(value, ['principalId', 'missionId', 'commandId', 'workspaceId', 'leaseId', 'generation', 'profileDigest']);
  for (const key of ['principalId', 'missionId', 'commandId', 'workspaceId', 'leaseId']) {
    check(typeof v[key] === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v[key]), 'INVALID_BINDING');
  }
  check(typeof v.generation === 'string' && /^[1-9][0-9]{0,17}$/.test(v.generation), 'INVALID_GENERATION');
  check(typeof v.profileDigest === 'string' && /^[0-9a-f]{64}$/.test(v.profileDigest), 'INVALID_PROFILE');
  return Object.freeze({ principalId: value.principalId, missionId: value.missionId, commandId: value.commandId,
    workspaceId: value.workspaceId, leaseId: value.leaseId, generation: value.generation, profileDigest: value.profileDigest });
}
function paths(values: readonly string[]): readonly string[] {
  check(Array.isArray(values) && values.length > 0 && values.length <= CANDIDATE_LIMITS.files, 'PATH_COUNT');
  const result = values.map(path).sort();
  const folded = result.map(p => p.toLowerCase()).sort();
  const known = new Set(folded);
  check(known.size === folded.length, 'PATH_COLLISION');
  for (const name of folded) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) check(!known.has(parts.slice(0, i).join('/')), 'PATH_COLLISION');
  }
  for (let i = 1; i < folded.length; i++) {
    check(folded[i] !== folded[i - 1] && !folded[i]!.startsWith(folded[i - 1]! + '/'), 'PATH_COLLISION');
  }
  return Object.freeze(result);
}
/** The caller is the trusted snapshot selector; incoming candidate data cannot choose writeSet. */
export function createCandidateSnapshot(scope: CandidateBinding, inputs: readonly { path: string; text: string }[], writeSet: readonly string[]): CandidateSnapshot {
  const b = binding(scope);
  check(Array.isArray(inputs) && inputs.length > 0 && inputs.length <= CANDIDATE_LIMITS.files, 'FILE_COUNT');
  const names = paths(inputs.map(f => f.path)), writes = paths(writeSet);
  const input = new Map(inputs.map(f => [f.path, text(f.text)]));
  check(writes.every(p => input.has(p)), 'WRITE_SET_OUTSIDE_SNAPSHOT');
  // v1 only supports replacements. Tests, runtime configuration and authority cannot be edited.
  check(writes.every(p => /^(apps\/home\/src|packages\/[a-z0-9-]+\/src)\/.+\.(ts|tsx|css)$/.test(p)
    && !/(^|\/)(AGENTS|SKILL)\.md$/i.test(p)), 'PROTECTED_WRITE');
  const files = Object.freeze(names.map(p => Object.freeze({ path: p, text: input.get(p)!, digest: sha(input.get(p)!) })));
  check(files.reduce((n, f) => n + Buffer.byteLength(f.text), 0) <= CANDIDATE_LIMITS.treeBytes, 'TREE_LIMIT');
  const treeDigest = sha(JSON.stringify(files.map(f => [f.path, f.digest])));
  const body = { version: 'CANDIDATE-TEXT-v1' as const, binding: b, writeSet: writes, files, treeDigest };
  const snapshot = Object.freeze({ ...body, digest: sha(JSON.stringify(body)) });
  check(Buffer.byteLength(JSON.stringify(snapshot)) <= 256 * 1024, 'SNAPSHOT_WIRE_LIMIT');
  snapshots.add(snapshot);
  return snapshot;
}

/** Full-file replacements avoid applying candidate-provided shell commands or fuzzy hunks. */
export function importCandidatePatch(base: CandidateSnapshot, bytes: Uint8Array): CandidateProposal {
  check(snapshots.has(base), 'UNSEALED_BASE');
  const decoded = strictJson(bytes);
  check(decoded.ok, 'INVALID_PATCH_WIRE');
  const patch = object(decoded.value, ['version', 'baseDigest', 'changes']);
  check(patch.version === 'CANDIDATE-PATCH-v1' && patch.baseDigest === base.digest, 'STALE_OR_FOREIGN_BASE');
  check(Array.isArray(patch.changes) && patch.changes.length > 0 && patch.changes.length <= base.writeSet.length, 'CHANGE_COUNT');
  const changes = patch.changes.map(raw => {
    const item = object(raw, ['path', 'beforeDigest', 'text']);
    const name = path(item.path), value = text(item.text), before = base.files.find(f => f.path === name);
    check(base.writeSet.includes(name) && before && item.beforeDigest === before.digest, 'WRITE_OR_BASE_MISMATCH');
    check(value !== before.text, 'NO_CHANGE');
    return { path: name, text: value };
  });
  const changedPaths = paths(changes.map(c => c.path));
  const after = createCandidateSnapshot(base.binding, base.files.map(f => changes.find(c => c.path === f.path) ?? f), base.writeSet);
  return Object.freeze({ version: 'CANDIDATE-PROPOSAL-v1', base, after, patchDigest: sha(bytes), changedPaths, status: 'unverified' });
}

export function candidateSnapshotBytes(snapshot: CandidateSnapshot): Uint8Array {
  check(snapshots.has(snapshot), 'UNSEALED_BASE');
  return Buffer.from(JSON.stringify(snapshot));
}

/** Reopen only against a separately persisted trusted digest. The blob never supplies its authority. */
export function reopenCandidateSnapshot(bytes: Uint8Array, expectedDigest: string): CandidateSnapshot {
  check(/^[0-9a-f]{64}$/.test(expectedDigest), 'EXPECTED_DIGEST_REQUIRED');
  const decoded = strictJson(bytes);
  check(decoded.ok, 'INVALID_SNAPSHOT_WIRE');
  const raw = object(decoded.value, ['version', 'binding', 'writeSet', 'files', 'treeDigest', 'digest']);
  check(raw.version === 'CANDIDATE-TEXT-v1' && Array.isArray(raw.files) && Array.isArray(raw.writeSet), 'INVALID_SNAPSHOT');
  const files = raw.files.map(f => {
    const v = object(f, ['path', 'text', 'digest']);
    check(typeof v.digest === 'string' && v.digest === sha(text(v.text)), 'FILE_DIGEST_MISMATCH');
    return { path: path(v.path), text: text(v.text) };
  });
  const result = createCandidateSnapshot(raw.binding as unknown as CandidateBinding, files, raw.writeSet as string[]);
  check(result.treeDigest === raw.treeDigest && result.digest === raw.digest && result.digest === expectedDigest, 'SNAPSHOT_DIGEST_MISMATCH');
  return result;
}
