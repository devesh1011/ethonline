import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AccountId, Client, ContractExecuteTransaction, ContractId, Hbar, PrivateKey, TokenAssociateTransaction, Transaction, TransactionId } from "@hiero-ledger/sdk";
import { Contract, FetchRequest, Interface, JsonRpcProvider } from "ethers";
import { ATS_ASSET_ABI, DEFAULT_PARTITION, createAtsAdapter } from "@receivablex/hedera-ats";
import { distributionPreview, sanitizeError } from "@receivablex/domain";
import { acceptanceApi, AcceptanceRunner, runRoleKey, type AcceptanceManifest, type Role } from "./run-acceptance.js";
import { SetupStore, signedArtifactHash, validRunId, type SetupPlan, type SetupSigned } from "./setup-checkpoints.js";
import { restoreSignedSetupNative } from "./setup-native.js";
import { verifyNativeSignerAccount } from "../src/hedera-native/src/runtime-context.js";

type Json = Record<string, any>;
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const assetAbi = new Interface(ATS_ASSET_ABI);
const paymentAbi = new Interface(["function executeDistributionBatch(bytes32,(address holder,uint256 snapshotBalance,uint256 cashAmount,uint256 principalAmount,uint256 incomeAmount)[],bytes32[][])", "function finalizeDistribution(bytes32)", "event DistributionFinalized(bytes32 indexed distributionId,uint256 roundingDust,uint256 principalRemainder)", "event HolderPaid(bytes32 indexed distributionId,address indexed holder,uint256 cash,uint256 principal,uint256 income)", "event Transfer(address indexed from,address indexed to,uint256 value)"]);
export interface ProbeReceipt { hash: string; to: string | null; status: number | null; data: string; logs: readonly { address: string; topics: readonly string[]; data: string }[] }
export function verifyProbeReceipt(value: ProbeReceipt | null, hash: string, status: 0 | 1, registry: string, payout: string, token: string, distributionId: string, recipient: Json) {
  check(value && value.hash.toLowerCase() === hash.toLowerCase() && value.to?.toLowerCase() === registry.toLowerCase() && value.status === status, "Original payout receipt identity/target/outcome is not confirmed");
  const call = paymentAbi.parseTransaction({ data: value.data });
  check(call?.name === "executeDistributionBatch" && call.args[0].toLowerCase() === distributionId.toLowerCase() && call.args[1].length === 1 && call.args[2].length === 1, "Receipt is not the original single-holder distribution call");
  const entry = call.args[1][0];
  check(entry.holder.toLowerCase() === recipient.holder.toLowerCase() && ["snapshotBalance", "cashAmount", "principalAmount", "incomeAmount"].every(field => entry[field].toString() === recipient[field]) && JSON.stringify([...call.args[2][0]].map((proof: string) => proof.toLowerCase())) === JSON.stringify(recipient.proof.map((proof: string) => proof.toLowerCase())), "Payout changed the immutable entitlement or proof");
  if (status === 0) return value;
  const paid = value.logs.filter(log => log.address.toLowerCase() === registry.toLowerCase()).flatMap(log => { try { const event = paymentAbi.parseLog({ topics: [...log.topics], data: log.data }); return event?.name === "HolderPaid" ? [event] : []; } catch { return []; } });
  const transfers = value.logs.filter(log => log.address.toLowerCase() === token.toLowerCase()).flatMap(log => { try { const event = paymentAbi.parseLog({ topics: [...log.topics], data: log.data }); return event?.name === "Transfer" && event.args.from.toLowerCase() === payout.toLowerCase() ? [event] : []; } catch { return []; } });
  check(paid.length === 1 && paid[0]!.args.distributionId.toLowerCase() === distributionId.toLowerCase() && paid[0]!.args.holder.toLowerCase() === recipient.holder.toLowerCase() && paid[0]!.args.cash.toString() === recipient.cashAmount && paid[0]!.args.principal.toString() === recipient.principalAmount && paid[0]!.args.income.toString() === recipient.incomeAmount, "Registry payment event does not prove the exact components");
  check(transfers.length === 1 && transfers[0]!.args.to.toLowerCase() === recipient.holder.toLowerCase() && transfers[0]!.args.value.toString() === recipient.cashAmount, "HTS transfer does not prove the exact holder cash");
  return value;
}
export function verifyProbeFinalization(value: ProbeReceipt | null, hash: string, registry: string, distributionId: string) {
  check(value && value.hash.toLowerCase() === hash.toLowerCase() && value.to?.toLowerCase() === registry.toLowerCase() && value.status === 1, "Finalization receipt identity/target/outcome is not confirmed");
  const call = paymentAbi.parseTransaction({ data: value.data });
  const events = value.logs.filter(log => log.address.toLowerCase() === registry.toLowerCase()).flatMap(log => { try { const event = paymentAbi.parseLog({ topics: [...log.topics], data: log.data }); return event?.name === "DistributionFinalized" ? [event] : []; } catch { return []; } });
  check(call?.name === "finalizeDistribution" && call.args[0].toLowerCase() === distributionId.toLowerCase() && events.length === 1 && events[0]!.args.distributionId.toLowerCase() === distributionId.toLowerCase() && events[0]!.args.roundingDust === 0n && events[0]!.args.principalRemainder === 0n, "Finalization does not prove exact zero-residual completion");
  return value;
}
export function validateProbeNative(prepared: Json, kind: "transfer" | "associate", m: AcceptanceManifest, securityId: string): Transaction {
  const role = kind === "transfer" ? "test-investor-a" : "test-investor-probe", actor = m.actors[role], transaction = Transaction.fromBytes(Buffer.from(prepared.unsignedBytes, "base64"));
  check(prepared.kind === kind && prepared.role === role && transaction.transactionId?.toString() === prepared.transactionId && transaction.transactionId?.accountId?.toString() === actor.accountId && transaction.transactionValidDuration === 120 && Date.parse(prepared.validUntil) === Number(transaction.transactionId.validStart!.seconds.toString()) * 1000 + 120000 && transaction.nodeAccountIds?.length === 1 && transaction.nodeAccountIds[0]?.toString() === "0.0.3" && BigInt(transaction.maxTransactionFee?.toTinybars().toString() ?? "-1") > 0n && BigInt(transaction.maxTransactionFee!.toTinybars().toString()) <= 500000000n, "Prepared native probe identity, validity or fee changed");
  if (kind === "transfer") {
    const expected = assetAbi.encodeFunctionData("transferByPartition", [DEFAULT_PARTITION, { to: m.actors["test-investor-probe"].address, value: 1n }, "0x"]);
    check(transaction instanceof ContractExecuteTransaction && transaction.contractId?.toString() === securityId && transaction.gas?.toString() === "1200000" && transaction.payableAmount?.toTinybars().toString() === "0" && Buffer.from(transaction.functionParameters ?? []).toString("hex") === expected.slice(2), "Only the exact one-unit probe transfer may be signed");
  } else check(transaction instanceof TokenAssociateTransaction && transaction.accountId?.toString() === actor.accountId && transaction.tokenIds?.length === 1 && transaction.tokenIds[0]?.toString() === m.expected.tokenId, "Only the probe's exact settlement-token association may be signed");
  check(transaction.getSignatures().getFlatSignatureList().every(signatures => signatures.size === 0), "Prepared probe envelope must not contain unreviewed signatures");
  return transaction;
}
export const payoutProbePlan = {
  status: "NOT_RUN", network: "Hedera testnet 296", phase: "V3_PAYOUT_PROBE", networkWrites: false,
  economics: { transferUnits: "1", snapshotSupply: "1000", collectionMinorUnits: "901", expectedCash: { investorA: "540", investorB: "315", originator: "45", probe: "1" }, roundingPolicy: "LARGEST_REMAINDER_V1", roundingDust: "0" },
  steps: ["Require this run's completed activation, Registry v3, exact adapter, and generated probe with no settlement-token association", "Grant real signed sandbox attestation through compliance API; A transfers one ATS unit to probe", "Persist and submit a 901-minor collection through servicer API; request snapshot and verify exact four-holder preview", "Trustee approves; preserve actual probe preflight rejection OR failed consensus receipt while three other recipients are paid", "Probe signs its own settlement-token association; trustee retries the original immutable entitlement; worker finalizes", "Verify original and retry attempts, exact unchanged preview, all four payments and zero reservation; duplicate API retry must reject"],
  safety: "Production simulation is never bypassed. PRECHECK_BLOCKED is operational recovery evidence, not native consensus-failure evidence. Generated actors are not user wallet approval. Existing security acknowledgement remains unchanged.",
  command: "npx tsx scripts/payout-failure-acceptance.ts --run-id RUN --execute --acknowledge-testnet-writes",
};
export function payoutProbeArguments(args: string[]) {
  const result = { runId: "", execute: false, acknowledge: false };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!; check(!seen.has(flag), "Duplicate payout probe option"); seen.add(flag);
    if (flag === "--plan") continue;
    if (flag === "--execute") result.execute = true;
    else if (flag === "--acknowledge-testnet-writes") result.acknowledge = true;
    else if (flag === "--run-id") result.runId = validRunId(args[++i] ?? "");
    else throw new Error("Unknown payout probe option");
  }
  check(!(seen.has("--plan") && result.execute), "Choose plan or execute, never both");
  if (result.execute) check(result.runId && result.acknowledge, "Execution requires run ID and explicit testnet-write acknowledgement");
  return result;
}
export function validateProbePreview(preview: Json, manifest: AcceptanceManifest) {
  const balances = [["test-investor-a", 599n], ["test-investor-b", 350n], ["originator", 50n], ["test-investor-probe", 1n]] as const;
  const expected = distributionPreview(BigInt(preview.snapshotId), { snapshotSupply: 1000n, principalBudget: 901n, incomeBudget: 0n, holders: balances.map(([role, balance]) => ({ address: manifest.actors[role].address as `0x${string}`, balance })) }, preview.recordDate ?? undefined);
  check(preview.roundingPolicy === "LARGEST_REMAINDER_V1" && preview.previewHash === expected.previewHash && preview.entitlementRoot === expected.entitlementRoot && preview.roundingDust === "0" && preview.immutablePayoutTotal === "901", "Snapshot does not match the immutable four-holder exact allocation");
  return expected;
}
export function probeFailure(attempts: Json[], holder: string) {
  const first = attempts.find(row => row.holder.toLowerCase() === holder.toLowerCase() && row.attempt === 1);
  check(first?.state === "FAILED", "Probe has no definitive failed first attempt");
  if (first.failureCode === "CONSENSUS_REVERT" && /^0x[0-9a-fA-F]{64}$/.test(first.transactionId ?? "")) return "CONSENSUS_FAILED";
  check(!first.transactionId && ["PAYOUT_PREFLIGHT_REVERT", "RECIPIENT_INELIGIBLE"].includes(first.failureCode), "Unknown or unverified outcomes cannot be classified as payout failures");
  return "PRECHECK_BLOCKED";
}

