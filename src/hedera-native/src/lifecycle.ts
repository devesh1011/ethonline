import { readFile } from "node:fs/promises";
import { safeEvmWallet, assertSignerAccount, populateBoundedTransaction, loadSignerSecretFiles } from "./safety.js";
import { AccountId, Client, ContractId, ContractExecuteTransaction, Hbar, PrivateKey, TransactionId } from "@hiero-ledger/sdk";
import { Contract, FetchRequest, Interface, JsonRpcProvider, Wallet, getBytes, hexlify, id, keccak256, toQuantity } from "ethers";
import { createAtsAdapter } from "@receivablex/hedera-ats";
import { assertRetirementReady, type LifecycleAction, type RetirementTransaction } from "@receivablex/domain";

export interface LifecycleContext { poolId: string; registry: string; security: string; actorAccountId: string; action: LifecycleAction; amountUnits: string }
export interface LifecycleTransport {
  prepare(context: LifecycleContext): Promise<{ signedBytes: Uint8Array | null; transactionId: string | null; prepared: RetirementTransaction }>;
  submit(bytes: Uint8Array): Promise<void>;
  reconcile(context: LifecycleContext, transactionId: string, prepared: RetirementTransaction): Promise<{ success: boolean; status: string } | null>;
  dispose?(): void;
}

