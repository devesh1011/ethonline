import { describe, expect, it } from "vitest";
import { distributionPreview, hashPair, distributionEntitlementLeaf, principalFirstBudgets, planDistribution } from "../src/index.js";
const holders = [{ address: "0x0000000000000000000000000000000000000001", balance: 1n }, { address: "0x0000000000000000000000000000000000000002", balance: 2n }];
describe("immutable principal-first distribution", () => {
  it("uses only unreserved principal and rejects invalid cash budgets", () => {
    expect(principalFirstBudgets(100n, 100n, 120n, 40n)).toEqual({ principalBudget: 80n, incomeBudget: 20n });
    expect(() => principalFirstBudgets(101n, 100n, 120n, 40n)).toThrow();
    expect(() => principalFirstBudgets(1n, 100n, 10n, 11n)).toThrow();
    expect(() => principalFirstBudgets(0n, 100n, 10n, 0n)).toThrow();
    expect(() => planDistribution({ holders, snapshotSupply: 3n, principalBudget: 0n, incomeBudget: 0n })).toThrow("positive");
  });
  it("commits deterministic exact proofs and all money as strings", () => {
    const input = { holders, snapshotSupply: 3n, principalBudget: 80n, incomeBudget: 20n };
    const preview = distributionPreview(42n, input);
    expect(distributionPreview(42n, { ...input, holders: [...holders].reverse() })).toEqual(preview);
    expect(preview.roundingDust).toBe("0");
    expect(preview.roundingPolicy).toBe("LARGEST_REMAINDER_V1");
    for (const recipient of preview.recipients) {
      const leaf = distributionEntitlementLeaf({ holder: recipient.holder, snapshotBalance: BigInt(recipient.snapshotBalance), cashAmount: BigInt(recipient.cashAmount), principalAmount: BigInt(recipient.principalAmount), incomeAmount: BigInt(recipient.incomeAmount) });
      expect(recipient.proof.reduce(hashPair, leaf)).toBe(preview.entitlementRoot);
    }
    expect(() => JSON.stringify(preview)).not.toThrow();
  });
  it("retains zero-value recipients for explicit no-payment resolution", () => {
    const preview = distributionPreview(1n, { holders, snapshotSupply: 3n, principalBudget: 1n, incomeBudget: 0n });
    expect(preview.recipients.map(entry => entry.cashAmount)).toEqual(["0", "1"]);
    expect(preview.roundingDust).toBe("0");
  });
});
