import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import observer from '../../scripts/evaluators/home-observer.cjs';
const {createHomeObserver} = observer;
function fake() {
  const contents = new EventEmitter();
  Object.assign(contents, {isDestroyed:()=>false,getURL:()=> 'orgmanage://home/',getLastWebPreferences:()=>({sandbox:true,contextIsolation:true,nodeIntegration:false,webSecurity:true,webviewTag:false}),executeJavaScriptInIsolatedWorld:async()=>'{"ok":true}'});
  return contents;
}
test('observer exposes only fixed operations and uses separate world', async()=>{
  const c=fake(), calls=[];c.executeJavaScriptInIsolatedWorld=async(...args)=>{calls.push(args);return '{}';};
  const o=createHomeObserver(c);assert.deepEqual(Object.keys(o),['read','clickFilter','selectTask','dispose']);
  await o.read();await o.clickFilter(2);await o.selectTask(3);
  assert.ok(calls.every(([world,,gesture])=>world===1004&&gesture===false));
  for(const value of [-1,4,NaN,'0;alert(1)',{},null])assert.throws(()=>o.clickFilter(value));
  for(const value of [-1,100,1.5,'1'])assert.throws(()=>o.selectTask(value));
});
test('unsafe page or sandbox settings prevent any observation',async()=>{
  for(const key of ['sandbox','contextIsolation','webSecurity','nodeIntegration','webviewTag','url','destroyed']){
    const c=fake();let calls=0;c.executeJavaScriptInIsolatedWorld=async()=>{calls++;return '{}';};
    if(key==='url')c.getURL=()=> 'orgmanage://home/?foreign';
    else if(key==='destroyed')c.isDestroyed=()=>true;
    else{const p=c.getLastWebPreferences();p[key]=!p[key];c.getLastWebPreferences=()=>p;}
    await assert.rejects(createHomeObserver(c).read());assert.equal(calls,0);
  }
});
test('navigation during evaluation permanently invalidates observer',async()=>{
  const c=fake();c.executeJavaScriptInIsolatedWorld=async()=>{c.emit('did-start-navigation');return '{}';};
  const o=createHomeObserver(c);await assert.rejects(o.read(),/Navigation/);await assert.rejects(o.read(),/invalidated/);assert.equal(c.listenerCount('did-start-navigation'),0);
});
test('timeout preserves unknown and cannot replay with the same observer',async()=>{
  const c=fake();let calls=0;c.executeJavaScriptInIsolatedWorld=()=>{calls++;return new Promise(()=>{});};
  const o=createHomeObserver(c,{timeoutMs:10});await assert.rejects(o.read(),/status unknown/);await assert.rejects(o.read(),/invalidated/);assert.equal(calls,1);
});
test('malformed or oversized response fails closed and removes listeners',async()=>{
  for(const value of [null,{},'not-json',' '.repeat(65537)]){
    const c=fake();c.executeJavaScriptInIsolatedWorld=async()=>value;const o=createHomeObserver(c);
    await assert.rejects(o.read());await assert.rejects(o.read(),/invalidated/);assert.equal(c.listenerCount('did-start-navigation'),0);
  }
});
