import { createHash } from "node:crypto";
import { id } from "ethers";
import { validRunId, type SetupPlan, type SetupStep } from "./setup-checkpoints.js";
export const SETUP_ROLES = ["admin", "issuer", "compliance", "custody", "escrow", "manager", "trustee", "snapshot", "payout", "servicer", "treasury", "originator"] as const;
export const FILE_CHUNK_BYTES = 2000;
/** HFS stores hex-ASCII here, matching SDK ContractCreateFlow's string path.
 * Each hex character is one UTF-8 byte; it is not a raw bytecode slice. */
export function registryFileChunks(bytecode: string): Uint8Array[] {
  const contents = Buffer.from(bytecode.slice(2), "utf8");
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < contents.length; offset += FILE_CHUNK_BYTES) chunks.push(contents.subarray(offset, offset + FILE_CHUNK_BYTES));
  return chunks;
}
export interface SetupOptions { runId: string; operatorAccountId?: string; maxHbar?: number; testInvestors?: boolean; walletInvestors?: string[]; credentialMode?: "SIGNED_SANDBOX" | "REGISTRY"; vcDidRegistry?: string; vcRevocationRegistry?: string; atsFactoryId?: string; atsResolverId?: string; atsConfigurationId?: string; assignmentDocumentHash?: string }
export function setupPlan(options: SetupOptions, registryBytecode: string): SetupPlan {
  const runId = validRunId(options.runId);
  if (options.operatorAccountId && !/^0\.0\.[1-9]\d*$/.test(options.operatorAccountId)) throw new Error("Operator account must be a numeric Hedera ID");
  if (options.assignmentDocumentHash && !/^0x[0-9a-fA-F]{64}$/.test(options.assignmentDocumentHash)) throw new Error("Assignment document hash must be bytes32");
  if (!/^0x[0-9a-fA-F]+$/.test(registryBytecode) || registryBytecode.length % 2 !== 0) throw new Error("Compiled Registry bytecode is required");
  const maxHbar = options.maxHbar ?? 250; if (!Number.isSafeInteger(maxHbar) || maxHbar < 1 || maxHbar > 1000) throw new Error("HBAR budget must be an integer from 1 to 1000");
  const roles = [...SETUP_ROLES, ...(options.testInvestors ? ["test-investor-a", "test-investor-b", "test-investor-probe", "ineligible"] : [])];
  const funded: Record<string, number> = { issuer: 15, manager: 10, admin: 10, compliance: 5, trustee: 5 };
  const steps: SetupStep[] = roles.map(role => ({ id: `account-${role}`, kind: "ACCOUNT", role, initialHbar: funded[role] ?? 3, maxFeeHbar: 2 }));
  steps.push({ id: "token-create", kind: "TOKEN", maxFeeHbar: 20 });
  steps.push({ id: "registry-file-create", kind: "FILE_CREATE", chunk: 0, maxFeeHbar: 2 });
  for (let chunk = 1; chunk < registryFileChunks(registryBytecode).length; chunk++) steps.push({ id: `registry-file-append-${String(chunk).padStart(3, "0")}`, kind: "FILE_APPEND", chunk, maxFeeHbar: 2 });
  steps.push({ id: "registry-create", kind: "REGISTRY", maxFeeHbar: 20 });
  for (const [role, roleName] of [["manager", "pool-manager"], ["servicer", "servicer"], ["trustee", "trustee"], ["payout", "payout-executor"]]) steps.push({ id: `registry-role-${role}`, kind: "ROLE", role: role!, roleHash: id(`receivablex.role.${roleName}`), maxFeeHbar: 2 });
  for (const role of ["escrow", "originator", ...(options.testInvestors ? ["test-investor-a", "test-investor-b", "ineligible"] : [])]) steps.push({ id: `associate-${role}`, kind: "ASSOCIATE", role, maxFeeHbar: 2 });
  if (options.testInvestors) for (const role of ["test-investor-a", "test-investor-b"]) steps.push({ id: `faucet-${role}`, kind: "FAUCET", role, amount: "1000000000", maxFeeHbar: 2 });
  const credentialMode = options.credentialMode ?? "SIGNED_SANDBOX";
  if (!["SIGNED_SANDBOX", "REGISTRY"].includes(credentialMode)) throw new Error("Invalid credential mode");
  if (credentialMode === "REGISTRY" && (![options.vcDidRegistry, options.vcRevocationRegistry].every(value => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value)))) throw new Error("REGISTRY mode requires explicit verified registry addresses");
  const walletInvestors = options.walletInvestors ?? [];
  if (walletInvestors.some(account => !/^0\.0\.[1-9]\d*$/.test(account)) || new Set(walletInvestors).size !== walletInvestors.length) throw new Error("Wallet investor IDs must be distinct numeric Hedera accounts");
  return { version: 1, runId, schema: `rx_${runId.replaceAll("-", "_")}`, operatorAccountId: options.operatorAccountId ?? "", maxHbar, credentialMode, ...(credentialMode === "REGISTRY" ? { vcDidRegistry: options.vcDidRegistry!, vcRevocationRegistry: options.vcRevocationRegistry! } : {}), ...(options.assignmentDocumentHash ? { assignmentDocumentHash: options.assignmentDocumentHash } : {}), walletInvestors, registryBytecode, registryBytecodeHash: createHash("sha256").update(registryBytecode).digest("hex"), steps, roles, atsFactoryId: options.atsFactoryId ?? "0.0.9213391", atsResolverId: options.atsResolverId ?? "0.0.9212226", atsConfigurationId: options.atsConfigurationId ?? `0x${"0".repeat(63)}2` };
}
export function summarizePlan(plan: SetupPlan) {
  return { mode: "PLAN", runId: plan.runId, schema: plan.schema, network: "testnet", roles: plan.roles, steps: plan.steps, maxHbar: plan.maxHbar, conservativeHbarUpperBound: plan.steps.reduce((total, step) => total + step.maxFeeHbar + (step.initialHbar ?? 0), 0), credentialPolicy: plan.credentialMode === "SIGNED_SANDBOX" ? "Signed non-revocable sandbox attestations; any credentialStatus claim is rejected. Actual signatures, holder/issuer/date bindings and ATS revokeKyc remain enforced. Not institutional KYC." : "Actual registered credential revocation; public registry code and revocation lookup must verify.", generatedInvestorKeys: plan.roles.includes("test-investor-a"), walletAcceptance: "Not performed: investors must approve their own application subscription payments", artifacts: { registryBytecodeHash: plan.registryBytecodeHash, registryBytes: (plan.registryBytecode.length - 2) / 2 }, historicalEvidence: "Preserved; no historical bootstrap or legacy actor keys imported" };
}
