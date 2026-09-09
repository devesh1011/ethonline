import { expect, test } from "vitest";
import { Interface, ZeroHash, parseUnits, type Wallet, type TransactionRequest } from "ethers";
import { BusinessLogicResolver__factory } from "@hashgraph/asset-tokenization-contracts";
import { ATS_ASSET_ABI, AtsAdapter } from "@receivablex/hedera-ats";
import { populateIssuanceTransaction } from "../../hedera-native/src/issuance.js";
import { populateBoundedTransaction, type IssuanceCreationFeePurpose } from "../../hedera-native/src/safety.js";

const issuer = `0x${"1".repeat(40)}`, factory = `0x${"2".repeat(40)}`, other = `0x${"3".repeat(40)}`;
const env = { HEDERA_ISSUANCE_CREATE_MAX_FEE_HBAR: "25" };
async function fixture() {
  const resolver = new Interface(BusinessLogicResolver__factory.abi);
  const adapter = new AtsAdapter({ getNetwork: async () => ({ chainId: 296n }), call: async () => resolver.encodeFunctionResult("getLatestVersionByConfiguration", [8]), getBlockNumber: async () => 1, getTransactionReceipt: async () => null }, { now: () => 100 });
  const prepared = await adapter.prepareCreateSecurity(issuer, { factory, resolver: other, configurationId: ZeroHash, admin: other, name: "Fee regression", symbol: "RX", isin: "INRXPOOL0011", maxSupply: 1000n, decimals: 0, currency: "0x494e52", nominalValue: 980000n, nominalValueDecimals: 2, startingDate: 200, maturityDate: 300, information: "Local fee policy test" });
  let estimated: TransactionRequest | undefined, populated: TransactionRequest | undefined;
  const wallet = { address: issuer, provider: { send: async () => "0x128", estimateGas: async (tx: TransactionRequest) => { estimated = tx; return 8_010_045n; } }, populateTransaction: async (tx: TransactionRequest) => { populated = tx; return { ...tx, nonce: 7, type: 2, maxFeePerGas: 2_380_000_000_000n, maxPriorityFeePerGas: 0n }; } } as unknown as Wallet;
  return { prepared, wallet, observations: () => ({ estimated, populated }) };
}
test("actual creation preparation uses explicit25 cap for22.87668852 quote, preserving data, nonce and20%buffer", async () => {
  const f = await fixture();
  await expect(populateIssuanceTransaction(f.prepared, { factory, issuerAddress: issuer }, f.wallet, {}, "CREATE_SECURITY")).rejects.toThrow("fee or gas limit");
  const result = await populateIssuanceTransaction(f.prepared, { factory, issuerAddress: issuer }, f.wallet, env, "CREATE_SECURITY");
  expect(f.prepared.operation).toBe("deployBond"); expect(f.prepared.transaction.gasLimit).toBe(15_000_000n);
  expect(result).toMatchObject({ gasLimit: 9_612_054n, nonce: 7, type: 2, data: f.prepared.transaction.data, maxFeePerGas: 2_380_000_000_000n, maxPriorityFeePerGas: 0n, value: 0n });
  expect(BigInt(result.gasLimit!) * BigInt(result.maxFeePerGas!)).toBe(parseUnits("22.87668852", 18));
  expect(f.observations().estimated?.data).toBe(f.prepared.transaction.data);
  expect(f.observations().estimated?.gasLimit).toBe(15_000_000n);
  await expect(populateIssuanceTransaction(f.prepared, { factory, issuerAddress: issuer }, f.wallet, { HEDERA_ISSUANCE_CREATE_MAX_FEE_HBAR: "22.87668851" }, "CREATE_SECURITY")).rejects.toThrow("fee or gas limit");
  await expect(populateIssuanceTransaction(f.prepared, { factory, issuerAddress: issuer }, f.wallet, { HEDERA_ISSUANCE_CREATE_MAX_FEE_HBAR: "25.00000001" }, "CREATE_SECURITY")).rejects.toThrow("at most 25");
});
test("KYC, issue and other workflows cannot inherit the creation budget", async () => {
  const f = await fixture(), asset = new Interface(ATS_ASSET_ABI);
  for (const operation of ["grantKyc", "issueByPartition", "registerIssuer", "CREATE_SECURITY"]) await expect(populateIssuanceTransaction({ ...f.prepared, operation }, { factory, issuerAddress: issuer }, f.wallet, env, "GRANT_KYC")).rejects.toThrow("fee or gas limit");
  await expect(populateIssuanceTransaction(f.prepared, { factory, issuerAddress: issuer }, f.wallet, env, "GRANT_KYC")).rejects.toThrow("persisted issuance stage");
  await expect(populateIssuanceTransaction(f.prepared, { factory, issuerAddress: issuer }, f.wallet, env)).rejects.toThrow("persisted issuance stage");
  await expect(populateIssuanceTransaction({ ...f.prepared, operation: "grantKyc" }, { factory, issuerAddress: issuer }, f.wallet, env, "CREATE_SECURITY")).rejects.toThrow("persisted issuance stage");
  await expect(populateBoundedTransaction(f.wallet, f.prepared.transaction, undefined, env)).rejects.toThrow("fee or gas limit");
  const wrongCall = { ...f.prepared, transaction: { ...f.prepared.transaction, data: asset.encodeFunctionData("revokeKyc", [other]) } };
  await expect(populateIssuanceTransaction(wrongCall, { factory, issuerAddress: issuer }, f.wallet, env, "CREATE_SECURITY")).rejects.toThrow("exact ATS deployBond");
  const purpose: IssuanceCreationFeePurpose = { purpose: "ISSUANCE_CREATE_SECURITY", factory, issuer };
  await expect(populateBoundedTransaction(f.wallet, f.prepared.transaction, { ...purpose, purpose: "KYC" } as unknown as IssuanceCreationFeePurpose, env)).rejects.toThrow("exact ATS deployBond");
});
test("creation exception remains bound to factory, issuer, full ABI calldata, zero value and chain296", async () => {
  const f = await fixture();
  for (const transaction of [{ ...f.prepared.transaction, to: other }, { ...f.prepared.transaction, from: other }, { ...f.prepared.transaction, data: f.prepared.transaction.data.slice(0, 10) }, { ...f.prepared.transaction, value: 1n }]) await expect(populateIssuanceTransaction({ ...f.prepared, transaction }, { factory, issuerAddress: issuer }, f.wallet, env, "CREATE_SECURITY")).rejects.toThrow("exact ATS deployBond");
  await expect(populateIssuanceTransaction({ ...f.prepared, transaction: { ...f.prepared.transaction, chainId: 295n } }, { factory, issuerAddress: issuer }, f.wallet, env, "CREATE_SECURITY")).rejects.toThrow("testnet chain identity");
  await expect(populateIssuanceTransaction(f.prepared, { factory, issuerAddress: issuer }, f.wallet, { ...env, HEDERA_MAX_EVM_TX_FEE_HBAR: "25" }, "CREATE_SECURITY")).rejects.toThrow("at most 10");
});
