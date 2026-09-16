import test from 'node:test';
import assert from 'node:assert/strict';
import {ExtensionGateway} from '../../dist/core/src/extensions.js';
import {fixture,snap,request,randomUUID,bytes,committed} from './fixtures/helpers.mjs';
test('interactive extension uses same command deduplication and principal ledger',async t=>{
  const f=await fixture(t),g=new ExtensionGateway(f.core,()=>f.now.getTime()),surface=g.register(f.session,'human_interactive',f.now.getTime()+10000),view=snap(f);
  const cmd=bytes(request('conversation.post',view.conversation.id,view.conversation.revision,{message_id:randomUUID(),raw_text:'別画面からの本人入力',attachment_refs:[],relation_hint:'new'}));
  committed(g.command(surface,cmd));const after=snap(f);g.command(surface,cmd);assert.equal(snap(f).missions.length,after.missions.length);assert.deepEqual(g.snapshot(surface),snap(f));
});
test('preview cannot approve, forged/revoked/expired surfaces are refused',async t=>{
  const f=await fixture(t),g=new ExtensionGateway(f.core,()=>f.now.getTime()),surface=g.register(f.session,'read_only',f.now.getTime()+1);
  assert.equal(g.command(surface,bytes({})).error.code,'EXTENSION_READ_ONLY');assert.throws(()=>g.snapshot({}),/UNAVAILABLE/);
  f.now=new Date(f.now.getTime()+1);assert.throws(()=>g.snapshot(surface),/UNAVAILABLE/);
  const next=g.register(f.session,'human_interactive',f.now.getTime()+10);g.revoke(next);assert.throws(()=>g.snapshot(next),/UNAVAILABLE/);
});
