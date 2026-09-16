import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
const target=new URL('../../apps/desktop/output-guard.mjs',import.meta.url).href;
test('desktop survives a genuinely disconnected parent output pipe',async()=>{
 const child=spawn(process.execPath,['--input-type=module','-e',`
  const guard=await import(${JSON.stringify(target)}).catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
  guard.guardBrokenOutput?.(process.stdout);
  process.stdout.write('ready');
  setTimeout(()=>process.stdout.write('x'.repeat(65536)),150);
  setTimeout(()=>process.exit(0),400);
 `],{stdio:['ignore','pipe','pipe'],windowsHide:true});
 let error='';child.stderr.on('data',b=>error+=b.toString());
 child.stdout.once('data',()=>child.stdout.destroy());
 const timer=setTimeout(()=>child.kill(),5000);
 try{const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});assert.equal(code,0,error);}finally{clearTimeout(timer);}
});
test('output guard is idempotent and does not hide unrelated failures',async()=>{
 const module=await import(target).catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
 assert.equal(typeof module.guardBrokenOutput,'function');
 const output=new EventEmitter();module.guardBrokenOutput(output);module.guardBrokenOutput(output);
 assert.equal(output.listenerCount('error'),1);
 assert.doesNotThrow(()=>output.emit('error',Object.assign(new Error('closed'),{code:'EPIPE'})));
 const other=Object.assign(new Error('unrelated'),{code:'EIO'});
 assert.throws(()=>output.emit('error',other),e=>e===other);
});
