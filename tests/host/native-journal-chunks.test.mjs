import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {NativeJournalChunks} from '../../dist/host/src/native-journal-chunks.js';
function fixture(){const bytes=Buffer.alloc(100000,97);const chunks=[0,49152,98304].map(offset=>({ok:true,format:'native_journal_chunk_v1',target:'dispatch',offset,totalLength:bytes.length,fileDigest:createHash('sha256').update(bytes).digest('hex'),chunkBase64:bytes.subarray(offset,offset+49152).toString('base64'),receipt:{fixed:true},nicCount:0,codexCount:0,workerDisabled:true}));return {bytes,chunks};}
test('4096 byte chunks with a maximum receipt fit the fixed guest output boundary',()=>{
 const f=fixture(),a=new NativeJournalChunks('dispatch',4096);
 for(let offset=0;offset<f.bytes.length;offset+=4096){
  const c={...f.chunks[0],offset,chunkBase64:f.bytes.subarray(offset,offset+4096).toString('base64'),receipt:{padding:'a'.repeat(16300)}};
  assert.ok(JSON.stringify(c).length<24576);a.add(c);
 }
 assert.deepEqual(a.finish().bytes,f.bytes);
});
test('bounded chunks reconstruct an exact multi-chunk snapshot',()=>{const f=fixture(),a=new NativeJournalChunks('dispatch');for(const c of f.chunks)a.add(c);assert.equal(a.nextOffset,null);assert.deepEqual(a.finish().bytes,f.bytes);});
test('actual 337160 byte journal fits one 64-package retention cycle',()=>{
 const bytes=Buffer.alloc(337160,97),a=new NativeJournalChunks('dispatch',8192);let count=0;
 for(let offset=0;offset<bytes.length;offset+=8192){const c={...fixture().chunks[0],offset,totalLength:bytes.length,fileDigest:createHash('sha256').update(bytes).digest('hex'),chunkBase64:bytes.subarray(offset,offset+8192).toString('base64'),receipt:{padding:'a'.repeat(11900)}};assert.ok(JSON.stringify(c).length<24576);a.add(c);count++;}
 assert.equal(count,42);assert.deepEqual(a.finish().bytes,bytes);
});
test('missing chunks cannot be treated as a complete snapshot',()=>{const f=fixture(),a=new NativeJournalChunks('dispatch');a.add(f.chunks[0]);assert.throws(()=>a.finish());assert.throws(()=>a.add(f.chunks[2]));});
test('digest, receipt and target changes poison collection',()=>{for(const change of [c=>c.fileDigest='f'.repeat(64),c=>c.receipt={other:true},c=>c.target='probe']){const f=fixture(),a=new NativeJournalChunks('dispatch');a.add(f.chunks[0]);change(f.chunks[1]);assert.throws(()=>a.add(f.chunks[1]));assert.throws(()=>a.add(f.chunks[1]));}});
test('same advertised hash with altered bytes is rejected at completion',()=>{const f=fixture(),a=new NativeJournalChunks('dispatch');f.chunks[2].chunkBase64=Buffer.alloc(1696,98).toString('base64');for(const c of f.chunks)a.add(c);assert.throws(()=>a.finish());});
