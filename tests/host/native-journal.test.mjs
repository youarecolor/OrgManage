import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {inspectNativeJournal} from '../../dist/host/src/native-journal.js';
const hash=s=>createHash('sha256').update(s).digest('hex');
function fixture(){let head='0'.repeat(64);const lines=['固定😀','応答'].map((frame,i)=>{const kind=i?'inbound':'outbound',encoded=Buffer.from(frame).toString('base64'),previous=head;head=hash(`${kind}\n${i+1}\n${previous}\n${encoded}`);return JSON.stringify({version:1,index:i+1,kind,previous,digest:head,frameBase64:encoded})+'\n';});const data=Buffer.from(lines.join(''));return {data,lines,seal:{count:2,headDigest:head,length:data.length,sha256:hash(data)}};}
test('journal preserves exact UTF8 frames and independently bound seal',()=>{const f=fixture(),r=inspectNativeJournal(f.data,f.seal);assert.equal(r.integrity,'sealed');assert.deepEqual(r.entries.map(e=>e.frame),['固定😀','応答']);});
test('truncated final record returns only verified prefix, never sealed completion',()=>{const f=fixture(),cut=f.data.subarray(0,f.data.length-8);const r=inspectNativeJournal(cut);assert.equal(r.entries.length,1);assert.equal(r.integrity,'prefix_only');assert.ok(r.trailingBytes>0);assert.throws(()=>inspectNativeJournal(cut,f.seal));});
test('complete-record truncation is detected by the separately retained seal',()=>{const f=fixture();assert.throws(()=>inspectNativeJournal(Buffer.from(f.lines[0]),f.seal));assert.equal(inspectNativeJournal(Buffer.from(f.lines[0])).integrity,'prefix_only');});
test('frame edits, reordering and invalid base64 are rejected',()=>{const f=fixture();for(const text of [f.lines.join('').replace('outbound','inbound'),[...f.lines].reverse().join(''),f.lines.join('').replace('frameBase64":"','frameBase64":"!')])assert.throws(()=>inspectNativeJournal(Buffer.from(text),f.seal));});
test('empty prefix does not assert no send or completion',()=>{const r=inspectNativeJournal(Buffer.alloc(0));assert.equal(r.integrity,'prefix_only');assert.equal(r.entries.length,0);assert.equal('noSend' in r,false);});
