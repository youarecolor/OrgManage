import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { LedgerStore, LedgerIntegrityError, LEDGER_SCHEMA_HASH } from '../../dist/ledger/src/index.js';

test('frozen v3 migrates to v8 preserving old data, and tampered v3 stays unmigrated',async t=>{
  const frozen=JSON.parse(readFileSync(new URL('./fixtures/schema-v3.json',import.meta.url),'utf8'));
  for(const tamper of [false,true]){
    const path=join(mkdtempSync('.private/test-runs/candidate-migration-'),'ledger.sqlite');
    const db=new DatabaseSync(path);db.exec('BEGIN');
    for(const sql of [...frozen.schema].sort((a,b)=>Number(!a.startsWith('CREATE TABLE'))-Number(!b.startsWith('CREATE TABLE'))))db.exec(sql);
    for(const r of frozen.meta)db.prepare('INSERT INTO meta VALUES(?,?)').run(r.key,r.value);
    db.prepare('INSERT INTO principals VALUES(?,?,?)').run('11111111-1111-1111-1111-111111111111','person','Retained candidate migration fixture');
    db.exec('PRAGMA application_id=1330464561; PRAGMA user_version=3; COMMIT');
    if(tamper)db.exec('CREATE TABLE unexpected(x TEXT)');db.close();
    if(tamper){
      await assert.rejects(LedgerStore.open(path),LedgerIntegrityError);
      const check=new DatabaseSync(path);assert.equal(check.prepare('PRAGMA user_version').get().user_version,3);
      assert.equal(check.prepare("SELECT COUNT(*) n FROM sqlite_schema WHERE name='candidate_bases'").get().n,0);check.close();
    }else{
      const store=await LedgerStore.open(path);t.after(()=>store.close());
      assert.equal(store.read(tx=>tx.getMeta('fixture_preserve')),'candidate-original');
      assert.equal(store.read(tx=>tx.listPrincipal())[0].displayName,'Retained candidate migration fixture');
      assert.equal(store.read(tx=>tx.getMeta('_store.schema_hash')),LEDGER_SCHEMA_HASH);
      const check=new DatabaseSync(path);assert.equal(check.prepare('PRAGMA user_version').get().user_version,8);
      assert.equal(check.prepare('PRAGMA integrity_check').get().integrity_check,'ok');check.close();
    }
  }
});
