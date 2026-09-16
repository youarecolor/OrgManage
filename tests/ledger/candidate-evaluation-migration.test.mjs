import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {LedgerStore,LedgerIntegrityError,LEDGER_SCHEMA_HASH} from '../../dist/ledger/src/index.js';

test('exact frozen v4 migrates to v8 and preserves metadata; altered old schema is refused atomically',async t=>{
  const frozen=JSON.parse(readFileSync(new URL('./fixtures/schema-v4.json',import.meta.url),'utf8'));
  for(const tamper of [false,true]){
    const path=join(mkdtempSync('.private/test-runs/evaluation-migration-'),'ledger.sqlite');
    const raw=new DatabaseSync(path);raw.exec('BEGIN');
    for(const sql of [...frozen.schema].sort((a,b)=>Number(!a.startsWith('CREATE TABLE'))-Number(!b.startsWith('CREATE TABLE'))))raw.exec(sql);
    for(const r of frozen.meta)raw.prepare('INSERT INTO meta VALUES(?,?)').run(r.key,r.value);
    raw.prepare('INSERT INTO principals VALUES(?,?,?)').run('11111111-1111-1111-1111-111111111111','person','Preserved v4 Principal');
    raw.exec('PRAGMA application_id=1330464561; PRAGMA user_version=4; COMMIT');
    if(tamper)raw.exec('DROP TRIGGER candidate_proposals_immutable_update');raw.close();
    if(tamper){await assert.rejects(LedgerStore.open(path),LedgerIntegrityError);const db=new DatabaseSync(path);assert.equal(db.prepare('PRAGMA user_version').get().user_version,4);assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name='candidate_evaluation_plans'").get().n,0);db.close();}
    else{
      const store=await LedgerStore.open(path);t.after(()=>store.close());
      assert.equal(store.read(tx=>tx.getMeta('fixture_preserve')),'evaluation-original');assert.equal(store.read(tx=>tx.listPrincipal())[0].displayName,'Preserved v4 Principal');
      assert.equal(store.read(tx=>tx.getMeta('_store.schema_hash')),LEDGER_SCHEMA_HASH);
      const db=new DatabaseSync(path);assert.equal(db.prepare('PRAGMA user_version').get().user_version,8);assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);db.close();
    }
  }
});
