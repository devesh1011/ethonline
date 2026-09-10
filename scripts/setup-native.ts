import { AccountCreateTransaction, AccountId, Client, ContractCreateTransaction, FileAppendTransaction, FileCreateTransaction, FileId, Hbar, Long, PrivateKey, TokenAssociateTransaction, TokenCreateTransaction, TokenSupplyType, TokenType, Transaction, TransactionId, TransferTransaction } from "@hiero-ledger/sdk";
import { AbiCoder, Contract, FetchRequest, Interface, JsonRpcProvider, Wallet, getBytes, hexlify, keccak256, type TransactionRequest } from "ethers";
import { verifyNativeSignerAccount } from "../src/hedera-native/src/runtime-context.js";
import { loadHederaConfig } from "./config.js";
import { FILE_CHUNK_BYTES, registryFileChunks } from "./setup-plan.js";
import { remainingSetupCost, signedArtifactHash, type SetupKey, type SetupPlan, type SetupPrepared, type SetupReceipt, type SetupSigned, type SetupState, type SetupStep, type SetupTransport } from "./setup-checkpoints.js";
const registryAbi = new Interface(["function grantRole(bytes32,address)", "function hasRole(bytes32,address) view returns(bool)", "function lifecycleVersion() view returns(uint256)", "function servicingVersion() view returns(uint256)", "function distributionVersion() view returns(uint256)", "event RoleGranted(bytes32 indexed role,address indexed account,address indexed sender)"]);
const privateKey = (raw: string) => { try { return PrivateKey.fromStringECDSA(raw); } catch { throw new Error("Invalid private signing key; key material is omitted"); } };
function account(state: SetupState, role: string): string { const id = state.steps[`account-${role}`]?.result?.accountId; if (typeof id !== "string" || !/^0\.0\.[1-9]\d*$/.test(id)) throw new Error("A required actor creation is not confirmed"); return id; }
function resultId(state: SetupState, step: string, field: string): string { const value = state.steps[step]?.result?.[field]; if (typeof value !== "string") throw new Error("A prerequisite setup identity is not confirmed"); return value; }
export function boundedSetupGas(estimate: bigint, ceiling: bigint): bigint {
  if (estimate <= 0n || estimate > ceiling) throw new Error("Estimated setup gas exceeds the reviewed transaction ceiling");
  const buffered = (estimate * 120n + 99n) / 100n + 10000n;
  return buffered > ceiling ? ceiling : buffered;
}
export function restoreSignedSetupNative(signed: SetupSigned): Transaction {
  const bytes = Buffer.from(signed.signedBytes, "base64");
  if (signedArtifactHash(bytes) !== signed.bytesHash) throw new Error("Stored native byte hash mismatch");
  const transaction = Transaction.fromBytes(bytes);
  // The public getter locks SDK transaction IDs, preventing expiry regeneration.
  if (transaction.transactionId?.toString() !== signed.transactionId) throw new Error("Stored native identity mismatch");
  transaction.setMaxAttempts(1);
  if (!Buffer.from(transaction.toBytes()).equals(bytes)) throw new Error("Native restoration changed signed bytes");
  return transaction;
}
export async function prepareNativeSetup(step: SetupStep, plan: SetupPlan, state: SetupState, keys: (role: string) => Promise<SetupKey>, client: Client): Promise<SetupPrepared> {
  let native: Transaction; const signers = ["operator"];
  if (step.kind === "ACCOUNT") { const key = privateKey((await keys(step.role!)).privateKey); native = new AccountCreateTransaction().setKey(key.publicKey).setAlias(key.publicKey.toEvmAddress()).setInitialBalance(new Hbar(step.initialHbar!)).setMaxAutomaticTokenAssociations(0); }
  else if (step.kind === "TOKEN") { const admin = privateKey((await keys("admin")).privateKey), treasury = privateKey((await keys("treasury")).privateKey); native = new TokenCreateTransaction().setTokenName("ReceivableX Test Settlement").setTokenSymbol("INRX").setTokenType(TokenType.FungibleCommon).setSupplyType(TokenSupplyType.Finite).setDecimals(2).setInitialSupply(Long.fromString("5000000000")).setMaxSupply(Long.fromString("5000000000")).setTreasuryAccountId(account(state, "treasury")).setAdminKey(admin.publicKey).setSupplyKey(treasury.publicKey); signers.push("treasury", "admin"); }
  else if (step.kind === "FILE_CREATE") { const admin = privateKey((await keys("admin")).privateKey); native = new FileCreateTransaction().setKeys([admin.publicKey]).setContents(registryFileChunks(plan.registryBytecode)[0]!); signers.push("admin"); }
  else if (step.kind === "FILE_APPEND") { const chunk = registryFileChunks(plan.registryBytecode)[step.chunk!]; if (!chunk?.length) throw new Error("Empty bytecode append is forbidden"); native = new FileAppendTransaction().setFileId(FileId.fromString(resultId(state, "registry-file-create", "fileId"))).setChunkSize(FILE_CHUNK_BYTES).setMaxChunks(1).setContents(chunk); signers.push("admin"); }
  else if (step.kind === "REGISTRY") { const admin = await keys("admin"); native = new ContractCreateTransaction().setBytecodeFileId(resultId(state, "registry-file-create", "fileId")).setGas(8000000).setAdminKey(privateKey(admin.privateKey).publicKey).setAutoRenewAccountId(account(state, "admin")).setConstructorParameters(getBytes(AbiCoder.defaultAbiCoder().encode(["address"], [admin.address]))); signers.push("admin"); }
  else if (step.kind === "ASSOCIATE") { native = new TokenAssociateTransaction().setAccountId(account(state, step.role!)).setTokenIds([resultId(state, "token-create", "tokenId")]); signers.push(step.role!); }
  else if (step.kind === "FAUCET") { native = new TransferTransaction().addTokenTransfer(resultId(state, "token-create", "tokenId"), account(state, "treasury"), Long.fromString(`-${step.amount}`)).addTokenTransfer(resultId(state, "token-create", "tokenId"), account(state, step.role!), Long.fromString(step.amount!)); signers.push("treasury"); }
  else throw new Error("This setup step is not a native transaction");
  const transactionId = TransactionId.generate(AccountId.fromString(plan.operatorAccountId));
  native.setTransactionId(transactionId).setTransactionValidDuration(120).setNodeAccountIds([AccountId.fromString("0.0.3")]).setMaxTransactionFee(new Hbar(step.maxFeeHbar)).setRegenerateTransactionId(false).setMaxAttempts(1).freezeWith(client);
  return { kind: "NATIVE", transactionId: transactionId.toString(), unsignedBytes: Buffer.from(native.toBytes()).toString("base64"), validUntil: new Date(Number(transactionId.validStart!.seconds.toString()) * 1000 + 120000).toISOString(), signers };
}

