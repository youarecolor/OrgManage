import test from 'node:test';
import assert from 'node:assert/strict';
import {StandardExecutor} from '../../dist/core/src/standard-executor.js';
const policy={maxSteps:4,maxInputBytes:10000,maxOutputBytes:10000,deadlineMs:100,tools:['read_fixture']};

test('deadline elapsed inside synchronous acquisition prevents starting an effect even before timer delivery',async()=>{
 for(const blockedKind of ['model','tool']){
  let modelCalls=0,toolCalls=0;
  const f=fixture({acquire:kind=>{
   if(kind===blockedKind){const until=performance.now()+30;while(performance.now()<until){/* simulate synchronous ledger stall */}}
   return kind;
  },model:async()=>{modelCalls++;return {kind:'tool',name:'read_fixture',arguments:{}};},tool:async()=>{toolCalls++;return {};}});
  const r=await new StandardExecutor(f.port,{...policy,deadlineMs:20}).run('input',new AbortController().signal);
  assert.equal(r.state,'unknown');assert.equal(r.reason,'stop_after_acquire');
  assert.equal(modelCalls,blockedKind==='model'?0:1);assert.equal(toolCalls,0);
  assert.equal(f.events.at(-1)[1],blockedKind);assert.equal(f.events.at(-1)[2],'unknown');
 }
});

test('adapter mutation cannot change a validated tool call or the retained transcript',async()=>{
 let turn=0;const calls=[];
 const f=fixture({acquire:(kind,input)=>{
  if(kind==='tool'){input.name='shell';input.arguments.path='changed';}
  return kind;
 },model:async input=>{
  if(turn++===0)return {kind:'tool',name:'read_fixture',arguments:{path:'original'}};
  assert.equal(input[1].name,'read_fixture');assert.equal(input[1].arguments.path,'original');
  assert.deepEqual(input[2].output,{text:'trusted observation'});
  return {kind:'final',text:'done'};
 },tool:async(name,args)=>{calls.push([name,args.path]);args.path='tool mutation';return {text:'trusted observation'};},
 observe:(_id,_state,value)=>{if(value&&typeof value==='object'){value.name='shell';value.text='observer mutation';if(value.arguments)value.arguments.path='observer mutation';}}});
 const r=await new StandardExecutor(f.port,policy).run('input',new AbortController().signal);
 assert.equal(r.state,'completed');assert.equal(r.text,'done');assert.deepEqual(calls,[['read_fixture','original']]);
});
function fixture(overrides={}){const events=[];let n=0;const port={acquire:(kind,input)=>{events.push(['intent',kind,input]);return String(++n);},model:async()=>({kind:'final',text:'done'}),tool:async()=>({fixture:true}),observe:(...e)=>events.push(['observe',...e]),...overrides};return {events,port};}
test('standard loop orders model/tool intent before effects, preserves original and has finite steps',async()=>{
  let turn=0;const f=fixture({model:async(input)=>{assert.equal(input[0].text,'original');return turn++?{kind:'final',text:'done'}:{kind:'tool',name:'read_fixture',arguments:{}};}});
  const r=await new StandardExecutor(f.port,policy).run('original',new AbortController().signal);assert.equal(r.state,'completed');assert.equal(r.steps,3);
  assert.deepEqual(f.events.filter(e=>e[0]==='intent').map(e=>e[1]),['model','tool','model']);
});
test('model cannot invent a tool or change the execution policy',async()=>{
  let called=false;const f=fixture({model:async()=>({kind:'tool',name:'shell',arguments:{}}),tool:async()=>{called=true;}});
  const r=await new StandardExecutor(f.port,policy).run('input',new AbortController().signal);
  assert.equal(r.state,'unknown');assert.equal(called,false);assert.equal(f.events.at(-1)[2],'unknown');
});
test('timeout retains unknown and does not retry a model ignoring abort',async()=>{
  const f=fixture({model:async()=>new Promise(()=>{})});const r=await new StandardExecutor(f.port,{...policy,deadlineMs:10}).run('input',new AbortController().signal);
  assert.equal(r.state,'unknown');assert.equal(f.events.filter(e=>e[0]==='intent').length,1);
});
test('pre-cancelled run creates no intent and step limit forbids the next tool',async()=>{
  const stop=new AbortController();stop.abort();const f=fixture();assert.equal((await new StandardExecutor(f.port,policy).run('input',stop.signal)).state,'stopped');assert.equal(f.events.length,0);
  const g=fixture({model:async()=>({kind:'tool',name:'read_fixture',arguments:{}})});assert.equal((await new StandardExecutor(g.port,{...policy,maxSteps:1}).run('input',new AbortController().signal)).state,'limit');assert.equal(g.events.filter(e=>e[0]==='intent').length,1);
});
