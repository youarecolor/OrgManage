import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {projectNativePreparation,ZERO_TOOL_PROFILE as pin} from '../../dist/host/src/native-preparation.js';
const now=1789392000000;
test('host pins match the current reviewed guest source files',async()=>{
 for(const [name,expected] of [['session-zero-tools.cs',pin.runner],['prepare-provider-zero-tools.ps1',pin.preparation]]){
  const bytes=await readFile(new URL('../../scripts/guest-packages/codex-session/'+name,import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),expected);
 }
});
function fixture(){
 const binding={sessionId:'a'.repeat(64),processId:123,processStartTicks:'639249878675011252',accountRoute:'test-only-route',profileDigest:pin.profile,model:'gpt-6-astra',effort:'low',helperSourceDigest:'b'.repeat(64),vmId:pin.vm,runnerDigest:pin.runner,cliDigest:pin.cli};
 const live={processId:456,profilePinned:true,processExitObserved:false,preparationSourceDigest:pin.preparation,expiresAt:now+45000};
 const featureNames=['apps','plugins','multi_agent','shell_tool','unified_exec','apply_patch_freeform','browser_use','computer_use','code_mode_host','shell_snapshot','skill_mcp_dependency_install','memories','goals','view_image','sleep_tool','current_time_reminder','token_budget','deferred_executor','image_generation','tool_suggest','request_permissions_tool','default_mode_request_user_input','multi_agent_v2'];
 const raw={format:'native_guest_preparation_v1',processId:456,threadId:'test-only-thread',model:'gpt-6-astra',effort:'low',accountType:'chatgpt',plan:'pro',credits:{bucket:'codex',paidCreditsAvailable:false,unlimitedCredits:false,creditBalance:'0',remaining:'unknown'},creditObservedAt:now-100,features:Object.fromEntries(featureNames.map(k=>[k,k==='unified_exec'])),threadPermissionProfile:'orgmanage_guest_native_edit',threadInstructionSources:0,apiFallbackEnabled:false,purchaseOperationsEnabled:false,turnsSent:0,observedAt:now,methods:['initialize','account/read','config/read','experimentalFeature/list','account/rateLimits/read','thread/start'],runtimeQualified:false,toolBoundary:'zero_tools_capture_and_pinned_startup_not_runtime_qualification',catalogDigest:pin.catalog.toUpperCase(),toolProfileDigest:pin.profile.toUpperCase()};
 return {raw,binding,live};
}
test('owned preparation projects bounded evidence without copying raw account metadata',()=>{
 const {raw,binding,live}=fixture();const value=projectNativePreparation(raw,binding,live,now);
 assert.equal(value.expiresAt,live.expiresAt);assert.equal(value.guest.processId,456);assert.equal(value.threadId,raw.threadId);assert.equal(value.toolsEnabled,false);
 assert.equal('credits' in value,false);assert.equal('plan' in value,false);assert.equal('runtimeQualified' in value,false);
 raw.threadId='changed';binding.helperSourceDigest='c'.repeat(64);assert.equal(value.threadId,'test-only-thread');assert.equal(value.helper.sourceDigest,'b'.repeat(64));
});
for(const [name,mutate] of [
 ['closed session',x=>x.live.processExitObserved=true],['released file pin',x=>x.live.profilePinned=false],['different guest PID',x=>x.live.processId++],
 ['wrong runner',x=>x.binding.runnerDigest='0'.repeat(64)],['wrong preparation source',x=>x.live.preparationSourceDigest='0'.repeat(64)],['wrong catalog',x=>x.raw.catalogDigest='0'.repeat(64)],
 ['enabled tool',x=>x.raw.features.multi_agent_v2=true],['missing tool observation',x=>delete x.raw.features.sleep_tool],['unknown feature',x=>x.raw.features.future=false],
 ['extra secret field',x=>x.raw.token='reject-without-copy'],['paid credit',x=>x.raw.credits.creditBalance='1'],['unknown balance',x=>x.raw.credits.creditBalance=null],
 ['previously sent turn',x=>x.raw.turnsSent=1],['unexpected RPC',x=>x.raw.methods.push('turn/start')],['fallback enabled',x=>x.raw.apiFallbackEnabled=true],
 ['future observation',x=>x.raw.observedAt=now+1],['expiry renewed',x=>x.live.expiresAt=now+60001],['expired',x=>x.live.expiresAt=now],['stale credits',x=>x.raw.creditObservedAt=now-300001],
 ['wrong model',x=>x.binding.model='other'],['wrong effort',x=>x.raw.effort='high'],['runtime qualification smuggled',x=>x.raw.runtimeQualified=true],
])test(`projection refuses ${name}`,()=>{const x=fixture();mutate(x);assert.throws(()=>projectNativePreparation(x.raw,x.binding,x.live,now));});
