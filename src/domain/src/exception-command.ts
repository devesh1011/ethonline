import { AbiCoder, ZeroHash, id, keccak256 } from "ethers";
import { bytes32, factoringUnitId } from "./input-schema";
export type ExceptionAction = "WRITE_OFF" | "WRITE_DOWN_PRINCIPAL" | "CANCEL_DISTRIBUTION";
export interface ExceptionCommand { poolId: string; action: ExceptionAction; fuId: string | null; distributionId: string | null; amountMinorUnits: string; reference: string; reason: string; expectedStateVersion: string; previewHash: string | null }
export function validateExceptionCommand(poolId: string, input: unknown): ExceptionCommand {
  bytes32(poolId, "pool ID");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Exception body must be an object");
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some(key => !["action", "fuId", "distributionId", "amountMinorUnits", "reference", "reason", "expectedStateVersion", "previewHash"].includes(key))) throw new Error("Unknown exception field");
  if (!["WRITE_OFF", "WRITE_DOWN_PRINCIPAL", "CANCEL_DISTRIBUTION"].includes(String(body.action))) throw new Error("Invalid exception action");
  const fuId = body.fuId ?? null, distributionId = body.distributionId ?? null, previewHash = body.previewHash ?? null;
  if (body.action === "WRITE_OFF") factoringUnitId(fuId); else if (fuId !== null) throw new Error("This exception does not identify a receivable");
  if (body.action === "CANCEL_DISTRIBUTION") { bytes32(distributionId, "distribution ID"); bytes32(previewHash, "preview hash"); }
  else if (distributionId !== null || previewHash !== null) throw new Error("This exception does not identify a distribution");
  const amount = body.amountMinorUnits ?? "0";
  if (typeof amount !== "string" || !/^(0|[1-9][0-9]{0,37})$/.test(amount) || (body.action === "WRITE_DOWN_PRINCIPAL" ? amount === "0" : amount !== "0")) throw new Error("Only principal write-down accepts a positive exact minor-unit amount");
  if (typeof body.reference !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,99}$/.test(body.reference)) throw new Error("A unique exception reference is required");
  if (typeof body.reason !== "string" || body.reason.trim().length < 20 || body.reason.length > 1000) throw new Error("An explicit trustee decision of 20 to 1000 characters is required");
  if (typeof body.expectedStateVersion !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(body.expectedStateVersion)) throw new Error("Invalid expected state version");
  return { poolId: poolId.toLowerCase(), action: body.action as ExceptionAction, fuId: fuId as string | null, distributionId: distributionId as string | null, previewHash: previewHash as string | null, amountMinorUnits: amount, reference: body.reference, reason: body.reason.trim(), expectedStateVersion: body.expectedStateVersion };
}
export function exceptionIdentity(command: ExceptionCommand) {
  const coder = AbiCoder.defaultAbiCoder();
  const sourceEventId = keccak256(coder.encode(["bytes32", "bytes32", "bytes32"], [id("receivablex-exception-v1"), command.poolId, id(command.reference)]));
  const decisionHash = id(command.reason);
  const payloadHash = keccak256(coder.encode(["bytes32", "bytes32", "bytes32", "bytes32", "bytes32", "uint256", "bytes32", "bytes32"], [sourceEventId, command.poolId, id(command.action), command.fuId ? id(command.fuId) : ZeroHash, command.distributionId ?? ZeroHash, command.amountMinorUnits, decisionHash, command.previewHash ?? ZeroHash]));
  return { sourceEventId, payloadHash, decisionHash, requestHash: keccak256(coder.encode(["bytes32", "uint256", "bytes32"], [payloadHash, command.expectedStateVersion, command.previewHash ?? ZeroHash])) };
}
export function principalWriteDownCapacity(principal: bigint, reservedPrincipal: bigint, realizedLosses: bigint, alreadyWrittenDown: bigint) {
  if ([principal, reservedPrincipal, realizedLosses, alreadyWrittenDown].some(value => value < 0n) || reservedPrincipal > principal || alreadyWrittenDown > realizedLosses) throw new Error("Invalid principal or realized loss ledger");
  const unreserved = principal - reservedPrincipal, unusedLoss = realizedLosses - alreadyWrittenDown;
  return unreserved < unusedLoss ? unreserved : unusedLoss;
}
export function assertCancellationStepsSafe(steps: readonly { kind: string; state: string; transaction_id?: string | null; receipt?: { status?: number } | null }[]) {
  const approval = steps.find(step => step.kind === "APPROVE");
  if (!approval || approval.state !== "SUCCESS" || approval.receipt?.status !== 1) throw new Error("Original approval must be conclusively verified before cancellation");
  for (const step of steps.filter(entry => entry.kind === "PAYOUT")) {
    if (step.state === "SUCCESS" || step.receipt?.status === 1) throw new Error("A successful or unverified successful payout prevents cancellation");
    if (step.transaction_id && !(step.state === "FAILED" && step.receipt?.status === 0)) throw new Error("Unknown signed payouts must reconcile before cancellation");
  }
}
