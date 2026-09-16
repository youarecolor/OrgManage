import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';

export interface NativeAttempt {
  principalId: string; id: string; runId: string; scopeId: string; actorId: string;
  ownerId: string; ownerEpoch: string; binding: string;
  state: 'prepared' | 'send_intent' | 'running' | 'completed' | 'interrupted' | 'failed' | 'unknown' | 'discarded';
  cancellation: 'not_requested' | 'requested' | 'observed';
  threadId: string | null; turnId: string | null; revision: bigint;
}
export interface NativeEvent { principalId: string; id: string; attemptId: string; eventKey: string; digest: string; payload: string }
export const NATIVE_SCHEMA = [
  `CREATE TABLE native_attempts(principal_id TEXT NOT NULL, id TEXT NOT NULL, attempt_kind TEXT NOT NULL DEFAULT 'attempt' CHECK(attempt_kind='attempt'), run_id TEXT NOT NULL, run_kind TEXT NOT NULL DEFAULT 'run' CHECK(run_kind='run'), scope_id TEXT NOT NULL, actor_id TEXT NOT NULL, owner_id TEXT NOT NULL, owner_epoch TEXT NOT NULL, binding TEXT NOT NULL CHECK(json_valid(binding)), state TEXT NOT NULL CHECK(state IN ('prepared','send_intent','running','completed','interrupted','failed','unknown','discarded')), cancellation TEXT NOT NULL CHECK(cancellation IN ('not_requested','requested','observed')), thread_id TEXT, turn_id TEXT, revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 999999999999999999), PRIMARY KEY(principal_id,id), UNIQUE(principal_id,run_id), FOREIGN KEY(principal_id,id,attempt_kind) REFERENCES record_heads(principal_id,id,kind), FOREIGN KEY(principal_id,run_id,run_kind) REFERENCES record_heads(principal_id,id,kind), FOREIGN KEY(principal_id,scope_id) REFERENCES scopes(principal_id,id), FOREIGN KEY(principal_id,actor_id) REFERENCES memberships(principal_id,actor_id), CHECK(turn_id IS NULL OR thread_id IS NOT NULL)) STRICT`,
  `CREATE TRIGGER native_identity_update BEFORE UPDATE ON native_attempts WHEN NEW.principal_id!=OLD.principal_id OR NEW.id!=OLD.id OR NEW.run_id!=OLD.run_id OR NEW.scope_id!=OLD.scope_id OR NEW.actor_id!=OLD.actor_id OR NEW.owner_id!=OLD.owner_id OR NEW.owner_epoch!=OLD.owner_epoch OR NEW.binding!=OLD.binding OR (OLD.thread_id IS NOT NULL AND NEW.thread_id IS NOT OLD.thread_id) OR (OLD.turn_id IS NOT NULL AND NEW.turn_id IS NOT OLD.turn_id) BEGIN SELECT RAISE(ABORT,'native identity is immutable'); END`,
  `CREATE TRIGGER native_no_delete BEFORE DELETE ON native_attempts BEGIN SELECT RAISE(ABORT,'native attempt cannot be deleted'); END`,
  `CREATE UNIQUE INDEX native_one_active_scope ON native_attempts(principal_id,scope_id) WHERE state IN ('prepared','send_intent','running')`,
  `CREATE UNIQUE INDEX native_turn_identity ON native_attempts(principal_id,json_extract(binding,'$.accountRoute'),thread_id,turn_id) WHERE turn_id IS NOT NULL`,
  `CREATE TABLE native_events(principal_id TEXT NOT NULL,id TEXT NOT NULL,attempt_id TEXT NOT NULL,event_key TEXT NOT NULL,digest TEXT NOT NULL CHECK(length(digest)=64 AND digest NOT GLOB '*[^0-9a-f]*'),payload TEXT NOT NULL CHECK(json_valid(payload)),PRIMARY KEY(principal_id,id),UNIQUE(principal_id,attempt_id,event_key,digest),FOREIGN KEY(principal_id,attempt_id) REFERENCES native_attempts(principal_id,id)) STRICT`,
  `CREATE TRIGGER native_event_update BEFORE UPDATE ON native_events BEGIN SELECT RAISE(ABORT,'native event is immutable'); END`,
  `CREATE TRIGGER native_event_delete BEFORE DELETE ON native_events BEGIN SELECT RAISE(ABORT,'native event cannot be deleted'); END`,
];
export interface NativeReader { getAttempt(p:string,id:string):NativeAttempt|undefined; listAttempts(p:string):NativeAttempt[]; events(p:string,id:string):NativeEvent[] }
export interface NativeTransaction extends NativeReader { insertAttempt(a:NativeAttempt):void; updateAttempt(a:NativeAttempt,expected:bigint):void; insertEvent(e:NativeEvent):void }
type Row=Record<string,SQLOutputValue>;
type Get=(sql:string,...args:SQLInputValue[])=>Row|undefined;
type All=(sql:string,...args:SQLInputValue[])=>Row[];
type Run=(sql:string,...args:SQLInputValue[])=>{changes:number|bigint};
const attempt=(r:Row):NativeAttempt=>({principalId:r.principal_id as string,id:r.id as string,runId:r.run_id as string,scopeId:r.scope_id as string,actorId:r.actor_id as string,ownerId:r.owner_id as string,ownerEpoch:r.owner_epoch as string,binding:r.binding as string,state:r.state as NativeAttempt['state'],cancellation:r.cancellation as NativeAttempt['cancellation'],threadId:r.thread_id as string|null,turnId:r.turn_id as string|null,revision:r.revision as bigint});
export class NativeAccess implements NativeTransaction {
  #get:Get; #all:All; #run:Run; #conflict:()=>never;
  constructor(get:Get,all:All,run:Run,conflict:()=>never){this.#get=get;this.#all=all;this.#run=run;this.#conflict=conflict;}
  getAttempt(p:string,id:string):NativeAttempt|undefined{const r=this.#get('SELECT * FROM native_attempts WHERE principal_id=? AND id=?',p,id);return r&&attempt(r);}
  listAttempts(p:string):NativeAttempt[]{return this.#all('SELECT * FROM native_attempts WHERE principal_id=? ORDER BY id',p).map(attempt);}
  events(p:string,id:string):NativeEvent[]{return this.#all('SELECT * FROM native_events WHERE principal_id=? AND attempt_id=? ORDER BY rowid',p,id).map(r=>({principalId:r.principal_id as string,id:r.id as string,attemptId:r.attempt_id as string,eventKey:r.event_key as string,digest:r.digest as string,payload:r.payload as string}));}
  insertAttempt(a:NativeAttempt):void{this.#run('INSERT INTO native_attempts(principal_id,id,run_id,scope_id,actor_id,owner_id,owner_epoch,binding,state,cancellation,thread_id,turn_id,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',a.principalId,a.id,a.runId,a.scopeId,a.actorId,a.ownerId,a.ownerEpoch,a.binding,a.state,a.cancellation,a.threadId,a.turnId,a.revision);}
  updateAttempt(a:NativeAttempt,expected:bigint):void{const old=this.getAttempt(a.principalId,a.id);if(!old||(['runId','scopeId','actorId','ownerId','ownerEpoch','binding'] as const).some(k=>old[k]!==a[k]))this.#conflict();if(this.#run('UPDATE native_attempts SET state=?,cancellation=?,thread_id=?,turn_id=?,revision=? WHERE principal_id=? AND id=? AND revision=?',a.state,a.cancellation,a.threadId,a.turnId,a.revision,a.principalId,a.id,expected).changes!==1n)this.#conflict();}
  insertEvent(e:NativeEvent):void{this.#run('INSERT INTO native_events VALUES(?,?,?,?,?,?)',e.principalId,e.id,e.attemptId,e.eventKey,e.digest,e.payload);}
}
