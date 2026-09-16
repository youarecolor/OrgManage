import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectOpenRouterKeyStatus} from '../../dist/core/src/openrouter-key-status.js';
const now=Date.parse('2026-09-15T00:00:00Z');
const data=()=>({is_management_key:false,is_provisioning_key:false,limit:10,limit_remaining:9.5,usage:0.5,limit_reset:null,expires_at:null,label:'sensitive-key-fragment',creator_user_id:'private-user'});
const run=patch=>inspectOpenRouterKeyStatus(Buffer.from(JSON.stringify({data:{...data(),...patch}})),'10',now);
test('key status exposes bounded amounts but not identity or inference authority',()=>{
 const result=run({});assert.equal(result.keyLimitVerified,true);assert.equal(result.remainingUsdUnits,'9500000000');assert.equal(result.executionAuthorized,false);assert.equal(result.accountCreditsVerified,false);
 assert.equal(JSON.stringify(result).includes('sensitive'),false);assert.equal(JSON.stringify(result).includes('private-user'),false);
});
test('unlimited, resettable, oversized, expired, disabled or management keys cannot pass',()=>{
 for(const patch of [{limit:null},{limit:11},{limit_reset:'monthly'},{expires_at:'2026-09-14T00:00:00Z'},{expires_at:'unrecognized'},{disabled:true},{is_management_key:true},{is_provisioning_key:true},{limit_remaining:0},{usage:4}])assert.equal(run(patch).keyLimitVerified,false);
});
test('missing and malformed metadata remain unknown rather than zero',()=>{
 for(const patch of [{usage:null},{limit_remaining:null},{limit_remaining:-1},{expires_at:undefined},{is_management_key:undefined}])assert.equal(run(patch).keyLimitVerified,false);
 for(const raw of ['{"data":{},"data":{}}','null','{"data":[]}'])assert.equal(inspectOpenRouterKeyStatus(Buffer.from(raw),'10',now).keyLimitVerified,false);
});
