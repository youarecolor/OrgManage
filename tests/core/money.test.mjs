import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMoney,formatMoney,addMoney,compareMoney,moneyUnits} from '../../dist/core/src/money.js';
import {usdUnits} from '../../dist/core/src/api-trial-budget.js';
test('USD nano precision is exact and legacy JPY is not reinterpreted',()=>{
 assert.equal(formatMoney(addMoney(parseMoney('USD','0.1'),parseMoney('USD','0.2'))),'0.3');
 assert.equal(usdUnits('0.000000001'),1n);assert.equal(formatMoney(parseMoney('USD','10.800000000')),'10.8');
 const dollars=parseMoney('USD','10'),yen=parseMoney('JPY','10');
 assert.equal(moneyUnits(dollars),10000000000n);assert.equal(moneyUnits(yen),10n);
 assert.throws(()=>addMoney(dollars,yen),/CURRENCY_MISMATCH/);assert.throws(()=>compareMoney(dollars,yen),/CURRENCY_MISMATCH/);
});
test('invalid amounts, unknown currency and aggregate overflow fail closed',()=>{
 for(const text of ['1e-9','-1','+1','01','1.0000000001',' 1','1\n','NaN'])assert.throws(()=>parseMoney('USD',text));
 assert.throws(()=>parseMoney('JPY','1.1'));assert.throws(()=>parseMoney('EUR','1'));
 assert.throws(()=>moneyUnits({format:'money_v1',currency:'USD',units:'1.0'}));
 assert.throws(()=>addMoney(parseMoney('USD','999999999.999999999'),parseMoney('USD','0.000000001')));
 assert.equal(compareMoney(parseMoney('USD','0.000000002'),parseMoney('USD','0.000000001')),1);
});
