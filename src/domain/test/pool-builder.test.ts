import { describe, expect, it } from "vitest";
import { buildPool, demoFactoringUnits, factoringUnitLeaf, hashPair, merkleProof } from "../src/index.js";

describe("buildPool", () => {
  it("commits ten eligible receivables and explains two rejections", () => {
    const result = buildPool(demoFactoringUnits);

    expect(result.accepted).toHaveLength(10);
    expect(result.rejected).toEqual([
      { fuId: "FU-011", reasons: ["BUYER_NOT_ACCEPTED"] },
      { fuId: "FU-012", reasons: ["ASSIGNMENT_NOT_CONFIRMED"] },
    ]);
    expect(result.faceValue).toBe(10_000_000_00n);
    expect(result.poolRoot).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("produces the same commitment regardless of import order", () => {
    const expected = buildPool(demoFactoringUnits);
    const shuffled = buildPool([...demoFactoringUnits].reverse());

    expect(shuffled.poolRoot).toBe(expected.poolRoot);
    expect(shuffled.manifestHash).toBe(expected.manifestHash);
  });

  it("proves an accepted FU belongs to the committed pool", () => {
    const pool = buildPool(demoFactoringUnits);
    const leaves = pool.accepted.map(factoringUnitLeaf);
    const target = factoringUnitLeaf(pool.accepted[0]!);
    const proof = merkleProof(leaves, target);
    const reconstructed = proof.reduce((node, sibling) => hashPair(node, sibling), target);

    expect(reconstructed).toBe(pool.poolRoot);
  });
});
