import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';

export interface CandidateEvaluationPlanRow { principalId:string; id:string; proposalId:string; planDigest:string; createdAt:number }
export interface CandidateEvaluationAttemptRow { principalId:string; id:string; planId:string; ownerId:string; ownerEpoch:bigint; createdAt:number }
export interface CandidateEvaluationResultRow { principalId:string; id:string; attemptId:string; sequence:bigint; receiptDigest:string; status:'passed'|'failed'|'unknown'|'quarantined'; createdAt:number }
const digest=(c:string)=>`length(${c})=64 AND ${c} NOT GLOB '*[^0-9a-f]*'`;
const evidenceFk=`FOREIGN KEY(principal_id,id,evidence_kind) REFERENCES record_heads(principal_id,id,kind)`;
export const CANDIDATE_EVALUATION_SCHEMA=[
  `CREATE TABLE candidate_evaluation_plans(principal_id TEXT NOT NULL,id TEXT NOT NULL,evidence_kind TEXT NOT NULL DEFAULT 'evidence' CHECK(evidence_kind='evidence'),proposal_id TEXT NOT NULL,plan_digest TEXT NOT NULL CHECK(${digest('plan_digest')}),created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),PRIMARY KEY(principal_id,id),${evidenceFk},FOREIGN KEY(principal_id,proposal_id) REFERENCES candidate_proposals(principal_id,id)) STRICT`,
  `CREATE TRIGGER candidate_evaluation_plan_data BEFORE INSERT ON candidate_evaluation_plans WHEN NOT EXISTS(SELECT 1 FROM record_heads h JOIN record_versions v ON v.principal_id=h.principal_id AND v.version_id=h.current_version_id WHERE h.principal_id=NEW.principal_id AND h.id=NEW.id AND json_extract(v.data,'$.format')='candidate_evaluation_plan_v1' AND json_extract(v.data,'$.plan.digest')=NEW.plan_digest AND json_extract(v.data,'$.plan.proposalId')=NEW.proposal_id AND json_extract(v.data,'$.plan.principalId')=NEW.principal_id AND json_extract(v.data,'$.plan.id')=NEW.id) BEGIN SELECT RAISE(ABORT,'evaluation plan data mismatch'); END`,
  `CREATE TABLE candidate_evaluation_attempts(principal_id TEXT NOT NULL,id TEXT NOT NULL,evidence_kind TEXT NOT NULL DEFAULT 'evidence' CHECK(evidence_kind='evidence'),plan_id TEXT NOT NULL,owner_id TEXT NOT NULL,owner_epoch INTEGER NOT NULL CHECK(owner_epoch BETWEEN 1 AND 999999999999999999),created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),PRIMARY KEY(principal_id,id),UNIQUE(principal_id,plan_id),${evidenceFk},FOREIGN KEY(principal_id,plan_id) REFERENCES candidate_evaluation_plans(principal_id,id)) STRICT`,
  `CREATE TRIGGER candidate_evaluation_attempt_data BEFORE INSERT ON candidate_evaluation_attempts WHEN NOT EXISTS(SELECT 1 FROM record_heads h JOIN record_versions v ON v.principal_id=h.principal_id AND v.version_id=h.current_version_id JOIN candidate_evaluation_plans p ON p.principal_id=NEW.principal_id AND p.id=NEW.plan_id WHERE h.principal_id=NEW.principal_id AND h.id=NEW.id AND json_extract(v.data,'$.format')='candidate_evaluation_dispatch_v1' AND json_extract(v.data,'$.planId')=NEW.plan_id AND json_extract(v.data,'$.ownerId')=NEW.owner_id AND json_extract(v.data,'$.ownerEpoch')=CAST(NEW.owner_epoch AS TEXT) AND NEW.created_at>=p.created_at) BEGIN SELECT RAISE(ABORT,'evaluation dispatch data mismatch'); END`,
  `CREATE TABLE candidate_evaluation_results(principal_id TEXT NOT NULL,id TEXT NOT NULL,evidence_kind TEXT NOT NULL DEFAULT 'evidence' CHECK(evidence_kind='evidence'),attempt_id TEXT NOT NULL,sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 999999999999999999),receipt_digest TEXT NOT NULL CHECK(${digest('receipt_digest')}),status TEXT NOT NULL CHECK(status IN ('passed','failed','unknown','quarantined')),created_at INTEGER NOT NULL CHECK(created_at BETWEEN 0 AND 9007199254740991),PRIMARY KEY(principal_id,id),UNIQUE(principal_id,attempt_id,sequence),${evidenceFk},FOREIGN KEY(principal_id,attempt_id) REFERENCES candidate_evaluation_attempts(principal_id,id)) STRICT`,
  `CREATE TRIGGER candidate_evaluation_result_chain BEFORE INSERT ON candidate_evaluation_results WHEN NEW.sequence!=1+COALESCE((SELECT MAX(sequence) FROM candidate_evaluation_results WHERE principal_id=NEW.principal_id AND attempt_id=NEW.attempt_id),0) OR EXISTS(SELECT 1 FROM candidate_evaluation_results WHERE principal_id=NEW.principal_id AND attempt_id=NEW.attempt_id AND status!='unknown') OR NOT EXISTS(SELECT 1 FROM candidate_evaluation_attempts a JOIN record_heads h ON h.principal_id=a.principal_id AND h.id=NEW.id JOIN record_versions v ON v.principal_id=h.principal_id AND v.version_id=h.current_version_id WHERE a.principal_id=NEW.principal_id AND a.id=NEW.attempt_id AND NEW.created_at>=a.created_at AND json_extract(v.data,'$.format')='candidate_evaluation_result_v1' AND json_extract(v.data,'$.attemptId')=NEW.attempt_id AND json_extract(v.data,'$.status')=NEW.status AND json_extract(v.data,'$.receiptDigest')=NEW.receipt_digest) BEGIN SELECT RAISE(ABORT,'evaluation result chain mismatch'); END`,
  ...['candidate_evaluation_plans','candidate_evaluation_attempts','candidate_evaluation_results'].flatMap(t=>[
    `CREATE TRIGGER ${t}_immutable_update BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT,'evaluation evidence immutable'); END`,
    `CREATE TRIGGER ${t}_immutable_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT,'evaluation evidence immutable'); END`,
  ]),
];
export interface CandidateEvaluationReader {
  listPlans(p:string):CandidateEvaluationPlanRow[];
  getPlan(p:string,id:string):CandidateEvaluationPlanRow|undefined;
  attemptForPlan(p:string,id:string):CandidateEvaluationAttemptRow|undefined;
  results(p:string,attemptId:string):CandidateEvaluationResultRow[];
}
export interface CandidateEvaluationTransaction extends CandidateEvaluationReader {
  insertPlan(row:CandidateEvaluationPlanRow):void;
  insertAttempt(row:CandidateEvaluationAttemptRow):void;
  insertResult(row:CandidateEvaluationResultRow):void;
}
type Row=Record<string,SQLOutputValue>;
type Get=(sql:string,...args:SQLInputValue[])=>Row|undefined;
type All=(sql:string,...args:SQLInputValue[])=>Row[];
type Run=(sql:string,...args:SQLInputValue[])=>unknown;
export class CandidateEvaluationAccess implements CandidateEvaluationTransaction {
  #get:Get; #all:All; #run:Run;
  constructor(get:Get,all:All,run:Run){this.#get=get;this.#all=all;this.#run=run;}
  listPlans(p:string):CandidateEvaluationPlanRow[]{return this.#all('SELECT * FROM candidate_evaluation_plans WHERE principal_id=? ORDER BY created_at,id',p).map(r=>({principalId:p,id:r.id as string,proposalId:r.proposal_id as string,planDigest:r.plan_digest as string,createdAt:Number(r.created_at)}));}
  getPlan(p:string,id:string):CandidateEvaluationPlanRow|undefined {const r=this.#get('SELECT * FROM candidate_evaluation_plans WHERE principal_id=? AND id=?',p,id);return r&&{principalId:p,id,proposalId:r.proposal_id as string,planDigest:r.plan_digest as string,createdAt:Number(r.created_at)};}
  attemptForPlan(p:string,id:string):CandidateEvaluationAttemptRow|undefined {const r=this.#get('SELECT * FROM candidate_evaluation_attempts WHERE principal_id=? AND plan_id=?',p,id);return r&&{principalId:p,id:r.id as string,planId:id,ownerId:r.owner_id as string,ownerEpoch:r.owner_epoch as bigint,createdAt:Number(r.created_at)};}
  results(p:string,id:string):CandidateEvaluationResultRow[] {return this.#all('SELECT * FROM candidate_evaluation_results WHERE principal_id=? AND attempt_id=? ORDER BY sequence',p,id).map(r=>({principalId:p,id:r.id as string,attemptId:id,sequence:r.sequence as bigint,receiptDigest:r.receipt_digest as string,status:r.status as CandidateEvaluationResultRow['status'],createdAt:Number(r.created_at)}));}
  insertPlan(r:CandidateEvaluationPlanRow):void {this.#run('INSERT INTO candidate_evaluation_plans(principal_id,id,proposal_id,plan_digest,created_at) VALUES(?,?,?,?,?)',r.principalId,r.id,r.proposalId,r.planDigest,r.createdAt);}
  insertAttempt(r:CandidateEvaluationAttemptRow):void {this.#run('INSERT INTO candidate_evaluation_attempts(principal_id,id,plan_id,owner_id,owner_epoch,created_at) VALUES(?,?,?,?,?,?)',r.principalId,r.id,r.planId,r.ownerId,r.ownerEpoch,r.createdAt);}
  insertResult(r:CandidateEvaluationResultRow):void {this.#run('INSERT INTO candidate_evaluation_results(principal_id,id,attempt_id,sequence,receipt_digest,status,created_at) VALUES(?,?,?,?,?,?,?)',r.principalId,r.id,r.attemptId,r.sequence,r.receiptDigest,r.status,r.createdAt);}
}
