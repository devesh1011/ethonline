import { readFile } from "node:fs/promises";
import { safePrivateKey, loadSignerSecretFiles } from "./safety.js";
import { AccountId, Client, ContractExecuteTransaction, Hbar, PrivateKey, TransactionId } from "@hiero-ledger/sdk";
import { Contract, FetchRequest, Interface, JsonRpcProvider, ZeroHash, getBytes, id } from "ethers";
import { buildPool, factoringUnitLeaf, merkleProof, servicingCommandIdentity, servicingRole, validateServicingCommand, validateServicingTransition, type ServicingCommand } from "@receivablex/domain";
import { mirror } from "./index.js";
import { contextBindings, legacyRuntimeContext, parseRuntimeContext, verifyRuntimeEntityIds, verifyNativeSignerAccount, type RuntimePoolContext } from "./runtime-context.js";

export class ServicingCapabilityError extends Error {
  readonly code = "SERVICING_UNSUPPORTED";
  constructor() { super("Registry does not support servicing v2; verify the upgraded deployment before enabling commands"); }
}

export async function prepareServicingTransaction(raw: ServicingCommand, input: RuntimePoolContext = legacyRuntimeContext) {
  const context = parseRuntimeContext(input);
  await verifyRuntimeEntityIds(context, mirror);
  const evidence = contextBindings(context);
  if (process.env.SERVICING_COMMANDS_ENABLED !== "true") throw new Error("Servicing commands are disabled");
  if ((process.env.HEDERA_NETWORK ?? "testnet") !== "testnet") throw new Error("Only testnet is permitted");
  const { poolId, ...body } = raw;
  const command = validateServicingCommand(poolId, body);
  if (command.poolId !== evidence.pool.poolId) throw new Error("Pool is not in the configured deployment");
  const artifact = JSON.parse(await readFile(new URL("../../contracts/artifacts/contracts/ReceivablePoolRegistry.sol/ReceivablePoolRegistry.json", import.meta.url), "utf8"));
  const rpc = new FetchRequest(process.env.HEDERA_JSON_RPC_URL ?? "https://testnet.hashio.io/api"); rpc.timeout = 15_000;
  const provider = new JsonRpcProvider(rpc, 296, { staticNetwork: true });
  const registry = new Contract(evidence.registry.address, artifact.abi, provider);
  try {
    if (BigInt(await provider.send("eth_chainId", [])) !== 296n) throw new Error("RPC endpoint is not Hedera testnet (chain 296)");
    let version: bigint;
    try { version = await registry.getFunction("servicingVersion")(); } catch { throw new ServicingCapabilityError(); }
    if (version < 2n) throw new ServicingCapabilityError();
    const role = servicingRole(command.action);
    await loadSignerSecretFiles([role === "trustee" ? "HEDERA_TRUSTEE_PRIVATE_KEY" : "HEDERA_SERVICER_PRIVATE_KEY"]);
    const accountId = role === "trustee" ? process.env.HEDERA_TRUSTEE_ACCOUNT_ID : process.env.HEDERA_SERVICER_ACCOUNT_ID;
    const key = role === "trustee" ? process.env.HEDERA_TRUSTEE_PRIVATE_KEY : process.env.HEDERA_SERVICER_PRIVATE_KEY;
    if (!accountId || !key) throw new Error(`Missing dedicated ${role} signer configuration`);
    if (accountId === (process.env.HEDERA_OPERATOR_ACCOUNT_ID ?? process.env.ACCOUNT_ID)) throw new Error(`${role} must be separate from deployment administrator`);
    if (role === "trustee" && accountId === process.env.HEDERA_SERVICER_ACCOUNT_ID) throw new Error("Trustee and servicer signers must be separate");
    const actor = await mirror(`accounts/${accountId}`);
    const address = actor?.evm_address ?? `0x${AccountId.fromString(accountId).toEvmAddress()}`;
    if (!await registry.getFunction("hasRole")(id(`receivablex.role.${role}`), address)) throw new Error(`Configured signer lacks ${role} role`);
    const built = buildPool(context.records);
    const unit = built.accepted.find(entry => entry.fuId === command.fuId);
    if (!unit) throw new Error("Receivable is absent from committed manifest");
    const identity = servicingCommandIdentity(command);
    const [pool, collected, status, payload, block] = await Promise.all([
      registry.getFunction("getPool")(poolId), registry.getFunction("collectedByReceivable")(poolId, id(unit.fuId)),
      registry.getFunction("receivableStatus")(poolId, id(unit.fuId)), registry.getFunction("servicingPayloadHash")(identity.sourceEventId), provider.getBlock("latest"),
    ]);
    if (pool.poolRoot !== built.poolRoot || ![1, 2, 3].includes(Number(pool.status))) throw new Error("Live pool manifest or status does not permit servicing");
    if (payload !== ZeroHash && payload !== identity.payloadHash) throw new Error("Servicing reference conflicts with an on-chain event");
    if (!block) throw new Error("Confirmed chain time unavailable");
    if (payload === ZeroHash) validateServicingTransition(command, { status: ["PERFORMING", "PERFORMING", "DELINQUENT", "DEFAULTED", "WRITTEN_OFF", "PAID"][Number(status)]!, outstanding: unit.faceValue - BigInt(collected), dueDate: unit.dueDate }, block.timestamp);
    const leaf = { schemaVersion: 1, fuIdHash: id(unit.fuId), obligorIdHash: id(unit.obligorId), faceValue: unit.faceValue, dueDate: unit.dueDate, currency: "0x494e52", acceptedAt: unit.acceptedAt, evidenceHash: unit.evidenceHash };
    const proof = merkleProof(built.accepted.map(factoringUnitLeaf), factoringUnitLeaf(unit));
    const method = { DELINQUENT: "markDelinquent", DEFAULT: "markDefault", CURE: "cureReceivable", REVISE_RECOVERY: "reviseRecoveryEstimate" }[command.action];
    const args: unknown[] = [poolId, identity.sourceEventId, identity.payloadHash];
    if (["DEFAULT", "REVISE_RECOVERY"].includes(command.action)) args.push(command.estimatedRecoveryMinorUnits);
    args.push(leaf, proof);
    const data = new Interface(artifact.abi).encodeFunctionData(method, args);
    const privateKey = safePrivateKey(key);
    verifyNativeSignerAccount(await mirror(`accounts/${accountId}`), accountId, privateKey);
    const client = Client.forTestnet().setOperator(accountId, privateKey).setRequestTimeout(15_000).setMaxAttempts(2);
    try {
      const transaction = new ContractExecuteTransaction().setContractId(evidence.registry.contractId).setGas(1_500_000).setFunctionParameters(getBytes(data))
        .setTransactionId(TransactionId.generate(AccountId.fromString(accountId))).setTransactionValidDuration(120).setMaxTransactionFee(new Hbar(5)).setNodeAccountIds([AccountId.fromString("0.0.3")]).freezeWith(client);
      await transaction.sign(privateKey);
      return { transactionId: transaction.transactionId!.toString(), transactionHash: Buffer.from(await transaction.getTransactionHash()).toString("hex"), signedBytes: Buffer.from(transaction.toBytes()), validUntil: new Date(Number(transaction.transactionId!.validStart!.seconds.toString()) * 1000 + 120_000) };
    } finally { client.close(); }
  } finally { provider.destroy(); }
}