/** Only two allowlisted generated-actor mutations exist: ATS transfer(1), probe association. */
export class ProbeNative {
  constructor(readonly store: SetupStore, readonly manifest: AcceptanceManifest, readonly provider: JsonRpcProvider, readonly mirror: string, readonly securityId: string, readonly securityAddress: string, readonly broadcast: (signed: SetupSigned) => Promise<void> = async signed => {
    const client = Client.forTestnet().setMaxAttempts(1).setRequestTimeout(15000).setDefaultRegenerateTransactionId(false);
    try { await restoreSignedSetupNative(signed).execute(client); } finally { client.close(); }
  }) {}
  async mirrorRead(path: string) {
    const response = await fetch(`${this.mirror.replace(/\/$/, "")}/${path}`, { signal: AbortSignal.timeout(15000) });
    if (response.status === 404) return null;
    check(response.ok, "Mirror request failed; resume original identities"); return response.json();
  }
  async associated() {
    const value = await this.mirrorRead(`accounts/${this.manifest.actors["test-investor-probe"].accountId}/tokens?token.id=${this.manifest.expected.tokenId}`);
    check(value && Array.isArray(value.tokens), "Probe association state unavailable");
    return value.tokens.some((token: Json) => token.token_id === this.manifest.expected.tokenId);
  }
  async mutate(kind: "transfer" | "associate") {
    const role = kind === "transfer" ? "test-investor-a" : "test-investor-probe", actor = this.manifest.actors[role];
    const name = `acceptance-payout-probe-${kind}`, complete = await this.store.maybe<Json>(`${name}.receipt.json`);
    if (complete) { check(complete.result === "SUCCESS", "Original native actor transaction failed; no replacement is authorized"); return complete; }
    check(BigInt(await this.provider.send("eth_chainId", [])) === 296n, "Payout probe requires testnet 296");
    let prepared = await this.store.maybe<Json>(`${name}.prepared.json`);
    if (!prepared) {
      let transaction: Transaction;
      if (kind === "transfer") {
        const ats = createAtsAdapter(this.provider, { mirrorUrl: this.mirror });
        const security = await ats.resolveSecurity(this.securityId); check(security.address.toLowerCase() === this.securityAddress.toLowerCase(), "Security numeric identity mismatch");
        const call = await ats.prepareTransfer(this.securityAddress, actor.address, this.manifest.actors["test-investor-probe"].address, 1n);
        transaction = new ContractExecuteTransaction().setContractId(ContractId.fromString(this.securityId)).setGas(1200000).setFunctionParameters(Buffer.from(call.transaction.data.slice(2), "hex"));
      } else transaction = new TokenAssociateTransaction().setAccountId(actor.accountId).setTokenIds([this.manifest.expected.tokenId]);
      transaction.setTransactionId(TransactionId.generate(AccountId.fromString(actor.accountId))).setNodeAccountIds([AccountId.fromString("0.0.3")]).setTransactionValidDuration(120).setMaxTransactionFee(new Hbar(5)).setRegenerateTransactionId(false).setMaxAttempts(1).freeze();
      prepared = { kind, role, transactionId: transaction.transactionId!.toString(), unsignedBytes: Buffer.from(transaction.toBytes()).toString("base64"), validUntil: new Date(Number(transaction.transactionId!.validStart!.seconds.toString()) * 1000 + 120000).toISOString() };
      await this.store.put(`${name}.prepared.json`, prepared);
    }
    const unsigned = validateProbeNative(prepared, kind, this.manifest, this.securityId);
    let signed = await this.store.maybe<SetupSigned>(`${name}.signed.json`);
    if (!signed) {
      check(Date.parse(prepared.validUntil) > Date.now(), "Unsigned actor intent expired; explicit reconciliation required");
      const raw = await runRoleKey(this.store, this.manifest, role), key = PrivateKey.fromStringECDSA(raw.privateKey);
      verifyNativeSignerAccount(await this.mirrorRead(`accounts/${actor.accountId}`), actor.accountId, key);
      await unsigned.sign(key); const bytes = unsigned.toBytes();
      signed = { transactionId: prepared.transactionId, signedBytes: Buffer.from(bytes).toString("base64"), bytesHash: signedArtifactHash(bytes) };
      await this.store.put(`${name}.signed.json`, signed);
    }
    check(signed.transactionId === prepared.transactionId && signed.bytesHash === signedArtifactHash(Buffer.from(signed.signedBytes, "base64")), "Persisted native probe signed bytes changed");
    const read = async () => {
      const reference = signed!.transactionId.replace("@", "-").replace(/\.(\d+)$/, "-$1");
      const value = await this.mirrorRead(`transactions/${reference}`);
      const rows = (value?.transactions ?? []).filter((item: Json) => item.transaction_id === reference && Number(item.nonce ?? 0) === 0 && item.scheduled !== true && item.result !== "DUPLICATE_TRANSACTION");
      return rows.length === 1 ? rows[0] : undefined;
    };
    let receipt = await read();
    if (!receipt && Date.parse(prepared.validUntil) > Date.now()) {
      if (!await this.store.maybe(`${name}.broadcast-intent.json`)) await this.store.put(`${name}.broadcast-intent.json`, { transactionId: signed.transactionId, bytesHash: signed.bytesHash });
      try { await this.broadcast(signed); } catch { /* Reconcile the original identity, never replace. */ }
      receipt = await read();
    }
    check(receipt, "Original native actor transaction is pending; resume same command without a new identity");
    check(typeof receipt.result === "string" && Number.isSafeInteger(Number(receipt.charged_tx_fee)) && Number(receipt.charged_tx_fee) >= 0 && Number(receipt.charged_tx_fee) <= 500000000 && /^\d+\.\d+$/.test(String(receipt.consensus_timestamp)), "Original native receipt is incomplete or exceeds its fee cap");
    const recorded = { transactionId: signed.transactionId, result: receipt.result, consensusTimestamp: receipt.consensus_timestamp, chargedTxFee: receipt.charged_tx_fee };
    await this.store.put(`${name}.receipt.json`, recorded);
    check(receipt.result === "SUCCESS", "Original native actor transaction failed; no replacement is authorized"); return recorded;
  }
}

