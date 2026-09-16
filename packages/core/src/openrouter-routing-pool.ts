import canonicalize from 'canonicalize';
import type {RoutingCoordinator} from './routing-ledger.js';
import type {OpenRouterPolicy} from './openrouter-policy.js';
import {yen} from './budget.js';
import {moneyUnits,type Money} from './money.js';
export function checkOpenRouterRoutingPool(binding:ReturnType<RoutingCoordinator['confirmPoolInTransaction']>,policy:OpenRouterPolicy,bound:string|Money){
 const q=binding.qualification,c=q.sharedConfiguration;
 const enough=typeof bound==='string'?'maximumYen' in q&&typeof q.maximumYen==='string'&&yen(bound)>=yen(q.maximumYen):bound.currency==='USD'&&'maximum' in q&&q.maximum?.currency==='USD'&&moneyUnits(bound)>=moneyUnits(q.maximum);
 if(policy.mode!=='auto'||q.kind!=='eligible'||!enough
  ||canonicalize([...policy.models].sort())!==canonicalize(q.members.map(m=>m.model).sort())
  ||c.runtime!=='standard'||c.billingRoute!=='openrouter'||c.tools.length!==0||c.effort!=='provider-default')throw Error('OPENROUTER_ROUTING_POOL_MISMATCH');
 return c;
}
