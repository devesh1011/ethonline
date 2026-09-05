import { expect, test } from "vitest";
import { id } from "ethers";
import { assertCancellationStepsSafe, exceptionIdentity, principalWriteDownCapacity, validateExceptionCommand } from "../src/index";
test("principal capacity is capped by both unreserved principal and unused realized loss", () => {
  expect(principalWriteDownCapacity(100n, 20n, 90n, 30n)).toBe(60n);
  expect(principalWriteDownCapacity(50n, 20n, 90n, 30n)).toBe(30n);
  expect(() => principalWriteDownCapacity(10n, 20n, 90n, 30n)).toThrow();
});
test("exception identity binds decision text, units and immutable preview", () => {
  const command = validateExceptionCommand(id("pool"), { action: "WRITE_DOWN_PRINCIPAL", amountMinorUnits: "40", reason: "Trustee approved the audited loss allocation", reference: "LOSS-001", expectedStateVersion: "0" });
  expect(exceptionIdentity(command).sourceEventId).toBe(exceptionIdentity({ ...command, amountMinorUnits: "41" }).sourceEventId);
  expect(exceptionIdentity(command).payloadHash).not.toBe(exceptionIdentity({ ...command, amountMinorUnits: "41" }).payloadHash);
  const { poolId, ...body } = command;
  for (const amountMinorUnits of ["0", "-1", "01", "1.5", 4]) expect(() => validateExceptionCommand(poolId, { ...body, amountMinorUnits })).toThrow("positive exact");
});
test("cancellation rejects unknown signed payouts, all successful attempts, and unresolved approval", () => {
  const approval = { kind: "APPROVE", state: "SUCCESS", receipt: { status: 1 } };
  expect(() => assertCancellationStepsSafe([approval, { kind: "PAYOUT", state: "PLANNED" }])).not.toThrow();
  expect(() => assertCancellationStepsSafe([approval, { kind: "PAYOUT", state: "FAILED", transaction_id: "hash", receipt: { status: 0 } }])).not.toThrow();
  for (const step of [{ kind: "PAYOUT", state: "UNKNOWN", transaction_id: "hash" }, { kind: "PAYOUT", state: "SIGNED", transaction_id: "hash" }, { kind: "PAYOUT", state: "FAILED", transaction_id: "hash", receipt: { status: 1 } }, { kind: "PAYOUT", state: "SUCCESS" }]) expect(() => assertCancellationStepsSafe([approval, step])).toThrow();
  expect(() => assertCancellationStepsSafe([{ kind: "APPROVE", state: "UNKNOWN" }])).toThrow("approval");
});
