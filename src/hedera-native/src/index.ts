import { readFile } from "node:fs/promises";
export * from "./safety.js";
import { loadSignerSecretFiles, safePrivateKey } from "./safety.js";
import { AccountId, Client, ContractExecuteTransaction, Hbar, PrivateKey, Transaction, TransactionId, TransferTransaction } from "@hiero-ledger/sdk";
import { Contract, FetchRequest, Interface, JsonRpcProvider, getBytes, id } from "ethers";
import Long from "long";
import { ATS_ASSET_ABI } from "@receivablex/hedera-ats";
import { historicalEvidence, legacyRuntimeContext, contextBindings, parseRuntimeContext, verifyRuntimeEntityIds, verifyNativeSignerAccount, type RuntimePoolContext } from "./runtime-context.js";
export * from "./runtime-context.js";
export * from "./servicing.js";
export * from "./distributions.js";
export * from "./issuance.js";
export * from "./lifecycle.js";
export * from "./financing.js";
export * from "./exceptions.js";
import { buildPool, collectionCommandIdentity, factoringUnitLeaf, merkleProof, validateCollectionCommand, type CollectionCommand } from "@receivablex/domain";

export const evidence = historicalEvidence;
const artifact = JSON.parse(await readFile(new URL("../../contracts/artifacts/contracts/ReceivablePoolRegistry.sol/ReceivablePoolRegistry.json", import.meta.url), "utf8"));
const rpc = new FetchRequest(process.env.HEDERA_JSON_RPC_URL ?? "https://testnet.hashio.io/api");
rpc.timeout = 15_000;
const provider = new JsonRpcProvider(rpc, 296, { staticNetwork: true });
async function assertTestnetRpc() {
  if (BigInt(await provider.send("eth_chainId", [])) !== 296n) throw new Error("RPC endpoint is not Hedera testnet (chain 296)");
}
const mirrorBase = (process.env.HEDERA_MIRROR_NODE_URL ?? "https://testnet.mirrornode.hedera.com/api/v1").replace(/\/$/, "");

