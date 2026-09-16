import {createHash} from 'node:crypto';
import {strictJson} from '../../contracts/src/wire.js';

/** Bounded text proposal only. No file I/O, import, execution, lease or adoption. */
const sha=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const hash=/^[0-9a-f]{64}$/;
const start='function MissionList(',end='\nfunction ApprovalCard(';
const sealed=new WeakSet<object>();
export interface NativeEditRequest {
  readonly version:'NATIVE-TEXT-REQUEST-v1';readonly filePath:'apps/home/src/App.tsx';
  readonly fileDigest:string;readonly regionStart:number;readonly regionText:string;
  readonly requirements:string;readonly digest:string;
}
function check(v:unknown,message:string):asserts v {if(!v)throw Error('NATIVE_EDIT_'+message);}
function text(v:unknown,max:number):asserts v is string {check(typeof v==='string'&&v.isWellFormed()&&!v.includes('\0')&&Buffer.byteLength(v)<=max,'TEXT');}
function object(v:unknown,keys:readonly string[]):Record<string,unknown>{
  check(v!==null&&typeof v==='object'&&!Array.isArray(v),'OBJECT');
  check(Object.keys(v).sort().join('|')===[...keys].sort().join('|'),'FIELDS');return v as Record<string,unknown>;
}
export function createNativeEditRequest(source:string,requirements:string):Readonly<NativeEditRequest>{
  text(source,65536);text(requirements,4096);check(requirements.trim().length>0,'REQUIREMENTS');
  const from=source.indexOf(start),to=source.indexOf(end);
  check(from>=0&&to>from&&source.indexOf(start,from+1)===-1&&source.indexOf(end,to+1)===-1,'REGION');
  const regionText=source.slice(from,to);text(regionText,8192);
  const body={version:'NATIVE-TEXT-REQUEST-v1' as const,filePath:'apps/home/src/App.tsx' as const,fileDigest:sha(source),regionStart:from,regionText,requirements};
  const result=Object.freeze({...body,digest:sha(JSON.stringify(body))});sealed.add(result);return result;
}
export function reopenNativeEditRequest(bytes:Uint8Array,expectedDigest:string):Readonly<NativeEditRequest>{
  check(bytes instanceof Uint8Array&&!(bytes.buffer instanceof SharedArrayBuffer)&&bytes.byteLength<=16384&&hash.test(expectedDigest),'WIRE');
  const parsed=strictJson(bytes);check(parsed.ok,'JSON');
  const r=object(parsed.value,['version','filePath','fileDigest','regionStart','regionText','requirements','digest']);
  text(r.regionText,8192);text(r.requirements,4096);
  check(r.version==='NATIVE-TEXT-REQUEST-v1'&&r.filePath==='apps/home/src/App.tsx'&&typeof r.fileDigest==='string'&&hash.test(r.fileDigest)&&Number.isSafeInteger(r.regionStart)&&(r.regionStart as number)>=0&&(r.regionStart as number)<=65536&&r.regionText.startsWith(start)&&r.requirements.trim().length>0,'REQUEST');
  const {digest,...body}=r;check(digest===expectedDigest&&sha(JSON.stringify(body))===digest,'DIGEST');
  const result=Object.freeze({...r}) as unknown as NativeEditRequest;sealed.add(result);return result;
}
export function nativeEditPrompt(request:Readonly<NativeEditRequest>):string{
  check(sealed.has(request),'UNSEALED');
  return 'Propose one source edit as data. Use no tools. Return exactly one JSON object, no Markdown: '+
    JSON.stringify({version:'NATIVE-TEXT-EDIT-v1',requestDigest:request.digest,replacement:'<complete replacement for the supplied MissionList function>'})+
    '\nDo not change any other function, imports, actions, or evaluation. The response is an unverified proposal.\nREQUIREMENTS:\n'+request.requirements+
    '\nCONTEXT: React useState is already imported. MissionView.phase is intake | approval | execution | review | exit.\nFILE: '+request.filePath+'\nSOURCE REGION:\n'+request.regionText;
}
export function applyNativeEditProposal(source:string,request:Readonly<NativeEditRequest>,bytes:Uint8Array):{readonly text:string;readonly responseDigest:string;readonly fileDigest:string;readonly status:'unverified'}{
  check(sealed.has(request),'UNSEALED');text(source,65536);check(sha(source)===request.fileDigest,'STALE_SOURCE');
  // Recompute the selected region from the full original, not from model-supplied offsets.
  check(createNativeEditRequest(source,request.requirements).digest===request.digest,'REGION_CHANGED');
  check(bytes instanceof Uint8Array&&!(bytes.buffer instanceof SharedArrayBuffer)&&bytes.byteLength<=16384,'WIRE');
  const parsed=strictJson(bytes);check(parsed.ok,'JSON');const r=object(parsed.value,['version','requestDigest','replacement']);
  check(r.version==='NATIVE-TEXT-EDIT-v1'&&r.requestDigest===request.digest,'RESPONSE_BINDING');
  text(r.replacement,8192);check(r.replacement.startsWith(start)&&r.replacement!==request.regionText,'REPLACEMENT');
  const after=source.slice(0,request.regionStart)+r.replacement+source.slice(request.regionStart+request.regionText.length);text(after,65536);
  return Object.freeze({text:after,responseDigest:sha(bytes),fileDigest:sha(after),status:'unverified' as const});
}
