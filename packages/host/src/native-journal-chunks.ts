import {createHash} from 'node:crypto';
import canonicalize from 'canonicalize';
export interface NativeJournalChunk {
 ok:true;format:'native_journal_chunk_v1';target:'dispatch'|'probe';offset:number;
 totalLength:number;fileDigest:string;chunkBase64:string;receipt:unknown;
 nicCount:0;codexCount:0;workerDisabled:true;
}
/** Assembles only a fixed reader's response payloads. It does not itself prove
 * the pipe peer, VM, ACL or receipt provenance, or resolve any Attempt. */
export class NativeJournalChunks {
 #parts:Buffer[]=[];#offset=0;#first:NativeJournalChunk|undefined;#done=false;#failed=false;
 constructor(readonly target:'dispatch'|'probe',readonly chunkSize:4096|8192|49152=49152){}
 add(value:NativeJournalChunk):void{
  try{
   if(this.#done||this.#failed)throw Error('closed');
   if(!value||Object.keys(value).sort().join('|')!=='chunkBase64|codexCount|fileDigest|format|nicCount|offset|ok|receipt|target|totalLength|workerDisabled'||value.ok!==true||value.format!=='native_journal_chunk_v1'||value.target!==this.target||value.nicCount!==0||value.codexCount!==0||value.workerDisabled!==true)throw Error('binding');
   if(!Number.isSafeInteger(value.totalLength)||value.totalLength<0||value.totalLength>4194304||value.offset!==this.#offset||!/^[a-f0-9]{64}$/.test(value.fileDigest)||typeof value.chunkBase64!=='string'||value.chunkBase64.length>65536)throw Error('bounds');
   const body=Buffer.from(value.chunkBase64,'base64');if(body.toString('base64')!==value.chunkBase64||body.length!==Math.min(this.chunkSize,value.totalLength-this.#offset))throw Error('chunk');
   if(this.#first){if(value.totalLength!==this.#first.totalLength||value.fileDigest!==this.#first.fileDigest||canonicalize(value.receipt)!==canonicalize(this.#first.receipt))throw Error('snapshot changed');}
   else this.#first=structuredClone(value);
   this.#parts.push(body);this.#offset+=body.length;this.#done=this.#offset===value.totalLength;
  }catch{this.#failed=true;throw Error('NATIVE_JOURNAL_CHUNK_DENIED');}
 }
 get nextOffset(){if(this.#failed)throw Error('NATIVE_JOURNAL_CHUNK_DENIED');return this.#done?null:this.#offset;}
 finish(){
  if(this.#failed||!this.#done||!this.#first)throw Error('NATIVE_JOURNAL_CHUNK_INCOMPLETE');
  const bytes=Buffer.concat(this.#parts);
  if(createHash('sha256').update(bytes).digest('hex')!==this.#first.fileDigest){this.#failed=true;throw Error('NATIVE_JOURNAL_CHUNK_DIGEST');}
  return {bytes,receipt:structuredClone(this.#first.receipt)};
 }
}
