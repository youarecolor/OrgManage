import type { ObligationData, PolicyData } from './model.js';

const amountPattern = /^(0|[1-9][0-9]{0,17})(?![\s\S])/;
export function yen(value: string): bigint {
  if (typeof value !== 'string' || !amountPattern.test(value)) throw new RangeError('Invalid integer yen amount');
  return BigInt(value);
}
export function budgetMonth(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new RangeError('Invalid clock');
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 7);
}
export type BudgetAmounts = Pick<ObligationData, 'month' | 'purpose' | 'bookedYen' | 'heldYen'>;
export function aggregate(obligations: readonly BudgetAmounts[], month: string) {
  let booked = 0n, held = 0n, autonomousE = 0n;
  for (const row of obligations) {
    if (row.month !== month) continue;
    const b = yen(row.bookedYen), h = yen(row.heldYen);
    booked += b; held += h;
    if (row.purpose === 'autonomous_e') autonomousE += b + h;
  }
  return { booked, held, autonomousE };
}
export function canReserve(policy: Pick<PolicyData,'normalLimitYen'|'autonomousELimitYen'|'cash'>, obligations: readonly BudgetAmounts[], month: string,
  amount: string, purpose: ObligationData['purpose']): boolean {
  if(policy.cash!==undefined)return false;
  const sum = aggregate(obligations, month), requested = yen(amount);
  return sum.booked + sum.held + requested <= yen(policy.normalLimitYen)
    && (purpose !== 'autonomous_e' || sum.autonomousE + requested <= yen(policy.autonomousELimitYen));
}
