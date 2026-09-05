import { describe, expect, it } from "vitest";
import { CollectionConflictError, ServicingLedger, createDemoPoolAccounting } from "../src/index.js";

describe("ServicingLedger", () => {
  it("applies a collection once and ignores an exact retry", () => {
    const ledger = new ServicingLedger(createDemoPoolAccounting());
    const event = {
      sourceSystem: "mock-treds",
      settlementReference: "SETTLE-001",
      fuId: "FU-001",
      amount: 1_000_000_00n,
      settledAt: "2026-09-11T10:00:00.000Z",
    } as const;

    const first = ledger.applyCollection(event);
    const replay = ledger.applyCollection(event);

    expect(first.outcome).toBe("RECORDED");
    expect(first.state.performingFaceOutstanding).toBe(9_000_000_00n);
    expect(first.state.availableCash).toBe(1_000_000_00n);
    expect(replay.outcome).toBe("ALREADY_PROCESSED");
    expect(replay.state).toEqual(first.state);
  });

  it("rejects a changed payload with the same source reference", () => {
    const ledger = new ServicingLedger(createDemoPoolAccounting());
    const base = {
      sourceSystem: "mock-treds",
      settlementReference: "SETTLE-001",
      fuId: "FU-001",
      amount: 1_000_000_00n,
      settledAt: "2026-09-11T10:00:00.000Z",
    } as const;

    ledger.applyCollection(base);

    expect(() => ledger.applyCollection({ ...base, amount: 900_000_00n })).toThrow(CollectionConflictError);
  });
});
