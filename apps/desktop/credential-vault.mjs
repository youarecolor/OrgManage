import {safeStorage} from 'electron';
import {lstatSync,realpathSync,openSync,closeSync,writeFileSync,readFileSync,fstatSync,fsyncSync,unlinkSync} from 'node:fs';
import {resolve,join} from 'node:path';

function check(ok,code){if(!ok)throw Error(`CREDENTIAL_${code}`);}
/** Main-process only. No renderer read method, discovery, HTTP or environment-key
 * lookup. Windows DPAPI protects at rest from other users, not same-user apps. */
export class CredentialVault {
 #root;
 constructor(root){
  check(process.platform==='win32'&&safeStorage.isEncryptionAvailable(),'ENCRYPTION_UNAVAILABLE');
  const full=resolve(root),stat=lstatSync(full);check(stat.isDirectory()&&!stat.isSymbolicLink()&&realpathSync(full).toLowerCase()===full.toLowerCase(),'DIRECTORY');this.#root=full;
 }
 #path(route){check(typeof route==='string'&&/^[a-z0-9][a-z0-9_-]{0,63}$/.test(route),'ROUTE');
  check(realpathSync(this.#root).toLowerCase()===this.#root.toLowerCase()&&!lstatSync(this.#root).isSymbolicLink(),'DIRECTORY');return join(this.#root,`${route}.dpapi`);
 }
 saveNew(route,key){
  check(typeof key==='string'&&key.length>=16&&key.length<=512&&/^[\x21-\x7e]+$/.test(key),'INPUT');
  const path=this.#path(route);let cipher;
  try{cipher=safeStorage.encryptString(JSON.stringify({version:1,route,key}));}catch{throw Error('CREDENTIAL_ENCRYPT_FAILED');}
  check(Buffer.isBuffer(cipher)&&cipher.length>0&&cipher.length<=8192,'CIPHERTEXT');
  // Exclusive creation preserves an existing key and cannot follow a target alias.
  let fd;try{fd=openSync(path,'wx',0o600);writeFileSync(fd,cipher);fsyncSync(fd);}catch{throw Error('CREDENTIAL_SAVE_FAILED');}finally{if(fd!==undefined)closeSync(fd);cipher.fill(0);}
  return {stored:true};
 }
 status(route){
  const path=this.#path(route);let stat;
  try{stat=lstatSync(path);}catch(error){if(error.code==='ENOENT')return {stored:false};throw Error('CREDENTIAL_STATUS_FAILED');}
  check(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size>0&&stat.size<=8192,'FILE');return {stored:true};
 }
 /** Trusted transport callback only; never bind this method to renderer IPC. */
 withKey(route,consume){
  const path=this.#path(route),before=lstatSync(path);check(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&before.size>0&&before.size<=8192,'FILE');
  let fd,cipher;
  try{
   fd=openSync(path,'r');const current=fstatSync(fd);check(current.dev===before.dev&&current.ino===before.ino&&current.nlink===1&&current.size===before.size,'FILE_CHANGED');
   cipher=readFileSync(fd);check(cipher.length===before.size,'FILE_CHANGED');
   let value;try{value=JSON.parse(safeStorage.decryptString(cipher));}catch{throw Error('CREDENTIAL_DECRYPT_FAILED');}
   check(value.version===1&&value.route===route&&typeof value.key==='string'&&Object.keys(value).sort().join(',')==='key,route,version','BINDING');
   return consume(value.key);
  }finally{if(fd!==undefined)closeSync(fd);cipher?.fill(0);}
 }
 remove(route){
  const path=this.#path(route),stat=lstatSync(path);check(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1,'FILE');unlinkSync(path);return {stored:false};
 }
}
