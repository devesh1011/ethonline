import { id } from "ethers";
import { bytes32 } from "./input-schema";
export type LifecycleAction = "MATURE" | "CLOSE" | "RETIRE";
export interface LifecycleCommand { poolId: string; action: LifecycleAction; expectedStateVersion: string; amountUnits: string }
export interface RetirementTransaction { from: string; to: string; data: string; value: "0x0"; chainId: "0x128"; gas: string; nonce: string; nativeTransactionList?: string; nativeTransactionId?: string; nativeContractId?: string; nativeValidUntil?: string; holderAccountId?: string }
export interface LifecycleRequestView { operationId: string; action: LifecycleAction; state: string; transactionId: string | null; error: string | null; prepared: RetirementTransaction | null; amountUnits: string }
export function validateLifecycleCommand(poolId: string, input: unknown): LifecycleCommand {
  bytes32(poolId, "pool ID");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Lifecycle body must be an object");
  const body = input as Record<string, unknown>;
  if (Object.keys(body).some(k => !["action", "expectedStateVersion", "amountUnits"].includes(k))) throw new Error("Unknown lifecycle field");
  if (!["MATURE", "CLOSE", "RETIRE"].includes(String(body.action))) throw new Error("Invalid lifecycle action");
  if (typeof body.expectedStateVersion !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(body.expectedStateVersion)) throw new Error("Invalid state version");
  const amount = body.amountUnits ?? "0";
  if (typeof amount !== "string" || !/^(0|[1-9][0-9]{0,37})$/.test(amount) || (body.action === "RETIRE" ? amount === "0" : amount !== "0")) throw new Error("Retirement requires positive integer units; other actions do not accept units");
  return { poolId: poolId.toLowerCase(), action: body.action as LifecycleAction, amountUnits: amount, expectedStateVersion: body.expectedStateVersion };
}
export function lifecycleRequestHash(command: LifecycleCommand) { return id(JSON.stringify(["receivablex-lifecycle-v1", command.poolId, command.action, command.amountUnits, command.expectedStateVersion])); }
export interface LifecycleLedger { state: string; principal: bigint; cash: bigint; reservedCash: bigint; reservedPrincipal: bigint; performing: bigint; delinquent: bigint; defaulted: bigint; estimatedRecovery: bigint; pendingDistributions: bigint }
export function assertRetirementReady(pool: LifecycleLedger) {
  if (pool.state !== "MATURED") throw new Error("Pool must be matured before units are retired");
  if ([pool.principal, pool.cash, pool.reservedCash, pool.reservedPrincipal, pool.performing, pool.delinquent, pool.defaulted, pool.estimatedRecovery, pool.pendingDistributions].some(n => n !== 0n)) throw new Error("Resolve principal, cash, receivables and pending distributions before retiring units");
}