export async function createLifecycleTransport(): Promise<LifecycleTransport> {
  if (process.env.LIFECYCLE_COMMANDS_ENABLED !== "true" || process.env.HEDERA_NETWORK !== "testnet") throw new Error("Lifecycle commands require enabled testnet configuration");
  const rpc = new FetchRequest(process.env.HEDERA_JSON_RPC_URL ?? "https://testnet.hashio.io/api"); rpc.timeout = 15000;
  const provider = new JsonRpcProvider(rpc);
  const assertNetwork = async () => { if (BigInt(await provider.send("eth_chainId", [])) !== 296n) throw new Error("Lifecycle RPC must be Hedera testnet 296"); };
  const artifact = JSON.parse(await readFile(new URL("../../contracts/artifacts/contracts/ReceivablePoolRegistry.sol/ReceivablePoolRegistry.json", import.meta.url), "utf8"));
  const abi = new Interface(artifact.abi);
  const registryFor = (c: LifecycleContext) => new Contract(c.registry, abi, provider);
  const ats = createAtsAdapter(provider);
  async function accountAddress(accountId: string) {
    const response = await fetch(`https://testnet.mirrornode.hedera.com/api/v1/accounts/${accountId}`, { signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error("Holder account lookup unavailable");
    const account = await response.json() as { account?: string; deleted?: boolean; evm_address?: string };
    if (account.account !== accountId || account.deleted) throw new Error("Authenticated holder account is not active on testnet");
    return account.evm_address ?? `0x${AccountId.fromString(accountId).toEvmAddress()}`;
  }
  return {
    dispose() { provider.destroy(); },
    async prepare(context) {
      await assertNetwork();
      const registry = registryFor(context);
      let version;
      try { version = await registry.getFunction("lifecycleVersion")(); } catch { throw new Error("Registry lifecycle capability is unavailable; verified upgrade required"); }
      if (version !== 1n) throw new Error("Registry lifecycle v1 is required");
      const pool = await registry.getFunction("getPool")(context.poolId);
      if (String(pool.atsSecurity).toLowerCase() !== context.security.toLowerCase()) throw new Error("Pool security binding changed");
      const address = await accountAddress(context.actorAccountId);
      let transaction;
      let wallet: Wallet | undefined;
      if (context.action === "RETIRE") {
        const pending = await registry.getFunction("pendingDistributions")(context.poolId);
        assertRetirementReady({ state: ["DRAFT", "ACTIVE", "AMORTIZING", "MATURED", "CLOSED"][Number(pool.status)]!, principal: pool.investorPrincipalOutstanding, cash: pool.availableCash, reservedCash: pool.reservedCash, reservedPrincipal: pool.reservedPrincipal, performing: pool.performingFaceOutstanding, delinquent: pool.delinquentFaceOutstanding, defaulted: pool.defaultedFaceOutstanding, estimatedRecovery: pool.estimatedDefaultRecoveries, pendingDistributions: pending });
        const security = new Contract(context.security, ["function balanceOf(address) view returns(uint256)"], provider);
        if (await security.getFunction("balanceOf")(address) < BigInt(context.amountUnits)) throw new Error("Authenticated holder does not own the requested units");
        transaction = (await ats.prepareRetirement(context.security, address, BigInt(context.amountUnits))).transaction;
      } else {
        await loadSignerSecretFiles(["HEDERA_TRUSTEE_PRIVATE_KEY"]);
        const accountId = process.env.HEDERA_TRUSTEE_ACCOUNT_ID;
        const key = process.env.HEDERA_TRUSTEE_PRIVATE_KEY;
        if (!accountId || !key || accountId !== context.actorAccountId || accountId === (process.env.HEDERA_OPERATOR_ACCOUNT_ID ?? process.env.ACCOUNT_ID)) throw new Error("The dedicated configured trustee must authorize lifecycle commands");
        wallet = safeEvmWallet(key, provider);
        await assertSignerAccount(accountId, wallet);
        if (wallet.address.toLowerCase() !== address.toLowerCase() || String(pool.trustee).toLowerCase() !== address.toLowerCase() || !await registry.getFunction("hasRole")(id("receivablex.role.trustee"), address)) throw new Error("Trustee account, key or contract authority does not match");
        transaction = { to: context.registry, from: address, data: abi.encodeFunctionData(context.action === "MATURE" ? "markMatured" : "closePool", [context.poolId]), value: 0n, chainId: 296n, gasLimit: 1500000n };
      }
      await provider.call(transaction);
      const nonce = await provider.getTransactionCount(address, "pending");
      const prepared: RetirementTransaction = { from: address, to: transaction.to, data: transaction.data, value: "0x0", chainId: "0x128", gas: toQuantity(transaction.gasLimit), nonce: toQuantity(nonce) };
      if (!wallet) {
        const response = await fetch(`https://testnet.mirrornode.hedera.com/api/v1/contracts/${context.security}`, { signal: AbortSignal.timeout(12000) });
        if (!response.ok) throw new Error("Native retirement requires the verified numeric security contract ID");
        const binding = await response.json() as { contract_id?: string; evm_address?: string; deleted?: boolean };
        if (!binding.contract_id || !/^0\.0\.[1-9][0-9]*$/.test(binding.contract_id) || binding.deleted || binding.evm_address?.toLowerCase() !== context.security.toLowerCase()) throw new Error("Native security contract ID binding mismatch");
        const nativeClient = Client.forTestnet();
        try {
          const transactionId = TransactionId.generate(AccountId.fromString(context.actorAccountId));
          const native = new ContractExecuteTransaction().setContractId(ContractId.fromString(binding.contract_id)).setFunctionParameters(getBytes(transaction.data)).setGas(1200000)
            .setTransactionId(transactionId).setTransactionValidDuration(120).setMaxTransactionFee(new Hbar(5)).setNodeAccountIds([AccountId.fromString("0.0.3")]).freezeWith(nativeClient);
          prepared.nativeTransactionList = Buffer.from(native.toBytes()).toString("base64");
          prepared.nativeTransactionId = transactionId.toString();
          prepared.nativeContractId = binding.contract_id;
          prepared.nativeValidUntil = new Date(Number(transactionId.validStart!.seconds.toString()) * 1000 + 120000).toISOString();
          prepared.holderAccountId = context.actorAccountId;
        } finally { nativeClient.close(); }
        return { prepared, signedBytes: null, transactionId: null };
      }
      const signed = await wallet.signTransaction(await populateBoundedTransaction(wallet, { ...transaction, nonce }));
      return { prepared, signedBytes: getBytes(signed), transactionId: keccak256(signed) };
    },
    async submit(bytes) { await assertNetwork(); await provider.broadcastTransaction(hexlify(bytes)); },
    async reconcile(context, transactionId, prepared) {
      await assertNetwork();
      if (transactionId.includes("@")) {
        if (context.action !== "RETIRE" || transactionId !== prepared.nativeTransactionId || prepared.holderAccountId !== context.actorAccountId) throw new Error("Native retirement transaction identity mismatch");
        const mirrorId = transactionId.replace("@", "-").replace(/(\d+)\.(\d+)$/, "$1-$2");
        const response = await fetch(`https://testnet.mirrornode.hedera.com/api/v1/contracts/results/${mirrorId}`, { signal: AbortSignal.timeout(12000) });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error("Native retirement receipt lookup unavailable");
        const result = await response.json() as { from?: string; to?: string; function_parameters?: string; amount?: number; result?: string };
        const from = result.from?.toLowerCase();
        const numericAddress = `0x${AccountId.fromString(context.actorAccountId).toEvmAddress()}`.toLowerCase();
        if (![prepared.from.toLowerCase(), numericAddress].includes(from ?? "") || result.to?.toLowerCase() !== prepared.to.toLowerCase() || result.function_parameters !== prepared.data || result.amount !== 0) throw new Error("Native receipt does not match authorized holder, target, calldata and zero value");
        if (!result.result) throw new Error("Native receipt is missing its consensus result");
        return { success: result.result === "SUCCESS", status: result.result };
      }
      const [tx, receipt] = await Promise.all([provider.getTransaction(transactionId), provider.getTransactionReceipt(transactionId)]);
      if (!tx || !receipt) return null;
      if (tx.chainId !== 296n || tx.from.toLowerCase() !== prepared.from.toLowerCase() || tx.to?.toLowerCase() !== prepared.to.toLowerCase() || tx.data !== prepared.data || tx.value !== 0n || BigInt(tx.nonce) !== BigInt(prepared.nonce)) throw new Error("Transaction does not match the authorized holder, target, calldata, value and nonce");
      if (receipt.status !== 1) return { success: false, status: "CONTRACT_REVERT" };
      if (context.action !== "RETIRE") {
        const pool = await registryFor(context).getFunction("getPool")(context.poolId);
        if (Number(pool.status) !== (context.action === "MATURE" ? 3 : 4)) throw new Error("Confirmed lifecycle state is not yet visible");
      }
      return { success: true, status: "SUCCESS" };
    },
  };
}
