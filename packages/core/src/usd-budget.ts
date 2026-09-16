import {moneyUnits,parseMoney,type Money} from './money.js';
export interface UsdBudgetPolicy {normal:Money;reserve:Money;autonomousE:Money}
export interface CashBudgetRow {month:string;purpose:'production'|'autonomous_e';pool:'normal'|'reserve';booked:Money;held:Money}
// Product policy values are supplied from the owner's versioned policy, not
// from this module. No personal budget defaults are embedded in public source.
function usd(value:Money):bigint{const n=moneyUnits(value);if(value.currency!=='USD')throw Error('USD_BUDGET_CURRENCY');return n;}
function month(value:string){if(!/^\d{4}-(0[1-9]|1[0-2])(?![\s\S])/.test(value))throw Error('USD_BUDGET_MONTH');}
export function usdBudgetTotals(rows:readonly CashBudgetRow[],period:string){
 month(period);let normal=0n,reserve=0n,autonomousE=0n;
 for(const row of rows){
  month(row.month);
  if(!['normal','reserve'].includes(row.pool)||!['production','autonomous_e'].includes(row.purpose))throw Error('USD_BUDGET_SCOPE');
  // Even an old-month unresolved foreign obligation must not disappear at a
  // currency migration. Settled old-month history may remain in its currency.
  if(row.month!==period){if(moneyUnits(row.held)>0n&&row.held.currency!=='USD')throw Error('USD_BUDGET_LEGACY_UNRESOLVED');continue;}
  const total=usd(row.booked)+usd(row.held);
  if(row.pool==='normal')normal+=total;else reserve+=total;
  if(row.purpose==='autonomous_e')autonomousE+=total;
 }
 return {normal,reserve,autonomousE,total:normal+reserve};
}
export function canReserveUsd(policy:UsdBudgetPolicy,rows:readonly CashBudgetRow[],period:string,requested:Money,purpose:CashBudgetRow['purpose'],pool:CashBudgetRow['pool'],reserveApproved=false):boolean{
 const normal=usd(policy.normal),reserve=usd(policy.reserve),e=usd(policy.autonomousE),amount=usd(requested);
 if(e>normal)throw Error('USD_BUDGET_E_NOT_SUBSET');
 if(!['normal','reserve'].includes(pool)||!['production','autonomous_e'].includes(purpose))throw Error('USD_BUDGET_SCOPE');
 const sum=usdBudgetTotals(rows,period);
 if(sum.normal>normal||sum.reserve>reserve||sum.autonomousE>e)return false;
 if(pool==='reserve'&&(!reserveApproved||purpose==='autonomous_e'))return false;
 return (pool==='normal'?sum.normal+amount<=normal:sum.reserve+amount<=reserve)
  &&sum.total+amount<=normal+reserve
  &&(purpose!=='autonomous_e'||sum.autonomousE+amount<=e);
}
export function makeUsdBudgetPolicy(normal:string,reserve:string,autonomousE:string):UsdBudgetPolicy{
 const result={normal:parseMoney('USD',normal),reserve:parseMoney('USD',reserve),autonomousE:parseMoney('USD',autonomousE)};
 if(usd(result.autonomousE)>usd(result.normal))throw Error('USD_BUDGET_E_NOT_SUBSET');
 return Object.freeze(result);
}
