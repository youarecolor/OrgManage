import {createHash} from 'node:crypto';
import {closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats} from 'node:fs';
import {dirname, parse, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const filename=fileURLToPath(new URL('../../../.private/local-bindings/fixed-environment.json',import.meta.url));
const digest='60c08c293b51688c85eb6446163abd73d8acf0f470f79f1d2094dd99c6b117b2';
const deny=()=>new Error('LOCAL_NATIVE_BINDING_UNAVAILABLE');
function same(a:Stats,b:Stats):boolean {
 return a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs&&b.nlink===1&&b.isFile();
}
function checkAncestors():void {
 for(let path=dirname(filename);;path=dirname(path)){
  const stat=lstatSync(path);
  if(stat.isSymbolicLink()||!stat.isDirectory())throw deny();
  if(path===parse(path).root)break;
 }
 // Reject redirected ancestors as well as the final path. This is detection,
 // not an OS boundary against another process running as the same user.
 const canonical=realpathSync.native(filename),expected=resolve(filename);
 if((process.platform==='win32'?canonical.toLowerCase():canonical)!==(process.platform==='win32'?expected.toLowerCase():expected))throw deny();
 if(!expected.includes(`${sep}.private${sep}local-bindings${sep}`))throw deny();
}

/** Data-only fixed local binding. No environment override, caller path, cache,
 * credentials or deployment changes. Missing or changed data prevents subsequent
 * calls through these fixed adapters; it does not stop an already open session.
 * The public checksum preserves the reviewed binding without publishing its ID.
 */
export function readPinnedNativeVmBinding():Readonly<{vmId:string}> {
 let fd:number|undefined;
 try {
  checkAncestors();
  const before=lstatSync(filename);
  if(before.isSymbolicLink()||!before.isFile()||before.nlink!==1||before.size!==93)throw deny();
  fd=openSync(filename,'r');
  if(!same(before,fstatSync(fd)))throw deny();
  const buffer=Buffer.alloc(94),length=readSync(fd,buffer,0,buffer.length,0);
  const bytes=buffer.subarray(0,length);
  if(length!==93||createHash('sha256').update(bytes).digest('hex')!==digest)throw deny();
  if(!same(before,fstatSync(fd))||!same(before,lstatSync(filename)))throw deny();
  checkAncestors();
  const value:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(!value||typeof value!=='object'||Array.isArray(value))throw deny();
  const v=value as Record<string,unknown>;
  if(Object.keys(v).sort().join('|')!=='format|vmId'||v.format!=='orgmanage-local-native-binding-v1'||typeof v.vmId!=='string'||!(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/).test(v.vmId))throw deny();
  return Object.freeze({vmId:v.vmId});
 }catch{throw deny();}finally{if(fd!==undefined)closeSync(fd);}
}