export async function mirror(path: string): Promise<any> {
  const response = await fetch(`${mirrorBase}/${path.replace(/^\//, "")}`, { signal: AbortSignal.timeout(12_000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Mirror query failed (${response.status})`);
  return response.json();
}

const receiptOutcomes = new Map<string, boolean>();
async function successfulContractReceipt(hash: string): Promise<boolean> {
  const known = receiptOutcomes.get(hash);
  if (known !== undefined) return known;
  const result = await mirror(`contracts/results/${hash}`);
  if (!result?.result || result.hash?.toLowerCase() !== hash.toLowerCase()) throw new Error("Contract receipt is not yet available for event reconciliation");
  const success = result.result === "SUCCESS";
  if (receiptOutcomes.size >= 10000) receiptOutcomes.delete(receiptOutcomes.keys().next().value!);
  receiptOutcomes.set(hash, success);
  return success;
}

export function mirrorTransactionId(value: string) { return value.replace("@", "-").replace(/(\d+)\.(\d+)$/, "$1-$2"); }
export async function reconcileTransaction(transactionId: string) {
  const result = await mirror(`transactions/${mirrorTransactionId(transactionId)}`);
  // Internal child records can succeed even when the parent contract call failed.
  const transactions = (result?.transactions ?? []).filter((entry:any)=>(entry.nonce??0)===0);
  const record = transactions.find((entry: any) => entry.result === "SUCCESS") ?? transactions.find((entry: any) => entry.result !== "DUPLICATE_TRANSACTION");
  return record ? { success: record.result === "SUCCESS", status: String(record.result), consensusTimestamp: String(record.consensus_timestamp) } : null;
}

/** Recover an operation omitted from this database without issuing another token transfer. */
export async function findRecordedCollection(command:CollectionCommand, input: RuntimePoolContext = legacyRuntimeContext):Promise<null|{kind:"conflict"}|{kind:"recorded";transactionId:string;consensusTimestamp:string}> {
  await assertTestnetRpc();
  const context = parseRuntimeContext(input);
  if (command.poolId !== context.poolId) throw new Error("Collection does not belong to the selected pool");
  const evidence = contextBindings(context);
  const registry = new Contract(context.registryAddress, artifact.abi, provider);
  const identity=collectionCommandIdentity(command);
  const [payload,poolId]=await Promise.all([registry.getFunction("collectionPayloadHash")(identity.sourceEventId),registry.getFunction("collectionPool")(identity.sourceEventId)]);
  if(payload===`0x${"0".repeat(64)}`)return null;
  if(payload!==identity.payloadHash||String(poolId).toLowerCase()!==command.poolId)return{kind:"conflict"};
  let next:string|null=`contracts/${evidence.registry.contractId}/results/logs?order=desc&limit=100`;
  for(let page=0;next;page++){
    if(page>=100)throw new Error("Recorded collection event lookup exceeded pagination limit");
    const result=await mirror(next);
    for(const log of result?.logs??[]){
      let parsed;try{parsed=new Interface(artifact.abi).parseLog({topics:log.topics,data:log.data});}catch{continue;}
      if(parsed?.name!=="CollectionRecorded"||parsed.args.sourceEventId!==identity.sourceEventId)continue;
      if(!await successfulContractReceipt(String(log.transaction_hash)))continue;
      if(String(parsed.args.poolId).toLowerCase()!==command.poolId||parsed.args.fuIdHash!==id(command.fuId)||String(parsed.args.amount)!==command.amountMinorUnits)return{kind:"conflict"};
      const receipt=await mirror(`contracts/results/${log.transaction_hash}`);
      if(receipt?.result!=="SUCCESS")throw new Error("Matching collection event receipt is not yet verified");
      return{kind:"recorded",transactionId:String(log.transaction_hash),consensusTimestamp:String(log.timestamp)};
    }
    next=result?.links?.next?String(result.links.next).replace(/^\/api\/v1\//,""):null;
  }
  throw new Error("Collection fingerprint exists; awaiting its original verified event. Funding remains disabled.");
}

function signer(phase: "FUNDING" | "RECORDING") {
  if ((process.env.HEDERA_NETWORK ?? "testnet") !== "testnet") throw new Error("Only testnet is permitted");
  const accountId = phase === "FUNDING" ? process.env.HEDERA_TREASURY_ACCOUNT_ID : process.env.HEDERA_SERVICER_ACCOUNT_ID;
  const key = phase === "FUNDING" ? process.env.HEDERA_TREASURY_PRIVATE_KEY : process.env.HEDERA_SERVICER_PRIVATE_KEY;
  if (!accountId || !key) throw new Error(`Missing ${phase === "FUNDING" ? "treasury" : "dedicated servicer"} signer configuration`);
  if (accountId === (process.env.HEDERA_OPERATOR_ACCOUNT_ID ?? process.env.ACCOUNT_ID)) throw new Error("Collection signers must be separate from deployment administrator");
  const privateKey = safePrivateKey(key);
  const client = Client.forTestnet().setOperator(accountId, privateKey).setRequestTimeout(15_000).setMaxAttempts(2);
  return { accountId, privateKey, client };
}

export async function prepareCollectionTransaction(phase: "FUNDING" | "RECORDING", raw: CollectionCommand, input: RuntimePoolContext = legacyRuntimeContext) {
  await loadSignerSecretFiles(phase === "FUNDING" ? ["HEDERA_TREASURY_PRIVATE_KEY", "HEDERA_SERVICER_PRIVATE_KEY"] : ["HEDERA_SERVICER_PRIVATE_KEY"]);
  await assertTestnetRpc();
  const context = parseRuntimeContext(input);
  await verifyRuntimeEntityIds(context, mirror);
  const evidence = contextBindings(context);
  const registry = new Contract(context.registryAddress, artifact.abi, provider);
  const built = buildPool(context.records);
  const { sourceSystem: _source, poolId, ...body } = raw;
  const command = validateCollectionCommand(poolId, body);
  if (command.poolId !== evidence.pool.poolId) throw new Error("Pool is not in the configured testnet deployment");
  const identity = collectionCommandIdentity(command);
  const unit = built.accepted.find((entry) => entry.fuId === command.fuId);
  if (!unit) throw new Error("Receivable is absent from committed manifest");
  // Funding is allowed only after the later recording signer and live state pass.
  const servicer=signer("RECORDING");
  servicer.client.close();
  const actor=await mirror(`accounts/${servicer.accountId}`);
  verifyNativeSignerAccount(actor,servicer.accountId,servicer.privateKey);
  const actorAddress=actor?.evm_address??`0x${AccountId.fromString(servicer.accountId).toEvmAddress()}`;
  const [hasRole,pool,collected,existingPayload,receivableState]=await Promise.all([
    registry.getFunction("hasRole")(id("receivablex.role.servicer"),actorAddress),
    registry.getFunction("getPool")(command.poolId),
    registry.getFunction("collectedByReceivable")(command.poolId,id(command.fuId)),
    registry.getFunction("collectionPayloadHash")(identity.sourceEventId),
    registry.getFunction("receivableStatus")(command.poolId,id(command.fuId)),
  ]);
  if(!hasRole)throw new Error("Configured signer lacks SERVICER_ROLE; no funding submitted");
  if([4,5].includes(Number(receivableState)))throw new Error("Paid or written-off receivables cannot receive ordinary collection funding");
  if(![1,2,3].includes(Number(pool.status))||pool.poolRoot!==built.poolRoot||pool.eligibilityRoot!==built.eligibilityRoot||pool.manifestHash!==built.manifestHash)throw new Error("Live pool is not ready for collection");
  if(String(pool.payoutContract).toLowerCase()!==context.payoutAddress.toLowerCase()||String(pool.paymentToken).toLowerCase()!==context.paymentTokenAddress.toLowerCase()||String(pool.atsSecurity).toLowerCase()!==context.securityAddress.toLowerCase())throw new Error("Collection custody bindings do not match the live pool");
  const custody = await mirror(`contracts/${context.payoutId}`);
  if(custody?.deleted||custody?.evm_address?.toLowerCase()!==context.payoutAddress.toLowerCase())throw new Error("Collection recipient ID does not match the verified payout adapter");
  if(BigInt(command.amountMinorUnits)>unit.faceValue-BigInt(collected))throw new Error("Collection exceeds live receivable outstanding");
  if(existingPayload!==`0x${"0".repeat(64)}`)throw new Error("Collection already exists on chain; reconcile before funding or signing");
  const { accountId, privateKey, client } = signer(phase);
  try {
    verifyNativeSignerAccount(await mirror(`accounts/${accountId}`),accountId,privateKey);
    let transaction: Transaction;
    if (phase === "FUNDING") {
      transaction = new TransferTransaction().addTokenTransfer(evidence.inrx.tokenId, accountId, Long.fromString(`-${command.amountMinorUnits}`)).addTokenTransfer(evidence.inrx.tokenId, evidence.payoutAdapter.contractId, Long.fromString(command.amountMinorUnits));
    } else {
      const actor = await mirror(`accounts/${accountId}`);
      const address = actor?.evm_address ?? `0x${AccountId.fromString(accountId).toEvmAddress()}`;
      if (!await registry.getFunction("hasRole")(id("receivablex.role.servicer"), address)) throw new Error("Configured signer lacks SERVICER_ROLE");
      const leaf = { schemaVersion: 1, fuIdHash: id(unit.fuId), obligorIdHash: id(unit.obligorId), faceValue: unit.faceValue, dueDate: unit.dueDate, currency: "0x494e52", acceptedAt: unit.acceptedAt, evidenceHash: unit.evidenceHash };
      const proof = merkleProof(built.accepted.map(factoringUnitLeaf), factoringUnitLeaf(unit));
      const data = new Interface(artifact.abi).encodeFunctionData("recordCollection", [command.poolId, identity.sourceEventId, identity.payloadHash, command.amountMinorUnits, leaf, proof]);
      transaction = new ContractExecuteTransaction().setContractId(evidence.registry.contractId).setGas(1_500_000).setFunctionParameters(getBytes(data));
    }
    transaction.setTransactionId(TransactionId.generate(AccountId.fromString(accountId))).setTransactionValidDuration(120).setMaxTransactionFee(new Hbar(5)).setNodeAccountIds([AccountId.fromString("0.0.3")]).freezeWith(client);
    await transaction.sign(privateKey);
    return { transactionId: transaction.transactionId!.toString(), transactionHash: Buffer.from(await transaction.getTransactionHash()).toString("hex"), signedBytes: Buffer.from(transaction.toBytes()), validUntil: new Date(Number(transaction.transactionId!.validStart!.seconds.toString()) * 1000 + 120_000) };
  } finally { client.close(); }
}

/** Executes previously persisted bytes only. Never re-sign a submission of uncertain outcome. */
export function createNativeSubmitter(execute: (transaction: Transaction, client: Client) => Promise<unknown> = (transaction, client) => transaction.execute(client)) {
  return async (bytes: Uint8Array): Promise<void> => {
    let transaction: Transaction;
    try {
      transaction = Transaction.fromBytes(bytes);
      // This public getter locks the decoded transaction IDs in the SDK. Do
      // not call setRegenerateTransactionId on a frozen transaction: it throws.
      if (!transaction.transactionId) throw new Error("missing identity");
      const signatures = transaction.getSignatures().getFlatSignatureList();
      if (!signatures.length || signatures.some(signature => signature.size === 0)) throw new Error("unsigned envelope");
      transaction.setMaxAttempts(1);
      if (!Buffer.from(transaction.toBytes()).equals(Buffer.from(bytes))) throw new Error("bytes changed during restoration");
    } catch { throw new Error("Persisted native transaction is invalid, unsigned or not byte-preserving"); }
    // No operator or signer exists on this client, so execute cannot add a
    // signature. ID locking and the client default both prohibit regeneration.
    const client = Client.forTestnet().setRequestTimeout(15_000).setMaxAttempts(1).setDefaultRegenerateTransactionId(false);
    try { await execute(transaction, client); } finally { client.close(); }
  };
}
const submitPersistedNative = createNativeSubmitter();
export async function submitSignedTransaction(bytes: Uint8Array) { await submitPersistedNative(bytes); }

export interface ChainProjection {
  pool: any; receivables: any[]; distribution: any; holders: any[]; events: any[];
  built: ReturnType<typeof buildPool>; asOf: string;
  context?: RuntimePoolContext;
  distributionRecords?: { id: string; value: any; recordDate: string }[];
  servicingVersion?: number; distributionVersion?: number; lifecycleVersion?: number;
  exceptionsVersion?: number; totalPrincipalWrittenDown?: string;
  pendingDistributions?: string; totalSupply?: string; maturity?: string;
}

async function contractLogs(contractId: string, address: string, blockTag: number, timestamp: number) {
  const logs: any[] = [];
  let next: string | null = `contracts/${contractId}/results/logs?order=asc&limit=100&timestamp=lte:${timestamp}.999999999`;
  for (let page = 0; next; page++) {
    if (page >= 100) throw new Error("Event pagination limit exceeded; projection not committed");
    const result = await mirror(next);
    for (const log of result?.logs ?? []) {
      if (String(log.address).toLowerCase() !== address.toLowerCase()) continue;
      const height = Number(log.block_number);
      if (!Number.isSafeInteger(height)) throw new Error("Event has no verifiable block number");
      if (height <= blockTag) logs.push(log);
    }
    next = result?.links?.next ? String(result.links.next).replace(/^\/api\/v1\//, "") : null;
  }
  const hashes = [...new Set<string>(logs.map(log => String(log.transaction_hash)))];
  const outcomes = new Map<string, boolean>();
  for (let offset = 0; offset < hashes.length; offset += 20) {
    await Promise.all(hashes.slice(offset, offset + 20).map(async hash => { outcomes.set(hash, await successfulContractReceipt(hash)); }));
  }
  return logs.filter(log => outcomes.get(String(log.transaction_hash)) === true);
}

export async function readChainProjection(expected?: { sourceEventId: string; payloadHash: string; kind?: "servicing" }, input: RuntimePoolContext = legacyRuntimeContext): Promise<ChainProjection> {
  await assertTestnetRpc();
  const context = parseRuntimeContext(input);
  const built = buildPool(context.records);
  const registry = new Contract(context.registryAddress, artifact.abi, provider);
  const blockTag = await provider.getBlockNumber();
  const block = await provider.getBlock(blockTag);
  if (!block) throw new Error("Chain block unavailable");
  const pool = await registry.getFunction("getPool")(context.poolId, { blockTag });
  if (BigInt(pool.originalFaceValue) !== built.faceValue) throw new Error("Committed receivable aggregate does not match Registry face value");
  if (pool.poolRoot !== built.poolRoot || pool.eligibilityRoot !== built.eligibilityRoot || pool.manifestHash !== built.manifestHash) throw new Error("Committed manifest does not match deployed Registry");
  if (String(pool.atsSecurity).toLowerCase() !== context.securityAddress.toLowerCase() || String(pool.payoutContract).toLowerCase() !== context.payoutAddress.toLowerCase() || String(pool.paymentToken).toLowerCase() !== context.paymentTokenAddress.toLowerCase()) throw new Error("Runtime custody bindings do not match Registry");
  if (expected && await registry.getFunction(expected.kind === "servicing" ? "servicingPayloadHash" : "collectionPayloadHash")(expected.sourceEventId, { blockTag }) !== expected.payloadHash) throw new Error("Confirmed event is not yet visible in projection RPC");
  const capability = async (method: string, enabled: boolean) => {
    if (!enabled) return 0;
    try { return Number(await registry.getFunction(method)({ blockTag })); } catch { return 0; }
  };
  const [servicingVersion, distributionVersion, lifecycleVersion, exceptionsVersion] = await Promise.all([
    capability("servicingVersion", true),
    capability("distributionVersion", true),
    capability("lifecycleVersion", true),
    capability("exceptionsVersion", true),
  ]);
  const totalPrincipalWrittenDown = exceptionsVersion ? String(await registry.getFunction("totalPrincipalWrittenDown")(context.poolId, { blockTag })) : "0";
  const security = new Contract(context.securityAddress, ATS_ASSET_ABI, provider);
  const payment = new Contract(context.paymentTokenAddress, ["function balanceOf(address) view returns(uint256)"], provider);
  const totalSupply = String(await security.getFunction("totalSupply")({ blockTag }));
  const pendingDistributions = lifecycleVersion ? String(await registry.getFunction("pendingDistributions")(context.poolId, { blockTag })) : "0";
  const receivables: any[] = [];
  for (let offset = 0; offset < built.accepted.length; offset += 20) {
    receivables.push(...await Promise.all(built.accepted.slice(offset, offset + 20).map(async unit => {
      const [collected, status, estimate, writtenOff] = await Promise.all([
        registry.getFunction("collectedByReceivable")(context.poolId, id(unit.fuId), { blockTag }),
        registry.getFunction("receivableStatus")(context.poolId, id(unit.fuId), { blockTag }),
        registry.getFunction("estimatedRecoveryByReceivable")(context.poolId, id(unit.fuId), { blockTag }),
        exceptionsVersion ? registry.getFunction("writtenOffByReceivable")(context.poolId, id(unit.fuId), { blockTag }) : Promise.resolve(0n),
      ]);
      return { unit, leafHash: factoringUnitLeaf(unit), fuIdHash: id(unit.fuId), estimatedRecovery: String(estimate),
        writtenOff: String(writtenOff), outstanding: String(unit.faceValue - BigInt(collected) - BigInt(writtenOff)),
        status: ["PERFORMING", "PERFORMING", "DELINQUENT", "DEFAULTED", "WRITTEN_OFF", "PAID"][Number(status)] };
    })));
  }
  const abi = new Interface(artifact.abi);
  const decoded: any[] = [];
  for (const log of await contractLogs(context.registryId, context.registryAddress, blockTag, block.timestamp)) {
    try {
      const parsed = abi.parseLog({ topics: log.topics, data: log.data });
      if (parsed) decoded.push({ key: context.poolId === legacyRuntimeContext.poolId ? `${log.timestamp}:${log.index}` : `${context.registryId}:${log.timestamp}:${log.index}`, type: parsed.name,
        transactionId: log.transaction_hash, consensusTimestamp: log.timestamp,
        payload: Object.fromEntries(parsed.fragment.inputs.map((field, index) => [field.name, String(parsed.args[index])])) });
    } catch { /* Ignore unrelated ABI events; never reinterpret them as pool actions. */ }
  }
  const distributionIds = [...new Set<string>(decoded.filter(event => event.type === "DistributionApproved" && event.payload.poolId === context.poolId).map(event => event.payload.distributionId))];
  const events = decoded.filter(event => event.payload.poolId === context.poolId || distributionIds.includes(event.payload.distributionId));
  for (const event of events.filter(event => event.type === "CollectionRecorded")) event.payload.canonicalPayloadHash = String(await registry.getFunction("collectionPayloadHash")(event.payload.sourceEventId, { blockTag }));
  const snapshotDates = new Map<string, string>();
  if (distributionIds.length) {
    const assetAbi = new Interface(ATS_ASSET_ABI);
    for (const log of await contractLogs(context.securityId, context.securityAddress, blockTag, block.timestamp)) {
      let parsed; try { parsed = assetAbi.parseLog({ topics: log.topics, data: log.data }); } catch { continue; }
      if (parsed?.name === "SnapshotTaken") {
        snapshotDates.set(String(parsed.args.snapshotID), String(log.timestamp));
        events.push({ key: `${context.securityId}:${log.timestamp}:${log.index}`, type: "SnapshotTaken", transactionId: log.transaction_hash,
          consensusTimestamp: log.timestamp, payload: { poolId: context.poolId, snapshotId: String(parsed.args.snapshotID) } });
      }
    }
  }
  const distributionRecords: { id: string; value: any; recordDate: string }[] = [];
  for (const distributionId of distributionIds) {
    const value = await registry.getFunction("getDistribution")(distributionId, { blockTag });
    const timestamp = snapshotDates.get(String(value.snapshotId));
    if (!timestamp || !/^\d+\.\d+$/.test(timestamp)) throw new Error("ATS record-date evidence is unavailable; projection retained");
    distributionRecords.push({ id: distributionId, value, recordDate: new Date(Number(timestamp) * 1000).toISOString() });
  }
  // Preserve the old singular return value for script/test callers; new projection uses all records.
  const distribution = distributionRecords.find(record => record.id === historicalEvidence.distribution.distributionId)?.value ?? distributionRecords.at(-1)?.value ?? null;
  const count = Number(await security.getFunction("getTotalSecurityHolders")({ blockTag }));
  if (!Number.isSafeInteger(count) || count < 0 || count > 1000) throw new Error("Holder enumeration exceeds supported bound");
  const addresses = new Set<string>(events.filter(event => ["HolderPaid", "HolderNoPaymentDue"].includes(event.type)).map(event => String(event.payload.holder).toLowerCase()));
  for (let start = 0; start < count; start += 100) {
    for (const holder of await security.getFunction("getSecurityHolders")(start / 100, 100, { blockTag })) addresses.add(String(holder).toLowerCase());
  }
  const holders: any[] = [];
  const ordered = [...addresses].sort();
  for (let offset = 0; offset < ordered.length; offset += 20) {
    holders.push(...await Promise.all(ordered.slice(offset, offset + 20).map(async address => ({
      address, units: String(await security.getFunction("balanceOf")(address, { blockTag })),
      snapshotUnits: distribution ? String(await security.getFunction("balanceOfAtSnapshot")(distribution.snapshotId, address, { blockTag })) : "0",
      paymentBalance: String(await payment.getFunction("balanceOf")(address, { blockTag })),
    }))));
  }
  for (const event of events.filter(event => ["HolderPaid", "HolderNoPaymentDue"].includes(event.type))) {
    const record = distributionRecords.find(item => item.id === event.payload.distributionId);
    if (!record) throw new Error("Payout references unknown distribution");
    event.payload.snapshotUnits = String(await security.getFunction("balanceOfAtSnapshot")(record.value.snapshotId, event.payload.holder, { blockTag }));
  }
  return { context, pool, built, receivables, distribution, distributionRecords, events, holders,
    asOf: new Date(block.timestamp * 1000).toISOString(), servicingVersion, distributionVersion, lifecycleVersion, exceptionsVersion, totalPrincipalWrittenDown, pendingDistributions, totalSupply, maturity: String(pool.maturity) };
}
