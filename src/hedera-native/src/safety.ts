import { PrivateKey, PublicKey } from "@hiero-ledger/sdk";
import { lstat, readFile } from "node:fs/promises";
import { Interface, Wallet, parseUnits, type JsonRpcProvider, type TransactionRequest } from "ethers";
import { ATS_FACTORY_ABI } from "@receivablex/hedera-ats";
import { verifyNativeSignerAccount } from "./runtime-context.js";

const signerKeys = new WeakMap<Wallet, PrivateKey>();
const loadedSecrets = new WeakMap<object, Map<string, string>>();

/** Load only the requested lane's secrets. Values never enter logs or returned
 * diagnostics. Files are read once; rotate keys with a controlled worker restart. */
export async function loadSignerSecretFiles(names: readonly string[], env: Record<string, string | undefined> = process.env) {
  const loaded = loadedSecrets.get(env) ?? new Map<string, string>();
  loadedSecrets.set(env, loaded);
  for (const name of names) {
    if (!/^[A-Z][A-Z0-9_]*_PRIVATE_KEY$/.test(name)) throw new Error("Invalid signer secret variable name");
    const file = env[`${name}_FILE`];
    if (!file) {
      if (!env[name]) throw new Error(`Missing ${name.replace(/_PRIVATE_KEY$/, "").toLowerCase()} signer configuration`);
      safePrivateKey(env[name]!);
      continue;
    }
    if (loaded.has(name)) { if (env[name] !== loaded.get(name)) throw new Error("Signer secret changed; restart the worker after reconciliation"); continue; }
    if (env[name]) throw new Error("Configure either a raw signer key or its key file, not both");
    let value: string;
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (typeof process.getuid === "function" && info.uid !== process.getuid()) || info.size > 4096) throw new Error("unsafe");
      value = (await readFile(file, "utf8")).trim();
      if (!value) throw new Error("empty");
      if (value.startsWith("{")) {
        const record = JSON.parse(value) as Record<string, unknown>;
        if (Object.keys(record).length !== 3 || Object.keys(record).some(key => !["privateKey", "publicKey", "address"].includes(key)) || typeof record.privateKey !== "string" || typeof record.publicKey !== "string" || typeof record.address !== "string") throw new Error("Invalid key artifact");
        const key = safePrivateKey(record.privateKey);
        if (PublicKey.fromStringECDSA(record.publicKey).toStringRaw().toLowerCase() !== key.publicKey.toStringRaw().toLowerCase() || new Wallet(`0x${key.toStringRaw()}`).address.toLowerCase() !== record.address.toLowerCase()) throw new Error("Key artifact mismatch");
        value = record.privateKey;
      }
    } catch { throw new Error("Signer key file must be a readable owner-only regular file (mode 0600)"); }
    safePrivateKey(value);
    env[name] = value; loaded.set(name, value);
  }
}

