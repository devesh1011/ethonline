import { expect, test } from "vitest";
import { id } from "ethers";
import { assertRetirementReady, lifecycleRequestHash, validateLifecycleCommand, type LifecycleLedger } from "../src/index";
const resolved: LifecycleLedger = { state: "MATURED", principal: 0n, cash: 0n, reservedCash: 0n, reservedPrincipal: 0n, performing: 0n, delinquent: 0n, defaulted: 0n, estimatedRecovery: 0n, pendingDistributions: 0n };
test("retirement requires every obligation resolved and actual matured state", () => {
  expect(() => assertRetirementReady(resolved)).not.toThrow();
  for (const field of ["principal", "cash", "reservedCash", "reservedPrincipal", "performing", "delinquent", "defaulted", "estimatedRecovery", "pendingDistributions"]) expect(() => assertRetirementReady({ ...resolved, [field]: 1n })).toThrow("Resolve");
  expect(() => assertRetirementReady({ ...resolved, state: "ACTIVE" })).toThrow("matured");
});
test("canonical lifecycle identity binds units, action and state version", () => {
  const body = { action: "RETIRE", amountUnits: "50", expectedStateVersion: "0" };
  const command = validateLifecycleCommand(id("pool"), body);
  expect(lifecycleRequestHash(command)).not.toBe(lifecycleRequestHash({ ...command, amountUnits: "51" }));
  for (const amountUnits of ["0", "-1", "01", "1.5", 1]) expect(() => validateLifecycleCommand(command.poolId, { ...body, amountUnits })).toThrow();
  expect(() => validateLifecycleCommand(command.poolId, { ...body, action: "CLOSE" })).toThrow();
});
