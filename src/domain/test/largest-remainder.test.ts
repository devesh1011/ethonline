import { expect, test } from "vitest";
import fc from "fast-check";
import { planDistribution } from "../src/index.js";
const address = (index: number) => `0x${(index + 1).toString(16).padStart(40, "0")}`;
test("901 units allocate 300/601 and conserve principal800 plus income101", () => {
  const result = planDistribution({ snapshotSupply: 3n, holders: [{ address: address(0), balance: 1n }, { address: address(1), balance: 2n }], principalBudget: 800n, incomeBudget: 101n });
  expect(result.entitlements.map(entry => [entry.cashAmount, entry.principalAmount, entry.incomeAmount])).toEqual([[300n, 267n, 33n], [601n, 533n, 68n]]);
  expect(result.roundingDust).toBe(0n);
});
test("ties go to normalized ascending addresses regardless of input order", () => {
  const result = planDistribution({ snapshotSupply: 3n, holders: [{ address: address(2), balance: 1n }, { address: address(0), balance: 1n }, { address: address(1), balance: 1n }], principalBudget: 1n, incomeBudget: 0n });
  expect(result.entitlements.map(entry => entry.cashAmount)).toEqual([1n, 0n, 0n]);
});
test("generated small budgets retain zero owners and allocate exactly by largest remainder", () => {
  fc.assert(fc.property(fc.array(fc.bigInt({ min: 1n, max: 10n ** 20n }), { minLength: 1, maxLength: 32 }), fc.bigInt({ min: 0n, max: 20n }), fc.bigInt({ min: 0n, max: 20n }), (weights, principalBudget, incomeBudget) => {
    fc.pre(principalBudget + incomeBudget > 0n);
    const total = principalBudget + incomeBudget, supply = weights.reduce((a, b) => a + b, 0n);
    const holders = weights.map((balance, index) => ({ address: address(index), balance }));
    const plan = planDistribution({ holders, snapshotSupply: supply, principalBudget, incomeBudget });
    expect(plan.entitlements).toHaveLength(weights.length); expect(plan.allocatedCash).toBe(total); expect(plan.allocatedPrincipal).toBe(principalBudget); expect(plan.allocatedIncome).toBe(incomeBudget); expect(plan.roundingDust).toBe(0n);
    expect(planDistribution({ holders: [...holders].reverse(), snapshotSupply: supply, principalBudget, incomeBudget }).entitlementRoot).toBe(plan.entitlementRoot);
    const winners = plan.entitlements.filter((entry, index) => entry.cashAmount > total * weights[index]! / supply);
    const losers = plan.entitlements.filter((entry, index) => entry.cashAmount === total * weights[index]! / supply);
    for (const winner of winners) for (const loser of losers) {
      const a = total * winner.snapshotBalance % supply, b = total * loser.snapshotBalance % supply;
      expect(a > b || (a === b && winner.holder < loser.holder)).toBe(true);
    }
    for (const entry of plan.entitlements) { expect(entry.principalAmount + entry.incomeAmount).toBe(entry.cashAmount); expect(entry.cashAmount - total * entry.snapshotBalance / supply).toBeLessThanOrEqual(1n); }
  }), { seed: 260913, numRuns: 500 });
});
