import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { fixedGuestProfile,renderFixedGuestPackage } from '../../dist/runner/src/fixed-guest-port.js';
function fixture(){const p=fixedGuestProfile(randomUUID());return {principalId:p.principalId,leaseId:randomUUID(),workspaceId:randomUUID(),generation:'2',ownerId:randomUUID(),ownerEpoch:'1',stopEpoch:'0',profileDigest:p.digest,isolationId:p.isolationId};}
test('reviewed fixed package renders the exact canonical protocol hash and byte budget',()=>{
  const b=fixture(),p=renderFixedGuestPackage(b,'start');assert.equal(p.entry.includes('@@'),false);assert.ok(p.entry.includes(Buffer.from(JSON.stringify(b)).toString('base64')));
  const wire=JSON.stringify({version:'GUEST-PACKAGE-v1',entry:Buffer.from(p.entry).toString('base64'),controller:Buffer.from(p.controller).toString('base64'),writer:Buffer.from(p.writer).toString('base64')});assert.equal(p.packageId,createHash('sha256').update(wire).digest('hex'));assert.ok(Buffer.byteLength(p.entry+p.controller+p.writer)<262144);
});
test('wrong VM/profile, malformed identity, unknown operation and post-stop start are refused',()=>{
  const b=fixture();for(const changed of [{...b,isolationId:randomUUID()},{...b,profileDigest:'0'.repeat(64)},{...b,leaseId:"'; Start-Process bad; '"},{...b,stopEpoch:'1'},{...b,generation:'01'},{...b,extra:'x'}])assert.throws(()=>renderFixedGuestPackage(changed,'start'));
  assert.throws(()=>renderFixedGuestPackage(b,'shell'));assert.doesNotThrow(()=>renderFixedGuestPackage({...b,stopEpoch:'1'},'inspect'));
});
