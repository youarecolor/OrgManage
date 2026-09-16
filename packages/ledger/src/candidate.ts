import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';

export interface CandidateBaseRecord {
  principalId: string; id: string; missionId: string; commandId: string; contractId: string;
  leaseId: string; workspaceId: string; generation: bigint; profileDigest: string;
  snapshotDigest: string; treeDigest: string; writeSetDigest: string; createdAt: number;
}
export interface CandidateProposalRecord {
  principalId: string; id: string; baseId: string; patchDigest: string;
  afterDigest: string; afterTreeDigest: string; createdAt: number;
}
const hash = (c: string) => `length(${c})=64 AND ${c} NOT GLOB '*[^0-9a-f]*'`;
// These relations bind immutable evidence data. They do not designate collected ArtifactRevision,
// executable code, an application receipt, a verification result, or an adoption decision.
export const CANDIDATE_SCHEMA = [
  `CREATE TABLE candidate_bases(principal_id TEXT NOT NULL, id TEXT NOT NULL, evidence_kind TEXT NOT NULL DEFAULT 'evidence' CHECK(evidence_kind='evidence'), mission_id TEXT NOT NULL, command_id TEXT NOT NULL, contract_id TEXT NOT NULL, contract_kind TEXT NOT NULL DEFAULT 'contract' CHECK(contract_kind='contract'), lease_id TEXT NOT NULL REFERENCES runner_leases(id), workspace_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 999999999999999999), profile_digest TEXT NOT NULL CHECK(${hash('profile_digest')}), snapshot_digest TEXT NOT NULL CHECK(${hash('snapshot_digest')}), tree_digest TEXT NOT NULL CHECK(${hash('tree_digest')}), write_set_digest TEXT NOT NULL CHECK(${hash('write_set_digest')}), created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991), PRIMARY KEY(principal_id,id), UNIQUE(principal_id,lease_id), FOREIGN KEY(principal_id,id,evidence_kind) REFERENCES record_heads(principal_id,id,kind), FOREIGN KEY(principal_id,mission_id) REFERENCES scopes(principal_id,id), FOREIGN KEY(principal_id,command_id) REFERENCES commands(principal_id,command_id), FOREIGN KEY(principal_id,contract_id,contract_kind) REFERENCES record_heads(principal_id,id,kind), FOREIGN KEY(principal_id,workspace_id) REFERENCES runner_workspaces(principal_id,id)) STRICT`,
  `CREATE TRIGGER candidate_base_binding BEFORE INSERT ON candidate_bases WHEN NOT EXISTS(SELECT 1 FROM runner_leases l JOIN runner_workspaces w ON w.id=l.workspace_id JOIN scopes s ON s.id=l.scope_id WHERE l.id=NEW.lease_id AND l.principal_id=NEW.principal_id AND l.workspace_id=NEW.workspace_id AND l.generation=NEW.generation AND l.scope_id=NEW.mission_id AND l.state='active' AND l.stop_epoch=0 AND l.dispatched=0 AND NEW.created_at>=l.updated_at AND NEW.created_at<l.expires_at AND w.generation=NEW.generation AND w.state='ready' AND w.profile_digest=NEW.profile_digest AND w.snapshot_digest=NEW.tree_digest AND w.write_set_digest=NEW.write_set_digest AND s.kind='mission' AND s.state='active') BEGIN SELECT RAISE(ABORT,'candidate lease binding mismatch'); END`,
  `CREATE TRIGGER candidate_base_data BEFORE INSERT ON candidate_bases WHEN NOT EXISTS(SELECT 1 FROM record_heads h JOIN record_versions v ON v.principal_id=h.principal_id AND v.version_id=h.current_version_id WHERE h.principal_id=NEW.principal_id AND h.id=NEW.id AND h.kind='evidence' AND json_extract(v.data,'$.format')='candidate_base_v1' AND json_extract(v.data,'$.snapshot.digest')=NEW.snapshot_digest AND json_extract(v.data,'$.snapshot.treeDigest')=NEW.tree_digest AND json_extract(v.data,'$.snapshot.binding.principalId')=NEW.principal_id AND json_extract(v.data,'$.snapshot.binding.missionId')=NEW.mission_id AND json_extract(v.data,'$.snapshot.binding.commandId')=NEW.command_id AND json_extract(v.data,'$.snapshot.binding.workspaceId')=NEW.workspace_id AND json_extract(v.data,'$.snapshot.binding.leaseId')=NEW.lease_id AND json_extract(v.data,'$.snapshot.binding.generation')=CAST(NEW.generation AS TEXT) AND json_extract(v.data,'$.snapshot.binding.profileDigest')=NEW.profile_digest) BEGIN SELECT RAISE(ABORT,'candidate snapshot evidence mismatch'); END`,
  `CREATE TRIGGER candidate_base_contract BEFORE INSERT ON candidate_bases WHEN NOT EXISTS(SELECT 1 FROM record_heads h JOIN record_versions v ON v.principal_id=h.principal_id AND v.version_id=h.current_version_id WHERE h.principal_id=NEW.principal_id AND h.id=NEW.mission_id AND h.kind='mission' AND json_extract(v.data,'$.contractRef')=NEW.contract_id) BEGIN SELECT RAISE(ABORT,'candidate mission contract mismatch'); END`,
  `CREATE TABLE candidate_proposals(principal_id TEXT NOT NULL,id TEXT NOT NULL,evidence_kind TEXT NOT NULL DEFAULT 'evidence' CHECK(evidence_kind='evidence'),base_id TEXT NOT NULL,patch_digest TEXT NOT NULL CHECK(${hash('patch_digest')}),after_digest TEXT NOT NULL CHECK(${hash('after_digest')}),after_tree_digest TEXT NOT NULL CHECK(${hash('after_tree_digest')}),created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),PRIMARY KEY(principal_id,id),UNIQUE(principal_id,base_id),FOREIGN KEY(principal_id,id,evidence_kind) REFERENCES record_heads(principal_id,id,kind),FOREIGN KEY(principal_id,base_id) REFERENCES candidate_bases(principal_id,id)) STRICT`,
  `CREATE TRIGGER candidate_proposal_data BEFORE INSERT ON candidate_proposals WHEN NOT EXISTS(SELECT 1 FROM candidate_bases b JOIN record_heads h ON h.principal_id=b.principal_id AND h.id=NEW.id JOIN record_versions v ON v.principal_id=h.principal_id AND v.version_id=h.current_version_id JOIN record_heads bh ON bh.principal_id=b.principal_id AND bh.id=b.id JOIN record_versions bv ON bv.principal_id=bh.principal_id AND bv.version_id=bh.current_version_id WHERE b.principal_id=NEW.principal_id AND b.id=NEW.base_id AND h.kind='evidence' AND NEW.created_at>=b.created_at AND json_extract(v.data,'$.format')='candidate_proposal_v1' AND json_extract(v.data,'$.after.digest')=NEW.after_digest AND json_extract(v.data,'$.after.treeDigest')=NEW.after_tree_digest AND json_extract(v.data,'$.after.binding')=json_extract(bv.data,'$.snapshot.binding') AND json_extract(v.data,'$.after.writeSet')=json_extract(bv.data,'$.snapshot.writeSet') AND NEW.after_tree_digest!=b.tree_digest) BEGIN SELECT RAISE(ABORT,'candidate proposal evidence mismatch'); END`,
  ...['candidate_bases', 'candidate_proposals'].flatMap(table => [
    `CREATE TRIGGER ${table}_immutable_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'candidate evidence link is immutable'); END`,
    `CREATE TRIGGER ${table}_immutable_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'candidate evidence link cannot be deleted'); END`,
  ]),
];
// v8 resolves native version references while retaining the contract-head FK.
// The independent immutable evidence must bind the same ref, head and version.
export const CANDIDATE_CONTRACT_V8 = `CREATE TRIGGER candidate_base_contract BEFORE INSERT ON candidate_bases WHEN NOT EXISTS(SELECT 1 FROM record_heads h JOIN record_versions v ON v.principal_id=h.principal_id AND v.version_id=h.current_version_id JOIN record_heads c ON c.principal_id=h.principal_id AND c.id=NEW.contract_id AND c.kind='contract' JOIN record_heads b ON b.principal_id=h.principal_id AND b.id=NEW.id AND b.kind='evidence' JOIN record_versions bv ON bv.principal_id=b.principal_id AND bv.version_id=b.current_version_id WHERE h.principal_id=NEW.principal_id AND h.id=NEW.mission_id AND h.kind='mission' AND (json_extract(v.data,'$.contractRef')=c.id OR json_extract(v.data,'$.contractRef')=c.current_version_id) AND ((json_type(bv.data,'$.contractBinding') IS NULL AND json_extract(v.data,'$.contractRef')=c.id) OR (json_extract(bv.data,'$.contractBinding.ref')=json_extract(v.data,'$.contractRef') AND json_extract(bv.data,'$.contractBinding.id')=c.id AND json_extract(bv.data,'$.contractBinding.versionId')=c.current_version_id))) BEGIN SELECT RAISE(ABORT,'candidate mission contract mismatch'); END`;
export interface CandidateReader {
  getBase(p: string, id: string): CandidateBaseRecord | undefined;
  baseForLease(p: string, leaseId: string): CandidateBaseRecord | undefined;
  getProposal(p: string, id: string): CandidateProposalRecord | undefined;
  proposalForBase(p: string, baseId: string): CandidateProposalRecord | undefined;
  listBases(p: string, missionId: string): CandidateBaseRecord[];
}
export interface CandidateTransaction extends CandidateReader {
  insertBase(row: CandidateBaseRecord): void;
  insertProposal(row: CandidateProposalRecord): void;
}
type Row = Record<string, SQLOutputValue>;
type Get = (sql: string, ...args: SQLInputValue[]) => Row | undefined;
type All = (sql: string, ...args: SQLInputValue[]) => Row[];
type Run = (sql: string, ...args: SQLInputValue[]) => unknown;
const base = (r: Row): CandidateBaseRecord => ({ principalId: r.principal_id as string, id: r.id as string,
  missionId: r.mission_id as string, commandId: r.command_id as string, contractId: r.contract_id as string,
  leaseId: r.lease_id as string, workspaceId: r.workspace_id as string, generation: r.generation as bigint,
  profileDigest: r.profile_digest as string, snapshotDigest: r.snapshot_digest as string, treeDigest: r.tree_digest as string,
  writeSetDigest: r.write_set_digest as string, createdAt: Number(r.created_at) });
