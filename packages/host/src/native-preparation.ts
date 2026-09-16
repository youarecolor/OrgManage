import {validateNativePreparation,type NativePreparationReceipt} from '../../core/src/native-session-ingress.js';
import type {NativePreparedExpected} from './native-pipe.js';
import {readPinnedNativeVmBinding} from '../../local-bindings/src/index.js';

/** Fixed profile facts, independently captured with the pinned official CLI.
 * This converter is only called by the helper that owns the live guest Session.
 * It is not an admission API and must not be exposed to renderer/candidate code. */
export const ZERO_TOOL_PROFILE=Object.freeze({
 catalog:'87617477ed3d80510088d7175f9ee933c52abf18a1dc43d36ac15247fcc102d3',
 profile:'aa84a97efa273c52d814d998ba66d27172928970ce3ac8b9dd990f6aff1ddf8e',
 runner:'d8c907ae28bb02e2d3299b7c46a48a731fe6f1a6b3687684957fa51fd5b918b2',
 cli:'be96b992178b1e467c225800da0d65f2c86d5eba1ef0b14632f65db381cbdfde',
 preparation:'5cef1b23101dc469cc2933c918388198c6aec8a81264297f408a9072e65d4795',
 get vm(){return readPinnedNativeVmBinding().vmId;},
});
const features=['apps','plugins','multi_agent','shell_tool','unified_exec','apply_patch_freeform','browser_use','computer_use','code_mode_host','shell_snapshot','skill_mcp_dependency_install','memories','goals','view_image','sleep_tool','current_time_reminder','token_budget','deferred_executor','image_generation','tool_suggest','request_permissions_tool','default_mode_request_user_input','multi_agent_v2'];
const methods=['initialize','account/read','config/read','experimentalFeature/list','account/rateLimits/read','thread/start'];
type ObjectValue=Record<string,unknown>;
function check(v:unknown):asserts v{if(!v)throw Error('NATIVE_PREPARATION_PROJECTION_DENIED');}
function object(v:unknown):ObjectValue{check(v&&typeof v==='object'&&!Array.isArray(v));return v as ObjectValue;}
function exact(v:ObjectValue,keys:string[]){check(Object.keys(v).sort().join('|')===[...keys].sort().join('|'));}
export interface NativeGuestLiveObservation {
 processId:number;profilePinned:boolean;processExitObserved:boolean;
 preparationSourceDigest:string;expiresAt:number;
}
/** Projects only allowlisted metadata obtained in the same owned PSDirect
 * session. Expiry is derived from the original observation, never renewed by
 * polling. The host still must verify the pipe/helper identity before import. */
export function projectNativePreparation(raw:unknown,binding:NativePreparedExpected,live:NativeGuestLiveObservation,now:number):Readonly<NativePreparationReceipt>{
 const r=object(raw);
 exact(object(live),['processId','profilePinned','processExitObserved','preparationSourceDigest','expiresAt']);
 exact(r,['format','processId','threadId','model','effort','accountType','plan','credits','creditObservedAt','features','threadPermissionProfile','threadInstructionSources','apiFallbackEnabled','purchaseOperationsEnabled','turnsSent','observedAt','methods','runtimeQualified','toolBoundary','catalogDigest','toolProfileDigest']);
 check(binding.vmId===ZERO_TOOL_PROFILE.vm&&binding.runnerDigest===ZERO_TOOL_PROFILE.runner&&binding.cliDigest===ZERO_TOOL_PROFILE.cli);
 check(binding.profileDigest===ZERO_TOOL_PROFILE.profile&&binding.model==='gpt-6-astra'&&binding.effort==='low');
 check(live.preparationSourceDigest===ZERO_TOOL_PROFILE.preparation&&live.profilePinned===true&&live.processExitObserved===false);
 check(Number.isSafeInteger(live.processId)&&live.processId>0&&r.processId===live.processId);
 check(r.format==='native_guest_preparation_v1'&&r.model===binding.model&&r.effort===binding.effort&&r.accountType==='chatgpt'&&['plus','pro'].includes(String(r.plan)));
 check(r.catalogDigest===ZERO_TOOL_PROFILE.catalog.toUpperCase()&&r.toolProfileDigest===ZERO_TOOL_PROFILE.profile.toUpperCase());
 check(r.runtimeQualified===false&&r.toolBoundary==='zero_tools_capture_and_pinned_startup_not_runtime_qualification');
 check(r.threadPermissionProfile==='orgmanage_guest_native_edit'&&r.threadInstructionSources===0&&r.apiFallbackEnabled===false&&r.purchaseOperationsEnabled===false&&r.turnsSent===0);
 check(Array.isArray(r.methods)&&JSON.stringify(r.methods)===JSON.stringify(methods));
 const f=object(r.features);exact(f,features);for(const k of features)check(f[k]===(k==='unified_exec'));
 const c=object(r.credits);exact(c,['bucket','paidCreditsAvailable','unlimitedCredits','creditBalance','remaining']);
 check(c.bucket==='codex'&&c.paidCreditsAvailable===false&&c.unlimitedCredits===false&&c.creditBalance==='0'&&c.remaining==='unknown');
 check(typeof r.observedAt==='number'&&Number.isSafeInteger(r.observedAt)&&r.observedAt<=now);
 check(typeof r.creditObservedAt==='number'&&Number.isSafeInteger(r.creditObservedAt)&&r.creditObservedAt>=0&&r.creditObservedAt<=r.observedAt&&now-r.creditObservedAt<=300000);
 check(Number.isSafeInteger(live.expiresAt)&&live.expiresAt>now&&live.expiresAt<=r.observedAt+60000);
 check(typeof r.threadId==='string');
 return validateNativePreparation({format:'native_preparation_v1',mode:'provider',stage:'ready',sessionId:binding.sessionId,threadId:r.threadId,accountRoute:binding.accountRoute,profileDigest:binding.profileDigest,model:binding.model,effort:binding.effort,helper:{processId:binding.processId,startTicks:binding.processStartTicks,sourceDigest:binding.helperSourceDigest},guest:{vmId:binding.vmId,processId:live.processId,runnerDigest:binding.runnerDigest,cliDigest:binding.cliDigest},observedAt:r.observedAt,expiresAt:live.expiresAt,closed:false,turnsSent:0,maxTurns:1,toolsEnabled:false,apiFallbackEnabled:false,purchaseOperationsEnabled:false},now);
}