export async function runPayoutProbe(runner: AcceptanceRunner, native: Pick<ProbeNative, "associated" | "mutate">, receipt: (hash: string) => Promise<ProbeReceipt | null>) {
  const { store, manifest: m, api } = runner, active = await store.get<Json>("acceptance-active.json"), probe = m.actors["test-investor-probe"].address.toLowerCase();
  check(active.status === "ACTIVE" && active.runId === m.runId, "This run is not activated");
  const getWorkspace = () => api.get("trustee", "/api/workspace");
  let workspace = await getWorkspace();
  check(workspace.pool?.id === active.poolId && workspace.pool.registryAddress?.toLowerCase() === m.expected.registryAddress.toLowerCase() && workspace.stale === false, "Fresh run pool projection is required");
  const command = (name: string, role: Role, path: string, body: Json) => runner.command(`payout-probe-${name}`, role, path, body);
  if (!await store.maybe("acceptance-payout-probe-initial.json")) {
    check(!await native.associated(), "Probe is already settlement-token associated; unassociated-recipient condition does not exist");
    check(workspace.pool.availableCashMinorUnits === "0" && workspace.pool.reservedCashMinorUnits === "0", "Probe phase requires an isolated pool with zero initial cash/reservations");
    check(workspace.holders?.length === 3 && [["test-investor-a", "600"], ["test-investor-b", "350"], ["originator", "50"]].every(([role, units]) => workspace.holders.some((holder: Json) => holder.address.toLowerCase() === m.actors[role as Role].address.toLowerCase() && holder.units === units)), "Initial holdings differ from reviewed financing; do not transfer probe units");
    await store.put("acceptance-payout-probe-initial.json", { poolId: active.poolId, unassociated: true, at: new Date().toISOString() });
  }
  const credentialJson = JSON.stringify(await store.get("attestation-test-investor-probe.json"));
  const kyc = await command("kyc", "compliance", `/api/issuances/${active.issuanceId}/compliance`, { kind: "GRANT_KYC", holder: probe, credentialJson });
  await runner.until("Probe eligibility", () => api.get("compliance", `/api/operations/${kyc.operationId}`), value => value.state === "RECONCILED");
  await native.mutate("transfer");
  workspace = await runner.until("Four-holder projection", getWorkspace, value => value.holders?.length === 4 && value.holders.some((holder: Json) => holder.address.toLowerCase() === probe && holder.units === "1"));
  const collectionIntent = await store.maybe<Json>("acceptance-payout-probe-collection.intent.json");
  const collection = await command("collection", "servicer", `/api/pools/${active.poolId}/collections`, collectionIntent?.body ?? { fuId: m.source.rows[0].fuId, amountMinorUnits: "901", settlementReference: `${m.runId}:payout-probe:901`, settledAt: new Date().toISOString(), expectedStateVersion: workspace.pool.stateVersion });
  await runner.until("Probe collection", () => api.get("servicer", `/api/operations/${collection.operationId}`), value => value.state === "RECONCILED");
  const snapshotIntent = await store.maybe<Json>("acceptance-payout-probe-snapshot.intent.json");
  if (!snapshotIntent) workspace = await runner.until("Collected cash projection", getWorkspace, value => value.pool?.availableCashMinorUnits === "901");
  const opened = await command("snapshot", "trustee", `/api/pools/${active.poolId}/distributions`, snapshotIntent?.body ?? { amountMinorUnits: "901", expectedStateVersion: workspace.pool.stateVersion });
  const read = () => api.get("trustee", `/api/distributions/${opened.distributionId}`);
  let view = await runner.until("Probe snapshot", read, value => !!value.preview);
  const preview = validateProbePreview(view.preview, m);
  await command("approve", "trustee", `/api/distributions/${opened.distributionId}/approve`, { previewHash: preview.previewHash });
  let failure = await store.maybe<Json>("acceptance-payout-probe-failure.json");
  if (!failure) {
    view = await runner.until("Initial recipient outcomes", read, value => { check(value.state !== "FINALIZED", "Probe was paid without rejection; no failure evidence or remediation is claimed"); return value.state === "BLOCKED" && value.results?.filter((row: Json) => row.state === "SUCCESS").length === 3; });
    const attempts = await api.get("trustee", `/api/distributions/${opened.distributionId}/attempts`) as unknown as Json[];
    const condition = probeFailure(attempts, probe);
    let failedReceipt: ProbeReceipt | undefined;
    if (condition === "CONSENSUS_FAILED") { const hash = attempts.find(row => row.holder.toLowerCase() === probe && row.attempt === 1)!.transactionId; failedReceipt = verifyProbeReceipt(await receipt(hash), hash, 0, m.expected.registryAddress, workspace.pool.payoutAddress, m.expected.tokenAddress, opened.distributionId, preview.recipients.find(row => row.holder === probe)!); }
    failure = { condition, distributionId: opened.distributionId, preview, attempts, failedReceipt, observedAt: new Date().toISOString() };
    await store.put("acceptance-payout-probe-failure.json", failure);
  }
  check(failure.distributionId === opened.distributionId && failure.preview.previewHash === preview.previewHash, "Original failure or entitlement changed");
  await native.mutate("associate"); check(await native.associated(), "Probe association has not yet indexed; resume same phase");
  const retry = await command("retry", "trustee", `/api/distributions/${opened.distributionId}/retry`, { previewHash: preview.previewHash, holders: [probe] });
  view = await runner.until("Probe retry/finalization", read, value => value.state === "FINALIZED");
  check(view.preview.previewHash === preview.previewHash && view.results.length === 4 && view.results.every((row: Json) => row.state === "SUCCESS"), "Final payments or immutable preview differ");
  const attempts = await api.get("trustee", `/api/distributions/${opened.distributionId}/attempts`) as unknown as Json[];
  check(attempts.length === 5 && attempts.filter(row => row.holder === probe).length === 2, "Expected one preserved failure and one retry, without duplicate payments");
  check(failure.attempts.every((before: Json) => { const after = attempts.find(row => row.holder === before.holder && row.attempt === before.attempt); return after && ["holder", "attempt", "state", "transactionId", "failureCode", "createdAt"].every(field => before[field] === after[field]); }), "Original payment attempt history changed");
  const successes = attempts.filter(row => row.state === "SUCCESS");
  check(successes.length === 4 && new Set(successes.map(row => row.holder.toLowerCase())).size === 4 && new Set(successes.map(row => row.transactionId?.toLowerCase())).size === 4 && preview.recipients.every(entry => successes.some(row => row.holder.toLowerCase() === entry.holder)), "Each committed holder requires one distinct successful payment");
  const verifiedReceipts: ProbeReceipt[] = [];
  for (const row of successes) verifiedReceipts.push(verifyProbeReceipt(await receipt(row.transactionId), row.transactionId, 1, m.expected.registryAddress, workspace.pool.payoutAddress, m.expected.tokenAddress, opened.distributionId, preview.recipients.find(entry => entry.holder === row.holder.toLowerCase())!));
  const completed = await runner.until("Finalized operation receipt", () => api.get("trustee", `/api/operations/${opened.operationId}`), value => value.state === "RECONCILED" && /^0x[0-9a-fA-F]{64}$/.test(value.transactionId ?? ""));
  const finalizationReceipt = verifyProbeFinalization(await receipt(completed.transactionId), completed.transactionId, m.expected.registryAddress, opened.distributionId);
  // A fresh idempotency key must reject paid holders; do not deliberately send a reverting chain transaction.
  let rejected = Boolean(await store.maybe("acceptance-payout-probe-paid-rejection.json"));
  if (!rejected) {
    try { await command("paid-rejection", "trustee", `/api/distributions/${opened.distributionId}/retry`, { previewHash: preview.previewHash, holders: [probe] }); }
    catch (error) { rejected = error instanceof Error && error.message.startsWith("API 409:"); }
    if (rejected) await store.put("acceptance-payout-probe-paid-rejection.json", { status: 409, distributionId: opened.distributionId, previewHash: preview.previewHash, holder: probe });
  }
  check(rejected, "Paid-holder duplicate API retry was not conclusively rejected");
  workspace = await runner.until("Final cash projection", getWorkspace, value => value.pool?.reservedCashMinorUnits === "0" && value.pool?.availableCashMinorUnits === "0");
  const result = { status: "RECOVERY_VERIFIED", runId: m.runId, condition: failure.condition, nativeConsensusFailureProven: failure.condition === "CONSENSUS_FAILED", securityAcknowledgement: m.securityAcknowledgement, distributionId: opened.distributionId, preview, retry, attempts, verifiedReceipts, finalizationReceipt, paidCashMinorUnits: "901", duplicateApiRejection: true, reservedCashMinorUnits: workspace.pool.reservedCashMinorUnits, generatedActorAcceptance: true };
  if (!await store.maybe("acceptance-payout-probe-complete.json")) await store.put("acceptance-payout-probe-complete.json", result);
  return result;
}

