import { describe, expect, it } from "vitest";
import { planDistribution } from "../src/index.js";

const a = "0x0000000000000000000000000000000000000001";
const b = "0x0000000000000000000000000000000000000002";

describe("planDistribution", () => {
  it("classifies component rounding without exceeding either budget", () => {
    const plan = planDistribution({
      holders: [
        { address: b, balance: 1n },
        { address: a, balance: 1n },
      ],
      snapshotSupply: 2n,
      principalBudget: 1n,
      incomeBudget: 1n,
    });

    expect(plan.entitlements).toEqual([
      { holder: a, snapshotBalance: 1n, cashAmount: 1n, principalAmount: 1n, incomeAmount: 0n },
      { holder: b, snapshotBalance: 1n, cashAmount: 1n, principalAmount: 0n, incomeAmount: 1n },
    ]);
    expect(plan.allocatedPrincipal).toBe(1n);
    expect(plan.allocatedIncome).toBe(1n);
    expect(plan.roundingDust).toBe(0n);
  });

  it("preserves the 50/600/350 unit demo allocation", () => {
    const plan = planDistribution({
      holders: [
        { address: a, balance: 50n },
        { address: b, balance: 950n },
      ],
      snapshotSupply: 1_000n,
      principalBudget: 990_000_00n,
      incomeBudget: 0n,
    });

    expect(plan.entitlements.map((entry) => entry.cashAmount)).toEqual([49_500_00n, 940_500_00n]);
    expect(plan.allocatedCash).toBe(990_000_00n);
    expect(plan.entitlementRoot).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
