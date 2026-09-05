import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { planDistribution } from "../src/index.js";

const addresses = [
  "0x0000000000000000000000000000000000000001",
  "0x0000000000000000000000000000000000000002",
  "0x0000000000000000000000000000000000000003",
];

describe("distribution accounting properties", () => {
  it("conserves cash and never exceeds component budgets", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.integer({ min: 1, max: 10_000 }),
          fc.integer({ min: 1, max: 10_000 }),
          fc.integer({ min: 1, max: 10_000 }),
        ),
        fc.bigInt({ min: 0n, max: 1_000_000n }),
        fc.bigInt({ min: 0n, max: 1_000_000n }),
        (weights, principalBudget, incomeBudget) => {
          fc.pre(principalBudget + incomeBudget > 0n);
          const balances = weights.map(BigInt);
          const plan = planDistribution({
            holders: addresses.map((address, index) => ({ address, balance: balances[index]! })),
            snapshotSupply: balances.reduce((sum, value) => sum + value, 0n),
            principalBudget,
            incomeBudget,
          });
          expect(plan.allocatedCash).toBe(plan.immutablePayoutTotal);
          expect(plan.roundingDust).toBe(0n);
          expect(plan.allocatedPrincipal).toBe(principalBudget);
          expect(plan.allocatedIncome).toBe(incomeBudget);
          expect(plan.allocatedPrincipal + plan.allocatedIncome).toBe(plan.allocatedCash);
          for (const entitlement of plan.entitlements) {
            expect(entitlement.principalAmount + entitlement.incomeAmount).toBe(entitlement.cashAmount);
          }
        },
      ),
      { numRuns: 500, seed: 20260913 },
    );
  });
});
