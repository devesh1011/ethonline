import { readFile } from "node:fs/promises";
import { getAddress, ZeroAddress } from "ethers";
import { PrivateKey, PublicKey } from "@hiero-ledger/sdk";
import { buildPool, bytes32, demoFactoringUnits, parseFactoringUnitImport, type FactoringUnit } from "@receivablex/domain";

export interface RuntimePoolContext {
  version: 1;
  poolId: string;
  name: string;
  registryAddress: string;
  registryId: string;
  securityAddress: string;
  securityId: string;
  payoutAddress: string;
  payoutId: string;
  paymentTokenId: string;
  paymentTokenAddress: string;
  records: FactoringUnit[];
}

export const historicalEvidence = JSON.parse(await readFile(new URL("../../../docs/evidence/testnet-evidence.json", import.meta.url), "utf8"));
const entityId = (input: unknown) => {
  if (typeof input !== "string" || !/^0\.0\.[1-9][0-9]*$/.test(input)) throw new Error("Runtime manifest requires resolved numeric Hedera entity IDs");
  return input;
};
const address = (input: unknown) => {
  if (typeof input !== "string") throw new Error("Runtime manifest address is missing");
  const result = getAddress(input);
  if (result === ZeroAddress) throw new Error("Runtime manifest address cannot be zero");
  return result;
};

/** Metadata is a verified binding, never a substitute for the committed records. */
export function parseRuntimeContext(input: unknown, expected?: { poolId: string; poolRoot: string; eligibilityRoot: string; manifestHash: string }): RuntimePoolContext {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Pool runtime manifest is unavailable");
  const value = input as Record<string, unknown>;
  if (value.version !== 1 || typeof value.name !== "string" || !value.name.trim() || value.name.length > 160) throw new Error("Invalid runtime manifest version or name");
  const result: RuntimePoolContext = {
    version: 1, poolId: bytes32(value.poolId, "poolId"), name: value.name.trim(),
    registryAddress: address(value.registryAddress), registryId: entityId(value.registryId),
    securityAddress: address(value.securityAddress), securityId: entityId(value.securityId),
    payoutAddress: address(value.payoutAddress), payoutId: entityId(value.payoutId),
    paymentTokenId: entityId(value.paymentTokenId), paymentTokenAddress: address(value.paymentTokenAddress),
    records: parseFactoringUnitImport(value.records),
  };
  const tokenAddress = getAddress(`0x${BigInt(result.paymentTokenId.split(".")[2]!).toString(16).padStart(40, "0")}`);
  if (tokenAddress !== result.paymentTokenAddress) throw new Error("Payment token ID/address mismatch");
  const built = buildPool(result.records);
  if (expected && (result.poolId !== expected.poolId.toLowerCase() || built.poolRoot !== expected.poolRoot.toLowerCase() || built.eligibilityRoot !== expected.eligibilityRoot.toLowerCase() || built.manifestHash !== expected.manifestHash.toLowerCase())) throw new Error("Runtime manifest does not match reviewed pool commitments");
  return result;
}

export const legacyRuntimeContext = parseRuntimeContext({
  version: 1, poolId: historicalEvidence.pool.poolId, name: "TReDS CPSE Sep-26",
  registryAddress: historicalEvidence.registry.address, registryId: historicalEvidence.registry.contractId,
  securityAddress: historicalEvidence.ats.securityAddress, securityId: historicalEvidence.ats.securityId,
  payoutAddress: historicalEvidence.payoutAdapter.address, payoutId: historicalEvidence.payoutAdapter.contractId,
  paymentTokenId: historicalEvidence.inrx.tokenId, paymentTokenAddress: historicalEvidence.inrx.tokenAddress,
  records: demoFactoringUnits,
});

export function serializeRuntimeContext(context: RuntimePoolContext) {
  return JSON.parse(JSON.stringify(context, (_key, value) => typeof value === "bigint" ? String(value) : value));
}

export async function verifyRuntimeEntityIds(context: RuntimePoolContext, query: (path: string) => Promise<any>) {
  await Promise.all([[context.registryId, context.registryAddress], [context.securityId, context.securityAddress], [context.payoutId, context.payoutAddress]].map(async ([entity, expected]) => {
    const record = await query(`contracts/${entity}`);
    if (record?.deleted || record?.contract_id !== entity || record?.evm_address?.toLowerCase() !== expected!.toLowerCase()) throw new Error("Runtime contract ID does not match its verified EVM address");
  }));
}

export function verifyNativeSignerAccount(account: unknown, accountId: string, privateKey: PrivateKey) {
  const record = account as { account?: string; deleted?: boolean; key?: { _type?: string; key?: string } } | null;
  try {
    if (!record || record.account !== accountId || record.deleted || record.key?._type !== "ECDSA_SECP256K1" || !record.key.key || PublicKey.fromStringECDSA(record.key.key).toStringRaw().toLowerCase() !== privateKey.publicKey.toStringRaw().toLowerCase()) throw new Error("mismatch");
  } catch { throw new Error("Configured signer does not match the current Hedera account key"); }
}

export function contextBindings(context: RuntimePoolContext) {
  return {
    pool: { poolId: context.poolId }, registry: { address: context.registryAddress, contractId: context.registryId },
    ats: { securityAddress: context.securityAddress, securityId: context.securityId },
    payoutAdapter: { address: context.payoutAddress, contractId: context.payoutId },
    inrx: { tokenId: context.paymentTokenId, tokenAddress: context.paymentTokenAddress },
  };
}
