import test from 'node:test';
import assert from 'node:assert/strict';
import {checkOpenRouterKey} from '../../dist/host/src/openrouter-key-check.js';
const now=Date.parse('2026-09-15T00:00:00Z');
const data={is_management_key:false,is_provisioning_key:false,limit:10,limit_remaining:9,usage:1,limit_reset:null,expires_at:null,label:'PRIVATE_LABEL'};
const port={withKey:use=>use('synthetic-key')};
const response=(patch={},options={})=>new Response(JSON.stringify({data:{...data,...patch}}),{headers:{'content-type':'application/json'},...options});
test('fixed metadata GET uses one scoped key and bounded freshness without execution authority',async()=>{
 let calls=0;
 const result=await checkOpenRouterKey(port,async(url,o)=>{calls++;assert.equal(url,'https://openrouter.ai/api/v1/key');assert.equal(o.method,'GET');assert.equal(o.redirect,'error');assert.equal(o.body,undefined);assert.equal(o.headers.Authorization,'Bearer synthetic-key');return response();},()=>now);
 assert.equal(calls,1);assert.equal(result.keyLimitVerified,true);assert.equal(result.expiresAt,now+60000);assert.equal(result.executionAuthorized,false);assert.equal(result.accountCreditsVerified,false);assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
 const expiring=await checkOpenRouterKey(port,async()=>response({expires_at:new Date(now+3000).toISOString()}),()=>now);assert.equal(expiring.expiresAt,now+3000);
});
test('non-JSON, HTTP errors, oversized body, invalid JSON and vault errors stay unknown without retry',async()=>{
 for(const make of [()=>response({}, {headers:{'content-type':'text/html'}}),()=>response({}, {status:401}),()=>new Response('x'.repeat(65537),{headers:{'content-type':'application/json'}}),()=>new Response('{',{headers:{'content-type':'application/json'}})]){
  let calls=0;const result=await checkOpenRouterKey(port,async()=>{calls++;return make();},()=>now);assert.equal(result.keyLimitVerified,false);assert.equal(result.executionAuthorized,false);assert.equal(calls,1);
 }
 const result=await checkOpenRouterKey({withKey:async()=>{throw Error('PRIVATE_SECRET');}},async()=>{assert.fail('must not fetch');},()=>now);assert.equal(result.reason,'metadata_unavailable');assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
});
test('clock rollback and responses after the original deadline cannot qualify',async()=>{
 for(const end of [now-1,now+15000]){let i=0;const result=await checkOpenRouterKey(port,async()=>response(),()=>i++===0?now:end);assert.equal(result.keyLimitVerified,false);assert.equal(result.reason,'metadata_stale');}
});

test('stop returns while a vault is pending and a late key cannot start HTTP',async()=>{
 const stop=new AbortController();let late;
 const pending=checkOpenRouterKey({withKey:use=>new Promise(resolve=>{late=()=>resolve(use('late-key'));})},async()=>{assert.fail('late key must not send');},()=>now,stop.signal);
 stop.abort();const result=await pending;assert.equal(result.reason,'metadata_interrupted');
 late();await new Promise(resolve=>setImmediate(resolve));
});
test('stop does not await an uncooperative HTTP operation or accept its late result',async()=>{
 const stop=new AbortController();let finish,cancelled=false;
 const pending=checkOpenRouterKey(port,()=>new Promise(resolve=>{finish=resolve;}),()=>now,stop.signal);
 stop.abort();assert.equal((await pending).reason,'metadata_interrupted');
 finish(new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}}));
 await new Promise(resolve=>setImmediate(resolve));assert.equal(cancelled,true);
});
test('already stopped checks never access the vault',async()=>{
 const stop=new AbortController();stop.abort();
 const result=await checkOpenRouterKey({withKey:()=>assert.fail('vault access')},async()=>assert.fail('HTTP access'),()=>now,stop.signal);
 assert.equal(result.reason,'metadata_interrupted');
});
test('the real fixed deadline releases a hung vault without caller cancellation',{timeout:20000},async()=>{
 const started=performance.now();
 const result=await checkOpenRouterKey({withKey:()=>new Promise(()=>{})},async()=>assert.fail('HTTP access'));
 assert.equal(result.reason,'metadata_interrupted');assert.ok(performance.now()-started>=14000);assert.ok(performance.now()-started<19000);
});
