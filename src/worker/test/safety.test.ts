import { mkdtemp, writeFile, chmod, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonRpcProvider, parseUnits, type Wallet, type TransactionRequest } from "ethers";
import { expect, test } from "vitest";
import { safePrivateKey, safeEvmWallet, assertSignerAccount, assertBoundedEvmFees, populateBoundedTransaction, evmFeeCap, issuanceCreateFeeCap, loadSignerSecretFiles, runtimeTiming } from "../../hedera-native/src/safety.js";

const testKey = "0".repeat(63) + "1";
test("key parsing never returns the supplied secret in an exception", () => {
  const invalid = "not-a-key-" + "z".repeat(80);
  try { safePrivateKey(invalid); throw new Error("Expected rejection"); } catch (error) { expect((error as Error).message).not.toContain(invalid); }
});
test("current Mirror public key, active account and alias must all match", async () => {
  const provider = new JsonRpcProvider();
  try {
    const wallet = safeEvmWallet(testKey, provider), key = safePrivateKey(testKey);
    const account = { account: "0.0.123", evm_address: wallet.address, key: { _type: "ECDSA_SECP256K1", key: key.publicKey.toStringRaw() }, deleted: false };
    const fetcher = (value: unknown) => (async () => new Response(JSON.stringify(value))) as typeof fetch;
    await expect(assertSignerAccount("0.0.123", wallet, fetcher(account))).resolves.toBeUndefined();
    await expect(assertSignerAccount("0.0.123", wallet, fetcher({ ...account, key: { ...account.key, key: safePrivateKey("0".repeat(63) + "2").publicKey.toStringRaw() } }))).rejects.toThrow("current Hedera account key");
    await expect(assertSignerAccount("0.0.123", wallet, fetcher({ ...account, deleted: true }))).rejects.toThrow();
  } finally { provider.destroy(); }
});
test("fees are bounded before signing and unsafe environment values fail closed", () => {
  const transaction = { chainId: 296n, gasLimit: 1_000_000n, gasPrice: 1_000_000_000n, value: 0n };
  expect(() => assertBoundedEvmFees(transaction)).not.toThrow();
  expect(() => assertBoundedEvmFees({ ...transaction, gasPrice: parseUnits("1", 18) })).toThrow("fee");
  expect(() => assertBoundedEvmFees({ ...transaction, chainId: 295n })).toThrow();
  expect(() => evmFeeCap({ HEDERA_MAX_EVM_TX_FEE_HBAR: "100" })).toThrow();
  expect(() => runtimeTiming({ WORKER_POLL_MS: "NaN" })).toThrow();
  expect(() => runtimeTiming({ DISTRIBUTION_COMMANDS_ENABLED: "TRUE" })).toThrow();
});
test("creation fee configuration is separate, default5 and bounded25 without relaxing standard5/max10", () => {
  expect(issuanceCreateFeeCap({})).toBe(parseUnits("5", 18)); expect(evmFeeCap({})).toBe(parseUnits("5", 18));
  expect(issuanceCreateFeeCap({ HEDERA_ISSUANCE_CREATE_MAX_FEE_HBAR: "25" })).toBe(parseUnits("25", 18));
  expect(evmFeeCap({ HEDERA_ISSUANCE_CREATE_MAX_FEE_HBAR: "25" })).toBe(parseUnits("5", 18));
  expect(evmFeeCap({ HEDERA_MAX_EVM_TX_FEE_HBAR: "10" })).toBe(parseUnits("10", 18));
  for (const value of ["25.00000001", "26", "0", "-1", "NaN", "1e1"]) expect(() => issuanceCreateFeeCap({ HEDERA_ISSUANCE_CREATE_MAX_FEE_HBAR: value })).toThrow();
  expect(() => evmFeeCap({ HEDERA_MAX_EVM_TX_FEE_HBAR: "25", HEDERA_ISSUANCE_CREATE_MAX_FEE_HBAR: "25" })).toThrow("at most 10");
  expect(() => runtimeTiming({ HEDERA_ISSUANCE_CREATE_MAX_FEE_HBAR: "26" })).toThrow("at most 25");
});
test("large prepared ceilings use bounded estimates but genuinely expensive calls remain rejected", async () => {
  let estimate = 1_000_000n;
  const wallet = { address: `0x${"1".repeat(40)}`, provider: { send: async () => "0x128", estimateGas: async () => estimate }, populateTransaction: async (transaction: TransactionRequest) => ({ ...transaction, maxFeePerGas: 2_400_000_000_000n }) } as unknown as Wallet;
  const transaction = { chainId: 296n, gasLimit: 15_000_000n, value: 0n };
  expect((await populateBoundedTransaction(wallet, transaction)).gasLimit).toBe(1_200_000n);
  estimate = 4_000_000n;
  await expect(populateBoundedTransaction(wallet, transaction)).rejects.toThrow("fee");
  estimate = 16_000_000n;
  await expect(populateBoundedTransaction(wallet, transaction)).rejects.toThrow("ceiling");
});
test("only owner-private regular key files load; exact setup JSON artifacts are checked", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ops-secret-test-"));
  const file = join(directory, "key"), json = join(directory, "key.json"), link = join(directory, "link");
  try {
    await writeFile(file, testKey, { mode: 0o600 });
    const env: Record<string, string | undefined> = { HEDERA_ISSUER_PRIVATE_KEY_FILE: file };
    await loadSignerSecretFiles(["HEDERA_ISSUER_PRIVATE_KEY"], env); expect(env.HEDERA_ISSUER_PRIVATE_KEY).toBe(testKey);
    await chmod(file, 0o644);
    await expect(loadSignerSecretFiles(["HEDERA_ISSUER_PRIVATE_KEY"], { HEDERA_ISSUER_PRIVATE_KEY_FILE: file })).rejects.toThrow("owner-only");
    await chmod(file, 0o600); await symlink(file, link);
    await expect(loadSignerSecretFiles(["HEDERA_ISSUER_PRIVATE_KEY"], { HEDERA_ISSUER_PRIVATE_KEY_FILE: link })).rejects.toThrow();
    const key = safePrivateKey(testKey);
    await writeFile(json, JSON.stringify({ privateKey: key.toStringDer(), publicKey: key.publicKey.toStringRaw(), address: `0x${key.publicKey.toEvmAddress()}` }), { mode: 0o600 });
    const artifactEnv: Record<string, string | undefined> = { HEDERA_ISSUER_PRIVATE_KEY_FILE: json };
    await loadSignerSecretFiles(["HEDERA_ISSUER_PRIVATE_KEY"], artifactEnv); expect(artifactEnv.HEDERA_ISSUER_PRIVATE_KEY).toBe(key.toStringDer());
    await expect(loadSignerSecretFiles(["HEDERA_ISSUER_PRIVATE_KEY"], { HEDERA_ISSUER_PRIVATE_KEY_FILE: file, HEDERA_ISSUER_PRIVATE_KEY: testKey })).rejects.toThrow("not both");
  } finally { await rm(directory, { recursive: true }); }
});
