/** Versioned amounts. USD precision matches provider nano-dollar accounting;
 * legacy JPY values remain integer yen and are never relabelled as dollars. */
export type Currency='USD'|'JPY';
export interface Money {readonly format:'money_v1';readonly currency:Currency;readonly units:string}
const unitsPattern=/^(0|[1-9][0-9]{0,17})(?![\s\S])/;
export function moneyUnits(value:Money):bigint{
 if(!value||value.format!=='money_v1'||!['USD','JPY'].includes(value.currency)||typeof value.units!=='string'||!unitsPattern.test(value.units))throw Error('MONEY_INVALID');
 return BigInt(value.units);
}
export function parseMoney(currency:Currency,decimal:string):Money{
 if(typeof decimal!=='string')throw Error('MONEY_INVALID');
 let units:string;
 if(currency==='USD'){
  if(!/^(0|[1-9][0-9]{0,8})(\.[0-9]{1,9})?(?![\s\S])/.test(decimal))throw Error('MONEY_INVALID');
  const [whole,fraction='']=decimal.split('.');units=String(BigInt(whole!)*1000000000n+BigInt(fraction.padEnd(9,'0')));
 }else if(currency==='JPY'&&unitsPattern.test(decimal))units=decimal;
 else throw Error('MONEY_INVALID');
 return Object.freeze({format:'money_v1',currency,units});
}
export function formatMoney(value:Money):string{
 const units=moneyUnits(value);if(value.currency==='JPY')return String(units);
 const fraction=String(units%1000000000n).padStart(9,'0').replace(/0+$/,'');
 return String(units/1000000000n)+(fraction?'.'+fraction:'');
}
export function addMoney(left:Money,right:Money):Money{
 const a=moneyUnits(left),b=moneyUnits(right);
 if(left.currency!==right.currency)throw Error('MONEY_CURRENCY_MISMATCH');
 const result={format:'money_v1' as const,currency:left.currency,units:String(a+b)};moneyUnits(result);return Object.freeze(result);
}
export function compareMoney(left:Money,right:Money):number{
 const a=moneyUnits(left),b=moneyUnits(right);
 if(left.currency!==right.currency)throw Error('MONEY_CURRENCY_MISMATCH');
 return a===b?0:a<b?-1:1;
}