/** This factory must only be imported/called after CLI execution+secured-key gates. */
export async function createSetupTransport(plan: SetupPlan): Promise<SetupTransport & { preflight(state?: SetupState): Promise<Record<string, unknown>> }> {
  if (!["SECURED_KEY_CONFIRMED", "EXPOSED_TESTNET_ACCEPTED"].includes(plan.securityAcknowledgement ?? "")) throw new Error("Explicit key-security acknowledgement is required for the native setup transport");
  const config = loadHederaConfig();
  if (config.operatorAccountId !== plan.operatorAccountId || config.chainId !== 296) throw new Error("Run operator or testnet configuration changed");
  const operatorKey = privateKey(config.operatorPrivateKey);
  const rpc = new FetchRequest(config.jsonRpcUrl); rpc.timeout = 15000;
  const provider = new JsonRpcProvider(rpc);
  const client = Client.forTestnet().setOperator(plan.operatorAccountId, operatorKey).setRequestTimeout(15000).setMaxAttempts(1);
  const broadcastClient = Client.forTestnet().setRequestTimeout(15000).setMaxAttempts(1).setDefaultRegenerateTransactionId(false);
  async function mirror(path: string) { const response = await fetch(`${config.mirrorNodeUrl}${path}`, { signal: AbortSignal.timeout(15000) }); if (response.status === 404) return null; if (!response.ok) throw new Error("Mirror request unavailable"); return response.json() as Promise<Record<string, any>>; }
  const assertNetwork = async () => { if (BigInt(await provider.send("eth_chainId", [])) !== 296n) throw new Error("Setup RPC must be Hedera testnet 296"); };
  async function contractIdentity(entityId: string) { const data = await mirror(`contracts/${entityId}`); if (!data || data.deleted || !/^0\.0\.[1-9]\d*$/.test(data.contract_id ?? "") || !/^0x[0-9a-fA-F]{40}$/.test(data.evm_address ?? "") || (entityId.startsWith("0.0.") ? data.contract_id !== entityId : data.evm_address.toLowerCase() !== entityId.toLowerCase())) throw new Error("Contract identity is not yet verified by Mirror; resume without redeploying"); return { contractId: String(data.contract_id), address: String(data.evm_address) }; }
  return {
    dispose() { client.close(); broadcastClient.close(); provider.destroy(); },
    async preflight(state) {
      await assertNetwork(); const operator = await mirror(`accounts/${plan.operatorAccountId}`); verifyNativeSignerAccount(operator, plan.operatorAccountId, operatorKey);
      const remaining = remainingSetupCost(plan, state);
      const upperBound = BigInt(state?.spentTinybar ?? "0") + remaining;
      if (upperBound > BigInt(plan.maxHbar) * 100000000n) throw new Error("Actual spend plus effective remaining caps exceed the unchanged setup budget");
      if (BigInt(operator?.balance?.balance ?? "0") < remaining) throw new Error("Operator needs the remaining conservative setup HBAR balance before execution");
      const [factory, resolver] = await Promise.all([contractIdentity(plan.atsFactoryId), contractIdentity(plan.atsResolverId)]);
      for (const accountId of plan.walletInvestors) { const investor = await mirror(`accounts/${accountId}`); if (!investor || investor.account !== accountId || investor.deleted) throw new Error("A declared external wallet account is not active on testnet"); }
      if (plan.credentialMode === "REGISTRY") for (const target of [plan.vcDidRegistry!, plan.vcRevocationRegistry!]) if (await provider.getCode(target) === "0x") throw new Error("Configured credential registry is not deployed on testnet");
      return { operatorAccountId: plan.operatorAccountId, operatorPublicKey: operatorKey.publicKey.toStringRaw(), operatorBalanceTinybar: String(operator?.balance?.balance), remainingConservativeHbar: `${remaining / 100000000n}.${String(remaining % 100000000n).padStart(8, "0")}`, actualPlusRemainingTinybar: upperBound.toString(), declaredMaxHbar: plan.maxHbar, securityAcknowledgement: plan.securityAcknowledgement, atsFactory: factory, atsResolver: resolver, credentialMode: plan.credentialMode };
    },
    async generateKey() { const key = PrivateKey.generateECDSA(); return { privateKey: key.toStringDer(), publicKey: key.publicKey.toStringRaw(), address: `0x${key.publicKey.toEvmAddress()}` }; },
    async prepare(step, _plan, state, keys) {
      await assertNetwork();
      if (step.kind === "ROLE") {
        const admin = await keys("admin"), member = await keys(step.role!); const registry = resultId(state, "registry-create", "address");
        const transaction = { to: registry, from: admin.address, data: registryAbi.encodeFunctionData("grantRole", [step.roleHash, member.address]), chainId: "296", value: "0", gasLimit: "900000", maxSetupFeeHbar: step.maxFeeHbar };
        return { kind: "EVM", transaction, signers: ["admin"] };
      }
      return prepareNativeSetup(step, plan, state, keys, client);
    },
    async sign(prepared, keys) {
      await assertNetwork(); let bytes: Uint8Array; let transactionId: string;
      verifyNativeSignerAccount(await mirror(`accounts/${plan.operatorAccountId}`), plan.operatorAccountId, operatorKey);
      if (prepared.kind === "NATIVE") {
        const native = Transaction.fromBytes(Buffer.from(prepared.unsignedBytes!, "base64"));
        for (const role of prepared.signers) await native.sign(role === "operator" ? operatorKey : privateKey((await keys(role)).privateKey));
        bytes = native.toBytes(); transactionId = native.transactionId!.toString();
        if (transactionId !== prepared.transactionId) throw new Error("Native signing changed the prepared transaction identity");
      } else {
        const actor = await keys(prepared.signers[0]!); const wallet = new Wallet(`0x${privateKey(actor.privateKey).toStringRaw()}`, provider);
        const currentActor = await mirror(`accounts/${actor.address}`); verifyNativeSignerAccount(currentActor, String(currentActor?.account ?? ""), privateKey(actor.privateKey));
        const { maxSetupFeeHbar, ...input } = prepared.transaction!;
        const transaction = { ...input, gasLimit: BigInt(String(input.gasLimit)), chainId: 296n, value: 0n } as TransactionRequest;
        if (String(input.from).toLowerCase() !== wallet.address.toLowerCase()) throw new Error("Prepared EVM signer mismatch");
        await provider.call(transaction);
        transaction.gasLimit = boundedSetupGas(await provider.estimateGas(transaction), BigInt(String(input.gasLimit)));
        const populated = await wallet.populateTransaction(transaction);
        const fee = BigInt(populated.maxFeePerGas ?? populated.gasPrice ?? 0) * BigInt(populated.gasLimit ?? 0);
        if (fee <= 0n || fee > BigInt(Number(maxSetupFeeHbar)) * 1000000000000000000n) throw new Error("Setup EVM fee quote exceeds the declared step cap");
        const signed = await wallet.signTransaction(populated); bytes = getBytes(signed); transactionId = keccak256(signed);
      }
      return { transactionId, signedBytes: Buffer.from(bytes).toString("base64"), bytesHash: signedArtifactHash(bytes), ...(prepared.validUntil ? { validUntil: prepared.validUntil } : {}) };
    },
    async submit(signed, prepared) {
      await assertNetwork(); const bytes = Buffer.from(signed.signedBytes, "base64");
      if (prepared.kind === "EVM") { await provider.broadcastTransaction(hexlify(bytes)); return; }
      const transaction = restoreSignedSetupNative(signed);
      // The broadcaster has no operator/signing key: it can only send the
      // already signed persisted transaction, never add or regenerate a proof.
      await transaction.execute(broadcastClient);
    },
    async reconcile(signed, prepared) {
      await assertNetwork();
      if (prepared.kind === "EVM") { const receipt = await provider.getTransactionReceipt(signed.transactionId); if (!receipt) return null; return { transactionId: signed.transactionId, success: receipt.status === 1, status: receipt.status === 1 ? "SUCCESS" : "REVERTED", feeTinybar: ((receipt.fee + 9999999999n) / 10000000000n).toString(), evmHash: receipt.hash, raw: { hash: receipt.hash, blockNumber: receipt.blockNumber, logs: receipt.logs.map(log => ({ address: log.address, topics: [...log.topics], data: log.data })) } }; }
      const mirrorId = signed.transactionId.replace("@", "-").replace(/(\d+)\.(\d+)$/, "$1-$2");
      const response = await mirror(`transactions/${mirrorId}`); if (!response) return null;
      const rows = (response.transactions ?? []).filter((row: Record<string, unknown>) => row.result !== "DUPLICATE_TRANSACTION" && Number(row.nonce ?? 0) === 0);
      if (rows.length !== 1) return null; const receipt = rows[0];
      if (receipt.transaction_id !== mirrorId) throw new Error("Mirror receipt does not match the requested native identity");
      if (typeof receipt.result !== "string" || !Number.isSafeInteger(Number(receipt.charged_tx_fee))) throw new Error("Native receipt is incomplete");
      return { transactionId: signed.transactionId, success: receipt.result === "SUCCESS", status: receipt.result, feeTinybar: String(receipt.charged_tx_fee), consensusTimestamp: String(receipt.consensus_timestamp), ...(receipt.entity_id ? { entityId: String(receipt.entity_id) } : {}), raw: receipt };
    },
    async verify(step, receipt, _plan, state, keys) {
      if (!receipt.success) throw new Error("Cannot verify a failed setup step");
      if (step.kind === "ACCOUNT") { if (!receipt.entityId) throw new Error("Account creation identity missing"); const actor = await mirror(`accounts/${receipt.entityId}`); const key = await keys(step.role!); verifyNativeSignerAccount(actor, receipt.entityId, privateKey(key.privateKey)); if (String(actor?.evm_address).toLowerCase() !== key.address.toLowerCase()) throw new Error("Created actor alias differs from its persisted key"); return { accountId: receipt.entityId, address: key.address, publicKey: key.publicKey }; }
      if (step.kind === "TOKEN") { const token = await mirror(`tokens/${receipt.entityId}`); if (!token || token.token_id !== receipt.entityId || token.deleted || token.treasury_account_id !== account(state, "treasury") || Number(token.decimals) !== 2 || String(token.total_supply) !== "5000000000") throw new Error("Created token identity or supply is not confirmed"); return { tokenId: String(token.token_id), address: `0x${AccountId.fromString(String(token.token_id)).toEvmAddress()}`, treasuryAccountId: account(state, "treasury"), decimals: 2 }; }
      if (step.kind === "FILE_CREATE") { if (!receipt.entityId || !/^0\.0\.[1-9]\d*$/.test(receipt.entityId)) throw new Error("Bytecode file identity missing"); return { fileId: receipt.entityId, bytecodeHash: plan.registryBytecodeHash }; }
      if (step.kind === "FILE_APPEND") return { fileId: resultId(state, "registry-file-create", "fileId"), chunk: step.chunk! };
      if (step.kind === "REGISTRY") { if (!receipt.entityId) throw new Error("Registry contract identity missing"); const identity = await contractIdentity(receipt.entityId); const registry = new Contract(identity.address, registryAbi, provider); const capabilities = await Promise.all(["lifecycleVersion", "servicingVersion", "distributionVersion"].map(name => registry.getFunction(name)().then((value: bigint) => Number(value)))); return { ...identity, lifecycleVersion: capabilities[0]!, servicingVersion: capabilities[1]!, distributionVersion: capabilities[2]! }; }
      if (step.kind === "ROLE") { const registry = new Contract(resultId(state, "registry-create", "address"), registryAbi, provider); const member = await keys(step.role!); if (!await registry.getFunction("hasRole")(step.roleHash, member.address)) throw new Error("Registry role grant is not observed"); return { role: step.role!, roleHash: step.roleHash!, member: member.address }; }
      const actorId = account(state, step.role!), tokenId = resultId(state, "token-create", "tokenId");
      const association = await mirror(`accounts/${actorId}/tokens?token.id=${tokenId}`); const row = association?.tokens?.find((item: Record<string, unknown>) => item.token_id === tokenId);
      if (!row) throw new Error("Token association is not yet indexed");
      if (step.kind === "FAUCET") {
        const transfers = (receipt.raw as Record<string, any>)?.token_transfers ?? [];
        if (!transfers.some((entry: Record<string, unknown>) => entry.token_id === tokenId && entry.account === actorId && String(entry.amount) === step.amount)) throw new Error("Faucet receipt does not show the planned test funding");
        return { actorId, tokenId, amount: step.amount!, purpose: "FAUCET_TEST_BALANCE_NOT_SUBSCRIPTION" };
      }
      return { actorId, tokenId, associated: true };
    },
  };
}
