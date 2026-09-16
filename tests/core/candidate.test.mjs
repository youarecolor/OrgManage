import test from 'node:test';
import assert from 'node:assert/strict';
import { createCandidateSnapshot, importCandidatePatch, reopenCandidateSnapshot } from '../../dist/runner/src/candidate.js';

const id = '00000000-0000-4000-8000-000000000001';
const scope = { principalId: id, missionId: id, commandId: id, workspaceId: id, leaseId: id, generation: '1', profileDigest: 'a'.repeat(64) };
const target = 'apps/home/src/filter.ts';
const oracle = 'tests/protected-filter.mjs';
const files = [{ path: target, text: 'export const label = "all";\r\n' }, { path: oracle, text: 'protected independent oracle' }];
const wire = v => Buffer.from(JSON.stringify(v));
const snapshot = () => createCandidateSnapshot(scope, files, [target]);
const patch = base => ({ version: 'CANDIDATE-PATCH-v1', baseDigest: base.digest, changes: [{ path: target, beforeDigest: base.files.find(f=>f.path===target).digest, text: 'export const label = "すべて";\r\n' }] });

test('candidate round trip binds exact text, scope, write set and base; never promotes verification', () => {
  const base = snapshot(), input = patch(base), result = importCandidatePatch(base, wire(input));
  assert.equal(result.status, 'unverified');
  assert.equal(result.base, base);
  assert.equal(result.after.files.find(f=>f.path===target).text, input.changes[0].text);
  assert.equal(result.after.files.find(f=>f.path===oracle).digest, base.files.find(f=>f.path===oracle).digest);
  assert.notEqual(result.after.treeDigest, base.treeDigest);
  assert.deepEqual(reopenCandidateSnapshot(wire(result.after), result.after.digest), result.after);
  assert.equal(base.files.find(f=>f.path===target).text, files[0].text);
  assert.throws(()=>{result.after.files[0].text='tamper';});
  assert.throws(()=>{result.after.binding.generation='2';});
  assert.throws(()=>result.changedPaths.push('other'));
});
test('snapshot is deterministic under file order, copied from caller, and scoped beyond tree bytes', () => {
  const input=structuredClone(files), b=structuredClone(scope), writes=[target];
  const base=createCandidateSnapshot(b,input,writes);
  assert.equal(base.digest,createCandidateSnapshot(scope,[...files].reverse(),[target]).digest);
  input[0].text='mutated';b.generation='2';writes[0]='bad';
  assert.equal(base.digest,snapshot().digest);
  const other=createCandidateSnapshot({...scope,generation:'2'},files,[target]);
  assert.equal(base.treeDigest,other.treeDigest);assert.notEqual(base.digest,other.digest);
  assert.throws(()=>importCandidatePatch(other,wire(patch(base))),/STALE_OR_FOREIGN_BASE/);
});
for (const name of ['../secret','/absolute','C:/secret','a\\b','file:stream','file.','a//b','.private/key','a/CON.txt','a/Lpt1','node_modules/x','a/../b']) {
  test(`candidate rejects Windows path alias ${name}`, () => {
    assert.throws(()=>createCandidateSnapshot(scope,[...files,{path:name,text:'x'}],[target]));
  });
}
test('case aliases and file-directory collisions are rejected even across intervening sorted names',()=>{
  for(const names of [[target,target.toUpperCase()],['a','a.b','a/c']]) {
    assert.throws(()=>createCandidateSnapshot(scope,[...files,...names.map(path=>({path,text:'x'}))],[target]),/PATH_COLLISION/);
  }
});
for(const scenario of ['extra-field','protected-file','stale-file','stale-tree','duplicate-path','case-variant','no-op','empty','delete','new-file']) {
  test(`patch rejects ${scenario}`,()=>{
    const base=snapshot(), p=patch(base), c=p.changes[0];
    if(scenario==='extra-field')p.verification='passed';
    if(scenario==='protected-file'){c.path=oracle;c.beforeDigest=base.files.find(f=>f.path===oracle).digest;}
    if(scenario==='stale-file')c.beforeDigest='0'.repeat(64);
    if(scenario==='stale-tree')p.baseDigest='0'.repeat(64);
    if(scenario==='duplicate-path')p.changes.push({...c});
    if(scenario==='case-variant')c.path=target.toUpperCase();
    if(scenario==='no-op')c.text=files[0].text;
    if(scenario==='empty')p.changes=[];
    if(scenario==='delete')c.text=null;
    if(scenario==='new-file')c.path='apps/home/src/new.ts';
    assert.throws(()=>importCandidatePatch(base,wire(p)));
  });
}
test('wire decoder rejects duplicate fields, malformed UTF8, shared memory and executable metadata',()=>{
  const base=snapshot(), p=wire(patch(base)).toString();
  for(const bytes of [Buffer.from(p.replace('"version":','"version":"x","version":')), Buffer.from([0xff]),new Uint8Array(new SharedArrayBuffer(8)),wire({...patch(base),command:'run.exe'})]) {
    assert.throws(()=>importCandidatePatch(base,bytes));
  }
});
test('size and Unicode bounds apply before accepting output',()=>{
  for(const value of ['a'.repeat(65537),'\ud800','\0']) {
    const base=snapshot(), p=patch(base);p.changes[0].text=value;
    assert.throws(()=>importCandidatePatch(base,wire(p)));
  }
  assert.throws(()=>createCandidateSnapshot(scope,Array.from({length:33},(_,i)=>({path:`f${i}`,text:'x'})),[target]));
});
test('reopen requires a trusted reference and refuses tampered or forged snapshots',()=>{
  const base=snapshot();
  assert.throws(()=>importCandidatePatch(JSON.parse(JSON.stringify(base)),wire(patch(base))),/UNSEALED_BASE/);
  for(const key of ['text','scope','digest','tree','write-set']) {
    const copy=JSON.parse(JSON.stringify(base));
    if(key==='text')copy.files[0].text='tampered';
    if(key==='scope')copy.binding.principalId='00000000-0000-4000-8000-000000000002';
    if(key==='digest')copy.digest='0'.repeat(64);
    if(key==='tree')copy.treeDigest='0'.repeat(64);
    if(key==='write-set')copy.writeSet=[oracle];
    assert.throws(()=>reopenCandidateSnapshot(wire(copy),base.digest));
  }
  assert.throws(()=>reopenCandidateSnapshot(wire(base),'0'.repeat(64)));
});
test('candidate strings containing script text remain data without evaluation',()=>{
  const base=snapshot(), p=patch(base);p.changes[0].text='throw new Error("must not execute");';
  const result=importCandidatePatch(base,wire(p));
  assert.equal(result.after.files.find(f=>f.path===target).text,p.changes[0].text);
  assert.equal(result.status,'unverified');
});