const proposal = (r: Row): CandidateProposalRecord => ({ principalId: r.principal_id as string, id: r.id as string,
  baseId: r.base_id as string, patchDigest: r.patch_digest as string, afterDigest: r.after_digest as string,
  afterTreeDigest: r.after_tree_digest as string, createdAt: Number(r.created_at) });
export class CandidateAccess implements CandidateTransaction {
  #get: Get; #all: All; #run: Run;
  constructor(get: Get, all: All, run: Run) { this.#get=get;this.#all=all;this.#run=run; }
  getBase(p: string, id: string): CandidateBaseRecord | undefined { const r=this.#get('SELECT * FROM candidate_bases WHERE principal_id=? AND id=?',p,id);return r&&base(r); }
  baseForLease(p: string, leaseId: string): CandidateBaseRecord | undefined { const r=this.#get('SELECT * FROM candidate_bases WHERE principal_id=? AND lease_id=?',p,leaseId);return r&&base(r); }
  getProposal(p: string, id: string): CandidateProposalRecord | undefined { const r=this.#get('SELECT * FROM candidate_proposals WHERE principal_id=? AND id=?',p,id);return r&&proposal(r); }
  proposalForBase(p: string, baseId: string): CandidateProposalRecord | undefined { const r=this.#get('SELECT * FROM candidate_proposals WHERE principal_id=? AND base_id=?',p,baseId);return r&&proposal(r); }
  listBases(p: string, missionId: string): CandidateBaseRecord[] { return this.#all('SELECT * FROM candidate_bases WHERE principal_id=? AND mission_id=? ORDER BY created_at,id',p,missionId).map(base); }
  insertBase(r: CandidateBaseRecord): void { this.#run('INSERT INTO candidate_bases(principal_id,id,mission_id,command_id,contract_id,lease_id,workspace_id,generation,profile_digest,snapshot_digest,tree_digest,write_set_digest,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',r.principalId,r.id,r.missionId,r.commandId,r.contractId,r.leaseId,r.workspaceId,r.generation,r.profileDigest,r.snapshotDigest,r.treeDigest,r.writeSetDigest,r.createdAt); }
  insertProposal(r: CandidateProposalRecord): void { this.#run('INSERT INTO candidate_proposals(principal_id,id,base_id,patch_digest,after_digest,after_tree_digest,created_at) VALUES(?,?,?,?,?,?,?)',r.principalId,r.id,r.baseId,r.patchDigest,r.afterDigest,r.afterTreeDigest,r.createdAt); }
}
