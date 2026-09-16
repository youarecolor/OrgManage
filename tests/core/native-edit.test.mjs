import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeEditRequest,reopenNativeEditRequest,nativeEditPrompt,applyNativeEditProposal} from '../../dist/runner/src/native-edit.js';
const source='// protected prefix\nfunction MissionList() { return 0; }\n\nfunction ApprovalCard() { return 2; }\n';
const request=()=>createNativeEditRequest(source,'Display counts for all filters, including zero.');
const bytes=o=>Buffer.from(JSON.stringify(o));
const response=r=>({version:'NATIVE-TEXT-EDIT-v1',requestDigest:r.digest,replacement:'function MissionList() { return 1; }\n'});
test('native text edit preserves prefix and following protected function exactly; stays unverified',()=>{
  const r=request(),reopened=reopenNativeEditRequest(bytes(r),r.digest),result=applyNativeEditProposal(source,reopened,bytes(response(r)));
  assert.equal(result.text,'// protected prefix\nfunction MissionList() { return 1; }\n\nfunction ApprovalCard() { return 2; }\n');
  assert.equal(result.status,'unverified');assert.ok(Object.isFrozen(result));assert.ok(Object.isFrozen(reopened));
  assert.ok(nativeEditPrompt(r).includes(r.digest));assert.ok(!nativeEditPrompt(r).includes('protected prefix'));
});
test('source changed after native request is rejected without rebasing silently',()=>assert.throws(()=>applyNativeEditProposal(source+' ',request(),bytes(response(request()))),/STALE_SOURCE/));
test('plain unsealed request cannot acquire a proposal or prompt',()=>{assert.throws(()=>nativeEditPrompt({...request()}),/UNSEALED/);assert.throws(()=>applyNativeEditProposal(source,{...request()},bytes(response(request()))),/UNSEALED/);});
for(const mode of ['wrong-binding','extra-path','wrong-version','unchanged','oversized','nul','surrogate','not-function'])test('reject native response '+mode,()=>{
  const r=request(),v=response(r);
  if(mode==='wrong-binding')v.requestDigest='0'.repeat(64);
  if(mode==='extra-path')v.path='protected/tests.ts';
  if(mode==='wrong-version')v.version='v2';
  if(mode==='unchanged')v.replacement=r.regionText;
  if(mode==='oversized')v.replacement='function MissionList('+'x'.repeat(16385);
  if(mode==='nul')v.replacement+='\0';
  if(mode==='surrogate')v.replacement+='\ud800';
  if(mode==='not-function')v.replacement='import fs from "node:fs";';
  assert.throws(()=>applyNativeEditProposal(source,r,bytes(v)));
});
test('duplicate fields, bad UTF-8 and shared memory rejected',()=>{
  const r=request(),v=response(r);
  assert.throws(()=>applyNativeEditProposal(source,r,Buffer.from(JSON.stringify(v).replace('{','{"version":"bad",'))));
  assert.throws(()=>applyNativeEditProposal(source,r,Buffer.from([255])));
  assert.throws(()=>applyNativeEditProposal(source,r,new Uint8Array(new SharedArrayBuffer(8))));
});
test('request digest and protected region boundaries cannot be substituted',()=>{
  const r=request();assert.throws(()=>reopenNativeEditRequest(bytes(r),'0'.repeat(64)),/DIGEST/);
  assert.throws(()=>reopenNativeEditRequest(bytes({...r,regionStart:r.regionStart+1}),r.digest),/DIGEST/);
  assert.throws(()=>createNativeEditRequest(source+source,'counts'),/REGION/);
});
test('candidate text remains data; no safety or correctness admission is manufactured',()=>{
  const r=request(),v=response(r);v.replacement='function MissionList() { throw Error("untrusted"); }\n';
  assert.equal(applyNativeEditProposal(source,r,bytes(v)).status,'unverified');
});
