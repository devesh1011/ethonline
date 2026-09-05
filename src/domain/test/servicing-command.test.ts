import { describe, expect, it } from "vitest";
import { id } from "ethers";
import { createDemoPoolAccounting, ServicingLedger, servicingCommandIdentity, servicingRole, validateServicingCommand, validateServicingTransition, type ServicingAction } from "../src/index";
const poolId = id("servicing-test");
const command = (action: ServicingAction, estimate = "0", reference = action) => validateServicingCommand(poolId, { fuId: "FU-001", action, reference, reason: "Trustee reviewed the buyer status", estimatedRecoveryMinorUnits: estimate, expectedStateVersion: "0" });

describe("canonical servicing commands", () => {
  it("binds action, reason and amount but keeps source identity stable for conflict checks", () => {
    const first = servicingCommandIdentity(command("DEFAULT", "400"));
    const revised = servicingCommandIdentity(command("DEFAULT", "401"));
    expect(first.sourceEventId).toBe(revised.sourceEventId);
    expect(first.payloadHash).not.toBe(revised.payloadHash);
    expect(servicingRole("DEFAULT")).toBe("trustee");
    expect(servicingRole("CURE")).toBe("trustee");
    expect(servicingRole("DELINQUENT")).toBe("servicer");
  });
  it.each(["-1", "1.5", "01", 100, "1e3"])("rejects noncanonical estimate %s", value => {
    const { poolId: _pool, ...body } = command("DEFAULT");
    expect(() => validateServicingCommand(poolId, { ...body, estimatedRecoveryMinorUnits: value })).toThrow();
  });
  it("rejects early delinquency, illegal transitions and estimates beyond outstanding", () => {
    expect(() => validateServicingTransition(command("DELINQUENT"), { status: "PERFORMING", outstanding: 100n, dueDate: 100 }, 100)).toThrow("not overdue");
    expect(() => validateServicingTransition(command("DEFAULT"), { status: "PERFORMING", outstanding: 100n, dueDate: 100 }, 101)).toThrow("delinquent");
    expect(() => validateServicingTransition(command("REVISE_RECOVERY", "101"), { status: "DEFAULTED", outstanding: 100n, dueDate: 100 }, 101)).toThrow("exceeds");
  });
  it("keeps buckets balanced through partial receipts, default, revision, cure and replay", () => {
    const initial = createDemoPoolAccounting();
    const ledger = new ServicingLedger(initial, poolId, { "FU-001": { status: "PERFORMING", dueDate: 100, estimate: 0n } });
    const late = command("DELINQUENT");
    ledger.applyServicing(late, 101);
    let state = ledger.applyServicing(command("DEFAULT", "400"), 101).state;
    expect(state.defaultedFaceOutstanding).toBe(initial.fuOutstanding["FU-001"]);
    state = ledger.applyServicing(command("REVISE_RECOVERY", "600"), 101).state;
    expect(state.estimatedDefaultRecoveries).toBe(600n);
    expect(() => ledger.applyServicing(command("REVISE_RECOVERY", "601"), 101)).toThrow("Conflicting");
    state = ledger.applyCollection({ sourceSystem: "servicing-test", settlementReference: "RECOVERY-1", fuId: "FU-001", amount: 700n, settledAt: "2026-01-01T00:00:00Z" }).state;
    expect(state.estimatedDefaultRecoveries).toBe(0n);
    expect(state.availableCash).toBe(700n);
    state = ledger.applyServicing(command("CURE"), 101).state;
    expect(state.defaultedFaceOutstanding).toBe(0n);
    expect(state.performingFaceOutstanding).toBe(initial.performingFaceOutstanding - 700n);
    expect(state.realizedLosses).toBe(0n);
    expect(state.investorPrincipalOutstanding).toBe(initial.investorPrincipalOutstanding);
    expect(ledger.applyServicing(command("CURE"), 101).outcome).toBe("ALREADY_PROCESSED");
  });
});
