import test from 'node:test';
import assert from 'node:assert/strict';
import {strictJson,strictMetadataJson,WIRE_LIMITS} from '../../dist/contracts/src/wire.js';
test('larger public metadata does not expand ordinary command JSON allowance',()=>{
 const body=Buffer.from(JSON.stringify({metadata:'x'.repeat(300000)}));
 assert.equal(strictJson(body).error.code,'BYTE_LIMIT');assert.equal(strictMetadataJson(body).ok,true);assert.equal(WIRE_LIMITS.maxBytes,262144);
 assert.equal(strictMetadataJson(new Uint8Array(4194305)).error.code,'BYTE_LIMIT');
});
test('metadata still rejects duplicate properties, invalid UTF8, comments and deep nesting',()=>{
 for(const bytes of [Buffer.from('{"a":1,"a":2}'),Buffer.from([0xff]),Buffer.from('{/*comment*/"a":1}'),Buffer.from('['.repeat(17)+'0'+']'.repeat(17))])assert.equal(strictMetadataJson(bytes).ok,false);
});
