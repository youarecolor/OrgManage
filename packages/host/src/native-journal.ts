import {createHash} from 'node:crypto';
import {strictJson} from '../../contracts/src/wire.js';
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export interface NativeJournalSeal {count:number;headDigest:string;length:number;sha256:string}
/** Recovery data only. Hash integrity is not provenance or authority. The fixed
 * guest reader must establish protected path/ACL and session identity separately.
 * An unsealed prefix cannot confirm completion, cancellation or no send. */
export function inspectNativeJournal(bytes:Uint8Array,seal?:NativeJournalSeal){
 if(bytes.byteLength>4194304)throw Error('NATIVE_JOURNAL_BOUND');
 const data=Buffer.from(bytes);let head='0'.repeat(64),offset=0;
 const entries:{index:number;kind:'outbound'|'inbound';frame:string}[]=[];
 while(offset<data.length){
  const end=data.indexOf(10,offset);if(end<0)break;
  if(entries.length>=4096||end-offset>90000)throw Error('NATIVE_JOURNAL_BOUND');
  const parsed=strictJson(data.subarray(offset,end));if(!parsed.ok)throw Error('NATIVE_JOURNAL_JSON');
  const r=parsed.value as Record<string,unknown>;
  if(!r||Object.keys(r).sort().join('|')!=='digest|frameBase64|index|kind|previous|version'||r.version!==1||r.index!==entries.length+1||!['outbound','inbound'].includes(String(r.kind))||r.previous!==head||typeof r.frameBase64!=='string')throw Error('NATIVE_JOURNAL_SEQUENCE');
  const raw=Buffer.from(r.frameBase64,'base64');
  if(!raw.length||raw.length>65536||raw.toString('base64')!==r.frameBase64)throw Error('NATIVE_JOURNAL_ENCODING');
  const frame=raw.toString('utf8');if(!Buffer.from(frame).equals(raw))throw Error('NATIVE_JOURNAL_UTF8');
  const expected=hash(`${r.kind}\n${r.index}\n${head}\n${r.frameBase64}`);
  if(r.digest!==expected)throw Error('NATIVE_JOURNAL_DIGEST');
  head=expected;entries.push({index:r.index as number,kind:r.kind as 'outbound'|'inbound',frame});offset=end+1;
 }
 const trailingBytes=data.length-offset;
 if(seal&&(Object.keys(seal).sort().join('|')!=='count|headDigest|length|sha256'||trailingBytes||seal.count!==entries.length||seal.headDigest!==head||seal.length!==data.length||seal.sha256.toLowerCase()!==hash(data)))throw Error('NATIVE_JOURNAL_SEAL');
 return {entries,headDigest:head,verifiedPrefixBytes:offset,trailingBytes,integrity:seal?'sealed' as const:'prefix_only' as const,sha256:hash(data)};
}
