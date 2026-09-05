import { AbiCoder, id, keccak256 } from "ethers";
import { describe, expect, it } from "vitest";
import { buildPool, collectionCommandIdentity, collectionEventIdentity, createDemoPoolAccounting, demoFactoringUnits, hashPair, MAX_AMOUNT_MINOR_UNITS, merkleProof, merkleProofs, parseFactoringUnitImport, ServicingLedger, validateCollectionCommand, validateFactoringUnitImport } from "../src/index";

const unit = demoFactoringUnits[0]!;

describe("runtime import schema", () => {
  it("normalizes JSON money, date and hash without changing existing commitments", () => {
    const records = demoFactoringUnits.map((item) => ({ ...item, faceValue: item.faceValue.toString(), acceptedAt: new Date(item.acceptedAt * 1_000).toISOString(), dueDate: new Date(item.dueDate * 1_000).toISOString(), evidenceHash: `0x${item.evidenceHash.slice(2).toUpperCase()}` }));
    expect(parseFactoringUnitImport(records)).toEqual(demoFactoringUnits);
    expect(buildPool(parseFactoringUnitImport(records))).toEqual(buildPool(demoFactoringUnits));
  });

  it.each([0n, -1n, MAX_AMOUNT_MINOR_UNITS + 1n, 100, "0", "01", "1.1", "1e3", "-1", "1000000000000000000"])("rejects invalid amount %s", (faceValue) => {
    expect(validateFactoringUnitImport([{ ...unit, faceValue }]).issues).toEqual([expect.objectContaining({ row: 1, field: "faceValue" })]);
  });

  it.each([{ currency: "USD" }, { dueDate: "2026-02-30T00:00:00Z" }, { acceptedAt: "2026-09-01T00:00:00.001Z" }, { dueDate: 1.5 }, { dueDate: 253402300800 }, { acceptedAt: 0 }, { evidenceHash: "0x123" }, { buyerAccepted: "true" }, { fuId: " FU-001" }, { obligorId: "" }, { surprise: true }])("reports invalid fields %#", (change) => {
    const result = validateFactoringUnitImport([{ ...unit, ...change }]);
    expect(result.records).toHaveLength(0);
    expect(result.issues[0]?.row).toBe(1);
  });

  it("reports every duplicate and never silently commits the nonduplicate subset", () => {
    const rows = [unit, { ...unit, faceValue: 101n }, demoFactoringUnits[1]!];
    const result = validateFactoringUnitImport(rows);
    expect(result.records).toHaveLength(1);
    expect(result.issues.map((issue) => issue.row)).toEqual([1, 2]);
    expect(() => buildPool(rows)).toThrow("Duplicate receivable ID");
  });

  it.each([null, {}, [], [null], [{ fuId: "FU-001" }], Array(10_001).fill(unit)])("rejects malformed imports %#", (input) => {
    expect(validateFactoringUnitImport(input).issues.length).toBeGreaterThan(0);
  });

  it("leaves structurally valid underwriting rejections visible", () => {
    const invalidTerm = { ...unit, dueDate: unit.acceptedAt };
    expect(validateFactoringUnitImport([invalidTerm]).issues).toEqual([]);
    const result = buildPool([invalidTerm]);
    expect(result.rejected[0]?.reasons).toEqual(["INVALID_DUE_DATE"]);
    expect(result.metrics).toEqual({ weightedDueDate: 0, weightedTenorSeconds: 0, largestObligorBasisPoints: 0, obligors: [] });
  });
});

describe("persistable commitments and metrics", () => {
  it("provides proofs for every accepted and rejected FU", () => {
    const result = buildPool(demoFactoringUnits);
    expect(result.schemaVersion).toBe(1);
    expect(result.ruleVersion).toBe("treds-pool-v1");
    expect(result.proofs).toHaveLength(12);
    for (const proof of result.proofs) {
      expect(proof.eligibilityProof.reduce(hashPair, proof.eligibilityLeaf)).toBe(result.eligibilityRoot);
      if (proof.poolLeaf) expect(proof.poolProof.reduce(hashPair, proof.poolLeaf)).toBe(result.poolRoot);
      else expect(proof.poolProof).toEqual([]);
    }
    expect(result.metrics.largestObligorBasisPoints).toBe(3_000);
    expect(result.metrics.weightedTenorSeconds).toBe(35.5 * 86_400);
    expect(result.metrics.weightedDueDate).toBe(unit.acceptedAt + 35.5 * 86_400);
  });

  it("batch proof builder matches established odd-leaf duplication algorithm", () => {
    const leaves = [id("a"), id("b"), id("c"), id("d"), id("e")] as `0x${string}`[];
    const proofs = merkleProofs(leaves);
    for (const leaf of leaves) expect(proofs.get(leaf)).toEqual(merkleProof(leaves, leaf));
  });
});

describe("v1 collection identity compatibility", () => {
  it("preserves deployed command hashes exactly and shares them with ledger", () => {
    const poolId = id("pool");
    const command = validateCollectionCommand(poolId, { fuId: "FU-001", amountMinorUnits: "100", settlementReference: "SETTLE-123", settledAt: "2026-01-01T00:00:00Z", expectedStateVersion: "0" });
    const coder = AbiCoder.defaultAbiCoder();
    const sourceEventId = keccak256(coder.encode(["bytes32", "bytes32", "bytes32"], [id(command.sourceSystem), poolId, id(command.settlementReference)]));
    const payloadHash = keccak256(coder.encode(["bytes32", "bytes32", "bytes32", "bytes32", "uint256", "bytes32"], [id("receivablex.collection.v1"), sourceEventId, poolId, id(command.fuId), command.amountMinorUnits, id(command.settledAt)]));
    expect(collectionCommandIdentity(command)).toEqual({ sourceEventId, payloadHash, requestHash: keccak256(coder.encode(["bytes32", "uint256"], [payloadHash, command.expectedStateVersion])) });
    const event = { ...command, amount: BigInt(command.amountMinorUnits) };
    expect(collectionEventIdentity(poolId, event)).toEqual({ sourceEventId, payloadHash });
    const ledger = new ServicingLedger(createDemoPoolAccounting(), poolId);
    expect(ledger.applyCollection(event)).toMatchObject({ sourceEventId, payloadHash, outcome: "RECORDED" });
    expect(ledger.applyCollection({ ...event, settledAt: "2026-01-01T00:00:00Z" }).outcome).toBe("ALREADY_PROCESSED");
    expect(collectionEventIdentity(id("other-pool"), event).sourceEventId).not.toBe(sourceEventId);
    expect(collectionCommandIdentity({ ...command, expectedStateVersion: "1" }).payloadHash).toBe(payloadHash);
  });
});
