import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMoney as money} from '../../dist/core/src/money.js';
import {makeUsdBudgetPolicy,canReserveUsd,usdBudgetTotals} from '../../dist/core/src/usd-budget.js';
import {canReserve} from '../../dist/core/src/budget.js';
const policy=makeUsdBudgetPolicy('40','80','10'),period='2026-09';
const row=(cost,held='0',purpose='production',pool='normal',month=period)=>({month,purpose,pool,booked:money('USD',cost),held:money('USD',held)});
test('activating a USD policy cannot keep using its historical JPY capacity',()=>{
 assert.equal(canReserve({normalLimitYen:'1000',autonomousELimitYen:'100',cash:{format:'usd_budget_policy_v1',...policy}},[],period,'1','production'),false);
});
test('USD normal/reserve and E subset enforce holds, reserve approval and exact boundary',()=>{
 const rows=[row('30','5'),row('2','1','autonomous_e')];
 assert.equal(canReserveUsd(policy,rows,period,money('USD','2'),'production','normal'),true);
 assert.equal(canReserveUsd(policy,rows,period,money('USD','2.000000001'),'production','normal'),false);
 assert.equal(canReserveUsd(policy,rows,period,money('USD','80'),'production','reserve'),false);
 assert.equal(canReserveUsd(policy,rows,period,money('USD','80'),'production','reserve',true),true);
 assert.equal(canReserveUsd(policy,[],period,money('USD','1'),'autonomous_e','reserve',true),false);
 assert.equal(canReserveUsd(policy,[row('9','1','autonomous_e')],period,money('USD','0.000000001'),'autonomous_e','normal'),false);
});
test('observed overspend stays in totals and stops new admission across pools',()=>{
 const rows=[row('41')];assert.equal(usdBudgetTotals(rows,period).total,41000000000n);
 assert.equal(canReserveUsd(policy,rows,period,money('USD','1'),'production','reserve',true),false);
 assert.equal(canReserveUsd(policy,[row('11','0','autonomous_e','reserve')],period,money('USD','1'),'production','normal'),false);
});
test('month rollover retains foreign unresolved debt and never relabels old JPY',()=>{
 const old={...row('0','0','production','normal','2026-08'),booked:money('JPY','100'),held:money('JPY','0')};
 assert.equal(usdBudgetTotals([old],period).total,0n);
 assert.throws(()=>usdBudgetTotals([{...old,held:money('JPY','1')}],period),/LEGACY_UNRESOLVED/);
 assert.throws(()=>usdBudgetTotals([{...old,month:period}],period),/CURRENCY/);
 assert.throws(()=>canReserveUsd(policy,[],period,money('JPY','1'),'production','normal'),/CURRENCY/);
 assert.throws(()=>makeUsdBudgetPolicy('1','2','2'),/E_NOT_SUBSET/);
});