export async function payoutProbeMain(args: string[]) {
  const options = payoutProbeArguments(args); if (!options.execute) return payoutProbePlan;
  const store = await SetupStore.resume(fileURLToPath(new URL("../.local/runs/", import.meta.url)), options.runId), m = await store.get<AcceptanceManifest>("acceptance-manifest.json"), plan = await store.get<SetupPlan>("plan.json"), state = await store.state();
  check(m.runId === options.runId && m.setupFingerprint === state.planFingerprint && m.securityAcknowledgement === plan.securityAcknowledgement, "Run identity or security acknowledgement mismatch");
  const config = await store.get<Json>("public-config.json"), active = await store.get<Json>("acceptance-active.json");
  const request = new FetchRequest(config.HEDERA_JSON_RPC_URL ?? config.HEDERA_RPC_URL ?? "https://testnet.hashio.io/api"); request.timeout = 15000;
  const provider = new JsonRpcProvider(request), key = (role: Role) => runRoleKey(store, m, role), api = acceptanceApi(m, key);
  const unused = async (): Promise<never> => { throw new Error("Subscription mutations are not allowed in the payout phase"); };
  const runner = new AcceptanceRunner(store, m, api, { assertNetwork: unused, sign: unused, submit: unused }, key, 60000);
  try {
    check(BigInt(await provider.send("eth_chainId", [])) === 296n, "Payout probe requires testnet 296");
    const workspace = await api.get("trustee", "/api/workspace");
    const registry = new Contract(m.expected.registryAddress, ["function distributionVersion() view returns(uint256)"], provider);
    check(await registry.getFunction("distributionVersion")() === 3n, "Registry is not exact-allocation v3");
    const payout = new Contract(workspace.pool.payoutAddress, ["function exactPayoutVersion() view returns(uint256)"], provider);
    check(await payout.getFunction("exactPayoutVersion")() === 1n, "Payout adapter lacks the exact committed-entitlement capability");
    const native = new ProbeNative(store, m, provider, config.HEDERA_MIRROR_NODE_URL ?? config.HEDERA_MIRROR_URL ?? "https://testnet.mirrornode.hedera.com/api/v1", active.securityId, workspace.pool.securityAddress);
    return await runPayoutProbe(runner, native, async hash => { const [receipt, transaction] = await Promise.all([provider.getTransactionReceipt(hash), provider.getTransaction(hash)]); return receipt && transaction ? { hash: receipt.hash, to: receipt.to, status: receipt.status, data: transaction.data, logs: receipt.logs.map(log => ({ address: log.address, topics: [...log.topics], data: log.data })) } : null; });
  } catch (error) { await store.put(`acceptance-payout-probe-progress-${Date.now()}-${randomUUID()}.json`, { status: "PENDING_OR_BLOCKED", message: sanitizeError(error) }); throw error; }
  finally { provider.destroy(); }
}
