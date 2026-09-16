import {parseMoney,moneyUnits} from './money.js';
import type {CashObligationData,ObligationData} from './model.js';
import type {CashBudgetRow} from './usd-budget.js';
export type CommonObligation=CashObligationData|ObligationData;
export function isCash(value:CommonObligation):value is CashObligationData{return 'format' in value&&value.format==='cash_obligation_v1';}
/** Retain legacy history. Only confirmed zero is currency independent. */
export function cashBudgetRows(values:readonly CommonObligation[]):CashBudgetRow[]{
 return values.map(value=>{
  if(isCash(value))return value;
  if(value.settled!==true)throw Error('USD_BUDGET_LEGACY_UNRESOLVED');
  const held=parseMoney('JPY',value.heldYen),booked=parseMoney('JPY',value.bookedYen);
  return {...value,held:moneyUnits(held)===0n?parseMoney('USD','0'):held,booked:moneyUnits(booked)===0n?parseMoney('USD','0'):booked};
 });
}
