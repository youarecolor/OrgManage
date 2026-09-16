import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {LedgerStore,LEDGER_SCHEMA_HASH} from '../../dist/ledger/src/index.js';
import {CANDIDATE_SCHEMA} from '../../dist/ledger/src/candidate.js';
const oldHash='c42d35f8c8170e1afc5a3326840bed3ef5473bd058e58891aad0f953ac98be2b';
test('exact v7 contract trigger migrates atomically, preserving original metadata',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'orgmanage-contract-v8-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 for(const tamper of [false,true]){
  const path=join(directory,String(tamper)+'.sqlite');let store=await LedgerStore.open(path);await store.close();
  let db=new DatabaseSync(path);db.exec('DROP TRIGGER candidate_base_contract');db.exec(CANDIDATE_SCHEMA.find(s=>s.startsWith('CREATE TRIGGER candidate_base_contract ')));
  const schema=db.prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all().map(r=>r.sql).sort();
  assert.equal(createHash('sha256').update(schema.join('\n')).digest('hex'),oldHash);
  db.prepare('UPDATE meta SET value=? WHERE key=?').run(oldHash,'_store.schema_hash');db.prepare('UPDATE meta SET value=? WHERE key=?').run('orgmanage-local-ledger-v7','_store.version');db.exec('PRAGMA user_version=7');
  db.prepare('INSERT INTO meta VALUES(?,?)').run('preserve-original','original-evidence');
  if(tamper)db.exec('DROP TRIGGER candidate_base_contract');db.close();
  if(tamper){await assert.rejects(LedgerStore.open(path));}
  else{store=await LedgerStore.open(path);assert.equal(store.read(tx=>tx.getMeta('preserve-original')),'original-evidence');await store.close();}
  db=new DatabaseSync(path);assert.equal(db.prepare('PRAGMA user_version').get().user_version,tamper?7:8);assert.equal(db.prepare('SELECT value FROM meta WHERE key=?').get('_store.schema_hash').value,tamper?oldHash:LEDGER_SCHEMA_HASH);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);db.close();
 }
});
