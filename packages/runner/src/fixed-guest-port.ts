import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strictJson } from '../../contracts/src/index.js';
import type { FixedVerificationPort, RunnerBinding } from '../../core/src/runner.js';
import type { RunnerProfile } from '../../ledger/src/index.js';
import {readPinnedNativeVmBinding} from '../../local-bindings/src/index.js';

const root=fileURLToPath(new URL('../../../',import.meta.url));
const clientHash='38b791038146b5e93e953312d95bfa05a2a17c95be1b1cf80b3ebf15028b68ae';
const sha=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex');
function requireThat(c:unknown,message:string):asserts c {if(!c)throw new Error(message);}
interface Manifest {version:string;files:Record<string,string>}
function assets():{manifest:Manifest;digest:string;get:(path:string)=>string} {
  const bytes=readFileSync(join(root,'scripts/guest-packages/persistent-runner/assets.manifest.json'));
  const manifest=JSON.parse(bytes.toString('utf8')) as Manifest;
  requireThat(manifest.version==='PERSISTENT-RUNNER-ASSETS-v1','Unknown asset manifest');
  const texts=new Map<string,string>();
  const required=['scripts/guest-packages/persistent-runner/entry.template.ps1','scripts/guest-packages/lease-stop/entry.ps1','scripts/guest-packages/lease-stop/controller.cs','scripts/guest-packages/lease-stop/writer.cs'];
  requireThat(JSON.stringify(Object.keys(manifest.files).sort())===JSON.stringify([...required].sort()),'Unexpected asset paths');
  for(const path of required){const data=readFileSync(join(root,path));requireThat(sha(data)===manifest.files[path],'Reviewed asset hash mismatch');texts.set(path,new TextDecoder('utf-8',{fatal:true}).decode(data));}
  requireThat(sha(readFileSync(join(root,'scripts/invoke-vm-bridge.ps1')))===clientHash,'Fixed bridge client changed');
  return {manifest,digest:sha(bytes),get:path=>{const value=texts.get(path);requireThat(value!==undefined,'Unknown asset');return value;}};
}
export function fixedGuestProfile(principalId:string):RunnerProfile {
  const vmId=readPinnedNativeVmBinding().vmId;
  return {principalId,id:'22c18e5f-8bc7-4878-a0f6-35e916967e50',revision:1n,digest:assets().digest,kind:'fixed_guest_fixture',isolationId:vmId,ttlMs:60000};
}
export function renderFixedGuestPackage(binding:Readonly<RunnerBinding>,mode:'start'|'inspect'):{entry:string;controller:string;writer:string;packageId:string} {
  const vmId=readPinnedNativeVmBinding().vmId;
  const a=assets();
  requireThat(Object.keys(binding).length===9 && ['principalId','leaseId','workspaceId','ownerId'].every(k=>typeof binding[k as keyof RunnerBinding]==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(binding[k as keyof RunnerBinding])),'Invalid fixed ledger binding');
  requireThat(binding.profileDigest===a.digest&&binding.isolationId===vmId&&/^[1-9][0-9]{0,17}$/.test(binding.generation)&&/^[1-9][0-9]{0,17}$/.test(binding.ownerEpoch)&&/^[01]$/.test(binding.stopEpoch)&&(mode!=='start'||binding.stopEpoch==='0'),'Unadmitted profile/VM/generation');
  requireThat(mode==='start'||mode==='inspect','Unknown fixed operation');
  let entry=a.get('scripts/guest-packages/persistent-runner/entry.template.ps1');
  for(const [token,value] of Object.entries({'@@BINDING_BASE64@@':Buffer.from(JSON.stringify(binding)).toString('base64'),'@@OPERATION@@':mode,'@@BASE_ENTRY@@':mode==='start'?a.get('scripts/guest-packages/lease-stop/entry.ps1'):''})){
    requireThat(entry.split(token).length===2,'Template marker mismatch');entry=entry.replace(token,()=>value);
  }
  const controller=mode==='start'?a.get('scripts/guest-packages/lease-stop/controller.cs'):'';
  const writer=mode==='start'?a.get('scripts/guest-packages/lease-stop/writer.cs'):'';
  const wire=JSON.stringify({version:'GUEST-PACKAGE-v1',entry:Buffer.from(entry).toString('base64'),controller:Buffer.from(controller).toString('base64'),writer:Buffer.from(writer).toString('base64')});
  requireThat(Buffer.byteLength(entry+controller+writer)<=262144,'Fixed package exceeds bridge limit');
  return {entry,controller,writer,packageId:sha(wire)};
}
function invoke(args:string[]):Promise<string> {
  requireThat(process.platform==='win32','Fixed Windows host only');
  return new Promise((resolve,reject)=>{
    const child=spawn('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-File',join(root,'scripts/invoke-vm-bridge.ps1'),...args],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
    const stdout:Buffer[]=[];let bytes=0;let failed=false;
    const fail=(reason:string)=>{if(failed)return;failed=true;child.kill();reject(new Error(reason));};
    const timer=setTimeout(()=>fail('Fixed client timeout; effect unknown, reconcile before retry'),115000);
    child.stdout.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>131072)fail('Fixed client output exceeds limit');else stdout.push(chunk);});
    child.stderr.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>131072)fail('Fixed client output exceeds limit');});
    child.on('error',()=>{clearTimeout(timer);fail('Fixed client unavailable');});
    child.on('close',code=>{clearTimeout(timer);if(failed)return;if(code!==0){reject(new Error('Fixed client failed; effect may be unknown'));return;}resolve(Buffer.concat(stdout).toString('utf8'));});
  });
}
/** Uses only the already installed fixed VM broker and its saved credentials. No credential reads. */
export class FixedGuestFixturePort implements FixedVerificationPort {
  readonly receipts:{requestId:string;packageId:string;directory:string}[]=[];
  async #call(binding:Readonly<RunnerBinding>,mode:'start'|'inspect'):Promise<Uint8Array> {
    const pkg=renderFixedGuestPackage(binding,mode),requestId=randomUUID().replaceAll('-','');
    const base=join(root,'.private/test-runs');mkdirSync(base,{recursive:true});const directory=mkdtempSync(join(base,'fixed-guest-port-'));
    for(const [name,value] of [['entry.ps1',pkg.entry],['controller.cs',pkg.controller],['writer.cs',pkg.writer]])writeFileSync(join(directory,name!),value!,{flag:'wx'});
    this.receipts.push({requestId,packageId:pkg.packageId,directory});
    const raw=await invoke(['-Operation','guest-package','-EntryPath',join(directory,'entry.ps1'),'-ControllerPath',join(directory,'controller.cs'),'-WriterPath',join(directory,'writer.cs'),'-RequestId',requestId]);
    writeFileSync(join(directory,'bridge-response.json'),raw,{flag:'wx'});
    const decoded=strictJson(Buffer.from(raw));requireThat(decoded.ok&&decoded.value!==null&&typeof decoded.value==='object','Invalid bridge response');
    const result=decoded.value as {requestId?:unknown;operation?:unknown;stage?:unknown;packageId?:unknown;guest?:{stage?:unknown;packageId?:unknown;result?:{ok?:unknown;runnerObservation?:unknown};observation?:{workerEnabled?:unknown;writers?:unknown[];processProbeLockFree?:unknown}}};
    requireThat(result.requestId===requestId&&result.operation==='guest-package'&&result.stage==='completed'&&result.packageId===pkg.packageId&&result.guest?.stage==='guest_package_completed'&&result.guest.packageId===pkg.packageId&&result.guest.result?.ok===true,'Unsuccessful or mismatched guest receipt');
    requireThat(result.guest.observation?.workerEnabled===false&&Array.isArray(result.guest.observation.writers)&&result.guest.observation.writers.length===0&&result.guest.observation.processProbeLockFree===true,'Guest cleanup not independently observed');
    return Buffer.from(JSON.stringify(result.guest.result.runnerObservation));
  }
  startExecutor(binding:Readonly<RunnerBinding>):Promise<Uint8Array>{return this.#call(binding,'start');}
  // This fixture has its own finite Job deadline. These methods inspect its persisted completion;
  // they do not claim to be a general live process-control channel or send a second start.
  requestStop(binding:Readonly<RunnerBinding>):Promise<Uint8Array>{return this.#call(binding,'inspect');}
  inspect(binding:Readonly<RunnerBinding>):Promise<Uint8Array>{return this.#call(binding,'inspect');}
}
