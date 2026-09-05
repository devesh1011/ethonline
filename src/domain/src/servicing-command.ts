import { AbiCoder, id, keccak256 } from "ethers";
import { bytes32, factoringUnitId } from "./input-schema";

export type ServicingAction = "DELINQUENT" | "DEFAULT" | "CURE" | "REVISE_RECOVERY";
export interface ServicingCommand {
  poolId: string; fuId: string; action: ServicingAction; reference: string;
  reason: string; estimatedRecoveryMinorUnits: string; expectedStateVersion: string;
}
export function validateServicingCommand(poolId: string, input: unknown): ServicingCommand {
  bytes32(poolId, "pool ID");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Servicing body must be an object");
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some(key => !["fuId", "action", "reference", "reason", "estimatedRecoveryMinorUnits", "expectedStateVersion"].includes(key))) throw new Error("Unknown servicing field");
  factoringUnitId(body.fuId);
  if (!["DELINQUENT", "DEFAULT", "CURE", "REVISE_RECOVERY"].includes(String(body.action))) throw new Error("Invalid servicing action");
  if (typeof body.reference !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,99}$/.test(body.reference)) throw new Error("Invalid servicing reference");
  if (typeof body.reason !== "string" || body.reason.trim().length < 10 || body.reason.length > 1000) throw new Error("Provide a reason of 10 to 1000 characters");
  if (typeof body.expectedStateVersion !== "string" || !/^(0|[1-9][0-9]{0,17})$/.test(body.expectedStateVersion)) throw new Error("Expected state version must be an integer string");
  const estimate = body.estimatedRecoveryMinorUnits ?? "0";
  if (typeof estimate !== "string" || !/^(0|[1-9][0-9]{0,17})$/.test(estimate)) throw new Error("Recovery must be a nonnegative integer string in minor units");
  if (["DELINQUENT", "CURE"].includes(String(body.action)) && estimate !== "0") throw new Error("This action does not accept a recovery estimate");
  return { poolId: poolId.toLowerCase(), fuId: body.fuId as string, action: body.action as ServicingAction, reference: body.reference, reason: body.reason.trim(), estimatedRecoveryMinorUnits: estimate, expectedStateVersion: body.expectedStateVersion };
}
export function servicingCommandIdentity(command: ServicingCommand) {
  const coder = AbiCoder.defaultAbiCoder();
  const sourceEventId = keccak256(coder.encode(["bytes32", "bytes32", "bytes32"], [id("receivablex-servicing-v2"), command.poolId, id(command.reference)]));
  const payloadHash = keccak256(coder.encode(["bytes32", "bytes32", "bytes32", "bytes32", "uint256", "bytes32"], [sourceEventId, command.poolId, id(command.fuId), id(command.action), command.estimatedRecoveryMinorUnits, id(command.reason)]));
  return { sourceEventId, payloadHash, requestHash: keccak256(coder.encode(["bytes32", "uint256"], [payloadHash, command.expectedStateVersion])) };
}
export function servicingRole(action: ServicingAction) { return action === "DELINQUENT" ? "servicer" : "trustee"; }
/** Due dates are committed Unix seconds. Business-clock acceleration requires a new manifest. */
export function validateServicingTransition(command: ServicingCommand, receivable: { status: string; outstanding: bigint; dueDate: number }, chainTimestamp: number) {
  if (receivable.outstanding <= 0n) throw new Error("Receivable has no outstanding balance");
  if (command.action === "DELINQUENT") {
    if (receivable.status !== "PERFORMING") throw new Error("Only performing receivables can become delinquent");
    if (chainTimestamp <= receivable.dueDate) throw new Error("Receivable is not overdue at the confirmed chain time");
  } else if (command.action === "DEFAULT" && receivable.status !== "DELINQUENT") throw new Error("Default requires a delinquent receivable");
  else if (command.action === "REVISE_RECOVERY" && receivable.status !== "DEFAULTED") throw new Error("Recovery revision requires a defaulted receivable");
  else if (command.action === "CURE" && !["DELINQUENT", "DEFAULTED"].includes(receivable.status)) throw new Error("Cure requires a delinquent or defaulted receivable");
  if (BigInt(command.estimatedRecoveryMinorUnits) > receivable.outstanding) throw new Error("Recovery estimate exceeds outstanding face value");
}