export function safePrivateKey(raw: string): PrivateKey {
  try { return PrivateKey.fromStringECDSA(raw); }
  catch { throw new Error("Invalid configured signer key; replace the configuration securely."); }
}
export function safeEvmWallet(raw: string, provider: JsonRpcProvider): Wallet {
  const key = safePrivateKey(raw);
  try { const wallet = new Wallet(`0x${key.toStringRaw()}`, provider); signerKeys.set(wallet, key); return wallet; }
  catch { throw new Error("Invalid configured EVM signer; replace the configuration securely."); }
}
export async function assertSignerAccount(accountId: string, wallet: Wallet, fetcher: typeof fetch = fetch): Promise<void> {
  if (wallet.address.toLowerCase() === process.env.ISSUANCE_DEFAULT_ADMIN_ADDRESS?.toLowerCase()) throw new Error("Default administrator cannot act as an online managed signer");
  if (!/^0\.0\.[1-9][0-9]*$/.test(accountId)) throw new Error("Invalid dedicated signer account configuration");
  const key = signerKeys.get(wallet);
  if (!key) throw new Error("Signer was not constructed through the verified configuration boundary");
  const response = await fetcher(`https://testnet.mirrornode.hedera.com/api/v1/accounts/${accountId}`, { signal: AbortSignal.timeout(12_000) });
  if (!response.ok) throw new Error("Current signer account verification is unavailable");
  const account: unknown = await response.json();
  verifyNativeSignerAccount(account, accountId, key);
  if ((account as { evm_address?: string }).evm_address?.toLowerCase() !== wallet.address.toLowerCase()) throw new Error("Configured signer alias does not match the verified current account key");
}
export function evmFeeCap(env: Record<string, string | undefined> = process.env): bigint {
  const value = env.HEDERA_MAX_EVM_TX_FEE_HBAR ?? "5";
  if (!/^\d{1,2}(?:\.\d{1,8})?$/.test(value)) throw new Error("Invalid HEDERA_MAX_EVM_TX_FEE_HBAR configuration");
  const cap = parseUnits(value, 18);
  if (cap <= 0n || cap > parseUnits("10", 18)) throw new Error("EVM transaction fee cap must be positive and at most 10 HBAR");
  return cap;
}
export function issuanceCreateFeeCap(env: Record<string, string | undefined> = process.env): bigint {
  const value = env.HEDERA_ISSUANCE_CREATE_MAX_FEE_HBAR ?? "5";
  if (!/^\d{1,2}(?:\.\d{1,8})?$/.test(value)) throw new Error("Invalid HEDERA_ISSUANCE_CREATE_MAX_FEE_HBAR configuration");
  const cap = parseUnits(value, 18);
  if (cap <= 0n || cap > parseUnits("25", 18)) throw new Error("Security creation fee cap must be positive and at most 25 HBAR");
  return cap;
}
export interface IssuanceCreationFeePurpose { purpose: "ISSUANCE_CREATE_SECURITY"; factory: string; issuer: string }
const issuanceFactoryAbi = new Interface(ATS_FACTORY_ABI);
function feeCapForPurpose(wallet: Wallet, transaction: TransactionRequest, purpose: IssuanceCreationFeePurpose | undefined, env: Record<string, string | undefined>): bigint {
  const standard = evmFeeCap(env);
  if (purpose === undefined) return standard;
  let allowed = false;
  try {
    const call = typeof transaction.data === "string" ? issuanceFactoryAbi.parseTransaction({ data: transaction.data }) : null;
    allowed = purpose.purpose === "ISSUANCE_CREATE_SECURITY" && /^0x[0-9a-fA-F]{40}$/.test(purpose.factory) && BigInt(purpose.factory) > 0n && /^0x[0-9a-fA-F]{40}$/.test(purpose.issuer) && BigInt(purpose.issuer) > 0n && typeof transaction.to === "string" && transaction.to.toLowerCase() === purpose.factory.toLowerCase() && typeof transaction.from === "string" && transaction.from.toLowerCase() === purpose.issuer.toLowerCase() && wallet.address.toLowerCase() === purpose.issuer.toLowerCase() && BigInt(transaction.value ?? 0) === 0n && call?.name === "deployBond";
  } catch { /* A label cannot authorize unrelated or malformed calldata. */ }
  if (!allowed) throw new Error("Extended creation fee cap requires the configured issuer's exact ATS deployBond purpose and factory");
  return issuanceCreateFeeCap(env);
}
export function assertBoundedEvmFees(transaction: TransactionRequest, cap = evmFeeCap()): void {
  let gas: bigint, price: bigint, value: bigint, chainId: bigint, priority: bigint;
  try { gas = BigInt(transaction.gasLimit ?? 0); price = BigInt(transaction.maxFeePerGas ?? transaction.gasPrice ?? 0); value = BigInt(transaction.value ?? 0); chainId = BigInt(transaction.chainId ?? 0); priority = BigInt(transaction.maxPriorityFeePerGas ?? 0); }
  catch { throw new Error("Invalid EVM fee envelope"); }
  if (chainId !== 296n || gas <= 0n || gas > 15_000_000n || price <= 0n || value < 0n || gas * price + value > cap) throw new Error("EVM transaction exceeds the configured fee or gas limit");
  if (priority < 0n || priority > price) throw new Error("Invalid EVM priority fee");
}
export async function populateBoundedTransaction(wallet: Wallet, transaction: TransactionRequest, purpose?: IssuanceCreationFeePurpose, env: Record<string, string | undefined> = process.env): Promise<TransactionRequest> {
  const cap = feeCapForPurpose(wallet, transaction, purpose, env);
  let ceiling: bigint;
  try { ceiling = BigInt(transaction.gasLimit ?? 0); } catch { throw new Error("Invalid EVM gas ceiling"); }
  if (ceiling <= 0n || ceiling > 15_000_000n || !wallet.provider) throw new Error("Invalid EVM gas ceiling or provider");
  const rpc = wallet.provider as JsonRpcProvider;
  if (typeof rpc.send !== "function" || BigInt(await rpc.send("eth_chainId", [])) !== 296n) throw new Error("Managed EVM signing requires current Hedera testnet chain 296");
  // A prepared gas limit is an upper bound, not an instruction to reserve the
  // worst possible fee for a cheap call. Estimate the same unsigned call first.
  const estimate = await wallet.provider.estimateGas({ ...transaction, from: transaction.from ?? wallet.address });
  if (estimate <= 0n || estimate > ceiling) throw new Error("Estimated EVM gas exceeds the prepared ceiling");
  const buffered = (estimate * 120n + 99n) / 100n;
  const gasLimit = buffered < ceiling ? buffered : ceiling;
  const populated = await wallet.populateTransaction({ ...transaction, gasLimit });
  assertBoundedEvmFees(populated, cap);
  return populated;
}

export function runtimeTiming(env: Record<string, string | undefined> = process.env) {
  const number = (key: string, fallback: number, min: number, max: number) => {
    const raw = env[key] ?? String(fallback);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < min || Number(raw) > max) throw new Error(`Invalid ${key} configuration`);
    return Number(raw);
  };
  for (const [key, value] of Object.entries(env)) if (/^(COLLECTION|SERVICING|DISTRIBUTION|ISSUANCE|FINANCING|LIFECYCLE|EXCEPTIONS)_COMMANDS_ENABLED$/.test(key) && !["true", "false"].includes(value ?? "")) throw new Error(`Invalid ${key} flag`);
  evmFeeCap(env);
  issuanceCreateFeeCap(env);
  return { pollMs: number("WORKER_POLL_MS", 2_000, 250, 30_000), heartbeatMs: number("WORKER_HEARTBEAT_MS", 10_000, 1_000, 30_000), projectionMaxAgeMs: number("PROJECTION_MAX_AGE_MS", 120_000, 10_000, 300_000), backoffMaxMs: number("WORKER_BACKOFF_MAX_MS", 60_000, 2_000, 300_000) };
}
